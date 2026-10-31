// Integration tests against the generated navmesh of assets/test-city (pnpm build:city).
// Coordinates are glTF world space: Blender (x, y) becomes (x, -y) on XZ (see tools/city-build/blender/test_city.py).
import { describe, expect, test } from "vitest";
import landmarksJson from "../../../assets/test-city/landmarks.json" with { type: "json" };
import navmeshJson from "../../../assets/test-city/navmesh.base.json" with { type: "json" };
import { type LandmarksData, NavMesh, pathLength, pointAlongPath, type Vec2, validatePath } from "./index.ts";

const mesh = NavMesh.fromJSON(navmeshJson);
const { landmarks, spawn } = landmarksJson as LandmarksData;

/** Axis-aligned footprints on XZ: [minX, minZ, maxX, maxZ]. */
type Rect = [number, number, number, number];
const box = (cx: number, cz: number, sx: number, sz: number): Rect => [
	cx - sx / 2,
	cz - sz / 2,
	cx + sx / 2,
	cz + sz / 2,
];
const buildings: Record<string, Rect> = {
	cafe: box(18, -14, 8, 6),
	station: box(-20, -27, 14, 6),
	library: box(-24, 14, 10, 10),
	block_a: box(26, -32, 10, 8),
	block_b: box(-30, -8, 6, 12),
};
const deck = box(22, 20, 12, 10); // top at 1.2 m
const stairs: Rect = [13.2, 20.5, 16, 23.5]; // west side, 8 steps of 0.15 m
const ramp: Rect = [23, 5.4, 26, 15]; // north side, 1:8
const FOUNTAIN_RADIUS = 3;

const inside = ([x, z]: Vec2, [x0, z0, x1, z1]: Rect, margin = 0) =>
	x > x0 - margin && x < x1 + margin && z > z0 - margin && z < z1 + margin;

/** Points every `step` metres along the path (including the ends). */
function samples(path: Vec2[], step = 0.05): Vec2[] {
	const length = pathLength(path);
	const out: Vec2[] = [];
	for (let d = 0; d < length; d += step) out.push(pointAlongPath(path, d));
	out.push(pointAlongPath(path, length));
	return out;
}

function expectGoodPath(path: Vec2[] | null, from: Vec2, to: Vec2): Vec2[] {
	expect(path).not.toBeNull();
	const p = path as Vec2[];
	expect(p[0]).toEqual(from);
	expect(p[p.length - 1]).toEqual(to);
	expect(validatePath(mesh, p)).toEqual({ ok: true });
	expect(validatePath(mesh, p, { sampleSpacing: 0.05 })).toEqual({ ok: true });
	const blocked = samples(p).filter(
		(s) =>
			Object.values(buildings).some((rect) => inside(s, rect)) || Math.hypot(s[0], s[1]) <= FOUNTAIN_RADIUS,
	);
	expect(blocked).toEqual([]);
	return p;
}

/** Deterministic PRNG (mulberry32). */
function random(seed: number) {
	return () => {
		seed = (seed + 0x6d2b79f5) | 0;
		let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function randomWalkable(rand: () => number): Vec2 {
	for (;;) {
		const p: Vec2 = [rand() * 80 - 40, rand() * 80 - 40];
		if (mesh.isWalkable(p)) return p;
	}
}

describe("test city navmesh", () => {
	test("spawn and every landmark are on the mesh and reachable from the spawn", () => {
		expect(mesh.isWalkable(spawn.pos)).toBe(true);
		expect(landmarks.map((l) => l.id).sort()).toEqual([
			"cafe",
			"deck",
			"fountain",
			"library",
			"park",
			"station",
		]);
		for (const l of landmarks) {
			expect(mesh.isWalkable(l.pos), l.id).toBe(true);
			expectGoodPath(mesh.findPath(spawn.pos, l.pos), spawn.pos, l.pos);
		}
	});

	test("building footprints, the fountain and the area outside the city are not walkable", () => {
		for (const [name, [x0, z0, x1, z1]] of Object.entries(buildings)) {
			for (let x = x0; x <= x1; x += 0.5) {
				for (let z = z0; z <= z1; z += 0.5)
					expect(mesh.isWalkable([x, z]), `${name} at ${x}, ${z}`).toBe(false);
			}
			// Just outside the eroded border (agent radius 0.3 m) is walkable.
			const [cx, cz] = [(x0 + x1) / 2, (z0 + z1) / 2];
			expect(mesh.isWalkable([x0 - 0.6, cz]), name).toBe(true);
			expect(mesh.isWalkable([cx, z1 + 0.6]), name).toBe(true);
		}
		for (let a = 0; a < Math.PI * 2; a += 0.1) {
			expect(mesh.isWalkable([Math.cos(a) * 3, Math.sin(a) * 3])).toBe(false);
			expect(mesh.isWalkable([Math.cos(a) * 4, Math.sin(a) * 4])).toBe(true);
		}
		expect(mesh.isWalkable([0, 0])).toBe(false);
		expect(mesh.isWalkable([45, 0])).toBe(false);
		expect(mesh.isWalkable([0, -39.9])).toBe(false); // eroded edge of the ground plane
		expect(mesh.isWalkable([0, -39])).toBe(true);
	});

	test("goes around the fountain", () => {
		const path = expectGoodPath(mesh.findPath([0, -8], [0, 8]), [0, -8], [0, 8]);
		expect(path.length).toBeGreaterThan(2);
		expect(pathLength(path)).toBeGreaterThan(16);
		expect(pathLength(path)).toBeLessThan(19);
	});

	test("goes around buildings", () => {
		// Across the cafe (south to north side) and across the library (west to east side).
		const cafe = expectGoodPath(mesh.findPath([18, -20], [18, -8]), [18, -20], [18, -8]);
		expect(pathLength(cafe)).toBeGreaterThan(12);
		const library = expectGoodPath(mesh.findPath([-32, 14], [-16, 14]), [-32, 14], [-16, 14]);
		expect(pathLength(library)).toBeGreaterThan(16);
		// The straight segments are rejected.
		expect(
			validatePath(
				mesh,
				[
					[18, -20],
					[18, -8],
				],
				{ sampleSpacing: 0.25 },
			).ok,
		).toBe(false);
	});

	test("goes up onto the deck by the stairs from the west", () => {
		const from: Vec2 = [5, 22];
		const path = expectGoodPath(mesh.findPath(from, [22, 20]), from, [22, 20]);
		const pts = samples(path);
		expect(pts.some((p) => inside(p, stairs))).toBe(true);
		expect(pts.some((p) => inside(p, ramp))).toBe(false);
		expectSmoothClimb(pts);
	});

	test("goes up onto the deck by the ramp from the north", () => {
		const from: Vec2 = [24.5, 0];
		const path = expectGoodPath(mesh.findPath(from, [22, 20]), from, [22, 20]);
		const pts = samples(path);
		expect(pts.some((p) => inside(p, ramp))).toBe(true);
		expect(pts.some((p) => inside(p, stairs))).toBe(false);
		expectSmoothClimb(pts);
	});

	test("cannot climb the deck's sides", () => {
		// Right below the south edge of the deck: the way up is round the corner by the stairs or the ramp.
		const from: Vec2 = [22, 26];
		const path = expectGoodPath(mesh.findPath(from, [22, 23]), from, [22, 23]);
		expect(pathLength(path)).toBeGreaterThan(15);
		const pts = samples(path);
		expect(pts.some((p) => inside(p, stairs) || inside(p, ramp))).toBe(true);
		// Every step between deck and ground goes through the stairs or the ramp.
		for (let i = 1; i < pts.length; i++) {
			const a = pts[i - 1] as Vec2;
			const b = pts[i] as Vec2;
			if (inside(a, deck) !== inside(b, deck)) {
				expect(inside(a, stairs, 0.5) || inside(a, ramp, 0.5)).toBe(true);
			}
		}
	});

	test("heights", () => {
		expect(mesh.heightAt([10, -20])).toBeCloseTo(0, 1);
		expect(mesh.heightAt(spawn.pos)).toBeCloseTo(0, 1);
		expect(mesh.heightAt([22, 20])).toBeCloseTo(1.2, 1);
		expect(mesh.heightAt([24.5, 10.2])).toBeGreaterThan(0.4); // half way up the ramp (0.6 m)
		expect(mesh.heightAt([24.5, 10.2])).toBeLessThan(0.8);
		expect(mesh.heightAt([18, -14])).toBeNull(); // inside the cafe
	});

	test("unreachable or off-mesh end points give null", () => {
		expect(mesh.findPath(spawn.pos, [18, -14])).toBeNull(); // inside the cafe
		expect(mesh.findPath(spawn.pos, [0, 0])).toBeNull(); // in the fountain
		expect(mesh.findPath([-24, 14], spawn.pos)).toBeNull(); // inside the library
		expect(mesh.findPath(spawn.pos, [60, 0])).toBeNull(); // outside the city
		expect(mesh.findPath(spawn.pos, [Number.NaN, 0])).toBeNull();
	});

	test("closestPoint snaps off-mesh points to the nearest walkable point", () => {
		const p = mesh.closestPoint([18, -16.5]); // inside the cafe, 0.5 m from its south wall
		expect(mesh.isWalkable(p)).toBe(true);
		expect(p[1]).toBeCloseTo(-17.35, 1);
		expect(Math.abs(p[0] - 18)).toBeLessThan(0.01);
		expect(mesh.findPath(spawn.pos, p)).not.toBeNull();
		expect(mesh.closestPoint(spawn.pos)).toEqual(spawn.pos);
		const outside = mesh.closestPoint([60, 0]);
		expect(outside[0]).toBeCloseTo(39.5, 1);
		expect(mesh.isWalkable(outside)).toBe(true);
	});

	test("random walkable pairs are always connected and give valid paths", () => {
		const rand = random(12);
		for (let i = 0; i < 300; i++) {
			const a = randomWalkable(rand);
			const b = randomWalkable(rand);
			const path = expectGoodPath(mesh.findPath(a, b), a, b);
			expect(pathLength(path)).toBeGreaterThanOrEqual(Math.hypot(a[0] - b[0], a[1] - b[1]) - 1e-9);
			// Lazy position evaluation on the host stays on the mesh.
			expect(mesh.isWalkable(pointAlongPath(path, rand() * pathLength(path)))).toBe(true);
		}
	});
});

/** The height changes by at most a stair's rise between samples 5 cm apart, and ends on the deck. */
function expectSmoothClimb(pts: Vec2[]) {
	const heights = pts.map((p) => mesh.heightAt(p));
	expect(heights.every((h) => h !== null)).toBe(true);
	for (let i = 1; i < heights.length; i++) {
		expect(Math.abs((heights[i] as number) - (heights[i - 1] as number))).toBeLessThan(0.15);
	}
	expect(heights[heights.length - 1]).toBeCloseTo(1.2, 1);
}
