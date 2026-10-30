// End-to-end smoke test against a running city-host (default: cf dev on localhost:5173).
//   node apps/city-host/scripts/smoke.ts [baseUrl]
// Logs in two dev users, registers an agent, connects a human and the agent, and checks
// movement, conversation and the agent challenge.

import { NavMesh, type NavMeshData } from "@rojibura/nav";
import {
	authPayload,
	encode,
	exportPublicKey,
	generateAgentKeyPair,
	type HostToClient,
	parseHostMessage,
	signAuth,
} from "@rojibura/protocol";

import { BASE, Client, check, devLogin, WS_BASE } from "./lib.ts";

const health = await (await fetch(`${BASE}/api/health`)).json();
check(health.ok, "health");
const selftest = await (await fetch(`${BASE}/api/dev/selftest`)).json();
check(
	selftest.ed25519?.signVerify && selftest.ed25519?.rejectsOtherPayload,
	"Ed25519 in the Workers runtime",
);

const alice = await devLogin("alice");
const kazu = await devLogin(`smoke-owner-${Date.now() % 100000}`);
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
const mesh = NavMesh.fromJSON((await (await fetch(`${BASE}/test-city/navmesh.json`)).json()) as NavMeshData);
// straight through the fountain (radius 3 m at the origin) must be rejected
h.send({ t: "MOVE_PATH", path: [start as [number, number], [0, 8]], speed: 1.4, seq: 1 });
await h.waitFor("CORRECT");
check(true, "path through the fountain is corrected");
const around = mesh.findPath(start as [number, number], [0, 8]);
check(around && around.length > 2, `navmesh path around the fountain (${around?.length} points)`);
h.send({ t: "MOVE_PATH", path: around ?? [], speed: 1.4, seq: 2 });
await a.waitFor("MOVED", (m) => m.id === me.id && m.move.kind === "path");
check(true, "MOVE_PATH along the navmesh reaches the agent");

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
