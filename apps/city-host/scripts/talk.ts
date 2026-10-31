// Talks to an AI in the city as a human (dev login) and prints its replies.
//   node apps/city-host/scripts/talk.ts <baseUrl> <AI name> "message" ["message" ...]

import { Client, devLogin, WS_BASE } from "./lib.ts";

const [name, ...lines] = process.argv.slice(3);
const c = new Client(`${WS_BASE}/ws/area/main`, await devLogin("つばさ"));
await c.opened;
const welcome = await c.waitFor("WELCOME");
console.log("here:", welcome.avatars.map((a) => `${a.name}(${a.kind})`).join(", "));
const ai = welcome.avatars.find((a) => a.name === name);
if (!ai) throw new Error(`${name} is not here`);
// anything said to us right after arriving (the guide's welcome)
await new Promise((res) => setTimeout(res, 4000));
for (const m of c.inbox) if (m.t === "SAID" && m.to === welcome.you) console.log(`< ${m.text} (on arrival)`);
c.inbox.length = 0;
for (const text of lines) {
	const t0 = Date.now();
	c.send({ t: "SAY", text, to: ai.id });
	const r = await c.waitFor("SAID", (m) => m.id === ai.id && m.at >= t0 - 1000, 30_000);
	console.log(`> ${text}\n< ${r.text} (${Date.now() - t0} ms)`);
	c.inbox.length = 0;
	await new Promise((res) => setTimeout(res, 1500));
}
c.ws.close();
process.exit(0);
