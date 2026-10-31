import { describe, expect, test } from "vitest";
import landmarksJson from "../../../assets/test-city/landmarks.json";
import navmeshJson from "../../../assets/test-city/navmesh.json";
import {
	applyBuilds,
	boxNav,
	claimed,
	type ModelNav,
	NAV_MARGIN,
	occupied,
	type PlacedModel,
} from "./builds.ts";
import { carveObstacles, convexHull, expand, overlaps } from "./carve.ts";
import type { LandmarksData } from "./landmarks.ts";
import { NavMesh, type NavMeshData } from "./navmesh.ts";
import type { Vec2 } from "./vec.ts";

/** A flat rectangle [x0, x1] x [z0, z1] split into a 2 x 2 grid of quads, at height y. */
function plane(x0: number, x1: number, z0: number, z1: number, y = 0): NavMeshData {
	const xm = (x0 + x1) / 2;
	const zm = (z0 + z1) / 2;
	const xs = [x0, xm, x1];
	const zs = [z0, zm, z1];
	const vertices: number[] = [];
	for (const z of zs) for (const x of xs) vertices.push(x, y, z);
	const v = (i: number, j: number) => j * 3 + i;
	const quad = (i: number, j: number) => [v(i, j), v(i + 1, j), v(i + 1, j + 1), v(i, j + 1)];
	const polygons = [
		{ verts: quad(0, 0), neighbors: [-1, 1, 2, -1] },
		{ verts: quad(1, 0), neighbors: [-1, -1, 3, 0] },
		{ verts: quad(0, 1), neighbors: [0, 3, -1, -1] },
		{ verts: quad(1, 1), neighbors: [1, -1, -1, 2] },
	];
	return { version: 1, vertices, polygons };
}

const rect = (x0: number, x1: number, z0: number, z1: number): Vec2[] => [
	[x0, z0],
	[x1, z0],
	[x1, z1],
	[x0, z1],
];

function inside(poly: Vec2[], p: Vec2, margin = 0): boolean {
	for (let i = 0; i < poly.length; i++) {
		const a = poly[i] as Vec2;
		const b = poly[(i + 1) % poly.length] as Vec2;
		const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
		if (((b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])) / len < margin) return false;
	}
	return true;
}

/** Every polygon edge linked to a neighbour is the same edge walked the other way by that neighbour. */
function expectConsistent(data: NavMeshData) {
	const key = (p: number, j: number) => {
		const verts = data.polygons[p]?.verts as readonly number[];
		return [verts[j], verts[(j + 1) % verts.length]];
	};
	data.polygons.forEach((poly, p) => {
		poly.neighbors.forEach((n, j) => {
			if (n < 0) return;
			const [a, b] = key(p, j);
			const other = data.polygons[n] as { verts: readonly number[] };
			const k = other.verts.indexOf(b as number);
			expect(k, `polygon ${p} edge ${j}`).toBeGreaterThanOrEqual(0);
			expect(other.verts[(k + 1) % other.verts.length]).toBe(a);
		});
	});
}

/** Points along a path, every 5 cm. */
function samples(path: Vec2[]): Vec2[] {
	const out: Vec2[] = [];
	for (let i = 1; i < path.length; i++) {
		const a = path[i - 1] as Vec2;
		const b = path[i] as Vec2;
		const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 0.05));
		for (let s = 0; s <= n; s++) out.push([a[0] + ((b[0] - a[0]) * s) / n, a[1] + ((b[1] - a[1]) * s) / n]);
	}
	return out;
}

describe("carveObstacles", () => {
	const base = plane(-20, 20, -20, 20);
	const box = rect(-5, 5, -3, 3);
	const carved = NavMesh.fromJSON(carveObstacles(base, [box]));

	test("the obstacle is no longer walkable, the rest still is", () => {
		expect(carved.isWalkable([0, 0])).toBe(false);
		expect(carved.isWalkable([4.9, 2.9])).toBe(false);
		expect(carved.isWalkable([5.2, 0])).toBe(true);
		expect(carved.isWalkable([-15, 15])).toBe(true);
	});

	test("neighbours are consistent and paths go around", () => {
		expectConsistent(carveObstacles(base, [box]));
		const path = carved.findPath([-15, 0], [15, 0]);
		expect(path).not.toBeNull();
		for (const p of samples(path as Vec2[])) expect(inside(box, p, 0.02)).toBe(false);
	});

	test("an obstacle that splits the area disconnects it", () => {
		const wall = NavMesh.fromJSON(carveObstacles(base, [rect(-1, 1, -25, 25)]));
		expect(wall.findPath([-10, 0], [10, 0])).toBeNull();
		expect(wall.findPath([-10, 0], [-10, 10])).not.toBeNull();
	});

	test("random points: walkable after carving exactly when walkable before and outside every obstacle", () => {
		const city = NavMesh.fromJSON(navmeshJson as NavMeshData);
		const obstacles = [
			rect(-2, 2, -12, -10),
			rect(10, 14, -2, 1),
			expand(convexHull(rect(-22, -18, 18, 22)), 0.3),
		];
		const mesh = NavMesh.fromJSON(carveObstacles(navmeshJson as NavMeshData, obstacles));
		let seed = 7;
		const rand = () => {
			seed = (seed * 16807) % 2147483647;
			return seed / 2147483647;
		};
		let checked = 0;
		for (let i = 0; i < 4000; i++) {
			const p: Vec2 = [rand() * 80 - 40, rand() * 80 - 40];
			// skip points within a few centimetres of a border, where tolerances decide
			const near = (q: Vec2) =>
				[
					[0.03, 0],
					[-0.03, 0],
					[0, 0.03],
					[0, -0.03],
				].some(
					([dx, dz]) =>
						city.isWalkable([q[0] + (dx as number), q[1] + (dz as number)]) !== city.isWalkable(q),
				);
			if (near(p) || obstacles.some((o) => inside(o, p, -0.03) && !inside(o, p, 0.03))) continue;
			const expected = city.isWalkable(p) && !obstacles.some((o) => inside(o, p));
			expect(mesh.isWalkable(p), `(${p[0]}, ${p[1]})`).toBe(expected);
			checked++;
		}
		expect(checked).toBeGreaterThan(3000);
	});
});

describe("applyBuilds on the test city", () => {
	const city = landmarksJson as LandmarksData;
	const at = (x: number, z: number, rot = 0): Omit<PlacedModel, "nav"> => ({
		pos: [x, z],
		y: 0,
		rot,
		scale: 1,
	});

	test("a block on the street: every landmark is still reachable, around the block", () => {
		const block: PlacedModel = { nav: boxNav(3, 2, 1), ...at(-10, -14, 30) };
		const data = applyBuilds(navmeshJson as NavMeshData, [block]);
		expectConsistent(data);
		const mesh = NavMesh.fromJSON(data);
		const [footprint] = occupied(block) as [Vec2[]];
		for (const a of city.landmarks)
			for (const b of city.landmarks) {
				const path = mesh.findPath(a.pos, b.pos);
				expect(path, `${a.id} -> ${b.id}`).not.toBeNull();
				for (const p of samples(path as Vec2[])) expect(inside(footprint, p, 0.01)).toBe(false);
			}
		// the agent keeps its radius from the block
		expect(mesh.isWalkable([-10, -14])).toBe(false);
		const [margin] = occupied(block, NAV_MARGIN) as [Vec2[]];
		expect(inside(margin, [-10, -14])).toBe(true);
	});

	test("claimed areas overlap only when the builds do", () => {
		const a: PlacedModel = { nav: boxNav(2, 2, 2), ...at(0, 0) };
		const b: PlacedModel = { nav: boxNav(2, 2, 2), ...at(2, 0) };
		const c: PlacedModel = { nav: boxNav(2, 2, 2), ...at(1.5, 0.5, 45) };
		const [ca] = claimed(a) as [Vec2[]];
		expect(overlaps(ca, (claimed(b) as [Vec2[]])[0], 1e-4)).toBe(false); // touching
		expect(overlaps(ca, (claimed(c) as [Vec2[]])[0], 1e-4)).toBe(true);
	});
});

/**
 * A model people can walk on: a platform 1 m high on [-1, 1] x [-1, 1], a ramp down to the ground on its
 * +Z side ([-1, 1] x [1, 3]), and the ground around both out to 4 m, as Recast would give it.
 */
function platform(): ModelNav {
	const vertices: number[] = [];
	const polygons: { verts: number[]; neighbors: number[] }[] = [];
	const add = (pts: [number, number, number][]) => {
		const base = vertices.length / 3;
		for (const p of pts) vertices.push(...p);
		polygons.push({ verts: pts.map((_, i) => base + i), neighbors: pts.map(() => -1) });
	};
	add([
		[-1, 1, -1],
		[1, 1, -1],
		[1, 1, 1],
		[-1, 1, 1],
	]);
	add([
		[-1, 1, 1],
		[1, 1, 1],
		[1, 0, 3],
		[-1, 0, 3],
	]);
	add([
		[-4, 0, -4],
		[-1, 0, -4],
		[-1, 0, 4],
		[-4, 0, 4],
	]);
	add([
		[1, 0, -4],
		[4, 0, -4],
		[4, 0, 4],
		[1, 0, 4],
	]);
	add([
		[-1, 0, -4],
		[1, 0, -4],
		[1, 0, -1],
		[-1, 0, -1],
	]);
	add([
		[-1, 0, 3],
		[1, 0, 3],
		[1, 0, 4],
		[-1, 0, 4],
	]);
	return {
		version: 1,
		min: [-1, 0, -1],
		max: [1, 1, 3],
		footprint: [rect(-1, 1, -1, 3)],
		walk: { version: 1, vertices, polygons },
	};
}

describe("applyBuilds with a model people can walk on", () => {
	const base = plane(-20, 20, -20, 20);
	const deck: PlacedModel = { nav: platform(), pos: [5, 5], y: 0, rot: 90, scale: 1 };
	const data = applyBuilds(base, [deck]);
	const mesh = NavMesh.fromJSON(data);
	// rot 90: model +Z points to world +X, so the platform centre is at (5, 5) and the ramp foot at (8, 5)

	test("the platform top is walkable and 1 m up, reached by the ramp", () => {
		expectConsistent(data);
		expect(mesh.isWalkable([5, 5])).toBe(true);
		expect(mesh.heightAt([5, 5])).toBeCloseTo(1, 3);
		const path = mesh.findPath([-15, -15], [5, 5]);
		expect(path).not.toBeNull();
		// it climbs the ramp: it passes the ramp's foot side (x > 6)
		expect((path as Vec2[]).some((p) => p[0] > 6)).toBe(true);
	});

	test("the platform's sides are drops, not walkable joins with the ground", () => {
		// from the ground just west of the platform, the way up is around through the ramp
		const path = mesh.findPath([3.5, 5], [5, 5]) as Vec2[];
		expect(path).not.toBeNull();
		expect(path.some((p) => p[0] > 6)).toBe(true);
	});

	test("the ground around the model joins the city along the region's border", () => {
		expect(mesh.findPath([15, 15], [9.5, 5])).not.toBeNull();
		expect(mesh.findPath([-15, -15], [15, 15])).not.toBeNull();
	});

	test("the ground ring is not added where the city is not walkable", () => {
		// the region is x 3..9, z 3..7; the hole covers its east end, beside the ramp
		const holey = carveObstacles(base, [rect(8.2, 12, 0, 3.8)]);
		const withDeck = NavMesh.fromJSON(applyBuilds(holey, [deck]));
		expect(withDeck.isWalkable([8.6, 3.4])).toBe(false);
		expect(withDeck.isWalkable([4, 3.4])).toBe(true);
		expect(withDeck.findPath([-15, -15], [5, 5])).not.toBeNull();
	});
});
