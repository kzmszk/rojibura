import { claimed, type ModelNav, occupied, overlaps, type PlacedModel } from "@rojibura/nav";
import { dist, facing, type Vec2 } from "@rojibura/protocol";
import type { BuildWorld, Walkable, World } from "./room-core.ts";

type Person = { name: string; pos: Vec2 };
type Anchor = { point: Vec2; exact: boolean; face?: Vec2 };

/** Building: keep this clear around the spawn point and landmarks (m). */
const SPAWN_CLEAR = 3.5;
const LANDMARK_CLEAR = 1.5;
/** Searching for a free spot: rings this far apart, this many directions, this many rings. */
const SPOT_STEP = 1;
const SPOT_DIRECTIONS = 16;
const SPOT_RINGS = 12;
/** Spots whose cheap checks pass and whose walkable area is then computed, at most. */
const SPOT_FULL_CHECKS = 4;
export function findBuildPlacement({
	anchor,
	nav,
	scale,
	rotation,
	existing,
	world,
	buildWorld,
	people,
}: {
	anchor: Anchor;
	nav: ModelNav;
	scale: number;
	rotation: number | undefined;
	existing: PlacedModel[];
	world: World;
	buildWorld: BuildWorld;
	people: Person[];
}): { kind: "placed"; placed: PlacedModel; walk: Walkable } | { kind: "rejected"; error: string } {
	let firstError: string | null = null;
	let fullChecks = 0;
	for (const pos of anchor.exact ? [anchor.point] : spotsAround(anchor.point, nav, scale)) {
		const rot = rotation ?? (anchor.face ? facing(pos, anchor.face) : 0);
		const placed: PlacedModel = { nav, pos, y: buildWorld.groundHeight(pos) ?? 0, rot, scale };
		let err = placementError(placed, existing, world, people);
		if (!err) {
			if (fullChecks++ >= SPOT_FULL_CHECKS) break;
			const walk = buildWorld.walkWith([...existing, placed]);
			err = reachError(walk, world, people);
			if (!err) return { kind: "placed", placed, walk };
		}
		firstError ??= err;
	}
	return { kind: "rejected", error: firstError ?? "置ける場所が見つかりません" };
}

/** Candidate centres in rings around `center`, starting just clear of the model's own size. */
function* spotsAround(center: Vec2, nav: ModelNav, scale: number): Generator<Vec2> {
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
function placementError(
	p: PlacedModel,
	existing: PlacedModel[],
	world: World,
	people: Person[],
): string | null {
	const city = world.walk;
	const parts = occupied(p);
	const onGround = parts.every((part) => sampleOutline(part, 0.5).every((q) => city.isWalkable(q)));
	if (!onGround || !city.isWalkable(p.pos))
		return "そこには建てられません（地面の外か、街の建物と重なります）";
	const mine = claimed(p);
	if (existing.some((o) => claimed(o).some((c) => mine.some((d) => overlaps(c, d, 1e-4)))))
		return "ほかの建物と重なります";
	const blocking = occupied(p, 0.3);
	const near = (q: Vec2, d: number) => blocking.some((part) => distanceToConvex(q, part) <= d);
	if (near(world.spawn, SPAWN_CLEAR)) return "スポーン地点のそばには建てられません";
	const landmark = world.landmarks.find((l) => near(l.pos, LANDMARK_CLEAR));
	if (landmark) return `${landmark.name}の上には建てられません`;
	for (const o of people) if (near(o.pos, 0.2)) return `そこに${o.name}がいます`;
	return null;
}

/** With `walk`, everyone can still get to the spawn point, and from there to every landmark. */
function reachError(walk: Walkable, world: World, people: Person[]): string | null {
	const find = walk.findPath?.bind(walk);
	if (!find) return null;
	const spawn = walk.closestPoint(world.spawn);
	for (const l of world.landmarks)
		if (!find(spawn, walk.closestPoint(l.pos)))
			return `道をふさいでしまいます（${l.name}へ行けなくなります）`;
	for (const o of people)
		if (!find(walk.closestPoint(o.pos), spawn))
			return `道をふさいでしまいます（${o.name}が出られなくなります）`;
	return null;
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
