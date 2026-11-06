// The identities of browser AIs (T3): each one's agent ID and an Ed25519 key that never leaves the browser
// (a non-extractable CryptoKey kept in IndexedDB, docs/prd.md 2.2.4). Kept per owner and per AI, so several
// accounts on one browser stay apart and a new AI never overwrites another.

import { exportPublicKey, generateAgentKeyPair } from "@rojibura/protocol";
import { idbDelete, idbDeletePrefix, idbGet, idbList, idbPut } from "./idb.ts";

export interface BrowserIdentity {
	agentId: string;
	name: string;
	/** What the owner wrote about it; sent with each trial LLM call. */
	personality: string;
	privateKey: CryptoKey;
}

/** Where the one AI of earlier versions is. It says nothing of its owner, so it is copied, not moved. */
const LEGACY_KEY = "default";

const keyOf = (ownerId: string, agentId: string) => `${ownerId}|${agentId}`;

export const loadBrowserIdentity = (ownerId: string, agentId: string) =>
	idbGet<BrowserIdentity>("agents", keyOf(ownerId, agentId));
export const saveBrowserIdentity = (ownerId: string, id: BrowserIdentity) =>
	idbPut("agents", keyOf(ownerId, id.agentId), id);
export const listBrowserIdentities = (ownerId: string) =>
	idbList<BrowserIdentity>("agents", keyOf(ownerId, ""));

/**
 * Gives the AI of earlier versions its place under its owner, if it is one of `agentIds` (theirs on the host) and
 * has none yet. Returns it when it was copied just now. Its notes are already kept by agent ID.
 */
export async function migrateLegacyBrowserIdentity(
	ownerId: string,
	agentIds: string[],
): Promise<BrowserIdentity | null> {
	const legacy = await idbGet<BrowserIdentity>("agents", LEGACY_KEY);
	if (!legacy || !agentIds.includes(legacy.agentId)) return null;
	if (await loadBrowserIdentity(ownerId, legacy.agentId)) return null;
	await saveBrowserIdentity(ownerId, legacy);
	return legacy;
}

/** Removes an AI's key and notes from this browser (the AI itself is gone from the host). */
export async function deleteBrowserIdentity(ownerId: string, agentId: string): Promise<void> {
	await idbDelete("agents", keyOf(ownerId, agentId));
	await idbDeletePrefix("memory", `${agentId}|`);
	const legacy = await idbGet<BrowserIdentity>("agents", LEGACY_KEY);
	if (legacy?.agentId === agentId) await idbDelete("agents", LEGACY_KEY);
}

/**
 * Registers a new browser AI for the logged-in owner (same-origin cookie) and keeps its key here. `preset`:
 * the look it keeps (one of the host's /api/presets).
 */
export async function registerBrowserAgent(
	baseUrl: string,
	ownerId: string,
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
	await saveBrowserIdentity(ownerId, id);
	return id;
}
