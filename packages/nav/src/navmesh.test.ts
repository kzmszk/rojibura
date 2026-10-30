import { describe, expect, test } from "vitest";
import { NavMesh, type NavMeshData, pathLength, type Vec2 } from "./index.ts";

/**
 * A navmesh of unit squares from an ASCII map: "." is walkable, anything else is a wall.
 * Column = x, row = z. `reverse` winds the polygons the other way; `height` sets each vertex's y.
 */
function gridMesh(
	rows: string[],
	opts: { reverse?: boolean; height?: (x: number, z: number) => number } = {},
) {
	const width = Math.max(...rows.map((r) => r.length));
	const vertices: number[] = [];
	for (let z = 0; z <= rows.length; z++) {
		for (let x = 0; x <= width; x++) vertices.push(x, opts.height?.(x, z) ?? 0, z);
	}
	const vertex = (x: number, z: number) => z * (width + 1) + x;
	const ids = new Map<string, number>();
	rows.forEach((row, z) => {
		[...row].forEach((ch, x) => {
			if (ch === ".") ids.set(`${x},${z}`, ids.size);
		});
	});
	const polygons: NavMeshData["polygons"][number][] = [];
	for (const [key] of ids) {
		const [x, z] = key.split(",").map(Number) as [number, number];
		const at = (cx: number, cz: number) => ids.get(`${cx},${cz}`) ?? -1;
		// Counter-clockwise in (x, z); neighbors[j] is across verts[j] -> verts[j + 1].
		const verts = [vertex(x, z), vertex(x + 1, z), vertex(x + 1, z + 1), vertex(x, z + 1)];
		const neighbors = [at(x, z - 1), at(x + 1, z), at(x, z + 1), at(x - 1, z)];
		if (opts.reverse) {
			polygons.push({
				verts: [...verts].reverse(),
				neighbors: [neighbors[2], neighbors[1], neighbors[0], neighbors[3]] as number[],
			});
		} else polygons.push({ verts, neighbors });
	}
	return { version: 1, vertices, polygons } satisfies NavMeshData;
}

function expectPath(actual: Vec2[] | null, expected: Vec2[]) {
	expect(actual).not.toBeNull();
	expect(actual?.length).toBe(expected.length);
	actual?.forEach((p, i) => {
		expect(p[0]).toBeCloseTo((expected[i] as Vec2)[0], 9);
		expect(p[1]).toBeCloseTo((expected[i] as Vec2)[1], 9);
	});
}

describe("findPath on a grid", () => {
	// A wall from x = 0 to 2 on the middle row: going from the top-left to the bottom-left means
	// walking around its right end, touching both of its corners.
	const rows = ["....", "##..", "...."];

	for (const reverse of [false, true]) {
		test(`goes around a wall (${reverse ? "clockwise" : "counter-clockwise"} polygons)`, () => {
			const mesh = NavMesh.fromJSON(gridMesh(rows, { reverse }));
			expectPath(mesh.findPath([0.5, 0.5], [0.5, 2.5]), [
				[0.5, 0.5],
				[2, 1],
				[2, 2],
				[0.5, 2.5],
			]);
			expectPath(mesh.findPath([0.5, 2.5], [0.5, 0.5]), [
				[0.5, 2.5],
				[2, 2],
				[2, 1],
				[0.5, 0.5],
			]);
		});
	}

	test("is a straight line when nothing is in the way", () => {
		const mesh = NavMesh.fromJSON(gridMesh(rows));
		expectPath(mesh.findPath([0.2, 0.3], [3.8, 0.7]), [
			[0.2, 0.3],
			[3.8, 0.7],
		]);
		expectPath(mesh.findPath([2.5, 0.5], [3.5, 2.5]), [
			[2.5, 0.5],
			[3.5, 2.5],
		]);
	});

	test("takes the shorter way around an obstacle", () => {
		// A pillar in the middle of an open area; start and goal are on either side, slightly to the right.
		const mesh = NavMesh.fromJSON(gridMesh([".....", ".....", "..#..", ".....", "....."]));
		const path = mesh.findPath([2.8, 0.5], [2.8, 4.5]);
		expectPath(path, [
			[2.8, 0.5],
			[3, 2],
			[3, 3],
			[2.8, 4.5],
		]);
	});

	test("within one polygon returns the two points", () => {
		const mesh = NavMesh.fromJSON(gridMesh(rows));
		expect(mesh.findPath([0.2, 0.2], [0.8, 0.9])).toEqual([
			[0.2, 0.2],
			[0.8, 0.9],
		]);
	});

	test("follows a winding corridor", () => {
		const mesh = NavMesh.fromJSON(gridMesh(["....#", "###.#", "....#", ".####", "....."]));
		const path = mesh.findPath([0.5, 0.5], [4.5, 4.5]);
		expectPath(path, [
			[0.5, 0.5],
			[3, 1],
			[3, 2],
			[1, 3],
			[1, 4],
			[4.5, 4.5],
		]);
		expect(pathLength(path ?? [])).toBeGreaterThan(8);
	});

	test("is null between disconnected areas and for points off the mesh", () => {
		const mesh = NavMesh.fromJSON(gridMesh(["..#.."]));
		expect(mesh.findPath([0.5, 0.5], [4.5, 0.5])).toBeNull();
		expect(mesh.findPath([0.5, 0.5], [2.5, 0.5])).toBeNull(); // goal in the wall
		expect(mesh.findPath([2.5, 0.5], [0.5, 0.5])).toBeNull(); // start in the wall
		expect(mesh.findPath([0.5, 0.5], [0.5, 5])).toBeNull(); // outside the mesh
		expect(mesh.findPath([0.5, 0.5], [Number.NaN, 0.5])).toBeNull();
		expect(mesh.findPath([0.5, 0.5], [1.5, 0.5])).not.toBeNull();
	});

	test("can be queried many times (scratch buffers are reset)", () => {
		const mesh = NavMesh.fromJSON(gridMesh(rows));
		for (let i = 0; i < 100; i++) {
			expect(mesh.findPath([0.5, 0.5], [0.5, 2.5])?.length).toBe(4);
			expect(mesh.findPath([3.5, 2.5], [0.5, 0.5])?.length).toBe(4);
		}
	});
});

describe("point queries", () => {
	test("isWalkable, with a 1 cm tolerance at the border", () => {
		const mesh = NavMesh.fromJSON(gridMesh(["..#.."]));
		expect(mesh.polygonCount).toBe(4);
		expect(mesh.isWalkable([0.5, 0.5])).toBe(true);
		expect(mesh.isWalkable([1, 0.5])).toBe(true); // shared edge
		expect(mesh.isWalkable([0, 0])).toBe(true); // corner
		expect(mesh.isWalkable([2.5, 0.5])).toBe(false);
		expect(mesh.isWalkable([-0.005, 0.5])).toBe(true);
		expect(mesh.isWalkable([-0.02, 0.5])).toBe(false);
		expect(mesh.isWalkable([2.005, 0.5])).toBe(true);
		expect(mesh.isWalkable([2.02, 0.5])).toBe(false);
		expect(mesh.isWalkable([100, 100])).toBe(false);
		expect(mesh.isWalkable([Number.NaN, 0])).toBe(false);
		expect(mesh.isWalkable([Number.POSITIVE_INFINITY, 0])).toBe(false);
		const strict = NavMesh.fromJSON(gridMesh(["..#.."]), { tolerance: 0 });
		expect(strict.isWalkable([-0.005, 0.5])).toBe(false);
		expect(strict.isWalkable([0, 0.5])).toBe(true);
	});

	test("closestPoint", () => {
		const mesh = NavMesh.fromJSON(gridMesh(["..#.."]));
		expect(mesh.closestPoint([0.3, 0.4])).toEqual([0.3, 0.4]);
		expect(mesh.closestPoint([-1, 0.5])).toEqual([0, 0.5]);
		expect(mesh.closestPoint([2.4, 0.5])).toEqual([2, 0.5]);
		expect(mesh.closestPoint([2.6, 0.5])).toEqual([3, 0.5]);
		expect(mesh.closestPoint([7, 3])).toEqual([5, 1]);
		for (const p of [
			[-3, -2],
			[2.5, 0.1],
			[9, 0.5],
			[1.5, 7],
		] as Vec2[]) {
			expect(mesh.isWalkable(mesh.closestPoint(p))).toBe(true);
		}
		expect(() => mesh.closestPoint([Number.NaN, 0])).toThrow(RangeError);
	});

	test("heightAt interpolates the polygon's vertices", () => {
		const mesh = NavMesh.fromJSON(gridMesh(["...", "..."], { height: (x, z) => x * 0.5 + z * 0.1 }));
		expect(mesh.heightAt([0, 0])).toBeCloseTo(0, 9);
		expect(mesh.heightAt([1.5, 0.5])).toBeCloseTo(0.8, 9);
		expect(mesh.heightAt([2.25, 1.75])).toBeCloseTo(1.3, 9);
		expect(mesh.heightAt([3.5, 0.5])).toBeNull();
	});
});

describe("fromJSON", () => {
	const good = gridMesh([".."]);

	test("rejects malformed data", () => {
		expect(() => NavMesh.fromJSON({ ...good, version: 2 })).toThrow(/version/);
		expect(() => NavMesh.fromJSON({ ...good, polygons: [] })).toThrow(/no polygons/);
		expect(() => NavMesh.fromJSON({ ...good, vertices: [0, 0] })).toThrow(/vertices/);
		expect(() =>
			NavMesh.fromJSON({ ...good, vertices: good.vertices.map((v, i) => (i === 4 ? Number.NaN : v)) }),
		).toThrow(/finite/);
		const bad = (poly: { verts: number[]; neighbors: number[] }) =>
			NavMesh.fromJSON({ ...good, polygons: [poly, good.polygons[1] as (typeof good.polygons)[number]] });
		expect(() => bad({ verts: [0, 1], neighbors: [-1, -1] })).toThrow(/malformed/);
		expect(() => bad({ verts: [0, 1, 99], neighbors: [-1, -1, -1] })).toThrow(/vertex index/);
		expect(() => bad({ verts: [0, 1, 4], neighbors: [-1, 5, -1] })).toThrow(/neighbor index/);
		expect(() => bad({ verts: [0, 1, 4], neighbors: [-1, 0, -1] })).toThrow(/neighbor index/);
		expect(() => bad({ verts: [0, 1, 4], neighbors: [-1, -1] })).toThrow(/malformed/);
	});
});
