// Load test against a running city-host (docs/prd.md 2.4, issue #3).
//   node apps/city-host/scripts/load.ts [--base http://localhost:5173] [--humans 50] [--ais 50] [--seconds 60] [--interval 3000]
// Every client sends one message per interval on average (mostly MOVE_PATH, some SAY), like the cost model.
// Reports delivery latency (host timestamp -> received), messages received per client, and room stats.

import { parseArgs } from "node:util";
import {
	authPayload,
	type ClientToHost,
	encode,
	exportPublicKey,
	generateAgentKeyPair,
	type HostToClient,
	parseHostMessage,
	signAuth,
	type Vec2,
} from "@rojibura/protocol";

const { values } = parseArgs({
	options: {
		base: { type: "string", default: "http://localhost:5173" },
		humans: { type: "string", default: "50" },
		ais: { type: "string", default: "50" },
		seconds: { type: "string", default: "60" },
		interval: { type: "string", default: "3000" },
		area: { type: "string", default: "load" },
	},
});
const BASE = values.base ?? "";
const WS = BASE.replace(/^http/, "ws");
const AREA = values.area ?? "load";
const HUMANS = Number(values.humans);
const AIS = Number(values.ais);
const SECONDS = Number(values.seconds);
const INTERVAL = Number(values.interval);
const run = Date.now().toString(36);

async function devLogin(name: string): Promise<string> {
	const r = await fetch(`${BASE}/auth/dev/login?name=${encodeURIComponent(name)}`, { redirect: "manual" });
	const c = r.headers.get("set-cookie")?.split(";")[0];
	if (!c) throw new Error(`login ${name}: ${r.status}`);
	return c;
}

const latencies: number[] = [];
let received = 0;
let sent = 0;
let notices = 0;
const closes: number[] = [];

class Bot {
	pos: Vec2 = [0, 0];
	ws!: WebSocket;
	id = "";
	others: string[] = [];
	private seq = 0;
	ready: Promise<void>;
	private markReady!: () => void;

	constructor(url: string, init?: { cookie?: string; key?: CryptoKey; agentId?: string }) {
		this.ready = new Promise((r) => {
			this.markReady = r;
		});
		this.ws = new WebSocket(
			url,
			init?.cookie ? ({ headers: { Cookie: init.cookie } } as unknown as string[]) : undefined,
		);
		this.ws.onmessage = async (e) => {
			if (e.data === "pong") return;
			const m = parseHostMessage(String(e.data)) as HostToClient;
			received++;
			const now = Date.now();
			if (m.t === "CHALLENGE" && init?.key && init.agentId) {
				this.ws.send(
					encode({ t: "AUTH", sig: await signAuth(init.key, authPayload(AREA, init.agentId, m.nonce)) }),
				);
			} else if (m.t === "WELCOME") {
				this.id = m.you;
				const me = m.avatars.find((a) => a.id === m.you);
				if (me?.move.kind === "idle") this.pos = me.move.pos;
				this.others = m.avatars.map((a) => a.id).filter((id) => id !== m.you);
				this.markReady();
			} else if (m.t === "MOVED") {
				latencies.push(now - m.move.at);
				if (m.id === this.id && m.move.kind === "path")
					this.pos = m.move.path[m.move.path.length - 1] as Vec2;
				if (m.id === this.id && m.move.kind === "idle") this.pos = m.move.pos;
			} else if (m.t === "SAID") {
				latencies.push(now - m.at);
			} else if (m.t === "CORRECT" && m.move.kind === "idle") {
				this.pos = m.move.pos;
			} else if (m.t === "NOTICE") {
				notices++;
			} else if (m.t === "JOINED") {
				this.others.push(m.avatar.id);
			}
		};
		this.ws.onclose = (e) => closes.push(e.code);
		this.ws.onerror = () => {};
	}

	act(): void {
		if (this.ws.readyState !== WebSocket.OPEN) return;
		let msg: ClientToHost;
		if (Math.random() < 0.15) {
			msg = { t: "SAY", text: `テスト発言 ${this.seq}` };
		} else {
			// short hops near the spawn area keep paths valid in the bounding-box world
			const to: Vec2 = [
				Math.max(-30, Math.min(30, this.pos[0] + (Math.random() - 0.5) * 8)),
				Math.max(-30, Math.min(30, this.pos[1] + (Math.random() - 0.5) * 8)),
			];
			msg = { t: "MOVE_PATH", path: [this.pos, to], speed: 4, seq: ++this.seq };
			this.pos = to;
		}
		this.ws.send(encode(msg));
		sent++;
	}
}

console.log(
	`run ${run}: ${HUMANS} humans + ${AIS} AIs in area "${AREA}" for ${SECONDS}s, 1 msg / ${INTERVAL} ms each`,
);
const bots: Bot[] = [];
for (let i = 0; i < HUMANS; i++) {
	const cookie = await devLogin(`load-h${i}-${run}`);
	bots.push(new Bot(`${WS}/ws/area/${AREA}`, { cookie }));
}
for (let i = 0; i < AIS; i++) {
	const owner = await devLogin(`load-o${Math.floor(i / 2)}-${run}`);
	const kp = await generateAgentKeyPair(true);
	const r = await fetch(`${BASE}/api/agents`, {
		method: "POST",
		headers: { Cookie: owner, "Content-Type": "application/json" },
		body: JSON.stringify({
			name: `bot${i}`,
			publicKey: await exportPublicKey(kp.publicKey),
			runtime: "node",
		}),
	});
	const agent = (await r.json()) as { id: string };
	await fetch(`${BASE}/api/dev/agents/${agent.id}/approve`, { method: "POST" });
	bots.push(new Bot(`${WS}/ws/area/${AREA}?agent=${agent.id}`, { key: kp.privateKey, agentId: agent.id }));
}
await Promise.race([Promise.all(bots.map((b) => b.ready)), new Promise((r) => setTimeout(r, 20_000))]);
const joined = bots.filter((b) => b.id).length;
console.log(`joined: ${joined}/${bots.length}`);

latencies.length = 0;
received = 0;
const t0 = Date.now();
const timers = bots.map((b) =>
	setTimeout(function tick() {
		b.act();
		if (Date.now() - t0 < SECONDS * 1000) setTimeout(tick, INTERVAL * (0.5 + Math.random()));
	}, Math.random() * INTERVAL),
);
const heartbeats = setInterval(() => {
	for (const b of bots) if (b.ws.readyState === WebSocket.OPEN) b.ws.send("ping");
}, 20_000);
await new Promise((r) => setTimeout(r, SECONDS * 1000 + 2000));
for (const t of timers) clearTimeout(t);
clearInterval(heartbeats);

latencies.sort((a, b) => a - b);
const q = (p: number) => latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * p))] ?? NaN;
const elapsed = (Date.now() - t0) / 1000;
const stats = await (await fetch(`${BASE}/api/dev/rooms/${AREA}/stats`)).json();
console.log(
	JSON.stringify(
		{
			joined,
			sent,
			sentPerSec: +(sent / elapsed).toFixed(1),
			receivedTotal: received,
			receivedPerClientPerSec: +(received / joined / elapsed).toFixed(1),
			latencyMs: { p50: q(0.5), p90: q(0.9), p99: q(0.99), max: latencies.at(-1) },
			notices,
			closes: closes.length,
			billedRequestsPerHour: Math.round(((sent / elapsed) * 3600) / 20),
			room: stats.live,
		},
		null,
		1,
	),
);
for (const b of bots) b.ws.close();
await new Promise((r) => setTimeout(r, 500));
process.exit(0);
