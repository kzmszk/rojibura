// Opening hours: 20:00-24:00 JST every day (docs/prd.md 1.6, 2.4).

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
export const OPEN_HOUR_JST = 20;
export const CLOSE_HOUR_JST = 24;
export const CLOSING_NOTICE_MS = 10 * 60 * 1000;

function jstMidnight(now: number): number {
	const jst = now + JST_OFFSET_MS;
	return jst - (jst % 86_400_000) - JST_OFFSET_MS;
}

export function isOpen(now: number): boolean {
	const hour = Math.floor(((now + JST_OFFSET_MS) % 86_400_000) / 3_600_000);
	return hour >= OPEN_HOUR_JST && hour < CLOSE_HOUR_JST;
}

/** Next opening time (epoch ms). If open now, the current session's opening time. */
export function nextOpening(now: number): number {
	const today = jstMidnight(now) + OPEN_HOUR_JST * 3_600_000;
	if (isOpen(now)) return today;
	return now < today ? today : today + 86_400_000;
}

/** Closing time of the session that is open now. */
export function closingTime(now: number): number {
	return jstMidnight(now) + CLOSE_HOUR_JST * 3_600_000;
}
