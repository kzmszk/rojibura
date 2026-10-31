// Billed usage of a deployed Worker from Cloudflare's GraphQL Analytics API (docs/prd.md 2.4, Phase 0 checks).
//   node apps/city-host/scripts/usage.ts --script rojibura-staging --since 2026-10-31T00:00:00Z [--until ...] [--object load]
// Auth: CLOUDFLARE_API_TOKEN, or the token `cf auth login` stored (run `cf auth whoami` first to refresh it).
// Analytics lag a few minutes behind real time.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
	options: {
		script: { type: "string", default: "rojibura-staging" },
		since: { type: "string" },
		until: { type: "string" },
		/** Durable Object name (area id) to narrow the DO numbers to. */
		object: { type: "string" },
		/** Print one row per minute as well. */
		minutes: { type: "boolean", default: false },
		account: { type: "string" },
	},
});
if (!values.since) throw new Error("--since is required (ISO time)");
const since = values.since;
const until = values.until ?? new Date().toISOString();

function token(): string {
	if (process.env.CLOUDFLARE_API_TOKEN) return process.env.CLOUDFLARE_API_TOKEN;
	const file = join(homedir(), ".config/cloudflare/config/default.json");
	return (JSON.parse(readFileSync(file, "utf8")) as { oauth_token: string }).oauth_token;
}

/** --account, CLOUDFLARE_ACCOUNT_ID, or the first account the token can see. */
async function accountId(given: string | undefined): Promise<string> {
	if (given) return given;
	if (process.env.CLOUDFLARE_ACCOUNT_ID) return process.env.CLOUDFLARE_ACCOUNT_ID;
	const r = await fetch("https://api.cloudflare.com/client/v4/accounts", {
		headers: { Authorization: `Bearer ${token()}` },
	});
	const id = ((await r.json()) as { result?: { id: string }[] }).result?.[0]?.id;
	if (!id) throw new Error("no Cloudflare account found; pass --account");
	return id;
}

// biome-ignore lint/suspicious/noExplicitAny: GraphQL results are untyped
async function gql(query: string, variables: Record<string, unknown>): Promise<any> {
	const r = await fetch("https://api.cloudflare.com/client/v4/graphql", {
		method: "POST",
		headers: { Authorization: `Bearer ${token()}`, "Content-Type": "application/json" },
		body: JSON.stringify({ query, variables }),
	});
	const body = (await r.json()) as { data?: unknown; errors?: { message: string }[] };
	if (body.errors?.length) throw new Error(body.errors.map((e) => e.message).join("; "));
	return body.data;
}

// One query per run: the API's rate limit is low. DO metrics are filtered to this script's namespaces below.
const data = await gql(
	`query ($acct: String!, $since: Time!, $until: Time!, $script: String!) {
		viewer { accounts(filter: { accountTag: $acct }) {
			workers: workersInvocationsAdaptive(limit: 500, filter: { scriptName: $script, datetime_geq: $since, datetime_leq: $until }) {
				sum { requests errors subrequests cpuTimeUs }
				dimensions { datetimeMinute status }
			}
			invocations: durableObjectsInvocationsAdaptiveGroups(limit: 500, filter: { scriptName: $script, datetime_geq: $since, datetime_leq: $until }) {
				sum { requests wallTime }
				dimensions { datetimeMinute namespaceId name type }
			}
			periodic: durableObjectsPeriodicGroups(limit: 500, filter: { datetimeMinute_geq: $since, datetimeMinute_leq: $until }) {
				sum { activeTime cpuTime duration inboundWebsocketMsgCount outboundWebsocketMsgCount rowsRead rowsWritten storageWriteUnits }
				max { activeWebsocketConnections memoryUsageBytes }
				dimensions { datetimeMinute namespaceId name }
			}
		} }
	}`,
	{ acct: await accountId(values.account), since, until, script: values.script },
);
const account = data.viewer.accounts[0];
const namespaces = new Set<string>(
	// biome-ignore lint/suspicious/noExplicitAny: see gql
	account.invocations.map((r: any) => r.dimensions.namespaceId as string),
);
// biome-ignore lint/suspicious/noExplicitAny: see gql
const periodic = account.periodic.filter((r: any) => namespaces.has(r.dimensions.namespaceId));

const byObject = (r: { dimensions: { name?: string } }) =>
	!values.object || r.dimensions.name === values.object;
// biome-ignore lint/suspicious/noExplicitAny: see gql
const sum = (rows: any[], f: (r: any) => number) => rows.reduce((a, r) => a + (f(r) ?? 0), 0);
// biome-ignore lint/suspicious/noExplicitAny: see gql
const inv = account.invocations.filter(byObject) as any[];
// biome-ignore lint/suspicious/noExplicitAny: see gql
const per = periodic.filter(byObject) as any[];
const minutesSpan = (Date.parse(until) - Date.parse(since)) / 60_000;

const invByType: Record<string, number> = {};
for (const r of inv) invByType[r.dimensions.type] = (invByType[r.dimensions.type] ?? 0) + r.sum.requests;
const inbound = sum(per, (r) => r.sum.inboundWebsocketMsgCount);
const doRequests = sum(inv, (r) => r.sum.requests);
const report = {
	window: { since, until, minutes: Math.round(minutesSpan * 10) / 10 },
	worker: {
		requests: sum(account.workers, (r) => r.sum.requests),
		errors: sum(account.workers, (r) => r.sum.errors),
		cpuMs: Math.round(sum(account.workers, (r) => r.sum.cpuTimeUs) / 1000),
	},
	durableObjects: {
		object: values.object ?? "(all)",
		invocationsByType: invByType,
		inboundWebsocketMessages: inbound,
		outboundWebsocketMessages: sum(per, (r) => r.sum.outboundWebsocketMsgCount),
		// docs/prd.md 2.4: incoming WebSocket messages are billed at 20:1
		// WebSocket events on hibernatable sockets show up as "hibernation" invocations (inbound counts stay 0)
		billedRequests: Math.round(doRequests - (invByType.hibernation ?? 0) + (invByType.hibernation ?? 0) / 20),
		activeSeconds: Math.round(sum(per, (r) => r.sum.activeTime) / 1e6),
		cpuMs: Math.round(sum(per, (r) => r.sum.cpuTime) / 1000),
		gbSeconds: Math.round(sum(per, (r) => r.sum.duration) * 10) / 10,
		rowsWritten: sum(per, (r) => r.sum.rowsWritten),
		maxConnections: Math.max(0, ...per.map((r) => r.max.activeWebsocketConnections)),
		maxMemoryMB: Math.round(Math.max(0, ...per.map((r) => r.max.memoryUsageBytes)) / 1e5) / 10,
	},
};
console.log(JSON.stringify(report, null, 2));

if (values.minutes) {
	const rows = new Map<string, Record<string, number>>();
	for (const r of per) {
		const m = rows.get(r.dimensions.datetimeMinute) ?? {};
		m.inbound = (m.inbound ?? 0) + r.sum.inboundWebsocketMsgCount;
		m.activeMs = (m.activeMs ?? 0) + Math.round(r.sum.activeTime / 1000);
		m.cpuMs = (m.cpuMs ?? 0) + Math.round(r.sum.cpuTime / 1000);
		m.gbs = Math.round(((m.gbs ?? 0) + r.sum.duration) * 100) / 100;
		m.conns = Math.max(m.conns ?? 0, r.max.activeWebsocketConnections);
		rows.set(r.dimensions.datetimeMinute, m);
	}
	for (const r of inv) {
		const m = rows.get(r.dimensions.datetimeMinute) ?? {};
		m[r.dimensions.type] = (m[r.dimensions.type] ?? 0) + r.sum.requests;
		rows.set(r.dimensions.datetimeMinute, m);
	}
	for (const [t, m] of [...rows].sort()) console.log(t, JSON.stringify(m));
}
