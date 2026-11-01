// The identity of a browser AI (T3): its agent ID and an Ed25519 key that never leaves the browser
// (a non-extractable CryptoKey kept in IndexedDB, docs/prd.md 2.2.4).

import { exportPublicKey, generateAgentKeyPair } from "@rojibura/protocol";
import { idbDelete, idbGet, idbPut } from "./idb.ts";

export interface BrowserIdentity {
	agentId: string;
	name: string;
	/** What the owner wrote about it; sent with each trial LLM call. */
	personality: string;
	privateKey: CryptoKey;
}

const KEY = "default";

export const loadBrowserIdentity = () => idbGet<BrowserIdentity>("agents", KEY);
export const saveBrowserIdentity = (id: BrowserIdentity) => idbPut("agents", KEY, id);
export const forgetBrowserIdentity = () => idbDelete("agents", KEY);

/**
 * Registers a new browser AI for the logged-in owner (same-origin cookie) and keeps its key here. `preset`:
 * the look it keeps (one of the host's /api/presets).
 */
export async function registerBrowserAgent(
	baseUrl: string,
	name: string,
	personality: string,
	preset?: string,
): Promise<BrowserIdentity> {
	const kp = await generateAgentKeyPair(false);
	const r = await fetch(`${baseUrl}/api/agents`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			name,
			publicKey: await exportPublicKey(kp.publicKey),
			runtime: "browser",
			...(preset ? { preset } : {}),
		}),
	});
	const body = (await r.json().catch(() => ({}))) as { id?: string; name?: string; error?: string };
	if (!r.ok || !body.id) throw new Error(body.error ?? `登録できませんでした（${r.status}）`);
	const id: BrowserIdentity = {
		agentId: body.id,
		name: body.name ?? name,
		personality,
		privateKey: kp.privateKey,
	};
	await saveBrowserIdentity(id);
	return id;
}
