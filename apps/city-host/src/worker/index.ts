// Gateway Worker (docs/prd.md 2.1): authentication, API, opening hours and the WebSocket gateway.
// The client itself is served as static assets; only /api/*, /ws/* and /auth/* reach this code.

import { env } from "cloudflare:workers";
import {
	authPayload,
	exportPublicKey,
	generateAgentKeyPair,
	importPublicKey,
	signAuth,
	verifyAuth,
} from "@rojibura/protocol";
import {
	type Account,
	addBan,
	cleanName,
	createReport,
	ensureSchema,
	findAccount,
	findOrCreateAccount,
	getAccount,
	getAgent,
	isBanned,
	listAgents,
	listReports,
	logModAction,
	registerAgent,
	relationsOf,
	resolveReport,
	setAgentTrust,
	setRelation,
	setRole,
	updateAccount,
} from "./db.ts";
import { isOpen, nextOpening } from "./hours.ts";
import { authUrl, exchangeCode, googleKeys, newPkce, verifyIdToken } from "./oidc.ts";
import type { JoinRequest, RoomCommand } from "./room.ts";
import {
	clearSessionCookie,
	cookie,
	createSessionToken,
	createSignedToken,
	getCookie,
	OAUTH_COOKIE,
	OAUTH_TTL_MS,
	readSessionToken,
	readSignedToken,
	SESSION_COOKIE,
	sessionCookie,
} from "./session.ts";
import { DEFAULT_PRESET, PRESETS } from "./world.ts";

export { CityRoomDO } from "./room.ts";

const DEV = env.DEV_AUTH === "1";
const AREA_RE = /^[a-z0-9-]{1,32}$/;
/** Areas that moderation commands are sent to. */
const AREAS = ["main"];
const REPORT_REASONS = ["harassment", "spam", "inappropriate", "other"];
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

function roomCommand(areaId: string, c: RoomCommand): Promise<Response> {
	return env.ROOM.getByName(areaId).fetch(
		new Request("https://room/command", { method: "POST", body: JSON.stringify(c) }),
	);
}

async function broadcastCommand(c: RoomCommand): Promise<void> {
	await Promise.all(AREAS.map((a) => roomCommand(a, c)));
}

const isModerator = (a: Account) => a.role === "moderator" || a.role === "admin";

const DEV_TOKEN_HEADER = "X-RJ-Dev-Token";
const DEV_TOKEN_COOKIE = "rj_dev";

/** Dev endpoints: free on localhost; on a deployed dev build (staging) only with DEV_TOKEN. */
function devAllowed(request: Request, url: URL): boolean {
	if (!DEV) return false;
	if (url.hostname === "localhost" || url.hostname === "127.0.0.1") return true;
	const given = request.headers.get(DEV_TOKEN_HEADER) ?? getCookie(request, DEV_TOKEN_COOKIE);
	if (!env.DEV_TOKEN || !given) return false;
	const a = new TextEncoder().encode(env.DEV_TOKEN);
	const b = new TextEncoder().encode(given);
	return a.byteLength === b.byteLength && crypto.subtle.timingSafeEqual(a, b);
}

function sessionSecret(): string {
	if (env.SESSION_SECRET) return env.SESSION_SECRET;
	// the fallback is for local development only: deployed dev builds have a DEV_TOKEN
	if (DEV && !env.DEV_TOKEN) return "dev-only-insecure-session-secret";
	throw new Error("SESSION_SECRET is not set");
}

function json(data: unknown, status = 200, headers: HeadersInit = {}): Response {
	return Response.json(data, { status, headers });
}

function error(status: number, message: string): Response {
	return json({ error: message }, status);
}

async function currentAccount(request: Request): Promise<Account | null> {
	const token = getCookie(request, SESSION_COOKIE);
	if (!token) return null;
	const s = await readSessionToken(sessionSecret(), token);
	return s ? getAccount(env.DB, s.aid) : null;
}

async function loginResponse(account: Account, redirect: string): Promise<Response> {
	const token = await createSessionToken(sessionSecret(), account.id);
	const headers = new Headers({ Location: redirect });
	headers.append("Set-Cookie", sessionCookie(token));
	headers.append("Set-Cookie", cookie(OAUTH_COOKIE, "", 0));
	return new Response(null, { status: 302, headers });
}

function safeRedirect(r: string | null | undefined): string {
	return r?.startsWith("/") && !r.startsWith("//") ? r : "/";
}

const googleConfigured = () => Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);

async function googleLogin(url: URL): Promise<Response> {
	if (!googleConfigured()) return error(503, "Google login is not configured");
	const { state, verifier } = newPkce();
	const redirect = safeRedirect(url.searchParams.get("redirect"));
	const token = await createSignedToken(
		sessionSecret(),
		"oauth",
		{ state, verifier, redirect },
		OAUTH_TTL_MS,
	);
	const location = await authUrl(env.GOOGLE_CLIENT_ID, `${url.origin}/auth/google/callback`, state, verifier);
	return new Response(null, {
		status: 302,
		headers: { Location: location, "Set-Cookie": cookie(OAUTH_COOKIE, token, OAUTH_TTL_MS) },
	});
}

async function googleCallback(request: Request, url: URL): Promise<Response> {
	if (!googleConfigured()) return error(503, "Google login is not configured");
	const raw = getCookie(request, OAUTH_COOKIE);
	const saved = raw
		? await readSignedToken<{ state: string; verifier: string; redirect: string }>(
				sessionSecret(),
				"oauth",
				raw,
			)
		: null;
	const code = url.searchParams.get("code");
	if (!saved || !code || url.searchParams.get("state") !== saved.state)
		return error(400, "invalid login state");
	let sub: string;
	try {
		const idToken = await exchangeCode({
			code,
			verifier: saved.verifier,
			clientId: env.GOOGLE_CLIENT_ID,
			clientSecret: env.GOOGLE_CLIENT_SECRET,
			redirectUri: `${url.origin}/auth/google/callback`,
		});
		const claims = await verifyIdToken(idToken, await googleKeys(), env.GOOGLE_CLIENT_ID);
		if (typeof claims === "string") return error(401, `login failed: ${claims}`);
		sub = claims.sub;
	} catch (e) {
		return error(502, (e as Error).message);
	}
	const existing = await findAccount(env.DB, "google", sub);
	const account = existing ?? (await findOrCreateAccount(env.DB, "google", sub, `ゲスト${sub.slice(-4)}`));
	// new accounts choose their display name first (scope is openid only, so Google gives no name)
	return loginResponse(
		account,
		existing ? saved.redirect : `/?welcome=1&redirect=${encodeURIComponent(saved.redirect)}`,
	);
}

function openOrError(): Response | null {
	if (env.DEV_ALWAYS_OPEN === "1" || isOpen(Date.now())) return null;
	return json({ error: "closed", nextOpening: nextOpening(Date.now()) }, 403);
}

async function wsGateway(request: Request, areaId: string): Promise<Response> {
	if (request.headers.get("Upgrade") !== "websocket") return error(426, "Expected WebSocket");
	const closed = openOrError();
	if (closed) return closed;
	const url = new URL(request.url);
	const agentId = url.searchParams.get("agent");
	let join: JoinRequest;
	if (agentId) {
		const agent = await getAgent(env.DB, agentId);
		if (!agent || agent.trust === "suspended" || agent.key_revoked_at !== null)
			return error(403, "agent not allowed");
		const owner = await getAccount(env.DB, agent.owner_id);
		if (!owner) return error(403, "owner not found");
		if (await isBanned(env.DB, [agent.id, owner.id])) return error(403, "banned");
		join = {
			areaId,
			publicKey: agent.public_key,
			info: {
				id: agent.id,
				kind: "ai",
				name: agent.name,
				assets: DEFAULT_PRESET.assets,
				ownerId: owner.id,
				ownerName: owner.display_name,
				trust: agent.trust,
				ownerAgentLimit: owner.agent_concurrency,
			},
		};
	} else {
		const account = await currentAccount(request);
		if (!account) return error(401, "login required");
		if (await isBanned(env.DB, [account.id])) return error(403, "banned");
		const preset = PRESETS[url.searchParams.get("avatar") ?? ""] ?? DEFAULT_PRESET;
		join = {
			areaId,
			info: {
				id: account.id,
				kind: "human",
				name: account.display_name,
				assets: preset.assets,
				ownerId: account.id,
				allowAiApproach: account.allow_ai_approach === 1,
			},
		};
	}
	// A fresh request: never forward participant headers to the DO, it trusts X-RJ-Join.
	const inner = new Request(`https://room/${areaId}`, {
		headers: { Upgrade: "websocket", "X-RJ-Join": JSON.stringify(join) },
	});
	return env.ROOM.getByName(areaId).fetch(inner);
}

async function devSelftest(): Promise<Response> {
	const t0 = performance.now();
	const kp = await generateAgentKeyPair(false);
	const pub = await exportPublicKey(kp.publicKey);
	const payload = authPayload("main", "a_test", "nonce");
	const sig = await signAuth(kp.privateKey, payload);
	const ok = await verifyAuth(pub, payload, sig);
	const bad = await verifyAuth(pub, authPayload("main", "a_test", "other"), sig);
	await importPublicKey(pub);
	return json({ ed25519: { signVerify: ok, rejectsOtherPayload: !bad, ms: performance.now() - t0 } });
}

async function api(request: Request, url: URL): Promise<Response> {
	const path = url.pathname;
	if (path === "/api/health")
		return json({ ok: true, dev: DEV, google: googleConfigured(), open: isOpen(Date.now()) });
	if (path === "/api/presets") return json(Object.values(PRESETS));

	if (path === "/api/me" && request.method === "PATCH") {
		const account = await currentAccount(request);
		if (!account) return error(401, "login required");
		const body = (await request.json().catch(() => null)) as {
			name?: string;
			allowAiApproach?: boolean;
		} | null;
		const name = body?.name === undefined ? undefined : cleanName(body.name);
		if (name === null) return error(400, "bad name");
		await updateAccount(env.DB, account.id, { name, allowAiApproach: body?.allowAiApproach });
		return json({ ok: true });
	}

	if (path === "/api/me") {
		const account = await currentAccount(request);
		if (!account) return error(401, "login required");
		const agents = await listAgents(env.DB, account.id);
		return json({
			id: account.id,
			name: account.display_name,
			role: account.role,
			allowAiApproach: account.allow_ai_approach === 1,
			agents: agents.map((a) => ({ id: a.id, name: a.name, runtime: a.runtime, trust: a.trust })),
			relations: await relationsOf(env.DB, account.id).then((r) => ({ mutes: r.mutes, blocks: r.blocks })),
		});
	}

	// ---- moderation (docs/prd.md 4.2) ----
	if (path === "/api/relations" && request.method === "POST") {
		const account = await currentAccount(request);
		if (!account) return error(401, "login required");
		const b = (await request.json().catch(() => null)) as {
			targetId?: string;
			kind?: string;
			on?: boolean;
		} | null;
		if (!b?.targetId || !/^[ha]_[A-Za-z0-9_-]{1,64}$/.test(b.targetId) || b.targetId === account.id)
			return error(400, "bad target");
		if (b.kind !== "mute" && b.kind !== "block") return error(400, "bad kind");
		const on = b.on !== false;
		await setRelation(env.DB, account.id, b.targetId, b.kind, on);
		await broadcastCommand({ op: "relation", accountId: account.id, targetId: b.targetId, kind: b.kind, on });
		return json({ ok: true });
	}

	if (path === "/api/reports" && request.method === "POST") {
		const account = await currentAccount(request);
		if (!account) return error(401, "login required");
		const b = (await request.json().catch(() => null)) as {
			targetId?: string;
			reason?: string;
			note?: string;
		} | null;
		if (!b?.targetId || !/^[ha]_[A-Za-z0-9_-]{1,64}$/.test(b.targetId)) return error(400, "bad target");
		if (!REPORT_REASONS.includes(b.reason ?? "")) return error(400, "bad reason");
		const note = (b.note ?? "").slice(0, 500);
		const excerpts = await Promise.all(
			AREAS.map((a) =>
				roomCommand(a, { op: "excerpt", id: b.targetId as string, minutes: 5 })
					.then((r) => r.json() as Promise<{ lines: unknown[] }>)
					.catch(() => ({ lines: [] })),
			),
		);
		const id = await createReport(env.DB, {
			reporterId: account.id,
			targetId: b.targetId,
			reason: b.reason as string,
			note,
			excerpt: excerpts.flatMap((e) => e.lines),
		});
		return json({ id }, 201);
	}

	if (path === "/api/mod/reports") {
		const account = await currentAccount(request);
		if (!account || !isModerator(account)) return error(403, "moderators only");
		const reports = await listReports(env.DB, url.searchParams.get("status") ?? "open");
		const names = new Map<string, string>();
		for (const id of new Set(reports.flatMap((r) => [r.reporter_id, r.target_id]))) {
			const n = id.startsWith("a_")
				? (await getAgent(env.DB, id))?.name
				: (await getAccount(env.DB, id))?.display_name;
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

	if (path === "/api/mod/action" && request.method === "POST") {
		const account = await currentAccount(request);
		if (!account || !isModerator(account)) return error(403, "moderators only");
		const b = (await request.json().catch(() => null)) as {
			action?: string;
			subjectId?: string;
			minutes?: number;
			reason?: string;
			reportId?: string;
		} | null;
		const subject = b?.subjectId ?? "";
		if (!/^[ha]_[A-Za-z0-9_-]{1,64}$/.test(subject)) return error(400, "bad subject");
		const reason = (b?.reason ?? "").slice(0, 200) || "モデレーション";
		const now = Date.now();
		switch (b?.action) {
			case "mute": {
				const minutes = Math.min(Math.max(1, Number(b.minutes) || 10), 24 * 60);
				await broadcastCommand({ op: "mute", id: subject, until: now + minutes * 60_000 });
				break;
			}
			case "kick": {
				// kicked avatars cannot come back until the end of the day (JST)
				const jst = now + JST_OFFSET_MS;
				const endOfDay = jst - (jst % 86_400_000) + 86_400_000 - JST_OFFSET_MS;
				await addBan(env.DB, {
					subjectId: subject,
					kind: subject.startsWith("a_") ? "agent" : "account",
					until: endOfDay,
					reason,
					by: account.id,
				});
				await broadcastCommand({ op: "kick", id: subject });
				break;
			}
			case "ban": {
				const minutes = Number(b.minutes);
				await addBan(env.DB, {
					subjectId: subject,
					kind: subject.startsWith("a_") ? "agent" : "account",
					until: minutes > 0 ? now + minutes * 60_000 : null,
					reason,
					by: account.id,
				});
				await broadcastCommand({ op: "kick", id: subject });
				// an owner's ban also removes their agents
				if (subject.startsWith("h_"))
					for (const a of await listAgents(env.DB, subject)) await broadcastCommand({ op: "kick", id: a.id });
				break;
			}
			case "suspend":
				if (!subject.startsWith("a_")) return error(400, "only agents can be suspended");
				await setAgentTrust(env.DB, subject, "suspended");
				await broadcastCommand({ op: "kick", id: subject });
				break;
			case "approve":
				if (!subject.startsWith("a_") || account.role !== "admin") return error(403, "admins approve agents");
				await setAgentTrust(env.DB, subject, "approved");
				break;
			case "resolve":
				break;
			default:
				return error(400, "bad action");
		}
		if (b?.reportId) await resolveReport(env.DB, b.reportId);
		await logModAction(env.DB, {
			actorId: account.id,
			action: b?.action ?? "",
			subjectId: subject,
			detail: { minutes: b?.minutes, reason, reportId: b?.reportId },
		});
		return json({ ok: true });
	}

	if (devAllowed(request, url) && path === "/api/dev/role" && request.method === "POST") {
		const account = await currentAccount(request);
		if (!account) return error(401, "login required");
		const role = ((await request.json().catch(() => null)) as { role?: string } | null)?.role;
		if (role !== "admin" && role !== "moderator" && role !== "user") return error(400, "bad role");
		await setRole(env.DB, account.id, role);
		return json({ ok: true });
	}

	if (path === "/api/agents" && request.method === "POST") {
		const account = await currentAccount(request);
		if (!account) return error(401, "login required");
		const body = (await request.json().catch(() => null)) as {
			name?: string;
			publicKey?: string;
			runtime?: string;
		} | null;
		const name = cleanName(body?.name ?? "");
		if (!name) return error(400, "bad name");
		const runtime = body?.runtime;
		if (runtime !== "browser" && runtime !== "worker" && runtime !== "node") return error(400, "bad runtime");
		const publicKey = body?.publicKey ?? "";
		try {
			await importPublicKey(publicKey);
		} catch {
			return error(400, "bad public key");
		}
		const r = await registerAgent(env.DB, account.id, { name, publicKey, runtime });
		if (typeof r === "string") return error(409, r);
		return json({ id: r.id, name: r.name, trust: r.trust }, 201);
	}

	const stats = path.match(/^\/api\/dev\/rooms\/([a-z0-9-]{1,32})\/stats$/);
	if (stats?.[1] && devAllowed(request, url))
		return env.ROOM.getByName(stats[1]).fetch(new Request("https://room/stats"));

	const approve = path.match(/^\/api\/dev\/agents\/(a_[A-Za-z0-9_-]+)\/approve$/);
	if (approve?.[1] && request.method === "POST" && devAllowed(request, url)) {
		await setAgentTrust(env.DB, approve[1], "approved");
		return json({ ok: true });
	}

	if (path === "/api/dev/selftest" && devAllowed(request, url)) return devSelftest();
	return error(404, "not found");
}

async function auth(request: Request, url: URL): Promise<Response> {
	if (url.pathname === "/auth/logout") {
		return new Response(null, {
			status: 302,
			headers: { Location: "/", "Set-Cookie": clearSessionCookie() },
		});
	}
	if (url.pathname === "/auth/google/login") return googleLogin(url);
	if (url.pathname === "/auth/google/callback") return googleCallback(request, url);
	if (url.pathname === "/auth/dev/login") {
		if (!devAllowed(request, url)) return error(404, "not found");
		const name = cleanName(url.searchParams.get("name") ?? "");
		if (!name) return error(400, "name is required (1-24 characters)");
		const account = await findOrCreateAccount(env.DB, "dev", name, name);
		return loginResponse(account, safeRedirect(url.searchParams.get("redirect")));
	}
	return error(404, "not found");
}

export default {
	async fetch(request) {
		const url = new URL(request.url);
		if (DEV) await ensureSchema(env.DB);
		if (url.pathname.startsWith("/api/")) return api(request, url);
		if (url.pathname.startsWith("/auth/")) return auth(request, url);
		const ws = url.pathname.match(/^\/ws\/area\/([^/]+)$/);
		if (ws?.[1] && AREA_RE.test(ws[1])) return wsGateway(request, ws[1]);
		return error(404, "not found");
	},
} satisfies ExportedHandler<Env>;
