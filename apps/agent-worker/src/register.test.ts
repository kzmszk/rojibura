import { importPrivateKey, registrationPayload, verifyAuth } from "@rojibura/protocol";
import { expect, test } from "vitest";
import { registerWithCode } from "./register.ts";

test("registers with the code, a public key and a signature that only its private key could make", async () => {
	let sent: { code: string; publicKey: string; signature: string } | undefined;
	let url = "";
	const fetcher = (async (input: URL | RequestInfo, init?: RequestInit) => {
		url = String(input);
		sent = JSON.parse(String(init?.body));
		return Response.json({ id: "a_new", name: "ミナト", trust: "provisional" }, { status: 201 });
	}) as typeof fetch;

	const identity = await registerWithCode("https://city.test/", "rjreg_abc", fetcher);

	expect(url).toBe("https://city.test/api/agents/register");
	expect(sent?.code).toBe("rjreg_abc");
	expect(
		await verifyAuth(sent?.publicKey ?? "", registrationPayload("rjreg_abc"), sent?.signature ?? ""),
	).toBe(true);
	// the code is bound into the signature: it does not hold for another code
	expect(await verifyAuth(sent?.publicKey ?? "", registrationPayload("other"), sent?.signature ?? "")).toBe(
		false,
	);
	expect(identity).toMatchObject({ agentId: "a_new", name: "ミナト" });
	// the key it keeps is the one it registered
	await expect(importPrivateKey(identity.privateKey)).resolves.toBeDefined();
});

test("says what the city answered when it refuses", async () => {
	const fetcher = (async () => new Response('{"error":"used"}', { status: 404 })) as unknown as typeof fetch;
	await expect(registerWithCode("https://city.test", "rjreg_abc", fetcher)).rejects.toThrow(
		"registration refused (404)",
	);
});
