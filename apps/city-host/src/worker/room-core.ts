// Area logic of CityRoomDO, independent of the Workers runtime so it can be tested in Node
// (docs/prd.md 3.2, 3.3). The Durable Object adapter (room.ts) owns sockets, hibernation and auth.

import {
	AGENTS_PER_OWNER_CONCURRENT,
	AI_CONV_MAX_TURNS,
	AI_PAIR_COOLDOWN_MS,
	AI_REPLY_MIN_INTERVAL_MS,
	type AvatarAssets,
	type AvatarId,
	type AvatarKind,
	type AvatarState,
	CAPACITY_AI,
	CAPACITY_PROVISIONAL_AI,
	CAPACITY_TOTAL,
	type ClientToHost,
	CONTEXT_AVATAR_RADIUS,
	CONTEXT_LANDMARK_RADIUS,
	CONTEXT_MAX_ITEMS,
	CONV_TIMEOUT_MS,
	dist,
	type HostToClient,
	HUMAN_TO_SAME_AI_PER_MIN,
	INTEREST_RADIUS_DEFAULT,
	type LeaveReason,
	MAX_PATH_LENGTH,
	type MoveState,
	POSITION_TOLERANCE,
	PRESENCE_TIMEOUT_MS,
	polylineLength,
	poseAt,
	RATE_MOVE,
	RATE_SAY_AI_PER_MIN,
	RATE_SAY_HUMAN,
	RATE_VIOLATIONS_BEFORE_CLOSE,
	type SpatialContext,
	type Status,
	type Vec2,
} from "@rojibura/protocol";

/** What the area needs to know about the walkable ground (implemented with @rojibura/nav). */
export interface Walkable {
	isWalkable(p: Vec2): boolean;
	/** Every vertex and every segment midpoint is walkable. */
	validatePath(path: Vec2[]): boolean;
	closestPoint(p: Vec2): Vec2;
}

export interface Landmark {
	id: string;
	name: string;
	pos: Vec2;
}

export interface World {
	walk: Walkable;
	landmarks: Landmark[];
	spawn: Vec2;
	/** Used in the spatial context when no landmark is close. */
	areaName: string;
}

/** Identity of a connection, decided by the gateway (humans) or after AUTH (agents). */
export interface JoinInfo {
	id: AvatarId;
	kind: AvatarKind;
	name: string;
	assets: AvatarAssets;
	/** Account that owns an agent (or the human's own account). */
	ownerId: string;
	ownerName?: string;
	trust?: "provisional" | "approved";
	/** Humans only: whether AIs may start conversations with them. */
	allowAiApproach?: boolean;
	/** Max agents of this owner in the area at once (accounts.agent_concurrency). */
	ownerAgentLimit?: number;
}

/** Member state that survives hibernation (kept in the WebSocket attachment, < 2 KB). */
export interface Member extends JoinInfo {
	status: Status;
	move: MoveState;
	interest: number;
}

interface Bucket {
	tokens: number;
	at: number;
}

interface Volatile {
	moveBucket: Bucket;
	sayBucket: Bucket;
	violations: number[];
	aiSays: number[];
	lastAiReplyAt: number;
	lastSeen: number;
}

interface Conv {
	id: string;
	a: AvatarId;
	b: AvatarId;
	turn: number;
	maxTurns: number | null;
	lastAt: number;
}

export interface Transport<C> {
	send(conn: C, msg: HostToClient): void;
	close(conn: C, code: number, reason: string): void;
	/** Called whenever a member's persistent state changes. */
	persist(conn: C, member: Member): void;
}

export interface RoomStats {
	inbound: number;
	connects: number;
	rejectedMoves: number;
	says: number;
}

export const CLOSE_POLICY = 1008;
export const CLOSE_REPLACED = 4000;
export const CLOSE_FULL = 4001;
export const CLOSE_KICKED = 4003;
export const CLOSE_TIMEOUT = 4008;
export const CLOSE_CLOSING = 4010;

function takeToken(b: Bucket, rate: number, burst: number, now: number): boolean {
	b.tokens = Math.min(burst, b.tokens + ((now - b.at) / 1000) * rate);
	b.at = now;
	if (b.tokens < 1) return false;
	b.tokens -= 1;
	return true;
}

function within(times: number[], windowMs: number, now: number): number[] {
	return times.filter((t) => now - t < windowMs);
}

export class RoomCore<C> {
	readonly members = new Map<C, Member>();
	private readonly volatile = new Map<C, Volatile>();
	private readonly byId = new Map<AvatarId, C>();
	private readonly convs = new Map<string, Conv>();
	private readonly pairCooldown = new Map<string, number>();
	private readonly humanToAi = new Map<string, number[]>();
	readonly stats: RoomStats = { inbound: 0, connects: 0, rejectedMoves: 0, says: 0 };

	private readonly transport: Transport<C>;
	private readonly world: World;
	private readonly clock: () => number;
	private readonly newId: () => string;

	constructor(transport: Transport<C>, world: World, clock: () => number, newId: () => string) {
		this.transport = transport;
		this.world = world;
		this.clock = clock;
		this.newId = newId;
	}

	// ---- membership ---------------------------------------------------------

	/** Re-adds a member after the Durable Object woke from hibernation. */
	restore(conn: C, member: Member): void {
		this.members.set(conn, member);
		this.byId.set(member.id, conn);
		this.volatile.set(conn, this.freshVolatile());
	}

	/** Returns a reason when the area cannot take this avatar (docs/prd.md 3.3 item 7). */
	admissionError(info: JoinInfo): string | null {
		const others = [...this.members.values()].filter((m) => m.id !== info.id);
		if (others.length >= CAPACITY_TOTAL) return "街が満員です";
		if (info.kind === "ai") {
			const ais = others.filter((m) => m.kind === "ai");
			if (ais.length >= CAPACITY_AI) return "AIの定員に達しています";
			const mine = ais.filter((m) => m.ownerId === info.ownerId);
			if (mine.length >= (info.ownerAgentLimit ?? AGENTS_PER_OWNER_CONCURRENT))
				return "このオーナーのAIは同時入場数の上限に達しています";
			if (info.trust === "provisional") {
				const prov = ais.filter((m) => m.trust === "provisional");
				if (prov.length >= CAPACITY_PROVISIONAL_AI) return "仮承認AIの定員に達しています";
				if (prov.some((m) => m.ownerId === info.ownerId)) return "仮承認のAIはオーナーごとに1体までです";
			}
		}
		return null;
	}

	join(conn: C, info: JoinInfo): boolean {
		const now = this.clock();
		const old = this.byId.get(info.id);
		if (old !== undefined && old !== conn) {
			this.removeMember(old, "quit");
			this.transport.close(old, CLOSE_REPLACED, "replaced by a new connection");
		}
		const err = this.admissionError(info);
		if (err) {
			this.transport.send(conn, { t: "NOTICE", kind: "rejected", message: err });
			this.transport.close(conn, CLOSE_FULL, "full");
			return false;
		}
		const member: Member = {
			...info,
			status: "active",
			move: { kind: "idle", pos: this.spawnPoint(), at: now },
			interest: INTEREST_RADIUS_DEFAULT,
		};
		this.members.set(conn, member);
		this.byId.set(member.id, conn);
		this.volatile.set(conn, this.freshVolatile());
		this.stats.connects++;
		this.transport.persist(conn, member);
		this.transport.send(conn, {
			t: "WELCOME",
			you: member.id,
			serverTime: now,
			budget: 0,
			avatars: [...this.members.values()].map((m) => this.toState(m)),
		});
		this.broadcastAbout(member, { t: "JOINED", avatar: this.toState(member) }, conn);
		return true;
	}

	/** Called when the socket closed or errored. */
	leave(conn: C, reason: LeaveReason = "quit"): void {
		this.removeMember(conn, reason);
	}

	/** Removes members without a heartbeat or message for PRESENCE_TIMEOUT_MS and stale conversations. */
	sweep(lastPing: (conn: C) => number | null): void {
		const now = this.clock();
		for (const [conn, m] of [...this.members]) {
			const v = this.volatile.get(conn);
			const last = Math.max(v?.lastSeen ?? 0, lastPing(conn) ?? 0);
			if (now - last > PRESENCE_TIMEOUT_MS) {
				this.removeMember(conn, "timeout");
				this.transport.close(conn, CLOSE_TIMEOUT, "no heartbeat");
			} else if (!v) {
				// restored after hibernation without volatile state
				this.volatile.set(conn, this.freshVolatile());
			}
			void m;
		}
		for (const c of [...this.convs.values()]) {
			if (now - c.lastAt > CONV_TIMEOUT_MS) this.endConv(c, "timeout");
		}
		for (const [k, until] of this.pairCooldown) if (until <= now) this.pairCooldown.delete(k);
	}

	/** Closes every connection (closing time). */
	closeAll(reason: LeaveReason, code: number, message: string): void {
		for (const conn of [...this.members.keys()]) {
			this.removeMember(conn, reason);
			this.transport.close(conn, code, message);
		}
	}

	get size(): number {
		return this.members.size;
	}

	// ---- messages -----------------------------------------------------------

	handle(conn: C, msg: ClientToHost): void {
		const m = this.members.get(conn);
		const v = this.volatile.get(conn) ?? this.freshVolatile();
		this.volatile.set(conn, v);
		if (!m) return;
		const now = this.clock();
		v.lastSeen = now;
		this.stats.inbound++;
		switch (msg.t) {
			case "MOVE_PATH":
			case "MOVE_VEL":
				if (!takeToken(v.moveBucket, RATE_MOVE.rate, RATE_MOVE.burst, now)) {
					this.violation(conn, v, now);
					return;
				}
				msg.t === "MOVE_PATH" ? this.movePath(conn, m, msg, now) : this.moveVel(conn, m, msg, now);
				return;
			case "ACTION":
				if (!takeToken(v.moveBucket, RATE_MOVE.rate, RATE_MOVE.burst, now)) {
					this.violation(conn, v, now);
					return;
				}
				if (msg.target && !this.byId.has(msg.target)) return;
				this.broadcastAbout(m, { t: "ACTED", id: m.id, motion: msg.motion, target: msg.target, at: now });
				return;
			case "SAY":
				this.say(conn, m, v, msg, now);
				return;
			case "STATUS":
				if (m.status === msg.status) return;
				m.status = msg.status;
				this.transport.persist(conn, m);
				this.broadcastAbout(m, { t: "STATUS_CHANGED", id: m.id, status: m.status });
				return;
			case "INTEREST":
				if (m.kind !== "ai") return;
				m.interest = msg.radius;
				this.transport.persist(conn, m);
				return;
			case "AUTH":
				return; // handled by the adapter before join
		}
	}

	/** Records liveness for a message the adapter handled itself. */
	touch(conn: C): void {
		const v = this.volatile.get(conn);
		if (v) v.lastSeen = this.clock();
	}

	private movePath(conn: C, m: Member, msg: Extract<ClientToHost, { t: "MOVE_PATH" }>, now: number): void {
		const here = this.positionOf(m, now);
		const start = msg.path[0] as Vec2;
		const ok =
			dist(start, here) <= POSITION_TOLERANCE &&
			polylineLength(msg.path) <= MAX_PATH_LENGTH &&
			this.world.walk.validatePath(msg.path);
		if (!ok) {
			this.reject(conn, m, here, now);
			return;
		}
		// start exactly where the host thinks the avatar is, so everyone interpolates the same line
		const path: Vec2[] = [here, ...msg.path.slice(1)];
		m.move = { kind: "path", path, speed: msg.speed, at: now };
		this.transport.persist(conn, m);
		this.broadcastAbout(m, { t: "MOVED", id: m.id, move: m.move });
	}

	private moveVel(conn: C, m: Member, msg: Extract<ClientToHost, { t: "MOVE_VEL" }>, now: number): void {
		const here = this.positionOf(m, now);
		if (dist(msg.pos, here) > POSITION_TOLERANCE || !this.world.walk.isWalkable(msg.pos)) {
			this.reject(conn, m, here, now);
			return;
		}
		const stopped = msg.speed === 0 || (msg.dir[0] === 0 && msg.dir[1] === 0);
		m.move = stopped
			? { kind: "idle", pos: msg.pos, at: now }
			: { kind: "vel", pos: msg.pos, dir: msg.dir, speed: msg.speed, at: now };
		this.transport.persist(conn, m);
		this.broadcastAbout(m, { t: "MOVED", id: m.id, move: m.move });
	}

	private reject(conn: C, m: Member, here: Vec2, now: number): void {
		this.stats.rejectedMoves++;
		m.move = { kind: "idle", pos: here, at: now };
		this.transport.persist(conn, m);
		this.transport.send(conn, { t: "CORRECT", move: m.move });
		this.broadcastAbout(m, { t: "MOVED", id: m.id, move: m.move }, conn);
	}

	private say(conn: C, m: Member, v: Volatile, msg: Extract<ClientToHost, { t: "SAY" }>, now: number): void {
		// rate limits
		if (m.kind === "human") {
			if (!takeToken(v.sayBucket, RATE_SAY_HUMAN.rate, RATE_SAY_HUMAN.burst, now)) {
				this.violation(conn, v, now);
				return;
			}
		} else {
			const limit = m.trust === "provisional" ? Math.floor(RATE_SAY_AI_PER_MIN / 2) : RATE_SAY_AI_PER_MIN;
			v.aiSays = within(v.aiSays, 60_000, now);
			if (v.aiSays.length >= limit) {
				this.violation(conn, v, now);
				return;
			}
		}

		let conv: Conv | undefined;
		let target: Member | undefined;
		if (msg.convId) {
			const c = this.convs.get(msg.convId);
			if (c && (c.a === m.id || c.b === m.id)) {
				conv = c;
				const otherId = c.a === m.id ? c.b : c.a;
				if (msg.to && msg.to !== otherId) {
					this.notice(conn, "rejected", "会話の相手が違います");
					return;
				}
				target = this.memberById(otherId);
				if (!target) {
					this.endConv(c, "left");
					return;
				}
			}
		}
		if (!conv && msg.to) {
			target = this.memberById(msg.to);
			if (!target || target.id === m.id) {
				this.notice(conn, "rejected", "相手が見つかりません");
				return;
			}
			// both sides may start at the same moment: join the open conversation instead of making a second one
			const tid = target.id;
			conv = [...this.convs.values()].find(
				(c) => (c.a === m.id && c.b === tid) || (c.a === tid && c.b === m.id),
			);
		}
		if (!conv && msg.to && target) {
			const err = this.canStartConv(m, target, now);
			if (err) {
				this.notice(conn, "rejected", err);
				return;
			}
			const aiPair = m.kind === "ai" && target.kind === "ai";
			conv = {
				id: `c_${this.newId()}`,
				a: m.id,
				b: target.id,
				turn: 0,
				maxTurns: aiPair ? AI_CONV_MAX_TURNS : null,
				lastAt: now,
			};
			this.convs.set(conv.id, conv);
		}

		if (conv && target) {
			if (m.kind === "ai" && target.kind === "ai" && now - v.lastAiReplyAt < AI_REPLY_MIN_INTERVAL_MS) {
				this.notice(conn, "rate_limited", "返答の間隔が短すぎます");
				return;
			}
			if (m.kind === "human" && target.kind === "ai" && !this.countHumanToAi(m.id, target.id, now)) {
				this.notice(conn, "rate_limited", "同じAIへの話しかけが多すぎます");
				return;
			}
			conv.turn++;
			conv.lastAt = now;
		}
		if (m.kind === "ai") {
			v.aiSays.push(now);
			v.lastAiReplyAt = now;
		}
		this.stats.says++;

		const said: HostToClient = { t: "SAID", id: m.id, text: msg.text, at: now };
		if (target) said.to = target.id;
		if (conv) said.convId = conv.id;
		this.broadcastAbout(m, said, undefined, target?.id);

		if (conv && target) {
			if (target.kind === "ai") {
				const targetConn = this.byId.get(target.id);
				if (targetConn !== undefined)
					this.transport.send(targetConn, {
						t: "ADDRESSED",
						from: m.id,
						text: msg.text,
						convId: conv.id,
						turn: conv.turn,
						maxTurns: conv.maxTurns,
						context: this.contextFor(target, now),
					});
			}
			if (conv.maxTurns !== null && conv.turn >= conv.maxTurns) this.endConv(conv, "max_turns");
		}
	}

	private canStartConv(from: Member, to: Member, now: number): string | null {
		if (from.kind === "ai" && to.kind === "human") {
			if (from.trust !== "approved") return "仮承認のAIは人間に話しかけられません";
			if (to.allowAiApproach === false) return "この人はAIからの話しかけを受け付けていません";
		}
		if (from.kind === "ai" && to.kind === "ai") {
			const until = this.pairCooldown.get(pairKey(from.id, to.id));
			if (until !== undefined && until > now) return "この相手とはしばらく会話できません";
			const active = [...this.convs.values()].filter(
				(c) => c.a === from.id || c.b === from.id || c.a === to.id || c.b === to.id,
			);
			if (active.length >= 2) return "会話が多すぎます";
		}
		return null;
	}

	private countHumanToAi(human: AvatarId, ai: AvatarId, now: number): boolean {
		const key = `${human}>${ai}`;
		const times = within(this.humanToAi.get(key) ?? [], 60_000, now);
		if (times.length >= HUMAN_TO_SAME_AI_PER_MIN) {
			this.humanToAi.set(key, times);
			return false;
		}
		times.push(now);
		this.humanToAi.set(key, times);
		return true;
	}

	private endConv(c: Conv, reason: "max_turns" | "timeout" | "left" | "budget"): void {
		this.convs.delete(c.id);
		const a = this.memberById(c.a);
		const b = this.memberById(c.b);
		if (a?.kind === "ai" && b?.kind === "ai")
			this.pairCooldown.set(pairKey(c.a, c.b), this.clock() + AI_PAIR_COOLDOWN_MS);
		for (const id of [c.a, c.b]) {
			const conn = this.byId.get(id);
			if (conn !== undefined) this.transport.send(conn, { t: "CONV_END", convId: c.id, reason });
		}
	}

	private violation(conn: C, v: Volatile, now: number): void {
		v.violations = within(v.violations, 60_000, now);
		v.violations.push(now);
		if (v.violations.length >= RATE_VIOLATIONS_BEFORE_CLOSE) {
			this.removeMember(conn, "kicked");
			this.transport.close(conn, CLOSE_POLICY, "rate limit");
			return;
		}
		this.notice(conn, "rate_limited", "送信が多すぎます");
	}

	private notice(conn: C, kind: "rate_limited" | "rejected", message: string): void {
		this.transport.send(conn, { t: "NOTICE", kind, message });
	}

	// ---- spatial ------------------------------------------------------------

	positionOf(m: Member, now = this.clock()): Vec2 {
		return poseAt(m.move, now, (p) => (this.world.walk.isWalkable(p) ? p : this.world.walk.closestPoint(p)))
			.pos;
	}

	contextFor(m: Member, now = this.clock()): SpatialContext {
		const pos = this.positionOf(m, now);
		const nearbyAvatars = [...this.members.values()]
			.filter((o) => o.id !== m.id)
			.map((o) => ({
				id: o.id,
				name: o.name,
				kind: o.kind,
				distance: round1(dist(pos, this.positionOf(o, now))),
			}))
			.filter((o) => o.distance <= CONTEXT_AVATAR_RADIUS)
			.sort((a, b) => a.distance - b.distance)
			.slice(0, CONTEXT_MAX_ITEMS);
		const nearbyLandmarks = this.world.landmarks
			.map((l) => ({ id: l.id, name: l.name, distance: round1(dist(pos, l.pos)) }))
			.filter((l) => l.distance <= CONTEXT_LANDMARK_RADIUS)
			.sort((a, b) => a.distance - b.distance)
			.slice(0, CONTEXT_MAX_ITEMS);
		const nearest = nearbyLandmarks[0];
		const area = nearest && nearest.distance <= 15 ? nearest.name : this.world.areaName;
		return { area, pos: [round1(pos[0]), round1(pos[1])], nearbyAvatars, nearbyLandmarks };
	}

	private spawnPoint(): Vec2 {
		for (let i = 0; i < 10; i++) {
			const a = Math.random() * Math.PI * 2;
			const r = Math.random() * 2.5;
			const p: Vec2 = [this.world.spawn[0] + Math.cos(a) * r, this.world.spawn[1] + Math.sin(a) * r];
			if (this.world.walk.isWalkable(p)) return [round1(p[0]), round1(p[1])];
		}
		return this.world.spawn;
	}

	/**
	 * Sends a message about `subject` to everyone who should see it: humans always (they render the whole
	 * area), AIs only within their interest radius or when they are `alsoTo`.
	 */
	private broadcastAbout(subject: Member, msg: HostToClient, except?: C, alsoTo?: AvatarId): void {
		const now = this.clock();
		const at = this.positionOf(subject, now);
		for (const [conn, r] of this.members) {
			if (conn === except) continue;
			if (r.kind === "ai" && r.id !== subject.id && r.id !== alsoTo) {
				if (dist(this.positionOf(r, now), at) > r.interest) continue;
			}
			this.transport.send(conn, msg);
		}
	}

	private removeMember(conn: C, reason: LeaveReason): void {
		const m = this.members.get(conn);
		this.volatile.delete(conn);
		if (!m) return;
		this.members.delete(conn);
		if (this.byId.get(m.id) === conn) this.byId.delete(m.id);
		for (const c of [...this.convs.values()]) if (c.a === m.id || c.b === m.id) this.endConv(c, "left");
		this.broadcastAbout(m, { t: "LEFT", id: m.id, reason });
	}

	private memberById(id: AvatarId): Member | undefined {
		const conn = this.byId.get(id);
		return conn === undefined ? undefined : this.members.get(conn);
	}

	toState(m: Member): AvatarState {
		const s: AvatarState = {
			id: m.id,
			kind: m.kind,
			name: m.name,
			status: m.status,
			assets: m.assets,
			move: m.move,
		};
		if (m.ownerName && m.kind === "ai") s.owner = m.ownerName;
		if (m.trust) s.trust = m.trust;
		return s;
	}

	private freshVolatile(): Volatile {
		const now = this.clock();
		return {
			moveBucket: { tokens: RATE_MOVE.burst, at: now },
			sayBucket: { tokens: RATE_SAY_HUMAN.burst, at: now },
			violations: [],
			aiSays: [],
			lastAiReplyAt: 0,
			lastSeen: now,
		};
	}
}

function pairKey(a: AvatarId, b: AvatarId): string {
	return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function round1(n: number): number {
	return Math.round(n * 10) / 10;
}
