// AI agent authentication with Ed25519 (docs/prd.md 2.2.4).
// Uses WebCrypto only, so the same code runs in browsers, Workers and Node.

const ED25519 = { name: "Ed25519" } as const;

/** The exact bytes an agent signs when answering a CHALLENGE. Binding the area and agent ID prevents reuse. */
export function authPayload(areaId: string, agentId: string, nonce: string): string {
	return `rojibura/v2/auth\n${areaId}\n${agentId}\n${nonce}`;
}

/** What an AI signs when it registers with a one-time code: proof that it holds the private key it registers. */
export function registrationPayload(code: string): string {
	return `rojibura/v2/register\n${code}`;
}

export function toBase64Url(bytes: ArrayBuffer | Uint8Array): string {
	const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
	let s = "";
	for (const b of u8) s += String.fromCharCode(b);
	return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(s: string): Uint8Array<ArrayBuffer> {
	const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
	const bin = atob(b64);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

/** Random URL-safe token (nonces, IDs). */
export function randomToken(bytes = 16): string {
	return toBase64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function generateAgentKeyPair(extractable: boolean): Promise<CryptoKeyPair> {
	return (await crypto.subtle.generateKey(ED25519, extractable, ["sign", "verify"])) as CryptoKeyPair;
}

/** Raw 32-byte public key, base64url. This is what the host stores. */
export async function exportPublicKey(key: CryptoKey): Promise<string> {
	return toBase64Url((await crypto.subtle.exportKey("raw", key)) as ArrayBuffer);
}

export async function importPublicKey(b64: string): Promise<CryptoKey> {
	return crypto.subtle.importKey("raw", fromBase64Url(b64), ED25519, false, ["verify"]);
}

/** PKCS#8 private key, base64url (for runtimes that keep the key in a file or secret). */
export async function exportPrivateKey(key: CryptoKey): Promise<string> {
	return toBase64Url((await crypto.subtle.exportKey("pkcs8", key)) as ArrayBuffer);
}

export async function importPrivateKey(b64: string): Promise<CryptoKey> {
	return crypto.subtle.importKey("pkcs8", fromBase64Url(b64), ED25519, false, ["sign"]);
}

export async function signAuth(privateKey: CryptoKey, payload: string): Promise<string> {
	const sig = await crypto.subtle.sign(ED25519, privateKey, new TextEncoder().encode(payload));
	return toBase64Url(sig);
}

export async function verifyAuth(publicKeyB64: string, payload: string, sigB64: string): Promise<boolean> {
	try {
		const key = await importPublicKey(publicKeyB64);
		return await crypto.subtle.verify(ED25519, key, fromBase64Url(sigB64), new TextEncoder().encode(payload));
	} catch {
		return false;
	}
}
