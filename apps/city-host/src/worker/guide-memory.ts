// The guide's memory of each person (docs/prd.md 3.5.3), kept in the room's storage:
//   - recent lines in detail (dropped about two days after they are summarized),
//   - one summary per day of what was talked about (60 days),
//   - what the person wants or likes, kept for good and updated whenever a day is summarized.
// Only the memory of the person the guide is talking to goes into its prompt.

import { type AvatarId, sanitizeText, textLength } from "@rojibura/protocol";

/** The part of the Durable Object's synchronous KV storage this needs. */
export interface Kv {
	get<T>(key: string): T | undefined;
	put<T>(key: string, value: T): void;
}

export interface MemoryLine {
	at: number;
	who: "them" | "guide";
	text: string;
}

export interface PersonMemory {
	id: AvatarId;
	name: string;
	firstMet: number;
	lastMet: number;
	/** JST days on which they talked with the guide. */
	visits: number;
	/** What they want, like, promised or struggle with. Kept for good. */
	wishes: string;
	/** One summary per JST day, oldest first. */
	days: { day: string; summary: string }[];
	lines: MemoryLine[];
	/** Lines up to this time are in a day summary. */
	summarizedUntil: number;
}

export interface SummaryJob {
	person: PersonMemory;
	day: string;
	lines: MemoryLine[];
	/** The day's summary so far (a day can be summarized in several parts). */
	previous: string;
}

const HOUR_MS = 3_600_000;
const JST_OFFSET_MS = 9 * HOUR_MS;
/** Lines this recent go into the prompt word for word. */
const DETAIL_MS = 24 * HOUR_MS;
/** Summarized lines are dropped after this long. */
const KEEP_LINES_MS = 48 * HOUR_MS;
const MAX_LINES = 80;
const KEEP_DAYS = 60;
/** A pause this long ends a conversation: what came before is no longer "this conversation". */
const SESSION_GAP_MS = 10 * 60_000;
/** A person's lines are summarized once their conversation has been quiet this long. */
export const SETTLE_MS = 10 * 60_000;

const PENDING = "guide:pending";
const key = (id: AvatarId) => `guide:person:${id}`;

export const jstDay = (t: number) => new Date(t + JST_OFFSET_MS).toISOString().slice(0, 10);
const md = (day: string) => `${Number(day.slice(5, 7))}/${Number(day.slice(8, 10))}`;
const hm = (t: number) => new Date(t + JST_OFFSET_MS).toISOString().slice(11, 16);

function when(at: number, now: number): string {
	const day = jstDay(at);
	if (day === jstDay(now)) return `今日 ${hm(at)}`;
	if (day === jstDay(now - 24 * HOUR_MS)) return `昨日 ${hm(at)}`;
	return `${md(day)} ${hm(at)}`;
}

function dayLabel(day: string, now: number): string {
	if (day === jstDay(now)) return "今日";
	if (day === jstDay(now - 24 * HOUR_MS)) return "昨日";
	return md(day);
}

/** Untrusted text from the city, made safe and short for a prompt. */
function quote(text: string, max = 100): string {
	const t = sanitizeText(text).replace(/[<>]/g, "");
	return textLength(t) > max ? `${[...t].slice(0, max).join("")}…` : t;
}

export class GuideMemory {
	private readonly kv: Kv;
	private readonly guideName: string;

	constructor(kv: Kv, guideName: string) {
		this.kv = kv;
		this.guideName = guideName;
	}

	get(id: AvatarId): PersonMemory | undefined {
		return this.kv.get<PersonMemory>(key(id));
	}

	/** Records one line said by or to the person. */
	remember(person: { id: AvatarId; name: string }, who: MemoryLine["who"], text: string, at: number): void {
		const p = this.get(person.id) ?? {
			id: person.id,
			name: person.name,
			firstMet: at,
			lastMet: at,
			visits: 0,
			wishes: "",
			days: [],
			lines: [],
			summarizedUntil: 0,
		};
		if (p.visits === 0 || jstDay(p.lastMet) !== jstDay(at)) p.visits++;
		p.name = person.name;
		p.lastMet = at;
		p.lines.push({ at, who, text: quote(text, 200) });
		this.pruneLines(p, at);
		this.kv.put(key(p.id), p);
		const pending = this.kv.get<AvatarId[]>(PENDING) ?? [];
		if (!pending.includes(p.id)) this.kv.put(PENDING, [...pending, p.id]);
	}

	/**
	 * What goes into the prompt when talking with this person now: `memory` (who they are to the guide,
	 * what they want, earlier days in summary, earlier today in detail) and `history` (this conversation).
	 */
	recall(id: AvatarId, now: number): { known: boolean; memory: string[]; history: string[] } {
		const p = this.get(id);
		if (!p) return { known: false, memory: [], history: [] };
		const say = (l: MemoryLine) => `${l.who === "them" ? p.name : this.guideName}「${quote(l.text, 60)}」`;

		// this conversation: the trailing lines without a long pause, if it is still going on
		let start = p.lines.length;
		let last = now;
		for (let i = p.lines.length - 1; i >= 0; i--) {
			const l = p.lines[i] as MemoryLine;
			if (last - l.at > SESSION_GAP_MS) break;
			start = i;
			last = l.at;
		}
		const session = p.lines.slice(start);
		const before = p.lines.slice(0, start).filter((l) => now - l.at <= DETAIL_MS);

		const memory = [`初めて会ったのは${md(jstDay(p.firstMet))}。話すのは${p.visits}日目。`];
		if (p.wishes) memory.push(`望んでいること・好み・約束：${p.wishes}`);
		for (const d of p.days.slice(-5)) memory.push(`${dayLabel(d.day, now)}話したこと：${d.summary}`);
		for (const l of before.slice(-8)) memory.push(`${when(l.at, now)} ${say(l)}`);
		return {
			known: true,
			memory,
			history: session.slice(-6).map((l) => `${l.who === "them" ? p.name : this.guideName}: ${l.text}`),
		};
	}

	/** The next person whose conversation has settled and has lines not yet summarized (one day at a time). */
	nextToSummarize(now: number): SummaryJob | null {
		const pending = this.kv.get<AvatarId[]>(PENDING) ?? [];
		const still: AvatarId[] = [];
		let job: SummaryJob | null = null;
		for (const id of pending) {
			const p = this.get(id);
			const fresh = p?.lines.filter((l) => l.at > p.summarizedUntil) ?? [];
			if (!p || fresh.length === 0) continue;
			still.push(id);
			if (job || now - (fresh[fresh.length - 1] as MemoryLine).at < SETTLE_MS) continue;
			const day = jstDay((fresh[0] as MemoryLine).at);
			job = {
				person: p,
				day,
				lines: fresh.filter((l) => jstDay(l.at) === day),
				previous: p.days.find((d) => d.day === day)?.summary ?? "",
			};
		}
		if (still.length !== pending.length) this.kv.put(PENDING, still);
		return job;
	}

	/** Stores a summary: the day's summary, the updated wishes, and how far the lines are covered. */
	saveSummary(job: SummaryJob, summary: string, wishes: string, now: number): void {
		const p = this.get(job.person.id);
		if (!p) return;
		const days = p.days.filter((d) => d.day !== job.day);
		days.push({ day: job.day, summary });
		p.days = days.sort((a, b) => (a.day < b.day ? -1 : 1)).slice(-KEEP_DAYS);
		if (wishes) p.wishes = wishes;
		p.summarizedUntil = Math.max(p.summarizedUntil, (job.lines[job.lines.length - 1] as MemoryLine).at);
		this.pruneLines(p, now);
		this.kv.put(key(p.id), p);
	}

	/** Without an LLM: the day's summary is what they said, cut short. */
	static plainSummary(job: SummaryJob): string {
		const theirs = job.lines.filter((l) => l.who === "them").map((l) => l.text);
		const text = [job.previous, theirs.length > 0 ? `話したこと：${theirs.join("、")}` : "あいさつした"]
			.filter(Boolean)
			.join(" ");
		return textLength(text) > 160 ? `${[...text].slice(0, 159).join("")}…` : text;
	}

	/** The prompt for summarizing one day of a person's conversations with the guide. */
	summaryPrompt(job: SummaryJob): string {
		const p = job.person;
		return [
			"<city_input>",
			`相手：${quote(p.name, 24)}`,
			`日付：${md(job.day)}`,
			`この日の前のまとめ：${job.previous ? quote(job.previous, 160) : "なし"}`,
			`相手が望んでいること・好み・約束（これまで）：${p.wishes ? quote(p.wishes, 200) : "なし"}`,
			`会話：${job.lines.map((l) => `${hm(l.at)} ${l.who === "them" ? quote(p.name, 24) : this.guideName}「${quote(l.text, 100)}」`).join(" / ")}`,
			"</city_input>",
			"次に会ったときのための自分用のメモを書いてください。",
			"summary：この日に何を話したかを1〜2文で。前のまとめがあれば、それも含めて書き直す。",
			"wishes：相手が望んでいること、好み、約束、困っていることを、これまでの内容を保ちながら更新する。新しいことがなければ、これまでの内容をそのまま書く。",
		].join("\n");
	}

	private pruneLines(p: PersonMemory, now: number): void {
		p.lines = p.lines
			.filter((l) => l.at > p.summarizedUntil || now - l.at <= KEEP_LINES_MS)
			.slice(-MAX_LINES);
	}
}

export const MEMORY_SCHEMA = {
	type: "object",
	properties: {
		summary: { type: "string", maxLength: 160 },
		wishes: { type: "string", maxLength: 200 },
	},
	required: ["summary", "wishes"],
	additionalProperties: false,
};
