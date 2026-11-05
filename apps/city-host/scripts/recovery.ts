import assert from "node:assert/strict";
import { type ChildProcess, fork } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { BASE, Client, devLogin, WS_BASE } from "./lib.ts";

if (process.argv.includes("--drop-client")) {
	const client = new Client(`${WS_BASE}/ws/area/main`, process.env.RJ_RECOVERY_COOKIE);
	await client.opened;
	const welcome = await client.waitFor("WELCOME");
	process.send?.({ ready: welcome.you });
} else {
	await recovery();
}

async function recovery(): Promise<void> {
	const clients: Client[] = [];
	const children: ChildProcess[] = [];
	const tag = `r${Date.now().toString(36)}`;
	const url = `${WS_BASE}/ws/area/main`;
	async function connect(cookie: string): Promise<Client> {
		const client = new Client(url, cookie);
		clients.push(client);
		await client.opened;
		await client.waitFor("WELCOME");
		return client;
	}
	async function abruptClient(cookie: string): Promise<{ child: ChildProcess; id: string }> {
		const child = fork(fileURLToPath(import.meta.url), [BASE, "--drop-client"], {
			env: { ...process.env, RJ_RECOVERY_COOKIE: cookie },
			stdio: ["ignore", "inherit", "inherit", "ipc"],
		});
		children.push(child);
		const message: unknown = (await once(child, "message", { signal: AbortSignal.timeout(10_000) }))[0];
		assert(
			message !== null &&
				typeof message === "object" &&
				"ready" in message &&
				typeof message.ready === "string",
			"child must join before its connection drops",
		);
		return { child, id: message.ready };
	}
	async function drop(child: ChildProcess): Promise<void> {
		const exited = once(child, "exit");
		assert(child.kill("SIGKILL"), "terminate the client without sending a WebSocket close frame");
		await exited;
		await delay(500);
	}
	try {
		const watcher = await connect(await devLogin(`${tag}-watcher`));
		const cookie = await devLogin(`${tag}-returning`);
		const initial = await abruptClient(cookie);
		await watcher.waitFor("JOINED", (m) => m.avatar.id === initial.id);
		watcher.inbox.length = 0;
		await drop(initial.child);
		const text = `${tag}-while-away`;
		watcher.send({ t: "SAY", text });
		await watcher.waitFor("SAID", (m) => m.text === text);
		const back = await connect(cookie);
		const welcome = await back.waitFor("WELCOME");
		assert.equal(welcome.you, initial.id);
		assert.equal(welcome.resumed, true);
		await back.waitFor("SAID", (m) => m.text === text);
		assert.deepEqual(
			back.inbox.slice(0, 3).map((m) => m.t),
			["WELCOME", "WALLET", "SAID"],
		);
		assert(!watcher.inbox.some((m) => m.t === "LEFT" && m.id === initial.id));
		assert(!watcher.inbox.some((m) => m.t === "JOINED" && m.avatar.id === initial.id));
		console.log("ok   abrupt disconnect resumes silently and replays speech after WELCOME and WALLET");

		const current = await connect(cookie);
		assert.equal((await current.waitFor("WELCOME")).resumed, true);
		if (back.ws.readyState !== WebSocket.CLOSED) {
			const oldClosed = once(back.ws, "close", { signal: AbortSignal.timeout(10_000) });
			if (back.ws.readyState === WebSocket.OPEN) back.ws.close(1000, "old connection");
			await oldClosed;
		}
		await delay(200);
		current.send({ t: "SAY", text: `${tag}-current` });
		await watcher.waitFor("SAID", (m) => m.id === initial.id && m.text === `${tag}-current`);
		assert(!watcher.inbox.some((m) => m.t === "LEFT" && m.id === initial.id));
		console.log("ok   replacement and a late close from the old connection keep the new participant");

		current.ws.close(1000, "quit");
		assert.equal((await watcher.waitFor("LEFT", (m) => m.id === initial.id)).reason, "quit");
		const fresh = await connect(cookie);
		assert.notEqual((await fresh.waitFor("WELCOME")).resumed, true);
		await watcher.waitFor("JOINED", (m) => m.avatar.id === initial.id);
		console.log("ok   normal quit leaves immediately and a later connection enters afresh");

		const absent = await abruptClient(await devLogin(`${tag}-absent`));
		await watcher.waitFor("JOINED", (m) => m.avatar.id === absent.id);
		await drop(absent.child);
		assert(!watcher.inbox.some((m) => m.t === "LEFT" && m.id === absent.id));
		assert.equal((await watcher.waitFor("LEFT", (m) => m.id === absent.id, 30_000)).reason, "timeout");
		await delay(200);
		assert.equal(watcher.inbox.filter((m) => m.t === "LEFT" && m.id === absent.id).length, 1);
		console.log("ok   an absent participant leaves once when the recovery timer expires");
	} finally {
		for (const child of children)
			if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		for (const client of clients) if (client.ws.readyState === WebSocket.OPEN) client.ws.close(1000);
	}
}
