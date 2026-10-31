// Gateway Worker (docs/prd.md 2.1): authentication, API, opening hours and the WebSocket gateway.
// The client itself is served as static assets; only /api/*, /ws/* and /auth/* reach this code.

import { env } from "cloudflare:workers";
import { AsyncLocalStorage } from "node:async_hooks";
import { decisionSchema, SUMMARY_SCHEMA, systemPrompt, WorkersAiLLM } from "@rojibura/avatar-sdk";
import {
	authPayload,
	exportPublicKey,
	generateAgentKeyPair,
	importPublicKey,
	signAuth,
	USAGE_KEYS,
	type Usage,
	type UsageEvent,
	usageDay,
	verifyAuth,
} from "@rojibura/protocol";
import {
	type Account,
	addBan,
	addTrialCall,
	cleanName,
	createReport,
	ensureSchema,
	findAccount,
	findOrCreateAccount,
	getAccount,
	getAgent,
	isBanned,
	listAgents,
	listOnboarding,
	listReports,
	logModAction,
	markOnboarding,
	registerAgent,
	relationsOf,
	resolveReport,
	setAgentTrust,
	setFirstVisit,
	setRelation,
	setRole,
	trialCalls,
	updateAccount,
} from "./db.ts";
import { isOpen, nextOpening, parseHours } from "./hours.ts";
import { freePlayOn, isLocalHost } from "./modes.ts";
import { officialUsage } from "./official.ts";
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
import { meteredD1 } from "./usage.ts";
import { ALL_LANDMARK_IDS, AREA_IDS, AREAS, DEFAULT_PRESET, MAIN_AREA, PRESETS } from "./world.ts";

export { CityRoomDO } from "./room.ts";

const DEV = env.DEV_AUTH === "1";
/** Free play (docs/prd.md 3.7): only in `pnpm dev:free`, never in staging or production. */
const FREE_PLAY = freePlayOn(env);

// ---- free-tier usage of the gateway (docs/prd.md 2.5) ----
/** The cost of the request being handled (AsyncLocalStorage keeps concurrent requests apart). */
const requestUsage = new AsyncLocalStorage<Partial<Usage>>();
const DB = meteredD1(env.DB, (c) => {
	const u = requestUsage.getStore();
	if (u) for (const k of USAGE_KEYS) if (c[k]) u[k] = (u[k] ?? 0) + (c[k] ?? 0);
});
/** Adds a cost to the request being handled (e.g. Workers AI neurons). */
function addRequestCost(c: Partial<Usage>): void {
	const u = requestUsage.getStore();
	if (u) for (const k of USAGE_KEYS) if (c[k]) u[k] = (u[k] ?? 0) + (c[k] ?? 0);
}

/**
 * The trial LLM for browser AIs (#24): the host's Workers AI, so people can start without an API key.
 * Capped per person and in total (docs/prd.md 2.4: with the guide, at most about 60% of the free tier).
 */
const TRIAL_CALLS_PER_ACCOUNT = 60;
const TRIAL_CALLS_PER_DAY = 600;

/** Gateway actions not yet reported to the room's meter, and when this isolate last reported. */
let unreported: UsageEvent[] = [];
let reportedAt = 0;
const REPORT_MS = 60_000;

function gatewayLabel(method: string, path: string): string {
	if (path.startsWith("/ws/")) return "入場（ゲートウェイ）";
	if (path.startsWith("/auth/")) return "ログイン";
	const names: Record<string, string> = {
		"/api/me": method === "PATCH" ? "設定の変更" : "自分の情報",
		"/api/entry": "入場の確認",
		"/api/health": "状態の確認",
		"/api/relations": "ミュート・ブロック",
		"/api/reports": "通報",
		"/api/usage/official": "公式の利用状況",
		"/api/llm": "お試しAI（Workers AI）",
		"/api/onboarding": "初回訪問の記録",
		"/api/models": method === "POST" ? "モデルの登録" : "モデルの一覧",
	};
	return `API：${names[path] ?? `${method} ${path}`}`;
}

/** Tells the client what its request cost (same origin, so it can read the header). */
function withUsageHeader(response: Response, cost: Partial<Usage>, label: string): Response {
	if (response.status === 101) return response;
	const value = USAGE_KEYS.filter((k) => cost[k])
		.map((k) => `${k}=${Math.round((cost[k] ?? 0) * 1000) / 1000}`)
		.join(",");
	const r = new Response(response.body, response);
	r.headers.set("X-RJ-Usage", value);
	r.headers.set("X-RJ-Usage-Label", encodeURIComponent(label));
	return r;
}
/** Parsed at startup: a malformed OPEN_HOURS fails the deploy instead of going live. Free play is always open. */
const HOURS = FREE_PLAY ? "always" : parseHours(env.OPEN_HOURS);
const AREA_RE = /^[a-z0-9-]{1,32}$/;
/** A landmark or portal ID to arrive at (landmarks.json, areas.json). */
const ARRIVE_RE = /^[A-Za-z0-9_-]{1,32}$/;
const REPORT_REASONS = ["harassment", "spam", "inappropriate", "other"];
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

function roomCommand(areaId: string, c: RoomCommand): Promise<Response> {
	return env.ROOM.getByName(areaId).fetch(
		new Request("https://room/command", { method: "POST", body: JSON.stringify(c) }),
	);
}

async function broadcastCommand(c: RoomCommand): Promise<void> {
	await Promise.all(AREA_IDS.map((a) => roomCommand(a, c)));
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
	return s ? getAccount(DB, s.aid) : null;
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
	const existing = await findAccount(DB, "google", sub);
	const account = existing ?? (await findOrCreateAccount(DB, "google", sub, `ゲスト${sub.slice(-4)}`));
	// new accounts choose their display name first (scope is openid only, so Google gives no name)
	return loginResponse(
		account,
		existing ? saved.redirect : `/?welcome=1&redirect=${encodeURIComponent(saved.redirect)}`,
	);
}

function openOrError(): Response | null {
	if (isOpen(Date.now(), HOURS)) return null;
	return json({ error: "closed", nextOpening: nextOpening(Date.now(), HOURS) }, 403);
}

export type EntryRefusal = { reason: "closed"; nextOpening: number } | { reason: "login" | "banned" };

/**
 * Why a person cannot enter right now (null: they can). Shared by the gateway and /api/entry: a browser
 * cannot read why a WebSocket handshake failed, so the client asks here before connecting.
 */
async function humanEntryRefusal(account: Account | null): Promise<EntryRefusal | null> {
	const now = Date.now();
	if (!isOpen(now, HOURS)) return { reason: "closed", nextOpening: nextOpening(now, HOURS) };
	if (!account) return { reason: "login" };
	if (await isBanned(DB, [account.id])) return { reason: "banned" };
	return null;
}

async function wsGateway(request: Request, areaId: string): Promise<Response> {
	if (request.headers.get("Upgrade") !== "websocket") return error(426, "Expected WebSocket");
	const closed = openOrError();
	if (closed) return closed;
	const url = new URL(request.url);
	const agentId = url.searchParams.get("agent");
	// through a portal (docs/prd.md 3.8): the room checks it is one of its landmarks or portals
	const at = url.searchParams.get("at");
	const arrive = at && ARRIVE_RE.test(at) ? { arrive: at } : {};
	let join: JoinRequest;
	if (agentId) {
		const agent = await getAgent(DB, agentId);
		if (!agent || agent.trust === "suspended" || agent.key_revoked_at !== null)
			return error(403, "agent not allowed");
		const owner = await getAccount(DB, agent.owner_id);
		if (!owner) return error(403, "owner not found");
		if (await isBanned(DB, [agent.id, owner.id])) return error(403, "banned");
		await markOnboarding(DB, owner.id, "ai_at");
		join = {
			areaId,
			...arrive,
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
		const refusal = await humanEntryRefusal(account);
		if (!refusal && account) await markOnboarding(DB, account.id, "entered_at");
		if (refusal || !account)
			return json({ error: refusal?.reason ?? "login", ...refusal }, refusal?.reason === "login" ? 401 : 403);
		const preset = PRESETS[url.searchParams.get("avatar") ?? ""] ?? DEFAULT_PRESET;
		join = {
			areaId,
			...arrive,
			info: {
				id: account.id,
				kind: "human",
				name: account.display_name,
				assets: preset.assets,
				ownerId: account.id,
				allowAiApproach: account.allow_ai_approach === 1,
				canWatchUsage: DEV || isModerator(account),
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
		return json({
			ok: true,
			dev: DEV,
			freePlay: FREE_PLAY,
			google: googleConfigured(),
			hours: env.OPEN_HOURS,
			open: isOpen(Date.now(), HOURS),
			nextOpening: nextOpening(Date.now(), HOURS),
		});
	if (path === "/api/usage/official") {
		const account = await currentAccount(request);
		if (!devAllowed(request, url) && !(account && isModerator(account))) return error(403, "moderators only");
		// optional secrets, not declared in cloudflare.config.ts
		const optional = env as unknown as { CF_ANALYTICS_TOKEN?: string; CF_ACCOUNT_ID?: string };
		return json(await officialUsage(optional.CF_ANALYTICS_TOKEN, optional.CF_ACCOUNT_ID));
	}
	if (path === "/api/onboarding" && request.method === "POST") {
		const account = await currentAccount(request);
		if (!account) return error(401, "login required");
		// how long ago this browser first opened the site (a duration, so the browser's clock does not matter)
		const body = (await request.json().catch(() => null)) as { sinceFirstVisitMs?: unknown } | null;
		const since = Number(body?.sinceFirstVisitMs);
		if (Number.isFinite(since) && since >= 0 && since < 86_400_000)
			await setFirstVisit(DB, account.id, Date.now() - since);
		return json({ ok: true });
	}
	if (path === "/api/mod/onboarding") {
		const account = await currentAccount(request);
		if (!account || !isModerator(account)) return error(403, "moderators only");
		return json(await listOnboarding(DB));
	}
	if (path === "/api/llm") return trialLlm(request);
	if (path === "/api/entry") {
		const refusal = await humanEntryRefusal(await currentAccount(request));
		return json(refusal ? { ok: false, ...refusal } : { ok: true });
	}
	if (path === "/api/presets") return json(Object.values(PRESETS));
	if (path === "/api/models" || path.startsWith("/api/models/")) return models(request, path);

	if (path === "/api/me" && request.method === "PATCH") {
		const account = await currentAccount(request);
		if (!account) return error(401, "login required");
		const body = (await request.json().catch(() => null)) as {
			name?: string;
			allowAiApproach?: boolean;
		} | null;
		const name = body?.name === undefined ? undefined : cleanName(body.name);
		if (name === null) return error(400, "bad name");
		await updateAccount(DB, account.id, { name, allowAiApproach: body?.allowAiApproach });
		return json({ ok: true });
	}

	if (path === "/api/me") {
		const account = await currentAccount(request);
		if (!account) return error(401, "login required");
		const agents = await listAgents(DB, account.id);
		return json({
			id: account.id,
			name: account.display_name,
			role: account.role,
			allowAiApproach: account.allow_ai_approach === 1,
			agents: agents.map((a) => ({ id: a.id, name: a.name, runtime: a.runtime, trust: a.trust })),
			relations: await relationsOf(DB, account.id).then((r) => ({ mutes: r.mutes, blocks: r.blocks })),
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
		await setRelation(DB, account.id, b.targetId, b.kind, on);
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
			AREA_IDS.map((a) =>
				roomCommand(a, { op: "excerpt", id: b.targetId as string, minutes: 5 })
					.then((r) => r.json() as Promise<{ lines: unknown[] }>)
					.catch(() => ({ lines: [] })),
			),
		);
		const id = await createReport(DB, {
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
		const reports = await listReports(DB, url.searchParams.get("status") ?? "open");
		const names = new Map<string, string>();
		for (const id of new Set(reports.flatMap((r) => [r.reporter_id, r.target_id]))) {
			const n = id.startsWith("a_")
				? (await getAgent(DB, id))?.name
				: (await getAccount(DB, id))?.display_name;
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
				await addBan(DB, {
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
				await addBan(DB, {
					subjectId: subject,
					kind: subject.startsWith("a_") ? "agent" : "account",
					until: minutes > 0 ? now + minutes * 60_000 : null,
					reason,
					by: account.id,
				});
				await broadcastCommand({ op: "kick", id: subject });
				// an owner's ban also removes their agents
				if (subject.startsWith("h_"))
					for (const a of await listAgents(DB, subject)) await broadcastCommand({ op: "kick", id: a.id });
				break;
			}
			case "suspend":
				if (!subject.startsWith("a_")) return error(400, "only agents can be suspended");
				await setAgentTrust(DB, subject, "suspended");
				await broadcastCommand({ op: "kick", id: subject });
				break;
			case "approve":
				if (!subject.startsWith("a_") || account.role !== "admin") return error(403, "admins approve agents");
				await setAgentTrust(DB, subject, "approved");
				break;
			case "resolve":
				break;
			default:
				return error(400, "bad action");
		}
		if (b?.reportId) await resolveReport(DB, b.reportId);
		await logModAction(DB, {
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
		await setRole(DB, account.id, role);
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
		const r = await registerAgent(DB, account.id, { name, publicKey, runtime }, FREE_PLAY ? null : undefined);
		if (typeof r === "string") return error(409, r);
		return json({ id: r.id, name: r.name, trust: r.trust }, 201);
	}

	const builds = path.match(/^\/api\/dev\/rooms\/([a-z0-9-]{1,32})\/builds$/);
	if (builds?.[1] && FREE_PLAY && devAllowed(request, url)) {
		// GET: everything built (pnpm builds:publish); DELETE: take it all down
		if (request.method === "GET") return roomCommand(builds[1], { op: "list_builds" });
		if (request.method === "DELETE") {
			const account = await currentAccount(request);
			return roomCommand(builds[1], { op: "clear_builds", by: account?.id ?? "h_dev" });
		}
	}

	const stats = path.match(/^\/api\/dev\/rooms\/([a-z0-9-]{1,32})\/stats$/);
	if (stats?.[1] && devAllowed(request, url))
		return env.ROOM.getByName(stats[1]).fetch(new Request(`https://room/stats${url.search}`));

	const approve = path.match(/^\/api\/dev\/agents\/(a_[A-Za-z0-9_-]+)\/approve$/);
	if (approve?.[1] && request.method === "POST" && devAllowed(request, url)) {
		await setAgentTrust(DB, approve[1], "approved");
		return json({ ok: true });
	}

	if (path === "/api/dev/selftest" && devAllowed(request, url)) return devSelftest();
	return error(404, "not found");
}

/**
 * Models to build with (free play, docs/prd.md 3.7). GET /api/models lists them; POST registers one
 * (multipart from the model CLI, logged in); GET /api/models/<id>.glb|png|nav.json serves a registered one.
 * They are stored in the main area's Durable Object.
 */
async function models(request: Request, path: string): Promise<Response> {
	if (!FREE_PLAY) return error(403, "building is only in free play");
	const room = env.ROOM.getByName(MAIN_AREA);
	const inner = `https://room${path.slice("/api".length)}`;
	if (request.method === "POST" && path === "/api/models") {
		const account = await currentAccount(request);
		if (!account) return error(401, "login required");
		return room.fetch(
			new Request(inner, {
				method: "POST",
				headers: {
					"Content-Type": request.headers.get("Content-Type") ?? "",
					"X-RJ-Owner": JSON.stringify({ id: account.id, name: account.display_name }),
				},
				body: request.body,
			}),
		);
	}
	if (request.method !== "GET") return error(405, "method not allowed");
	return room.fetch(new Request(inner));
}

/** GET: how many trial calls are left today. POST: one LLM call for one of the caller's browser AIs. */
async function trialLlm(request: Request): Promise<Response> {
	const account = await currentAccount(request);
	if (!account) return error(401, "login required");
	const day = usageDay(Date.now());
	const used = await trialCalls(DB, account.id, day);
	const remaining = Math.max(
		0,
		Math.min(TRIAL_CALLS_PER_ACCOUNT - used.mine, TRIAL_CALLS_PER_DAY - used.all),
	);
	if (request.method !== "POST") return json({ remaining, limit: TRIAL_CALLS_PER_ACCOUNT });
	const b = (await request.json().catch(() => null)) as {
		agentId?: string;
		kind?: string;
		personality?: string;
		user?: string;
		landmarkIds?: string[];
	} | null;
	const agent = b?.agentId ? await getAgent(DB, b.agentId) : null;
	if (!agent || agent.owner_id !== account.id || agent.runtime !== "browser" || agent.trust === "suspended")
		return error(403, "not your browser AI");
	if (b?.kind !== "decision" && b?.kind !== "summary") return error(400, "bad kind");
	const user = typeof b.user === "string" ? b.user.slice(0, 4000) : "";
	if (!user) return error(400, "bad prompt");
	if (remaining <= 0) return json({ error: "limit", remaining: 0 }, 429);
	if (!env.AI) return error(503, "Workers AI is not available");
	// the system prompt and the output schema are built here: the endpoint only plays a resident of the city
	const landmarkIds = ALL_LANDMARK_IDS.filter((id) => b.landmarkIds?.includes(id) ?? true);
	const llm = new WorkersAiLLM(env.AI);
	const result = await llm.complete({
		system: systemPrompt({ name: agent.name, personality: String(b.personality ?? "").slice(0, 400) }),
		user,
		schema: b.kind === "summary" ? SUMMARY_SCHEMA : decisionSchema(landmarkIds),
	});
	const neurons = llm.lastUsage?.neurons ?? 0;
	addRequestCost({ neurons });
	await addTrialCall(DB, account.id, day, neurons);
	return json({ result, remaining: remaining - 1 });
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
		const account = await findOrCreateAccount(DB, "dev", name, name);
		return loginResponse(account, safeRedirect(url.searchParams.get("redirect")));
	}
	return error(404, "not found");
}

async function route(request: Request, url: URL): Promise<Response> {
	// free play answers only on this machine, even if a development build were reachable from elsewhere
	if (FREE_PLAY && !isLocalHost(url.hostname)) return error(403, "free play is local only");
	if (DEV) await ensureSchema(DB);
	if (url.pathname.startsWith("/api/")) return api(request, url);
	if (url.pathname.startsWith("/auth/")) return auth(request, url);
	const ws = url.pathname.match(/^\/ws\/area\/([^/]+)$/);
	if (ws?.[1] && AREA_RE.test(ws[1]) && AREAS.areas[ws[1]]) return wsGateway(request, ws[1]);
	return error(404, "not found");
}

export default {
	async fetch(request, _env, ctx) {
		const url = new URL(request.url);
		const cost: Partial<Usage> = { workerRequests: 1 };
		const response = await requestUsage.run(cost, () => route(request, url));
		const label = gatewayLabel(request.method, url.pathname);
		unreported.push({ at: Date.now(), label, cost });
		// report to the room's meter at most once a minute per isolate (each report is one DO request)
		if (Date.now() - reportedAt > REPORT_MS) {
			const events = unreported;
			unreported = [];
			reportedAt = Date.now();
			ctx.waitUntil(
				env.ROOM.getByName(MAIN_AREA)
					.fetch(new Request("https://room/usage", { method: "POST", body: JSON.stringify(events) }))
					.catch(() => {}),
			);
		}
		return withUsageHeader(response, cost, label);
	},
} satisfies ExportedHandler<Env>;
