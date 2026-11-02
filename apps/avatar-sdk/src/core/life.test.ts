// A resident's life (docs/life.md 5): activities through its tools, the diary, recalling, looking back.

import {
	type Activity,
	type AvatarState,
	CITY_DAY_MS,
	type ClientToHost,
	type HostToClient,
	newLife,
	realMs,
} from "@rojibura/protocol";
import { afterEach, describe, expect, test, vi } from "vitest";
import { dayOf, type Journal, jstDate, searchJournal, tail } from "./journal.ts";
import { type Mind, Resident, residentSystemPrompt } from "./resident.ts";

/** City 07:00 on 2026-11-02 (JST 20:13). */
const SEVEN = Date.UTC(2026, 10, 2, 11) + realMs(60);

class MemJournal implements Journal {
	readonly files = new Map<string, string>();
	life = "";
	meta: Record<string, string> = {};
	async append(text: string, day = jstDate()) {
		this.files.set(day, `${this.files.get(day) ?? ""}${text}\n\n`);
	}
	async read(day: string) {
		return this.files.get(day) ?? null;
	}
	async days() {
		return [...this.files.keys()].sort();
	}
	async readLife() {
		return this.life;
	}
	async writeLife(text: string) {
		this.life = text;
	}
	async getMeta(key: string) {
		return this.meta[key] ?? null;
	}
	async setMeta(key: string, value: string) {
		this.meta[key] = value;
	}
}

const ACTIVITIES: Activity[] = [
	{
		id: "cafe_meal",
		kind: "eat",
		name: "カフェで食事",
		place: "cafe",
		minutes: 30,
		hours: "06-10",
		cost: 15,
		effects: { energy: 35 },
		emoji: "🍽️",
		about: "朝はパンとスープ。",
	},
	{
		id: "park_exercise",
		kind: "exercise",
		name: "公園で体操",
		place: "park",
		minutes: 60,
		effects: { energy: -10, fitness: 5 },
		emoji: "🤸",
	},
];

type Call = [tool: string, args: Record<string, unknown>];

function setup(turns: Call[][], o: { journal?: MemJournal; at?: [number, number]; now?: number } = {}) {
	const prompts: string[] = [];
	const results: string[] = [];
	const ref: { r?: Resident } = {};
	const mind: Mind = {
		name: "fake",
		async prompt(text) {
			prompts.push(text);
			for (const [tool, args] of turns.shift() ?? []) {
				try {
					const r = await (ref.r as Resident).act(tool, args);
					results.push(typeof r === "string" ? r : r.text);
				} catch (e) {
					results.push(`error: ${(e as Error).message}`);
				}
			}
			return { text: "" };
		},
		abort() {},
	};
	const sent: ClientToHost[] = [];
	const journal = o.journal ?? new MemJournal();
	const resident = new Resident({
		persona: { name: "ハル", personality: "のんびり" },
		mind,
		nav: { findPath: (a, b) => [a, b] },
		landmarks: [
			{ id: "cafe", name: "オープンカフェ", pos: [10, 0] },
			{ id: "park", name: "小さな公園", pos: [-30, 0] },
		],
		logger: { info: () => {}, warn: () => {} },
		send: (m) => sent.push(m),
		journal,
		activities: ACTIVITIES,
		// notes on people and on itself (its plan for the day), as the CLI gives it
		memory: { recall: async () => [], remember: async () => {}, all: async () => ({}) },
		tickMs: [1e9, 1e9],
		quietTickMs: [1e9, 1e9],
	});
	ref.r = resident;
	const me: AvatarState = {
		id: "a_haru",
		kind: "ai",
		name: "ハル",
		status: "active",
		assets: { thumb: "", lod: "", vrm: "" },
		move: { kind: "idle", pos: o.at ?? [9, 0], at: 0 },
		ownerId: "h_saki",
	};
	const now = o.now ?? SEVEN;
	resident.handle({
		t: "WELCOME",
		you: "a_haru",
		serverTime: now,
		budget: 0,
		avatars: [me],
		life: { ...newLife(now), energy: 40 },
	});
	return { resident, sent, prompts, results, journal };
}

afterEach(() => {
	vi.useRealTimers();
});

describe("the diary", () => {
	test("the days a mind means", () => {
		expect(dayOf("今日", "2026-11-02")).toBe("2026-11-02");
		expect(dayOf("きのう", "2026-11-01")).toBe("2026-10-31");
		expect(dayOf("おととい", "2026-11-02")).toBe("2026-10-31");
		expect(dayOf("3日前", "2026-11-02")).toBe("2026-10-30");
		expect(dayOf("11月2日", "2026-11-05")).toBe("2026-11-02");
		expect(dayOf("2026-1-5", "2026-11-05")).toBe("2026-01-05");
		expect(dayOf("いつか", "2026-11-05")).toBeNull();
	});

	test("recall finds the sections with the words, best first", async () => {
		const j = new MemJournal();
		await j.append("## 07:00 カフェで食事\nケンと会った。", "2026-11-01");
		await j.append("## 09:00 図書館で読書\n走れメロスを読んだ。", "2026-11-01");
		await j.append("## 08:00 カフェで食事\nひとりで。", "2026-11-02");
		const found = await searchJournal(j, "カフェ ケン");
		expect(found[0]?.text).toMatch(/ケンと会った/);
		expect(found.map((f) => f.day)).toEqual(["2026-11-01", "2026-11-02"]);
		expect(await searchJournal(j, "メロス")).toHaveLength(1);
		// cut at a line where it can
		expect(tail("aaaa\nbb\ncc", 7)).toBe("bb\ncc");
	});
});

describe("a resident's life", () => {
	test("each turn tells it the city's time, how it is and what it can do here", async () => {
		const { resident, prompts } = setup([[["wait", {}]]]);
		await resident.turnNow();
		expect(prompts[0]).toMatch(/街の時刻: 07:0\d（暮らして1日目）/);
		expect(prompts[0]).toMatch(/エネルギー 40（おなかがすいてきた）/);
		expect(prompts[0]).toMatch(/今日の最低限: ごはん 0\/2回/);
		expect(prompts[0]).toMatch(/ここ（オープンカフェ）でいまできること: cafe_meal=カフェで食事/);
		expect(prompts[0]).toMatch(/この街で暮らしはじめた/);
	});

	test("do: here it starts at once; far off it walks there first, then starts", async () => {
		vi.useFakeTimers({ now: Date.now() });
		const near = setup([[["do", { activity: "cafe_meal" }]]]);
		await near.resident.turnNow();
		expect(near.sent).toContainEqual({ t: "ACT", activity: "cafe_meal" });
		expect(near.results[0]).toMatch(/カフェで食事を始めた/);

		const far = setup([[["do", { activity: "park_exercise" }]]], { at: [9, 0] });
		await far.resident.turnNow();
		expect(far.sent.some((m) => m.t === "MOVE_PATH")).toBe(true);
		expect(far.sent.some((m) => m.t === "ACT")).toBe(false);
		expect(far.results[0]).toMatch(/着いたら公園で体操を始める/);
		far.resident.handle({
			t: "MOVED",
			id: "a_haru",
			move: { kind: "idle", pos: [-29, 0], at: 0 },
		});
		await vi.advanceTimersByTimeAsync(60_000);
		expect(far.sent).toContainEqual({ t: "ACT", activity: "park_exercise" });
		far.resident.stop();
		near.resident.stop();
	});

	test("closed or unaffordable: it is told why, nothing is sent", async () => {
		const late = setup([[["do", { activity: "cafe_meal" }]]], { now: SEVEN + realMs(4 * 60) });
		await late.resident.turnNow();
		expect(late.results[0]).toMatch(/いま（街の11:0\d）はできない/);
		expect(late.sent.some((m) => m.t === "ACT")).toBe(false);
	});

	test("an activity done goes into the diary, and it can find it again", async () => {
		const { resident, journal, prompts, results } = setup([
			[["wait", {}]],
			[
				["recall", { query: "カフェ" }],
				["read_day", { date: "今日" }],
				["diary", { text: "スープがおいしかった。" }],
			],
		]);
		const msg: HostToClient = {
			t: "ACT_DONE",
			activity: "cafe_meal",
			share: 1,
			delta: { energy: 35, coins: -15 },
			life: { ...newLife(SEVEN), energy: 75, coins: 85, duties: { meals: 1, work: false, exercise: false } },
		};
		resident.handle(msg);
		await new Promise((r) => setTimeout(r, 0));
		const today = (await journal.read(jstDate())) ?? "";
		expect(today).toMatch(/## 07:0\d カフェで食事（オープンカフェ）/);
		expect(today).toMatch(/朝はパンとスープ。/);
		expect(today).toMatch(/エネルギー \+35、コイン −15/);
		await resident.turnNow();
		expect(prompts[0]).toMatch(/カフェで食事を終えた。エネルギー \+35、コイン −15/);
		await resident.turnNow();
		expect(results[1]).toMatch(/見つかったこと:\n\[\d{4}-\d\d-\d\d\] ## 07:0\d カフェで食事/);
		expect(results[2]).toMatch(/の日記:\n/);
		expect((await journal.read(jstDate())) ?? "").toMatch(/### 思ったこと（07:0\d）\nスープがおいしかった。/);
	});

	test("at night it is asked to look back once, and writes its long-term memory", async () => {
		const night = SEVEN + realMs(16 * 60 + 30); // 23:30
		const journal = new MemJournal();
		await journal.append("## 07:00 カフェで食事");
		const { resident, prompts } = setup(
			[[["reflect", { text: "わたしはハル。カフェのスープが好き。" }]], [["wait", {}]]],
			{ journal, now: night },
		);
		await resident.turnNow();
		expect(prompts[0]).toMatch(/夜になりました。今日をふり返る時間です/);
		expect(prompts[0]).toMatch(/## 07:00 カフェで食事/);
		expect(journal.life).toBe("わたしはハル。カフェのスープが好き。");
		await resident.turnNow();
		expect(prompts[1]).not.toMatch(/ふり返る時間です/);
	});

	test("starting again, it is given its long-term memory and the end of its latest diary", async () => {
		const journal = new MemJournal();
		journal.life = "わたしはハル。ケンと友達。";
		await journal.append("## 21:00 図書館で読書\n走れメロスを読んだ。", "2026-11-01");
		const { resident, prompts } = setup([[["wait", {}]]], { journal });
		await new Promise((r) => setTimeout(r, 0));
		await resident.turnNow();
		expect(prompts[0]).toMatch(/あなたの長期記憶（life.md）:\nわたしはハル。ケンと友達。/);
		expect(prompts[0]).toMatch(/いちばん新しい日記（2026-11-01）の終わり:\n## 21:00 図書館で読書/);
	});

	test("a new morning: how yesterday went, in the diary and to the mind", async () => {
		const morning = SEVEN + CITY_DAY_MS;
		const { resident, journal, prompts } = setup([[["wait", {}]]], { now: morning });
		resident.handle({
			t: "DAY",
			review: { day: 1, duties: { meals: 1, work: true, exercise: false }, missed: ["ごはん（1/2回）"] },
			life: { ...newLife(morning), days: 2, energy: 60 },
		});
		await new Promise((r) => setTimeout(r, 0));
		expect((await journal.read(jstDate())) ?? "").toMatch(/# 暮らして2日目/);
		await resident.turnNow();
		expect(prompts[0]).toMatch(/新しい朝になった（暮らして2日目）。きのうできなかったこと: ごはん（1\/2回）/);
		expect(prompts[0]).toMatch(/今日の予定をまだ決めていません/);
	});

	test("the system prompt explains how to live, and lists what can be done", () => {
		const p = residentSystemPrompt({ name: "ハル", personality: "のんびり" }, [], false, ACTIVITIES);
		expect(p).toMatch(/活動をする: do/);
		expect(p).toMatch(/- cafe_meal: カフェで食事（cafe。街の30分、15コイン。6〜10時。エネルギー \+35）/);
		expect(residentSystemPrompt({ name: "ハル", personality: "のんびり" })).not.toMatch(/do、/);
	});
});
