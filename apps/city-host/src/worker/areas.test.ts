// assets/areas.json against each area's world (docs/prd.md 3.8): the portals lead somewhere and can be walked to.
// (That each area's files are where `dir` says is checked in tools/city-build/src/areas.test.ts.)
import type { HostToClient, Vec2 } from "@rojibura/protocol";
import { expect, test } from "vitest";
import { RoomCore } from "./room-core.ts";
import type { JoinInfo } from "./room-types.ts";
import { AREA_IDS, AREAS, MAIN_AREA, worldOf } from "./world.ts";

test("the main area comes first and builds", () => {
	expect(MAIN_AREA).toBe("main");
	expect(AREAS.areas[MAIN_AREA]?.build).toBe(true);
});

test.each(AREA_IDS)("%s: the host has a world for it", (id) => {
	expect(worldOf(id)).toBeDefined();
	expect(worldOf(id)?.areaName).toBe(AREAS.areas[id]?.name);
});

test.each(AREA_IDS)("%s: every portal is walkable, reachable and leads to a place in another area", (id) => {
	const world = worldOf(id);
	if (!world) throw new Error(`no world for ${id}`);
	const { walk } = world;
	for (const p of AREAS.areas[id]?.portals ?? []) {
		expect(walk.isWalkable(p.pos)).toBe(true);
		expect(walk.findPath?.(world.spawn, p.pos)).toBeTruthy();
		// a portal is one of the area's landmarks, so people and AIs can walk to it
		expect(world.landmarks.some((l) => l.id === p.id)).toBe(true);
		const there = worldOf(p.to);
		expect(p.to).not.toBe(id);
		expect(there?.landmarks.some((l) => l.id === p.at)).toBe(true);
	}
});

test("arriving through a portal puts you a step away from it, not on it", () => {
	const world = worldOf("venezia");
	if (!world) throw new Error("no venezia");
	const gate = world.landmarks.find((l) => l.id === "gate_main");
	if (!gate) throw new Error("no gate_main");
	type Conn = { inbox: HostToClient[] };
	/** Where the WELCOME puts `id`. */
	const placed = (c: Conn, id: string): Vec2 => {
		const w = c.inbox[0];
		const me = w?.t === "WELCOME" ? w.avatars.find((a) => a.id === id) : undefined;
		if (me?.move.kind !== "idle") throw new Error("not placed");
		return me.move.pos;
	};
	const room = new RoomCore<Conn>(
		{ send: (c, m) => c.inbox.push(m), close: () => {}, persist: () => {} },
		world,
		() => 1_000_000,
		() => "x",
	);
	const info: JoinInfo = {
		id: "h_t",
		kind: "human",
		name: "t",
		assets: { thumb: "", lod: "", vrm: "" },
		ownerId: "h_t",
	};
	for (let i = 0; i < 20; i++) {
		const c: Conn = { inbox: [] };
		room.join(c, { ...info, id: `h_t${i}` }, "gate_main");
		const pos = placed(c, `h_t${i}`);
		const d = Math.hypot(pos[0] - gate.pos[0], pos[1] - gate.pos[1]);
		expect(d).toBeGreaterThanOrEqual(1.4);
		expect(d).toBeLessThanOrEqual(3.1);
		expect(world.walk.isWalkable(pos)).toBe(true);
	}
	// an unknown place is the spawn point
	const c: Conn = { inbox: [] };
	room.join(c, { ...info, id: "h_other" }, "nowhere");
	const pos = placed(c, "h_other");
	expect(Math.hypot(pos[0] - world.spawn[0], pos[1] - world.spawn[1])).toBeLessThanOrEqual(2.6);
});
