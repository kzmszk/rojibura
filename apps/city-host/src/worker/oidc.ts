// Google OpenID Connect: Authorization Code + PKCE, scope "openid" only (docs/prd.md 2.2.3).
// Pure functions plus small fetch wrappers so the verification can be unit tested.

import { fromBase64Url, randomToken, toBase64Url } from "@rojibura/protocol";

export const GOOGLE_AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";
export const GOOGLE_JWKS = "https://www.googleapis.com/oauth2/v3/certs";
const ISSUERS = ["https://accounts.google.com", "accounts.google.com"];

export interface Jwk {
	kid: string;
	kty: string;
	alg?: string;
	n: string;
	e: string;
}

export interface IdClaims {
	iss: string;
	aud: string;
	sub: string;
	exp: number;
	iat: number;
}

export async function pkceChallenge(verifier: string): Promise<string> {
	return toBase64Url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
}

export function newPkce(): { state: string; verifier: string } {
	return { state: randomToken(16), verifier: randomToken(48) };
}

export async function authUrl(
	clientId: string,
	redirectUri: string,
	state: string,
	verifier: string,
): Promise<string> {
	const q = new URLSearchParams({
		client_id: clientId,
		redirect_uri: redirectUri,
		response_type: "code",
		scope: "openid",
		state,
		code_challenge: await pkceChallenge(verifier),
		code_challenge_method: "S256",
		prompt: "select_account",
	});
	return `${GOOGLE_AUTH}?${q}`;
}

/** Verifies an RS256 ID token against the given keys. Returns the claims or a reason. */
export async function verifyIdToken(
	token: string,
	jwks: Jwk[],
	clientId: string,
	now = Date.now(),
): Promise<IdClaims | string> {
	const [h, p, s] = token.split(".");
	if (!h || !p || !s) return "malformed token";
	let header: { alg?: string; kid?: string };
	let claims: IdClaims;
	try {
		header = JSON.parse(new TextDecoder().decode(fromBase64Url(h)));
		claims = JSON.parse(new TextDecoder().decode(fromBase64Url(p)));
	} catch {
		return "malformed token";
	}
	if (header.alg !== "RS256") return "unexpected algorithm";
	const jwk = jwks.find((k) => k.kid === header.kid);
	if (!jwk) return "unknown key";
	const key = await crypto.subtle.importKey(
		"jwk",
		{ kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
		{ name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
		false,
		["verify"],
	);
	const ok = await crypto.subtle.verify(
		"RSASSA-PKCS1-v1_5",
		key,
		fromBase64Url(s),
		new TextEncoder().encode(`${h}.${p}`),
	);
	if (!ok) return "bad signature";
	if (!ISSUERS.includes(claims.iss)) return "bad issuer";
	if (claims.aud !== clientId) return "bad audience";
	const t = Math.floor(now / 1000);
	if (typeof claims.exp !== "number" || claims.exp < t - 60) return "expired";
	if (typeof claims.iat !== "number" || claims.iat > t + 300) return "issued in the future";
	if (typeof claims.sub !== "string" || claims.sub.length === 0) return "no subject";
	return claims;
}

let jwksCache: { keys: Jwk[]; until: number } | null = null;

export async function googleKeys(now = Date.now()): Promise<Jwk[]> {
	if (jwksCache && jwksCache.until > now) return jwksCache.keys;
	const r = await fetch(GOOGLE_JWKS);
	if (!r.ok) throw new Error(`JWKS ${r.status}`);
	const keys = ((await r.json()) as { keys: Jwk[] }).keys;
	jwksCache = { keys, until: now + 60 * 60 * 1000 };
	return keys;
}

export async function exchangeCode(input: {
	code: string;
	verifier: string;
	clientId: string;
	clientSecret: string;
	redirectUri: string;
}): Promise<string> {
	const r = await fetch(GOOGLE_TOKEN, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			code: input.code,
			client_id: input.clientId,
			client_secret: input.clientSecret,
			redirect_uri: input.redirectUri,
			grant_type: "authorization_code",
			code_verifier: input.verifier,
		}),
	});
	const body = (await r.json()) as { id_token?: string; error?: string };
	if (!r.ok || !body.id_token) throw new Error(`token exchange failed: ${body.error ?? r.status}`);
	return body.id_token;
}
