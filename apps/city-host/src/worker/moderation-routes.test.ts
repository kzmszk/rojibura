/// <reference types="node" />
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import init from "../../migrations/0001_init.sql?raw";
import moderation from "../../migrations/0002_moderation.sql?raw";
import onboarding from "../../migrations/0003_onboarding.sql?raw";
import type { Account } from "./db.ts";
import { moderationRoutes } from "./moderation-routes.ts";
import type { RoomCommand } from "./room.ts";
import { AREA_IDS } from "./world.ts";

const account: Account = {
	id: "h_owner",
	provider: "dev",
	subject: "owner",
	display_name: "Owner",
	role: "user",
	allow_ai_approach: 1,
	agent_concurrency: 2,
};
const moderator = { ...account, id: "h_mod", role: "moderator" };
let sqlite: DatabaseSync;
let db: D1Database;
let current: Account | null;
let devAllowed: boolean;
let broadcast: ReturnType<typeof vi.fn<(command: RoomCommand) => Promise<void>>>;
let room: ReturnType<typeof vi.fn<(area: string, command: RoomCommand) => Promise<Response>>>;

beforeEach(() => {
	sqlite = new DatabaseSync(":memory:");
	sqlite.exec(init);
	sqlite.exec(moderation);
	sqlite.exec(onboarding);
	sqlite.exec(
		"INSERT INTO accounts (id, provider, subject, display_name, role, created_at) VALUES ('h_owner','dev','owner','Owner','user',0), ('h_mod','dev','mod','Mod','moderator',0)",
	);
	sqlite.exec(
		"INSERT INTO agents (id, owner_id, name, runtime, public_key, created_at) VALUES ('a_owned','h_owner','Agent','node','key',0)",
	);
	const prepare = (sql: string, values: unknown[] = []) => ({
		bind: (...args: unknown[]) => prepare(sql, args),
		all: async () => ({ results: sqlite.prepare(sql).all(...(values as never[])) }),
		first: async () => sqlite.prepare(sql).get(...(values as never[])) ?? null,
		run: async () => sqlite.prepare(sql).run(...(values as never[])),
	});
	db = { prepare } as unknown as D1Database;
	current = account;
	devAllowed = false;
	broadcast = vi.fn<(command: RoomCommand) => Promise<void>>(async () => {});
	room = vi.fn<(area: string, command: RoomCommand) => Promise<Response>>(async () =>
		Response.json({ lines: [] }),
	);
});

afterEach(() => sqlite.close());

async function route(path: string, method = "POST", body?: unknown) {
	const url = new URL(`https://example.test${path}`);
	const request = new Request(url, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
	return moderationRoutes(request, url, {
		db,
		currentAccount: async () => current,
		devAllowed: () => devAllowed,
		broadcastCommand: broadcast,
		roomCommand: room,
	});
}
async function result(path: string, method = "POST", body?: unknown) {
	const response = await route(path, method, body);
	return response && { status: response.status, body: await response.json() };
}

describe("moderation route contract", () => {
	test("method fallthrough, authorization, and validation precedence", async () => {
		expect(await route("/api/relations", "GET")).toBeNull();
		expect(await route("/api/mod/action", "GET")).toBeNull();
		expect(await route("/api/dev/role", "POST", { role: "admin" })).toBeNull();
		current = null;
		expect(await result("/api/relations", "POST", {})).toEqual({
			status: 401,
			body: { error: "login required" },
		});
		expect(await result("/api/mod/reports", "POST")).toEqual({
			status: 403,
			body: { error: "moderators only" },
		});
		current = moderator;
		expect(await result("/api/mod/onboarding", "POST")).toEqual({ status: 200, body: [] });
		expect(await result("/api/mod/action", "POST", { action: "bogus", subjectId: "bad" })).toEqual({
			status: 400,
			body: { error: "bad subject" },
		});
		expect(await result("/api/relations", "POST", { targetId: "bad", kind: "bad" })).toEqual({
			status: 400,
			body: { error: "bad target" },
		});
		expect(await result("/api/reports", "POST", { targetId: "bad", reason: "bad" })).toEqual({
			status: 400,
			body: { error: "bad target" },
		});
	});
	test.each([1, false, ["note"], { text: "note" }])(
		"rejects non-string report note %j before collecting excerpts",
		async (note) => {
			expect(await result("/api/reports", "POST", { targetId: "a_owned", reason: "spam", note })).toEqual({
				status: 400,
				body: { error: "bad note" },
			});
			expect(room).not.toHaveBeenCalled();
			expect(sqlite.prepare("SELECT * FROM reports").all()).toHaveLength(0);
		},
	);
	test("report validation checks authentication, target and reason before note", async () => {
		current = null;
		expect(await result("/api/reports", "POST", { targetId: "bad", reason: "bad", note: 1 })).toEqual({
			status: 401,
			body: { error: "login required" },
		});
		current = account;
		expect(await result("/api/reports", "POST", { targetId: "bad", reason: "bad", note: 1 })).toEqual({
			status: 400,
			body: { error: "bad target" },
		});
		expect(await result("/api/reports", "POST", { targetId: "a_owned", reason: "bad", note: 1 })).toEqual({
			status: 400,
			body: { error: "bad reason" },
		});
		expect(room).not.toHaveBeenCalled();
		expect(sqlite.prepare("SELECT * FROM reports").all()).toHaveLength(0);
	});
	test.each([
		[{}, ""],
		[{ note: null }, ""],
		[{ note: "hello" }, "hello"],
	])("report accepts note %j", async (input, expected) => {
		expect(
			await result("/api/reports", "POST", { targetId: "a_owned", reason: "spam", ...input }),
		).toMatchObject({
			status: 201,
		});
		expect(sqlite.prepare("SELECT note FROM reports").get()).toMatchObject({ note: expected });
	});
	test.each([1, false, ["a_owned"], { id: "a_owned" }])(
		"rejects non-string report target %j",
		async (targetId) => {
			expect(await result("/api/reports", "POST", { targetId, reason: "spam" })).toEqual({
				status: 400,
				body: { error: "bad target" },
			});
			expect(room).not.toHaveBeenCalled();
			expect(sqlite.prepare("SELECT * FROM reports").all()).toHaveLength(0);
		},
	);
	test.each([1, false, ["h_other"], { id: "h_other" }])(
		"rejects non-string relation target %j",
		async (targetId) => {
			expect(await result("/api/relations", "POST", { targetId, kind: "mute" })).toEqual({
				status: 400,
				body: { error: "bad target" },
			});
			expect(broadcast).not.toHaveBeenCalled();
			expect(sqlite.prepare("SELECT * FROM relations").all()).toHaveLength(0);
		},
	);
	test.each([1, false, ["a_owned"], { id: "a_owned" }])(
		"rejects non-string action subject %j",
		async (subjectId) => {
			current = moderator;
			expect(await result("/api/mod/action", "POST", { action: "kick", subjectId })).toEqual({
				status: 400,
				body: { error: "bad subject" },
			});
			expect(broadcast).not.toHaveBeenCalled();
			expect(sqlite.prepare("SELECT * FROM bans").all()).toHaveLength(0);
			expect(sqlite.prepare("SELECT * FROM mod_actions").all()).toHaveLength(0);
		},
	);
	test.each([1, false, ["reason"], { text: "reason" }])(
		"rejects non-string action reason %j",
		async (reason) => {
			current = moderator;
			expect(
				await result("/api/mod/action", "POST", { action: "kick", subjectId: "a_owned", reason }),
			).toEqual({
				status: 400,
				body: { error: "bad reason" },
			});
			expect(broadcast).not.toHaveBeenCalled();
			expect(sqlite.prepare("SELECT * FROM bans").all()).toHaveLength(0);
			expect(sqlite.prepare("SELECT * FROM mod_actions").all()).toHaveLength(0);
		},
	);
	test("action validation retains authorization and subject precedence", async () => {
		current = null;
		expect(await result("/api/mod/action", "POST", { subjectId: "bad", reason: 1 })).toEqual({
			status: 403,
			body: { error: "moderators only" },
		});
		current = moderator;
		expect(await result("/api/mod/action", "POST", { subjectId: "bad", reason: 1 })).toEqual({
			status: 400,
			body: { error: "bad subject" },
		});
		expect(broadcast).not.toHaveBeenCalled();
		expect(sqlite.prepare("SELECT * FROM mod_actions").all()).toHaveLength(0);
	});
	test.each([{}, { reason: null }, { reason: "" }])("action defaults reason for %j", async (input) => {
		current = moderator;
		expect(
			await result("/api/mod/action", "POST", { action: "kick", subjectId: "a_owned", ...input }),
		).toMatchObject({ status: 200 });
		expect(sqlite.prepare("SELECT reason FROM bans").get()).toMatchObject({ reason: "モデレーション" });
	});
	test.each([["r_1"], { id: "r_1" }, false, 1])(
		"rejects non-string report ID %j before action effects",
		async (reportId) => {
			current = moderator;
			expect(
				await result("/api/mod/action", "POST", { action: "kick", subjectId: "a_owned", reportId }),
			).toEqual({
				status: 400,
				body: { error: "bad report" },
			});
			expect(broadcast).not.toHaveBeenCalled();
			expect(sqlite.prepare("SELECT * FROM bans").all()).toHaveLength(0);
			expect(sqlite.prepare("SELECT * FROM mod_actions").all()).toHaveLength(0);
		},
	);
	test("action validity and permission take precedence over bad report ID", async () => {
		current = moderator;
		for (const [action, subjectId, status, error] of [
			["approve", "a_owned", 403, "admins approve agents"],
			["suspend", "h_owner", 400, "only agents can be suspended"],
			["unknown", "a_owned", 400, "bad action"],
		] as const) {
			expect(await result("/api/mod/action", "POST", { action, subjectId, reportId: [] })).toEqual({
				status,
				body: { error },
			});
		}
		expect(broadcast).not.toHaveBeenCalled();
		expect(sqlite.prepare("SELECT * FROM mod_actions").all()).toHaveLength(0);
	});
	test.each([{}, { reportId: null }, { reportId: "" }])(
		"action accepts optional report ID %j",
		async (input) => {
			current = moderator;
			expect(
				await result("/api/mod/action", "POST", { action: "resolve", subjectId: "a_owned", ...input }),
			).toMatchObject({ status: 200 });
			expect(sqlite.prepare("SELECT action FROM mod_actions").all()).toHaveLength(1);
		},
	);
	test.each([{ body: null }, { body: [] }, { body: "text" }, { body: 1 }])(
		"invalid JSON envelope $body returns field errors without effects",
		async ({ body }) => {
			expect(await result("/api/relations", "POST", body)).toEqual({
				status: 400,
				body: { error: "bad target" },
			});
			expect(await result("/api/reports", "POST", body)).toEqual({
				status: 400,
				body: { error: "bad target" },
			});
			current = moderator;
			expect(await result("/api/mod/action", "POST", body)).toEqual({
				status: 400,
				body: { error: "bad subject" },
			});
			expect(room).not.toHaveBeenCalled();
			expect(broadcast).not.toHaveBeenCalled();
			expect(sqlite.prepare("SELECT * FROM relations").all()).toHaveLength(0);
			expect(sqlite.prepare("SELECT * FROM reports").all()).toHaveLength(0);
			expect(sqlite.prepare("SELECT * FROM mod_actions").all()).toHaveLength(0);
		},
	);
	test("relation writes before notification and defaults on unless false", async () => {
		broadcast.mockImplementationOnce(async () => {
			expect(sqlite.prepare("SELECT target_id, kind FROM relations").get()).toMatchObject({
				target_id: "h_other",
				kind: "mute",
			});
			throw new Error("room unavailable");
		});
		await expect(
			route("/api/relations", "POST", { targetId: "h_other", kind: "mute", on: 0 }),
		).rejects.toThrow("room unavailable");
		expect(broadcast).toHaveBeenCalledWith({
			op: "relation",
			accountId: "h_owner",
			targetId: "h_other",
			kind: "mute",
			on: true,
		});
		expect(await result("/api/relations", "POST", { targetId: "h_other", kind: "mute", on: false })).toEqual({
			status: 200,
			body: { ok: true },
		});
		expect(sqlite.prepare("SELECT * FROM relations").all()).toHaveLength(0);
	});
	test("report truncates note, tolerates excerpt failures, and lists open reports by default", async () => {
		room.mockImplementationOnce(async () => Response.json({ lines: ["first", "second"] }));
		room.mockImplementationOnce(async () => {
			throw new Error("offline");
		});
		const response = await result("/api/reports", "POST", {
			targetId: "a_owned",
			reason: "spam",
			note: "x".repeat(510),
		});
		expect(response).toMatchObject({ status: 201, body: { id: expect.any(String) } });
		expect(room).toHaveBeenCalledTimes(AREA_IDS.length);
		expect(
			sqlite.prepare("SELECT reporter_id, target_id, reason, note, excerpt_json, status FROM reports").get(),
		).toMatchObject({
			reporter_id: "h_owner",
			target_id: "a_owned",
			reason: "spam",
			note: "x".repeat(500),
			excerpt_json: '["first","second"]',
			status: "open",
		});
		current = moderator;
		expect(await result("/api/mod/reports", "GET")).toMatchObject({
			status: 200,
			body: [{ reporter: { name: "Owner" }, target: { name: "Agent" }, note: "x".repeat(500) }],
		});
		expect(await result("/api/mod/reports?status=resolved", "GET")).toEqual({ status: 200, body: [] });
	});
	test("action coercions, expiry, reason truncation and audit follow action", async () => {
		current = moderator;
		const now = 1_700_000_000_000;
		vi.spyOn(Date, "now").mockReturnValue(now);
		try {
			expect(
				await result("/api/mod/action", "POST", { action: "mute", subjectId: "a_owned", minutes: "2" }),
			).toMatchObject({ status: 200 });
			expect(broadcast).toHaveBeenLastCalledWith({ op: "mute", id: "a_owned", until: now + 120_000 });
			expect(
				await result("/api/mod/action", "POST", { action: "mute", subjectId: "a_owned", minutes: 0 }),
			).toMatchObject({ status: 200 });
			expect(broadcast).toHaveBeenLastCalledWith({ op: "mute", id: "a_owned", until: now + 600_000 });
			expect(
				await result("/api/mod/action", "POST", {
					action: "ban",
					subjectId: "h_owner",
					minutes: "3",
					reason: "r".repeat(210),
				}),
			).toMatchObject({ status: 200 });
			expect(sqlite.prepare("SELECT subject_id, subject_kind, until, reason FROM bans").get()).toMatchObject({
				subject_id: "h_owner",
				subject_kind: "account",
				until: now + 180_000,
				reason: "r".repeat(200),
			});
			expect(broadcast.mock.calls.slice(-2).map(([command]) => command)).toEqual([
				{ op: "kick", id: "h_owner" },
				{ op: "kick", id: "a_owned" },
			]);
			expect(sqlite.prepare("SELECT action FROM mod_actions").all()).toHaveLength(3);
		} finally {
			vi.restoreAllMocks();
		}
	});
	test("kick expires at JST midnight and resolves the report", async () => {
		current = moderator;
		const now = Date.UTC(2024, 0, 1, 14, 59);
		vi.spyOn(Date, "now").mockReturnValue(now);
		sqlite.exec(
			"INSERT INTO reports (id, reporter_id, target_id, reason, created_at) VALUES ('r_1','h_owner','a_owned','spam',0)",
		);
		try {
			broadcast.mockImplementationOnce(async () => {
				expect(sqlite.prepare("SELECT until FROM bans").get()).toMatchObject({
					until: Date.UTC(2024, 0, 1, 15),
				});
				expect(sqlite.prepare("SELECT status FROM reports").get()).toMatchObject({ status: "open" });
				expect(sqlite.prepare("SELECT * FROM mod_actions").all()).toHaveLength(0);
			});
			expect(
				await result("/api/mod/action", "POST", { action: "kick", subjectId: "a_owned", reportId: "r_1" }),
			).toMatchObject({ status: 200 });
			expect(sqlite.prepare("SELECT status FROM reports").get()).toMatchObject({ status: "resolved" });
			expect(sqlite.prepare("SELECT action FROM mod_actions").get()).toMatchObject({ action: "kick" });
		} finally {
			vi.restoreAllMocks();
		}
	});
	test("suspend, resolve, and invalid actions preserve their outcomes", async () => {
		current = moderator;
		expect(await result("/api/mod/action", "POST", { action: "suspend", subjectId: "h_owner" })).toEqual({
			status: 400,
			body: { error: "only agents can be suspended" },
		});
		expect(await result("/api/mod/action", "POST", { action: "unknown", subjectId: "a_owned" })).toEqual({
			status: 400,
			body: { error: "bad action" },
		});
		expect(sqlite.prepare("SELECT * FROM mod_actions").all()).toHaveLength(0);
		expect(broadcast).not.toHaveBeenCalled();
		expect(
			await result("/api/mod/action", "POST", { action: "suspend", subjectId: "a_owned" }),
		).toMatchObject({ status: 200 });
		expect(sqlite.prepare("SELECT trust FROM agents").get()).toMatchObject({ trust: "suspended" });
		expect(broadcast).toHaveBeenCalledWith({ op: "kick", id: "a_owned" });
		sqlite.exec(
			"INSERT INTO reports (id, reporter_id, target_id, reason, created_at) VALUES ('r_1','h_owner','a_owned','spam',0)",
		);
		expect(
			await result("/api/mod/action", "POST", { action: "resolve", subjectId: "a_owned", reportId: "r_1" }),
		).toMatchObject({ status: 200 });
		expect(sqlite.prepare("SELECT status FROM reports").get()).toMatchObject({ status: "resolved" });
		expect(sqlite.prepare("SELECT action FROM mod_actions ORDER BY rowid").all()).toEqual([
			{ action: "suspend" },
			{ action: "resolve" },
		]);
	});
	test("report resolution precedes audit insertion", async () => {
		current = moderator;
		sqlite.exec(
			"INSERT INTO reports (id, reporter_id, target_id, reason, created_at) VALUES ('r_1','h_owner','a_owned','spam',0)",
		);
		sqlite.exec(
			"CREATE TRIGGER reject_audit BEFORE INSERT ON mod_actions BEGIN SELECT RAISE(ABORT, 'audit failed'); END",
		);
		await expect(
			route("/api/mod/action", "POST", { action: "resolve", subjectId: "a_owned", reportId: "r_1" }),
		).rejects.toThrow("audit failed");
		expect(sqlite.prepare("SELECT status FROM reports").get()).toMatchObject({ status: "resolved" });
		expect(sqlite.prepare("SELECT * FROM mod_actions").all()).toHaveLength(0);
	});
	test("approval and development role authorization retain their distinct gates", async () => {
		current = moderator;
		expect(await result("/api/mod/action", "POST", { action: "approve", subjectId: "a_owned" })).toEqual({
			status: 403,
			body: { error: "admins approve agents" },
		});
		current = { ...moderator, role: "admin" };
		expect(
			await result("/api/mod/action", "POST", { action: "approve", subjectId: "a_owned" }),
		).toMatchObject({ status: 200 });
		expect(sqlite.prepare("SELECT trust FROM agents WHERE id='a_owned'").get()).toMatchObject({
			trust: "approved",
		});
		devAllowed = true;
		current = account;
		expect(await result("/api/dev/role", "POST", { role: "moderator" })).toMatchObject({ status: 200 });
		expect(sqlite.prepare("SELECT role FROM accounts WHERE id='h_owner'").get()).toMatchObject({
			role: "moderator",
		});
	});
	test("failed notification leaves ban but does not resolve report or log action", async () => {
		current = moderator;
		sqlite.exec(
			"INSERT INTO reports (id, reporter_id, target_id, reason, created_at) VALUES ('r_1','h_owner','a_owned','spam',0)",
		);
		broadcast.mockRejectedValueOnce(new Error("offline"));
		await expect(
			route("/api/mod/action", "POST", { action: "kick", subjectId: "a_owned", reportId: "r_1" }),
		).rejects.toThrow("offline");
		expect(sqlite.prepare("SELECT subject_id, reason FROM bans").get()).toMatchObject({
			subject_id: "a_owned",
			reason: "モデレーション",
		});
		expect(sqlite.prepare("SELECT status FROM reports WHERE id='r_1'").get()).toMatchObject({
			status: "open",
		});
		expect(sqlite.prepare("SELECT * FROM mod_actions").all()).toHaveLength(0);
	});
});
