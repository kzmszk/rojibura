import {
	type AreaId,
	type AvatarId,
	BODY_CALL_REACH,
	BODY_CALLED_TO,
	BODY_INTERVAL_MS,
	BODY_LOOK_REACH,
	BODY_REACH,
	bodyNeedsPartner,
	bodyTouches,
	bodyUntouchable,
	type ClientToHost,
	COMPANION_FREE,
	COMPANION_FREE_STEP,
	DIARY_ASK_MS,
	DIARY_TTL_MS,
	dist,
	type HostToClient,
	isPosture,
	LEAD_INTERVAL_MS,
	LEAD_MIN_DISTANCE,
	LEAD_REACH,
	MAX_PATH_LENGTH,
	MAX_PATH_POINTS,
	MAX_SPEED,
	OFFER_REACH,
	OFFER_TTL_MS,
	polylineLength,
	poseAt,
	SEAT_REACH,
	type Seat,
	STEP_BACK,
	STEP_BACK_S,
	TOGETHER_GAP,
	TOGETHER_MS,
	type Together,
	type Vec2,
	WALK_SPEED,
} from "@rojibura/protocol";
import type { RoomLife } from "./room-life.ts";
import type { RoomMovement } from "./room-movement.ts";
import { type RoomSpace, remainingPath } from "./room-space.ts";
import type { Member, Transport, World } from "./room-types.ts";

interface BodyRuntime {
	lastBodyAt: number;
}
interface InteractionPort<C> {
	movement: RoomMovement<C>;
	clock(): number;
	memberById(id: AvatarId): Member | undefined;
	memberValues(): IterableIterator<Member>;
	memberEntries(): IterableIterator<[C, Member]>;
	connectionFor(id: AvatarId): C | undefined;
	has(id: AvatarId): boolean;
	blockedBetween(a: AvatarId, b: AvatarId): boolean;
	broadcastAbout(member: Member, msg: HostToClient, except?: C, target?: AvatarId, social?: boolean): void;
	notice(conn: C, kind: "rejected", message: string): void;
	land(conn: C, member: Member, pos: Vec2, now: number): void;
}
const COMPANION_WALKING: Vec2 = [0.3, 0.9];
const COMPANION_STANDING: Vec2 = [0.15, 0.8];
const LEAD_GRACE_MS = 2 * 60_000;
const SEAT_COMPANY_NEAR = 3;
const SEAT_FRONT = 0.5;
const STEP_BACK_GRACE_MS = 3000;
export class RoomInteractions<C> {
	private readonly offers = new Map<string, { kind: Together; at: number }>();
	private readonly leads = new Map<AvatarId, { owner: AvatarId; to: Vec2; place: string; at: number }>();
	private readonly diaryAsks = new Map<
		AvatarId,
		{ owner: AvatarId; at: number; next: number; parts?: number }
	>();
	private readonly world: World;
	private readonly transport: Transport<C>;
	private readonly space: RoomSpace;
	private readonly life: RoomLife<C>;
	private readonly port: InteractionPort<C>;
	constructor(
		world: World,
		transport: Transport<C>,
		space: RoomSpace,
		life: RoomLife<C>,
		port: InteractionPort<C>,
	) {
		this.world = world;
		this.transport = transport;
		this.space = space;
		this.life = life;
		this.port = port;
	}
	leave(id: AvatarId): void {
		this.leads.delete(id);
	}
	companion(conn: C, m: Member, msg: Extract<ClientToHost, { t: "COMPANION" }>, now: number): void {
		if (m.kind !== "human") return;
		// also how the owner's page says a walk to a place is over (arrived, or they went their own way)
		this.endLeads(m);
		if (m.companion !== msg.on) this.tellCompany(m, msg.on);
		m.companion = msg.on;
		this.transport.persist(conn, m);
		if (msg.on) this.accompany(m, now);
	}
	action(conn: C, m: Member, msg: Extract<ClientToHost, { t: "ACTION" }>, now: number): void {
		if (msg.target && !this.port.has(msg.target)) return;
		// sitting and lying last until the avatar moves (docs/prd.md 3.4.5): it stops where it is
		if (isPosture(msg.motion)) {
			// on a seat close by, if one is asked for (an AI sitting next to a free one takes it)
			const seat = msg.motion === "sit" ? this.seatFor(m, msg.seat, now) : undefined;
			if (msg.seat !== undefined && seat === undefined) {
				this.port.notice(conn, "rejected", "そこには座れません（遠いか、ほかの人が座っています）");
				return;
			}
			// sitting down keeps the way it turned to (on a seat, the seat's way)
			const face =
				seat !== undefined
					? this.world.seats?.[seat]?.face
					: m.move.kind === "idle"
						? m.move.face
						: undefined;
			this.port.movement.commit(conn, m, {
				kind: "idle",
				pos: this.space.positionOf(m, now),
				at: now,
				posture: msg.motion,
				...(face ? { face } : {}),
				...(seat !== undefined ? { seat } : {}),
			});
			if (seat !== undefined && m.kind === "human" && m.companion) this.seatCompany(m, seat, now);
		}
		this.port.broadcastAbout(
			m,
			{ t: "ACTED", id: m.id, motion: msg.motion, target: msg.target, at: now },
			undefined,
			undefined,
			true,
		);
		// stepping back after a hug: an AI (or the guide) hugged steps back with them
		if (msg.motion === "stepback") this.stepBackWith(m, now);
	}
	// ---- the owner reading their AI's diary (docs/life.md 8) -------------------

	/** The owner asks their AI here for its diary; it is read where the AI runs, and comes back as DIARY. */
	askDiary(m: Member, msg: Extract<ClientToHost, { t: "DIARY_ASK" }>, now: number): string | null {
		const ai = this.port.memberById(msg.id);
		const ac = this.port.connectionFor(msg.id);
		if (!ai || ac === undefined) return "AIがこのエリアにいないので、日記を読めません";
		if (m.kind !== "human" || ai.kind !== "ai" || ai.ownerId !== m.id) return "自分のAIの日記だけ読めます";
		const asked = this.diaryAsks.get(ai.id);
		if (asked && now - asked.at < DIARY_ASK_MS) return null;
		this.diaryAsks.set(ai.id, { owner: m.id, at: now, next: 0 });
		this.transport.send(ac, { t: "DIARY_ASK", from: m.id, ...(msg.day ? { day: msg.day } : {}) });
		return null;
	}

	/** A part of an AI's answer goes on to the owner who asked, in order, and nothing else does. */
	passDiary(m: Member, msg: Extract<ClientToHost, { t: "DIARY" }>, now: number): void {
		const ask = this.diaryAsks.get(m.id);
		if (!ask || ask.owner !== msg.to || msg.part !== ask.next || now - ask.at > DIARY_TTL_MS) return;
		if (ask.parts !== undefined && msg.parts !== ask.parts) return;
		ask.parts = msg.parts;
		ask.next++;
		if (ask.next >= msg.parts) this.diaryAsks.delete(m.id);
		const oc = this.port.connectionFor(msg.to);
		if (oc === undefined) return;
		this.transport.send(oc, {
			t: "DIARY",
			id: m.id,
			day: msg.day,
			part: msg.part,
			parts: msg.parts,
			text: msg.text,
			...(msg.days ? { days: msg.days } : {}),
		});
	}

	// ---- sitting on a seat (docs/prd.md 3.4.5) ----------------------------------

	/**
	 * The seat `m` sits down on: `asked` if it is close and nobody sits on it, or undefined. With none asked, an
	 * AI takes the nearest free one within reach (a person sits on the ground unless they ask for a seat).
	 */
	private seatFor(m: Member, asked: number | undefined, now: number): number | undefined {
		const seats = this.world.seats ?? [];
		const here = this.space.positionOf(m, now);
		const taken = new Set<number>();
		for (const o of this.port.memberValues())
			if (o.id !== m.id && o.move.kind === "idle" && o.move.seat !== undefined) taken.add(o.move.seat);
		const free = (i: number) => {
			const s = seats[i];
			return !!s && !taken.has(i) && dist(s.pos, here) <= SEAT_REACH;
		};
		if (asked !== undefined) return free(asked) ? asked : undefined;
		if (m.kind !== "ai") return undefined;
		let best: number | undefined;
		seats.forEach((s, i) => {
			if (free(i) && (best === undefined || dist(s.pos, here) < dist((seats[best] as Seat).pos, here)))
				best = i;
		});
		return best;
	}

	/**
	 * The owner sat on a seat while walking with company: each of their AIs close by walks to the nearest free seat
	 * next to it and sits there when it arrives (`settleSeatPlans`); with no free seat it just stays beside them.
	 */
	private seatCompany(owner: Member, ownerSeat: number, now: number): void {
		const seats = this.world.seats ?? [];
		const at = seats[ownerSeat];
		if (!at) return;
		const taken = new Set<number>([ownerSeat]);
		for (const o of this.port.memberValues()) {
			if (o.move.kind === "idle" && o.move.seat !== undefined) taken.add(o.move.seat);
			if (o.seatPlan) taken.add(o.seatPlan.seat);
		}
		for (const [conn, ai] of this.port.memberEntries()) {
			if (ai.kind !== "ai" || ai.ownerId !== owner.id || this.togetherNow(ai, now)) continue;
			const from = this.space.positionOf(ai, now);
			let best: { i: number; d: number } | undefined;
			seats.forEach((s, i) => {
				const d = dist(s.pos, at.pos);
				if (taken.has(i) || d > SEAT_COMPANY_NEAR || Math.abs(s.y - at.y) > 0.5) return;
				if (!best || d < best.d) best = { i, d };
			});
			const pick = best as { i: number; d: number } | undefined;
			const seat = pick ? seats[pick.i] : undefined;
			if (!pick || !seat) continue;
			const front: Vec2 = [seat.pos[0] + seat.face[0] * SEAT_FRONT, seat.pos[1] + seat.face[1] * SEAT_FRONT];
			const path = dist(from, front) < 0.2 ? null : this.leadPath(from, front, this.space.walkOf(ai));
			if (!path && dist(from, front) >= 0.2) continue;
			taken.add(pick.i);
			this.life.stopDoing(conn, ai, now);
			this.port.movement.approachSeat(conn, ai, path, pick.i, now);
		}
	}

	/** The host time the next AI is due to sit down (for the alarm), if any. */
	get wakeAt(): number | undefined {
		let t: number | undefined;
		for (const m of this.port.memberValues())
			if (m.seatPlan && (t === undefined || m.seatPlan.at < t)) t = m.seatPlan.at;
		return t;
	}

	/** AIs that have walked up to their seat sit down on it. */
	settleSeatPlans(now: number): void {
		for (const [conn, ai] of this.port.memberEntries()) {
			const plan = ai.seatPlan;
			if (!plan || plan.at > now) continue;
			delete ai.seatPlan;
			// it was stopped, or sent elsewhere, on the way
			if (poseAt(ai.move, now).moving) {
				this.transport.persist(conn, ai);
				continue;
			}
			const seat = this.seatFor(ai, plan.seat, now);
			if (seat === undefined) {
				this.transport.persist(conn, ai);
				continue;
			}
			this.port.movement.commit(conn, ai, {
				kind: "idle",
				pos: this.space.positionOf(ai, now),
				at: now,
				posture: "sit",
				...(this.world.seats?.[seat]?.face ? { face: this.world.seats[seat]?.face as Vec2 } : {}),
				seat,
			});
			this.port.broadcastAbout(ai, { t: "ACTED", id: ai.id, motion: "sit", target: undefined, at: now });
		}
	}

	// ---- doing things together (docs/prd.md 3.4.6) ---------------------------

	offer(m: Member, kind: Together, to: AvatarId, now: number): string | null {
		const target = this.port.memberById(to);
		if (!target || target.id === m.id) return "その人はいません";
		if (this.port.blockedBetween(m.id, target.id)) return "その人には申し込めません";
		if (dist(this.space.positionOf(m, now), this.space.positionOf(target, now)) > OFFER_REACH)
			return "もっと近くに行ってから申し込んでください";
		this.offers.set(`${m.id} ${target.id}`, { kind, at: now });
		// the host's own guide says yes at once
		if (target.system) {
			this.answer(target, m.id, true, now);
			return null;
		}
		const tc = this.port.connectionFor(target.id);
		if (tc !== undefined) this.transport.send(tc, { t: "OFFERED", from: m.id, kind });
		return null;
	}

	/**
	 * `m` answers the offer from `to`. Yes: both walk to their places facing each other (centred where they
	 * are, TOGETHER_GAP apart) and start together once both are there. Too late, or nobody: nothing happens.
	 */
	answer(m: Member, to: AvatarId, accept: boolean, now: number): void {
		const key = `${to} ${m.id}`;
		const offer = this.offers.get(key);
		this.offers.delete(key);
		const from = this.port.memberById(to);
		const fc = this.port.connectionFor(to);
		const mc = this.port.connectionFor(m.id);
		if (!offer || now - offer.at > OFFER_TTL_MS || !from || fc === undefined || mc === undefined) return;
		const a = this.space.positionOf(from, now);
		const b = this.space.positionOf(m, now);
		const d = dist(a, b);
		const u: Vec2 = d > 1e-3 ? [(b[0] - a[0]) / d, (b[1] - a[1]) / d] : [0, 1];
		const mid: Vec2 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
		const half = TOGETHER_GAP[offer.kind] / 2;
		const pa: Vec2 = [mid[0] - u[0] * half, mid[1] - u[1] * half];
		const pb: Vec2 = [mid[0] + u[0] * half, mid[1] + u[1] * half];
		const fits =
			d <= OFFER_REACH + 1 && this.space.walkOf(from).isWalkable(pa) && this.space.walkOf(m).isWalkable(pb);
		this.transport.send(fc, { t: "ANSWERED", by: m.id, kind: offer.kind, accept: accept && fits });
		if (!accept || !fits) return;
		const ms = Math.max(this.stepTo(fc, from, a, pa, now), this.stepTo(mc, m, b, pb, now));
		const at = now + ms + 200;
		const until = at + TOGETHER_MS[offer.kind];
		from.together = { with: m.id, kind: offer.kind, until };
		m.together = { with: from.id, kind: offer.kind, until };
		this.transport.persist(fc, from);
		this.transport.persist(mc, m);
		this.port.broadcastAbout(
			from,
			{ t: "TOGETHER", kind: offer.kind, a: from.id, b: m.id, at },
			undefined,
			m.id,
			true,
		);
	}

	endTogether(m: Member): void {
		const other = m.together ? this.port.memberById(m.together.with) : undefined;
		if (other?.together?.with === m.id) delete other.together;
		delete m.together;
	}

	/** Whether `m` is (still) doing something together: until it is over, and a little after (stepping back). */
	togetherNow(m: Member, now: number): boolean {
		return !!m.together && now < m.together.until + STEP_BACK_GRACE_MS;
	}

	/**
	 * `m`, a person, steps back after a hug (their page does it when the hug is over): the AI (or the guide)
	 * they hugged steps back too, away from them, unless it has moved on. Two people each step back themselves.
	 */
	private stepBackWith(m: Member, now: number): void {
		const t = m.together;
		delete m.together;
		if (!t || m.kind !== "human" || now > t.until + STEP_BACK_GRACE_MS) return;
		const other = this.port.memberById(t.with);
		if (!other || other.kind === "human" || other.together?.with !== m.id) return;
		delete other.together;
		const oc = this.port.connectionFor(other.id);
		const here = this.space.positionOf(other, now);
		if (oc === undefined || poseAt(other.move, now).moving) return;
		const from = this.space.positionOf(m, now);
		const d = dist(here, from);
		if (d < 1e-3) return;
		const to: Vec2 = [
			here[0] + ((here[0] - from[0]) / d) * STEP_BACK,
			here[1] + ((here[1] - from[1]) / d) * STEP_BACK,
		];
		if (!this.space.walkOf(other).validatePath([here, to])) return;
		this.port.movement.commit(oc, other, {
			kind: "path",
			path: [here, to],
			speed: STEP_BACK / STEP_BACK_S,
			at: now,
		});
		this.port.broadcastAbout(
			other,
			{ t: "ACTED", id: other.id, motion: "stepback", at: now },
			undefined,
			undefined,
			true,
		);
	}

	/** Walks a member a short way to `to` (or puts them there); returns how long it takes (ms). */
	private stepTo(conn: C, m: Member, here: Vec2, to: Vec2, now: number): number {
		this.life.stopDoing(conn, m, now);
		const d = dist(here, to);
		const walk = d > 0.05 && this.space.walkOf(m).validatePath([here, to]);
		this.port.movement.commit(
			conn,
			m,
			walk
				? { kind: "path", path: [here, to], speed: WALK_SPEED, at: now }
				: { kind: "idle", pos: to, at: now },
		);
		return walk ? (d / WALK_SPEED) * 1000 : 0;
	}

	/**
	 * Someone goes through a portal to area `to`, arriving at `at` (docs/prd.md 3.8.2): their AIs walking with
	 * them come along (FOLLOW). `who` may be what a closed connection last persisted (its close says where to).
	 */
	travel(who: Pick<Member, "id" | "kind" | "companion">, to: AreaId, at: string): void {
		if (who.kind !== "human" || !who.companion) return;
		for (const [ac, ai] of this.port.memberEntries())
			if (ai.kind === "ai" && ai.ownerId === who.id)
				this.transport.send(ac, { t: "FOLLOW", owner: who.id, to, at });
	}

	// ---- an AI moving its own body (docs/prd.md 3.4.11) ----------------------

	/**
	 * Everyone close sees the member move its body by the script from a moment on. A hand may touch only some
	 * parts, and only between an AI and its owner: the AI touching its owner close by, or the owner touching
	 * their own AI, which the host first brings up to them if it is a little way off (as for a handshake).
	 * Looking at someone needs them in the area.
	 */
	body(m: Member, v: BodyRuntime, msg: Extract<ClientToHost, { t: "BODY" }>, now: number): string | null {
		if (now - v.lastBodyAt < BODY_INTERVAL_MS) return "少し間をあけてください";
		const to = msg.to ? this.port.memberById(msg.to) : undefined;
		if (msg.to && (!to || to.id === m.id)) return "その人はいません";
		if (!to && bodyNeedsPartner(msg.keys)) return "of: you を使うときは to に相手を入れてください";
		let at = now + 100;
		if (to) {
			if (this.port.blockedBetween(m.id, to.id)) return "その人には向けられません";
			const here = this.space.positionOf(m, now);
			const there = this.space.positionOf(to, now);
			const d = dist(here, there);
			if (bodyTouches(msg.keys)) {
				const ownAi = m.kind === "human" && to.kind === "ai" && to.ownerId === m.id;
				if (m.kind === "ai" && m.ownerId !== to.id) return "手で触れられるのは自分のオーナーだけです";
				if (m.kind === "human" && !ownAi) return "手で触れられるのは自分のAIだけです";
				const part = bodyUntouchable(msg.keys);
				if (part) return `${part} には触れられません`;
				if (ownAi && d > BODY_REACH) {
					if (d > BODY_CALL_REACH) return "自分のAIのそばへ行ってください";
					const u: Vec2 = [(there[0] - here[0]) / d, (there[1] - here[1]) / d];
					const spot: Vec2 = [here[0] + u[0] * BODY_CALLED_TO, here[1] + u[1] * BODY_CALLED_TO];
					const ac = this.port.connectionFor(to.id);
					if (ac === undefined || !this.space.walkOf(to).isWalkable(spot)) return "そこには来られません";
					at = now + this.stepTo(ac, to, there, spot, now) + 200;
				} else if (d > BODY_REACH) return `もっと近くに行ってください（いま${Math.round(d * 10) / 10}m）`;
			} else if (d > BODY_LOOK_REACH) return "その人は遠すぎます";
		}
		v.lastBodyAt = now;
		this.port.broadcastAbout(
			m,
			{ t: "BODIED", id: m.id, keys: msg.keys, ...(to ? { to: to.id } : {}), at },
			undefined,
			to?.id,
			true,
		);
		return null;
	}

	/**
	 * An AI walking with its owner may step about on its own while the owner stands still: a short way, to
	 * somewhere within COMPANION_FREE of them (it chooses how close it stands). It stays there until the
	 * owner walks on.
	 */
	freeStep(m: Member, msg: Extract<ClientToHost, { t: "MOVE_PATH" | "MOVE_VEL" }>, now: number): boolean {
		const owner = this.port.memberById(m.ownerId);
		// turning where it stands (not while the host walks it along) is always its own
		if (msg.t === "MOVE_VEL")
			return (
				msg.speed === 0 && !poseAt(m.move, now).moving && dist(msg.pos, this.space.positionOf(m, now)) <= 0.3
			);
		if (!owner || poseAt(owner.move, now).moving) return false;
		if (m.lead && now < m.lead.until) return false;
		const end = msg.path[msg.path.length - 1] as Vec2;
		return (
			polylineLength(msg.path) <= COMPANION_FREE_STEP &&
			dist(end, this.space.positionOf(owner, now)) <= COMPANION_FREE
		);
	}

	// ---- walking with your AIs (docs/prd.md 3.4.9) ----------------------------

	/** True if `m` is an AI whose owner is here and walking with company. */
	accompanying(m: Member): boolean {
		return m.kind === "ai" && !!this.port.memberById(m.ownerId)?.companion;
	}

	/**
	 * Moves the owner's AIs to keep beside them, one to each side: along the owner's path shifted sideways (or,
	 * walking with keys, to where the owner will be a few seconds on), at the speed that gets there when the
	 * owner does, and, when the owner stops, at their side.
	 */
	accompany(owner: Member, now: number): void {
		const move = owner.move;
		if (move.kind === "path") {
			const last = move.path[move.path.length - 1] as Vec2;
			const prev = move.path[move.path.length - 2] ?? last;
			const d = dist(prev, last);
			if (d > 1e-3) owner.heading = [(last[0] - prev[0]) / d, (last[1] - prev[1]) / d];
		} else if (move.kind === "vel" && move.speed > 0) {
			owner.heading = move.dir;
		}
		const ahead = owner.heading ?? [0, 1];
		let slot = 0;
		for (const [conn, ai] of this.port.memberEntries()) {
			if (ai.kind !== "ai" || ai.ownerId !== owner.id) continue;
			const side = slot++ % 2 === 0 ? 1 : -1;
			delete ai.seatPlan;
			// taking the owner somewhere: it leads, the owner follows (until it is over, or long past)
			if (ai.lead && now < ai.lead.until) continue;
			// hugging its owner (or someone): it stays there until it is over and they have stepped back
			if (this.togetherNow(ai, now)) continue;
			if (ai.lead) {
				delete ai.lead;
				this.transport.persist(conn, ai);
			}
			this.companionStep(conn, ai, owner, side, ahead, now);
		}
	}

	/** The owner went somewhere at once (WARP): the AIs walking with them are there beside them too. */
	bringCompany(owner: Member, now: number): void {
		if (!owner.companion) return;
		this.endLeads(owner);
		const at = this.space.positionOf(owner, now);
		let slot = 0;
		for (const [conn, ai] of this.port.memberEntries()) {
			if (ai.kind !== "ai" || ai.ownerId !== owner.id) continue;
			const side = slot++ % 2 === 0 ? 1 : -1;
			this.life.stopDoing(conn, ai, now);
			const there = this.beside(
				at,
				owner.heading ?? [0, 1],
				side,
				COMPANION_STANDING,
				false,
				this.space.walkOf(ai),
			);
			this.port.land(conn, ai, there ?? at, now);
		}
	}

	/** Tells the owner's AIs here that they walk with the owner now, or no longer. */
	tellCompany(owner: Member, on: boolean): void {
		const now = this.port.clock();
		for (const [conn, ai] of this.port.memberEntries())
			if (ai.kind === "ai" && ai.ownerId === owner.id) {
				this.transport.send(conn, { t: "COMPANY", owner: owner.id, on });
				// its mood goes up from now on (or no more)
				if (on && ai.life) ai.companyAt = now;
				else delete ai.companyAt;
				this.transport.persist(conn, ai);
			}
	}

	// ---- an AI taking its owner somewhere (docs/prd.md 3.4.10) -----------------

	/** The way from `from` to `to` as one move, or null; a way of more points ends where one move does. */
	private leadPath(from: Vec2, to: Vec2, walk = this.space.terrain): Vec2[] | null {
		const way = walk.findPath?.(walk.closestPoint(from), to) ?? [from, to];
		if (way.length < 2) return null;
		const path = [from, ...way.slice(1)].slice(0, MAX_PATH_POINTS);
		return polylineLength(path) <= MAX_PATH_LENGTH && walk.validatePath(path) ? path : null;
	}

	/** An AI walking with its owner asks them to come along to a place; the owner's page asks them. */
	askLead(conn: C, m: Member, msg: Extract<ClientToHost, { t: "LEAD" }>, now: number): string | null {
		const owner = m.kind === "ai" ? this.port.memberById(m.ownerId) : undefined;
		const oc = owner ? this.port.connectionFor(owner.id) : undefined;
		if (!owner || oc === undefined || !owner.companion) return "オーナーと歩いているときだけ誘えます";
		if (m.leadAskedAt !== undefined && now - m.leadAskedAt < LEAD_INTERVAL_MS)
			return "さっき誘ったばかりです";
		const here = this.space.positionOf(m, now);
		if (dist(here, this.space.positionOf(owner, now)) > LEAD_REACH) return "オーナーが遠すぎます";
		const to = this.space.walkOf(m).closestPoint(msg.to);
		if (dist(here, to) < LEAD_MIN_DISTANCE) return "そこはすぐそばです";
		if (!this.leadPath(here, to, this.space.walkOf(m))) return "そこへは歩いて行けません";
		m.leadAskedAt = now;
		this.transport.persist(conn, m);
		this.leads.set(m.id, { owner: owner.id, to, place: msg.place, at: now });
		this.transport.send(oc, {
			t: "LEAD_OFFERED",
			from: m.id,
			to,
			place: msg.place,
			...(msg.text ? { text: msg.text } : {}),
		});
		return null;
	}

	/**
	 * `m` answers their AI `to` asking them to come along. Yes: the AI walks there and the owner's page
	 * follows it; the AI walks with the owner again when the page says it is over (COMPANION), or, if it
	 * never does, a while after arriving. False if there was no such ask (an ANSWER to an OFFER, then).
	 */
	answerLead(m: Member, to: AvatarId, accept: boolean, now: number): boolean {
		const lead = this.leads.get(to);
		if (!lead || lead.owner !== m.id) return false;
		this.leads.delete(to);
		const ai = this.port.memberById(to);
		const ac = this.port.connectionFor(to);
		const mc = this.port.connectionFor(m.id);
		if (!ai || ac === undefined || mc === undefined || now - lead.at > OFFER_TTL_MS) return true;
		const path =
			accept && this.accompanying(ai)
				? this.leadPath(this.space.positionOf(ai, now), lead.to, this.space.walkOf(ai))
				: null;
		if (accept && !path) this.port.notice(mc, "rejected", "そこへは行けなくなりました");
		const ms = path ? (polylineLength(path) / WALK_SPEED) * 1000 : 0;
		this.transport.send(ac, {
			t: "LEAD_ANSWERED",
			by: m.id,
			accept: path !== null,
			place: lead.place,
			...(path ? { at: now + ms } : {}),
		});
		if (!path) return true;
		const end = path[path.length - 1] as Vec2;
		ai.lead = { to: end, place: lead.place, until: now + ms + LEAD_GRACE_MS };
		this.life.stopDoing(ac, ai, now);
		this.port.movement.commit(ac, ai, { kind: "path", path, speed: WALK_SPEED, at: now });
		this.transport.send(mc, { t: "LEADING", by: ai.id, to: end, place: lead.place });
		return true;
	}

	/** Ends the owner's AIs' walks to a place, and their open asks. */
	private endLeads(owner: Member): void {
		for (const [conn, ai] of this.port.memberEntries()) {
			if (ai.kind !== "ai" || ai.ownerId !== owner.id) continue;
			this.leads.delete(ai.id);
			if (!ai.lead) continue;
			delete ai.lead;
			this.transport.persist(conn, ai);
		}
	}

	/**
	 * Just ahead of `at` facing `ahead`, to the right (side 1) or the left (-1), as far as `slot` says (walking
	 * or standing); `strict`: there or nowhere.
	 */
	private beside(
		at: Vec2,
		ahead: Vec2,
		side: number,
		slot = COMPANION_WALKING,
		strict = false,
		walk = this.space.terrain,
	): Vec2 | null {
		// facing +z the right hand is on -x: right = (-ahead.z, ahead.x)
		const right: Vec2 = [-ahead[1], ahead[0]];
		const [front, aside] = slot;
		const p: Vec2 = [
			at[0] + ahead[0] * front + right[0] * aside * side,
			at[1] + ahead[1] * front + right[1] * aside * side,
		];
		if (walk.isWalkable(p)) return p;
		return strict ? null : walk.closestPoint(p);
	}

	private companionStep(conn: C, ai: Member, owner: Member, side: number, ahead: Vec2, now: number): void {
		const from = this.space.positionOf(ai, now);
		const om = owner.move;
		const walk = this.space.walkOf(ai);
		let path: Vec2[] | null = null;
		let ms = 0;
		if (om.kind === "path" && poseAt(om, now).moving) {
			// the owner's way, shifted aside where that is walkable
			const rest = remainingPath(om, now);
			const steps = rest.slice(1).map((p, i) => {
				const a = rest[i] as Vec2;
				const d = dist(a, p);
				const dir: Vec2 = d > 1e-3 ? [(p[0] - a[0]) / d, (p[1] - a[1]) / d] : ahead;
				const last = i === rest.length - 2;
				return (
					(last
						? this.beside(p, dir, side, COMPANION_WALKING, false, walk)
						: this.beside(p, dir, side, COMPANION_WALKING, true, walk)) ?? p
				);
			});
			path = [from, ...steps].slice(0, MAX_PATH_POINTS);
			ms = (polylineLength(rest) / om.speed) * 1000;
		} else if (om.kind === "vel" && om.speed > 0) {
			// keys: where the owner will be a few seconds on, sooner if the way there is not clear
			const walked = (now - om.at) / 1000;
			for (const s of [6, 4, 2, 1]) {
				const go = om.speed * (walked + s);
				// where the owner's own way is still clear that far on
				const ahead: Vec2 = [om.pos[0] + om.dir[0] * go, om.pos[1] + om.dir[1] * go];
				if (!this.space.walkOf(owner).validatePath([this.space.positionOf(owner, now), ahead])) continue;
				const there = this.beside(ahead, om.dir, side, COMPANION_WALKING, false, walk);
				if (there) {
					path = [from, there];
					ms = s * 1000;
					break;
				}
			}
		} else {
			// the owner has stopped: it comes to their side
			const there = this.beside(
				this.space.positionOf(owner, now),
				ahead,
				side,
				COMPANION_STANDING,
				false,
				walk,
			);
			if (there) path = [from, there];
		}
		// a fountain or a wall in the way: find a way round it to the same place, there at the same time
		if (path && path.length >= 2 && !walk.validatePath(path)) {
			const to = path[path.length - 1] as Vec2;
			const round = walk.findPath?.(walk.closestPoint(from), walk.closestPoint(to));
			path = round && round.length >= 2 ? [from, ...round.slice(1)].slice(0, MAX_PATH_POINTS) : null;
		}
		if (!path || path.length < 2 || polylineLength(path) > MAX_PATH_LENGTH || !walk.validatePath(path))
			return;
		const length = polylineLength(path);
		if (length < 0.15) return;
		// as long as the owner takes; when the owner has stopped, a walk (a run if far behind)
		const speed = ms > 0 ? (length / ms) * 1000 : length > 6 ? 4 : WALK_SPEED;
		this.life.stopDoing(conn, ai, now);
		this.port.movement.commit(conn, ai, {
			kind: "path",
			path,
			speed: this.life.speedFor(ai, Math.min(MAX_SPEED, Math.max(0.5, speed)), now),
			at: now,
		});
	}
}
