import { importPublicKey } from "@rojibura/protocol";
import {
	type Account,
	cleanName,
	getAgent,
	pairPc,
	pcOf,
	registerAgent,
	setAgentPreset,
	setAgentTrust,
	startPairing,
	unpairPc,
} from "./db.ts";
import { normalizePairCode } from "./pairing.ts";
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
			{ name, publicKey, runtime, preset },
			deps.freePlay ? null : undefined,
		);
		if (typeof r === "string") return error(409, r);
		return json({ id: r.id, name: r.name, trust: r.trust }, 201);
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
		if (pcPath[2] === "pc" && request.method === "GET") {
			// inCity: the AI is in some area now (from the PC, or another tab), so the tab does not start it
			const [pc, here] = await Promise.all([
				pcOf(deps.db, agent.id),
				Promise.all(
					AREA_IDS.map((a) =>
						deps.room
							.getByName(a)
							.fetch(new Request(`https://room/present?id=${encodeURIComponent(agent.id)}`))
							.then((r) => r.json() as Promise<{ here: boolean }>),
					),
				),
			]);
			return json({ paired: pc !== null, pairedAt: pc?.paired_at ?? null, inCity: here.some((h) => h.here) });
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
