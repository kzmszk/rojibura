// Opening hours (docs/prd.md 1.6, 2.4), set by OPEN_HOURS in cloudflare.config.ts:
// "always", or JST hour ranges such as "20-24" or "12-13,20-24" (start inclusive, end exclusive, 0-24).
// Ranges that touch across midnight ("20-24,0-2") form one session, so nobody is closed out at 0:00.

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
export const CLOSING_NOTICE_MS = 10 * 60 * 1000;

export type Hours = "always" | [start: number, end: number][];

/** Opening hours as people should hear them, e.g. "いつでも" or "毎日 20時〜24時". */
export function describeHours(hours: Hours): string {
	if (hours === "always") return "いつでも（開発中のため）";
	return `毎日 ${hours.map(([a, b]) => `${a}時〜${b}時`).join("、")}（日本時間）`;
}

/** Parses OPEN_HOURS. Throws on a malformed value so a bad deploy fails at startup instead of going live. */
export function parseHours(spec: string | undefined): Hours {
	const s = (spec ?? "").trim();
	if (s === "" || s === "always") return "always";
	const ranges = s.split(",").map((part): [number, number] => {
		const m = part.trim().match(/^(\d{1,2})-(\d{1,2})$/);
		const start = Number(m?.[1]);
		const end = Number(m?.[2]);
		if (!m || !(start >= 0 && start < end && end <= 24)) throw new Error(`bad OPEN_HOURS: ${spec}`);
		return [start, end];
	});
	return ranges.sort((a, b) => a[0] - b[0]);
}

function jstMidnight(now: number): number {
	const jst = now + JST_OFFSET_MS;
	return jst - (jst % DAY_MS) - JST_OFFSET_MS;
}

/** Open sessions (epoch ms) from yesterday to tomorrow, with touching ranges merged. */
function sessions(now: number, ranges: [number, number][]): [number, number][] {
	const out: [number, number][] = [];
	for (const day of [-1, 0, 1]) {
		const midnight = jstMidnight(now) + day * DAY_MS;
		for (const [a, b] of ranges) {
			const s: [number, number] = [midnight + a * HOUR_MS, midnight + b * HOUR_MS];
			const last = out[out.length - 1];
			if (last && last[1] >= s[0]) last[1] = Math.max(last[1], s[1]);
			else out.push(s);
		}
	}
	return out;
}

function current(now: number, hours: Hours): [number, number] | null {
	if (hours === "always") return [Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY];
	return sessions(now, hours).find(([s, e]) => s <= now && now < e) ?? null;
}

export function isOpen(now: number, hours: Hours): boolean {
	return current(now, hours) !== null;
}

/** Next opening time (epoch ms). If open now, the current session's opening time (now when always open). */
export function nextOpening(now: number, hours: Hours): number {
	if (hours === "always") return now;
	const open = current(now, hours);
	if (open) return open[0];
	return sessions(now, hours).find(([s]) => s > now)?.[0] ?? now;
}

/** Closing time of the session open now; null when always open or closed. */
export function closingTime(now: number, hours: Hours): number | null {
	if (hours === "always") return null;
	return current(now, hours)?.[1] ?? null;
}
