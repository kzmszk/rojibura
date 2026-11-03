// An AI's life in the room (docs/life.md): activities, the meters, working and eating, mornings, saving the life.

import {
	type Activity,
	CITY_DAY_MS,
	EARN_MS,
	type HostToClient,
	type LifeState,
	MORNING_ENERGY,
	newLife,
	realMs,
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
		id: "onsen_bath",
		kind: "rest",
		name: "露天風呂に入る",
		place: "bath",
		minutes: 30,
		hours: "07-23",
		cost: 8,
		effects: { energy: 10, mood: 10 },
		pose: "sit",
		emoji: "♨️",
	},
	{
		id: "lawn_exercise",
		kind: "exercise",
		name: "原っぱで体操",
		place: "lawn",
		minutes: 60,
		effects: { energy: -10, fitness: 5 },
		capacity: 1,
		emoji: "🤸",
	},
];
/** JST 20:00 (city 06:00) on 2026-11-02, plus one city hour: 07:00. */
const SEVEN = Date.UTC(2026, 10, 2, 11) + realMs(60);

type Conn = { name: string; inbox: HostToClient[] };

function setup(start = SEVEN) {
	let now = start;
	const saved: [string, LifeState][] = [];
	const wallet: [string, number][] = [];
	const room = new RoomCore<Conn>(
		{ send: (c, m) => c.inbox.push(m), close: () => {}, persist: () => {} },
		{
			walk,
			landmarks: [
				{ id: "bath", name: "露天風呂", pos: [10, 10] },
				{ id: "lawn", name: "原っぱ", pos: [-10, 10] },
				{ id: "seven", name: "セブンイレブン", pos: [20, 0] },
			],
			spawn: [-10, -10],
			areaName: "テスト街",
			activities: ACTIVITIES,
			shops: [
				{
					id: "seven",
					name: "セブンイレブン",
					currency: "銅貨",
					counter: [20, 0],
					goods: [
						{ id: "onigiri", name: "おにぎり", price: 3, color: "#ffffff", food: true },
						{ id: "coffee", name: "ホットコーヒー", price: 2, color: "#6b4a33", food: true },
					],
				},
			],
			jobZones: [
				{
					id: "work_seven",
					kind: "work",
					name: "セブンイレブン",
					poly: [
						[15, -5],
						[25, -5],
						[25, 5],
						[15, 5],
					],
				},
				{
					id: "study_lawn",
					kind: "study",
					name: "原っぱのベンチ",
					poly: [
						[-15, 5],
						[-5, 5],
						[-5, 15],
						[-15, 15],
					],
				},
			],
			foods: { onigiri: { energy: 25, meal: true }, coffee: { energy: 3, mood: 5, drink: true } },
			jobs: { work_seven: { skill: "service", about: "レジに立つ。" } },
		},
		() => now,
		() => "1",
		{
			life: { save: (id, life) => saved.push([id, life]) },
			wallets: { add: (id, delta) => wallet.push([id, delta]) },
		},
	);
	return { room, saved, wallet, advance: (ms: number) => (now += ms), now: () => now };
}

const assets = { thumb: "", lod: "", vrm: "" };
const ai = (extra: Partial<JoinInfo> = {}): JoinInfo => ({
	id: "a_mina",
	kind: "ai",
	name: "ミナ",
	assets,
	ownerId: "h_kazu",
	trust: "approved",
	coins: 100,
	...extra,
});
const human = (): JoinInfo => ({
	id: "h_kazu",
	kind: "human",
	name: "kazu",
	assets,
	ownerId: "h_kazu",
	coins: 50,
});
const conn = (name: string): Conn => ({ name, inbox: [] });
const of = <T extends HostToClient["t"]>(c: Conn, t: T) =>
	c.inbox.filter((m): m is Extract<HostToClient, { t: T }> => m.t === t);

describe("an AI's life in the room", () => {
	test("a new AI starts its first day; its life comes with WELCOME, its coins with its owner's LIFE", () => {
		const { room } = setup();
		const c = conn("mina");
		room.join(c, ai());
		const w = of(c, "WELCOME")[0];
		expect(w?.life).toMatchObject({ days: 1, energy: MORNING_ENERGY });
		expect(of(c, "DAY")).toHaveLength(0);
		// its owner, coming in later, is told how it is doing and what is in its wallet
		const owner = conn("kazu");
		room.join(owner, human());
		expect(of(owner, "LIFE")[0]).toMatchObject({ id: "a_mina", life: { days: 1 }, coins: 100 });
	});

	test("a bath: it sits, pays from its wallet, and feels better once the time is up", () => {
		const { room, saved, wallet, advance, now } = setup();
		const c = conn("mina");
		const watcher = conn("kazu");
		room.join(watcher, human());
		room.join(c, ai({ life: { ...newLife(SEVEN), energy: 40 } }), "bath");
		room.handle(c, { t: "ACT", activity: "onsen_bath" });
		expect(of(watcher, "ACTING").at(-1)?.doing?.activity).toBe("onsen_bath");
		const moved = of(watcher, "MOVED").at(-1);
		expect(moved?.move.kind === "idle" && moved.move.posture).toBe("sit");
		expect(of(c, "WALLET").at(-1)).toMatchObject({ coins: 92, change: -8, why: "buy" });
		expect(wallet).toEqual([["a_mina", -8]]);
		advance(realMs(30) + 1000);
		room.sweep(() => now());
		const done = of(c, "ACT_DONE")[0];
		expect(done).toMatchObject({ activity: "onsen_bath", share: 1 });
		// 40, less half an hour of being about, plus 10
		expect(done?.life?.energy).toBeCloseTo(40 - 2 + 10, 0);
		expect(of(watcher, "ACTING").at(-1)?.doing).toBeNull();
		expect(saved.at(-1)?.[0]).toBe("a_mina");
	});

	test("too far, closed, full, too hungry or too poor: refused", () => {
		const { room } = setup();
		const c = conn("mina");
		room.join(c, ai());
		room.handle(c, { t: "ACT", activity: "onsen_bath" });
		expect(of(c, "NOTICE").at(-1)?.message).toMatch(/露天風呂まで行って/);

		const early = setup(SEVEN - realMs(30)); // 06:30
		const d = conn("mina");
		early.room.join(d, ai(), "bath");
		early.room.handle(d, { t: "ACT", activity: "onsen_bath" });
		expect(of(d, "NOTICE").at(-1)?.message).toMatch(/いまの時間はできません/);

		const full = setup();
		const e = conn("ken");
		const f = conn("mina");
		full.room.join(e, ai({ id: "a_ken", name: "ケン" }), "lawn");
		full.room.join(f, ai(), "lawn");
		full.room.handle(e, { t: "ACT", activity: "lawn_exercise" });
		full.room.handle(f, { t: "ACT", activity: "lawn_exercise" });
		expect(of(f, "NOTICE").at(-1)?.message).toMatch(/いっぱい/);

		const hungry = setup();
		const g = conn("mina");
		hungry.room.join(g, ai({ life: { ...newLife(SEVEN), energy: 10 } }), "lawn");
		hungry.room.handle(g, { t: "ACT", activity: "lawn_exercise" });
		expect(of(g, "NOTICE").at(-1)?.message).toMatch(/先に食べて/);

		const poor = setup();
		const h = conn("mina");
		poor.room.join(h, ai({ coins: 5 }), "bath");
		poor.room.handle(h, { t: "ACT", activity: "onsen_bath" });
		expect(of(h, "NOTICE").at(-1)?.message).toMatch(/銅貨が3枚足りません/);
	});

	test("walking away stops it part way: half the time, half the good", () => {
		const { room, advance } = setup();
		const c = conn("mina");
		room.join(c, ai(), "lawn");
		room.handle(c, { t: "ACT", activity: "lawn_exercise" });
		advance(realMs(30));
		const here = room.positionOf(room.members.get(c) as never);
		room.handle(c, { t: "MOVE_PATH", path: [here, [0, 0]], speed: WALK_SPEED, seq: 1 });
		const done = of(c, "ACT_DONE")[0];
		expect(done?.share).toBeCloseTo(0.5, 2);
		expect(done?.delta?.fitness).toBeCloseTo(2.5, 1);
		expect(done?.life?.duties.exercise).toBe(true);
	});

	test("working an hour is the day's work: coins, energy and a skill, told when it stops", () => {
		const { room, advance, now, saved } = setup();
		const c = conn("mina");
		room.join(c, ai(), "seven");
		room.handle(c, { t: "JOB", kind: "work" });
		expect(of(c, "JOBBED").at(-1)).toMatchObject({ id: "a_mina", job: "work" });
		advance(realMs(30));
		room.sweep(() => now());
		// half way: it hears how much it has done so far
		expect(of(c, "LIFE").at(-1)?.life.duties).toMatchObject({ work: false, worked: 30 });
		advance(realMs(30) + 1000);
		room.sweep(() => now());
		expect(of(c, "LIFE").at(-1)?.life.duties.work).toBe(true);
		room.handle(c, { t: "JOB", kind: null });
		const done = of(c, "ACT_DONE").at(-1);
		const earned = Math.floor((realMs(60) + 1000) / EARN_MS);
		expect(done).toMatchObject({
			activity: "work_seven",
			name: "セブンイレブンで働いた",
			about: "レジに立つ。",
			minutes: 60,
			delta: { coins: earned },
		});
		expect(done?.life?.duties).toMatchObject({ work: true, worked: 60 });
		expect(done?.life?.skills.service).toBeCloseTo(1, 1);
		// an hour about and an hour's work; the diary hears of all the work's energy
		expect(done?.life?.energy).toBeCloseTo(MORNING_ENERGY - 4 - 6, 0);
		expect(done?.delta?.energy).toBeCloseTo(-6, 0);
		expect(saved.at(-1)?.[1].duties.work).toBe(true);
	});

	test("a hungry AI cannot work; one working until it is starving stops", () => {
		const { room } = setup();
		const c = conn("mina");
		room.join(c, ai({ life: { ...newLife(SEVEN), energy: 10 } }), "seven");
		room.handle(c, { t: "JOB", kind: "work" });
		expect(of(c, "NOTICE").at(-1)?.message).toMatch(/先に何か食べて/);
		expect(of(c, "JOBBED")).toHaveLength(0);

		const late = setup();
		const d = conn("mina");
		late.room.join(d, ai({ life: { ...newLife(SEVEN), energy: 21 } }), "seven");
		late.room.handle(d, { t: "JOB", kind: "work" });
		late.advance(realMs(150));
		late.room.sweep(() => late.now());
		expect(of(d, "JOBBED").at(-1)?.job).toBeNull();
		expect(of(d, "NOTICE").at(-1)?.message).toMatch(/もう働けません/);
	});

	test("starting to work ends an activity; starting an activity ends the work", () => {
		const { room } = setup();
		const c = conn("mina");
		room.join(c, ai(), "lawn");
		room.handle(c, { t: "ACT", activity: "lawn_exercise" });
		room.handle(c, { t: "JOB", kind: "study" });
		expect(of(c, "ACT_DONE").at(-1)).toMatchObject({ activity: "lawn_exercise", share: 0 });
		expect(of(c, "ACTING").at(-1)?.doing).toBeNull();
		expect(room.members.get(c)?.job?.kind).toBe("study");
		room.handle(c, { t: "ACT", activity: "lawn_exercise" });
		expect(of(c, "JOBBED").at(-1)?.job).toBeNull();
		expect(room.members.get(c)?.doing?.activity).toBe("lawn_exercise");
	});

	test("food bought and eaten feeds an AI; a proper one is a meal, a coffee is drunk", () => {
		const { room } = setup();
		const c = conn("mina");
		room.join(c, ai({ life: { ...newLife(SEVEN), energy: 40 } }), "seven");
		room.handle(c, { t: "BUY", shop: "seven", goods: "onigiri" });
		room.handle(c, { t: "USE" });
		const rice = of(c, "ACT_DONE").at(-1);
		expect(rice).toMatchObject({
			activity: "onigiri",
			name: "おにぎりを食べた（ごはん）",
			delta: { energy: 25 },
		});
		expect(rice?.life?.duties.meals).toBe(1);
		room.handle(c, { t: "BUY", shop: "seven", goods: "coffee" });
		room.handle(c, { t: "USE" });
		const coffee = of(c, "ACT_DONE").at(-1);
		expect(coffee?.name).toBe("ホットコーヒーを飲んだ");
		expect(coffee?.life?.duties.meals).toBe(1);
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

	test("staying in the city past the end of the day: a new morning comes; the work so far was yesterday's", () => {
		const { room, advance, now } = setup();
		const c = conn("mina");
		room.join(c, ai(), "seven");
		room.handle(c, { t: "JOB", kind: "study" });
		room.handle(c, { t: "JOB", kind: "work" });
		advance(CITY_DAY_MS);
		room.sweep(() => now());
		const day = of(c, "DAY")[0];
		expect(day?.life.days).toBe(2);
		expect(day?.review.duties.work).toBe(true);
		expect(day?.life.duties.worked).toBe(0);
	});

	test("people do things too, and pay, without meters", () => {
		const { room } = setup();
		const c = conn("kazu");
		room.join(c, human(), "bath");
		room.handle(c, { t: "ACT", activity: "onsen_bath" });
		expect(of(c, "ACTING").at(-1)?.doing?.activity).toBe("onsen_bath");
		expect(of(c, "WALLET").at(-1)?.coins).toBe(42);
		expect(of(c, "LIFE")).toHaveLength(0);
		expect(room.toState(room.members.get(c) as never).doing?.activity).toBe("onsen_bath");
	});

	test("leaving part way saves what it did; others see what it is doing", () => {
		const { room, saved, advance } = setup();
		const c = conn("mina");
		const ken = conn("ken");
		room.join(c, ai(), "lawn");
		room.join(ken, ai({ id: "a_ken", name: "ケン" }), "lawn");
		room.handle(c, { t: "ACT", activity: "lawn_exercise" });
		const nearby = room.contextFor(room.members.get(ken) as never).nearbyAvatars;
		expect(nearby.find((a) => a.id === "a_mina")?.doing).toBe("原っぱで体操");
		advance(realMs(30));
		room.leave(c);
		const [id, life] = saved.at(-1) ?? [];
		expect(id).toBe("a_mina");
		expect(life?.fitness).toBeCloseTo(50 + 2.5, 1);
	});
});

describe("the owner reading their AI's diary (docs/life.md 8)", () => {
	const page = (part: number, parts: number, text: string) =>
		({ t: "DIARY", to: "h_kazu", day: "2026-11-03", part, parts, text }) as const;

	test("the owner asks, the AI here is asked, and its answer goes to the owner alone, in order", () => {
		const { room } = setup();
		const c = conn("mina");
		const owner = conn("kazu");
		const other = conn("ken");
		room.join(c, ai());
		room.join(owner, human());
		room.join(other, { ...human(), id: "h_ken", name: "ken", ownerId: "h_ken" });
		room.handle(owner, { t: "DIARY_ASK", id: "a_mina", day: "2026-11-03" });
		expect(of(c, "DIARY_ASK")).toEqual([{ t: "DIARY_ASK", from: "h_kazu", day: "2026-11-03" }]);
		room.handle(c, { ...page(0, 2, "# 2026-11-03\n"), days: ["2026-11-03"] });
		// a part out of order, and a part of another count, are not passed on
		room.handle(c, page(0, 2, "again"));
		room.handle(c, page(1, 3, "other"));
		room.handle(c, page(1, 2, "## 08:00 朝ごはん"));
		expect(of(owner, "DIARY")).toEqual([
			{
				t: "DIARY",
				id: "a_mina",
				day: "2026-11-03",
				part: 0,
				parts: 2,
				text: "# 2026-11-03\n",
				days: ["2026-11-03"],
			},
			{ t: "DIARY", id: "a_mina", day: "2026-11-03", part: 1, parts: 2, text: "## 08:00 朝ごはん" },
		]);
		expect(of(other, "DIARY")).toHaveLength(0);
		// the answer is over: nothing more goes through
		room.handle(c, page(0, 1, "more"));
		expect(of(owner, "DIARY")).toHaveLength(2);
	});

	test("only one's own AI here, and an AI cannot send its diary unasked or to someone else", () => {
		const { room, advance } = setup();
		const c = conn("mina");
		const owner = conn("kazu");
		const other = conn("ken");
		room.join(c, ai());
		room.join(owner, human());
		room.join(other, { ...human(), id: "h_ken", name: "ken", ownerId: "h_ken" });
		room.handle(other, { t: "DIARY_ASK", id: "a_mina" });
		expect(of(other, "NOTICE").at(-1)?.message).toBe("自分のAIの日記だけ読めます");
		room.handle(owner, { t: "DIARY_ASK", id: "a_away" });
		expect(of(owner, "NOTICE").at(-1)?.message).toContain("このエリアにいない");
		expect(of(c, "DIARY_ASK")).toHaveLength(0);
		room.handle(c, page(0, 1, "unasked"));
		expect(of(owner, "DIARY")).toHaveLength(0);
		room.handle(owner, { t: "DIARY_ASK", id: "a_mina" });
		room.handle(c, { ...page(0, 1, "to ken"), to: "h_ken" });
		expect(of(other, "DIARY")).toHaveLength(0);
		// an answer too late is not passed on
		advance(16_000);
		room.handle(c, page(0, 1, "late"));
		expect(of(owner, "DIARY")).toHaveLength(0);
	});
});
