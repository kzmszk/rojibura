import { boxNav, keepingOut, type ModelNav, type PlacedModel } from "@rojibura/nav";
import {
	type AvatarAssets,
	type AvatarId,
	type Build,
	type BuildAt,
	type BuildId,
	type ClientToHost,
	CONTEXT_AVATAR_RADIUS,
	CONTEXT_LANDMARK_RADIUS,
	CONTEXT_MAX_ITEMS,
	dist,
	type HostToClient,
	type JobKind,
	MAX_PATH_LENGTH,
	MAX_PATH_POINTS,
	type MoveState,
	polylineLength,
	poseAt,
	type Sex,
	type SpatialContext,
	type Vec2,
} from "@rojibura/protocol";
import { findBuildPlacement } from "./build-placement.ts";
import type { BuildStore, Member, Walkable, World } from "./room-types.ts";
import type { RoomRules } from "./rules.ts";

interface SpacePort {
	clock(): number;
	newId(): string;
	members(): IterableIterator<Member>;
	memberById(id: AvatarId): Member | undefined;
	blockedBetween(a: AvatarId, b: AvatarId): boolean;
	broadcastAll(message: HostToClient): void;
	stopThoseCrossing(now: number): void;
}
const BLOCK_DEFAULT_SIZE: [number, number, number] = [1, 1, 1];
function round1(n: number): number {
	return Math.round(n * 10) / 10;
}
function round2(n: number): number {
	return Math.round(n * 100) / 100;
}

export class RoomSpace {
	private readonly builds = new Map<BuildId, Build>();
	private walk: Walkable;
	private walkBySex = new WeakMap<Walkable, Map<Sex, Walkable>>();
	private readonly world: World;
	private readonly rules: RoomRules;
	private readonly store: BuildStore | undefined;
	private readonly port: SpacePort;
	constructor(world: World, rules: RoomRules, store: BuildStore | undefined, port: SpacePort) {
		this.world = world;
		this.rules = rules;
		this.store = store;
		this.port = port;
		this.walk = world.walk;
	}
	landingPoint(m: { assets: AvatarAssets }, p: Vec2): Vec2 {
		const walk = this.walkOf(m);
		let at: Vec2 = walk.isWalkable(p) ? p : walk.closestPoint(p);
		for (let r = 1; r <= 30 && !walk.isWalkable(at); r++)
			for (let k = 0; k < 16; k++) {
				const q: Vec2 = [p[0] + Math.cos((k * Math.PI) / 8) * r, p[1] + Math.sin((k * Math.PI) / 8) * r];
				if (walk.isWalkable(q)) {
					at = q;
					break;
				}
			}
		if (!walk.isWalkable(at)) at = this.world.spawn;
		const rounded: Vec2 = [round1(at[0]), round1(at[1])];
		return walk.isWalkable(rounded) ? rounded : at;
	}
	get terrain(): Walkable {
		return this.walk;
	}
	get canBuild(): boolean {
		return this.rules.build !== null && this.world.build !== undefined;
	}
	get hasBuilds(): boolean {
		return this.builds.size > 0;
	}
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
		for (const id of ids) this.port.broadcastAll({ t: "UNBUILT", id, by });
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
	build(m: Member, msg: Extract<ClientToHost, { t: "BUILD" }>, now: number): string | null {
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

		const result = findBuildPlacement({
			anchor,
			nav,
			scale,
			rotation: msg.rot,
			existing: this.placedAll(),
			world: this.world,
			buildWorld: bw,
			people: [...this.port.members()].map((o) => ({ name: o.name, pos: this.positionOf(o, now) })),
		});
		if (result.kind === "rejected") return result.error;
		const { placed, walk } = result;
		const b: Build = {
			id: `b_${this.port.newId()}`,
			model: msg.model,
			pos: [round2(placed.pos[0]), round2(placed.pos[1])],
			y: round2(placed.y),
			rot: placed.rot,
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
		this.port.broadcastAll({ t: "BUILT", build: b, ref: msg.ref });
		this.port.stopThoseCrossing(now);
		return null;
	}

	unbuild(m: Member, msg: Extract<ClientToHost, { t: "UNBUILD" }>): string | null {
		if (!this.canBuild) return "この街では建てられません";
		// free play: anyone may take anything down (production rules would allow only the builder's own)
		if (!this.builds.delete(msg.id)) return "その建物はありません";
		this.store?.remove(msg.id);
		this.rebuildWalk();
		this.port.broadcastAll({ t: "UNBUILT", id: msg.id, by: m.id, ref: msg.ref });
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
			const a = this.port.memberById(at.avatar);
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

	/** A path from here to (near) `to` on the walkable area with builds, within the protocol's limits. */
	replan(here: Vec2, to: Vec2, walk = this.walk): Vec2[] | null {
		const path = walk.findPath?.(walk.closestPoint(here), walk.closestPoint(to));
		if (!path || path.length < 2 || path.length > MAX_PATH_POINTS) return null;
		path[0] = here;
		return polylineLength(path) <= MAX_PATH_LENGTH && walk.validatePath(path) ? path : null;
	}

	// ---- spatial ------------------------------------------------------------

	/** Where `m` may walk: the walkable area without the rooms its sex keeps out of (docs/prd.md 3.8.6). */
	walkOf(m: { assets: AvatarAssets }): Walkable {
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

	positionOf(m: Member, now = this.port.clock()): Vec2 {
		return poseAt(m.move, now, (p) => (this.walk.isWalkable(p) ? p : this.walk.closestPoint(p))).pos;
	}

	contextFor(m: Member, now: number, canJobAt: (kind: JobKind) => boolean): SpatialContext {
		const pos = this.positionOf(m, now);
		const nearbyAvatars = [...this.port.members()]
			.filter((o) => o.id !== m.id && !this.port.blockedBetween(m.id, o.id))
			.map((o) => ({
				id: o.id,
				name: o.name,
				kind: o.kind,
				distance: round1(dist(pos, this.positionOf(o, now))),
				...(o.doing
					? {
							doing: this.world.activities?.find((a) => a.id === o.doing?.activity)?.name ?? o.doing.activity,
						}
					: {}),
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
		const canJob = (["work", "study"] as const).filter((k) => canJobAt(k));
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
	spawnPoint(arrive?: string): Vec2 {
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
}

/** The part of a path move still ahead at `now`, starting where the avatar is. */
export function remainingPath(move: Extract<MoveState, { kind: "path" }>, now: number): Vec2[] {
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
