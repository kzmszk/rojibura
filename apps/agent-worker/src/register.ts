// T4 (docs/prd.md 2.2.4, issue #28): the AI makes its own key and registers it with the one-time code its owner
// made on /portal. The private key never leaves this account; the city gets the public key and a signature.

import {
	exportPrivateKey,
	exportPublicKey,
	generateAgentKeyPair,
	registrationPayload,
	signAuth,
} from "@rojibura/protocol";

export interface Identity {
	agentId: string;
	/** The Ed25519 private key (pkcs8, base64url). */
	privateKey: string;
	/** The name the owner gave it (absent for an AI registered by hand). */
	name?: string;
}

/** Registers a new AI with the code; the city says who it is. Throws with the city's answer if it refuses. */
export async function registerWithCode(
	cityUrl: string,
	code: string,
	fetcher: typeof fetch = fetch,
): Promise<Identity> {
	const keys = await generateAgentKeyPair(true);
	const res = await fetcher(new URL("/api/agents/register", cityUrl), {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			code,
			publicKey: await exportPublicKey(keys.publicKey),
			signature: await signAuth(keys.privateKey, registrationPayload(code)),
		}),
	});
	if (!res.ok) throw new Error(`registration refused (${res.status}): ${await res.text()}`);
	const { id, name } = (await res.json()) as { id: string; name: string };
	return { agentId: id, privateKey: await exportPrivateKey(keys.privateKey), name };
}
