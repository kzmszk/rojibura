// Area logic of CityRoomDO, independent of the Workers runtime so it can be tested in Node
// (docs/prd.md 3.2, 3.3). The Durable Object adapter (room.ts) owns sockets, hibernation and auth.

import {
	boxNav,
	claimed,
	type KeepOut,
	keepingOut,
	type ModelNav,
	occupied,
	overlaps,
	type PlacedModel,
} from "@rojibura/nav";
import {
	ACTIVITY_REACH,
	type Activity,
	type AreaId,
	type AvatarAssets,
	type AvatarId,
	type AvatarKind,
	type AvatarState,
	activityOpen,
	BODY_CALL_REACH,
	BODY_CALLED_TO,
	BODY_INTERVAL_MS,
	BODY_LOOK_REACH,
	BODY_REACH,
	type Build,
	type BuildAt,
	type BuildId,
	bodyNeedsPartner,
	bodyTouches,
	bodyUntouchable,
	type ClientToHost,
	COMPANION_FREE,
	COMPANION_FREE_STEP,
	COMPANY_MOOD_MS,
	CONTEXT_AVATAR_RADIUS,
	CONTEXT_LANDMARK_RADIUS,
	CONTEXT_MAX_ITEMS,
	CONV_TIMEOUT_MS,
	cannotJob,
	cannotStart,
	canRun,
	cityMinutesOf,
	cityTime,
	type DayReview,
	DIARY_ASK_MS,
	DIARY_TTL_MS,
	type Doing,
	decay,
	dist,
	EARN_MS,
	eatFood,
	FLY_REACH,
	FLY_RUN_SPEED,
	type Food,
	facing,
	finishActivity,
	finishJob,
	type HostToClient,
	hoursText,
	INTEREST_RADIUS_DEFAULT,
	ITEM_REACH,
	type Item,
	type ItemId,
	type ItemKind,
	insidePolygon,
	isPosture,
	type JobInfo,
	type JobKind,
	type JobZone,
	LEAD_INTERVAL_MS,
	LEAD_MIN_DISTANCE,
	LEAD_REACH,
	type LeaveReason,
	type LifeState,
	MAX_GOODS,
	MAX_PATH_LENGTH,
	MAX_PATH_POINTS,
	MAX_SPEED,
	type ModelId,
	type MoveState,
	newDay,
	newLife,
	OFFER_REACH,
	OFFER_TTL_MS,
	POSITION_TOLERANCE,
	PRESENCE_TIMEOUT_MS,
	polylineLength,
	poseAt,
	RATE_VIOLATIONS_BEFORE_CLOSE,
	realMs,
	SEAT_REACH,
	type Seat,
	type Sex,
	SHOP_REACH,
	type Shop,
	type SpatialContext,
	STEP_BACK,
	STEP_BACK_S,
	type Status,
	THROW_MS,
	THROW_RANGE,
	THROW_RELEASE_MS,
	TOGETHER_GAP,
	TOGETHER_MS,
	type Together,
	type Vec2,
	WALK_SPEED,
	WARP_INTERVAL_MS,
	withCompany,
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
 * Where your AIs walk with you (docs/prd.md 3.4.9): this far ahead and this far to one side (m), side by side
 * (in front it stood in your way).
 */
const COMPANION_WALKING: Vec2 = [0.3, 0.9];
/** Where they stand when you stop: at your side, a little forward; a second one on the other side. */
const COMPANION_STANDING: Vec2 = [0.15, 0.8];
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

/** Keeps the wallets (D1): each change as it happens, added to what is saved (docs/prd.md 3.8.6). */
export interface WalletStore {
	add(id: AvatarId, delta: number): void;
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
	/** People may float in the air here (docs/prd.md 3.4.13). */
	fly?: boolean;
	/** Where building is possible (free play). */
	build?: BuildWorld;
	/** Published builds that are part of the city (already in `walk`); only for spatial context. */
	fixedBuilds?: Build[];
	/** Small things that are there when the area starts with none saved (docs/prd.md 3.4.7). */
	items?: { kind: ItemKind; pos: Vec2 }[];
	/** Shops to buy things at (docs/prd.md 3.8.6). */
	shops?: Shop[];
	/** Where one can work or study to earn coins. */
	jobZones?: JobZone[];
	/** Rooms each sex keeps out of (the onsen's changing rooms: men not in the women's, nor women in the men's). */
	keepOut?: Partial<Record<Sex, KeepOut[]>>;
	/** What can be done where (assets/<area>/activities.json, docs/life.md 3). */
	activities?: Activity[];
	/** Places to sit (benches, sofas, chairs: assets/<area>/seats.json, docs/prd.md 3.4.5). */
	seats?: Seat[];
	/** What eating the shops' goods does, and what working or studying at each job zone is like. */
	foods?: Record<string, Food>;
	jobs?: Record<string, JobInfo>;
}

/** Saves an AI's life (D1 agent_life) when it changes: an activity ends, a morning, leaving. */
export interface LifeStore {
	save(id: AvatarId, life: LifeState): void;
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
	/** AIs: their life as last saved (D1 agent_life); a new one on their first day (docs/life.md 2). */
	life?: LifeState;
	/** Coins in the wallet when they came in (D1). Only the host's guide has none (it buys for nothing). */
	coins?: number;
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
	/** Humans floating in the air (docs/prd.md 3.4.13): at this height (world Y); they move over everything. */
	fly?: number;
	/** Host time of their last WARP (docs/prd.md 3.4.14). */
	warpedAt?: number;
	/** Which way the avatar last walked (the host knows no facing): companions keep to its front. */
	heading?: Vec2;
	/** AIs: taking the owner to a place (docs/prd.md 3.4.10); walking with them again after `until` at last. */
	lead?: { to: Vec2; place: string; until: number };
	/** AIs: when it last asked its owner to come along (one ask per LEAD_INTERVAL_MS). */
	leadAskedAt?: number;
	/** AIs walking with their owner: host time its mood was last raised for it (docs/life.md 2). */
	companyAt?: number;
	/** AIs: walking to a seat next to the one their owner sat on, to sit on it at host time `at` (docs/prd.md 3.4.5). */
	seatPlan?: { seat: number; at: number };
	/** What it is doing now (docs/life.md 3). */
	doing?: Doing;
	/**
	 * Doing something together with `with` (docs/prd.md 3.4.6) until host time `until` (and a little after,
	 * while they step back): the host moves neither of them meanwhile, and an AI does not move itself.
	 */
	together?: { with: AvatarId; kind: Together; until: number };
	/** Working or studying in a zone since host time `since`; `paid` coins of it are in the wallet already. */
	/** `settled`: host time its life was brought up to; `used`: the energy it has used so far. */
	job?: { kind: JobKind; zone: string; since: number; paid: number; settled?: number; used?: number };
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

/** An AI walking with its owner sits down on a seat within this far of the owner's (m). */
const SEAT_COMPANY_NEAR = 3;
/** It stands this far in front of the seat to sit on it (as a person does, apps/city-client). */
const SEAT_FRONT = 0.5;

/** After something done together, the two may still step back this long (ms): the host leaves them be. */
const STEP_BACK_GRACE_MS = 3000;

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
	/** When the member last moved its body by a script (docs/prd.md 3.4.11). */
	lastBodyAt: number;
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
	/** The walkable area for each sex (without the rooms it keeps out of), made from `walk` when first needed. */
	private walkBySex = new WeakMap<Walkable, Map<Sex, Walkable>>();
	/** Offers to do something together, by "from to" (docs/prd.md 3.4.6); they lapse after OFFER_TTL_MS. */
	private readonly offers = new Map<string, { kind: Together; at: number }>();
	/** An AI's open ask to its owner to come along, by the AI (docs/prd.md 3.4.10); lapses after OFFER_TTL_MS. */
	private readonly leads = new Map<AvatarId, { owner: AvatarId; to: Vec2; place: string; at: number }>();
	/**
	 * An owner's open ask to read their AI's diary, by the AI (docs/life.md 8): `next` the part it sends next,
	 * `parts` how many it said there are. The diary only passes through; it lapses after DIARY_TTL_MS.
	 */
	private readonly diaryAsks = new Map<
		AvatarId,
		{ owner: AvatarId; at: number; next: number; parts?: number }
	>();
	/** Small things in the area (docs/prd.md 3.4.7). */
	private readonly items = new Map<ItemId, Item>();
	private readonly itemStore: ItemStore | undefined;
	private readonly lifeStore: LifeStore | undefined;
	private readonly wallets: WalletStore | undefined;
	/** Members whose connection dropped, by that dead connection: until when they wait, and what they missed. */
	private readonly away = new Map<C, { until: number; missed: HostToClient[] }>();

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
		this.lifeStore = options.life;
		this.wallets = options.wallets;
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
		const entered = member.kind === "ai" ? this.lifeOnEntry(info.life, now) : null;
		if (entered) member.life = entered.life;
		else delete member.life;
		this.members.set(conn, member);
		this.byId.set(member.id, conn);
		this.volatile.set(conn, this.freshVolatile());
		this.stats.connects++;
		this.transport.persist(conn, member);
		this.welcome(conn, member, now);
		if (entered?.review) {
			this.lifeStore?.save(member.id, entered.life);
			this.transport.send(conn, { t: "DAY", review: entered.review, life: entered.life });
		}
		// the owner's page shows how their AI is doing (docs/life.md 8), whichever of them came first
		if (member.kind === "ai") this.sendLife(member, false);
		else for (const ai of this.members.values()) if (ai.ownerId === member.id) this.sendLife(ai, false);
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
		// the life and wallet kept here are newer than what was read from D1 for the new connection
		const member: Member = {
			...was,
			...info,
			...(was.life ? { life: was.life } : {}),
			...(was.coins !== undefined ? { coins: was.coins } : {}),
		};
		this.members.set(conn, member);
		this.byId.set(member.id, conn);
		this.volatile.set(conn, v);
		this.transport.persist(conn, member);
		this.welcome(conn, member, now, true);
		if (member.coins !== undefined) this.transport.send(conn, { t: "WALLET", coins: member.coins });
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
		this.payJobs(now);
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
		this.settleSeatPlans(now);
		this.lifeTick(now);
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
			case "MOVE_VEL": {
				if (!this.moveToken(v, now)) {
					this.violation(conn, v, now);
					return;
				}
				// walking with its owner the host moves it; with the owner standing still, it may step about close by;
				// hugging (or shaking hands), an AI stays where it is
				if (
					(this.accompanying(m) && !this.freeStep(m, msg, now)) ||
					(m.kind !== "human" && this.togetherNow(m, now))
				) {
					this.transport.send(conn, { t: "CORRECT", move: m.move });
					return;
				}
				// a person walking off in the middle of a hug ends it for both (stepping back after it does not)
				// (a stop where one is, as a page says on arriving, is not walking off)
				const off = msg.t === "MOVE_PATH" || msg.speed > 0;
				if (m.kind === "human" && off && m.together && now < m.together.until) this.endTogether(m);
				msg.t === "MOVE_PATH" ? this.movePath(conn, m, msg, now) : this.moveVel(conn, m, msg, now);
				if (m.companion) this.accompany(m, now);
				// walking out of where one works or studies ends it
				if (m.job && !this.inJobZone(m, m.job.zone, now)) this.stopJob(m, now);
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
				if (!err && m.companion) this.accompany(m, now);
				if (m.job && !this.inJobZone(m, m.job.zone, now)) this.stopJob(m, now);
				return;
			}
			case "JOB": {
				const err = msg.kind ? this.startJob(m, msg.kind, now) : this.stopJob(m, now);
				if (err) this.notice(conn, "rejected", err);
				return;
			}
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
					// on a seat close by, if one is asked for (an AI sitting next to a free one takes it)
					const seat = msg.motion === "sit" ? this.seatFor(m, msg.seat, now) : undefined;
					if (msg.seat !== undefined && seat === undefined) {
						this.notice(conn, "rejected", "そこには座れません（遠いか、ほかの人が座っています）");
						return;
					}
					// sitting down keeps the way it turned to (on a seat, the seat's way)
					const face =
						seat !== undefined
							? this.world.seats?.[seat]?.face
							: m.move.kind === "idle"
								? m.move.face
								: undefined;
					m.move = {
						kind: "idle",
						pos: this.positionOf(m, now),
						at: now,
						posture: msg.motion,
						...(face ? { face } : {}),
						...(seat !== undefined ? { seat } : {}),
					};
					this.transport.persist(conn, m);
					this.broadcastAbout(m, { t: "MOVED", id: m.id, move: m.move });
					if (seat !== undefined && m.kind === "human" && m.companion) this.seatCompany(m, seat, now);
				}
				this.broadcastAbout(
					m,
					{ t: "ACTED", id: m.id, motion: msg.motion, target: msg.target, at: now },
					undefined,
					undefined,
					true,
				);
				// stepping back after a hug: an AI (or the guide) hugged steps back with them
				if (msg.motion === "stepback") this.stepBackWith(m, now);
				return;
			case "BODY": {
				if (!this.moveToken(v, now)) {
					this.violation(conn, v, now);
					return;
				}
				const err = this.body(m, v, msg, now);
				if (err) this.notice(conn, "rejected", err);
				return;
			}
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
			case "DROP":
			case "BUY":
			case "USE": {
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
								: msg.t === "BUY"
									? this.buy(m, msg.shop, msg.goods, now)
									: msg.t === "USE"
										? this.use(m, now)
										: this.drop(m, now);
				if (err) this.notice(conn, "rejected", err);
				return;
			}
			case "ANSWER":
				if (!this.answerLead(m, msg.to, msg.accept, now)) this.answer(m, msg.to, msg.accept, now);
				return;
			case "ACT": {
				if (!this.moveToken(v, now)) {
					this.violation(conn, v, now);
					return;
				}
				const err = this.startDoing(conn, m, msg.activity, now);
				if (err) this.notice(conn, "rejected", err);
				return;
			}
			case "ACT_STOP":
				this.stopDoing(conn, m, now);
				return;
			case "DIARY_ASK": {
				const err = this.askDiary(m, msg, now);
				if (err) this.notice(conn, "rejected", err);
				return;
			}
			case "DIARY":
				this.passDiary(m, msg, now);
				return;
			case "AUTH":
				return; // handled by the adapter before join
		}
	}

	// ---- the owner reading their AI's diary (docs/life.md 8) -------------------

	/** The owner asks their AI here for its diary; it is read where the AI runs, and comes back as DIARY. */
	private askDiary(m: Member, msg: Extract<ClientToHost, { t: "DIARY_ASK" }>, now: number): string | null {
		const ai = this.memberById(msg.id);
		const ac = this.byId.get(msg.id);
		if (!ai || ac === undefined) return "AIがこのエリアにいないので、日記を読めません";
		if (m.kind !== "human" || ai.kind !== "ai" || ai.ownerId !== m.id) return "自分のAIの日記だけ読めます";
		const asked = this.diaryAsks.get(ai.id);
		if (asked && now - asked.at < DIARY_ASK_MS) return null;
		this.diaryAsks.set(ai.id, { owner: m.id, at: now, next: 0 });
		this.transport.send(ac, { t: "DIARY_ASK", from: m.id, ...(msg.day ? { day: msg.day } : {}) });
		return null;
	}

	/** A part of an AI's answer goes on to the owner who asked, in order, and nothing else does. */
	private passDiary(m: Member, msg: Extract<ClientToHost, { t: "DIARY" }>, now: number): void {
		const ask = this.diaryAsks.get(m.id);
		if (!ask || ask.owner !== msg.to || msg.part !== ask.next || now - ask.at > DIARY_TTL_MS) return;
		if (ask.parts !== undefined && msg.parts !== ask.parts) return;
		ask.parts = msg.parts;
		ask.next++;
		if (ask.next >= msg.parts) this.diaryAsks.delete(m.id);
		const oc = this.byId.get(msg.to);
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
		const here = this.positionOf(m, now);
		const taken = new Set<number>();
		for (const o of this.members.values())
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
		for (const o of this.members.values()) {
			if (o.move.kind === "idle" && o.move.seat !== undefined) taken.add(o.move.seat);
			if (o.seatPlan) taken.add(o.seatPlan.seat);
		}
		for (const [conn, ai] of this.members) {
			if (ai.kind !== "ai" || ai.ownerId !== owner.id || this.togetherNow(ai, now)) continue;
			const from = this.positionOf(ai, now);
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
			const path = dist(from, front) < 0.2 ? null : this.leadPath(from, front, this.walkOf(ai));
			if (!path && dist(from, front) >= 0.2) continue;
			taken.add(pick.i);
			this.stopDoing(conn, ai, now);
			if (path) {
				ai.move = { kind: "path", path, speed: WALK_SPEED, at: now };
				this.broadcastAbout(ai, { t: "MOVED", id: ai.id, move: ai.move });
			}
			const ms = path ? (polylineLength(path) / WALK_SPEED) * 1000 : 0;
			ai.seatPlan = { seat: pick.i, at: now + ms + 150 };
			this.transport.persist(conn, ai);
		}
	}

	/** The host time the next AI is due to sit down (for the alarm), if any. */
	get wakeAt(): number | undefined {
		let t: number | undefined;
		for (const m of this.members.values())
			if (m.seatPlan && (t === undefined || m.seatPlan.at < t)) t = m.seatPlan.at;
		return t;
	}

	/** AIs that have walked up to their seat sit down on it. */
	private settleSeatPlans(now: number): void {
		for (const [conn, ai] of this.members) {
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
			ai.move = {
				kind: "idle",
				pos: this.positionOf(ai, now),
				at: now,
				posture: "sit",
				...(this.world.seats?.[seat]?.face ? { face: this.world.seats[seat]?.face as Vec2 } : {}),
				seat,
			};
			this.transport.persist(conn, ai);
			this.broadcastAbout(ai, { t: "MOVED", id: ai.id, move: ai.move });
			this.broadcastAbout(ai, { t: "ACTED", id: ai.id, motion: "sit", target: undefined, at: now });
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
		const fits = d <= OFFER_REACH + 1 && this.walkOf(from).isWalkable(pa) && this.walkOf(m).isWalkable(pb);
		this.transport.send(fc, { t: "ANSWERED", by: m.id, kind: offer.kind, accept: accept && fits });
		if (!accept || !fits) return;
		const ms = Math.max(this.stepTo(fc, from, a, pa, now), this.stepTo(mc, m, b, pb, now));
		const at = now + ms + 200;
		const until = at + TOGETHER_MS[offer.kind];
		from.together = { with: m.id, kind: offer.kind, until };
		m.together = { with: from.id, kind: offer.kind, until };
		this.transport.persist(fc, from);
		this.transport.persist(mc, m);
		this.broadcastAbout(
			from,
			{ t: "TOGETHER", kind: offer.kind, a: from.id, b: m.id, at },
			undefined,
			m.id,
			true,
		);
	}

	private endTogether(m: Member): void {
		const other = m.together ? this.memberById(m.together.with) : undefined;
		if (other?.together?.with === m.id) delete other.together;
		delete m.together;
	}

	/** Whether `m` is (still) doing something together: until it is over, and a little after (stepping back). */
	private togetherNow(m: Member, now: number): boolean {
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
		const other = this.memberById(t.with);
		if (!other || other.kind === "human" || other.together?.with !== m.id) return;
		delete other.together;
		const oc = this.byId.get(other.id);
		const here = this.positionOf(other, now);
		if (oc === undefined || poseAt(other.move, now).moving) return;
		const from = this.positionOf(m, now);
		const d = dist(here, from);
		if (d < 1e-3) return;
		const to: Vec2 = [
			here[0] + ((here[0] - from[0]) / d) * STEP_BACK,
			here[1] + ((here[1] - from[1]) / d) * STEP_BACK,
		];
		if (!this.walkOf(other).validatePath([here, to])) return;
		other.move = { kind: "path", path: [here, to], speed: STEP_BACK / STEP_BACK_S, at: now };
		this.transport.persist(oc, other);
		this.broadcastAbout(other, { t: "MOVED", id: other.id, move: other.move });
		this.broadcastAbout(
			other,
			{ t: "ACTED", id: other.id, motion: "stepback", at: now },
			undefined,
			undefined,
			true,
		);
	}

	/** Walks a member a short way to `to` (or puts them there); returns how long it takes (ms). */
	private stepTo(conn: C, m: Member, here: Vec2, to: Vec2, now: number): number {
		this.stopDoing(conn, m, now);
		const d = dist(here, to);
		const walk = d > 0.05 && this.walkOf(m).validatePath([here, to]);
		m.move = walk
			? { kind: "path", path: [here, to], speed: WALK_SPEED, at: now }
			: { kind: "idle", pos: to, at: now };
		this.transport.persist(conn, m);
		this.broadcastAbout(m, { t: "MOVED", id: m.id, move: m.move });
		return walk ? (d / WALK_SPEED) * 1000 : 0;
	}

	/**
	 * Someone goes through a portal to area `to`, arriving at `at` (docs/prd.md 3.8.2): their AIs walking with
	 * them come along (FOLLOW). `who` may be what a closed connection last persisted (its close says where to).
	 */
	travel(who: Pick<Member, "id" | "kind" | "companion">, to: AreaId, at: string): void {
		if (who.kind !== "human" || !who.companion) return;
		for (const [ac, ai] of this.members)
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
	private body(
		m: Member,
		v: Volatile,
		msg: Extract<ClientToHost, { t: "BODY" }>,
		now: number,
	): string | null {
		if (now - v.lastBodyAt < BODY_INTERVAL_MS) return "少し間をあけてください";
		const to = msg.to ? this.memberById(msg.to) : undefined;
		if (msg.to && (!to || to.id === m.id)) return "その人はいません";
		if (!to && bodyNeedsPartner(msg.keys)) return "of: you を使うときは to に相手を入れてください";
		let at = now + 100;
		if (to) {
			if (this.blockedBetween(m.id, to.id)) return "その人には向けられません";
			const here = this.positionOf(m, now);
			const there = this.positionOf(to, now);
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
					const ac = this.byId.get(to.id);
					if (ac === undefined || !this.walkOf(to).isWalkable(spot)) return "そこには来られません";
					at = now + this.stepTo(ac, to, there, spot, now) + 200;
				} else if (d > BODY_REACH) return `もっと近くに行ってください（いま${Math.round(d * 10) / 10}m）`;
			} else if (d > BODY_LOOK_REACH) return "その人は遠すぎます";
		}
		v.lastBodyAt = now;
		this.broadcastAbout(
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
	private freeStep(
		m: Member,
		msg: Extract<ClientToHost, { t: "MOVE_PATH" | "MOVE_VEL" }>,
		now: number,
	): boolean {
		const owner = this.memberById(m.ownerId);
		// turning where it stands (not while the host walks it along) is always its own
		if (msg.t === "MOVE_VEL")
			return msg.speed === 0 && !poseAt(m.move, now).moving && dist(msg.pos, this.positionOf(m, now)) <= 0.3;
		if (!owner || poseAt(owner.move, now).moving) return false;
		if (m.lead && now < m.lead.until) return false;
		const end = msg.path[msg.path.length - 1] as Vec2;
		return (
			polylineLength(msg.path) <= COMPANION_FREE_STEP &&
			dist(end, this.positionOf(owner, now)) <= COMPANION_FREE
		);
	}

	// ---- walking with your AIs (docs/prd.md 3.4.9) ----------------------------

	/** True if `m` is an AI whose owner is here and walking with company. */
	private accompanying(m: Member): boolean {
		return m.kind === "ai" && !!this.memberById(m.ownerId)?.companion;
	}

	/**
	 * Moves the owner's AIs to keep beside them, one to each side: along the owner's path shifted sideways (or,
	 * walking with keys, to where the owner will be a few seconds on), at the speed that gets there when the
	 * owner does, and, when the owner stops, at their side.
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
	private bringCompany(owner: Member, now: number): void {
		if (!owner.companion) return;
		this.endLeads(owner);
		const at = this.positionOf(owner, now);
		let slot = 0;
		for (const [conn, ai] of this.members) {
			if (ai.kind !== "ai" || ai.ownerId !== owner.id) continue;
			const side = slot++ % 2 === 0 ? 1 : -1;
			this.stopDoing(conn, ai, now);
			const there = this.beside(
				at,
				owner.heading ?? [0, 1],
				side,
				COMPANION_STANDING,
				false,
				this.walkOf(ai),
			);
			this.land(conn, ai, there ?? at, now);
		}
	}

	/** Tells the owner's AIs here that they walk with the owner now, or no longer. */
	private tellCompany(owner: Member, on: boolean): void {
		const now = this.clock();
		for (const [conn, ai] of this.members)
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
	private leadPath(from: Vec2, to: Vec2, walk = this.walk): Vec2[] | null {
		const way = walk.findPath?.(walk.closestPoint(from), to) ?? [from, to];
		if (way.length < 2) return null;
		const path = [from, ...way.slice(1)].slice(0, MAX_PATH_POINTS);
		return polylineLength(path) <= MAX_PATH_LENGTH && walk.validatePath(path) ? path : null;
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
		const to = this.walkOf(m).closestPoint(msg.to);
		if (dist(here, to) < LEAD_MIN_DISTANCE) return "そこはすぐそばです";
		if (!this.leadPath(here, to, this.walkOf(m))) return "そこへは歩いて行けません";
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
		const path =
			accept && this.accompanying(ai)
				? this.leadPath(this.positionOf(ai, now), lead.to, this.walkOf(ai))
				: null;
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
		this.stopDoing(ac, ai, now);
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
	private beside(
		at: Vec2,
		ahead: Vec2,
		side: number,
		slot = COMPANION_WALKING,
		strict = false,
		walk = this.walk,
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
		const from = this.positionOf(ai, now);
		const om = owner.move;
		const walk = this.walkOf(ai);
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
				if (!this.walkOf(owner).validatePath([this.positionOf(owner, now), ahead])) continue;
				const there = this.beside(ahead, om.dir, side, COMPANION_WALKING, false, walk);
				if (there) {
					path = [from, there];
					ms = s * 1000;
					break;
				}
			}
		} else {
			// the owner has stopped: it comes to their side
			const there = this.beside(this.positionOf(owner, now), ahead, side, COMPANION_STANDING, false, walk);
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
		this.stopDoing(conn, ai, now);
		ai.move = {
			kind: "path",
			path,
			speed: this.speedFor(ai, Math.min(MAX_SPEED, Math.max(0.5, speed)), now),
			at: now,
		};
		this.transport.persist(conn, ai);
		this.broadcastAbout(ai, { t: "MOVED", id: ai.id, move: ai.move });
	}

	// ---- life: activities and the meters (docs/life.md) ----------------------

	private activity(id: string): Activity | undefined {
		return this.world.activities?.find((a) => a.id === id);
	}

	/**
	 * An AI's life as it comes in: where it left off (time away does not count), or a first day. On a new city
	 * day, the day it last lived is scored and it wakes up (`review`).
	 */
	private lifeOnEntry(saved: LifeState | undefined, now: number): { life: LifeState; review?: DayReview } {
		if (!saved) return { life: newLife(now) };
		const life: LifeState = { ...saved, at: now };
		return cityTime(now).block !== saved.block ? newDay(life, now) : { life };
	}

	/** Starts activity `id` where `m` stands: they stop walking, and sit if it is done sitting. */
	private startDoing(conn: C, m: Member, id: string, now: number): string | null {
		const a = this.activity(id);
		if (!a) return "ここではできないことです";
		const place = this.world.landmarks.find((l) => l.id === a.place);
		if (!place) return "ここではできないことです";
		if (dist(this.positionOf(m, now), place.pos) > ACTIVITY_REACH)
			return `${place.name}まで行ってからにしてください`;
		if (!activityOpen(a, cityTime(now).minutes))
			return `${a.name}は、いまの時間はできません（${hoursText(a)}）`;
		if (m.doing?.activity === a.id) return `もう${a.name}をしています`;
		const others = [...this.members.values()].filter((o) => o.id !== m.id && o.doing?.activity === a.id);
		if (a.capacity !== undefined && others.length >= a.capacity) return `${a.name}は、いまいっぱいです`;
		if (m.life) {
			const err = cannotStart(decay(m.life, now), a);
			if (err) return err;
		}
		// it costs coins from the wallet, like a shop (the host's guide pays nothing)
		const cost = m.system ? 0 : (a.cost ?? 0);
		if (cost > 0) {
			if (m.coins === undefined) return "お財布が見つかりません（入り直してください）";
			if (m.coins < cost) return `銅貨が${cost - m.coins}枚足りません（働くか勉強すると増えます）`;
		}
		this.stopDoing(conn, m, now);
		if (m.job) this.stopJob(m, now);
		if (cost > 0) this.spend(m, -cost, "buy");
		if (m.life) m.life = decay(m.life, now);
		m.doing = { activity: a.id, since: now, until: now + Math.round(realMs(a.minutes)) };
		const face = m.move.kind === "idle" ? m.move.face : undefined;
		m.move = {
			kind: "idle",
			pos: this.positionOf(m, now),
			at: now,
			...(a.pose ? { posture: a.pose } : {}),
			...(face ? { face } : {}),
		};
		this.transport.persist(conn, m);
		this.broadcastAbout(m, { t: "MOVED", id: m.id, move: m.move });
		this.broadcastAbout(m, { t: "ACTING", id: m.id, doing: m.doing });
		this.sendLife(m);
		return null;
	}

	/**
	 * Ends what `m` is doing: done once its time is up, otherwise stopped part way, with that share of its
	 * effects and pay. `tell`: false when they are leaving (nobody needs to hear, nothing to persist).
	 */
	private stopDoing(conn: C, m: Member, now: number, tell = true): void {
		const d = m.doing;
		if (!d) return;
		delete m.doing;
		const a = this.activity(d.activity);
		const share = Math.min(1, Math.max(0, (now - d.since) / Math.max(1, d.until - d.since)));
		const done: Extract<HostToClient, { t: "ACT_DONE" }> = {
			t: "ACT_DONE",
			activity: d.activity,
			share: round2(share),
		};
		if (m.life && a) {
			const r = finishActivity(decay(m.life, now), a, share);
			m.life = r.life;
			done.delta = r.delta;
			done.life = r.life;
			this.lifeStore?.save(m.id, r.life);
		}
		if (!tell) return;
		this.transport.persist(conn, m);
		this.transport.send(conn, done);
		this.broadcastAbout(m, { t: "ACTING", id: m.id, doing: null });
		this.sendLife(m, false);
	}

	/** Activities whose time is up end; AIs whose city day is over wake up to a new one. */
	private lifeTick(now: number): void {
		const block = cityTime(now).block;
		for (const [conn, m] of [...this.members]) {
			if (this.away.has(conn)) continue;
			if (m.doing && m.doing.until <= now) this.stopDoing(conn, m, now);
			if (m.life && m.life.block !== block) {
				// the work done so far belongs to the day that ends
				if (m.job) this.settleJob(m, now, false);
				const { life, review } = newDay(decay(m.life, now), now);
				m.life = life;
				this.transport.persist(conn, m);
				this.lifeStore?.save(m.id, life);
				this.transport.send(conn, { t: "DAY", review, life });
				this.sendLife(m, false);
			}
			if (m.life) this.companyMood(conn, m, now);
			// too hungry to go on working or studying
			if (m.job && m.life) {
				const from = m.job.settled ?? m.job.since;
				const left = finishJob(decay(m.life, now), m.job.kind, cityMinutesOf(now - from)).life.energy;
				if (left <= 0) {
					this.stopJob(m, now);
					this.notice(conn, "rejected", "おなかがすいて、もう働けません。何か食べてください");
				}
			}
		}
	}

	/** Walking with its owner here, an AI feels better: COMPANY_MOOD for each COMPANY_MOOD_MS beside them. */
	private companyMood(conn: C, m: Member, now: number): void {
		if (!m.life || !this.accompanying(m)) {
			if (m.companyAt === undefined) return;
			delete m.companyAt;
			this.transport.persist(conn, m);
			return;
		}
		const since = m.companyAt ?? now;
		const life = withCompany(m.life, now - since);
		m.companyAt = since + Math.floor((now - since) / COMPANY_MOOD_MS) * COMPANY_MOOD_MS;
		this.transport.persist(conn, m);
		if (life === m.life || life.mood === m.life.mood) return;
		m.life = life;
		this.sendLife(m);
	}

	/** Tells an AI (`self`) and its owner here what its life is now. */
	private sendLife(m: Member, self = true): void {
		if (!m.life) return;
		const msg: HostToClient = {
			t: "LIFE",
			id: m.id,
			life: m.life,
			...(m.coins !== undefined ? { coins: m.coins } : {}),
		};
		const own = this.byId.get(m.id);
		if (self && own !== undefined) this.transport.send(own, msg);
		const owner = m.kind === "ai" ? this.byId.get(m.ownerId) : undefined;
		if (owner !== undefined) this.transport.send(owner, msg);
	}

	/** On the ground no faster than MAX_SPEED (afloat, FLY_RUN_SPEED); an AI too hungry or unfit to run walks. */
	private speedFor(m: Member, speed: number, now: number): number {
		const capped = Math.min(speed, m.fly !== undefined ? FLY_RUN_SPEED : MAX_SPEED);
		return m.life && capped > WALK_SPEED && !canRun(decay(m.life, now)) ? WALK_SPEED : capped;
	}

	/** How far a move may start from where the host thinks one is: further afloat, where one goes fast. */
	private tolerance(m: Member): number {
		const speed = m.fly !== undefined && m.move.kind !== "idle" ? m.move.speed : 0;
		return POSITION_TOLERANCE + speed * 0.3;
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

	// ---- shops (docs/prd.md 3.8.6) -------------------------------------------

	/** Buys at a shop's counter: the thing is in the buyer's hand. Coins are not counted (yet). */
	private buy(m: Member, shopId: string, goodsId: string, now: number): string | null {
		const shop = this.world.shops?.find((s) => s.id === shopId);
		const goods = shop?.goods.find((g) => g.id === goodsId);
		if (!shop || !goods) return "そのお店では売っていません";
		if (this.holding(m.id)) return "手に持っているものを置いてから買ってください";
		if (dist(this.positionOf(m, now), shop.counter) > SHOP_REACH) return "お店のカウンターまで行ってください";
		// the host's own guide has no wallet and pays nothing; anyone else without one cannot buy
		if (m.coins === undefined && !m.system) return "お財布が見つかりません（入り直してください）";
		if (m.coins !== undefined) {
			if (m.coins < goods.price)
				return `${shop.currency}が${goods.price - m.coins}枚足りません（お店や宿で働くか、学校で勉強すると増えます）`;
			this.spend(m, -goods.price, "buy");
		}
		const item: Item = {
			id: `i_${this.newId()}`,
			kind: "goods",
			goods: { id: goods.id, name: goods.name, color: goods.color, ...(goods.food ? { food: true } : {}) },
			pos: this.positionOf(m, now),
			holder: m.id,
		};
		this.items.set(item.id, item);
		this.itemChanged(item);
		// bought things pile up: the oldest one lying about goes
		const bought = [...this.items.values()].filter((i) => i.kind === "goods");
		const spare = bought.filter((i) => !i.holder);
		for (let k = 0; k < bought.length - MAX_GOODS && k < spare.length; k++) this.itemGone(spare[k] as Item);
		return null;
	}

	/** Eats or drinks what the member holds; for an AI that lives here, it is food (docs/life.md 2). */
	private use(m: Member, now: number): string | null {
		const item = this.holding(m.id);
		if (!item) return "何も持っていません";
		const goods = item.goods;
		if (!goods?.food) return "それは食べられません";
		this.itemGone(item, m.id);
		if (m.life) {
			const food = this.world.foods?.[goods.id];
			const r = eatFood(decay(m.life, now), food);
			m.life = r.life;
			this.lifeStore?.save(m.id, r.life);
			const conn = this.byId.get(m.id);
			if (conn !== undefined) {
				this.transport.persist(conn, m);
				this.transport.send(conn, {
					t: "ACT_DONE",
					activity: goods.id,
					share: 1,
					name: `${goods.name}を${food?.drink ? "飲んだ" : "食べた"}${food?.meal ? "（ごはん）" : ""}`,
					delta: r.delta,
					life: r.life,
				});
			}
			this.sendLife(m, false);
		}
		return null;
	}

	/** Adds to (or takes from) a wallet, saves it and tells its owner. */
	private spend(m: Member, delta: number, why: "buy" | JobKind): void {
		if (m.coins === undefined || delta === 0) return;
		m.coins += delta;
		this.wallets?.add(m.id, delta);
		const conn = this.byId.get(m.id);
		if (conn !== undefined) {
			this.transport.persist(conn, m);
			this.transport.send(conn, { t: "WALLET", coins: m.coins, change: delta, why });
		}
	}

	// ---- working and studying (docs/prd.md 3.8.6) -----------------------------

	/** The zone of this kind where `m` stands, if any. */
	private jobZoneAt(m: Member, kind: JobKind, now: number): JobZone | undefined {
		const pos = this.positionOf(m, now);
		return this.world.jobZones?.find((z) => z.kind === kind && insidePolygon(pos, z.poly));
	}

	/** Still in that zone, and not walking out of it. */
	private inJobZone(m: Member, zoneId: string, now: number): boolean {
		const zone = this.world.jobZones?.find((z) => z.id === zoneId);
		if (!zone) return false;
		const end = m.move.kind === "path" ? m.move.path[m.move.path.length - 1] : undefined;
		return insidePolygon(this.positionOf(m, now), zone.poly) && (!end || insidePolygon(end, zone.poly));
	}

	private startJob(m: Member, kind: JobKind, now: number): string | null {
		const zone = this.jobZoneAt(m, kind, now);
		if (!zone)
			return kind === "work"
				? "ここでは働けません（お店、温泉宿の帳場、広場の屋台で働けます）"
				: "ここでは勉強できません（学校と本屋で勉強できます）";
		if (m.job?.kind === kind && m.job.zone === zone.id) return null;
		if (m.life) {
			const err = cannotJob(decay(m.life, now));
			if (err) return err;
		}
		// one thing at a time: an activity ends
		const conn = this.byId.get(m.id);
		if (conn !== undefined && m.doing) this.stopDoing(conn, m, now);
		if (m.job) {
			this.payJob(m, now);
			this.settleJob(m, now, true);
		}
		m.job = { kind, zone: zone.id, since: now, paid: 0 };
		this.jobChanged(m);
		return null;
	}

	private stopJob(m: Member, now: number): string | null {
		if (!m.job) return null;
		this.payJob(m, now);
		this.settleJob(m, now, true);
		delete m.job;
		this.jobChanged(m);
		return null;
	}

	/** What working or studying has earned since it was last paid: one coin per EARN_MS. */
	private payJob(m: Member, now: number): void {
		if (!m.job) return;
		const earned = Math.floor((now - m.job.since) / EARN_MS) - m.job.paid;
		if (earned <= 0) return;
		m.job.paid += earned;
		this.spend(m, earned, m.job.kind);
	}

	/**
	 * The work or study until `now` goes into an AI's life (energy, skill, the day's work, docs/life.md 2).
	 * `tell`: it is over, and the AI hears what it did (ACT_DONE, for its diary). `save`: false for the
	 * minute-by-minute update while it goes on (D1 is written when it ends, on a new morning and on leaving).
	 */
	private settleJob(m: Member, now: number, tell: boolean, save = true): void {
		const job = m.job;
		if (!job || !m.life) return;
		const info = this.world.jobs?.[job.zone];
		const r = finishJob(decay(m.life, now), job.kind, cityMinutesOf(now - (job.settled ?? job.since)), info);
		m.life = r.life;
		job.settled = now;
		job.used = round2((job.used ?? 0) + (r.delta.energy ?? 0));
		if (save) this.lifeStore?.save(m.id, r.life);
		const conn = tell ? this.byId.get(m.id) : undefined;
		if (conn === undefined) return;
		const zone = this.world.jobZones?.find((z) => z.id === job.zone);
		this.transport.send(conn, {
			t: "ACT_DONE",
			activity: job.zone,
			share: 1,
			name: `${zone?.name ?? job.zone}で${job.kind === "work" ? "働いた" : "勉強した"}`,
			...(info?.about ? { about: info.about } : {}),
			minutes: Math.round(cityMinutesOf(now - job.since)),
			delta: { energy: Math.round(job.used * 10) / 10, ...(job.paid > 0 ? { coins: job.paid } : {}) },
			life: r.life,
		});
		this.sendLife(m, false);
	}

	private jobChanged(m: Member): void {
		const conn = this.byId.get(m.id);
		if (conn !== undefined) this.transport.persist(conn, m);
		this.broadcastAll({ t: "JOBBED", id: m.id, job: m.job?.kind ?? null });
	}

	/** Pays everyone at work, and ends the work of those no longer where they work. */
	payJobs(now = this.clock()): void {
		for (const m of this.members.values()) {
			if (!m.job) continue;
			if (!this.inJobZone(m, m.job.zone, now)) this.stopJob(m, now);
			else {
				this.payJob(m, now);
				// an AI hears how its day's work is going (and its owner sees it) as it goes
				if (m.life) {
					this.settleJob(m, now, false, false);
					this.sendLife(m);
				}
			}
		}
	}

	private itemGone(item: Item, by?: AvatarId): void {
		this.items.delete(item.id);
		this.itemStore?.save([...this.items.values()]);
		this.broadcastAll({ t: "ITEM_GONE", id: item.id, ...(by ? { by } : {}) });
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

	/** Afloat one goes anywhere not too far out from where one can walk (docs/prd.md 3.4.13). */
	private inSky(p: Vec2): boolean {
		return dist(this.walk.closestPoint(p), p) <= FLY_REACH;
	}

	private movePath(conn: C, m: Member, msg: Extract<ClientToHost, { t: "MOVE_PATH" }>, now: number): void {
		const here = this.positionOf(m, now);
		const start = msg.path[0] as Vec2;
		const fromHere = dist(start, here) <= this.tolerance(m);
		const clear = (path: Vec2[]) =>
			m.fly !== undefined ? path.every((p) => this.inSky(p)) : this.walkOf(m).validatePath(path);
		// start exactly where the host thinks the avatar is, so everyone interpolates the same line; that way is
		// checked too (from a little elsewhere it could cut through a wall)
		const mine: Vec2[] = [here, ...msg.path.slice(1)];
		let path: Vec2[] | null =
			fromHere && polylineLength(mine) <= MAX_PATH_LENGTH && clear(msg.path) && clear(mine) ? mine : null;
		// a path through something built (a client or AI that does not know about it yet), or from here through
		// a wall: plan it again
		if (!path && fromHere && m.fly === undefined && (this.builds.size > 0 || clear(msg.path)))
			path = this.replan(here, msg.path[msg.path.length - 1] as Vec2, this.walkOf(m));
		if (!path) {
			this.reject(conn, m, here, now);
			return;
		}
		this.stopDoing(conn, m, now);
		m.move = { kind: "path", path, speed: this.speedFor(m, msg.speed, now), at: now };
		this.transport.persist(conn, m);
		this.broadcastAbout(m, { t: "MOVED", id: m.id, move: m.move });
	}

	private moveVel(conn: C, m: Member, msg: Extract<ClientToHost, { t: "MOVE_VEL" }>, now: number): void {
		const here = this.positionOf(m, now);
		// on the ground, from where the host thinks one is to there must be clear (not through a wall)
		const open =
			m.fly !== undefined
				? this.inSky(msg.pos)
				: this.walkOf(m).isWalkable(msg.pos) &&
					(dist(msg.pos, here) < 0.05 || this.walkOf(m).validatePath([here, msg.pos]));
		if (dist(msg.pos, here) > this.tolerance(m) || !open) {
			this.reject(conn, m, here, now);
			return;
		}
		const still = msg.dir[0] === 0 && msg.dir[1] === 0;
		if (msg.speed > 0 && !still) this.stopDoing(conn, m, now);
		// speed 0 with a direction: standing, turned that way (docs/prd.md 3.4.11)
		m.move =
			msg.speed === 0 && !still
				? { kind: "idle", pos: msg.pos, at: now, face: msg.dir }
				: msg.speed === 0 || still
					? { kind: "idle", pos: msg.pos, at: now }
					: { kind: "vel", pos: msg.pos, dir: msg.dir, speed: this.speedFor(m, msg.speed, now), at: now };
		this.transport.persist(conn, m);
		this.broadcastAbout(m, { t: "MOVED", id: m.id, move: m.move });
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
			this.stopDoing(conn, m, now);
			// a posture ends: one floats up standing
			const here = this.positionOf(m, now);
			if (m.move.kind === "idle" && m.move.posture) {
				m.move = { kind: "idle", pos: here, at: now };
				this.broadcastAbout(m, { t: "MOVED", id: m.id, move: m.move });
			}
		}
		this.transport.persist(conn, m);
		this.broadcastAbout(m, { t: "FLEW", id: m.id, alt });
		return null;
	}

	/** Stands `m` still on the walkable ground nearest `p` (where one lands, or warps to). */
	private land(conn: C, m: Member, p: Vec2, now: number): void {
		const walk = this.walkOf(m);
		let at: Vec2 = walk.isWalkable(p) ? p : walk.closestPoint(p);
		// rings round it, then the spawn point, if the nearest point is not quite on the ground
		for (let r = 1; r <= 30 && !walk.isWalkable(at); r++)
			for (let k = 0; k < 16; k++) {
				const q: Vec2 = [p[0] + Math.cos((k * Math.PI) / 8) * r, p[1] + Math.sin((k * Math.PI) / 8) * r];
				if (walk.isWalkable(q)) {
					at = q;
					break;
				}
			}
		if (!walk.isWalkable(at)) at = this.world.spawn;
		m.move = { kind: "idle", pos: [round1(at[0]), round1(at[1])], at: now };
		if (!walk.isWalkable(m.move.pos)) m.move = { kind: "idle", pos: at, at: now };
		this.transport.persist(conn, m);
		this.broadcastAbout(m, { t: "MOVED", id: m.id, move: m.move });
	}

	/** Humans: at one of the area's landmarks or portals at once, on the ground (docs/prd.md 3.4.14). */
	private warp(conn: C, m: Member, to: string, now: number): string | null {
		if (m.kind !== "human") return "AIは歩いて行ってください";
		const place = this.world.landmarks.find((l) => l.id === to);
		if (!place) return "その場所はありません";
		if (m.warpedAt !== undefined && now - m.warpedAt < WARP_INTERVAL_MS) return "少し待ってください";
		m.warpedAt = now;
		this.stopDoing(conn, m, now);
		if (m.fly !== undefined) {
			delete m.fly;
			this.broadcastAbout(m, { t: "FLEW", id: m.id, alt: null });
		}
		this.land(conn, m, this.spawnPoint(to), now);
		this.bringCompany(m, now);
		return null;
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
	private replan(here: Vec2, to: Vec2, walk = this.walk): Vec2[] | null {
		const path = walk.findPath?.(walk.closestPoint(here), walk.closestPoint(to));
		if (!path || path.length < 2 || path.length > MAX_PATH_POINTS) return null;
		path[0] = here;
		return polylineLength(path) <= MAX_PATH_LENGTH && walk.validatePath(path) ? path : null;
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

	/** Where `m` may walk: the walkable area without the rooms its sex keeps out of (docs/prd.md 3.8.6). */
	private walkOf(m: { assets: AvatarAssets }): Walkable {
		const sex = m.assets.sex;
		const out = sex ? this.world.keepOut?.[sex] : undefined;
		if (!sex || !out?.length) return this.walk;
		let made = this.walkBySex.get(this.walk);
		if (!made) {
			made = new Map();
			this.walkBySex.set(this.walk, made);
		}
		let w = made.get(sex);
		if (!w) {
			w = keepingOut(this.walk, out);
			made.set(sex, w);
		}
		return w;
	}

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
				...(o.doing ? { doing: this.activity(o.doing.activity)?.name ?? o.doing.activity } : {}),
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
		if (m.coins !== undefined) context.coins = m.coins;
		if (m.job) context.job = m.job.kind;
		const canJob = (["work", "study"] as const).filter((k) => this.jobZoneAt(m, k, now));
		if (canJob.length > 0) context.canJob = canJob;
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
		// what working or studying earned until now goes into the wallet (D1); it is not carried on elsewhere
		if (m.job) {
			this.payJob(m, this.clock());
			this.settleJob(m, this.clock(), false);
			delete m.job;
		}
		this.members.delete(conn);
		if (this.byId.get(m.id) === conn) {
			this.byId.delete(m.id);
			this.relations.delete(m.id);
		}
		for (const c of [...this.convs.values()]) if (c.a === m.id || c.b === m.id) this.endConv(c, "left");
		this.leads.delete(m.id);
		// what they were doing ends with what they did of it; their life is saved as it is
		const now = this.clock();
		if (m.doing) this.stopDoing(conn, m, now, false);
		else if (m.life) this.lifeStore?.save(m.id, decay(m.life, now));
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
