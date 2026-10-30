import { expect, test } from "vitest";
import { distance, pathLength, pointAlongPath, type Vec2 } from "./index.ts";

test("distance", () => {
	expect(distance([0, 0], [3, 4])).toBe(5);
});

test("pathLength", () => {
	expect(pathLength([])).toBe(0);
	expect(pathLength([[1, 1]])).toBe(0);
	expect(
		pathLength([
			[0, 0],
			[3, 4],
			[3, 10],
		]),
	).toBe(11);
});

test("pointAlongPath walks the segments and clamps to the ends", () => {
	const path: Vec2[] = [
		[0, 0],
		[10, 0],
		[10, 5],
	];
	expect(pointAlongPath(path, 0)).toEqual([0, 0]);
	expect(pointAlongPath(path, 4)).toEqual([4, 0]);
	expect(pointAlongPath(path, 10)).toEqual([10, 0]);
	expect(pointAlongPath(path, 12.5)).toEqual([10, 2.5]);
	expect(pointAlongPath(path, 15)).toEqual([10, 5]);
	expect(pointAlongPath(path, 1000)).toEqual([10, 5]);
	expect(pointAlongPath(path, -3)).toEqual([0, 0]);
	expect(pointAlongPath(path, Number.NaN)).toEqual([0, 0]);
});

test("pointAlongPath handles degenerate paths", () => {
	expect(pointAlongPath([[2, 3]], 5)).toEqual([2, 3]);
	expect(
		pointAlongPath(
			[
				[1, 1],
				[1, 1],
				[1, 3],
			],
			1,
		),
	).toEqual([1, 2]);
	expect(() => pointAlongPath([], 1)).toThrow();
});

test("pointAlongPath returns a copy", () => {
	const path: Vec2[] = [
		[0, 0],
		[1, 0],
	];
	const p = pointAlongPath(path, 0);
	p[0] = 99;
	expect(path[0]).toEqual([0, 0]);
});
