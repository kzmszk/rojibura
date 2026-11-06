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
	/** What each area says is there, by AI: where it runs. */
	present: {} as Record<string, Record<string, string | null>>,
	rawDb: null as unknown as DatabaseSync,
	/** The AI's row at the moment each kick reached a room. */
	agentAtKick: [] as unknown[],
}));

vi.mock("cloudflare:workers", () => ({
	env: {
		DEV_AUTH: "0",
		OPEN_HOURS: "always",
		SESSION_SECRET: "test",
		DB: {
			prepare: (sql: string) => fakes.db.prepare(sql),
			batch: (statements: D1PreparedStatement[]) => fakes.db.batch(statements),
		},
		ROOM: {
			getByName: (area: string) => ({
				fetch: async (req: Request) => {
					const url = new URL(req.url);
					if (url.pathname === "/command") {
						const c = (await req.json()) as { op: string; id?: string };
						fakes.commands.push(c);
						if (c.op === "kick")
							fakes.agentAtKick.push(
								fakes.rawDb.prepare("SELECT id FROM agents WHERE id = ?").get(c.id as string),
							);
					}
					return Response.json({ lines: [], present: fakes.present[area] ?? {} });
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
	fakes.db = {
		prepare,
		batch: async (statements: { run: () => Promise<unknown> }[]) => {
			const results = [];
			for (const s of statements) results.push(await s.run());
			return results;
		},
	} as unknown as D1Database;
	fakes.rawDb = db;
	fakes.commands.length = 0;
	fakes.present = {};
	fakes.agentAtKick.length = 0;
	db.exec(
		"INSERT INTO accounts (id, provider, subject, display_name, role, created_at) VALUES ('h_owner', 'dev', 'owner', 'Owner', 'user', 0), ('h_mod', 'dev', 'mod', 'Mod', 'moderator', 0)",
	);
	db.exec(
		"INSERT INTO agents (id, owner_id, name, runtime, public_key, created_at) VALUES ('a_owned', 'h_owner', 'AI', 'node', 'key', 0)",
	);
});

describe("an owner's AIs", () => {
	beforeEach(() => {
		fakes.rawDb.exec(
			"INSERT INTO accounts (id, provider, subject, display_name, role, created_at) VALUES ('h_other', 'dev', 'other', 'Other', 'user', 0)",
		);
		fakes.rawDb.exec(
			"INSERT INTO agents (id, owner_id, name, runtime, public_key, created_at) VALUES ('a_second', 'h_owner', 'Second', 'browser', 'key', 1), ('a_theirs', 'h_other', 'Theirs', 'browser', 'key', 2)",
		);
	});

	test("/api/me lists them all with the limits; the guide and others' AIs are not among them", async () => {
		const me = await request("/api/me", "GET", undefined, "h_owner");
		expect(me.body).toMatchObject({
			id: "h_owner",
			agentLimit: 5,
			agentsAtOnce: 2,
			agents: [
				{ id: "a_owned", runtime: "node" },
				{ id: "a_second", runtime: "browser" },
			],
		});
	});

	test("the status says where each one is, from all areas, and only the owner's", async () => {
		expect(await request("/api/agents/status")).toMatchObject({ status: 401 });
		const area = Object.keys((await import("./world.ts")).AREAS.areas)[0] as string;
		fakes.present[area] = { a_second: "pc" };
		fakes.rawDb.exec(
			"INSERT INTO agent_pc (agent_id, public_key, paired_at) VALUES ('a_second', 'pckey', 7), ('a_theirs', 'pckey', 8)",
		);
		fakes.rawDb.exec(
			"INSERT INTO bans (id, subject_id, subject_kind, until, reason, by, created_at) VALUES ('b1', 'a_owned', 'agent', NULL, 'x', 'h_mod', 0)",
		);
		const status = await request("/api/agents/status", "GET", undefined, "h_owner");
		expect(status.body).toEqual({
			agents: [
				{ id: "a_owned", paired: false, pairedAt: null, area: null, runsOn: null, banned: true },
				{ id: "a_second", paired: true, pairedAt: 7, area, runsOn: "pc", banned: false },
			],
		});
	});

	test("deleting takes it out of the city, then off the list, with what the host keeps of it", async () => {
		fakes.rawDb.exec(
			"INSERT INTO agent_pc (agent_id, public_key, paired_at) VALUES ('a_second', 'pckey', 7)",
		);
		fakes.rawDb.exec("INSERT INTO agent_life (agent_id, data, updated_at) VALUES ('a_second', '{}', 0)");
		fakes.rawDb.exec("INSERT INTO wallets (id, coins, updated_at) VALUES ('a_second', 100, 0)");
		fakes.rawDb.exec(
			"INSERT INTO relations (account_id, target_id, kind, created_at) VALUES ('h_other', 'a_second', 'mute', 0)",
		);

		expect(await request("/api/agents/a_second", "DELETE")).toMatchObject({ status: 401 });
		expect(await request("/api/agents/a_second", "DELETE", undefined, "h_other")).toMatchObject({
			status: 404,
		});
		expect(fakes.commands).toEqual([]);

		expect(await request("/api/agents/a_second", "DELETE", undefined, "h_owner")).toMatchObject({
			status: 200,
		});
		expect(fakes.commands).toContainEqual(expect.objectContaining({ op: "kick", id: "a_second" }));
		// the row was still there when the rooms let it go: their last save of its life must not fail
		expect(fakes.agentAtKick[0]).toBeTruthy();
		for (const [table, col] of [
			["agents", "id"],
			["agent_pc", "agent_id"],
			["agent_life", "agent_id"],
			["wallets", "id"],
			["relations", "target_id"],
		])
			expect(fakes.rawDb.prepare(`SELECT 1 FROM ${table} WHERE ${col} = 'a_second'`).get()).toBeUndefined();
		// the others stay, and a place in the limit is free again
		expect((await request("/api/me", "GET", undefined, "h_owner")).body).toMatchObject({
			agents: [{ id: "a_owned" }],
		});
	});

	test("a banned AI cannot be deleted", async () => {
		fakes.rawDb.exec(
			"INSERT INTO bans (id, subject_id, subject_kind, until, reason, by, created_at) VALUES ('b1', 'a_second', 'agent', NULL, 'x', 'h_mod', 0)",
		);
		expect(await request("/api/agents/a_second", "DELETE", undefined, "h_owner")).toMatchObject({
			status: 409,
		});
		expect(fakes.commands).toEqual([]);
	});
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
