import { COMPANY_GAP, dist, type MoveState, type Vec2 } from "@rojibura/protocol";
import { describe, expect, test } from "vitest";
import {
	assignPlaces,
	joinPoint,
	type Place,
	placeAt,
	placesFor,
	placesToTry,
	roomOnTheWay,
} from "./company-formation.ts";

const ahead: Vec2 = [0, 1];
const standing = (pos: Vec2): MoveState => ({ kind: "idle", pos, at: 0 });

describe("the places round an owner", () => {
	test.each(["walking", "standing"] as const)("however many AIs, %s, nobody shares a place", (gait) => {
		const spots = placesFor(5, gait).map((p) => placeAt([0, 0], ahead, p));
		for (const [i, a] of spots.entries()) {
			expect(dist(a, [0, 0])).toBeGreaterThanOrEqual(COMPANY_GAP);
			// none of them straight ahead or behind
			expect(Math.abs(a[0])).toBeGreaterThan(0.5);
			for (const b of spots.slice(i + 1)) expect(dist(a, b)).toBeGreaterThanOrEqual(COMPANY_GAP);
		}
	});

	test("the first is to the right, the next to the left (facing +z, the right hand is on -x)", () => {
		const [right, left] = placesFor(2, "walking").map((p) => placeAt([0, 0], ahead, p));
		expect(right?.[0]).toBeCloseTo(-0.9);
		expect(left?.[0]).toBeCloseTo(0.9);
	});
});

describe("who goes where", () => {
	const two = placesFor(2, "walking");

	test("an AI keeps to the side it is on, whichever came first", () => {
		const onLeft: Vec2 = [1, 0];
		const onRight: Vec2 = [-1, 0];
		const places = assignPlaces([onLeft, onRight], [0, 0], ahead, two);
		expect(places[0]?.side).toBe(-1);
		expect(places[1]?.side).toBe(1);
	});

	test("the owner turning round does not send it across to the other side", () => {
		const onRight: Vec2 = [-0.9, 0.3];
		const [place] = assignPlaces([onRight], [0, 0], [0, -1], placesFor(1, "walking").concat(two[1] as Place));
		// walking towards -z, the side it is on (-x) is now their left
		expect(place?.side).toBe(-1);
	});

	test("two on one side: each still gets a place of its own", () => {
		const places = assignPlaces(
			[
				[-1, 0],
				[-1.2, 0],
			],
			[0, 0],
			ahead,
			two,
		);
		expect(new Set(places.map((p) => p.side)).size).toBe(2);
	});
});

describe("when the place itself cannot be", () => {
	test("narrower first, then the other side, then behind or ahead; in line with the owner only last", () => {
		const place = placesFor(1, "walking")[0] as Place;
		const tries = placesToTry(place);
		expect(tries[0]).toEqual(place);
		expect(tries[1]?.aside).toBeLessThan(place.aside);
		expect(tries[2]?.side).toBe(-place.side);
		const inLine = tries.filter((p) => p.aside === 0);
		expect(tries.slice(-inLine.length)).toEqual(inLine);
		// (never where the owner is, and first of all behind them, out to the side as far as the way allows)
		for (const p of inLine) expect(Math.abs(p.front)).toBeGreaterThan(COMPANY_GAP);
		expect(inLine[0]?.front).toBeLessThan(0);
		const behind = tries.find((p) => p.front < -COMPANY_GAP);
		expect(behind?.aside).toBe(place.aside);
	});
});

describe("getting out to its side", () => {
	const place: Place = { front: 0.3, aside: 0.9, side: 1 };

	test("from straight ahead of the owner it is out there within a couple of metres, not at the end of the way", () => {
		const join = joinPoint([0, 1], [0, 0], ahead, 30, place) as Vec2;
		expect(join[0]).toBeCloseTo(-0.9);
		expect(join[1]).toBeCloseTo(2.5);
	});

	test("already out there, or the leg ends first: no such point", () => {
		expect(joinPoint([-0.9, 0.3], [0, 0], ahead, 30, place)).toBeNull();
		expect(joinPoint([0, 1], [0, 0], ahead, 2, place)).toBeNull();
	});
});

describe("looking over a way", () => {
	test("a walk through someone standing there has no room; one round them has", () => {
		const owner = standing([0, 0]);
		const through: Vec2[] = [
			[0, -2],
			[0, 2],
		];
		const round: Vec2[] = [
			[-1, -2],
			[-1, 2],
		];
		expect(roomOnTheWay(through, 1.4, 0, [owner])).toBeLessThan(COMPANY_GAP);
		expect(roomOnTheWay(round, 1.4, 0, [owner])).toBeCloseTo(1, 1);
	});

	test("it goes by the time: crossing where someone was a while ago is fine", () => {
		const walker: MoveState = {
			kind: "path",
			path: [
				[0, 0],
				[0, 100],
			],
			speed: 10,
			at: 0,
		};
		const cross: Vec2[] = [
			[-3, 0],
			[3, 0],
		];
		// (the walker is far on by the time it gets to where they started, but starts right next to it)
		expect(roomOnTheWay(cross, 1.4, 0, [walker])).toBeGreaterThan(COMPANY_GAP);
	});

	test("starting too close, what counts is getting away", () => {
		const owner = standing([0, 0]);
		const away: Vec2[] = [
			[0.1, 0],
			[3, 0],
		];
		expect(roomOnTheWay(away, 1.4, 0, [owner])).toBeGreaterThan(COMPANY_GAP);
	});
});
