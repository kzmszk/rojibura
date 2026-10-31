// Where people can walk once things are built (docs/prd.md 3.7). The host, the browser and AI runtimes
// call applyBuilds() with the same inputs, so they agree on the walkable area without sending navmeshes.

import {
	area2,
	assemble,
	ccw,
	convexHull,
	expand,
	intersect,
	type Piece,
	piecesOf,
	subtract,
	xz,
} from "./carve.ts";
import type { NavMeshData } from "./navmesh.ts";
import type { Vec2 } from "./vec.ts";

/** Obstacles are widened by this much: the agent radius the city's navmesh was built with (m). */
export const NAV_MARGIN = 0.3;
/** A model people can walk on claims its footprint widened by this much, where it joins the ground (m). */
export const WALK_RING = 1.0;
/** A registered model may be at most this big (tools/city-build model CLI, POST /api/models). */
export const MODEL_LIMITS = {
	bytes: 16 * 1024 * 1024,
	triangles: 200_000,
	/** Width, height and depth at scale 1 (m). */
	extent: [40, 60, 40],
	navPolygons: 2000,
	nameLength: 24,
} as const;
/** Walkable polygons of a model below this height (m) are ground: they are kept only where the city is walkable. */
export const GROUND_Y = 0.25;
/** A city polygon is the ground under a model only if its height is this close to the model's base (m). */
const GROUND_DY = 0.75;

/**
 * How a model changes where people can walk: `<id>.nav.json`, written by tools/city-build (model CLI).
 * Model space: metres, Y up, the base at y = 0 and its centre at the origin, the front facing +Z.
 */
export interface ModelNav {
	version: 1;
	min: [number, number, number];
	max: [number, number, number];
	/** Where it stands: convex polygons on the XZ plane. Obstacles, unless the model has `walk`. */
	footprint: Vec2[][];
	/** People can walk on it: its walkable surface together with the ground around it (from Recast). */
	walk?: NavMeshData;
}

export interface PlacedModel {
	nav: ModelNav;
	pos: Vec2;
	/** Height of the base. */
	y: number;
	/** Degrees: the front (+Z) faces (sin rot, cos rot). */
	rot: number;
	scale: number;
}

/** A box `w` wide, `h` high and `d` deep (the "block" model). */
export function boxNav(w: number, h: number, d: number): ModelNav {
	const x = w / 2;
	const z = d / 2;
	return {
		version: 1,
		min: [-x, 0, -z],
		max: [x, h, z],
		footprint: [
			[
				[-x, -z],
				[x, -z],
				[x, z],
				[-x, z],
			],
		],
	};
}

/** Model space to world space on the XZ plane. */
export function toWorld(p: PlacedModel, [x, z]: Vec2): Vec2 {
	const r = (p.rot * Math.PI) / 180;
	const c = Math.cos(r);
	const s = Math.sin(r);
	const sx = x * p.scale;
	const sz = z * p.scale;
	return [p.pos[0] + sx * c + sz * s, p.pos[1] - sx * s + sz * c];
}

/** The footprint in world space (counter-clockwise), widened by `margin`. */
export function occupied(p: PlacedModel, margin = 0): Vec2[][] {
	return p.nav.footprint.map((part) =>
		expand(
			ccw(
				part.map((q) => toWorld(p, q)),
				area2,
			),
			margin,
		),
	);
}

/** For a model people can walk on: the region it takes over from the city (footprint hull + WALK_RING). */
export function walkRegion(p: PlacedModel): Vec2[] | null {
	if (!p.nav.walk) return null;
	return expand(convexHull(p.nav.footprint.flat().map((q) => toWorld(p, q))), WALK_RING * p.scale);
}

/** What a build claims: no two builds may overlap here. */
export function claimed(p: PlacedModel): Vec2[][] {
	const region = walkRegion(p);
	return region ? [region] : occupied(p);
}

/**
 * The city's navmesh with things built on it. In a fixed order: regions of walkable models are cut out of
 * the city, the models' walkable surfaces are put in (ground-level parts only where the city is walkable,
 * so they join the city along the region's border), then obstacles (widened by NAV_MARGIN) are cut out.
 */
export function applyBuilds(base: NavMeshData, placed: readonly PlacedModel[]): NavMeshData {
	if (placed.length === 0) return base;
	let pieces = piecesOf(base);
	const city = pieces;
	const walkers = placed.filter((p) => p.nav.walk);
	for (const w of walkers) {
		const region = walkRegion(w) as Vec2[];
		pieces = pieces.flatMap((p) => subtract(p, region));
	}
	for (const w of walkers) {
		const region = walkRegion(w) as Vec2[];
		for (const local of piecesOf(w.nav.walk as NavMeshData)) {
			const world: Piece = local.map(([x, y, z]) => {
				const [wx, wz] = toWorld(w, [x, z]);
				return [wx, w.y + y * w.scale, wz];
			});
			const inside = intersect(world, region);
			if (!inside) continue;
			const top = Math.max(...local.map((v) => v[1])) * w.scale;
			if (top >= GROUND_Y) {
				pieces.push(inside);
				continue;
			}
			for (const g of city) {
				const avg = g.reduce((s, v) => s + v[1], 0) / g.length;
				if (Math.abs(avg - w.y) > GROUND_DY) continue;
				const part = intersect(inside, xz(g));
				if (part) pieces.push(part);
			}
		}
	}
	for (const p of placed)
		if (!p.nav.walk) for (const o of occupied(p, NAV_MARGIN)) pieces = pieces.flatMap((q) => subtract(q, o));
	return assemble(pieces);
}
