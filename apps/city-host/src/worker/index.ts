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
	cleanName,
	ensureSchema,
	findOrCreateAccount,
	getAccount,
	getAgent,
	isBanned,
	listAgents,
	registerAgent,
	setAgentTrust,
} from "./db.ts";
import { isOpen, nextOpening } from "./hours.ts";
import type { JoinRequest } from "./room.ts";
import {
	clearSessionCookie,
	createSessionToken,
	getCookie,
	readSessionToken,
	SESSION_COOKIE,
	sessionCookie,
} from "./session.ts";
import { DEFAULT_PRESET, PRESETS } from "./world.ts";

export { CityRoomDO } from "./room.ts";

const DEV = env.DEV_AUTH === "1";
const AREA_RE = /^[a-z0-9-]{1,32}$/;

function sessionSecret(): string {
	if (env.SESSION_SECRET) return env.SESSION_SECRET;
	if (DEV) return "dev-only-insecure-session-secret";
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
	return new Response(null, {
		status: 302,
		headers: { Location: redirect, "Set-Cookie": sessionCookie(token) },
	});
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
	if (path === "/api/health") return json({ ok: true, dev: DEV, open: isOpen(Date.now()) });
	if (path === "/api/presets") return json(Object.values(PRESETS));

	if (path === "/api/me") {
		const account = await currentAccount(request);
		if (!account) return error(401, "login required");
		const agents = await listAgents(env.DB, account.id);
		return json({
			id: account.id,
			name: account.display_name,
			role: account.role,
			agents: agents.map((a) => ({ id: a.id, name: a.name, runtime: a.runtime, trust: a.trust })),
		});
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
	if (DEV && stats?.[1]) return env.ROOM.getByName(stats[1]).fetch(new Request("https://room/stats"));

	const approve = path.match(/^\/api\/dev\/agents\/(a_[A-Za-z0-9_-]+)\/approve$/);
	if (DEV && approve?.[1] && request.method === "POST") {
		await setAgentTrust(env.DB, approve[1], "approved");
		return json({ ok: true });
	}

	if (DEV && path === "/api/dev/selftest") return devSelftest();
	return error(404, "not found");
}

async function auth(_request: Request, url: URL): Promise<Response> {
	if (url.pathname === "/auth/logout") {
		return new Response(null, {
			status: 302,
			headers: { Location: "/", "Set-Cookie": clearSessionCookie() },
		});
	}
	if (url.pathname === "/auth/dev/login") {
		if (!DEV) return error(404, "not found");
		const name = cleanName(url.searchParams.get("name") ?? "");
		if (!name) return error(400, "name is required (1-24 characters)");
		const account = await findOrCreateAccount(env.DB, "dev", name, name);
		const redirect = url.searchParams.get("redirect") ?? "/";
		return loginResponse(account, redirect.startsWith("/") && !redirect.startsWith("//") ? redirect : "/");
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
