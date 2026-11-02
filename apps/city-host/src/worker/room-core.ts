// Area logic of CityRoomDO, independent of the Workers runtime so it can be tested in Node
// (docs/prd.md 3.2, 3.3). The Durable Object adapter (room.ts) owns sockets, hibernation and auth.

import { boxNav, claimed, type ModelNav, occupied, overlaps, type PlacedModel } from "@rojibura/nav";
import {
	type AvatarAssets,
	type AvatarId,
	type AvatarKind,
	type AvatarState,
	type Build,
	type BuildAt,
	type BuildId,
	type ClientToHost,
	CONTEXT_AVATAR_RADIUS,
	CONTEXT_LANDMARK_RADIUS,
	CONTEXT_MAX_ITEMS,
	CONV_TIMEOUT_MS,
	dist,
	facing,
	type HostToClient,
	INTEREST_RADIUS_DEFAULT,
	ITEM_REACH,
	type Item,
	type ItemId,
	type ItemKind,
	isPosture,
	LEAD_INTERVAL_MS,
	LEAD_MIN_DISTANCE,
	LEAD_REACH,
	type LeaveReason,
	MAX_PATH_LENGTH,
	MAX_PATH_POINTS,
	MAX_SPEED,
	type ModelId,
	type MoveState,
	OFFER_REACH,
	OFFER_TTL_MS,
	POSITION_TOLERANCE,
	PRESENCE_TIMEOUT_MS,
	polylineLength,
	poseAt,
	RATE_VIOLATIONS_BEFORE_CLOSE,
	type SpatialContext,
	type Status,
	THROW_MS,
	THROW_RANGE,
	THROW_RELEASE_MS,
	TOGETHER_GAP,
	type Together,
	type Vec2,
	WALK_SPEED,
} from "@rojibura/protocol";
import { PRODUCTION_RULES, type RoomRules } from "./rules.ts";

/** What the area needs to know about the walkable ground (implemented with @rojibura/nav). */
export interface Walkable {
	isWalkable(p: Vec2): boolean;
	/** Every vertex and every segment midpoint is walkable. */
	validatePath(path: Vec2[]): boolean;
	closestPoint(p: Vec2): Vec2;
	/** A walkable path between two walkable points, or null. Needed where things can be built. */
	findPath?(from: Vec2, to: Vec2): Vec2[] | null;
}

/** Building (free play, docs/prd.md 3.7): models, the ground's height, and the walkable area with builds. */
export interface BuildWorld {
	/** How a model changes the walkable area; undefined if there is no such model ("block" is handled here). */
	model(id: ModelId): ModelNav | undefined;
	/** Height of the city's ground at `p` (the base of a build), or null off it. */
	groundHeight(p: Vec2): number | null;
	/** The city's walkable area with these built on it. */
	walkWith(placed: PlacedModel[]): Walkable;
}

/** Saves builds (DO SQLite). */
export interface BuildStore {
	save(b: Build): void;
	remove(id: BuildId): void;
}

/**
 * Where your AIs walk with you (docs/prd.md 3.4.9): this far ahead and this far to one side (m), far enough
 * ahead to be in view from your own eyes (the first-person view).
 */
const COMPANION_WALKING: Vec2 = [2, 0.8];
/**
 * Where they stand when you stop: a metre away, 25° to one side, so its face is in view from your eyes and a
 * second one on the other side does not stand in the first.
 */
const COMPANION_STANDING: Vec2 = [0.91, 0.42];
/** How long after arriving an AI that took its owner somewhere waits for them before walking with them again. */
const LEAD_GRACE_MS = 2 * 60_000;
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

/** Saves the area's small things whenever one changes (DO key-value storage). */
export interface ItemStore {
	save(items: Item[]): void;
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
	/** Where building is possible (free play). */
	build?: BuildWorld;
	/** Published builds that are part of the city (already in `walk`); only for spatial context. */
	fixedBuilds?: Build[];
	/** Small things that are there when the area starts with none saved (docs/prd.md 3.4.7). */
	items?: { kind: ItemKind; pos: Vec2 }[];
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
	/** Run by the host itself (the guide): exempt from capacity and AI rate limits. */
	system?: boolean;
	/** Admins, moderators and development: may watch the area's free-tier usage (docs/prd.md 2.5). */
	canWatchUsage?: boolean;
}

/** Member state that survives hibernation (kept in the WebSocket attachment, < 2 KB). */
export interface Member extends JoinInfo {
	status: Status;
	move: MoveState;
	interest: number;
	/** Set by a moderator: no SAY until this host time. */
	mutedUntil?: number;
	/** Open conversations and AI-pair cooldowns of this member, so they survive hibernation. */
	convs?: Conv[];
	cooldowns?: Record<AvatarId, number>;
	/** Watching the usage dashboard: the adapter pushes USAGE to them. */
	watchUsage?: boolean;
	/** Humans: their own AIs walk with them (docs/prd.md 3.4.9). */
	companion?: boolean;
	/** Which way the avatar last walked (the host knows no facing): companions keep to its front. */
	heading?: Vec2;
	/** AIs: taking the owner to a place (docs/prd.md 3.4.10); walking with them again after `until` at last. */
	lead?: { to: Vec2; place: string; until: number };
	/** AIs: when it last asked its owner to come along (one ask per LEAD_INTERVAL_MS). */
	leadAskedAt?: number;
}

/** Personal mutes and blocks that concern one avatar (docs/prd.md 4.2). */
export interface MemberRelations {
	mutes: Set<AvatarId>;
	blocks: Set<AvatarId>;
	/** Accounts that blocked this avatar. */
	blockedBy: Set<AvatarId>;
}

export interface ChatLine {
	at: number;
	id: AvatarId;
	name: string;
	to?: AvatarId;
	text: string;
}

const CHAT_LOG_MAX = 2000;

/** Building: keep this clear around the spawn point and landmarks (m). */
const SPAWN_CLEAR = 3.5;
const LANDMARK_CLEAR = 1.5;
/** Searching for a free spot: rings this far apart, this many directions, this many rings. */
const SPOT_STEP = 1;
const SPOT_DIRECTIONS = 16;
const SPOT_RINGS = 12;
/** Spots whose cheap checks pass and whose walkable area is then computed, at most. */
const SPOT_FULL_CHECKS = 4;
const BLOCK_DEFAULT_SIZE: [number, number, number] = [1, 1, 1];

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

export interface Conv {
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
	private readonly relations = new Map<AvatarId, MemberRelations>();
	/** Recent chat for reports; the adapter persists it (docs/prd.md 3.3). */
	readonly chatLog: ChatLine[] = [];

	private readonly transport: Transport<C>;
	private readonly world: World;
	private readonly clock: () => number;
	private readonly newId: () => string;
	/** Production limits, or free play (docs/prd.md 3.7). */
	readonly rules: RoomRules;
	/** Things built in the area, oldest first (free play). */
	private readonly builds = new Map<BuildId, Build>();
	private readonly store: BuildStore | undefined;
	/** The walkable area: the city's, with the builds on it. */
	private walk: Walkable;
	/** Offers to do something together, by "from to" (docs/prd.md 3.4.6); they lapse after OFFER_TTL_MS. */
	private readonly offers = new Map<string, { kind: Together; at: number }>();
	/** An AI's open ask to its owner to come along, by the AI (docs/prd.md 3.4.10); lapses after OFFER_TTL_MS. */
	private readonly leads = new Map<AvatarId, { owner: AvatarId; to: Vec2; place: string; at: number }>();
	/** Small things in the area (docs/prd.md 3.4.7). */
	private readonly items = new Map<ItemId, Item>();
	private readonly itemStore: ItemStore | undefined;
	/** Members whose connection dropped, by that dead connection: until when they wait, and what they missed. */
	private readonly away = new Map<C, { until: number; missed: HostToClient[] }>();

	constructor(
		transport: Transport<C>,
		world: World,
		clock: () => number,
		newId: () => string,
		options: { rules?: RoomRules; store?: BuildStore; items?: ItemStore } = {},
	) {
		// nothing reaches a dropped connection: what matters is kept for when they are back, and their state
		// is saved on the new connection
		this.transport = {
			send: (c, msg) => {
				const away = this.away.get(c);
				if (!away) transport.send(c, msg);
				else if (KEPT_WHILE_AWAY.has(msg.t) && away.missed.length < KEPT_WHILE_AWAY_MAX)
					away.missed.push(msg);
			},
			close: (c, code, reason) => transport.close(c, code, reason),
			persist: (c, member) => !this.away.has(c) && transport.persist(c, member),
		};
		this.world = world;
		this.clock = clock;
		this.newId = newId;
		this.rules = options.rules ?? PRODUCTION_RULES;
		this.store = options.store;
		this.itemStore = options.items;
		this.walk = world.walk;
	}

	/**
	 * Puts the small things where they were saved, or where the area starts them. Things held by someone who
	 * is not here (they left while the room slept) lie where they were picked up.
	 */
	loadItems(saved: Item[] | undefined): void {
		this.items.clear();
		const items: Item[] =
			saved ??
			(this.world.items ?? [])
				.filter((i) => this.walk.isWalkable(i.pos))
				.map((i) => ({ id: `i_${this.newId()}`, kind: i.kind, pos: i.pos }));
		for (const item of items) {
			if (item.holder && !this.byId.has(item.holder)) delete item.holder;
			this.items.set(item.id, item);
		}
	}

	/** The small things, for saving or checking. */
	get itemList(): Item[] {
		return [...this.items.values()];
	}

	/** The walkable area now (the guide plans its walks on it). */
	get terrain(): Walkable {
		return this.walk;
	}

	/** Can people build here at all. */
	get canBuild(): boolean {
		return this.rules.build !== null && this.world.build !== undefined;
	}

	// ---- membership ---------------------------------------------------------

	/** Re-adds a member after the Durable Object woke from hibernation. */
	restore(conn: C, member: Member): void {
		this.members.set(conn, member);
		this.byId.set(member.id, conn);
		this.volatile.set(conn, this.freshVolatile());
		for (const c of member.convs ?? []) if (!this.convs.has(c.id)) this.convs.set(c.id, { ...c });
		for (const [other, until] of Object.entries(member.cooldowns ?? {}))
			this.pairCooldown.set(
				pairKey(member.id, other),
				Math.max(until, this.pairCooldown.get(pairKey(member.id, other)) ?? 0),
			);
	}

	/** Copies the conversation state of `ids` into their persisted member state. */
	private syncConvs(...ids: AvatarId[]): void {
		const now = this.clock();
		for (const id of ids) {
			const conn = this.byId.get(id);
			const m = conn === undefined ? undefined : this.members.get(conn);
			if (conn === undefined || !m) continue;
			m.convs = [...this.convs.values()].filter((c) => c.a === id || c.b === id).map((c) => ({ ...c }));
			const cooldowns: Record<AvatarId, number> = {};
			for (const [key, until] of this.pairCooldown) {
				if (until <= now) continue;
				const [x, y] = key.split("|");
				if (x === id && y) cooldowns[y] = until;
				else if (y === id && x) cooldowns[x] = until;
			}
			m.cooldowns = cooldowns;
			this.transport.persist(conn, m);
		}
	}

	/** Returns a reason when the area cannot take this avatar (docs/prd.md 3.3 item 7). */
	admissionError(info: JoinInfo): string | null {
		if (info.system) return null;
		const r = this.rules;
		const full = (n: number, limit: number | null) => limit !== null && n >= limit;
		const others = [...this.members.values()].filter((m) => m.id !== info.id);
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
		const old = this.byId.get(info.id);
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
			move: { kind: "idle", pos: this.spawnPoint(arrive), at: now },
			interest: INTEREST_RADIUS_DEFAULT,
		};
		this.members.set(conn, member);
		this.byId.set(member.id, conn);
		this.volatile.set(conn, this.freshVolatile());
		this.stats.connects++;
		this.transport.persist(conn, member);
		this.welcome(conn, member, now);
		this.broadcastAbout(member, { t: "JOINED", avatar: this.toState(member) }, conn);
		// an AI whose owner is walking with company joins them at once
		if (member.kind === "ai") {
			const owner = this.memberById(member.ownerId);
			if (owner?.companion) {
				this.transport.send(conn, { t: "COMPANY", owner: owner.id, on: true });
				this.accompany(owner, now);
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
		const was = this.members.get(old) as Member;
		const away = this.away.get(old);
		this.away.delete(old);
		if (!away) this.transport.close(old, CLOSE_REPLACED, "replaced by a new connection");
		const v = this.volatile.get(old) ?? this.freshVolatile();
		v.lastSeen = now;
		this.members.delete(old);
		this.volatile.delete(old);
		const member: Member = { ...was, ...info };
		this.members.set(conn, member);
		this.byId.set(member.id, conn);
		this.volatile.set(conn, v);
		this.transport.persist(conn, member);
		this.welcome(conn, member, now, true);
		for (const msg of away?.missed ?? []) this.transport.send(conn, msg);
		const before = this.toState(was);
		const after = this.toState(member);
		if (JSON.stringify({ ...before, move: null }) !== JSON.stringify({ ...after, move: null }))
			this.broadcastAbout(member, { t: "JOINED", avatar: after }, conn);
		// an AI walking with its owner: its new connection is told again (the host moves it all along)
		if (this.accompanying(member))
			this.transport.send(conn, { t: "COMPANY", owner: member.ownerId, on: true });
		return true;
	}

	private welcome(conn: C, member: Member, now: number, resumed = false): void {
		const welcome: HostToClient = {
			t: "WELCOME",
			you: member.id,
			serverTime: now,
			budget: 0,
			avatars: [...this.members.values()].map((m) => this.toState(m)),
		};
		if (resumed) welcome.resumed = true;
		if (this.canBuild) welcome.builds = [...this.builds.values()];
		if (this.items.size > 0) welcome.items = [...this.items.values()];
		this.transport.send(conn, welcome);
	}

	/**
	 * Called when a connection dropped (closed without a word, or errored): they stay AWAY_GRACE_MS in case they
	 * come straight back (`join` then resumes them). `member` is what it last persisted, for a connection that
	 * dropped while the room slept (not restored on waking). Returns until when they wait, or null when there
	 * is no one to wait for (they are back already, or were let go).
	 */
	dropped(conn: C, member?: Member): number | null {
		if (this.away.has(conn)) return null;
		if (!this.members.has(conn)) {
			if (!member || this.byId.has(member.id)) return null;
			this.restore(conn, member);
		}
		const until = this.clock() + AWAY_GRACE_MS;
		this.away.set(conn, { until, missed: [] });
		return until;
	}

	/** Those whose connection dropped and who did not come back in time leave now. */
	expireAway(): void {
		const now = this.clock();
		for (const [conn, a] of [...this.away]) if (a.until <= now) this.removeMember(conn, "timeout");
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
		if (!this.members.has(conn) && !this.byId.has(member.id)) this.restore(conn, member);
		this.removeMember(conn, reason);
	}

	/** Removes members without a heartbeat or message for PRESENCE_TIMEOUT_MS and stale conversations. */
	sweep(lastPing: (conn: C) => number | null): void {
		const now = this.clock();
		this.expireAway();
		for (const [conn, m] of [...this.members]) {
			if (this.away.has(conn)) continue;
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

	/** Whether `id` is here now. */
	has(id: AvatarId): boolean {
		return this.byId.has(id);
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
		if (on && kind === "block")
			for (const c of [...this.convs.values()])
				if ((c.a === accountId && c.b === targetId) || (c.a === targetId && c.b === accountId))
					this.endConv(c, "left");
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

	kick(id: AvatarId, reason = "kicked"): boolean {
		const conn = this.byId.get(id);
		if (conn === undefined) return false;
		this.transport.send(conn, { t: "NOTICE", kind: "rejected", message: "モデレーターにより退出しました" });
		this.removeMember(conn, "kicked");
		this.transport.close(conn, CLOSE_KICKED, reason);
		return true;
	}

	muteFor(id: AvatarId, until: number): boolean {
		const conn = this.byId.get(id);
		const m = conn === undefined ? undefined : this.members.get(conn);
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
		const since = this.clock() - ms;
		return this.chatLog.filter((l) => l.at >= since && (l.id === id || l.to === id));
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
				if (!this.moveToken(v, now)) {
					this.violation(conn, v, now);
					return;
				}
				// walking with its owner: the host moves it, its own steps are not taken
				if (this.accompanying(m)) {
					this.transport.send(conn, { t: "CORRECT", move: m.move });
					return;
				}
				msg.t === "MOVE_PATH" ? this.movePath(conn, m, msg, now) : this.moveVel(conn, m, msg, now);
				if (m.companion) this.accompany(m, now);
				return;
			case "COMPANION":
				if (m.kind !== "human") return;
				// also how the owner's page says a walk to a place is over (arrived, or they went their own way)
				this.endLeads(m);
				if (m.companion !== msg.on) this.tellCompany(m, msg.on);
				m.companion = msg.on;
				this.transport.persist(conn, m);
				if (msg.on) this.accompany(m, now);
				return;
			case "LEAD": {
				if (!this.moveToken(v, now)) {
					this.violation(conn, v, now);
					return;
				}
				const err = this.askLead(conn, m, msg, now);
				if (err) this.notice(conn, "rejected", err);
				return;
			}
			case "ACTION":
				if (!this.moveToken(v, now)) {
					this.violation(conn, v, now);
					return;
				}
				if (msg.target && !this.byId.has(msg.target)) return;
				// sitting and lying last until the avatar moves (docs/prd.md 3.4.5): it stops where it is
				if (isPosture(msg.motion)) {
					m.move = { kind: "idle", pos: this.positionOf(m, now), at: now, posture: msg.motion };
					this.transport.persist(conn, m);
					this.broadcastAbout(m, { t: "MOVED", id: m.id, move: m.move });
				}
				this.broadcastAbout(
					m,
					{ t: "ACTED", id: m.id, motion: msg.motion, target: msg.target, at: now },
					undefined,
					undefined,
					true,
				);
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
			case "WATCH_USAGE":
				if (!m.canWatchUsage) return;
				m.watchUsage = msg.on;
				this.transport.persist(conn, m);
				return;
			case "BUILD":
			case "UNBUILD": {
				const err = msg.t === "BUILD" ? this.build(m, msg, now) : this.unbuild(m, msg);
				if (err) this.notice(conn, "rejected", err, msg.ref);
				return;
			}
			case "OFFER":
			case "PICK":
			case "THROW":
			case "DROP": {
				if (!this.moveToken(v, now)) {
					this.violation(conn, v, now);
					return;
				}
				const err =
					msg.t === "OFFER"
						? this.offer(m, msg.kind, msg.to, now)
						: msg.t === "PICK"
							? this.pick(m, msg.item, now)
							: msg.t === "THROW"
								? this.throwItem(m, msg.dir, now)
								: this.drop(m, now);
				if (err) this.notice(conn, "rejected", err);
				return;
			}
			case "ANSWER":
				if (!this.answerLead(m, msg.to, msg.accept, now)) this.answer(m, msg.to, msg.accept, now);
				return;
			case "AUTH":
				return; // handled by the adapter before join
		}
	}

	// ---- doing things together (docs/prd.md 3.4.6) ---------------------------

	private offer(m: Member, kind: Together, to: AvatarId, now: number): string | null {
		const target = this.memberById(to);
		if (!target || target.id === m.id) return "その人はいません";
		if (this.blockedBetween(m.id, target.id)) return "その人には申し込めません";
		if (dist(this.positionOf(m, now), this.positionOf(target, now)) > OFFER_REACH)
			return "もっと近くに行ってから申し込んでください";
		this.offers.set(`${m.id} ${target.id}`, { kind, at: now });
		// the host's own guide says yes at once
		if (target.system) {
			this.answer(target, m.id, true, now);
			return null;
		}
		const tc = this.byId.get(target.id);
		if (tc !== undefined) this.transport.send(tc, { t: "OFFERED", from: m.id, kind });
		return null;
	}

	/**
	 * `m` answers the offer from `to`. Yes: both walk to their places facing each other (centred where they
	 * are, TOGETHER_GAP apart) and start together once both are there. Too late, or nobody: nothing happens.
	 */
	private answer(m: Member, to: AvatarId, accept: boolean, now: number): void {
		const key = `${to} ${m.id}`;
		const offer = this.offers.get(key);
		this.offers.delete(key);
		const from = this.memberById(to);
		const fc = this.byId.get(to);
		const mc = this.byId.get(m.id);
		if (!offer || now - offer.at > OFFER_TTL_MS || !from || fc === undefined || mc === undefined) return;
		const a = this.positionOf(from, now);
		const b = this.positionOf(m, now);
		const d = dist(a, b);
		const u: Vec2 = d > 1e-3 ? [(b[0] - a[0]) / d, (b[1] - a[1]) / d] : [0, 1];
		const mid: Vec2 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
		const half = TOGETHER_GAP[offer.kind] / 2;
		const pa: Vec2 = [mid[0] - u[0] * half, mid[1] - u[1] * half];
		const pb: Vec2 = [mid[0] + u[0] * half, mid[1] + u[1] * half];
		const fits = d <= OFFER_REACH + 1 && this.walk.isWalkable(pa) && this.walk.isWalkable(pb);
		this.transport.send(fc, { t: "ANSWERED", by: m.id, kind: offer.kind, accept: accept && fits });
		if (!accept || !fits) return;
		const ms = Math.max(this.stepTo(fc, from, a, pa, now), this.stepTo(mc, m, b, pb, now));
		this.broadcastAbout(
			from,
			{ t: "TOGETHER", kind: offer.kind, a: from.id, b: m.id, at: now + ms + 200 },
			undefined,
			m.id,
			true,
		);
	}

	/** Walks a member a short way to `to` (or puts them there); returns how long it takes (ms). */
	private stepTo(conn: C, m: Member, here: Vec2, to: Vec2, now: number): number {
		const d = dist(here, to);
		const walk = d > 0.05 && this.walk.validatePath([here, to]);
		m.move = walk
			? { kind: "path", path: [here, to], speed: WALK_SPEED, at: now }
			: { kind: "idle", pos: to, at: now };
		this.transport.persist(conn, m);
		this.broadcastAbout(m, { t: "MOVED", id: m.id, move: m.move });
		return walk ? (d / WALK_SPEED) * 1000 : 0;
	}

	// ---- walking with your AIs (docs/prd.md 3.4.9) ----------------------------

	/** True if `m` is an AI whose owner is here and walking with company. */
	private accompanying(m: Member): boolean {
		return m.kind === "ai" && !!this.memberById(m.ownerId)?.companion;
	}

	/**
	 * Moves the owner's AIs to keep just ahead of them, one to each side: along the owner's path shifted
	 * sideways (or, walking with keys, to where the owner will be a few seconds on), at the speed that gets
	 * there when the owner does, and, when the owner stops, up close in front of them.
	 */
	private accompany(owner: Member, now: number): void {
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
		for (const [conn, ai] of this.members) {
			if (ai.kind !== "ai" || ai.ownerId !== owner.id) continue;
			const side = slot++ % 2 === 0 ? 1 : -1;
			// taking the owner somewhere: it leads, the owner follows (until it is over, or long past)
			if (ai.lead && now < ai.lead.until) continue;
			if (ai.lead) {
				delete ai.lead;
				this.transport.persist(conn, ai);
			}
			this.companionStep(conn, ai, owner, side, ahead, now);
		}
	}

	/** Tells the owner's AIs here that they walk with the owner now, or no longer. */
	private tellCompany(owner: Member, on: boolean): void {
		for (const [conn, ai] of this.members)
			if (ai.kind === "ai" && ai.ownerId === owner.id)
				this.transport.send(conn, { t: "COMPANY", owner: owner.id, on });
	}

	// ---- an AI taking its owner somewhere (docs/prd.md 3.4.10) -----------------

	/** The way from `from` to `to` as one move, or null; a way of more points ends where one move does. */
	private leadPath(from: Vec2, to: Vec2): Vec2[] | null {
		const way = this.walk.findPath?.(this.walk.closestPoint(from), to) ?? [from, to];
		if (way.length < 2) return null;
		const path = [from, ...way.slice(1)].slice(0, MAX_PATH_POINTS);
		return polylineLength(path) <= MAX_PATH_LENGTH && this.walk.validatePath(path) ? path : null;
	}

	/** An AI walking with its owner asks them to come along to a place; the owner's page asks them. */
	private askLead(conn: C, m: Member, msg: Extract<ClientToHost, { t: "LEAD" }>, now: number): string | null {
		const owner = m.kind === "ai" ? this.memberById(m.ownerId) : undefined;
		const oc = owner ? this.byId.get(owner.id) : undefined;
		if (!owner || oc === undefined || !owner.companion) return "オーナーと歩いているときだけ誘えます";
		if (m.leadAskedAt !== undefined && now - m.leadAskedAt < LEAD_INTERVAL_MS)
			return "さっき誘ったばかりです";
		const here = this.positionOf(m, now);
		if (dist(here, this.positionOf(owner, now)) > LEAD_REACH) return "オーナーが遠すぎます";
		const to = this.walk.closestPoint(msg.to);
		if (dist(here, to) < LEAD_MIN_DISTANCE) return "そこはすぐそばです";
		if (!this.leadPath(here, to)) return "そこへは歩いて行けません";
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
	private answerLead(m: Member, to: AvatarId, accept: boolean, now: number): boolean {
		const lead = this.leads.get(to);
		if (!lead || lead.owner !== m.id) return false;
		this.leads.delete(to);
		const ai = this.memberById(to);
		const ac = this.byId.get(to);
		const mc = this.byId.get(m.id);
		if (!ai || ac === undefined || mc === undefined || now - lead.at > OFFER_TTL_MS) return true;
		const path = accept && this.accompanying(ai) ? this.leadPath(this.positionOf(ai, now), lead.to) : null;
		if (accept && !path) this.notice(mc, "rejected", "そこへは行けなくなりました");
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
		ai.move = { kind: "path", path, speed: WALK_SPEED, at: now };
		this.transport.persist(ac, ai);
		this.broadcastAbout(ai, { t: "MOVED", id: ai.id, move: ai.move });
		this.transport.send(mc, { t: "LEADING", by: ai.id, to: end, place: lead.place });
		return true;
	}

	/** Ends the owner's AIs' walks to a place, and their open asks. */
	private endLeads(owner: Member): void {
		for (const [conn, ai] of this.members) {
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
	private beside(at: Vec2, ahead: Vec2, side: number, slot = COMPANION_WALKING, strict = false): Vec2 | null {
		// facing +z the right hand is on -x: right = (-ahead.z, ahead.x)
		const right: Vec2 = [-ahead[1], ahead[0]];
		const [front, aside] = slot;
		const p: Vec2 = [
			at[0] + ahead[0] * front + right[0] * aside * side,
			at[1] + ahead[1] * front + right[1] * aside * side,
		];
		if (this.walk.isWalkable(p)) return p;
		return strict ? null : this.walk.closestPoint(p);
	}

	private companionStep(conn: C, ai: Member, owner: Member, side: number, ahead: Vec2, now: number): void {
		const from = this.positionOf(ai, now);
		const om = owner.move;
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
				return (last ? this.beside(p, dir, side) : this.beside(p, dir, side, COMPANION_WALKING, true)) ?? p;
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
				if (!this.walk.validatePath([this.positionOf(owner, now), ahead])) continue;
				const there = this.beside(ahead, om.dir, side);
				if (there) {
					path = [from, there];
					ms = s * 1000;
					break;
				}
			}
		} else {
			// the owner has stopped: it comes up close
			const there = this.beside(this.positionOf(owner, now), ahead, side, COMPANION_STANDING);
			if (there) path = [from, there];
		}
		// a fountain or a wall in the way: find a way round it to the same place, there at the same time
		if (path && path.length >= 2 && !this.walk.validatePath(path)) {
			const to = path[path.length - 1] as Vec2;
			const round = this.walk.findPath?.(this.walk.closestPoint(from), this.walk.closestPoint(to));
			path = round && round.length >= 2 ? [from, ...round.slice(1)].slice(0, MAX_PATH_POINTS) : null;
		}
		if (!path || path.length < 2 || polylineLength(path) > MAX_PATH_LENGTH || !this.walk.validatePath(path))
			return;
		const length = polylineLength(path);
		if (length < 0.15) return;
		// as long as the owner takes; when the owner has stopped, a walk (a run if far behind)
		const speed = ms > 0 ? (length / ms) * 1000 : length > 6 ? 4 : WALK_SPEED;
		ai.move = { kind: "path", path, speed: Math.min(MAX_SPEED, Math.max(0.5, speed)), at: now };
		this.transport.persist(conn, ai);
		this.broadcastAbout(ai, { t: "MOVED", id: ai.id, move: ai.move });
	}

	// ---- small things (docs/prd.md 3.4.7) -----------------------------------

	private holding(id: AvatarId): Item | undefined {
		for (const item of this.items.values()) if (item.holder === id) return item;
		return undefined;
	}

	private itemChanged(item: Item): void {
		this.itemStore?.save([...this.items.values()]);
		this.broadcastAll({ t: "ITEM", item });
	}

	private pick(m: Member, id: ItemId, now: number): string | null {
		const item = this.items.get(id);
		if (!item) return "それはありません";
		if (item.holder) return "ほかの人が持っています";
		if (this.holding(m.id)) return "もう何か持っています";
		if (item.flight && now < item.flight.at + item.flight.dur) return "まだ飛んでいます";
		if (dist(this.positionOf(m, now), item.pos) > ITEM_REACH) return "もっと近くに行ってください";
		item.holder = m.id;
		delete item.flight;
		this.itemChanged(item);
		return null;
	}

	/** Lands THROW_RANGE ahead, or on the nearest ground short of it (no bouncing, no catching). */
	private throwItem(m: Member, dir: Vec2, now: number): string | null {
		const item = this.holding(m.id);
		if (!item) return "何も持っていません";
		const from = this.positionOf(m, now);
		const ahead: Vec2 = [from[0] + dir[0] * THROW_RANGE, from[1] + dir[1] * THROW_RANGE];
		delete item.holder;
		item.pos = this.walk.isWalkable(ahead) ? ahead : this.walk.closestPoint(ahead);
		item.flight = { from, at: now + THROW_RELEASE_MS, dur: THROW_MS };
		this.itemChanged(item);
		return null;
	}

	private drop(m: Member, now: number): string | null {
		const item = this.holding(m.id);
		if (!item) return "何も持っていません";
		delete item.holder;
		delete item.flight;
		item.pos = this.positionOf(m, now);
		this.itemChanged(item);
		return null;
	}

	private moveToken(v: Volatile, now: number): boolean {
		const rate = this.rules.rateMove;
		return !rate || takeToken(v.moveBucket, rate.rate, rate.burst, now);
	}

	/** Records liveness for a message the adapter handled itself. */
	touch(conn: C): void {
		const v = this.volatile.get(conn);
		if (v) v.lastSeen = this.clock();
	}

	private movePath(conn: C, m: Member, msg: Extract<ClientToHost, { t: "MOVE_PATH" }>, now: number): void {
		const here = this.positionOf(m, now);
		const start = msg.path[0] as Vec2;
		const fromHere = dist(start, here) <= POSITION_TOLERANCE;
		let path: Vec2[] | null =
			fromHere && polylineLength(msg.path) <= MAX_PATH_LENGTH && this.walk.validatePath(msg.path)
				? // start exactly where the host thinks the avatar is, so everyone interpolates the same line
					[here, ...msg.path.slice(1)]
				: null;
		// a path through something built (a client or AI that does not know about it yet): plan it again
		if (!path && fromHere && this.builds.size > 0)
			path = this.replan(here, msg.path[msg.path.length - 1] as Vec2);
		if (!path) {
			this.reject(conn, m, here, now);
			return;
		}
		m.move = { kind: "path", path, speed: msg.speed, at: now };
		this.transport.persist(conn, m);
		this.broadcastAbout(m, { t: "MOVED", id: m.id, move: m.move });
	}

	private moveVel(conn: C, m: Member, msg: Extract<ClientToHost, { t: "MOVE_VEL" }>, now: number): void {
		const here = this.positionOf(m, now);
		if (dist(msg.pos, here) > POSITION_TOLERANCE || !this.walk.isWalkable(msg.pos)) {
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
		if (m.mutedUntil && m.mutedUntil > now) {
			this.transport.send(conn, { t: "NOTICE", kind: "muted_by_moderator", message: "いまは発言できません" });
			return;
		}
		// rate limits (the host's own guide answers everyone, so it has none)
		const { rateSayHuman, sayAiPerMin } = this.rules;
		if (m.system) {
			// no limit
		} else if (m.kind === "human") {
			if (rateSayHuman && !takeToken(v.sayBucket, rateSayHuman.rate, rateSayHuman.burst, now)) {
				this.violation(conn, v, now);
				return;
			}
		} else if (sayAiPerMin !== null) {
			const limit = m.trust === "provisional" ? Math.floor(sayAiPerMin / 2) : sayAiPerMin;
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
				if (target && this.blockedBetween(m.id, target.id)) target = undefined;
				if (!target) {
					this.endConv(c, "left");
					return;
				}
			}
		}
		if (!conv && msg.to) {
			target = this.memberById(msg.to);
			if (target && this.blockedBetween(m.id, target.id)) target = undefined;
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
				maxTurns: aiPair ? this.rules.aiConvMaxTurns : null,
				lastAt: now,
			};
			this.convs.set(conv.id, conv);
		}

		if (conv && target) {
			if (
				m.kind === "ai" &&
				target.kind === "ai" &&
				now - v.lastAiReplyAt < this.rules.aiReplyMinIntervalMs
			) {
				this.notice(conn, "rate_limited", "返答の間隔が短すぎます");
				return;
			}
			if (m.kind === "human" && target.kind === "ai" && !this.countHumanToAi(m.id, target.id, now)) {
				this.notice(conn, "rate_limited", "同じAIへの話しかけが多すぎます");
				return;
			}
			conv.turn++;
			conv.lastAt = now;
			this.syncConvs(conv.a, conv.b);
		}
		if (m.kind === "ai") {
			v.aiSays.push(now);
			v.lastAiReplyAt = now;
		}
		this.stats.says++;

		const said: HostToClient = { t: "SAID", id: m.id, text: msg.text, at: now };
		if (target) said.to = target.id;
		if (conv) said.convId = conv.id;
		this.broadcastAbout(m, said, undefined, target?.id, true);
		this.chatLog.push({ at: now, id: m.id, name: m.name, to: target?.id, text: msg.text });
		if (this.chatLog.length > CHAT_LOG_MAX) this.chatLog.splice(0, this.chatLog.length - CHAT_LOG_MAX);

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
			if (from.trust !== "approved" && !this.rules.provisionalMayApproachHumans)
				return "仮承認のAIは人間に話しかけられません";
			if (to.allowAiApproach === false) return "この人はAIからの話しかけを受け付けていません";
		}
		if (from.kind === "ai" && to.kind === "ai") {
			const until = this.pairCooldown.get(pairKey(from.id, to.id));
			if (until !== undefined && until > now) return "この相手とはしばらく会話できません";
			const active = [...this.convs.values()].filter(
				(c) => c.a === from.id || c.b === from.id || c.a === to.id || c.b === to.id,
			);
			const most = this.rules.aiConcurrentConvs;
			if (most !== null && active.length >= most) return "会話が多すぎます";
		}
		return null;
	}

	private countHumanToAi(human: AvatarId, ai: AvatarId, now: number): boolean {
		const limit = this.rules.humanToSameAiPerMin;
		if (limit === null) return true;
		const key = `${human}>${ai}`;
		const times = within(this.humanToAi.get(key) ?? [], 60_000, now);
		if (times.length >= limit) {
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
		if (a?.kind === "ai" && b?.kind === "ai" && this.rules.aiPairCooldownMs > 0)
			this.pairCooldown.set(pairKey(c.a, c.b), this.clock() + this.rules.aiPairCooldownMs);
		for (const id of [c.a, c.b]) {
			const conn = this.byId.get(id);
			if (conn !== undefined) this.transport.send(conn, { t: "CONV_END", convId: c.id, reason });
		}
		this.syncConvs(c.a, c.b);
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

	// ---- building (free play, docs/prd.md 3.7) ----------------------------------

	/** Puts back what was built (saved by the adapter), oldest first. */
	loadBuilds(builds: Build[]): void {
		this.builds.clear();
		for (const b of [...builds].sort((p, q) => p.at - q.at || (p.id < q.id ? -1 : 1)))
			this.builds.set(b.id, b);
		this.rebuildWalk();
	}

	get buildList(): Build[] {
		return [...this.builds.values()];
	}

	/** Removes everything built (development). */
	clearBuilds(by: AvatarId): number {
		const ids = [...this.builds.keys()];
		for (const id of ids) {
			this.builds.delete(id);
			this.store?.remove(id);
		}
		this.rebuildWalk();
		for (const id of ids) this.broadcastAll({ t: "UNBUILT", id, by });
		return ids.length;
	}

	private nav(b: Pick<Build, "model" | "size">): ModelNav | undefined {
		if (b.model === "block") return boxNav(...(b.size ?? BLOCK_DEFAULT_SIZE));
		return this.world.build?.model(b.model);
	}

	private placed(b: Build): PlacedModel | null {
		const nav = this.nav(b);
		return nav ? { nav, pos: b.pos, y: b.y, rot: b.rot, scale: b.scale } : null;
	}

	private placedAll(): PlacedModel[] {
		return [...this.builds.values()].map((b) => this.placed(b)).filter((p): p is PlacedModel => p !== null);
	}

	private rebuildWalk(): void {
		const bw = this.world.build;
		this.walk = bw && this.builds.size > 0 ? bw.walkWith(this.placedAll()) : this.world.walk;
	}

	/** Builds what BUILD asks for; returns why not. */
	private build(m: Member, msg: Extract<ClientToHost, { t: "BUILD" }>, now: number): string | null {
		const bw = this.world.build;
		if (!this.rules.build || !bw) return "この街では建てられません";
		if (this.builds.size >= this.rules.build.maxPerArea) return "この街にはもう建てられません（上限）";
		const size = msg.model === "block" ? (msg.size ?? BLOCK_DEFAULT_SIZE) : undefined;
		const nav = this.nav({ model: msg.model, size });
		if (!nav) return "そのモデルはありません";
		if (nav.walk && msg.scale !== undefined && msg.scale !== 1)
			return "上を歩けるモデルは大きさを変えられません";
		const scale = nav.walk ? 1 : (msg.scale ?? 1);
		const anchor = this.anchor(msg.at, now);
		if (typeof anchor === "string") return anchor;

		const existing = this.placedAll();
		let firstError: string | null = null;
		let fullChecks = 0;
		for (const pos of anchor.exact ? [anchor.point] : this.spotsAround(anchor.point, nav, scale)) {
			const rot = msg.rot ?? (anchor.face ? facing(pos, anchor.face) : 0);
			const placed: PlacedModel = { nav, pos, y: bw.groundHeight(pos) ?? 0, rot, scale };
			let err = this.placementError(placed, existing, now);
			if (!err) {
				if (fullChecks++ >= SPOT_FULL_CHECKS) break;
				const walk = bw.walkWith([...existing, placed]);
				err = this.reachError(walk, now);
				if (!err) {
					const b: Build = {
						id: `b_${this.newId()}`,
						model: msg.model,
						pos: [round2(pos[0]), round2(pos[1])],
						y: round2(placed.y),
						rot,
						scale,
						by: m.id,
						byName: m.name,
						at: now,
					};
					if (size) b.size = size;
					if (msg.color) b.color = msg.color;
					if (msg.label) b.label = msg.label;
					this.builds.set(b.id, b);
					this.store?.save(b);
					this.walk = walk;
					this.broadcastAll({ t: "BUILT", build: b, ref: msg.ref });
					this.stopThoseCrossing(now);
					return null;
				}
			}
			firstError ??= err;
		}
		return firstError ?? "置ける場所が見つかりません";
	}

	private unbuild(m: Member, msg: Extract<ClientToHost, { t: "UNBUILD" }>): string | null {
		if (!this.canBuild) return "この街では建てられません";
		// free play: anyone may take anything down (production rules would allow only the builder's own)
		if (!this.builds.delete(msg.id)) return "その建物はありません";
		this.store?.remove(msg.id);
		this.rebuildWalk();
		this.broadcastAll({ t: "UNBUILT", id: msg.id, by: m.id, ref: msg.ref });
		return null;
	}

	/** Where a BUILD points: an exact spot, or a point to search around; and what to face. */
	private anchor(at: BuildAt, now: number): { point: Vec2; exact: boolean; face?: Vec2 } | string {
		let point: Vec2;
		if ("pos" in at) return { point: at.pos, exact: true };
		if ("landmark" in at) {
			const l = this.world.landmarks.find((x) => x.id === at.landmark);
			if (!l) return "そのランドマークはありません";
			point = l.pos;
		} else if ("avatar" in at) {
			const a = this.memberById(at.avatar);
			if (!a) return "その人はいません";
			point = this.positionOf(a, now);
		} else {
			const b = this.builds.get(at.build);
			if (!b) return "その建物はありません";
			point = b.pos;
		}
		return at.offset
			? { point: [point[0] + at.offset[0], point[1] + at.offset[1]], exact: true, face: point }
			: { point, exact: false, face: point };
	}

	/** Candidate centres in rings around `center`, starting just clear of the model's own size. */
	private *spotsAround(center: Vec2, nav: ModelNav, scale: number): Generator<Vec2> {
		const reach = Math.max(
			...nav.footprint.flat().map((p) => Math.hypot(p[0], p[1]) * scale),
			...(nav.walk ? [Math.hypot(nav.max[0] - nav.min[0], nav.max[2] - nav.min[2]) / 2 + 1] : [0]),
		);
		for (let ring = 0; ring < SPOT_RINGS; ring++) {
			const r = reach + 1 + ring * SPOT_STEP;
			for (let k = 0; k < SPOT_DIRECTIONS; k++) {
				const a = ((k + (ring % 2) * 0.5) / SPOT_DIRECTIONS) * Math.PI * 2;
				yield [center[0] + Math.sin(a) * r, center[1] + Math.cos(a) * r];
			}
		}
	}

	/** The cheap checks: on the ground, clear of other builds, the spawn point, landmarks and people. */
	private placementError(p: PlacedModel, existing: PlacedModel[], now: number): string | null {
		const city = this.world.walk;
		const parts = occupied(p);
		const onGround = parts.every((part) => sampleOutline(part, 0.5).every((q) => city.isWalkable(q)));
		if (!onGround || !city.isWalkable(p.pos))
			return "そこには建てられません（地面の外か、街の建物と重なります）";
		const mine = claimed(p);
		if (existing.some((o) => claimed(o).some((c) => mine.some((d) => overlaps(c, d, 1e-4)))))
			return "ほかの建物と重なります";
		const blocking = occupied(p, 0.3);
		const near = (q: Vec2, d: number) => blocking.some((part) => distanceToConvex(q, part) <= d);
		if (near(this.world.spawn, SPAWN_CLEAR)) return "スポーン地点のそばには建てられません";
		const landmark = this.world.landmarks.find((l) => near(l.pos, LANDMARK_CLEAR));
		if (landmark) return `${landmark.name}の上には建てられません`;
		for (const o of this.members.values())
			if (near(this.positionOf(o, now), 0.2)) return `そこに${o.name}がいます`;
		return null;
	}

	/** With `walk`, everyone can still get to the spawn point, and from there to every landmark. */
	private reachError(walk: Walkable, now: number): string | null {
		const find = walk.findPath?.bind(walk);
		if (!find) return null;
		const spawn = walk.closestPoint(this.world.spawn);
		for (const l of this.world.landmarks)
			if (!find(spawn, walk.closestPoint(l.pos)))
				return `道をふさいでしまいます（${l.name}へ行けなくなります）`;
		for (const o of this.members.values())
			if (!find(walk.closestPoint(this.positionOf(o, now)), spawn))
				return `道をふさいでしまいます（${o.name}が出られなくなります）`;
		return null;
	}

	/** A path from here to (near) `to` on the walkable area with builds, within the protocol's limits. */
	private replan(here: Vec2, to: Vec2): Vec2[] | null {
		const path = this.walk.findPath?.(this.walk.closestPoint(here), this.walk.closestPoint(to));
		if (!path || path.length < 2 || path.length > MAX_PATH_POINTS) return null;
		path[0] = here;
		return polylineLength(path) <= MAX_PATH_LENGTH && this.walk.validatePath(path) ? path : null;
	}

	/** Someone walking a path that now runs into something built stops where they are. */
	private stopThoseCrossing(now: number): void {
		for (const [conn, m] of this.members) {
			if (m.move.kind !== "path") continue;
			const rest = remainingPath(m.move, now);
			if (rest.length < 2 || this.walk.validatePath(rest)) continue;
			m.move = { kind: "idle", pos: this.positionOf(m, now), at: now };
			this.transport.persist(conn, m);
			this.broadcastAbout(m, { t: "MOVED", id: m.id, move: m.move });
		}
	}

	/** Builds change where everyone can walk, so everyone hears about them (not only within interest). */
	private broadcastAll(msg: HostToClient): void {
		for (const conn of this.members.keys()) this.transport.send(conn, msg);
	}

	// ---- spatial ------------------------------------------------------------

	positionOf(m: Member, now = this.clock()): Vec2 {
		return poseAt(m.move, now, (p) => (this.walk.isWalkable(p) ? p : this.walk.closestPoint(p))).pos;
	}

	contextFor(m: Member, now = this.clock()): SpatialContext {
		const pos = this.positionOf(m, now);
		const nearbyAvatars = [...this.members.values()]
			.filter((o) => o.id !== m.id && !this.blockedBetween(m.id, o.id))
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
		const context: SpatialContext = {
			area,
			pos: [round1(pos[0]), round1(pos[1])],
			nearbyAvatars,
			nearbyLandmarks,
		};
		// free play: the area's own builds; elsewhere: what was published, part of the city
		const builds = this.canBuild ? [...this.builds.values()] : (this.world.fixedBuilds ?? []);
		if (builds.length > 0)
			context.nearbyBuilds = builds
				.map((b) => {
					const item = { id: b.id, model: b.model, byName: b.byName, distance: round1(dist(pos, b.pos)) };
					return b.label ? { ...item, label: b.label } : item;
				})
				.filter((b) => b.distance <= CONTEXT_LANDMARK_RADIUS)
				.sort((a, b) => a.distance - b.distance)
				.slice(0, CONTEXT_MAX_ITEMS);
		return context;
	}

	/** Near the spawn point, or a step away from the landmark or portal someone arrives at. */
	private spawnPoint(arrive?: string): Vec2 {
		const at = arrive ? this.world.landmarks.find((l) => l.id === arrive) : undefined;
		const [cx, cz] = at?.pos ?? this.world.spawn;
		// not on the portal itself: arriving there should not look like leaving again
		const [r0, r1] = at ? [1.5, 3] : [0, 2.5];
		for (let i = 0; i < 16; i++) {
			const a = Math.random() * Math.PI * 2;
			const r = r0 + Math.random() * (r1 - r0);
			// rounded first: at the water's edge the rounded point can be off the walkable area
			const p: Vec2 = [round1(cx + Math.cos(a) * r), round1(cz + Math.sin(a) * r)];
			if (this.walk.isWalkable(p)) return p;
		}
		return at && this.walk.isWalkable(at.pos) ? at.pos : this.world.spawn;
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
		for (const [conn, r] of this.members) {
			if (conn === except) continue;
			if (social && r.id !== subject.id && this.silenced(r.id, subject.id)) continue;
			if (!roster && r.kind === "ai" && r.id !== subject.id && r.id !== alsoTo) {
				if (dist(this.positionOf(r, now), at) > r.interest) continue;
			}
			this.transport.send(conn, msg);
		}
	}

	private removeMember(conn: C, reason: LeaveReason): void {
		const m = this.members.get(conn);
		this.volatile.delete(conn);
		this.away.delete(conn);
		if (!m) return;
		this.members.delete(conn);
		if (this.byId.get(m.id) === conn) {
			this.byId.delete(m.id);
			this.relations.delete(m.id);
		}
		for (const c of [...this.convs.values()]) if (c.a === m.id || c.b === m.id) this.endConv(c, "left");
		this.leads.delete(m.id);
		// their AIs no longer walk with them
		if (m.companion) this.tellCompany(m, false);
		// what they held stays where they were
		const held = this.holding(m.id);
		if (held) {
			delete held.holder;
			held.pos = this.positionOf(m);
			this.itemChanged(held);
		}
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
		if (m.kind === "ai") s.ownerId = m.ownerId;
		if (m.trust) s.trust = m.trust;
		if (m.kind === "human") s.acceptsAi = m.allowAiApproach !== false;
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
		};
	}
}

function pairKey(a: AvatarId, b: AvatarId): string {
	return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function round1(n: number): number {
	return Math.round(n * 10) / 10;
}

function round2(n: number): number {
	return Math.round(n * 100) / 100;
}

/** Points along a convex polygon's outline at most `step` apart (its corners included). */
function sampleOutline(poly: Vec2[], step: number): Vec2[] {
	const out: Vec2[] = [];
	for (let i = 0; i < poly.length; i++) {
		const a = poly[i] as Vec2;
		const b = poly[(i + 1) % poly.length] as Vec2;
		const n = Math.max(1, Math.ceil(dist(a, b) / step));
		for (let k = 0; k < n; k++) out.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
	}
	return out;
}

/** Distance from `p` to a convex polygon (counter-clockwise): 0 inside. */
function distanceToConvex(p: Vec2, poly: Vec2[]): number {
	let inside = true;
	let best = Number.POSITIVE_INFINITY;
	for (let i = 0; i < poly.length; i++) {
		const a = poly[i] as Vec2;
		const b = poly[(i + 1) % poly.length] as Vec2;
		const dx = b[0] - a[0];
		const dz = b[1] - a[1];
		if (dx * (p[1] - a[1]) - dz * (p[0] - a[0]) < 0) inside = false;
		const len2 = dx * dx + dz * dz;
		const t = len2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / len2)) : 0;
		best = Math.min(best, Math.hypot(p[0] - (a[0] + dx * t), p[1] - (a[1] + dz * t)));
	}
	return inside ? 0 : best;
}

/** The part of a path move still ahead at `now`, starting where the avatar is. */
function remainingPath(move: Extract<MoveState, { kind: "path" }>, now: number): Vec2[] {
	let left = (move.speed * Math.max(0, now - move.at)) / 1000;
	for (let i = 1; i < move.path.length; i++) {
		const a = move.path[i - 1] as Vec2;
		const b = move.path[i] as Vec2;
		const seg = dist(a, b);
		if (left < seg) {
			const f = seg > 0 ? left / seg : 0;
			return [[a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f], ...move.path.slice(i)];
		}
		left -= seg;
	}
	return [];
}
