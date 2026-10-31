import { describe, expect, test } from "vitest";
import { GuideMemory, type Kv, SETTLE_MS } from "./guide-memory.ts";

function mapKv(): Kv & { data: Map<string, unknown> } {
	const data = new Map<string, unknown>();
	return {
		data,
		get: <T>(k: string) => structuredClone(data.get(k)) as T | undefined,
		put: (k, v) => {
			data.set(k, structuredClone(v));
		},
	};
}

// 2026-10-31 in JST is UTC+9
const jst = (d: number, h: number, m = 0) => Date.UTC(2026, 9, d, h - 9, m);
const alice = { id: "h_alice", name: "つばさ" };

describe("guide memory", () => {
	test("a stranger has no memory", () => {
		const mem = new GuideMemory(mapKv(), "シルベ");
		expect(mem.recall("h_alice", jst(31, 20))).toEqual({ known: false, memory: [], history: [] });
	});

	test("this conversation goes to history, earlier today in detail, earlier days as summaries", () => {
		const mem = new GuideMemory(mapKv(), "シルベ");
		// two days ago, summarized
		mem.remember(alice, "them", "古本屋めぐりが好き", jst(29, 21));
		const old = mem.nextToSummarize(jst(29, 22));
		if (!old) throw new Error("expected a job");
		mem.saveSummary(old, "古本屋めぐりの話をした", "昔の詩集を探している", jst(29, 22));
		// this morning
		mem.remember(alice, "them", "歩き方を教えて", jst(31, 10));
		mem.remember(alice, "guide", "地面をクリックすると歩けるよ", jst(31, 10, 1));
		// now
		mem.remember(alice, "them", "また来たよ", jst(31, 20));
		mem.remember(alice, "guide", "おかえり！", jst(31, 20, 1));

		const r = mem.recall("h_alice", jst(31, 20, 2));
		expect(r.known).toBe(true);
		expect(r.history).toEqual(["つばさ: また来たよ", "シルベ: おかえり！"]);
		expect(r.memory[0]).toBe("初めて会ったのは10/29。話すのは2日目。");
		expect(r.memory).toContain("望んでいること・好み・約束：昔の詩集を探している");
		expect(r.memory).toContain("10/29話したこと：古本屋めぐりの話をした");
		expect(r.memory).toContain("今日 10:00 つばさ「歩き方を教えて」");
		expect(r.memory).toContain("今日 10:01 シルベ「地面をクリックすると歩けるよ」");
	});

	test("a conversation is summarized once it settles, one day at a time", () => {
		const mem = new GuideMemory(mapKv(), "シルベ");
		mem.remember(alice, "them", "昨日の話", jst(30, 23, 50));
		mem.remember(alice, "them", "今日の話", jst(31, 0, 5));
		expect(mem.nextToSummarize(jst(31, 0, 6))).toBeNull(); // still talking
		const later = jst(31, 0, 5) + SETTLE_MS + 1;
		const first = mem.nextToSummarize(later);
		expect(first?.day).toBe("2026-10-30");
		expect(first?.lines.map((l) => l.text)).toEqual(["昨日の話"]);
		if (!first) throw new Error();
		mem.saveSummary(first, "昨日のまとめ", "", later);
		const second = mem.nextToSummarize(later);
		expect(second?.day).toBe("2026-10-31");
		if (!second) throw new Error();
		mem.saveSummary(second, "今日のまとめ", "夜景が好き", later);
		expect(mem.nextToSummarize(later)).toBeNull();
		expect(mem.get("h_alice")?.wishes).toBe("夜景が好き");
	});

	test("summarized lines are dropped after two days; wishes stay", () => {
		const mem = new GuideMemory(mapKv(), "シルベ");
		mem.remember(alice, "them", "前の話", jst(28, 20));
		const job = mem.nextToSummarize(jst(28, 21));
		if (!job) throw new Error();
		mem.saveSummary(job, "まとめ", "星を見るのが好き", jst(28, 21));
		mem.remember(alice, "them", "久しぶり", jst(31, 20));
		const p = mem.get("h_alice");
		expect(p?.lines.map((l) => l.text)).toEqual(["久しぶり"]);
		expect(p?.wishes).toBe("星を見るのが好き");
		expect(p?.days).toEqual([{ day: "2026-10-28", summary: "まとめ" }]);
	});

	test("without an LLM the summary keeps what they said", () => {
		const mem = new GuideMemory(mapKv(), "シルベ");
		mem.remember(alice, "them", "カフェはどこ？", jst(31, 20));
		mem.remember(alice, "guide", "あっちだよ", jst(31, 20, 1));
		const job = mem.nextToSummarize(jst(31, 21));
		if (!job) throw new Error();
		expect(GuideMemory.plainSummary(job)).toBe("話したこと：カフェはどこ？");
	});
});
