// Area logic of CityRoomDO, independent of the Workers runtime so it can be tested in Node
// (docs/prd.md 3.2, 3.3). The Durable Object adapter (room.ts) owns sockets, hibernation and auth.

import {
	type AreaId,
	type AvatarId,
	type AvatarState,
	type Build,
	type ClientToHost,
	decay,
	dist,
	FLY_REACH,
	type HostToClient,
	INTEREST_RADIUS_DEFAULT,
	type Item,
	type LeaveReason,
	MAX_PATH_LENGTH,
	PRESENCE_TIMEOUT_MS,
	polylineLength,
	RATE_VIOLATIONS_BEFORE_CLOSE,
	type SpatialContext,
	type Vec2,
	WARP_INTERVAL_MS,
} from "@rojibura/protocol";
import { RoomConversations } from "./room-conversations.ts";
import { RoomInteractions } from "./room-interactions.ts";
import { RoomLife } from "./room-life.ts";
import { RoomMovement } from "./room-movement.ts";
import { type Bucket, takeToken, within } from "./room-rate.ts";
import { RoomSpace, remainingPath } from "./room-space.ts";
import type {
	BuildStore,
	ChatLine,
	ItemStore,
	JoinInfo,
	LifeStore,
	Member,
	MemberRelations,
	RoomStats,
	Transport,
	Walkable,
	WalletStore,
	World,
} from "./room-types.ts";
import { PRODUCTION_RULES, type RoomRules } from "./rules.ts";

/**
 * Someone whose connection dropped stays this long (docs/prd.md 3.3): back within it, they carry on where they
 * were; the others see nothing. Covers a few of the clients' reconnect attempts (after 1, 2, 4... s).
 */
export const AWAY_GRACE_MS = 20_000;
/** What someone away is sent meanwhile and gets when back: what was said and asked, not what moved. */
const KEPT_WHILE_AWAY = new Set<HostToClient["t"]>([
	"SAID",
	"ADDRESSED",
	"CONV_END",
	"OFFERED",
	"ANSWERED",
	"COMPANY",
	"LEAD_OFFERED",
	"LEAD_ANSWERED",
	"LEADING",
	"NOTICE",
]);
const KEPT_WHILE_AWAY_MAX = 50;

interface Volatile {
	moveBucket: Bucket;
	sayBucket: Bucket;
	violations: number[];
	aiSays: number[];
	lastAiReplyAt: number;
	lastSeen: number;
	/** When the member last moved its body by a script (docs/prd.md 3.4.11). */
	lastBodyAt: number;
}

type ConnectionState<C> =
	| { kind: "active"; conn: C }
	| { kind: "away"; conn: C; until: number; order: number; missed: HostToClient[] };

interface Participant<C> {
	member: Member;
	runtime: Volatile;
	connection: ConnectionState<C>;
}

export const CLOSE_POLICY = 1008;
export const CLOSE_REPLACED = 4000;
export const CLOSE_FULL = 4001;
export const CLOSE_KICKED = 4003;
export const CLOSE_TIMEOUT = 4008;
export const CLOSE_CLOSING = 4010;

export class RoomCore<C> {
	private readonly participants = new Map<AvatarId, Participant<C>>();
	private readonly connectionToId = new Map<C, AvatarId>();
	private nextDropOrder = 0;
	private readonly conversations: RoomConversations<C>;
	readonly stats: RoomStats = { inbound: 0, connects: 0, rejectedMoves: 0, says: 0 };
	private readonly relations = new Map<AvatarId, MemberRelations>();
	/** Recent chat for reports; the adapter persists it (docs/prd.md 3.3). */
	get chatLog(): readonly ChatLine[] {
		return this.conversations.chatLog;
	}

	private readonly transport: Transport<C>;
	private readonly world: World;
	private readonly clock: () => number;
	/** Production limits, or free play (docs/prd.md 3.7). */
	readonly rules: RoomRules;
	private readonly space: RoomSpace;
	private readonly interactions: RoomInteractions<C>;
	private readonly life: RoomLife<C>;
	private readonly movement: RoomMovement<C>;

	constructor(
		transport: Transport<C>,
		world: World,
		clock: () => number,
		newId: () => string,
		options: {
			rules?: RoomRules;
			store?: BuildStore;
			items?: ItemStore;
			life?: LifeStore;
			wallets?: WalletStore;
		} = {},
	) {
		// nothing reaches a dropped connection: what matters is kept for when they are back, and their state
		// is saved on the new connection
		this.transport = {
			send: (c, msg) => {
				const state = this.participantFor(c)?.connection;
				const away = state?.kind === "away" ? state : undefined;
				if (!away) transport.send(c, msg);
				else if (KEPT_WHILE_AWAY.has(msg.t) && away.missed.length < KEPT_WHILE_AWAY_MAX)
					away.missed.push(msg);
			},
			close: (c, code, reason) => transport.close(c, code, reason),
			persist: (c, member) =>
				this.participantFor(c)?.connection.kind !== "away" && transport.persist(c, member),
		};
		this.movement = new RoomMovement(this.transport, (m, msg, except) => this.broadcastAbout(m, msg, except));
		this.conversations = new RoomConversations({
			rules: options.rules ?? PRODUCTION_RULES,
			stats: this.stats,
			transport: this.transport,
			clock,
			newId,
			memberById: (id) => this.memberById(id),
			connectionFor: (id) => this.connectionFor(id),
			blockedBetween: (a, b) => this.blockedBetween(a, b),
			broadcastAbout: (m, msg, except, target, speech) => this.broadcastAbout(m, msg, except, target, speech),
			contextFor: (m, now) => this.contextFor(m, now),
			notice: (conn, kind, message) => this.notice(conn, kind, message),
		});
		this.world = world;
		this.clock = clock;
		this.rules = options.rules ?? PRODUCTION_RULES;
		this.space = new RoomSpace(world, this.rules, options.store, {
			clock,
			newId,
			members: () => this.memberValues(),
			memberById: (id) => this.memberById(id),
			blockedBetween: (a, b) => this.blockedBetween(a, b),
			broadcastAll: (msg) => this.broadcastAll(msg),
			stopThoseCrossing: (now) => this.stopThoseCrossing(now),
		});
		this.life = new RoomLife(world, this.transport, transport, options, {
			space: this.space,
			movement: this.movement,
			clock,
			newId,
			memberValues: () => this.memberValues(),
			memberEntries: () => this.memberEntries(),
			has: (id) => this.has(id),
			connectionFor: (id) => this.connectionFor(id),
			isAway: (conn) => this.participantFor(conn)?.connection.kind === "away",
			accompanying: (m) => this.interactions.accompanying(m),
			broadcastAbout: (m, msg) => this.broadcastAbout(m, msg),
			broadcastAll: (msg) => this.broadcastAll(msg),
			notice: (conn, kind, message) => this.notice(conn, kind, message),
		});
		this.interactions = new RoomInteractions(world, this.transport, this.space, this.life, {
			movement: this.movement,
			clock,
			memberById: (id) => this.memberById(id),
			memberValues: () => this.memberValues(),
			memberEntries: () => this.memberEntries(),
			connectionFor: (id) => this.connectionFor(id),
			has: (id) => this.has(id),
			blockedBetween: (a, b) => this.blockedBetween(a, b),
			broadcastAbout: (m, msg, except, target, social) => this.broadcastAbout(m, msg, except, target, social),
			notice: (conn, kind, message) => this.notice(conn, kind, message),
			land: (conn, m, pos, now) => this.land(conn, m, pos, now),
		});
	}

	loadItems(saved: Item[] | undefined): void {
		this.life.loadItems(saved);
	}
	get itemList(): Item[] {
		return this.life.itemList;
	}

	/** The walkable area now (the guide plans its walks on it). */
	get terrain(): Walkable {
		return this.space.terrain;
	}

	/** Can people build here at all. */
	get canBuild(): boolean {
		return this.space.canBuild;
	}

	// ---- membership ---------------------------------------------------------

	/** Re-adds a member after the Durable Object woke from hibernation. */
	restore(conn: C, member: Member): void {
		const previous = this.participants.get(member.id);
		if (previous) this.connectionToId.delete(previous.connection.conn);
		this.participants.set(member.id, {
			member,
			runtime: this.freshVolatile(),
			connection: { kind: "active", conn },
		});
		this.connectionToId.set(conn, member.id);
		this.conversations.restore(member);
	}

	/** Returns a reason when the area cannot take this avatar (docs/prd.md 3.3 item 7). */
	admissionError(info: JoinInfo): string | null {
		if (info.system) return null;
		const r = this.rules;
		const full = (n: number, limit: number | null) => limit !== null && n >= limit;
		const others = [...this.memberValues()].filter((m) => m.id !== info.id);
		if (full(others.length, r.capacityTotal)) return "街が満員です";
		if (info.kind === "ai") {
			const ais = others.filter((m) => m.kind === "ai");
			if (full(ais.length, r.capacityAi)) return "AIの定員に達しています";
			const mine = ais.filter((m) => m.ownerId === info.ownerId);
			if (r.agentsPerOwner !== null && full(mine.length, info.ownerAgentLimit ?? r.agentsPerOwner))
				return "このオーナーのAIは同時入場数の上限に達しています";
			if (info.trust === "provisional") {
				const prov = ais.filter((m) => m.trust === "provisional");
				if (full(prov.length, r.capacityProvisionalAi)) return "仮承認AIの定員に達しています";
				if (full(prov.filter((m) => m.ownerId === info.ownerId).length, r.provisionalPerOwner))
					return "仮承認のAIはオーナーごとに1体までです";
			}
		}
		return null;
	}

	/** `arrive`: through a portal, the landmark or portal to appear at instead of the spawn point (docs/prd.md 3.8). */
	join(conn: C, info: JoinInfo, arrive?: string): boolean {
		const now = this.clock();
		const old = this.connectionFor(info.id);
		// still here: their connection dropped, or it has not been noticed yet (the old one is let go)
		if (old !== undefined && old !== conn) return this.resume(old, conn, info, now);
		const err = this.admissionError(info);
		if (err) {
			this.transport.send(conn, { t: "NOTICE", kind: "rejected", message: err });
			this.transport.close(conn, CLOSE_FULL, "full");
			return false;
		}
		const member: Member = {
			...info,
			status: "active",
			move: { kind: "idle", pos: this.space.spawnPoint(arrive), at: now },
			interest: INTEREST_RADIUS_DEFAULT,
		};
		const entered = member.kind === "ai" ? this.life.lifeOnEntry(info.life, now) : null;
		if (entered) member.life = entered.life;
		else delete member.life;
		this.participants.set(member.id, {
			member,
			runtime: this.freshVolatile(),
			connection: { kind: "active", conn },
		});
		this.connectionToId.set(conn, member.id);
		this.stats.connects++;
		this.transport.persist(conn, member);
		this.welcome(conn, member, now);
		if (entered?.review) {
			this.life.saveLife(member.id, entered.life);
			this.transport.send(conn, { t: "DAY", review: entered.review, life: entered.life });
		}
		// the owner's page shows how their AI is doing (docs/life.md 8), whichever of them came first
		if (member.kind === "ai") this.life.sendLife(member, false);
		else for (const ai of this.memberValues()) if (ai.ownerId === member.id) this.life.sendLife(ai, false);
		if (member.coins !== undefined) this.transport.send(conn, { t: "WALLET", coins: member.coins });
		this.broadcastAbout(member, { t: "JOINED", avatar: this.toState(member) }, conn);
		// an AI whose owner is walking with company joins them at once
		if (member.kind === "ai") {
			const owner = this.memberById(member.ownerId);
			if (owner?.companion) {
				this.transport.send(conn, { t: "COMPANY", owner: owner.id, on: true });
				// its mood goes up from now on
				if (member.life) {
					member.companyAt = now;
					this.transport.persist(conn, member);
				}
				this.interactions.accompany(owner, now);
			}
		}
		return true;
	}

	/**
	 * Someone still here comes in again on a new connection: their connection dropped (or this one replaces
	 * theirs, like their PC taking over from the browser). They carry on as they were (where they stand, their
	 * conversations, company, what they hold), and the others hear nothing unless they look different now.
	 * They get the area afresh (WELCOME, `resumed`), then what they missed while away.
	 */
	private resume(old: C, conn: C, info: JoinInfo, now: number): boolean {
		const participant = this.participantFor(old);
		if (!participant) return false;
		const was = participant.member;
		const away = participant.connection.kind === "away" ? participant.connection : undefined;
		if (!away) this.transport.close(old, CLOSE_REPLACED, "replaced by a new connection");
		participant.runtime.lastSeen = now;
		this.connectionToId.delete(old);
		// the life and wallet kept here are newer than what was read from D1 for the new connection
		const member: Member = {
			...was,
			...info,
			...(was.life ? { life: was.life } : {}),
			...(was.coins !== undefined ? { coins: was.coins } : {}),
		};
		participant.member = member;
		participant.connection = { kind: "active", conn };
		this.participants.delete(member.id);
		this.participants.set(member.id, participant);
		this.connectionToId.set(conn, member.id);
		this.transport.persist(conn, member);
		this.welcome(conn, member, now, true);
		if (member.coins !== undefined) this.transport.send(conn, { t: "WALLET", coins: member.coins });
		for (const msg of away?.missed ?? []) this.transport.send(conn, msg);
		const before = this.toState(was);
		const after = this.toState(member);
		if (JSON.stringify({ ...before, move: null }) !== JSON.stringify({ ...after, move: null }))
			this.broadcastAbout(member, { t: "JOINED", avatar: after }, conn);
		// an AI walking with its owner: its new connection is told again (the host moves it all along)
		if (this.interactions.accompanying(member))
			this.transport.send(conn, { t: "COMPANY", owner: member.ownerId, on: true });
		return true;
	}

	private welcome(conn: C, member: Member, now: number, resumed = false): void {
		const welcome: HostToClient = {
			t: "WELCOME",
			you: member.id,
			serverTime: now,
			budget: 0,
			avatars: [...this.memberValues()].map((m) => this.toState(m)),
		};
		if (resumed) welcome.resumed = true;
		if (this.canBuild) welcome.builds = this.space.buildList;
		if (this.life.itemList.length > 0) welcome.items = this.life.itemList;
		if (member.life) welcome.life = decay(member.life, now);
		this.transport.send(conn, welcome);
	}

	/**
	 * Called when a connection dropped (closed without a word, or errored): they stay AWAY_GRACE_MS in case they
	 * come straight back (`join` then resumes them). `member` is what it last persisted, for a connection that
	 * dropped while the room slept (not restored on waking). Returns until when they wait, or null when there
	 * is no one to wait for (they are back already, or were let go).
	 */
	dropped(conn: C, member?: Member): number | null {
		if (this.participantFor(conn)?.connection.kind === "away") return null;
		if (!this.connectionToId.has(conn)) {
			if (!member || this.participants.has(member.id)) return null;
			this.restore(conn, member);
		}
		const until = this.clock() + AWAY_GRACE_MS;
		const participant = this.participantFor(conn);
		if (!participant) return null;
		participant.connection = { kind: "away", conn, until, order: this.nextDropOrder++, missed: [] };
		return until;
	}

	/** Those whose connection dropped and who did not come back in time leave now. */
	expireAway(): void {
		const now = this.clock();
		const expired = [...this.participants.values()]
			.map(({ connection }) => connection)
			.filter((connection) => connection.kind === "away")
			.filter((connection) => connection.until <= now)
			.sort((a, b) => a.order - b.order);
		for (const connection of expired) this.removeMember(connection.conn, "timeout");
	}

	/** Called when the socket closed or errored. */
	leave(conn: C, reason: LeaveReason = "quit"): void {
		this.removeMember(conn, reason);
	}

	/**
	 * Called when a socket closed that the room may not know: one that closed while the room slept is not
	 * among the sockets restored on waking, so `member` (what it last persisted) says who left. Unless they are
	 * here under another connection (they came back in, replacing it), they leave as if the room had been
	 * awake, so the others hear LEFT and what they held is put down.
	 */
	departed(conn: C, member: Member, reason: LeaveReason = "quit"): void {
		if (!this.connectionToId.has(conn) && !this.participants.has(member.id)) this.restore(conn, member);
		this.removeMember(conn, reason);
	}

	/** Removes members without a heartbeat or message for PRESENCE_TIMEOUT_MS and stale conversations. */
	sweep(lastPing: (conn: C) => number | null): void {
		const now = this.clock();
		this.expireAway();
		this.life.payJobs(now);
		for (const [conn, m] of [...this.memberEntries()]) {
			if (this.participantFor(conn)?.connection.kind === "away") continue;
			const v = this.participantFor(conn)?.runtime;
			const last = Math.max(v?.lastSeen ?? 0, lastPing(conn) ?? 0);
			if (now - last > PRESENCE_TIMEOUT_MS) {
				this.removeMember(conn, "timeout");
				this.transport.close(conn, CLOSE_TIMEOUT, "no heartbeat");
			}
			void m;
		}
		this.conversations.expireConversations(now);
		this.interactions.settleSeatPlans(now);
		this.interactions.keepCompany(now);
		this.life.lifeTick(now);
		this.conversations.expireCooldowns(now);
	}

	/** Closes every connection (closing time). */
	closeAll(reason: LeaveReason, code: number, message: string): void {
		for (const conn of [...this.connections()]) {
			this.removeMember(conn, reason);
			this.transport.close(conn, code, message);
		}
	}

	get size(): number {
		return this.participants.size;
	}

	/** Whether `id` is here now. */
	has(id: AvatarId): boolean {
		return this.participants.has(id);
	}

	// ---- moderation -----------------------------------------------------------

	setRelations(id: AvatarId, r: { mutes: string[]; blocks: string[]; blockedBy: string[] }): void {
		this.relations.set(id, {
			mutes: new Set(r.mutes),
			blocks: new Set(r.blocks),
			blockedBy: new Set(r.blockedBy),
		});
	}

	/** Applies a mute/block change made through the API while both may be in the area. */
	updateRelation(accountId: AvatarId, targetId: AvatarId, kind: "mute" | "block", on: boolean): void {
		const mine = this.relations.get(accountId);
		if (mine) (kind === "mute" ? mine.mutes : mine.blocks)[on ? "add" : "delete"](targetId);
		const theirs = this.relations.get(targetId);
		if (theirs && kind === "block") theirs.blockedBy[on ? "add" : "delete"](accountId);
		if (on && kind === "block") this.conversations.closeBetween(accountId, targetId);
	}

	/** True if `viewer` does not want to hear from `speaker`. */
	private silenced(viewer: AvatarId, speaker: AvatarId): boolean {
		const r = this.relations.get(viewer);
		return !!r && (r.mutes.has(speaker) || r.blocks.has(speaker));
	}

	/** True if either side blocked the other. */
	private blockedBetween(a: AvatarId, b: AvatarId): boolean {
		return !!(this.relations.get(a)?.blocks.has(b) || this.relations.get(b)?.blocks.has(a));
	}

	kick(id: AvatarId, reason = "kicked", message = "モデレーターにより退出しました"): boolean {
		const conn = this.connectionFor(id);
		if (conn === undefined) return false;
		this.transport.send(conn, { t: "NOTICE", kind: "rejected", message });
		this.removeMember(conn, "kicked");
		this.transport.close(conn, CLOSE_KICKED, reason);
		return true;
	}

	muteFor(id: AvatarId, until: number): boolean {
		const conn = this.connectionFor(id);
		const m = conn === undefined ? undefined : this.memberFor(conn);
		if (conn === undefined || !m) return false;
		m.mutedUntil = until;
		this.transport.persist(conn, m);
		this.transport.send(conn, {
			t: "NOTICE",
			kind: "muted_by_moderator",
			message: `モデレーターにより ${Math.ceil((until - this.clock()) / 60_000)} 分間発言できません`,
		});
		return true;
	}

	/** Chat lines spoken by or to `id` in the last `ms`. */
	excerpt(id: AvatarId, ms: number): ChatLine[] {
		return this.conversations.excerpt(id, ms);
	}

	// ---- messages -----------------------------------------------------------

	handle(conn: C, msg: ClientToHost): void {
		const participant = this.participantFor(conn);
		if (!participant) return;
		const { member: m, runtime: v } = participant;
		const now = this.clock();
		v.lastSeen = now;
		this.stats.inbound++;
		switch (msg.t) {
			case "MOVE_PATH":
			case "MOVE_VEL": {
				if (!this.moveToken(v, now)) {
					this.violation(conn, v, now);
					return;
				}
				// walking with its owner the host moves it; with the owner standing still, it may step about close by;
				// hugging (or shaking hands), an AI stays where it is
				if (
					(this.interactions.accompanying(m) && !this.interactions.freeStep(m, msg, now)) ||
					(m.kind !== "human" && this.interactions.togetherNow(m, now))
				) {
					this.transport.send(conn, { t: "CORRECT", move: m.move });
					return;
				}
				// a person walking off in the middle of a hug ends it for both (stepping back after it does not)
				// (a stop where one is, as a page says on arriving, is not walking off)
				const off = msg.t === "MOVE_PATH" || msg.speed > 0;
				if (m.kind === "human" && off && m.together && now < m.together.until)
					this.interactions.endTogether(m);
				msg.t === "MOVE_PATH" ? this.movePath(conn, m, msg, now) : this.moveVel(conn, m, msg, now);
				if (m.companion) this.interactions.accompany(m, now);
				// walking out of where one works or studies ends it
				if (m.job && !this.life.inJobZone(m, m.job.zone, now)) this.life.stopJob(m, now);
				return;
			}
			case "FLY":
			case "WARP": {
				if (!this.moveToken(v, now)) {
					this.violation(conn, v, now);
					return;
				}
				const err = msg.t === "FLY" ? this.fly(conn, m, msg.alt, now) : this.warp(conn, m, msg.to, now);
				if (err) this.notice(conn, "rejected", err);
				if (!err && m.companion) this.interactions.accompany(m, now);
				if (m.job && !this.life.inJobZone(m, m.job.zone, now)) this.life.stopJob(m, now);
				return;
			}
			case "JOB": {
				const err = msg.kind ? this.life.startJob(m, msg.kind, now) : this.life.stopJob(m, now);
				if (err) this.notice(conn, "rejected", err);
				return;
			}
			case "COMPANION":
				this.interactions.companion(conn, m, msg, now);
				return;
			case "LEAD": {
				if (!this.moveToken(v, now)) {
					this.violation(conn, v, now);
					return;
				}
				const err = this.interactions.askLead(conn, m, msg, now);
				if (err) this.notice(conn, "rejected", err);
				return;
			}
			case "ACTION":
				if (!this.moveToken(v, now)) {
					this.violation(conn, v, now);
					return;
				}
				this.interactions.action(conn, m, msg, now);
				return;
			case "BODY": {
				if (!this.moveToken(v, now)) {
					this.violation(conn, v, now);
					return;
				}
				const err = this.interactions.body(m, v, msg, now);
				if (err) this.notice(conn, "rejected", err);
				return;
			}
			case "SAY":
				{
					const result = this.conversations.say(conn, m, v, msg, now);
					if (result === "violation") this.violation(conn, v, now);
				}
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
			case "WATCH_USAGE":
				if (!m.canWatchUsage) return;
				m.watchUsage = msg.on;
				this.transport.persist(conn, m);
				return;
			case "BUILD":
			case "UNBUILD": {
				const err = msg.t === "BUILD" ? this.space.build(m, msg, now) : this.space.unbuild(m, msg);
				if (err) this.notice(conn, "rejected", err, msg.ref);
				return;
			}
			case "OFFER":
			case "PICK":
			case "THROW":
			case "DROP":
			case "BUY":
			case "USE": {
				if (!this.moveToken(v, now)) {
					this.violation(conn, v, now);
					return;
				}
				const err =
					msg.t === "OFFER"
						? this.interactions.offer(m, msg.kind, msg.to, now)
						: msg.t === "PICK"
							? this.life.pick(m, msg.item, now)
							: msg.t === "THROW"
								? this.life.throwItem(m, msg.dir, now)
								: msg.t === "BUY"
									? this.life.buy(m, msg.shop, msg.goods, now)
									: msg.t === "USE"
										? this.life.use(m, now)
										: this.life.drop(m, now);
				if (err) this.notice(conn, "rejected", err);
				return;
			}
			case "ANSWER":
				if (!this.interactions.answerLead(m, msg.to, msg.accept, now))
					this.interactions.answer(m, msg.to, msg.accept, now);
				return;
			case "ACT": {
				if (!this.moveToken(v, now)) {
					this.violation(conn, v, now);
					return;
				}
				const err = this.life.startDoing(conn, m, msg.activity, now);
				if (err) this.notice(conn, "rejected", err);
				return;
			}
			case "ACT_STOP":
				this.life.stopDoing(conn, m, now);
				return;
			case "DIARY_ASK": {
				const err = this.interactions.askDiary(m, msg, now);
				if (err) this.notice(conn, "rejected", err);
				return;
			}
			case "DIARY":
				this.interactions.passDiary(m, msg, now);
				return;
			case "AUTH":
				return; // handled by the adapter before join
		}
	}

	get wakeAt(): number | undefined {
		return this.interactions.wakeAt;
	}
	travel(who: Pick<Member, "id" | "kind" | "companion">, to: AreaId, at: string): void {
		this.interactions.travel(who, to, at);
	}

	payJobs(now = this.clock()): void {
		this.life.payJobs(now);
	}

	private moveToken(v: Volatile, now: number): boolean {
		const rate = this.rules.rateMove;
		return !rate || takeToken(v.moveBucket, rate.rate, rate.burst, now);
	}

	/** Records liveness for a message the adapter handled itself. */
	touch(conn: C): void {
		const v = this.participantFor(conn)?.runtime;
		if (v) v.lastSeen = this.clock();
	}

	/** Afloat one goes anywhere not too far out from where one can walk (docs/prd.md 3.4.13). */
	private inSky(p: Vec2): boolean {
		return dist(this.space.terrain.closestPoint(p), p) <= FLY_REACH;
	}

	private movePath(conn: C, m: Member, msg: Extract<ClientToHost, { t: "MOVE_PATH" }>, now: number): void {
		const here = this.positionOf(m, now);
		const start = msg.path[0] as Vec2;
		const fromHere = dist(start, here) <= this.life.tolerance(m);
		const clear = (path: Vec2[]) =>
			m.fly !== undefined ? path.every((p) => this.inSky(p)) : this.space.walkOf(m).validatePath(path);
		// start exactly where the host thinks the avatar is, so everyone interpolates the same line; that way is
		// checked too (from a little elsewhere it could cut through a wall)
		const mine: Vec2[] = [here, ...msg.path.slice(1)];
		let path: Vec2[] | null =
			fromHere && polylineLength(mine) <= MAX_PATH_LENGTH && clear(msg.path) && clear(mine) ? mine : null;
		// a path through something built (a client or AI that does not know about it yet), or from here through
		// a wall: plan it again
		if (!path && fromHere && m.fly === undefined && (this.space.hasBuilds || clear(msg.path)))
			path = this.space.replan(here, msg.path[msg.path.length - 1] as Vec2, this.space.walkOf(m));
		if (!path) {
			this.reject(conn, m, here, now);
			return;
		}
		this.life.stopDoing(conn, m, now);
		this.movement.commit(conn, m, {
			kind: "path",
			path,
			speed: this.life.speedFor(m, msg.speed, now),
			at: now,
		});
	}

	private moveVel(conn: C, m: Member, msg: Extract<ClientToHost, { t: "MOVE_VEL" }>, now: number): void {
		const here = this.positionOf(m, now);
		// on the ground, from where the host thinks one is to there must be clear (not through a wall)
		const open =
			m.fly !== undefined
				? this.inSky(msg.pos)
				: this.space.walkOf(m).isWalkable(msg.pos) &&
					(dist(msg.pos, here) < 0.05 || this.space.walkOf(m).validatePath([here, msg.pos]));
		if (dist(msg.pos, here) > this.life.tolerance(m) || !open) {
			this.reject(conn, m, here, now);
			return;
		}
		const still = msg.dir[0] === 0 && msg.dir[1] === 0;
		if (msg.speed > 0 && !still) this.life.stopDoing(conn, m, now);
		// speed 0 with a direction: standing, turned that way (docs/prd.md 3.4.11)
		this.movement.commit(
			conn,
			m,
			msg.speed === 0 && !still
				? { kind: "idle", pos: msg.pos, at: now, face: msg.dir }
				: msg.speed === 0 || still
					? { kind: "idle", pos: msg.pos, at: now }
					: {
							kind: "vel",
							pos: msg.pos,
							dir: msg.dir,
							speed: this.life.speedFor(m, msg.speed, now),
							at: now,
						},
		);
	}

	/**
	 * Floats at `alt`, or comes down (null) on the walkable ground nearest below (docs/prd.md 3.4.13). Humans
	 * only, where the area allows it. Null if done, else why not.
	 */
	private fly(conn: C, m: Member, alt: number | null, now: number): string | null {
		if (m.kind !== "human") return "AIは空を飛べません";
		if (alt !== null && !this.world.fly) return "ここでは浮かべません";
		if (alt === null) {
			if (m.fly === undefined) return null;
			delete m.fly;
			this.broadcastAbout(m, { t: "FLEW", id: m.id, alt: null });
			this.land(conn, m, this.positionOf(m, now), now);
			return null;
		}
		const lifting = m.fly === undefined;
		m.fly = alt;
		if (lifting) {
			this.life.stopDoing(conn, m, now);
			// a posture ends: one floats up standing
			const here = this.positionOf(m, now);
			if (m.move.kind === "idle" && m.move.posture) {
				this.movement.liftPosture(conn, m, { kind: "idle", pos: here, at: now });
				this.broadcastAbout(m, { t: "FLEW", id: m.id, alt });
				return null;
			}
		}
		this.transport.persist(conn, m);
		this.broadcastAbout(m, { t: "FLEW", id: m.id, alt });
		return null;
	}

	/** Stands `m` still on the walkable ground nearest `p` (where one lands, or warps to). */
	private land(conn: C, m: Member, p: Vec2, now: number): void {
		const at = this.space.landingPoint(m, p);
		this.movement.commit(conn, m, { kind: "idle", pos: at, at: now });
	}

	/** Humans: at one of the area's landmarks or portals at once, on the ground (docs/prd.md 3.4.14). */
	private warp(conn: C, m: Member, to: string, now: number): string | null {
		if (m.kind !== "human") return "AIは歩いて行ってください";
		const place = this.world.landmarks.find((l) => l.id === to);
		if (!place) return "その場所はありません";
		if (m.warpedAt !== undefined && now - m.warpedAt < WARP_INTERVAL_MS) return "少し待ってください";
		m.warpedAt = now;
		this.life.stopDoing(conn, m, now);
		if (m.fly !== undefined) {
			delete m.fly;
			this.broadcastAbout(m, { t: "FLEW", id: m.id, alt: null });
		}
		this.land(conn, m, this.space.spawnPoint(to), now);
		this.interactions.bringCompany(m, now);
		return null;
	}

	private reject(conn: C, m: Member, here: Vec2, now: number): void {
		this.stats.rejectedMoves++;
		this.movement.correct(conn, m, { kind: "idle", pos: here, at: now });
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

	private notice(conn: C, kind: "rate_limited" | "rejected", message: string, ref?: string): void {
		this.transport.send(conn, ref ? { t: "NOTICE", kind, message, ref } : { t: "NOTICE", kind, message });
	}

	loadBuilds(builds: Build[]): void {
		this.space.loadBuilds(builds);
	}
	get buildList(): Build[] {
		return this.space.buildList;
	}
	clearBuilds(by: AvatarId): number {
		return this.space.clearBuilds(by);
	}
	positionOf(m: Member, now = this.clock()): Vec2 {
		return this.space.positionOf(m, now);
	}
	contextFor(m: Member, now = this.clock()): SpatialContext {
		return this.space.contextFor(m, now, (kind) => !!this.life.jobZoneAt(m, kind, now));
	}

	/** Someone walking a path that now runs into something built stops where they are. */
	private stopThoseCrossing(now: number): void {
		for (const [conn, m] of this.memberEntries()) {
			if (m.move.kind !== "path") continue;
			const rest = remainingPath(m.move, now);
			if (rest.length < 2 || this.space.terrain.validatePath(rest)) continue;
			this.movement.commit(conn, m, { kind: "idle", pos: this.positionOf(m, now), at: now });
		}
	}

	/** Builds change where everyone can walk, so everyone hears about them (not only within interest). */
	private broadcastAll(msg: HostToClient): void {
		for (const conn of this.connections()) this.transport.send(conn, msg);
	}

	/**
	 * Sends a message about `subject` to everyone who should see it: humans always (they render the whole
	 * area), AIs only within their interest radius or when they are `alsoTo`. Arrivals, departures and
	 * status changes reach every AI, so they always know who is in the area and by what name.
	 */
	private broadcastAbout(
		subject: Member,
		msg: HostToClient,
		except?: C,
		alsoTo?: AvatarId,
		/** Chat and gestures: skip recipients who muted or blocked the subject. */
		social = false,
	): void {
		const now = this.clock();
		const at = this.positionOf(subject, now);
		const roster = msg.t === "JOINED" || msg.t === "LEFT" || msg.t === "STATUS_CHANGED";
		for (const [conn, r] of this.memberEntries()) {
			if (conn === except) continue;
			if (social && r.id !== subject.id && this.silenced(r.id, subject.id)) continue;
			if (!roster && r.kind === "ai" && r.id !== subject.id && r.id !== alsoTo) {
				if (dist(this.positionOf(r, now), at) > r.interest) continue;
			}
			this.transport.send(conn, msg);
		}
	}

	private removeMember(conn: C, reason: LeaveReason): void {
		const participant = this.participantFor(conn);
		if (!participant) return;
		const m = participant.member;
		// what working or studying earned until now goes into the wallet (D1); it is not carried on elsewhere
		this.life.leaveJob(m);
		this.participants.delete(m.id);
		this.connectionToId.delete(conn);
		this.relations.delete(m.id);
		this.conversations.leave(m.id);
		this.interactions.leave(m.id);
		// what they were doing ends with what they did of it; their life is saved as it is
		const now = this.clock();
		this.life.leaveActivity(conn, m, now);
		// their AIs no longer walk with them
		if (m.companion) this.interactions.tellCompany(m, false);
		// what they held stays where they were
		this.life.dropHeld(m);
		this.broadcastAbout(m, { t: "LEFT", id: m.id, reason });
	}

	memberById(id: AvatarId): Member | undefined {
		return this.participants.get(id)?.member;
	}

	memberFor(conn: C): Member | undefined {
		return this.participantFor(conn)?.member;
	}

	private participantFor(conn: C): Participant<C> | undefined {
		const id = this.connectionToId.get(conn);
		const participant = id === undefined ? undefined : this.participants.get(id);
		return participant?.connection.conn === conn ? participant : undefined;
	}

	private connectionFor(id: AvatarId): C | undefined {
		return this.participants.get(id)?.connection.conn;
	}

	*memberEntries(): IterableIterator<[C, Member]> {
		for (const { member, connection } of this.participants.values()) yield [connection.conn, member];
	}

	*memberValues(): IterableIterator<Member> {
		for (const { member } of this.participants.values()) yield member;
	}

	*connections(): IterableIterator<C> {
		for (const { connection } of this.participants.values()) yield connection.conn;
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
		if (m.kind === "ai") s.ownerId = m.ownerId;
		if (m.trust) s.trust = m.trust;
		if (m.kind === "human") s.acceptsAi = m.allowAiApproach !== false;
		if (m.doing) s.doing = m.doing;
		if (m.job) s.job = m.job.kind;
		if (m.fly !== undefined) s.fly = m.fly;
		return s;
	}

	private freshVolatile(): Volatile {
		const now = this.clock();
		return {
			moveBucket: { tokens: this.rules.rateMove?.burst ?? 0, at: now },
			sayBucket: { tokens: this.rules.rateSayHuman?.burst ?? 0, at: now },
			violations: [],
			aiSays: [],
			lastAiReplyAt: 0,
			lastSeen: now,
			lastBodyAt: 0,
		};
	}
}
