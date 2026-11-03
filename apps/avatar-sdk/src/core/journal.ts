// An AI's diary and long-term memory (docs/life.md 5): what happened is written by the code, what it thought by
// its mind, and it can read any day back. Kept where the AI runs (a PC's files, later IndexedDB or D1), never on
// the host. This file has what does not depend on where it is kept.

import {
	type AvatarId,
	type ClientToHost,
	DIARY_DAYS_MAX,
	DIARY_PART_MAX,
	DIARY_PARTS_MAX,
} from "@rojibura/protocol";

/** Where the diary is kept. Days are JST dates, "2026-11-02". */
export interface Journal {
	/** Adds to the diary of `day` (today, JST, if omitted). */
	append(text: string, day?: string): Promise<void>;
	/** That day's diary, or null if nothing was written that day. */
	read(day: string): Promise<string | null>;
	/** Days with a diary, oldest first. */
	days(): Promise<string[]>;
	/** The long-term memory (life.md): who it is now, friends, skills, promises, what it wants to do next. */
	readLife(): Promise<string>;
	writeLife(text: string): Promise<void>;
	/** Small things the resident keeps between runs (e.g. which day it last looked back on). */
	getMeta(key: string): Promise<string | null>;
	setMeta(key: string, value: string): Promise<void>;
}

/** Longest long-term memory kept (characters). */
export const LIFE_MAX = 1500;
/** A section found by recall is cut to this many characters. */
const FOUND_MAX = 240;

/** The JST date of `d`: "2026-11-02". */
export function jstDate(d: Date = new Date()): string {
	return new Date(d.getTime() + 9 * 3600_000).toISOString().slice(0, 10);
}

/**
 * The day a mind means: "今日", "きのう"/"昨日", "おととい"/"一昨日", "2026-11-02", "11-02", "11/2", "11月2日".
 * Null if it is none of these.
 */
export function dayOf(raw: string, today: string): string | null {
	const s = raw.trim();
	const back = (n: number) => jstDate(new Date(Date.parse(`${today}T12:00:00+09:00`) - n * 86_400_000));
	if (/^(今日|きょう|today)$/i.test(s)) return today;
	if (/^(昨日|きのう|yesterday)$/i.test(s)) return back(1);
	if (/^(一昨日|おととい)$/.test(s)) return back(2);
	const ago = /^(\d{1,2})日前$/.exec(s);
	if (ago) return back(Number(ago[1]));
	const full = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
	if (full) return `${full[1]}-${full[2]?.padStart(2, "0")}-${full[3]?.padStart(2, "0")}`;
	const md = /^(\d{1,2})(?:[-/]|月)(\d{1,2})日?$/.exec(s);
	if (md) return `${today.slice(0, 4)}-${md[1]?.padStart(2, "0")}-${md[2]?.padStart(2, "0")}`;
	return null;
}

export interface Found {
	day: string;
	text: string;
}

/**
 * Sections of the diary ("## ..." headings) with the words of `query`, the best matches first, newer first
 * among equals. Words are split on spaces and Japanese commas; a section matches if it has any of them.
 */
export async function searchJournal(journal: Journal, query: string, max = 5): Promise<Found[]> {
	const words = query
		.split(/[\s、,。・]+/)
		.map((w) => w.trim())
		.filter((w) => w.length > 0);
	if (words.length === 0) return [];
	const found: (Found & { score: number; order: number })[] = [];
	let order = 0;
	for (const day of await journal.days()) {
		const text = await journal.read(day);
		if (!text) continue;
		for (const section of text.split(/\n(?=#{1,3} )/)) {
			order++;
			const score = words.filter((w) => section.includes(w)).length;
			if (score > 0) found.push({ day, text: cut(section.trim(), FOUND_MAX), score, order });
		}
	}
	return found
		.sort((a, b) => b.score - a.score || b.order - a.order)
		.slice(0, max)
		.map(({ day, text }) => ({ day, text }));
}

/** A page of the diary its owner asked to read (DIARY_ASK, docs/life.md 8). */
export interface DiaryPage {
	/** The day it is, "life" for the long-term memory, or null: no diary yet. */
	day: string | null;
	/** "" if nothing was written that day. */
	text: string;
	/** Days with a diary, oldest first. */
	days: string[];
}

/** The page its owner asks for: a day's diary (the latest if none is asked), or "life", the long-term memory. */
export async function diaryPage(journal: Journal, day?: string): Promise<DiaryPage> {
	const days = await journal.days();
	if (day === "life") return { day, text: await journal.readLife(), days };
	const d = day ?? days.at(-1) ?? null;
	return { day: d, text: (d && (await journal.read(d))) || "", days };
}

/** A page as the DIARY messages that carry it to `to`: from its end if it is longer than they can carry. */
export function diaryMessages(to: AvatarId, page: DiaryPage): Extract<ClientToHost, { t: "DIARY" }>[] {
	const chars = [...page.text];
	const kept = chars.slice(-DIARY_PART_MAX * DIARY_PARTS_MAX);
	const parts = Math.max(1, Math.ceil(kept.length / DIARY_PART_MAX));
	return Array.from({ length: parts }, (_, part) => ({
		t: "DIARY",
		to,
		day: page.day,
		part,
		parts,
		text: kept.slice(part * DIARY_PART_MAX, (part + 1) * DIARY_PART_MAX).join(""),
		...(part === 0 ? { days: page.days.slice(-DIARY_DAYS_MAX) } : {}),
	}));
}

/** The end of a text, at most `max` characters, starting at a line where it can. */
export function tail(text: string, max: number): string {
	const chars = [...text];
	if (chars.length <= max) return text;
	const rest = chars.slice(-max).join("");
	const line = rest.indexOf("\n");
	return line >= 0 && line < max / 2 ? rest.slice(line + 1) : rest;
}

function cut(text: string, max: number): string {
	const chars = [...text];
	return chars.length <= max ? text : `${chars.slice(0, max).join("")}…`;
}
