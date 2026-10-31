// Heartbeat-only clients (issue #2): do auto-responded pings wake a hibernated room, and how are they billed?
//   node apps/city-host/scripts/heartbeat.ts [--base URL] [--clients 30] [--minutes 10] [--area ping]
// Clients join, then only send "ping" every 20 seconds. Compare the window with scripts/usage.ts.

import { parseArgs } from "node:util";
import { HEARTBEAT_INTERVAL_MS } from "@rojibura/protocol";
import { devHeaders } from "./lib.ts";

const { values } = parseArgs({
	options: {
		base: { type: "string", default: "http://localhost:5173" },
		clients: { type: "string", default: "30" },
		minutes: { type: "string", default: "10" },
		area: { type: "string", default: "ping" },
	},
});
const BASE = values.base ?? "";
const AREA = values.area ?? "ping";
const N = Number(values.clients);
const run = Date.now().toString(36);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const stats = async () =>
	(await (await fetch(`${BASE}/api/dev/rooms/${AREA}/stats`, { headers: devHeaders })).json()) as {
		sockets: number;
		instanceStartedAt: number;
	};

let pings = 0;
let pongs = 0;
let other = 0;
const closes: number[] = [];
const sockets: WebSocket[] = [];
for (let i = 0; i < N; i++) {
	const r = await fetch(`${BASE}/auth/dev/login?name=hb-${run}-${i}`, {
		redirect: "manual",
		headers: devHeaders,
	});
	const cookie = r.headers.get("set-cookie")?.split(";")[0];
	if (!cookie) throw new Error(`login ${i}: ${r.status}`);
	const ws = new WebSocket(`${BASE.replace(/^http/, "ws")}/ws/area/${AREA}`, {
		headers: { Cookie: cookie },
	} as unknown as string[]);
	ws.onmessage = (e) => {
		if (e.data === "pong") pongs++;
		else other++;
	};
	ws.onclose = (e) => closes.push(e.code);
	await new Promise((res, rej) => {
		ws.onopen = res;
		ws.onerror = rej;
	});
	sockets.push(ws);
}
await sleep(3000);
const before = await stats();
const start = new Date();
console.log(`joined ${N}; heartbeat only from ${start.toISOString()}`);

const end = Date.now() + Number(values.minutes) * 60_000;
// spread the pings over the interval like real clients
const timers: ReturnType<typeof setInterval>[] = [];
sockets.forEach((ws, i) => {
	const tick = () => {
		if (ws.readyState === WebSocket.OPEN) {
			ws.send("ping");
			pings++;
		}
	};
	setTimeout(
		() => {
			tick();
			timers.push(setInterval(tick, HEARTBEAT_INTERVAL_MS));
		},
		(HEARTBEAT_INTERVAL_MS * i) / N,
	);
});
while (Date.now() < end) {
	await sleep(30_000);
	console.log(
		`${new Date().toISOString()} pings ${pings} pongs ${pongs} other ${other} closed ${closes.length}`,
	);
}
const stop = new Date();
for (const t of timers) clearInterval(t);
const after = await stats();
console.log(
	JSON.stringify(
		{
			window: { since: start.toISOString(), until: stop.toISOString() },
			clients: N,
			pings,
			pongs,
			otherMessages: other,
			closed: closes,
			socketsAtEnd: after.sockets,
			// a different instance at the end means the room was evicted and rebuilt (hibernated) in between
			hibernatedDuringWindow: after.instanceStartedAt !== before.instanceStartedAt,
		},
		null,
		2,
	),
);
process.exit(0);
