import type { KeepOut, ModelNav, PlacedModel } from "@rojibura/nav";
import type {
	Activity,
	AvatarAssets,
	AvatarId,
	AvatarKind,
	Build,
	BuildId,
	Doing,
	Food,
	HostToClient,
	Item,
	ItemKind,
	JobInfo,
	JobKind,
	JobZone,
	LifeState,
	ModelId,
	MoveState,
	Seat,
	Sex,
	Shop,
	Status,
	Together,
	Vec2,
} from "@rojibura/protocol";

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
	/** AIs: where it runs now: the runtime it registered with, or "pc" if it came in with its owner's PC's key. */
	runsOn?: string;
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
	/** Humans: those of their AIs that stay by them, whether here or not (docs/prd.md 3.4.9). The others are free. */
	company?: AvatarId[];
	/** Humans floating in the air (docs/prd.md 3.4.13): at this height (world Y); they move over everything. */
	fly?: number;
	/** Host time of their last WARP (docs/prd.md 3.4.14). */
	warpedAt?: number;
	/** Which way the avatar last walked (the host knows no facing): companions keep to its front. */
	heading?: Vec2;
	/**
	 * Humans walking on with keys and company: nothing is heard of them while the keys stay as they are, so at this
	 * host time their AIs are told how to go on (docs/prd.md 3.4.9).
	 */
	companyAgainAt?: number;
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
