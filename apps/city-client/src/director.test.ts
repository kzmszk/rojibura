import type { Vec2 } from "@rojibura/protocol";
import { describe, expect, it } from "vitest";
import {
	Director,
	HIDDEN_CUT_MS,
	type Looks,
	MIN_HOLD_MS,
	placeShot,
	type Shot,
	type Subjects,
} from "./director.ts";

const walking = (over: Partial<Subjects> = {}): Subjects => ({
	center: [0, 0],
	dir: [0, 1],
	spread: 1,
	moving: true,
	talking: false,
	leading: false,
	aspect: 16 / 9,
	reach: null,
	...over,
});

const clear: Looks = { open: () => true, seen: () => 1 };

/** Runs the director at 4 Hz, returning the cuts: when, and to what. */
function run(
	director: Director,
	from: number,
	ms: number,
	s: (t: number) => Subjects,
	looks: Looks = clear,
): { at: number; shot: Shot }[] {
	const cuts: { at: number; shot: Shot }[] = [];
	for (let t = from; t < from + ms; t += 250) {
		const r = director.step(t, s(t), looks);
		if (r.cut) cuts.push({ at: t, shot: r.shot });
	}
	return cuts;
}

describe("placeShot", () => {
	it("puts the camera at the shot's angle and distance, on its side", () => {
		const right = placeShot("side", 1, walking());
		const left = placeShot("side", -1, walking());
		expect(Math.hypot(...right.offset)).toBeCloseTo(9);
		expect(left.offset[0]).toBeCloseTo(-right.offset[0]);
		expect(left.offset[1]).toBeCloseTo(right.offset[1]);
		// the front shot is ahead of them, the back shot behind
		expect(placeShot("front", 1, walking()).offset[1]).toBeGreaterThan(0);
		expect(placeShot("back", 1, walking()).offset[1]).toBeLessThan(0);
	});

	it("never films the two walking side by side from straight beside them, one hiding the other", () => {
		const walk = walking();
		for (const kind of ["front", "side", "back", "wide", "frontAxis", "backAxis", "two"] as const) {
			const [x, z] = placeShot(kind, 1, walk).offset;
			// how much of the line between them (across the way they walk) shows, seen from the camera
			const across = Math.abs(z) / Math.hypot(x, z);
			expect(across).toBeGreaterThan(0.4);
		}
	});

	it("draws back so that two far apart both fit", () => {
		const close = placeShot("two", 1, walking({ spread: 1 }));
		const apart = placeShot("two", 1, walking({ spread: 8 }));
		expect(Math.hypot(...close.offset)).toBeCloseTo(5);
		expect(Math.hypot(...apart.offset)).toBeGreaterThan(5);
	});

	it("stays within the area's reach and widens the lens instead", () => {
		const shot = placeShot("wide", 1, walking({ reach: 6 }));
		expect(Math.hypot(...shot.offset)).toBeCloseTo(6);
		expect(shot.fov).toBeGreaterThan(28);
		expect(shot.fov).toBeLessThanOrEqual(50);
	});
});

describe("Director", () => {
	it("begins with the shot most wanted", () => {
		const r = new Director().step(0, walking(), clear);
		expect(r.cut).toBe(true);
		expect(r.shot.kind).toBe("front");
	});

	it("holds a shot for the least time even when another is better", () => {
		const d = new Director();
		d.step(0, walking(), clear);
		const cuts = run(d, 250, 8_000, () => walking({ moving: false, talking: true }));
		expect(cuts[0]?.at).toBeGreaterThanOrEqual(MIN_HOLD_MS);
		expect(cuts[0]?.shot.kind).toBe("two");
	});

	it("does not take the shot of two while they walk", () => {
		const cuts = run(new Director(), 0, 120_000, () => walking());
		expect(cuts.some((c) => c.shot.kind === "two")).toBe(false);
	});

	it("walking on, it changes shots now and then, not often, and stays on one side", () => {
		const cuts = run(new Director(), 0, 120_000, (t) => walking({ center: [0, (t / 1000) * 1.4] }));
		expect(cuts.length).toBeGreaterThan(4);
		for (let i = 1; i < cuts.length; i++) {
			const a = cuts[i - 1];
			const b = cuts[i];
			if (!a || !b) continue;
			expect(b.at - a.at).toBeGreaterThanOrEqual(8_000);
			expect(b.at - a.at).toBeLessThanOrEqual(30_000);
			expect(b.shot.side).toBe(a.shot.side);
			expect(b.shot.kind).not.toBe(a.shot.kind);
		}
	});

	it("keeps a shot while they stand", () => {
		const d = new Director();
		const cuts = run(d, 0, 60_000, () => walking({ moving: false }));
		expect(cuts).toHaveLength(1);
	});

	it("takes the way behind them while following the AI to a place", () => {
		expect(new Director().step(0, walking({ leading: true }), clear).shot.kind).toBe("back");
	});

	it("cuts when they turn, and the new shot goes by the new way", () => {
		const d = new Director();
		const turned: Vec2 = [1, 0];
		d.step(0, walking(), clear);
		const cuts = run(d, MIN_HOLD_MS, 1_000, () => walking({ dir: turned }));
		expect(cuts).toHaveLength(1);
		expect(cuts[0]?.shot.dir).toEqual(turned);
	});

	it("crosses to the other side only when nothing can be seen from this one", () => {
		const d = new Director();
		const first = d.step(0, walking(), clear).shot;
		// a wall all along this side
		const sideOf = (shot: Shot) => Math.sign(shot.offset[0]);
		const wall = sideOf(first);
		const blocked: Looks = {
			open: (shot) => sideOf(shot) !== wall,
			seen: (shot) => (sideOf(shot) === wall ? 0 : 1),
		};
		const cuts = run(d, MIN_HOLD_MS, 1_000, () => walking(), blocked);
		expect(cuts).toHaveLength(1);
		expect(cuts[0]?.shot.side).toBe(-first.side);
	});

	it("cuts at once when neither of them can be seen for a moment", () => {
		const d = new Director();
		const first = d.step(0, walking(), clear).shot;
		const hidden: Looks = { open: () => true, seen: (shot) => (shot === first ? 0 : 1) };
		const cuts = run(d, 250, 2_000, () => walking(), hidden);
		expect(cuts[0]?.at).toBeLessThanOrEqual(250 + HIDDEN_CUT_MS + 250);
		expect(cuts[0]?.at).toBeLessThan(MIN_HOLD_MS);
	});

	it("does not cut to a shot found to be hidden, and tries the next", () => {
		const d = new Director();
		d.step(0, walking(), clear);
		const looks: Looks = { open: () => true, seen: (shot) => (shot.kind === "side" ? 0 : 1) };
		// the shot now, once it has gone on a while, gives way; not to the side shot that would be next
		const cuts = run(d, 250, 30_000, () => walking(), looks);
		expect(cuts.length).toBeGreaterThan(0);
		expect(cuts.every((c) => c.shot.kind !== "side")).toBe(true);
	});

	it("falls back to just behind them when nothing can be seen", () => {
		const nothing: Looks = { open: () => false, seen: () => 0 };
		const r = new Director().step(0, walking(), nothing);
		expect(r.cut).toBe(true);
		expect(r.shot.kind).toBe("near");
	});

	it("a camera left in place stays where it was put, and looks at where they were or follows them", () => {
		const walk = walking({ center: [10, 20] });
		const ahead = placeShot("ahead", 1, walk);
		expect(ahead.fixed?.track).toBe(false);
		expect(ahead.fixed?.at[0]).toBeCloseTo(10 + ahead.offset[0]);
		expect(ahead.fixed?.at[1]).toBeCloseTo(20 + ahead.offset[1]);
		expect(ahead.fixed?.aim).toEqual([10, 20]);
		expect(ahead.offset[1]).toBeGreaterThan(10);
		const away = placeShot("away", 1, walk);
		expect(away.offset[1]).toBeLessThan(0);
		expect(placeShot("pan", 1, walk).fixed?.track).toBe(true);
		expect(placeShot("front", 1, walk).fixed).toBeNull();
	});

	it("films them past a camera that stays, and cuts before they are on top of it or out of sight", () => {
		const d = new Director();
		const at = (t: number): Subjects => walking({ center: [0, (t / 1000) * 1.4] });
		const cuts = run(d, 0, 400_000, at);
		const held = cuts.filter((c) => c.shot.fixed);
		expect(held.length).toBeGreaterThan(2);
		for (const c of held) {
			const next = cuts[cuts.indexOf(c) + 1];
			expect(next).toBeDefined();
			const there = at(next?.at ?? 0).center;
			const at0 = c.shot.fixed?.at ?? [0, 0];
			const away = Math.hypot(there[0] - at0[0], there[1] - at0[1]);
			expect(away).toBeLessThan(27);
			if (c.shot.kind === "ahead") expect(away).toBeGreaterThan(2.5);
		}
	});

	it("does not take a camera left in place where the camera may not be far from them", () => {
		const cuts = run(new Director(), 0, 200_000, () => walking({ reach: 6 }));
		expect(cuts.some((c) => c.shot.fixed)).toBe(false);
	});

	it("cuts at once, not after the shot's least time, when the camera gets into a wall", () => {
		const d = new Director();
		const first = d.step(0, walking(), clear).shot;
		const walled: Looks = { open: (shot) => shot !== first, seen: () => 1 };
		const r = d.step(250, walking(), walled);
		expect(r.cut).toBe(true);
		expect(r.shot).not.toBe(first);
	});

	it("never takes a shot whose camera would be in a wall, however good it is", () => {
		const shut = (kind: string): Looks => ({ open: (shot) => shot.kind !== kind, seen: () => 1 });
		for (const kind of ["front", "side", "pan", "ahead", "back"]) {
			const cuts = run(
				new Director(),
				0,
				120_000,
				(t) => walking({ center: [0, (t / 1000) * 1.4] }),
				shut(kind),
			);
			expect(cuts.some((c) => c.shot.kind === kind)).toBe(false);
		}
	});

	it("reset makes the next step cut", () => {
		const d = new Director();
		d.step(0, walking(), clear);
		d.reset();
		expect(d.step(250, walking(), clear).cut).toBe(true);
	});
});
