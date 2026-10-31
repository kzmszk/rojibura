import type { LLM } from "@rojibura/avatar-sdk";
import type { HostToClient, Vec2 } from "@rojibura/protocol";
import { beforeEach, describe, expect, test } from "vitest";
import { fixedAnswer, GUIDE_DAILY_LLM_CALLS, GUIDE_ID, Guide, type GuideSaved } from "./guide.ts";
import { type JoinInfo, RoomCore, type World } from "./room-core.ts";

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

function setup(llm: LLM | null) {
	let now = Date.UTC(2026, 9, 31, 12);
	let n = 0;
	const deferred: (() => void)[] = [];
	let saved: GuideSaved | undefined;
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
	guide = new Guide<Conn>({
		core,
		conn: guideConn,
		world,
		findPath: (from, to) => [from, to] as Vec2[],
		llm,
		load: () => saved,
		save: (s) => {
			saved = structuredClone(s);
		},
		hoursText: "いつでも",
		clock: () => now,
		random: () => 0,
		defer: (fn) => deferred.push(fn),
	});
	const flush = async () => {
		for (const fn of deferred.splice(0)) fn();
		await new Promise((r) => setTimeout(r, 0));
	};
	return {
		core,
		guide,
		flush,
		advance: (ms: number) => {
			now += ms;
		},
		saved: () => saved,
	};
}

const said = (c: Conn) => c.inbox.filter((m) => m.t === "SAID") as Extract<HostToClient, { t: "SAID" }>[];

let calls: string[];
const llm: LLM = {
	name: "fake",
	complete: async (req) => {
		calls.push(req.user);
		return { reply: "噴水の前でお話ししましょう", motion: "wave", goTo: "fountain", endConversation: false };
	},
};

beforeEach(() => {
	calls = [];
});

describe("guide", () => {
	test("is in the area when the first person arrives, and greets them once a day", async () => {
		const t = setup(llm);
		const a: Conn = { name: "a", inbox: [] };
		t.guide.ensurePresent();
		t.core.join(a, human("alice"));
		const welcome = a.inbox[0];
		expect(welcome?.t === "WELCOME" && welcome.avatars.map((x) => x.id)).toContain(GUIDE_ID);
		await t.flush();
		expect(said(a).at(-1)).toMatchObject({ id: GUIDE_ID, to: "h_alice" });
		expect(said(a).at(-1)?.text).toContain("ようこそ");
		// leaves and comes back the same day: no second greeting
		t.core.leave(a);
		const again: Conn = { name: "a2", inbox: [] };
		t.core.join(again, human("alice"));
		await t.flush();
		expect(said(again)).toHaveLength(0);
	});

	test("does not greet people who do not want AIs to talk to them", async () => {
		const t = setup(llm);
		const a: Conn = { name: "a", inbox: [] };
		t.guide.ensurePresent();
		t.core.join(a, human("alice", { allowAiApproach: false }));
		await t.flush();
		expect(said(a)).toHaveLength(0);
	});

	test("answers people with the LLM, with how-to-play notes in the prompt", async () => {
		const t = setup(llm);
		const a: Conn = { name: "a", inbox: [] };
		t.guide.ensurePresent();
		t.core.join(a, human("alice", { allowAiApproach: false }));
		t.core.handle(a, { t: "SAY", to: GUIDE_ID, text: "どうやって歩くの？" });
		await t.flush();
		expect(said(a).at(-1)).toMatchObject({ id: GUIDE_ID, text: "噴水の前でお話ししましょう" });
		expect(a.inbox.some((m) => m.t === "ACTED" && m.id === GUIDE_ID)).toBe(true);
		// walks to the landmark it chose
		expect(a.inbox.some((m) => m.t === "MOVED" && m.id === GUIDE_ID)).toBe(true);
		expect(t.guide.llmCallsToday).toBe(1);
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
			capped.advance(11_000); // stay under the per-AI rate limit for people
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
		// the bot keeps talking: the guide does not answer again
		if (answer?.t !== "ADDRESSED") throw new Error();
		t.advance(10_000);
		t.core.handle(bot, { t: "SAY", convId: answer.convId, text: "どこから来たの？" });
		await t.flush();
		expect(said(bot).filter((m) => m.id === GUIDE_ID)).toHaveLength(1);
		expect(calls).toHaveLength(0);
	});

	test("starts a chat with a quiet person nearby, and walks over to a lone visitor", async () => {
		const t = setup(llm);
		const a: Conn = { name: "a", inbox: [] };
		t.guide.ensurePresent();
		t.core.join(a, human("alice"));
		await t.flush(); // greeting
		// alice wanders far off and stays quiet
		const here =
			(a.inbox[0]?.t === "WELCOME" && a.inbox[0].avatars.find((x) => x.id === "h_alice")?.move) || null;
		const start = here && here.kind === "idle" ? here.pos : ([0, 0] as Vec2);
		t.core.handle(a, { t: "MOVE_PATH", path: [start, [30, 30]], speed: 4, seq: 1 });
		t.advance(20 * 60_000);
		a.inbox.length = 0;
		t.guide.tick();
		const walk = a.inbox.find((m) => m.t === "MOVED" && m.id === GUIDE_ID);
		expect(walk).toBeTruthy();
		// once next to her, the guide says something
		t.advance(60_000);
		t.guide.tick();
		await t.flush();
		expect(said(a).at(-1)).toMatchObject({ id: GUIDE_ID, to: "h_alice" });
	});

	test("comes back silently after the room wakes from hibernation", () => {
		const t = setup(llm);
		const a: Conn = { name: "a", inbox: [] };
		t.guide.ensurePresent();
		t.core.join(a, human("alice", { allowAiApproach: false }));
		const saved = t.saved();
		expect(saved?.member?.id).toBe(GUIDE_ID);

		// a new instance: alice is restored from her socket, the guide from storage
		const woke = setup(llm);
		const a2: Conn = { name: "a", inbox: [] };
		const aliceMember = [...t.core.members.values()].find((m) => m.id === "h_alice");
		if (!aliceMember) throw new Error();
		woke.core.restore(a2, aliceMember);
		const g = new Guide<Conn>({
			core: woke.core,
			conn: { name: "guide2", inbox: [] },
			world,
			findPath: (f, to) => [f, to],
			llm,
			load: () => saved,
			save: () => {},
			hoursText: "いつでも",
		});
		g.ensurePresent();
		expect([...woke.core.members.values()].some((m) => m.id === GUIDE_ID)).toBe(true);
		expect(a2.inbox.some((m) => m.t === "JOINED")).toBe(false);
	});
});
