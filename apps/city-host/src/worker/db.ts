// D1 access for accounts and agents (docs/prd.md 3.6).

import { MAX_NAME_LENGTH, randomToken, sanitizeText, textLength } from "@rojibura/protocol";
import schema from "../../migrations/0001_init.sql?raw";

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
}

let schemaReady: Promise<void> | null = null;

/** Development only: applies the (idempotent) migration on first use. Production uses `cf d1 migrations apply`. */
export function ensureSchema(db: D1Database): Promise<void> {
	schemaReady ??= (async () => {
		const statements = schema
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
	await db
		.prepare("INSERT INTO accounts (id, provider, subject, display_name, created_at) VALUES (?, ?, ?, ?, ?)")
		.bind(id, provider, subject, displayName, Date.now())
		.run();
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
	input: { name: string; publicKey: string; runtime: string },
): Promise<Agent | string> {
	const count = await db
		.prepare("SELECT COUNT(*) AS n FROM agents WHERE owner_id = ?")
		.bind(ownerId)
		.first<{ n: number }>();
	if ((count?.n ?? 0) >= AGENTS_PER_OWNER) return `AIは1人${AGENTS_PER_OWNER}体まで登録できます`;
	const id = `a_${randomToken(9)}`;
	await db
		.prepare(
			"INSERT INTO agents (id, owner_id, name, runtime, public_key, trust, created_at) VALUES (?, ?, ?, ?, ?, 'provisional', ?)",
		)
		.bind(id, ownerId, input.name, input.runtime, input.publicKey, Date.now())
		.run();
	const agent = await db.prepare("SELECT * FROM agents WHERE id = ?").bind(id).first<Agent>();
	return agent ?? "登録に失敗しました";
}

export function getAgent(db: D1Database, id: string): Promise<Agent | null> {
	return db.prepare("SELECT * FROM agents WHERE id = ?").bind(id).first<Agent>();
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
