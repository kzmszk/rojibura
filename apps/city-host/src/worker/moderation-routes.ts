import {
	type Account,
	addBan,
	createReport,
	getAccount,
	getAgent,
	listAgents,
	listOnboarding,
	listProvisionalAgents,
	listReports,
	logModAction,
	resolveReport,
	setAgentTrust,
	setRelation,
	setRole,
} from "./db.ts";
import type { RoomCommand } from "./room.ts";
import { AREA_IDS } from "./world.ts";

const REPORT_REASONS = ["harassment", "spam", "inappropriate", "other"];
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const isModerator = (a: Account) => a.role === "moderator" || a.role === "admin";

function json(data: unknown, status = 200): Response {
	return Response.json(data, { status });
}
function error(status: number, message: string): Response {
	return json({ error: message }, status);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
	const body: unknown = await request.json().catch(() => null);
	return isRecord(body) ? body : {};
}

type ModerationDeps = {
	db: D1Database;
	currentAccount: (request: Request) => Promise<Account | null>;
	devAllowed: (request: Request, url: URL) => boolean;
	roomCommand: (area: string, command: RoomCommand) => Promise<Response>;
	broadcastCommand: (command: RoomCommand) => Promise<void>;
};

export async function moderationRoutes(
	request: Request,
	url: URL,
	deps: ModerationDeps,
): Promise<Response | null> {
	const path = url.pathname;
	if (path === "/api/mod/onboarding") return onboarding(request, deps);
	if (path === "/api/relations" && request.method === "POST") return relations(request, deps);
	if (path === "/api/reports" && request.method === "POST") return submitReport(request, deps);
	if (path === "/api/mod/reports") return moderatorReports(request, url, deps);
	if (path === "/api/mod/agents" && request.method === "GET") return provisionalAgents(request, deps);
	if (path === "/api/mod/action" && request.method === "POST") return moderationAction(request, deps);
	if (path === "/api/dev/role" && request.method === "POST" && deps.devAllowed(request, url))
		return devRole(request, deps);
	return null;
}

async function onboarding(request: Request, deps: ModerationDeps): Promise<Response> {
	const account = await deps.currentAccount(request);
	if (!account || !isModerator(account)) return error(403, "moderators only");
	return json(await listOnboarding(deps.db));
}

async function relations(request: Request, deps: ModerationDeps): Promise<Response> {
	const account = await deps.currentAccount(request);
	if (!account) return error(401, "login required");
	const b = await readBody(request);
	if (
		typeof b.targetId !== "string" ||
		!/^[ha]_[A-Za-z0-9_-]{1,64}$/.test(b.targetId) ||
		b.targetId === account.id
	)
		return error(400, "bad target");
	if (b.kind !== "mute" && b.kind !== "block") return error(400, "bad kind");
	const on = b.on !== false;
	await setRelation(deps.db, account.id, b.targetId, b.kind, on);
	await deps.broadcastCommand({
		op: "relation",
		accountId: account.id,
		targetId: b.targetId,
		kind: b.kind,
		on,
	});
	return json({ ok: true });
}

async function submitReport(request: Request, deps: ModerationDeps): Promise<Response> {
	const account = await deps.currentAccount(request);
	if (!account) return error(401, "login required");
	const b = await readBody(request);
	if (typeof b.targetId !== "string" || !/^[ha]_[A-Za-z0-9_-]{1,64}$/.test(b.targetId))
		return error(400, "bad target");
	if (typeof b.reason !== "string" || !REPORT_REASONS.includes(b.reason)) return error(400, "bad reason");
	if (b.note != null && typeof b.note !== "string") return error(400, "bad note");
	const note = (b.note ?? "").slice(0, 500);
	const targetId = b.targetId;
	const excerpts = await Promise.all(
		AREA_IDS.map((a) =>
			deps
				.roomCommand(a, { op: "excerpt", id: targetId, minutes: 5 })
				.then((r) => r.json() as Promise<{ lines: unknown[] }>)
				.catch(() => ({ lines: [] })),
		),
	);
	const id = await createReport(deps.db, {
		reporterId: account.id,
		targetId: b.targetId,
		reason: b.reason,
		note,
		excerpt: excerpts.flatMap((e) => e.lines),
	});
	return json({ id }, 201);
}

async function moderatorReports(request: Request, url: URL, deps: ModerationDeps): Promise<Response> {
	const account = await deps.currentAccount(request);
	if (!account || !isModerator(account)) return error(403, "moderators only");
	const reports = await listReports(deps.db, url.searchParams.get("status") ?? "open");
	const names = new Map<string, string>();
	for (const id of new Set(reports.flatMap((r) => [r.reporter_id, r.target_id]))) {
		const n = id.startsWith("a_")
			? (await getAgent(deps.db, id))?.name
			: (await getAccount(deps.db, id))?.display_name;
		names.set(id, n ?? id);
	}
	return json(
		reports.map((r) => ({
			id: r.id,
			reporter: { id: r.reporter_id, name: names.get(r.reporter_id) },
			target: { id: r.target_id, name: names.get(r.target_id) },
			reason: r.reason,
			note: r.note,
			excerpt: JSON.parse(r.excerpt_json),
			createdAt: r.created_at,
		})),
	);
}

/** The AIs an admin can approve (only admins approve them, moderationAction). */
async function provisionalAgents(request: Request, deps: ModerationDeps): Promise<Response> {
	const account = await deps.currentAccount(request);
	if (account?.role !== "admin") return error(403, "admins approve agents");
	const agents = await listProvisionalAgents(deps.db);
	return json(
		agents.map((a) => ({
			id: a.id,
			name: a.name,
			runtime: a.runtime,
			owner: { id: a.owner_id, name: a.owner_name },
			createdAt: a.created_at,
		})),
	);
}

async function moderationAction(request: Request, deps: ModerationDeps): Promise<Response> {
	const account = await deps.currentAccount(request);
	if (!account || !isModerator(account)) return error(403, "moderators only");
	const b = await readBody(request);
	const subject = b.subjectId;
	if (typeof subject !== "string" || !/^[ha]_[A-Za-z0-9_-]{1,64}$/.test(subject))
		return error(400, "bad subject");
	if (b.reason != null && typeof b.reason !== "string") return error(400, "bad reason");
	const reason = (b.reason ?? "").slice(0, 200) || "モデレーション";
	if (b.action === "suspend" && !subject.startsWith("a_")) return error(400, "only agents can be suspended");
	if (b.action === "approve" && (!subject.startsWith("a_") || account.role !== "admin"))
		return error(403, "admins approve agents");
	if (
		b.action !== "mute" &&
		b.action !== "kick" &&
		b.action !== "ban" &&
		b.action !== "suspend" &&
		b.action !== "approve" &&
		b.action !== "resolve"
	)
		return error(400, "bad action");
	if (b.reportId != null && typeof b.reportId !== "string") return error(400, "bad report");
	const now = Date.now();
	switch (b.action) {
		case "mute": {
			const minutes = Math.min(Math.max(1, Number(b.minutes) || 10), 24 * 60);
			await deps.broadcastCommand({ op: "mute", id: subject, until: now + minutes * 60_000 });
			break;
		}
		case "kick": {
			const jst = now + JST_OFFSET_MS;
			const endOfDay = jst - (jst % 86_400_000) + 86_400_000 - JST_OFFSET_MS;
			await addBan(deps.db, {
				subjectId: subject,
				kind: subject.startsWith("a_") ? "agent" : "account",
				until: endOfDay,
				reason,
				by: account.id,
			});
			await deps.broadcastCommand({ op: "kick", id: subject });
			break;
		}
		case "ban": {
			const minutes = Number(b.minutes);
			await addBan(deps.db, {
				subjectId: subject,
				kind: subject.startsWith("a_") ? "agent" : "account",
				until: minutes > 0 ? now + minutes * 60_000 : null,
				reason,
				by: account.id,
			});
			await deps.broadcastCommand({ op: "kick", id: subject });
			if (subject.startsWith("h_"))
				for (const a of await listAgents(deps.db, subject))
					await deps.broadcastCommand({ op: "kick", id: a.id });
			break;
		}
		case "suspend":
			await setAgentTrust(deps.db, subject, "suspended");
			await deps.broadcastCommand({ op: "kick", id: subject });
			break;
		case "approve": {
			const agent = await getAgent(deps.db, subject);
			if (!agent) return error(404, "no such agent");
			// approving must not lift a suspension (a page opened before it was suspended, say)
			if (agent.trust === "suspended") return error(409, "停止中のAIは承認できません");
			await setAgentTrust(deps.db, subject, "approved");
			break;
		}
		case "resolve":
			break;
		default: {
			const exhaustive: never = b.action;
			return exhaustive;
		}
	}
	if (b.reportId) await resolveReport(deps.db, b.reportId);
	await logModAction(deps.db, {
		actorId: account.id,
		action: b.action,
		subjectId: subject,
		detail: { minutes: b.minutes, reason, reportId: b.reportId },
	});
	return json({ ok: true });
}

async function devRole(request: Request, deps: ModerationDeps): Promise<Response> {
	const account = await deps.currentAccount(request);
	if (!account) return error(401, "login required");
	const role = ((await request.json().catch(() => null)) as { role?: string } | null)?.role;
	if (role !== "admin" && role !== "moderator" && role !== "user") return error(400, "bad role");
	await setRole(deps.db, account.id, role);
	return json({ ok: true });
}
