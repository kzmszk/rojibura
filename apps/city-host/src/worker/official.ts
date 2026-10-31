// Cloudflare's own usage numbers for the whole account today (UTC), from the GraphQL Analytics API
// (docs/prd.md 2.5). They lag a few minutes and the API allows only a few queries, so results are cached.
// Needs CF_ANALYTICS_TOKEN (an API token with Account Analytics: Read) and CF_ACCOUNT_ID.

import { emptyUsage, type Usage, usageDay } from "@rojibura/protocol";

const CACHE_MS = 5 * 60_000;

export interface OfficialUsage {
	configured: boolean;
	day?: string;
	totals?: Usage;
	fetchedAt?: number;
	error?: string;
}

const QUERY = `query ($acct: String!, $since: Time!, $until: Time!) { viewer { accounts(filter: { accountTag: $acct }) {
	workers: workersInvocationsAdaptive(limit: 1, filter: { datetime_geq: $since, datetime_leq: $until }) { sum { requests } }
	doInv: durableObjectsInvocationsAdaptiveGroups(limit: 20, filter: { datetime_geq: $since, datetime_leq: $until }) { sum { requests } dimensions { type } }
	doPer: durableObjectsPeriodicGroups(limit: 1, filter: { datetimeMinute_geq: $since, datetimeMinute_leq: $until }) { sum { duration rowsRead rowsWritten } }
	d1: d1AnalyticsAdaptiveGroups(limit: 1, filter: { datetimeMinute_geq: $since, datetimeMinute_leq: $until }) { sum { rowsRead rowsWritten } }
	ai: aiInferenceAdaptiveGroups(limit: 1, filter: { datetime_geq: $since, datetime_leq: $until }) { sum { totalNeurons } }
} } }`;

interface Result {
	workers: { sum: { requests: number } }[];
	doInv: { sum: { requests: number }; dimensions: { type: string } }[];
	doPer: { sum: { duration: number; rowsRead: number; rowsWritten: number } }[];
	d1: { sum: { rowsRead: number; rowsWritten: number } }[];
	ai: { sum: { totalNeurons: number } }[];
}

let cache: OfficialUsage | null = null;

export async function officialUsage(
	token: string | undefined,
	account: string | undefined,
): Promise<OfficialUsage> {
	if (!token || !account) return { configured: false };
	const now = Date.now();
	const day = usageDay(now);
	if (cache?.fetchedAt && cache.day === day && now - cache.fetchedAt < CACHE_MS) return cache;
	try {
		const r = await fetch("https://api.cloudflare.com/client/v4/graphql", {
			method: "POST",
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
			body: JSON.stringify({
				query: QUERY,
				variables: { acct: account, since: `${day}T00:00:00Z`, until: new Date(now).toISOString() },
			}),
		});
		const body = (await r.json()) as {
			data?: { viewer: { accounts: Result[] } };
			errors?: { message: string }[];
		};
		const a = body.data?.viewer.accounts[0];
		if (!a) throw new Error(body.errors?.map((e) => e.message).join("; ") ?? `HTTP ${r.status}`);
		const totals = emptyUsage();
		totals.workerRequests = a.workers[0]?.sum.requests ?? 0;
		// incoming WebSocket messages ("hibernation" events) are billed at 20:1
		for (const g of a.doInv)
			totals.doRequests += g.dimensions.type === "hibernation" ? g.sum.requests / 20 : g.sum.requests;
		totals.doGbSeconds = a.doPer[0]?.sum.duration ?? 0;
		totals.sqlRowsRead = a.doPer[0]?.sum.rowsRead ?? 0;
		totals.sqlRowsWritten = a.doPer[0]?.sum.rowsWritten ?? 0;
		totals.d1RowsRead = a.d1[0]?.sum.rowsRead ?? 0;
		totals.d1RowsWritten = a.d1[0]?.sum.rowsWritten ?? 0;
		totals.neurons = a.ai[0]?.sum.totalNeurons ?? 0;
		cache = { configured: true, day, totals, fetchedAt: now };
		return cache;
	} catch (e) {
		// keep showing the last good numbers; try again after the cache period
		const error = (e as Error).message;
		if (cache) return { ...cache, error };
		cache = { configured: true, day, fetchedAt: now, error };
		return cache;
	}
}
