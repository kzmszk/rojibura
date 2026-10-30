// End-to-end check of moderation (docs/prd.md 4.2) against a running city-host in development.
//   node apps/city-host/scripts/moderation.ts [baseUrl]

import { BASE, Client, check, devLogin, WS_BASE } from "./lib.ts";

const run = Date.now() % 100000;
const alice = await devLogin(`mod-alice-${run}`);
const bob = await devLogin(`mod-bob-${run}`);
const moderator = await devLogin(`mod-mod-${run}`);
const me = async (cookie: string) => (await fetch(`${BASE}/api/me`, { headers: { Cookie: cookie } })).json();
const post = (cookie: string, path: string, body: unknown) =>
	fetch(`${BASE}${path}`, {
		method: "POST",
		headers: { Cookie: cookie, "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
const aliceId = (await me(alice)).id as string;
const bobId = (await me(bob)).id as string;

check(
	(await fetch(`${BASE}/api/mod/reports`, { headers: { Cookie: moderator } })).status === 403,
	"reports need a moderator",
);
check((await post(moderator, "/api/dev/role", { role: "moderator" })).ok, "dev: become a moderator");

const a = new Client(`${WS_BASE}/ws/area/main`, alice);
const b = new Client(`${WS_BASE}/ws/area/main`, bob);
await Promise.all([a.opened, b.opened]);
await Promise.all([a.waitFor("WELCOME"), b.waitFor("WELCOME")]);

// bob talks, then alice mutes bob: alice no longer hears him
b.send({ t: "SAY", text: "ひどいことを言う" });
await a.waitFor("SAID", (m) => m.id === bobId);
check(
	(await post(alice, "/api/relations", { targetId: bobId, kind: "mute", on: true })).ok,
	"alice mutes bob",
);
check(((await me(alice)).relations?.mutes ?? []).includes(bobId), "/api/me lists the mute");
await new Promise((r) => setTimeout(r, 1100));
b.send({ t: "SAY", text: "まだ言う" });
const heard = await a
	.waitFor("SAID", (m) => m.text === "まだ言う", 1500)
	.then(
		() => true,
		() => false,
	);
check(!heard, "muted speaker is not delivered");

// alice reports bob; the report carries the recent chat
const rep = await post(alice, "/api/reports", { targetId: bobId, reason: "harassment", note: "しつこい" });
check(rep.status === 201, "report created");
const reports = (await (
	await fetch(`${BASE}/api/mod/reports`, { headers: { Cookie: moderator } })
).json()) as {
	id: string;
	target: { id: string };
	excerpt: { text: string }[];
}[];
const mine = reports.find((r) => r.target.id === bobId);
check(
	mine?.excerpt.some((l) => l.text === "ひどいことを言う"),
	"moderator sees the report with the chat excerpt",
);

// kick: bob is disconnected and cannot come back today
const closed = new Promise<number>((r) => {
	b.ws.onclose = (e) => r(e.code);
});
check(
	(await post(moderator, "/api/mod/action", { action: "kick", subjectId: bobId, reportId: mine?.id })).ok,
	"moderator kicks bob",
);
check((await closed) === 4003, "bob is disconnected (4003)");
await a.waitFor("LEFT", (m) => m.id === bobId && m.reason === "kicked");
check(true, "others see LEFT kicked");
const back = await new Client(`${WS_BASE}/ws/area/main`, bob).opened.then(
	() => true,
	() => false,
);
check(!back, "bob cannot rejoin today");
const open = (await (await fetch(`${BASE}/api/mod/reports`, { headers: { Cookie: moderator } })).json()) as {
	id: string;
}[];
check(!open.some((r) => r.id === mine?.id), "the report is resolved");
check(
	(await post(alice, "/api/relations", { targetId: aliceId, kind: "block", on: true })).status === 400,
	"cannot block yourself",
);
a.ws.close();
process.exit(0);
