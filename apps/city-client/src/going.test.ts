import { RUN_SPEED, type Vec2, WALK_SPEED } from "@rojibura/protocol";
import { expect, test, vi } from "vitest";
import { Going } from "./going.ts";

function setup() {
	let pose = { pos: [0, 0] as Vec2, moving: false };
	const walk = vi.fn(() => true);
	const toast = vi.fn();
	const route = new Going(() => pose, walk, toast);
	route.current = {
		to: [20, 0],
		name: "公園",
		gate: false,
		run: false,
		until: 10000,
		plannedAt: 0,
		from: null,
	};
	return {
		route,
		walk,
		toast,
		setPose: (pos: Vec2, moving = false) => {
			pose = { pos, moving };
		},
	};
}

test("plans a walking leg and stops at the destination", () => {
	const { route, walk, toast, setPose } = setup();
	route.step(1000);
	expect(walk).toHaveBeenCalledWith([20, 0], WALK_SPEED);
	setPose([18, 0]);
	route.step(2000);
	expect(route.current).toBeNull();
	expect(toast).toHaveBeenCalledWith("公園に着きました");
});

test("waits during a leg, then stops if it did not move", () => {
	const { route, walk, toast, setPose } = setup();
	route.step(1000);
	setPose([0, 0], true);
	route.step(2000);
	expect(walk).toHaveBeenCalledTimes(1);
	setPose([0, 0]);
	route.step(3000);
	expect(route.current).toBeNull();
	expect(toast).toHaveBeenCalledWith("そこへは行けません");
});

test("replans from a new position, runs for a distant gate, and expires", () => {
	const { route, walk, setPose } = setup();
	if (!route.current) throw new Error("missing route");
	route.current.gate = true;
	route.current.run = true;
	route.step(1000);
	expect(walk).toHaveBeenCalledWith([20, 0], RUN_SPEED);
	setPose([5, 0]);
	route.step(2000);
	expect(walk).toHaveBeenCalledTimes(2);
	route.step(10001);
	expect(route.current).toBeNull();
});

test("stops when no path is found", () => {
	const { route, walk, toast } = setup();
	walk.mockReturnValue(false);
	route.step(1000);
	expect(route.current).toBeNull();
	expect(toast).toHaveBeenCalledWith("そこへは行けません");
});

test("does nothing after cancellation or when the avatar is unavailable", () => {
	const { route, walk } = setup();
	route.current = null;
	route.step(1000);
	expect(walk).not.toHaveBeenCalled();
	const absent = new Going(() => undefined, walk, vi.fn());
	absent.current = {
		to: [20, 0],
		name: "公園",
		gate: false,
		run: false,
		until: 10000,
		plannedAt: 0,
		from: null,
	};
	absent.step(1000);
	expect(absent.current).toBeNull();
});
