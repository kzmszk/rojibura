import { describe, expect, test } from "vitest";
import navmeshJson from "../../../assets/test-city/navmesh.json" with { type: "json" };
import { NavMesh, type Vec2, validatePath } from "./index.ts";

const mesh = NavMesh.fromJSON(navmeshJson);
const spawn: Vec2 = [0, -8];

describe("validatePath (docs/prd.md 3.2.3)", () => {
	test("accepts paths from findPath", () => {
		const path = mesh.findPath(spawn, [22, 20]) as Vec2[];
		expect(validatePath(mesh, path)).toEqual({ ok: true });
		expect(
			validatePath(mesh, path, {
				maxPoints: 24,
				maxLength: 200,
				start: { pos: [0.5, -8.5], maxDistance: 2 },
			}),
		).toEqual({ ok: true });
		expect(validatePath(mesh, [spawn])).toEqual({ ok: true });
	});

	test("rejects vertices off the mesh", () => {
		expect(
			validatePath(mesh, [
				spawn,
				[10, -14],
				[18, -14], // inside the cafe
			]),
		).toEqual({ ok: false, problem: "not_walkable", index: 2 });
		expect(validatePath(mesh, [[0, 0]])).toEqual({ ok: false, problem: "not_walkable", index: 0 });
	});

	test("rejects segments whose midpoint is off the mesh", () => {
		expect(
			validatePath(mesh, [
				[-5, 2],
				[-5, -2],
				[5, -2], // midpoint (0, -2) is in the fountain
			]),
		).toEqual({ ok: false, problem: "not_walkable", index: 1 });
	});

	test("sampleSpacing catches segments that cut across an obstacle away from their midpoint", () => {
		const path: Vec2[] = [
			[-5, 0],
			[15, 0], // crosses the fountain, but the midpoint (5, 0) is walkable
		];
		expect(validatePath(mesh, path)).toEqual({ ok: true });
		expect(validatePath(mesh, path, { sampleSpacing: 0.5 })).toEqual({
			ok: false,
			problem: "not_walkable",
			index: 0,
		});
	});

	test("limits", () => {
		const many = Array.from({ length: 25 }, (_, i): Vec2 => [i * 0.1, -8]);
		expect(validatePath(mesh, many, { maxPoints: 24 })).toEqual({ ok: false, problem: "too_many_points" });
		expect(validatePath(mesh, many.slice(0, 24), { maxPoints: 24 })).toEqual({ ok: true });
		const long: Vec2[] = [
			[-35, -35],
			[35, -35],
			[35, 35],
			[-35, 35],
		];
		expect(validatePath(mesh, long, { maxLength: 200 })).toEqual({ ok: false, problem: "too_long" });
		expect(validatePath(mesh, long, { maxLength: 210 })).toEqual({ ok: true });
		expect(validatePath(mesh, [spawn, [5, -8]], { start: { pos: [3, -8], maxDistance: 2 } })).toEqual({
			ok: false,
			problem: "bad_start",
			index: 0,
		});
		expect(validatePath(mesh, [spawn, [5, -8]], { start: { pos: [1.5, -8], maxDistance: 2 } })).toEqual({
			ok: true,
		});
	});

	test("rejects malformed input", () => {
		const check = (path: unknown) => validatePath(mesh, path as Vec2[]);
		expect(check([])).toEqual({ ok: false, problem: "empty" });
		expect(check("path")).toEqual({ ok: false, problem: "malformed" });
		expect(check(null)).toEqual({ ok: false, problem: "malformed" });
		expect(check([spawn, [1]])).toEqual({ ok: false, problem: "malformed", index: 1 });
		expect(check([spawn, [1, 2, 3]])).toEqual({ ok: false, problem: "malformed", index: 1 });
		expect(check([[Number.NaN, 0]])).toEqual({ ok: false, problem: "malformed", index: 0 });
		expect(check([["1", 0]])).toEqual({ ok: false, problem: "malformed", index: 0 });
		expect(check([[1e308, 1e308], spawn])).toEqual({ ok: false, problem: "not_walkable", index: 0 });
	});
});
