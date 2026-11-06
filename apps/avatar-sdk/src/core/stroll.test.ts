import type { AvatarState, ClientToHost, Vec2 } from "@rojibura/protocol";
import { COMPANION_FREE, dist } from "@rojibura/protocol";
import { describe, expect, test } from "vitest";
import { Stroll } from "./stroll.ts";
import { World } from "./world.ts";

const avatar = (id: string, kind: "ai" | "human", pos: Vec2, at: number): AvatarState => ({
	id,
	kind,
	name: id,
	status: "active",
	assets: { thumb: "", lod: "", vrm: "" },
	move: { kind: "idle", pos, at },
});

function setup(ownerAt: number, busy = false, others: AvatarState[] = []) {
	const world = new World();
	const now = Date.now();
	world.apply({
		t: "WELCOME",
		you: "a_mina",
		serverTime: now,
		budget: 0,
		avatars: [
			avatar("a_mina", "ai", [0.8, 0], now - 60_000),
			avatar("h_k", "human", [0, 0], now - ownerAt),
			...others,
		],
	});
	world.apply({ t: "COMPANY", owner: "h_k", on: true });
	const sent: ClientToHost[] = [];
	let seq = 0;
	const stroll = new Stroll({
		world,
		nav: () => ({ findPath: (a, b) => [a, b] }),
		send: (m) => sent.push(m),
		seq: () => ++seq,
		busy: () => busy,
		random: () => 0.9,
	});
	return { stroll, sent };
}

describe("standing about with its owner (docs/prd.md 3.4.9)", () => {
	test("a step to a spot close by, on its side of the owner", () => {
		const { stroll } = setup(10_000);
		const way = stroll.way();
		expect(way).not.toBeNull();
		const end = way?.at(-1) as Vec2;
		expect(dist(end, [0, 0])).toBeLessThanOrEqual(COMPANION_FREE);
		// it is on the +x side of the owner, and stays on that side
		expect(end[0]).toBeGreaterThan(0.5);
	});

	test("not onto someone standing just there", () => {
		const end = setup(10_000).stroll.way()?.at(-1) as Vec2;
		const inTheWay = avatar("a_other", "ai", [end[0] + 0.2, end[1]], Date.now() - 60_000);
		expect(setup(10_000, false, [inTheWay]).stroll.way()).toBeNull();
	});

	test("not while the owner has only just stopped, nor while talking", () => {
		expect(setup(1_000).stroll.way()).toBeNull();
		expect(setup(10_000, true).stroll.way()).toBeNull();
	});
});
