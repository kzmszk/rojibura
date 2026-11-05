import type { LLM } from "@rojibura/avatar-sdk";
import type { HostToClient, Vec2 } from "@rojibura/protocol";
import { beforeEach, describe, expect, test } from "vitest";
import { fixedAnswer, GUIDE_DAILY_LLM_CALLS, GUIDE_ID, Guide, type GuideSaved } from "./guide.ts";
import { GuideMemory, type Kv, SETTLE_MS } from "./guide-memory.ts";
import { RoomCore } from "./room-core.ts";
import type { JoinInfo, World } from "./room-types.ts";

type Conn = { name: string; inbox: HostToClient[] };

const world: World = {
	walk: {
		isWalkable: (p) => Math.abs(p[0]) <= 40 && Math.abs(p[1]) <= 40,
		validatePath: (path) => path.every((p) => Math.abs(p[0]) <= 40 && Math.abs(p[1]) <= 40),
		closestPoint: (p) => p,
	},
	landmarks: [
		{ id: "fountain", name: "中央噴水", pos: [0, 12] },
		{ id: "cafe", name: "オープンカフェ", pos: [30, 30] },
	],
	spawn: [0, 0],
	areaName: "テスト街",
};

const human = (id: string, extra: Partial<JoinInfo> = {}): JoinInfo => ({
	id: `h_${id}`,
	kind: "human",
	name: id,
	assets: { thumb: "", lod: "", vrm: "" },
	ownerId: `h_${id}`,
	...extra,
});

function mapKv(): Kv {
	const data = new Map<string, unknown>();
	return {
		get: <T>(k: string) => structuredClone(data.get(k)) as T | undefined,
		put: (k, v) => {
			data.set(k, structuredClone(v));
		},
	};
}

/** A room with the guide. Pass the storage of an earlier setup to model the next visit. */
function setup(llm: LLM | null, kv: Kv = mapKv(), start = Date.UTC(2026, 9, 31, 12)) {
	let now = start;
	let n = 0;
	const deferred: (() => void)[] = [];
	const guideConn: Conn = { name: "guide", inbox: [] };
	let guide: Guide<Conn> | null = null;
	const core = new RoomCore<Conn>(
		{
			send: (c, m) => (c === guideConn ? guide?.onMessage(m) : c.inbox.push(m)),
			close: () => {},
			persist: (c, m) => c === guideConn && guide?.persist(m),
		},
		world,
		() => now,
		() => String(++n),
	);
	const memory = new GuideMemory(kv, "シルベ");
	guide = new Guide<Conn>({
		core,
		conn: guideConn,
		world,
		findPath: (from, to) => [from, to] as Vec2[],
		llm,
		load: () => kv.get<GuideSaved>("guide"),
		save: (s) => kv.put("guide", s),
		memory,
		hoursText: "いつでも",
		clock: () => now,
		random: () => 0.9, // no plaza strolls unless a test wants them
		defer: (fn) => deferred.push(fn),
	});
	const flush = async () => {
		for (const fn of deferred.splice(0)) fn();
		for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0));
	};
	return {
		core,
		guide,
		memory,
		kv,
		flush,
		advance: (ms: number) => {
			now += ms;
		},
	};
}

const said = (c: Conn) => c.inbox.filter((m) => m.t === "SAID") as Extract<HostToClient, { t: "SAID" }>[];

let calls: string[];
const llm: LLM = {
	name: "fake",
	complete: async (req) => {
		calls.push(req.user);
		const props = (req.schema as { properties?: Record<string, unknown> }).properties ?? {};
		if ("summary" in props) return { summary: "歩き方を聞かれて教えた", wishes: "夜の展望デッキに行きたい" };
		return { reply: "噴水の前でお話ししましょう", motion: "wave", goTo: "fountain", endConversation: false };
	},
};

beforeEach(() => {
	calls = [];
});

describe("guide", () => {
	test("is in the area when the first person arrives, and welcomes them once a day", async () => {
		const t = setup(llm);
		const a: Conn = { name: "a", inbox: [] };
		t.guide.ensurePresent();
		t.core.join(a, human("alice"));
		const welcome = a.inbox[0];
		expect(welcome?.t === "WELCOME" && welcome.avatars.map((x) => x.id)).toContain(GUIDE_ID);
		await t.flush();
		expect(said(a).at(-1)).toMatchObject({ id: GUIDE_ID, to: "h_alice" });
		expect(said(a).at(-1)?.text).toContain("ようこそ");
		// leaves and comes back the same day: no second welcome
		t.core.leave(a);
		const again: Conn = { name: "a2", inbox: [] };
		t.core.join(again, human("alice"));
		await t.flush();
		expect(said(again)).toHaveLength(0);
	});

	test("does not welcome people who do not want AIs to talk to them", async () => {
		const t = setup(llm);
		const a: Conn = { name: "a", inbox: [] };
		t.guide.ensurePresent();
		t.core.join(a, human("alice", { allowAiApproach: false }));
		await t.flush();
		expect(said(a)).toHaveLength(0);
	});

	test("answers people with the LLM and how-to-play notes, and remembers the exchange", async () => {
		const t = setup(llm);
		const a: Conn = { name: "a", inbox: [] };
		t.guide.ensurePresent();
		t.core.join(a, human("alice", { allowAiApproach: false }));
		t.core.handle(a, { t: "SAY", to: GUIDE_ID, text: "どうやって歩くの？" });
		await t.flush();
		expect(said(a).at(-1)).toMatchObject({ id: GUIDE_ID, text: "噴水の前でお話ししましょう" });
		expect(a.inbox.some((m) => m.t === "ACTED" && m.id === GUIDE_ID)).toBe(true);
		expect(a.inbox.some((m) => m.t === "MOVED" && m.id === GUIDE_ID)).toBe(true); // walks to the fountain
		expect(t.memory.get("h_alice")?.lines.map((l) => [l.who, l.text])).toEqual([
			["them", "どうやって歩くの？"],
			["guide", "噴水の前でお話ししましょう"],
		]);
	});

	test("remembers people across conversations instead of meeting them anew", async () => {
		const t = setup(llm);
		const a: Conn = { name: "a", inbox: [] };
		t.guide.ensurePresent();
		t.core.join(a, human("alice", { allowAiApproach: false }));
		t.core.handle(a, { t: "SAY", to: GUIDE_ID, text: "歩き方を教えて" });
		await t.flush();
		t.advance(2 * 60 * 60_000); // two hours later, a new conversation
		calls = [];
		t.core.handle(a, { t: "SAY", to: GUIDE_ID, text: "こんにちは" });
		await t.flush();
		const prompt = calls[0] ?? "";
		expect(prompt).not.toContain("初対面");
		expect(prompt).toContain("初めて会ったのは");
		expect(prompt).toContain("歩き方を教えて");
		expect(prompt).toContain("この会話の流れ: （最初の発言）"); // the old talk is memory, not this conversation
	});

	test("summarizes settled conversations into the day's summary and the person's wishes", async () => {
		const t = setup(llm);
		const a: Conn = { name: "a", inbox: [] };
		t.guide.ensurePresent();
		t.core.join(a, human("alice", { allowAiApproach: false }));
		t.core.handle(a, { t: "SAY", to: GUIDE_ID, text: "歩き方を教えて" });
		await t.flush();
		t.advance(SETTLE_MS + 60_000);
		t.guide.tick();
		await t.flush();
		const p = t.memory.get("h_alice");
		expect(p?.days.at(-1)?.summary).toBe("歩き方を聞かれて教えた");
		expect(p?.wishes).toBe("夜の展望デッキに行きたい");
	});

	test("welcomes a known person back the next day, picking up what they talked about", async () => {
		const day1 = setup(llm);
		const a: Conn = { name: "a", inbox: [] };
		day1.guide.ensurePresent();
		day1.core.join(a, human("alice"));
		await day1.flush(); // first welcome
		day1.core.handle(a, { t: "SAY", to: GUIDE_ID, text: "展望デッキに行きたいな" });
		await day1.flush();
		day1.advance(SETTLE_MS + 60_000);
		day1.guide.tick();
		await day1.flush();

		const day2 = setup(llm, day1.kv, Date.UTC(2026, 10, 1, 12));
		const b: Conn = { name: "b", inbox: [] };
		calls = [];
		day2.guide.ensurePresent();
		day2.core.join(b, human("alice"));
		await day2.flush();
		const prompt = calls[0] ?? "";
		expect(prompt).toContain("夜の展望デッキに行きたい"); // wishes
		expect(prompt).toContain("話したこと：歩き方を聞かれて教えた"); // yesterday's summary
		expect(said(b).at(-1)).toMatchObject({ id: GUIDE_ID, to: "h_alice", text: "噴水の前でお話ししましょう" });
	});

	test("never starts talking on its own; walks over to a lone visitor without a word", async () => {
		const t = setup(llm);
		const a: Conn = { name: "a", inbox: [] };
		t.guide.ensurePresent();
		t.core.join(a, human("alice"));
		await t.flush();
		const welcomes = said(a).length;
		const w = a.inbox[0];
		const here = w?.t === "WELCOME" ? w.avatars.find((x) => x.id === "h_alice")?.move : undefined;
		const start = here?.kind === "idle" ? here.pos : ([0, 0] as Vec2);
		t.core.handle(a, { t: "MOVE_PATH", path: [start, [30, 30]], speed: 4, seq: 1 });
		t.advance(60_000);
		// arrived; standing still from now on
		t.core.handle(a, { t: "MOVE_VEL", pos: [30, 30], dir: [0, 0], speed: 0, seq: 2 });
		a.inbox.length = 0;
		for (let i = 0; i < 30; i++) {
			t.guide.tick();
			await t.flush();
			t.advance(60_000);
		}
		expect(a.inbox.some((m) => m.t === "MOVED" && m.id === GUIDE_ID)).toBe(true);
		expect(said(a)).toHaveLength(0);
		expect(welcomes).toBe(1);
	});

	test("falls back to fixed answers without an LLM or past the daily cap", async () => {
		const t = setup(null);
		const a: Conn = { name: "a", inbox: [] };
		t.guide.ensurePresent();
		t.core.join(a, human("alice", { allowAiApproach: false }));
		t.core.handle(a, { t: "SAY", to: GUIDE_ID, text: "どうやって歩くの？" });
		await t.flush();
		expect(said(a).at(-1)?.text).toBe(fixedAnswer("どうやって歩くの？"));
		expect(said(a).at(-1)?.text).toContain("クリック");

		const capped = setup(llm);
		const b: Conn = { name: "b", inbox: [] };
		capped.guide.ensurePresent();
		capped.core.join(b, human("bob", { allowAiApproach: false }));
		for (let i = 0; i < GUIDE_DAILY_LLM_CALLS; i++) {
			capped.core.handle(b, { t: "SAY", to: GUIDE_ID, text: `質問${i}` });
			await capped.flush();
			capped.advance(11_000); // under the per-AI rate limit for people
		}
		calls = [];
		capped.core.handle(b, { t: "SAY", to: GUIDE_ID, text: "話すにはどうするの？" });
		await capped.flush();
		expect(calls).toHaveLength(0);
		expect(said(b).at(-1)?.text).toBe(fixedAnswer("話すにはどうするの？"));
	});

	test("AIs get one friendly line without using the LLM", async () => {
		const t = setup(llm);
		const bot: Conn = { name: "bot", inbox: [] };
		t.guide.ensurePresent();
		t.core.join(bot, {
			id: "a_bot",
			kind: "ai",
			name: "bot",
			assets: { thumb: "", lod: "", vrm: "" },
			ownerId: "h_kazu",
			trust: "approved",
		});
		t.core.handle(bot, { t: "SAY", to: GUIDE_ID, text: "こんにちは" });
		await t.flush();
		expect(calls).toHaveLength(0);
		const answer = bot.inbox.find((m) => m.t === "ADDRESSED");
		expect(answer).toMatchObject({ from: GUIDE_ID });
		if (answer?.t !== "ADDRESSED") throw new Error();
		t.advance(10_000);
		t.core.handle(bot, { t: "SAY", convId: answer.convId, text: "どこから来たの？" });
		await t.flush();
		expect(said(bot).filter((m) => m.id === GUIDE_ID)).toHaveLength(1);
		expect(calls).toHaveLength(0);
	});

	test("comes back silently after the room wakes from hibernation", () => {
		const t = setup(llm);
		const a: Conn = { name: "a", inbox: [] };
		t.guide.ensurePresent();
		t.core.join(a, human("alice", { allowAiApproach: false }));
		expect(t.kv.get<GuideSaved>("guide")?.member?.id).toBe(GUIDE_ID);

		// a new instance on the same storage: alice is restored from her socket, the guide from storage
		const woke = setup(llm, t.kv);
		const a2: Conn = { name: "a", inbox: [] };
		const aliceMember = [...t.core.memberValues()].find((m) => m.id === "h_alice");
		if (!aliceMember) throw new Error();
		woke.core.restore(a2, aliceMember);
		woke.guide.ensurePresent();
		expect([...woke.core.memberValues()].some((m) => m.id === GUIDE_ID)).toBe(true);
		expect(a2.inbox.some((m) => m.t === "JOINED")).toBe(false);
	});
});
