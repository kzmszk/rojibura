// End-to-end smoke test against a running city-host (default: cf dev on localhost:5173).
//   node apps/city-host/scripts/smoke.ts [baseUrl]
// Logs in two dev users, registers an agent, connects a human and the agent, and checks
// movement, conversation and the agent challenge.

import {
	authPayload,
	encode,
	exportPublicKey,
	generateAgentKeyPair,
	type HostToClient,
	parseHostMessage,
	signAuth,
} from "@rojibura/protocol";

const BASE = process.argv[2] ?? "http://localhost:5173";
const WS_BASE = BASE.replace(/^http/, "ws");

function check(cond: unknown, label: string): void {
	if (!cond) {
		console.error(`FAIL ${label}`);
		process.exit(1);
	}
	console.log(`ok   ${label}`);
}

async function devLogin(name: string): Promise<string> {
	const r = await fetch(`${BASE}/auth/dev/login?name=${encodeURIComponent(name)}`, { redirect: "manual" });
	const cookie = r.headers.get("set-cookie")?.split(";")[0];
	if (!cookie) throw new Error(`login failed for ${name}: ${r.status}`);
	return cookie;
}

class Client {
	readonly inbox: HostToClient[] = [];
	private waiters: { pred: (m: HostToClient) => boolean; resolve: (m: HostToClient) => void }[] = [];
	readonly ws: WebSocket;
	readonly opened: Promise<void>;

	constructor(url: string, cookie?: string) {
		// undici's WebSocket accepts extra headers (non-standard)
		this.ws = new WebSocket(
			url,
			cookie ? ({ headers: { Cookie: cookie } } as unknown as string[]) : undefined,
		);
		this.opened = new Promise((resolve, reject) => {
			this.ws.onopen = () => resolve();
			this.ws.onerror = (e) => reject(new Error(`ws error ${String((e as ErrorEvent).message ?? "")}`));
		});
		this.ws.onmessage = (e) => {
			if (e.data === "pong") return;
			const m = parseHostMessage(String(e.data));
			if (!m) return;
			this.inbox.push(m);
			for (const w of [...this.waiters])
				if (w.pred(m)) {
					this.waiters.splice(this.waiters.indexOf(w), 1);
					w.resolve(m);
				}
		};
	}

	send(msg: Parameters<typeof encode>[0]): void {
		this.ws.send(encode(msg));
	}

	waitFor<T extends HostToClient["t"]>(
		t: T,
		pred: (m: Extract<HostToClient, { t: T }>) => boolean = () => true,
		ms = 5000,
	): Promise<Extract<HostToClient, { t: T }>> {
		const found = this.inbox.find((m) => m.t === t && pred(m as Extract<HostToClient, { t: T }>));
		if (found) return Promise.resolve(found as Extract<HostToClient, { t: T }>);
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error(`timeout waiting for ${t}`)), ms);
			this.waiters.push({
				pred: (m) => m.t === t && pred(m as Extract<HostToClient, { t: T }>),
				resolve: (m) => {
					clearTimeout(timer);
					resolve(m as Extract<HostToClient, { t: T }>);
				},
			});
		});
	}
}

const health = await (await fetch(`${BASE}/api/health`)).json();
check(health.ok, "health");
const selftest = await (await fetch(`${BASE}/api/dev/selftest`)).json();
check(
	selftest.ed25519?.signVerify && selftest.ed25519?.rejectsOtherPayload,
	"Ed25519 in the Workers runtime",
);

const alice = await devLogin("alice");
const kazu = await devLogin("kazu");
const me = await (await fetch(`${BASE}/api/me`, { headers: { Cookie: alice } })).json();
check(me.id?.startsWith("h_"), "dev login and /api/me");

// register an agent owned by kazu
const kp = await generateAgentKeyPair(true);
const reg = await fetch(`${BASE}/api/agents`, {
	method: "POST",
	headers: { Cookie: kazu, "Content-Type": "application/json" },
	body: JSON.stringify({
		name: `ミナ${Date.now() % 1000}`,
		publicKey: await exportPublicKey(kp.publicKey),
		runtime: "node",
	}),
});
const agent = await reg.json();
check(reg.status === 201 && agent.id?.startsWith("a_"), "agent registration");

// unauthenticated WebSocket is refused
const anonRefused = await new Client(`${WS_BASE}/ws/area/main`).opened.then(
	() => false,
	() => true,
);
check(anonRefused, "WebSocket without login is refused");

// human joins
const h = new Client(`${WS_BASE}/ws/area/main`, alice);
await h.opened;
const welcome = await h.waitFor("WELCOME");
check(welcome.you === me.id, "human WELCOME");

// agent with a wrong signature is closed
const bad = new Client(`${WS_BASE}/ws/area/main?agent=${agent.id}`);
await bad.opened;
await bad.waitFor("CHALLENGE");
const badClosed = new Promise<number>((r) => {
	bad.ws.onclose = (e) => r(e.code);
});
bad.send({ t: "AUTH", sig: "AAAA" });
check((await badClosed) === 1008, "bad agent signature is rejected");

// agent joins with the right signature
const a = new Client(`${WS_BASE}/ws/area/main?agent=${agent.id}`);
await a.opened;
const challenge = await a.waitFor("CHALLENGE");
a.send({ t: "AUTH", sig: await signAuth(kp.privateKey, authPayload("main", agent.id, challenge.nonce)) });
await a.waitFor("WELCOME");
await h.waitFor("JOINED", (m) => m.avatar.id === agent.id);
check(true, "agent challenge-response and JOINED");

// movement
const mine = welcome.avatars.find((x) => x.id === me.id);
const start = mine?.move.kind === "idle" ? mine.move.pos : [0, -8];
h.send({ t: "MOVE_PATH", path: [start as [number, number], [5, -12]], speed: 1.4, seq: 1 });
await a.waitFor("MOVED", (m) => m.id === me.id);
check(true, "MOVE_PATH reaches the agent");

// conversation
h.send({ t: "SAY", text: "こんばんは、カフェはどこ？", to: agent.id });
const addressed = await a.waitFor("ADDRESSED");
check(
	addressed.context.nearbyLandmarks.length > 0,
	`ADDRESSED with context (area: ${addressed.context.area})`,
);
a.send({ t: "SAY", text: "こんばんは！カフェは東の方ですよ。", convId: addressed.convId });
const reply = await h.waitFor("SAID", (m) => m.id === agent.id);
check(reply.convId === addressed.convId, "agent reply reaches the human");

// heartbeat auto-response
const pong = new Promise<string>((r) => {
	h.ws.addEventListener("message", (e) => e.data === "pong" && r("pong"));
});
h.ws.send("ping");
check((await pong) === "pong", "ping/pong auto-response");

// leaving
a.ws.close();
await h.waitFor("LEFT", (m) => m.id === agent.id);
check(true, "LEFT on close");
h.ws.close();

const stats = await (await fetch(`${BASE}/api/dev/rooms/main/stats`)).json();
console.log("room stats", JSON.stringify(stats));
process.exit(0);
