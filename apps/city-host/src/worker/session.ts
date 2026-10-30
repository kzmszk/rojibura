// Signed session tokens in an HttpOnly cookie (docs/prd.md 2.2.3).

import { fromBase64Url, toBase64Url } from "@rojibura/protocol";

export const SESSION_COOKIE = "rj_session";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

export interface Session {
	/** Account ID ("h_..."). */
	aid: string;
	exp: number;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
	return crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign", "verify"],
	);
}

export async function createSessionToken(secret: string, aid: string, now = Date.now()): Promise<string> {
	const body = toBase64Url(new TextEncoder().encode(JSON.stringify({ aid, exp: now + SESSION_TTL_MS })));
	const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), new TextEncoder().encode(body));
	return `${body}.${toBase64Url(sig)}`;
}

export async function readSessionToken(
	secret: string,
	token: string,
	now = Date.now(),
): Promise<Session | null> {
	const [body, sig] = token.split(".");
	if (!body || !sig) return null;
	try {
		const ok = await crypto.subtle.verify(
			"HMAC",
			await hmacKey(secret),
			fromBase64Url(sig),
			new TextEncoder().encode(body),
		);
		if (!ok) return null;
		const s = JSON.parse(new TextDecoder().decode(fromBase64Url(body))) as Session;
		return typeof s.aid === "string" && typeof s.exp === "number" && s.exp > now ? s : null;
	} catch {
		return null;
	}
}

export function getCookie(request: Request, name: string): string | null {
	const header = request.headers.get("Cookie");
	if (!header) return null;
	for (const part of header.split(";")) {
		const [k, ...v] = part.trim().split("=");
		if (k === name) return v.join("=");
	}
	return null;
}

export function sessionCookie(token: string): string {
	return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_TTL_MS / 1000}`;
}

export function clearSessionCookie(): string {
	return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}
