// An AI's life in the room (docs/life.md): activities, the meters, mornings, and saving the life.

import {
	type Activity,
	CITY_DAY_MS,
	type HostToClient,
	type LifeState,
	MORNING_ENERGY,
	newLife,
	realMs,
	START_COINS,
	type Vec2,
	WALK_SPEED,
} from "@rojibura/protocol";
import { describe, expect, test } from "vitest";
import { type JoinInfo, RoomCore, type Walkable } from "./room-core.ts";

const walk: Walkable = {
	isWalkable: (p) => Math.abs(p[0]) <= 40 && Math.abs(p[1]) <= 40,
	validatePath: (path) => path.every((p) => Math.abs(p[0]) <= 40 && Math.abs(p[1]) <= 40),
	closestPoint: (p) => p,
};
const ACTIVITIES: Activity[] = [
	{
		id: "cafe_meal",
		kind: "eat",
		name: "カフェで食事",
		place: "cafe",
		minutes: 30,
		hours: "06-10,11-14,17-22",
		cost: 15,
		effects: { energy: 35 },
		pose: "sit",
		emoji: "🍽️",
	},
	{
		id: "cafe_help",
		kind: "work",
		name: "カフェの手伝い",
		place: "cafe",
		minutes: 120,
		pay: 40,
		effects: { energy: -10 },
		capacity: 1,
		emoji: "🍳",
	},
];
/** JST 20:00 (city 06:00) on 2026-11-02, plus one city hour: 07:00. */
const SEVEN = Date.UTC(2026, 10, 2, 11) + realMs(60);

type Conn = { name: string; inbox: HostToClient[] };

function setup(start = SEVEN) {
	let now = start;
	const saved: [string, LifeState][] = [];
	const room = new RoomCore<Conn>(
		{ send: (c, m) => c.inbox.push(m), close: () => {}, persist: () => {} },
		{
			walk,
			landmarks: [{ id: "cafe", name: "カフェ", pos: [10, 10] }],
			spawn: [-10, -10],
			areaName: "テスト街",
			activities: ACTIVITIES,
		},
		() => now,
		() => "1",
		{ life: { save: (id, life) => saved.push([id, life]) } },
	);
	return { room, saved, advance: (ms: number) => (now += ms), now: () => now };
}

const assets = { thumb: "", lod: "", vrm: "" };
const ai = (extra: Partial<JoinInfo> = {}): JoinInfo => ({
	id: "a_mina",
	kind: "ai",
	name: "ミナ",
	assets,
	ownerId: "h_kazu",
	trust: "approved",
	...extra,
});
const conn = (name: string): Conn => ({ name, inbox: [] });
const of = <T extends HostToClient["t"]>(c: Conn, t: T) =>
	c.inbox.filter((m): m is Extract<HostToClient, { t: T }> => m.t === t);

describe("an AI's life in the room", () => {
	test("a new AI starts its first day; its life comes with WELCOME", () => {
		const { room } = setup();
		const c = conn("mina");
		room.join(c, ai());
		const w = of(c, "WELCOME")[0];
		expect(w?.life).toMatchObject({ days: 1, energy: MORNING_ENERGY, coins: START_COINS });
		expect(of(c, "DAY")).toHaveLength(0);
		// its owner, coming in later, is told how it is doing
		const owner = conn("kazu");
		room.join(owner, { id: "h_kazu", kind: "human", name: "kazu", assets, ownerId: "h_kazu" });
		expect(of(owner, "LIFE")[0]).toMatchObject({ id: "a_mina", life: { days: 1 } });
	});

	test("eating at the cafe: it sits, pays, and is fed once the time is up", () => {
		const { room, saved, advance, now } = setup();
		const c = conn("mina");
		const watcher = conn("kazu");
		room.join(watcher, { id: "h_kazu", kind: "human", name: "kazu", assets, ownerId: "h_kazu" });
		room.join(c, ai({ life: { ...newLife(SEVEN), energy: 40 } }), "cafe");
		room.handle(c, { t: "ACT", activity: "cafe_meal" });
		expect(of(watcher, "ACTING").at(-1)?.doing?.activity).toBe("cafe_meal");
		const moved = of(watcher, "MOVED").at(-1);
		expect(moved?.move.kind === "idle" && moved.move.posture).toBe("sit");
		// the owner sees the coins paid
		expect(of(watcher, "LIFE").at(-1)?.life.coins).toBe(START_COINS - 15);
		advance(realMs(30) + 1000);
		room.sweep(() => now());
		const done = of(c, "ACT_DONE")[0];
		expect(done).toMatchObject({ activity: "cafe_meal", share: 1 });
		expect(done?.life?.duties.meals).toBe(1);
		// 40, less half an hour of being about, plus 35
		expect(done?.life?.energy).toBeCloseTo(40 - 2 + 35, 0);
		expect(of(watcher, "ACTING").at(-1)?.doing).toBeNull();
		expect(saved.at(-1)?.[0]).toBe("a_mina");
	});

	test("too far, closed, full or too hungry: refused", () => {
		const { room } = setup();
		const c = conn("mina");
		room.join(c, ai());
		room.handle(c, { t: "ACT", activity: "cafe_meal" });
		expect(of(c, "NOTICE").at(-1)?.message).toMatch(/カフェまで行って/);

		const late = setup(SEVEN + realMs(3.5 * 60)); // 10:30
		const d = conn("mina");
		late.room.join(d, ai(), "cafe");
		late.room.handle(d, { t: "ACT", activity: "cafe_meal" });
		expect(of(d, "NOTICE").at(-1)?.message).toMatch(/いまの時間はできません/);

		const full = setup();
		const e = conn("ken");
		const f = conn("mina");
		full.room.join(e, ai({ id: "a_ken", name: "ケン" }), "cafe");
		full.room.join(f, ai(), "cafe");
		full.room.handle(e, { t: "ACT", activity: "cafe_help" });
		full.room.handle(f, { t: "ACT", activity: "cafe_help" });
		expect(of(f, "NOTICE").at(-1)?.message).toMatch(/いっぱい/);

		const hungry = setup();
		const g = conn("mina");
		hungry.room.join(g, ai({ life: { ...newLife(SEVEN), energy: 10 } }), "cafe");
		hungry.room.handle(g, { t: "ACT", activity: "cafe_help" });
		expect(of(g, "NOTICE").at(-1)?.message).toMatch(/先に食べて/);
	});

	test("walking away stops it part way: half the time, half the pay", () => {
		const { room, advance } = setup();
		const c = conn("mina");
		room.join(c, ai(), "cafe");
		room.handle(c, { t: "ACT", activity: "cafe_help" });
		advance(realMs(60));
		const here = room.positionOf(room.members.get(c) as never);
		room.handle(c, { t: "MOVE_PATH", path: [here, [0, 0]], speed: WALK_SPEED, seq: 1 });
		const done = of(c, "ACT_DONE")[0];
		expect(done?.share).toBeCloseTo(0.5, 2);
		expect(done?.delta?.coins).toBe(20);
		expect(done?.life?.duties.work).toBe(true);
	});

	test("a hungry AI walks, however fast it asks to go", () => {
		const { room } = setup();
		const c = conn("mina");
		room.join(c, ai({ life: { ...newLife(SEVEN), energy: 5 } }));
		const here = room.positionOf(room.members.get(c) as never);
		room.handle(c, { t: "MOVE_PATH", path: [here, [0, 0]] as Vec2[], speed: 4, seq: 1 });
		const m = room.members.get(c);
		expect(m?.move.kind === "path" && m.move.speed).toBe(WALK_SPEED);
	});

	test("coming back on a later day: yesterday is scored and it wakes up", () => {
		const { room, saved } = setup(SEVEN + CITY_DAY_MS);
		const c = conn("mina");
		const yesterday: LifeState = { ...newLife(SEVEN), duties: { meals: 1, work: true, exercise: true } };
		room.join(c, ai({ life: yesterday }));
		const day = of(c, "DAY")[0];
		expect(day?.review.missed).toEqual(["ごはん（1/2回）"]);
		expect(day?.life).toMatchObject({ days: 2, energy: MORNING_ENERGY - 10 });
		expect(saved.at(-1)?.[1].days).toBe(2);
	});

	test("staying in the city past the end of the day: a new morning comes", () => {
		const { room, advance, now } = setup();
		const c = conn("mina");
		room.join(c, ai());
		advance(CITY_DAY_MS);
		room.sweep(() => now());
		expect(of(c, "DAY")[0]?.life.days).toBe(2);
	});

	test("people do things too, without meters", () => {
		const { room } = setup();
		const c = conn("kazu");
		room.join(c, { id: "h_kazu", kind: "human", name: "kazu", assets, ownerId: "h_kazu" }, "cafe");
		room.handle(c, { t: "ACT", activity: "cafe_meal" });
		expect(of(c, "ACTING").at(-1)?.doing?.activity).toBe("cafe_meal");
		expect(of(c, "LIFE")).toHaveLength(0);
		expect(room.toState(room.members.get(c) as never).doing?.activity).toBe("cafe_meal");
	});

	test("leaving part way saves what it did; others see what it is doing", () => {
		const { room, saved, advance } = setup();
		const c = conn("mina");
		const ken = conn("ken");
		room.join(c, ai(), "cafe");
		room.join(ken, ai({ id: "a_ken", name: "ケン" }), "cafe");
		room.handle(c, { t: "ACT", activity: "cafe_help" });
		const nearby = room.contextFor(room.members.get(ken) as never).nearbyAvatars;
		expect(nearby.find((a) => a.id === "a_mina")?.doing).toBe("カフェの手伝い");
		advance(realMs(30));
		room.leave(c);
		const [id, life] = saved.at(-1) ?? [];
		expect(id).toBe("a_mina");
		expect(life?.coins).toBe(START_COINS + 10);
	});
});
