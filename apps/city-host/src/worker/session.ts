// Signed tokens in HttpOnly cookies: the session (docs/prd.md 2.2.3) and the short-lived OAuth state.

import { fromBase64Url, toBase64Url } from "@rojibura/protocol";

export const SESSION_COOKIE = "rj_session";
export const OAUTH_COOKIE = "rj_oauth";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
export const OAUTH_TTL_MS = 10 * 60 * 1000;

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

/** `purpose` is signed too, so a token for one cookie cannot be replayed as another. */
export async function createSignedToken(
	secret: string,
	purpose: string,
	data: Record<string, unknown>,
	ttlMs: number,
	now = Date.now(),
): Promise<string> {
	const body = toBase64Url(
		new TextEncoder().encode(JSON.stringify({ ...data, p: purpose, exp: now + ttlMs })),
	);
	const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), new TextEncoder().encode(body));
	return `${body}.${toBase64Url(sig)}`;
}

export async function readSignedToken<T>(
	secret: string,
	purpose: string,
	token: string,
	now = Date.now(),
): Promise<(T & { exp: number }) | null> {
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
		const v = JSON.parse(new TextDecoder().decode(fromBase64Url(body))) as T & { p?: string; exp: number };
		return v.p === purpose && typeof v.exp === "number" && v.exp > now ? v : null;
	} catch {
		return null;
	}
}

export function createSessionToken(secret: string, aid: string, now = Date.now()): Promise<string> {
	return createSignedToken(secret, "session", { aid }, SESSION_TTL_MS, now);
}

export async function readSessionToken(
	secret: string,
	token: string,
	now = Date.now(),
): Promise<Session | null> {
	const s = await readSignedToken<Session>(secret, "session", token, now);
	return s && typeof s.aid === "string" ? s : null;
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

export function cookie(name: string, value: string, maxAgeMs: number): string {
	return `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${Math.floor(maxAgeMs / 1000)}`;
}

export function sessionCookie(token: string): string {
	return cookie(SESSION_COOKIE, token, SESSION_TTL_MS);
}

export function clearSessionCookie(): string {
	return cookie(SESSION_COOKIE, "", 0);
}
