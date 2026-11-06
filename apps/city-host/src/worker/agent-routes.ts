import { importPublicKey, registrationPayload, verifyAuth } from "@rojibura/protocol";
import {
	type Account,
	bannedAmong,
	cleanName,
	deleteAgent,
	getAgent,
	issueRegistrationCode,
	listAgents,
	pairedPcsOf,
	pairPc,
	redeemRegistrationCode,
	registerAgent,
	setAgentPreset,
	setAgentTrust,
	startPairing,
	unpairPc,
} from "./db.ts";
import { normalizePairCode } from "./pairing.ts";
import type { RoomCommand } from "./room.ts";
import { AREA_IDS, DEFAULT_PRESET, PRESETS } from "./world.ts";

function json(data: unknown, status = 200): Response {
	return Response.json(data, { status });
}
function error(status: number, message: string): Response {
	return json({ error: message }, status);
}

export async function agentRoutes(
	request: Request,
	url: URL,
	deps: {
		db: D1Database;
		currentAccount: (request: Request) => Promise<Account | null>;
		devAllowed: (request: Request, url: URL) => boolean;
		freePlay: boolean;
		room: Env["ROOM"];
		broadcastCommand: (command: RoomCommand) => Promise<void>;
	},
): Promise<Response | null> {
	const path = url.pathname;
	if (path === "/api/agents" && request.method === "POST") {
		const account = await deps.currentAccount(request);
		if (!account) return error(401, "login required");
		const body = (await request.json().catch(() => null)) as {
			name?: string;
			publicKey?: string;
			runtime?: string;
			/** The look, one of PRESETS (the AI keeps it). */
			preset?: string;
		} | null;
		const name = cleanName(body?.name ?? "");
		if (!name) return error(400, "bad name");
		const preset = body?.preset;
		if (preset !== undefined && !Object.hasOwn(PRESETS, preset)) return error(400, "bad preset");
		const runtime = body?.runtime;
		if (runtime !== "browser" && runtime !== "worker" && runtime !== "node") return error(400, "bad runtime");
		const publicKey = body?.publicKey ?? "";
		try {
			await importPublicKey(publicKey);
		} catch {
			return error(400, "bad public key");
		}
		const r = await registerAgent(
			deps.db,
			account.id,
			// admins are the ones who approve: theirs need no one's approval (docs/prd.md 2.2.2)
			{ name, publicKey, runtime, preset, trust: account.role === "admin" ? "approved" : "provisional" },
			deps.freePlay ? null : undefined,
		);
		if (typeof r === "string") return error(409, r);
		return json({ id: r.id, name: r.name, trust: r.trust }, 201);
	}

	// T4 (docs/prd.md 2.2.4, issue #28): the owner makes a one-time code for an AI that will run in their own
	// Cloudflare account. The code is shown once and only its hash is kept.
	if (path === "/api/registration-codes" && request.method === "POST") {
		const account = await deps.currentAccount(request);
		if (!account) return error(401, "login required");
		const body = (await request.json().catch(() => null)) as { name?: string; preset?: string } | null;
		const name = cleanName(body?.name ?? "");
		if (!name) return error(400, "bad name");
		const preset = body?.preset;
		if (preset !== undefined && !Object.hasOwn(PRESETS, preset)) return error(400, "bad preset");
		const r = await issueRegistrationCode(
			deps.db,
			account.id,
			{ name, preset },
			deps.freePlay ? null : undefined,
		);
		if (typeof r === "string") return error(409, r);
		return json(r, 201);
	}
	if (path === "/api/agents/register" && request.method === "POST") {
		// no login: the code, made by the owner and spent once, is the credential. The signature shows that the
		// sender holds the private key of the key it registers.
		const body = (await request.json().catch(() => null)) as {
			code?: unknown;
			publicKey?: unknown;
			signature?: unknown;
		} | null;
		const code = typeof body?.code === "string" ? body.code : "";
		const publicKey = typeof body?.publicKey === "string" ? body.publicKey : "";
		const signature = typeof body?.signature === "string" ? body.signature : "";
		if (!code) return error(400, "bad code");
		try {
			await importPublicKey(publicKey);
		} catch {
			return error(400, "bad public key");
		}
		if (!(await verifyAuth(publicKey, registrationPayload(code), signature)))
			return error(400, "bad signature");
		const r = await redeemRegistrationCode(deps.db, code, publicKey, deps.freePlay ? null : undefined);
		if (r === null)
			return error(404, "そのコードは使えません（15分で切れます。ポータルで出し直してください）");
		if (typeof r === "string") return error(409, r);
		return json({ id: r.id, name: r.name, trust: r.trust }, 201);
	}

	// 🤖 自分のAI: where each of the owner's AIs is now, in any area, and what the host knows of it. All of them in
	// one go: each area is asked once, however many AIs there are.
	if (path === "/api/agents/status" && request.method === "GET") {
		const account = await deps.currentAccount(request);
		if (!account) return error(401, "login required");
		const agents = await listAgents(deps.db, account.id);
		const ids = agents.map((a) => a.id);
		const [pcs, banned, areas] = await Promise.all([
			pairedPcsOf(deps.db, account.id),
			bannedAmong(deps.db, ids),
			ids.length === 0
				? []
				: Promise.all(
						AREA_IDS.map(async (area) => {
							const q = encodeURIComponent(ids.join(","));
							const r = await deps.room.getByName(area).fetch(new Request(`https://room/present?ids=${q}`));
							const { present } = (await r.json()) as { present: Record<string, string | null> };
							return { area, present };
						}),
					),
		]);
		return json({
			agents: ids.map((id) => {
				const at = areas.find((a) => Object.hasOwn(a.present, id));
				return {
					id,
					paired: pcs.has(id),
					pairedAt: pcs.get(id) ?? null,
					area: at?.area ?? null,
					runsOn: at?.present[id] ?? null,
					banned: banned.has(id),
				};
			}),
		});
	}

	// the owner removes an AI from their list: out of the city first, so its life is not saved after it is gone
	const one = path.match(/^\/api\/agents\/(a_[A-Za-z0-9_-]+)$/);
	if (one?.[1] && request.method === "DELETE") {
		const account = await deps.currentAccount(request);
		if (!account) return error(401, "login required");
		const agent = await getAgent(deps.db, one[1]);
		if (!agent || agent.owner_id !== account.id) return error(404, "no such agent");
		// deleting must not be a way out of a ban
		if ((await bannedAmong(deps.db, [agent.id])).size > 0)
			return error(409, "利用停止中のAIは削除できません");
		await deps.broadcastCommand({ op: "kick", id: agent.id, message: "オーナーがこのAIを削除しました" });
		await deleteAgent(deps.db, agent.id);
		return json({ ok: true });
	}

	// an AI on its owner's PC (docs/prd.md 3.5.1): 🤖 自分のAI shows a one-time code, the PC sends it with its key
	const pcPath = path.match(/^\/api\/agents\/(a_[A-Za-z0-9_-]+)\/(pair|pc|look)$/);
	if (pcPath?.[1]) {
		const account = await deps.currentAccount(request);
		if (!account) return error(401, "login required");
		const agent = await getAgent(deps.db, pcPath[1]);
		if (!agent || agent.owner_id !== account.id) return error(404, "no such agent");
		if (pcPath[2] === "pair" && request.method === "POST") return json(await startPairing(deps.db, agent.id));
		// the look (a PRESETS id): read, and changed, e.g. to another outfit of the same character
		if (pcPath[2] === "look" && request.method === "GET")
			return json({
				preset: Object.hasOwn(PRESETS, agent.preset_id ?? "") ? agent.preset_id : DEFAULT_PRESET.id,
			});
		if (pcPath[2] === "look" && request.method === "PUT") {
			const preset = ((await request.json().catch(() => null)) as { preset?: unknown } | null)?.preset;
			if (typeof preset !== "string" || !Object.hasOwn(PRESETS, preset)) return error(400, "bad preset");
			await setAgentPreset(deps.db, agent.id, preset);
			return json({ ok: true, preset });
		}
		if (pcPath[2] === "pc" && request.method === "DELETE") {
			await unpairPc(deps.db, agent.id);
			return json({ ok: true });
		}
		return error(405, "method not allowed");
	}
	if (path === "/api/pair" && request.method === "POST") {
		// no login: the code, shown to the owner and spent once, is the credential
		const body = (await request.json().catch(() => null)) as { code?: unknown; publicKey?: unknown } | null;
		const code = normalizePairCode(body?.code);
		const publicKey = typeof body?.publicKey === "string" ? body.publicKey : "";
		if (!code) return error(400, "bad code");
		try {
			await importPublicKey(publicKey);
		} catch {
			return error(400, "bad public key");
		}
		const agent = await pairPc(deps.db, code, publicKey);
		if (!agent)
			return error(404, "そのコードは使えません（10分で切れます。街の「🤖 自分のAI」で出し直してください）");
		return json({ id: agent.id, name: agent.name }, 201);
	}

	const approve = path.match(/^\/api\/dev\/agents\/(a_[A-Za-z0-9_-]+)\/approve$/);
	if (approve?.[1] && request.method === "POST" && deps.devAllowed(request, url)) {
		await setAgentTrust(deps.db, approve[1], "approved");
		return json({ ok: true });
	}

	return null;
}
