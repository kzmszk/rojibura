// D1 access for accounts and agents (docs/prd.md 3.6).

import {
	type LifeState,
	MAX_NAME_LENGTH,
	randomToken,
	START_COINS,
	sanitizeText,
	textLength,
} from "@rojibura/protocol";
import init from "../../migrations/0001_init.sql?raw";
import moderation from "../../migrations/0002_moderation.sql?raw";
import onboarding from "../../migrations/0003_onboarding.sql?raw";
import pc from "../../migrations/0004_pc.sql?raw";
import wallets from "../../migrations/0005_wallets.sql?raw";
import life from "../../migrations/0006_life.sql?raw";
import { newPairCode, PAIR_CODE_TTL_MS } from "./pairing.ts";

const MIGRATIONS = [init, moderation, onboarding, pc, wallets, life];

export const AGENTS_PER_OWNER = 5;

export interface Account {
	id: string;
	provider: string;
	subject: string;
	display_name: string;
	role: string;
	allow_ai_approach: number;
	agent_concurrency: number;
}

export interface Agent {
	id: string;
	owner_id: string;
	name: string;
	runtime: string;
	public_key: string;
	key_revoked_at: number | null;
	trust: "provisional" | "approved" | "suspended";
	/** The preset look chosen when it was registered (PRESETS); null: the default one. */
	preset_id: string | null;
}

let schemaReady: Promise<void> | null = null;

/** Development only: applies the (idempotent) migration on first use. Production uses `cf d1 migrations apply`. */
export function ensureSchema(db: D1Database): Promise<void> {
	schemaReady ??= (async () => {
		const statements = MIGRATIONS.join("\n")
			.split("\n")
			.map((l: string) => l.replace(/--.*$/, ""))
			.join("\n")
			.split(";")
			.map((s: string) => s.trim())
			.filter(Boolean);
		await db.batch(statements.map((s: string) => db.prepare(s)));
	})();
	return schemaReady;
}

export function cleanName(raw: string): string | null {
	const name = sanitizeText(raw);
	return name.length > 0 && textLength(name) <= MAX_NAME_LENGTH ? name : null;
}

export async function findOrCreateAccount(
	db: D1Database,
	provider: string,
	subject: string,
	displayName: string,
): Promise<Account> {
	const found = await db
		.prepare("SELECT * FROM accounts WHERE provider = ? AND subject = ?")
		.bind(provider, subject)
		.first<Account>();
	if (found) return found;
	const id = `h_${randomToken(9)}`;
	const now = Date.now();
	await db.batch([
		db
			.prepare(
				"INSERT INTO accounts (id, provider, subject, display_name, created_at) VALUES (?, ?, ?, ?, ?)",
			)
			.bind(id, provider, subject, displayName, now),
		db.prepare("INSERT OR IGNORE INTO onboarding (account_id, login_at) VALUES (?, ?)").bind(id, now),
	]);
	const created = await db.prepare("SELECT * FROM accounts WHERE id = ?").bind(id).first<Account>();
	if (!created) throw new Error("account insert failed");
	return created;
}

export function findAccount(db: D1Database, provider: string, subject: string): Promise<Account | null> {
	return db
		.prepare("SELECT * FROM accounts WHERE provider = ? AND subject = ?")
		.bind(provider, subject)
		.first<Account>();
}

export async function updateAccount(
	db: D1Database,
	id: string,
	patch: { name?: string; allowAiApproach?: boolean },
): Promise<void> {
	if (patch.name !== undefined)
		await db.prepare("UPDATE accounts SET display_name = ? WHERE id = ?").bind(patch.name, id).run();
	if (patch.allowAiApproach !== undefined)
		await db
			.prepare("UPDATE accounts SET allow_ai_approach = ? WHERE id = ?")
			.bind(patch.allowAiApproach ? 1 : 0, id)
			.run();
}

export function getAccount(db: D1Database, id: string): Promise<Account | null> {
	return db.prepare("SELECT * FROM accounts WHERE id = ?").bind(id).first<Account>();
}

export async function listAgents(db: D1Database, ownerId: string): Promise<Agent[]> {
	const r = await db
		.prepare("SELECT * FROM agents WHERE owner_id = ? ORDER BY created_at")
		.bind(ownerId)
		.all<Agent>();
	return r.results;
}

export async function registerAgent(
	db: D1Database,
	ownerId: string,
	input: {
		name: string;
		publicKey: string;
		runtime: string;
		preset?: string | null;
		/** Provisional unless said otherwise. */
		trust?: "provisional" | "approved";
	},
	/** Agents one account may register; null for no limit (free play, docs/prd.md 3.7). */
	limit: number | null = AGENTS_PER_OWNER,
): Promise<Agent | string> {
	const count = await db
		.prepare("SELECT COUNT(*) AS n FROM agents WHERE owner_id = ?")
		.bind(ownerId)
		.first<{ n: number }>();
	if (limit !== null && (count?.n ?? 0) >= limit) return `AIは1人${limit}体まで登録できます`;
	const id = `a_${randomToken(9)}`;
	await db
		.prepare(
			"INSERT INTO agents (id, owner_id, name, runtime, public_key, trust, preset_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
		)
		.bind(
			id,
			ownerId,
			input.name,
			input.runtime,
			input.publicKey,
			input.trust ?? "provisional",
			input.preset ?? null,
			Date.now(),
		)
		.run();
	const agent = await db.prepare("SELECT * FROM agents WHERE id = ?").bind(id).first<Agent>();
	return agent ?? "登録に失敗しました";
}

export function getAgent(db: D1Database, id: string): Promise<Agent | null> {
	return db.prepare("SELECT * FROM agents WHERE id = ?").bind(id).first<Agent>();
}

// ---- an AI's life (docs/life.md 7.1) ----

/** The AI's life as last saved, or null before its first day. */
export async function lifeOf(db: D1Database, agentId: string): Promise<LifeState | null> {
	const row = await db
		.prepare("SELECT data FROM agent_life WHERE agent_id = ?")
		.bind(agentId)
		.first<{ data: string }>();
	if (!row) return null;
	try {
		return JSON.parse(row.data) as LifeState;
	} catch {
		return null;
	}
}

export async function saveLife(db: D1Database, agentId: string, life: LifeState): Promise<void> {
	await db
		.prepare(
			"INSERT INTO agent_life (agent_id, data, updated_at) VALUES (?, ?, ?) ON CONFLICT (agent_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at",
		)
		.bind(agentId, JSON.stringify(life), Date.now())
		.first();
}

// ---- an AI on its owner's PC (docs/prd.md 3.5.1) ----

/** A fresh one-time code to pair a PC with the agent (it replaces any earlier one; the paired key stays). */
export async function startPairing(
	db: D1Database,
	agentId: string,
): Promise<{ code: string; expiresAt: number }> {
	const code = newPairCode();
	const expiresAt = Date.now() + PAIR_CODE_TTL_MS;
	await db
		.prepare(
			"INSERT INTO agent_pc (agent_id, code, code_expires_at) VALUES (?, ?, ?) ON CONFLICT (agent_id) DO UPDATE SET code = excluded.code, code_expires_at = excluded.code_expires_at",
		)
		.bind(agentId, code, expiresAt)
		.run();
	return { code, expiresAt };
}

/** Registers the PC's key for the agent whose code this is; the code is spent. Null if it is unknown or late. */
export async function pairPc(db: D1Database, code: string, publicKey: string): Promise<Agent | null> {
	const row = await db
		.prepare("SELECT agent_id FROM agent_pc WHERE code = ? AND code_expires_at >= ?")
		.bind(code, Date.now())
		.first<{ agent_id: string }>();
	if (!row) return null;
	await db
		.prepare(
			"UPDATE agent_pc SET public_key = ?, paired_at = ?, code = NULL, code_expires_at = NULL WHERE agent_id = ?",
		)
		.bind(publicKey, Date.now(), row.agent_id)
		.run();
	return getAgent(db, row.agent_id);
}

/** The PC's key and when it was paired, or null if no PC is. */
export function pcOf(
	db: D1Database,
	agentId: string,
): Promise<{ public_key: string; paired_at: number } | null> {
	return db
		.prepare("SELECT public_key, paired_at FROM agent_pc WHERE agent_id = ? AND public_key IS NOT NULL")
		.bind(agentId)
		.first<{ public_key: string; paired_at: number }>();
}

/** AIs waiting for an admin's approval, oldest first (docs/prd.md 2.2.4). */
export async function listProvisionalAgents(
	db: D1Database,
): Promise<
	{ id: string; name: string; runtime: string; owner_id: string; owner_name: string; created_at: number }[]
> {
	const r = await db
		.prepare(
			"SELECT a.id, a.name, a.runtime, a.owner_id, o.display_name AS owner_name, a.created_at FROM agents a JOIN accounts o ON o.id = a.owner_id WHERE a.trust = 'provisional' ORDER BY a.created_at LIMIT 200",
		)
		.all<{
			id: string;
			name: string;
			runtime: string;
			owner_id: string;
			owner_name: string;
			created_at: number;
		}>();
	return r.results;
}

/** Which of an owner's AIs are paired with a PC, and since when. */
export async function pairedPcsOf(db: D1Database, ownerId: string): Promise<Map<string, number | null>> {
	const r = await db
		.prepare(
			"SELECT p.agent_id, p.paired_at FROM agent_pc p JOIN agents a ON a.id = p.agent_id WHERE a.owner_id = ? AND p.public_key IS NOT NULL",
		)
		.bind(ownerId)
		.all<{ agent_id: string; paired_at: number | null }>();
	return new Map(r.results.map((p) => [p.agent_id, p.paired_at]));
}

/**
 * Removes an AI for good, and what the host keeps of it. Reports and bans about it stay: they are the
 * moderators' record, not the AI's. Its place in the owner's limit is free again.
 */
export async function deleteAgent(db: D1Database, id: string): Promise<void> {
	await db.batch([
		db.prepare("DELETE FROM agent_pc WHERE agent_id = ?").bind(id),
		db.prepare("DELETE FROM agent_life WHERE agent_id = ?").bind(id),
		db.prepare("DELETE FROM wallets WHERE id = ?").bind(id),
		db.prepare("DELETE FROM relations WHERE target_id = ?").bind(id),
		db.prepare("DELETE FROM agents WHERE id = ?").bind(id),
	]);
}

/** Forgets the PC (and any code not yet used): only the browser's key lets the agent in again. */
export async function unpairPc(db: D1Database, agentId: string): Promise<void> {
	await db.prepare("DELETE FROM agent_pc WHERE agent_id = ?").bind(agentId).run();
}

/** Changes the look an AI comes in with (a PRESETS id): from its next entry on. */
export async function setAgentPreset(db: D1Database, id: string, preset: string): Promise<void> {
	await db.prepare("UPDATE agents SET preset_id = ? WHERE id = ?").bind(preset, id).run();
}

export async function setAgentTrust(db: D1Database, id: string, trust: Agent["trust"]): Promise<void> {
	await db.prepare("UPDATE agents SET trust = ? WHERE id = ?").bind(trust, id).run();
}

/** True if any of the subjects has an active ban. */
export async function isBanned(db: D1Database, subjectIds: string[], now = Date.now()): Promise<boolean> {
	if (subjectIds.length === 0) return false;
	const marks = subjectIds.map(() => "?").join(",");
	const row = await db
		.prepare(`SELECT 1 FROM bans WHERE subject_id IN (${marks}) AND (until IS NULL OR until > ?) LIMIT 1`)
		.bind(...subjectIds, now)
		.first();
	return row !== null;
}

/** Those of `subjectIds` under a ban now. */
export async function bannedAmong(
	db: D1Database,
	subjectIds: string[],
	now = Date.now(),
): Promise<Set<string>> {
	if (subjectIds.length === 0) return new Set();
	const marks = subjectIds.map(() => "?").join(",");
	const r = await db
		.prepare(`SELECT subject_id FROM bans WHERE subject_id IN (${marks}) AND (until IS NULL OR until > ?)`)
		.bind(...subjectIds, now)
		.all<{ subject_id: string }>();
	return new Set(r.results.map((b) => b.subject_id));
}

// ---- moderation (docs/prd.md 4.2) ----------------------------------------------

export type RelationKind = "mute" | "block";

export interface Relations {
	/** Avatars this account muted or blocked. */
	mutes: string[];
	blocks: string[];
	/** Accounts that blocked this avatar. */
	blockedBy: string[];
}

export async function setRelation(
	db: D1Database,
	accountId: string,
	targetId: string,
	kind: RelationKind,
	on: boolean,
): Promise<void> {
	await (on
		? db
				.prepare(
					"INSERT OR IGNORE INTO relations (account_id, target_id, kind, created_at) VALUES (?, ?, ?, ?)",
				)
				.bind(accountId, targetId, kind, Date.now())
		: db
				.prepare("DELETE FROM relations WHERE account_id = ? AND target_id = ? AND kind = ?")
				.bind(accountId, targetId, kind)
	).run();
}

/** The coins in someone's wallet (docs/prd.md 3.8.6); a new wallet is made with START_COINS. */
export async function walletOf(db: D1Database, avatarId: string): Promise<number> {
	await db
		.prepare("INSERT INTO wallets (id, coins, updated_at) VALUES (?, ?, ?) ON CONFLICT (id) DO NOTHING")
		.bind(avatarId, START_COINS, Date.now())
		.run();
	const row = await db
		.prepare("SELECT coins FROM wallets WHERE id = ?")
		.bind(avatarId)
		.first<{ coins: number }>();
	return row?.coins ?? START_COINS;
}

/** Adds to (or takes from) a wallet. */
export async function addToWallet(db: D1Database, avatarId: string, delta: number): Promise<void> {
	await db
		.prepare("UPDATE wallets SET coins = coins + ?, updated_at = ? WHERE id = ?")
		.bind(delta, Date.now(), avatarId)
		.run();
}

/** Relations that matter for one avatar: its own mutes/blocks (if it is a human) and who blocked it. */
export async function relationsOf(db: D1Database, avatarId: string): Promise<Relations> {
	const r = await db
		.prepare(
			"SELECT account_id, target_id, kind FROM relations WHERE account_id = ? OR (target_id = ? AND kind = 'block')",
		)
		.bind(avatarId, avatarId)
		.all<{ account_id: string; target_id: string; kind: RelationKind }>();
	const rows = r.results;
	return {
		mutes: rows.filter((x) => x.account_id === avatarId && x.kind === "mute").map((x) => x.target_id),
		blocks: rows.filter((x) => x.account_id === avatarId && x.kind === "block").map((x) => x.target_id),
		blockedBy: rows.filter((x) => x.target_id === avatarId && x.kind === "block").map((x) => x.account_id),
	};
}

export interface Report {
	id: string;
	reporter_id: string;
	target_id: string;
	reason: string;
	note: string;
	excerpt_json: string;
	status: string;
	created_at: number;
}

export async function createReport(
	db: D1Database,
	r: { reporterId: string; targetId: string; reason: string; note: string; excerpt: unknown[] },
): Promise<string> {
	const id = `r_${randomToken(9)}`;
	await db
		.prepare(
			"INSERT INTO reports (id, reporter_id, target_id, reason, note, excerpt_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
		)
		.bind(id, r.reporterId, r.targetId, r.reason, r.note, JSON.stringify(r.excerpt), Date.now())
		.run();
	return id;
}

export async function listReports(db: D1Database, status = "open"): Promise<Report[]> {
	const r = await db
		.prepare("SELECT * FROM reports WHERE status = ? ORDER BY created_at DESC LIMIT 100")
		.bind(status)
		.all<Report>();
	return r.results;
}

export async function resolveReport(db: D1Database, id: string): Promise<void> {
	await db.prepare("UPDATE reports SET status = 'resolved' WHERE id = ?").bind(id).run();
}

export async function addBan(
	db: D1Database,
	b: { subjectId: string; kind: "account" | "agent"; until: number | null; reason: string; by: string },
): Promise<void> {
	await db
		.prepare(
			"INSERT INTO bans (id, subject_id, subject_kind, until, reason, by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
		)
		.bind(`b_${randomToken(9)}`, b.subjectId, b.kind, b.until, b.reason, b.by, Date.now())
		.run();
}

export async function logModAction(
	db: D1Database,
	a: { actorId: string; action: string; subjectId: string; detail: unknown },
): Promise<void> {
	await db
		.prepare(
			"INSERT INTO mod_actions (id, actor_id, action, subject_id, detail_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
		)
		.bind(`m_${randomToken(9)}`, a.actorId, a.action, a.subjectId, JSON.stringify(a.detail), Date.now())
		.run();
}

export async function setRole(
	db: D1Database,
	id: string,
	role: "admin" | "moderator" | "user",
): Promise<void> {
	await db.prepare("UPDATE accounts SET role = ? WHERE id = ?").bind(role, id).run();
}

// ---- onboarding (#23) ----

export type OnboardingStep = "entered_at" | "avatar_at" | "ai_at";

/** Records the first time an account reached a step (later calls write nothing). */
export async function markOnboarding(db: D1Database, accountId: string, step: OnboardingStep): Promise<void> {
	await db
		.prepare(`UPDATE onboarding SET ${step} = ? WHERE account_id = ? AND ${step} IS NULL`)
		.bind(Date.now(), accountId)
		.run();
}

/** The browser's first visit, if it came before the login (a later first visit is another device). */
export async function setFirstVisit(db: D1Database, accountId: string, at: number): Promise<void> {
	await db
		.prepare(
			"UPDATE onboarding SET first_visit_at = ? WHERE account_id = ? AND first_visit_at IS NULL AND ? <= login_at AND ? > login_at - 86400000",
		)
		.bind(at, accountId, at, at)
		.run();
}

export interface OnboardingRow {
	account_id: string;
	display_name: string;
	provider: string;
	first_visit_at: number | null;
	login_at: number;
	entered_at: number | null;
	avatar_at: number | null;
	ai_at: number | null;
}

export async function listOnboarding(db: D1Database, limit = 50): Promise<OnboardingRow[]> {
	const r = await db
		.prepare(
			"SELECT o.*, a.display_name, a.provider FROM onboarding o JOIN accounts a ON a.id = o.account_id ORDER BY o.login_at DESC LIMIT ?",
		)
		.bind(limit)
		.all<OnboardingRow>();
	return r.results;
}

// ---- trial LLM for browser AIs (#24) ----

/** Calls today (UTC) by this account and by everyone. */
export async function trialCalls(
	db: D1Database,
	accountId: string,
	day: string,
): Promise<{ mine: number; all: number }> {
	const r = await db
		.prepare("SELECT account_id, calls FROM trial_llm WHERE day = ? AND account_id IN (?, '*')")
		.bind(day, accountId)
		.all<{ account_id: string; calls: number }>();
	return {
		mine: r.results.find((x) => x.account_id === accountId)?.calls ?? 0,
		all: r.results.find((x) => x.account_id === "*")?.calls ?? 0,
	};
}

export async function addTrialCall(
	db: D1Database,
	accountId: string,
	day: string,
	neurons: number,
): Promise<void> {
	const upsert =
		"INSERT INTO trial_llm (account_id, day, calls, neurons) VALUES (?, ?, 1, ?) ON CONFLICT (account_id, day) DO UPDATE SET calls = calls + 1, neurons = neurons + excluded.neurons";
	await db.batch([
		db.prepare(upsert).bind(accountId, day, neurons),
		db.prepare(upsert).bind("*", day, neurons),
	]);
}
