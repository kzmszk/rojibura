// Agent identity file: agent ID and Ed25519 key pair, kept with permission 600 (docs/prd.md 3.5.1, T5).

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
	exportPrivateKey,
	exportPublicKey,
	generateAgentKeyPair,
	importPrivateKey,
} from "@rojibura/protocol";

export interface IdentityFile {
	baseUrl: string;
	agentId: string;
	name: string;
	publicKey: string;
	privateKey: string;
}

export async function loadIdentity(path: string): Promise<IdentityFile | null> {
	try {
		return JSON.parse(await readFile(path, "utf8")) as IdentityFile;
	} catch {
		return null;
	}
}

export async function saveIdentity(path: string, id: IdentityFile): Promise<void> {
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	await writeFile(path, JSON.stringify(id, null, 1), { mode: 0o600 });
}

export function privateKeyOf(id: IdentityFile): Promise<CryptoKey> {
	return importPrivateKey(id.privateKey);
}

/**
 * Development registration: logs in as `owner` with the host's dummy login (cf dev only) and registers
 * a new agent. Production registration uses a one-time code from the owner portal (Phase 2).
 */
export async function registerWithDevLogin(
	baseUrl: string,
	owner: string,
	name: string,
): Promise<IdentityFile> {
	const login = await fetch(`${baseUrl}/auth/dev/login?name=${encodeURIComponent(owner)}`, {
		redirect: "manual",
	});
	const cookie = login.headers.get("set-cookie")?.split(";")[0];
	if (!cookie) throw new Error(`dev login failed (${login.status}); is the host running with cf dev?`);
	const kp = await generateAgentKeyPair(true);
	const publicKey = await exportPublicKey(kp.publicKey);
	const r = await fetch(`${baseUrl}/api/agents`, {
		method: "POST",
		headers: { Cookie: cookie, "Content-Type": "application/json" },
		body: JSON.stringify({ name, publicKey, runtime: "node" }),
	});
	const body = (await r.json()) as { id?: string; error?: string };
	if (!r.ok || !body.id) throw new Error(`agent registration failed: ${body.error ?? r.status}`);
	return { baseUrl, agentId: body.id, name, publicKey, privateKey: await exportPrivateKey(kp.privateKey) };
}
