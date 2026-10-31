// Cloudflare free-tier usage as the host measures it (docs/prd.md 2.5). Shown to admins and in development.

/** Daily free allocations on the Workers Free plan. All reset at 00:00 UTC (9:00 JST). */
export const FREE_TIER = {
	workerRequests: 100_000,
	doRequests: 100_000,
	doGbSeconds: 13_000,
	sqlRowsRead: 5_000_000,
	sqlRowsWritten: 100_000,
	d1RowsRead: 5_000_000,
	d1RowsWritten: 100_000,
	neurons: 10_000,
} as const;

export type UsageKey = keyof typeof FREE_TIER;
export type Usage = Record<UsageKey, number>;

export const USAGE_KEYS = Object.keys(FREE_TIER) as UsageKey[];

export const USAGE_LABELS: Record<UsageKey, string> = {
	workerRequests: "Workers リクエスト",
	doRequests: "DO リクエスト",
	doGbSeconds: "DO 稼働時間（GB-s）",
	sqlRowsRead: "DO ストレージ 読み（行）",
	sqlRowsWritten: "DO ストレージ 書き（行）",
	d1RowsRead: "D1 読み（行）",
	d1RowsWritten: "D1 書き（行）",
	neurons: "Workers AI（Neurons）",
};

/** One thing that used part of the free tier, e.g. "つばさ：発言" with its cost. */
export interface UsageEvent {
	at: number;
	label: string;
	cost: Partial<Usage>;
}

export function emptyUsage(): Usage {
	return Object.fromEntries(USAGE_KEYS.map((k) => [k, 0])) as Usage;
}

export function addUsage(into: Partial<Usage>, cost: Partial<Usage>): void {
	for (const k of USAGE_KEYS) if (cost[k]) into[k] = (into[k] ?? 0) + (cost[k] ?? 0);
}

/** The free-tier day (UTC) a time belongs to. */
export const usageDay = (t: number) => new Date(t).toISOString().slice(0, 10);
