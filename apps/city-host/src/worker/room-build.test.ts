// Free play (docs/prd.md 3.7): the limits it lifts, and building. Production rules refuse building.

import {
	applyBuilds,
	boxNav,
	type ModelNav,
	NavMesh,
	type NavMeshData,
	type PlacedModel,
} from "@rojibura/nav";
import type { Build, ClientToHost, HostToClient, Vec2 } from "@rojibura/protocol";
import { AI_CONV_MAX_TURNS } from "@rojibura/protocol";
import { describe, expect, test } from "vitest";
import { type JoinInfo, RoomCore, type World } from "./room-core.ts";
import { FREE_PLAY_RULES, PRODUCTION_RULES, type RoomRules } from "./rules.ts";
import { walkFor } from "./world.ts";

/** A flat 40 x 40 m square as 2 x 2 quads. */
const base: NavMeshData = {
	version: 1,
	vertices: [
		-20, 0, -20, 0, 0, -20, 20, 0, -20, -20, 0, 0, 0, 0, 0, 20, 0, 0, -20, 0, 20, 0, 0, 20, 20, 0, 20,
	],
	polygons: [
		{ verts: [0, 1, 4, 3], neighbors: [-1, 1, 2, -1] },
		{ verts: [1, 2, 5, 4], neighbors: [-1, -1, 3, 0] },
		{ verts: [3, 4, 7, 6], neighbors: [0, 3, -1, -1] },
		{ verts: [4, 5, 8, 7], neighbors: [1, -1, -1, 2] },
	],
};
const mesh = NavMesh.fromJSON(base);

/** A 1 m high platform people can walk on, with a ramp down to +Z and the ground around it. */
function platform(): ModelNav {
	const vertices: number[] = [];
	const polygons: { verts: number[]; neighbors: number[] }[] = [];
	const add = (pts: [number, number, number][]) => {
		const first = vertices.length / 3;
		for (const p of pts) vertices.push(...p);
		polygons.push({ verts: pts.map((_, i) => first + i), neighbors: pts.map(() => -1) });
	};
	const quad = (x0: number, x1: number, z0: number, z1: number, y0: number, y1 = y0) =>
		add([
			[x0, y0, z0],
			[x1, y0, z0],
			[x1, y1, z1],
			[x0, y1, z1],
		]);
	quad(-1, 1, -1, 1, 1);
	quad(-1, 1, 1, 3, 1, 0);
	quad(-4, -1, -4, 4, 0);
	quad(1, 4, -4, 4, 0);
	quad(-1, 1, -4, -1, 0);
	quad(-1, 1, 3, 4, 0);
	return {
		version: 1,
		min: [-1, 0, -1],
		max: [1, 1, 3],
		footprint: [
			[
				[-1, -1],
				[1, -1],
				[1, 3],
				[-1, 3],
			],
		],
		walk: { version: 1, vertices, polygons },
	};
}

const MODELS: Record<string, ModelNav> = { house: boxNav(4, 3, 4), deck: platform() };

type Conn = { name: string; inbox: HostToClient[]; closed?: number };

function setup(rules: RoomRules) {
	let now = 1_000_000;
	let n = 0;
	const clock = { now: () => now, advance: (ms: number) => (now += ms) };
	const saved = new Map<string, Build>();
	const world: World = {
		walk: walkFor(mesh),
		landmarks: [{ id: "cafe", name: "カフェ", pos: [10, 10] }],
		spawn: [-10, -10],
		areaName: "テスト街",
		build: {
			model: (id) => MODELS[id],
			groundHeight: (p) => mesh.heightAt(p),
			walkWith: (placed) => walkFor(NavMesh.fromJSON(applyBuilds(base, placed))),
		},
	};
	const room = new RoomCore<Conn>(
		{
			send: (c, m) => c.inbox.push(m),
			close: (c, code) => {
				c.closed = code;
			},
			persist: () => {},
		},
		world,
		clock.now,
		() => String(++n),
		{ rules, store: { save: (b) => saved.set(b.id, b), remove: (id) => saved.delete(id) } },
	);
	return { room, clock, saved };
}

const assets = { thumb: "", lod: "", vrm: "" };
const human = (id: string): JoinInfo => ({
	id: `h_${id}`,
	kind: "human",
	name: id,
	assets,
	ownerId: `h_${id}`,
});
const ai = (id: string, owner: string, trust: "approved" | "provisional" = "approved"): JoinInfo => ({
	id: `a_${id}`,
	kind: "ai",
	name: id,
	assets,
	ownerId: `h_${owner}`,
	trust,
});
const conn = (name: string): Conn => ({ name, inbox: [] });
const last = (c: Conn) => c.inbox[c.inbox.length - 1];
const of = <T extends HostToClient["t"]>(c: Conn, t: T) =>
	c.inbox.filter((m): m is Extract<HostToClient, { t: T }> => m.t === t);

/** Joins and moves to `pos` at once (the spawn point is random): returns the position. */
function joinAt(ctx: ReturnType<typeof setup>, c: Conn, info: JoinInfo, pos?: Vec2): Vec2 {
	ctx.room.join(c, info);
	const w = c.inbox[0];
	if (w?.t !== "WELCOME") throw new Error("no welcome");
	const me = w.avatars.find((x) => x.id === info.id);
	if (me?.move.kind !== "idle") throw new Error("not idle");
	if (!pos) return me.move.pos;
	const path = mesh.findPath(me.move.pos, pos) as Vec2[];
	ctx.room.handle(c, { t: "MOVE_PATH", path, speed: 6, seq: 1 });
	ctx.clock.advance(60_000);
	return pos;
}

const build = (
	model: string,
	at: Extract<ClientToHost, { t: "BUILD" }>["at"],
	extra: object = {},
): ClientToHost => ({
	t: "BUILD",
	model,
	at,
	...extra,
});

describe("production rules", () => {
	test("BUILD and UNBUILD are refused, with the ref; nobody hears of a build; WELCOME has no builds", () => {
		const ctx = setup(PRODUCTION_RULES);
		const a = conn("a");
		const b = conn("b");
		ctx.room.join(a, human("alice"));
		ctx.room.join(b, human("bob"));
		const welcome = a.inbox[0];
		expect(welcome?.t === "WELCOME" && welcome.builds).toBeUndefined();
		ctx.room.handle(a, build("house", { pos: [10, -10] }, { ref: "r1" }));
		expect(last(a)).toEqual({
			t: "NOTICE",
			kind: "rejected",
			message: "この街では建てられません",
			ref: "r1",
		});
		ctx.room.handle(a, { t: "UNBUILD", id: "b_x", ref: "r2" });
		expect(last(a)).toMatchObject({ t: "NOTICE", kind: "rejected", ref: "r2" });
		expect([...a.inbox, ...b.inbox].some((m) => m.t === "BUILT" || m.t === "UNBUILT")).toBe(false);
		expect(ctx.saved.size).toBe(0);
	});

	test("the free-tier limits still apply", () => {
		const ctx = setup(PRODUCTION_RULES);
		ctx.room.join(conn("1"), ai("x1", "kazu"));
		ctx.room.join(conn("2"), ai("x2", "kazu"));
		expect(ctx.room.join(conn("3"), ai("x3", "kazu"))).toBe(false);
		const p = conn("p");
		const h = conn("h");
		ctx.room.join(p, ai("p", "other", "provisional"));
		ctx.room.join(h, human("hana"));
		ctx.room.handle(p, { t: "SAY", text: "こんにちは", to: "h_hana" });
		expect(last(p)).toMatchObject({ t: "NOTICE", kind: "rejected" });
	});
});

describe("free play lifts the free-tier limits", () => {
	test("capacity, agents per owner and provisional AIs", () => {
		const ctx = setup(FREE_PLAY_RULES);
		for (let i = 0; i < 101; i++) expect(ctx.room.join(conn(`h${i}`), human(`h${i}`))).toBe(true);
		for (let i = 0; i < 4; i++)
			expect(ctx.room.join(conn(`a${i}`), ai(`a${i}`, "kazu", "provisional"))).toBe(true);
		expect(ctx.room.size).toBe(105);
	});

	test("provisional AIs may talk to people (unless they refuse AIs)", () => {
		const ctx = setup(FREE_PLAY_RULES);
		const p = conn("p");
		const h = conn("h");
		ctx.room.join(p, ai("p", "kazu", "provisional"));
		ctx.room.join(h, human("hana"));
		ctx.room.handle(p, { t: "SAY", text: "こんにちは", to: "h_hana" });
		expect(last(h)).toMatchObject({ t: "SAID", id: "a_p", to: "h_hana" });
	});

	test("AI conversations have no turn limit and no cooldown; people may talk as fast as they like", () => {
		const ctx = setup(FREE_PLAY_RULES);
		const x = conn("x");
		const y = conn("y");
		ctx.room.join(x, ai("x", "o1"));
		ctx.room.join(y, ai("y", "o2"));
		ctx.room.handle(x, { t: "SAY", text: "やあ", to: "a_y" });
		const first = of(y, "ADDRESSED")[0];
		expect(first?.maxTurns).toBeNull();
		let speaker = y;
		for (let turn = 2; turn <= AI_CONV_MAX_TURNS * 3; turn++) {
			ctx.clock.advance(3000);
			ctx.room.handle(speaker, { t: "SAY", text: `turn ${turn}`, convId: first?.convId });
			speaker = speaker === y ? x : y;
		}
		expect(of(x, "CONV_END")).toHaveLength(0);
		expect(of(x, "NOTICE")).toHaveLength(0);
		const h = conn("h");
		ctx.room.join(h, human("hana"));
		for (let i = 0; i < 20; i++) ctx.room.handle(h, { t: "SAY", text: `${i}` });
		expect(of(h, "SAID")).toHaveLength(20);
		expect(h.closed).toBeUndefined();
	});
});

describe("building in free play", () => {
	test("BUILT reaches everyone with the ref, is saved, and later arrivals get it in WELCOME", () => {
		const ctx = setup(FREE_PLAY_RULES);
		const a = conn("a");
		const far = conn("far");
		ctx.room.join(a, human("alice"));
		ctx.room.join(far, ai("far", "o1"));
		ctx.room.handle(
			a,
			build("house", { pos: [10, -10] }, { ref: "h1", color: "#c8473d", label: "アリスの家" }),
		);
		const built = last(a);
		expect(built).toMatchObject({
			t: "BUILT",
			ref: "h1",
			build: {
				model: "house",
				pos: [10, -10],
				y: 0,
				rot: 0,
				scale: 1,
				color: "#c8473d",
				label: "アリスの家",
				by: "h_alice",
			},
		});
		expect(last(far)).toEqual(built);
		expect(ctx.saved.size).toBe(1);
		const c = conn("c");
		ctx.room.join(c, human("carol"));
		const welcome = c.inbox[0];
		expect(welcome?.t === "WELCOME" && welcome.builds?.map((b) => b.model)).toEqual(["house"]);
	});

	test("refused: overlapping, near the spawn point, on a landmark, on someone, unknown models", () => {
		const ctx = setup(FREE_PLAY_RULES);
		const a = conn("a");
		joinAt(ctx, a, human("alice"), [-15, 15]);
		const refused = (msg: ClientToHost) => {
			ctx.room.handle(a, msg);
			const m = last(a);
			if (m?.t !== "NOTICE") throw new Error(`not refused: ${JSON.stringify(m)}`);
			return m;
		};
		ctx.room.handle(a, build("house", { pos: [10, -10] }));
		expect(refused(build("house", { pos: [12, -8] }, { ref: "x" }))).toMatchObject({
			ref: "x",
			message: "ほかの建物と重なります",
		});
		expect(refused(build("block", { pos: [-9, -9] })).message).toMatch(/スポーン/);
		expect(refused(build("block", { pos: [10, 10] })).message).toMatch(/カフェ/);
		expect(refused(build("block", { pos: [-15, 15] })).message).toMatch(/alice/);
		expect(refused(build("castle", { pos: [0, 5] })).message).toBe("そのモデルはありません");
		expect(refused(build("deck", { pos: [0, 5] }, { scale: 2 })).message).toMatch(/大きさ/);
		expect(refused(build("block", { pos: [25, 0] })).message).toMatch(/地面/);
	});

	test("a wall that would cut a landmark off is refused", () => {
		const ctx = setup(FREE_PLAY_RULES);
		const a = conn("a");
		ctx.room.join(a, human("alice"));
		ctx.room.handle(a, build("block", { pos: [5, 0] }, { size: [30, 2, 1] }));
		expect(last(a)?.t).toBe("BUILT");
		ctx.room.handle(a, build("block", { pos: [-15, 0] }, { size: [10, 2, 1] }));
		expect(last(a)).toMatchObject({
			t: "NOTICE",
			message: "道をふさいでしまいます（カフェへ行けなくなります）",
		});
	});

	test("anchors: next to a landmark facing it, and at an offset from yourself", () => {
		const ctx = setup(FREE_PLAY_RULES);
		const a = conn("a");
		const here = joinAt(ctx, a, human("alice"), [-12, 12]);
		ctx.room.handle(a, build("house", { landmark: "cafe" }));
		const near = last(a);
		if (near?.t !== "BUILT") throw new Error(JSON.stringify(near));
		const [x, z] = near.build.pos;
		const d = Math.hypot(x - 10, z - 10);
		expect(d).toBeGreaterThan(3);
		expect(d).toBeLessThan(8);
		// its front (sin rot, cos rot) points at the cafe
		const r = (near.build.rot * Math.PI) / 180;
		expect(Math.sin(r) * (10 - x) + Math.cos(r) * (10 - z)).toBeCloseTo(d, 3);
		ctx.room.handle(a, build("block", { avatar: "h_alice", offset: [3, 0] }));
		expect(last(a)).toMatchObject({ t: "BUILT", build: { pos: [here[0] + 3, here[1]] } });
	});

	test("paths through a build are planned again around it; walkers heading into a new build stop", () => {
		const ctx = setup(FREE_PLAY_RULES);
		const a = conn("a");
		const w = conn("w");
		const start = joinAt(ctx, a, human("alice"), [-15, 5]);
		joinAt(ctx, w, human("walker"), [5, 15]);
		// the walker sets off south, slowly
		ctx.room.handle(w, {
			t: "MOVE_PATH",
			path: [
				[5, 15],
				[5, -15],
			],
			speed: 1,
			seq: 2,
		});
		ctx.room.handle(a, build("block", { pos: [5, 5] }, { size: [8, 2, 1] }));
		expect(of(a, "BUILT")).toHaveLength(1);
		expect(of(a, "MOVED").at(-1)).toMatchObject({ id: "h_walker", move: { kind: "idle" } });
		// straight east through the block: the host plans it around
		ctx.room.handle(a, { t: "MOVE_PATH", path: [start, [15, 5]], speed: 1.4, seq: 3 });
		const moved = last(a);
		if (moved?.t !== "MOVED" || moved.move.kind !== "path") throw new Error(JSON.stringify(moved));
		expect(moved.move.path.length).toBeGreaterThan(2);
		expect(moved.move.path.at(-1)).toEqual([15, 5]);
		for (const p of moved.move.path) expect(Math.abs(p[0] - 5) < 4.2 && Math.abs(p[1] - 5) < 0.7).toBe(false);
	});

	test("UNBUILD takes it down for everyone and the way is open again", () => {
		const ctx = setup(FREE_PLAY_RULES);
		const a = conn("a");
		const b = conn("b");
		const start = joinAt(ctx, a, human("alice"), [-15, 5]);
		ctx.room.join(b, human("bob"));
		ctx.room.handle(a, build("block", { pos: [5, 5] }, { size: [8, 2, 1] }));
		const built = last(a);
		if (built?.t !== "BUILT") throw new Error();
		ctx.room.handle(b, { t: "UNBUILD", id: built.build.id, ref: "u" });
		expect(last(a)).toEqual({ t: "UNBUILT", id: built.build.id, by: "h_bob", ref: "u" });
		expect(ctx.saved.size).toBe(0);
		ctx.room.handle(a, { t: "MOVE_PATH", path: [start, [15, 5]], speed: 1.4, seq: 2 });
		expect(last(a)).toMatchObject({ t: "MOVED", move: { kind: "path", path: [start, [15, 5]] } });
	});

	test("a model people can walk on: its top is reachable, and AIs see builds in their context", () => {
		const ctx = setup(FREE_PLAY_RULES);
		const a = conn("a");
		const x = conn("x");
		const start = joinAt(ctx, a, human("alice"), [-15, 5]);
		ctx.room.handle(a, build("deck", { pos: [5, 5] }, { rot: 90, label: "見晴らし台" }));
		const built = last(a);
		if (built?.t !== "BUILT") throw new Error(JSON.stringify(built));
		const placed: PlacedModel = { nav: platform(), pos: [5, 5], y: 0, rot: 90, scale: 1 };
		const path = NavMesh.fromJSON(applyBuilds(base, [placed])).findPath(start, [5, 5]) as Vec2[];
		ctx.room.handle(a, { t: "MOVE_PATH", path, speed: 1.4, seq: 2 });
		expect(last(a)).toMatchObject({ t: "MOVED", move: { kind: "path" } });
		joinAt(ctx, x, ai("x", "o1"), [0, 0]);
		ctx.room.handle(a, { t: "SAY", text: "あれ見て", to: "a_x" });
		const addressed = of(x, "ADDRESSED")[0];
		expect(addressed?.context.nearbyBuilds?.[0]).toMatchObject({
			model: "deck",
			label: "見晴らし台",
			byName: "alice",
		});
	});

	test("saved builds come back after a restart", () => {
		const first = setup(FREE_PLAY_RULES);
		const a = conn("a");
		first.room.join(a, human("alice"));
		first.room.handle(a, build("house", { pos: [10, -10] }));
		const again = setup(FREE_PLAY_RULES);
		again.room.loadBuilds([...first.saved.values()]);
		const b = conn("b");
		again.room.join(b, human("bob"));
		const welcome = b.inbox[0];
		expect(welcome?.t === "WELCOME" && welcome.builds).toHaveLength(1);
		expect(again.room.terrain.isWalkable([10, -10])).toBe(false);
	});
});
