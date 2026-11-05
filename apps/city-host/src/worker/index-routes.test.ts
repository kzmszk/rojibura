/// <reference types="node" />
import { DatabaseSync } from "node:sqlite";
import { exportPublicKey, generateAgentKeyPair } from "@rojibura/protocol";
import { beforeEach, describe, expect, test, vi } from "vitest";
import init from "../../migrations/0001_init.sql?raw";
import moderation from "../../migrations/0002_moderation.sql?raw";
import onboarding from "../../migrations/0003_onboarding.sql?raw";
import pc from "../../migrations/0004_pc.sql?raw";
import wallets from "../../migrations/0005_wallets.sql?raw";
import life from "../../migrations/0006_life.sql?raw";
import { createSessionToken } from "./session.ts";

const fakes = vi.hoisted(() => ({
	db: null as unknown as D1Database,
	commands: [] as unknown[],
}));

vi.mock("cloudflare:workers", () => ({
	env: {
		DEV_AUTH: "0",
		OPEN_HOURS: "always",
		SESSION_SECRET: "test",
		DB: { prepare: (sql: string) => fakes.db.prepare(sql) },
		ROOM: {
			getByName: () => ({
				fetch: async (req: Request) => {
					if (new URL(req.url).pathname === "/command") fakes.commands.push(await req.json());
					return Response.json({ lines: [], here: false });
				},
			}),
		},
	},
}));
vi.mock("./room.ts", () => ({ CityRoomDO: class {} }));

import worker from "./index.ts";

async function request(path: string, method = "GET", body?: unknown, account?: string) {
	const headers = new Headers();
	if (account) headers.set("Cookie", `rj_session=${await createSessionToken("test", account)}`);
	if (body !== undefined) headers.set("Content-Type", "application/json");
	const res = await worker.fetch(
		new Request(`https://example.test${path}`, {
			method,
			headers,
			...(body !== undefined ? { body: JSON.stringify(body) } : {}),
		}),
		{} as Env,
		{ waitUntil() {} } as unknown as ExecutionContext,
	);
	return { status: res.status, body: await res.json(), usage: res.headers.get("X-RJ-Usage") };
}

beforeEach(() => {
	const db = new DatabaseSync(":memory:");
	for (const sql of [init, moderation, onboarding, pc, wallets, life]) db.exec(sql);
	const prepare = (sql: string, values: unknown[] = []) => ({
		bind: (...args: unknown[]) => prepare(sql, args),
		all: async () => {
			const rows = db.prepare(sql).all(...(values as never[]));
			return { results: rows, meta: { rows_read: rows.length, rows_written: 0 } };
		},
		run: async () => {
			const result = db.prepare(sql).run(...(values as never[]));
			return { results: [], meta: { rows_read: 0, rows_written: Number(result.changes) } };
		},
	});
	fakes.db = { prepare } as unknown as D1Database;
	fakes.commands.length = 0;
	db.exec(
		"INSERT INTO accounts (id, provider, subject, display_name, role, created_at) VALUES ('h_owner', 'dev', 'owner', 'Owner', 'user', 0), ('h_mod', 'dev', 'mod', 'Mod', 'moderator', 0)",
	);
	db.exec(
		"INSERT INTO agents (id, owner_id, name, runtime, public_key, created_at) VALUES ('a_owned', 'h_owner', 'AI', 'node', 'key', 0)",
	);
});

describe("gateway feature routes", () => {
	test("authentication, moderation, dev gate and usage headers", async () => {
		expect(await request("/api/relations", "POST", {})).toMatchObject({
			status: 401,
			body: { error: "login required" },
			usage: expect.stringContaining("workerRequests=1"),
		});
		expect(
			await request("/api/relations", "POST", { targetId: "h_owner", kind: "mute" }, "h_owner"),
		).toMatchObject({ status: 400, body: { error: "bad target" } });
		expect(
			await request("/api/relations", "POST", { targetId: "h_other", kind: "mute" }, "h_owner"),
		).toMatchObject({ status: 200, body: { ok: true } });

		expect((await request("/api/mod/onboarding", "GET", undefined, "h_mod")).status).toBe(200);
		const [anonymous, authenticated] = await Promise.all([
			request("/api/relations", "POST", {}),
			request("/api/relations", "POST", { targetId: "h_other", kind: "block" }, "h_owner"),
		]);
		expect(anonymous.usage).not.toContain("d1Rows");
		expect(authenticated.usage).toContain("d1RowsRead=1");
		expect(authenticated.usage).toContain("d1RowsWritten=1");

		expect(fakes.commands).toContainEqual({
			op: "relation",
			accountId: "h_owner",
			targetId: "h_other",
			kind: "mute",
			on: true,
		});
		expect(await request("/api/mod/reports", "GET", undefined, "h_owner")).toMatchObject({
			status: 403,
			body: { error: "moderators only" },
		});
		expect(await request("/api/mod/reports", "GET", undefined, "h_mod")).toMatchObject({
			status: 200,
			body: [],
		});
		expect(
			await request("/api/mod/action", "POST", { action: "approve", subjectId: "a_owned" }, "h_mod"),
		).toMatchObject({ status: 403, body: { error: "admins approve agents" } });
		expect(await request("/api/dev/role", "POST", { role: "admin" }, "h_owner")).toMatchObject({
			status: 404,
		});
		expect(await request("/api/relations", "GET", undefined, "h_owner")).toMatchObject({ status: 404 });
	});
	test("agent ownership, look and pairing validation", async () => {
		expect(await request("/api/agents", "POST", {})).toMatchObject({ status: 401 });
		expect(await request("/api/agents", "POST", {}, "h_owner")).toMatchObject({
			status: 400,
			body: { error: "bad name" },
		});
		expect(await request("/api/agents/a_owned/look")).toMatchObject({ status: 401 });
		expect(await request("/api/agents/a_owned/look", "GET", undefined, "h_mod")).toMatchObject({
			status: 404,
		});
		expect(await request("/api/agents/a_missing/look", "GET", undefined, "h_owner")).toMatchObject({
			status: 404,
		});
		expect(await request("/api/agents/a_owned/look", "PUT", { preset: "missing" }, "h_owner")).toMatchObject({
			status: 400,
			body: { error: "bad preset" },
		});
		const pairing = await request("/api/agents/a_owned/pair", "POST", undefined, "h_owner");
		expect(pairing).toMatchObject({ status: 200, body: { code: expect.any(String) } });
		expect(await request("/api/agents/a_owned/pair", "GET", undefined, "h_owner")).toMatchObject({
			status: 405,
		});
		expect(await request("/api/pair", "POST", { code: "bad" })).toMatchObject({
			status: 400,
			body: { error: "bad code" },
		});
		expect(await request("/api/pair", "POST", { code: "ABCD2345", publicKey: "bad" })).toMatchObject({
			status: 400,
			body: { error: "bad public key" },
		});
		if (
			typeof pairing.body !== "object" ||
			pairing.body === null ||
			!("code" in pairing.body) ||
			typeof pairing.body.code !== "string"
		)
			throw new Error("missing pairing code");
		const key = await exportPublicKey((await generateAgentKeyPair(true)).publicKey);

		expect(
			await request("/api/agents", "POST", { name: "AI", publicKey: key, runtime: "node" }, "h_owner"),
		).toMatchObject({ status: 201, body: { id: expect.any(String), name: "AI", trust: "provisional" } });

		expect(
			await request("/api/pair", "POST", { code: pairing.body.code.toLowerCase(), publicKey: key }),
		).toMatchObject({
			status: 201,
			body: { id: "a_owned", name: "AI" },
		});
	});
});
