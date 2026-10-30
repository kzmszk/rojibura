import { toBase64Url } from "@rojibura/protocol";
import { beforeAll, describe, expect, test } from "vitest";
import { authUrl, type Jwk, pkceChallenge, verifyIdToken } from "./oidc.ts";

const enc = (o: object) => toBase64Url(new TextEncoder().encode(JSON.stringify(o)));
let keys: CryptoKeyPair;
let jwk: Jwk;

async function sign(claims: object, kid = "k1", alg = "RS256"): Promise<string> {
	const head = enc({ alg, kid, typ: "JWT" });
	const body = enc(claims);
	const sig = await crypto.subtle.sign(
		"RSASSA-PKCS1-v1_5",
		keys.privateKey,
		new TextEncoder().encode(`${head}.${body}`),
	);
	return `${head}.${body}.${toBase64Url(sig)}`;
}

const now = Date.UTC(2026, 9, 31, 12);
const valid = {
	iss: "https://accounts.google.com",
	aud: "client-123",
	sub: "10987654321",
	iat: now / 1000 - 10,
	exp: now / 1000 + 3600,
};

beforeAll(async () => {
	keys = (await crypto.subtle.generateKey(
		{
			name: "RSASSA-PKCS1-v1_5",
			modulusLength: 2048,
			publicExponent: new Uint8Array([1, 0, 1]),
			hash: "SHA-256",
		},
		true,
		["sign", "verify"],
	)) as CryptoKeyPair;
	const exported = (await crypto.subtle.exportKey("jwk", keys.publicKey)) as JsonWebKey;
	jwk = { kid: "k1", kty: "RSA", alg: "RS256", n: exported.n ?? "", e: exported.e ?? "" };
});

describe("verifyIdToken", () => {
	test("accepts a valid token", async () => {
		expect(await verifyIdToken(await sign(valid), [jwk], "client-123", now)).toMatchObject({
			sub: "10987654321",
		});
	});

	test("rejects wrong audience, issuer, expiry, key and algorithm", async () => {
		expect(await verifyIdToken(await sign({ ...valid, aud: "other" }), [jwk], "client-123", now)).toBe(
			"bad audience",
		);
		expect(await verifyIdToken(await sign({ ...valid, iss: "https://evil" }), [jwk], "client-123", now)).toBe(
			"bad issuer",
		);
		expect(
			await verifyIdToken(await sign({ ...valid, exp: now / 1000 - 3600 }), [jwk], "client-123", now),
		).toBe("expired");
		expect(await verifyIdToken(await sign(valid, "unknown"), [jwk], "client-123", now)).toBe("unknown key");
		expect(await verifyIdToken(await sign(valid, "k1", "none"), [jwk], "client-123", now)).toBe(
			"unexpected algorithm",
		);
	});

	test("rejects a tampered payload", async () => {
		const [h, , s] = (await sign(valid)).split(".");
		const forged = `${h}.${enc({ ...valid, sub: "attacker" })}.${s}`;
		expect(await verifyIdToken(forged, [jwk], "client-123", now)).toBe("bad signature");
	});
});

test("authUrl asks only for openid with PKCE S256", async () => {
	const url = new URL(
		await authUrl("client-123", "http://localhost:5173/auth/google/callback", "st", "verifier"),
	);
	expect(url.searchParams.get("scope")).toBe("openid");
	expect(url.searchParams.get("code_challenge_method")).toBe("S256");
	expect(url.searchParams.get("code_challenge")).toBe(await pkceChallenge("verifier"));
});
