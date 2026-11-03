import { expect, test } from "vitest";
import { entersPoly, keepingOut, type WalkQueries } from "./keep-out.ts";
import type { Vec2 } from "./vec.ts";

// a corridor along z = 0 from x = 0 to 20, two rooms off it to the south: x 4..8 and x 12..16 (z -6..-1), both
// with a door from the corridor and one onto a yard along z = -8 (straight lines between waypoints)
const ROOM_A: Vec2[] = [
	[4, -6],
	[8, -6],
	[8, -1],
	[4, -1],
];
const ROOM_B: Vec2[] = [
	[12, -6],
	[16, -6],
	[16, -1],
	[12, -1],
];
const open: WalkQueries = {
	isWalkable: () => true,
	validatePath: () => true,
	closestPoint: (p) => p,
	// from the corridor to the yard (or a room) through the room nearer the middle of the way; out of a room
	// into the yard through its yard door
	findPath: (from, to) => {
		const room = (p: Vec2) => (p[1] < -1 && p[1] > -6 ? (p[0] < 10 ? 6 : 14) : null);
		const inFrom = room(from);
		if (inFrom !== null) return [from, [inFrom, -8], to];
		const door = room(to) ?? ((from[0] + to[0]) / 2 < 10 ? 6 : 14);
		return room(to) !== null ? [from, [door, 0], to] : [from, [door, 0], [door, -8], to];
	},
};

test("a path into the room, or through it, enters it", () => {
	expect(
		entersPoly(
			[
				[6, 1],
				[6, -3],
			],
			ROOM_A,
		),
	).toBe(true);
	expect(
		entersPoly(
			[
				[2, -3],
				[10, -3],
			],
			ROOM_A,
		),
	).toBe(true);
	expect(
		entersPoly(
			[
				[2, 1],
				[10, 1],
			],
			ROOM_A,
		),
	).toBe(false);
	// leaving from inside is fine
	expect(
		entersPoly(
			[
				[6, -3],
				[6, 1],
			],
			ROOM_A,
		),
	).toBe(false);
});

test("keeps out of the room, and goes round by the walker's own", () => {
	const man = keepingOut(open, [{ poly: ROOM_A, via: [14, -3] }]);
	expect(man.isWalkable([6, -3])).toBe(false);
	expect(man.isWalkable([14, -3])).toBe(true);
	expect(
		man.validatePath([
			[6, 1],
			[6, -3],
		]),
	).toBe(false);
	const way = man.findPath?.([2, 0], [6, -8]) as Vec2[];
	expect(way).not.toBeNull();
	expect(entersPoly(way, ROOM_A)).toBe(false);
	expect(way.some((p) => p[0] === 14)).toBe(true);
	// asked to go into it, the closest one gets is just outside
	expect(man.isWalkable(man.closestPoint([6, -3]))).toBe(true);
	// nobody to keep out: the same queries
	expect(keepingOut(open, [])).toBe(open);
});
