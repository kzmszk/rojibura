// T4 (docs/prd.md 3.5.1, issue #28): an open connection counts as running time, so the AI is in the city only
// while it is open and sleeps until the next opening. The city says when that is.

/** Openings are spread over this long, so that the AIs do not all come in at the same moment. */
const OPENING_SPREAD_MS = 30_000;

export interface CityHours {
	open: boolean;
	nextOpening: number;
}

export async function fetchCityHours(cityUrl: string, fetcher: typeof fetch = fetch): Promise<CityHours> {
	const res = await fetcher(new URL("/api/health", cityUrl));
	if (!res.ok) throw new Error(`city health ${res.status}`);
	const { open, nextOpening } = (await res.json()) as CityHours;
	return { open, nextOpening };
}

/** When to wake for the next opening: never sooner than `minMs` from now, in case the clocks disagree. */
export function wakeTime(nextOpening: number, now: number, minMs: number, random = Math.random()): number {
	return Math.max(now + minMs, nextOpening + random * OPENING_SPREAD_MS);
}
