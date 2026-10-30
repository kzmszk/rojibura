import { describe, expect, test } from "vitest";
import {
	authPayload,
	exportPrivateKey,
	exportPublicKey,
	generateAgentKeyPair,
	importPrivateKey,
	MAX_PATH_POINTS,
	MAX_SAY_LENGTH,
	type MoveState,
	parseClientMessage,
	poseAt,
	positionAt,
	sanitizeText,
	signAuth,
	verifyAuth,
} from "./index.ts";

describe("parseClientMessage", () => {
	test("accepts a valid MOVE_PATH", () => {
		const r = parseClientMessage(
			JSON.stringify({
				t: "MOVE_PATH",
				path: [
					[0, 0],
					[3, 4],
				],
				speed: 1.4,
				seq: 1,
			}),
		);
		expect(r).toEqual({
			ok: true,
			msg: {
				t: "MOVE_PATH",
				path: [
					[0, 0],
					[3, 4],
				],
				speed: 1.4,
				seq: 1,
			},
		});
	});

	test("rejects too many points, bad speed and NaN", () => {
		const long = Array.from({ length: MAX_PATH_POINTS + 1 }, (_, i) => [i, 0]);
		expect(parseClientMessage(JSON.stringify({ t: "MOVE_PATH", path: long, speed: 1, seq: 1 })).ok).toBe(
			false,
		);
		expect(
			parseClientMessage(
				JSON.stringify({
					t: "MOVE_PATH",
					path: [
						[0, 0],
						[1, 1],
					],
					speed: 99,
					seq: 1,
				}),
			).ok,
		).toBe(false);
		expect(parseClientMessage('{"t":"MOVE_PATH","path":[[0,0],[1,null]],"speed":1,"seq":1}').ok).toBe(false);
	});

	test("normalizes MOVE_VEL direction", () => {
		const r = parseClientMessage(
			JSON.stringify({ t: "MOVE_VEL", pos: [1, 2], dir: [3, 4], speed: 2, seq: 5 }),
		);
		expect(r.ok && r.msg.t === "MOVE_VEL" && r.msg.dir).toEqual([0.6, 0.8]);
	});

	test("SAY strips control characters and enforces length", () => {
		const r = parseClientMessage(
			JSON.stringify({ t: "SAY", text: " こんにちは\u0000\n世界 ", to: "a_bot1" }),
		);
		expect(r).toEqual({ ok: true, msg: { t: "SAY", text: "こんにちは 世界", to: "a_bot1" } });
		expect(parseClientMessage(JSON.stringify({ t: "SAY", text: "あ".repeat(MAX_SAY_LENGTH + 1) })).ok).toBe(
			false,
		);
		expect(parseClientMessage(JSON.stringify({ t: "SAY", text: "   " })).ok).toBe(false);
		expect(parseClientMessage(JSON.stringify({ t: "SAY", text: "hi", to: "x" })).ok).toBe(false);
	});

	test("rejects unknown types, garbage and binary", () => {
		expect(parseClientMessage('{"t":"HACK"}').ok).toBe(false);
		expect(parseClientMessage("not json").ok).toBe(false);
		expect(parseClientMessage(new ArrayBuffer(4)).ok).toBe(false);
	});

	test("sanitizeText", () => {
		expect(sanitizeText("a‮b")).toBe("a‮b"); // bidi marks are left to the renderer
		expect(sanitizeText("a\u007Fb\u0085c")).toBe("abc");
	});
});

describe("poseAt", () => {
	test("walks along a path and stops at the end", () => {
		const move: MoveState = {
			kind: "path",
			path: [
				[0, 0],
				[10, 0],
				[10, 10],
			],
			speed: 2,
			at: 1000,
		};
		expect(positionAt(move, 1000)).toEqual([0, 0]);
		expect(positionAt(move, 3500)).toEqual([5, 0]);
		expect(positionAt(move, 7000)).toEqual([10, 2]);
		const end = poseAt(move, 100_000);
		expect(end.pos).toEqual([10, 10]);
		expect(end.moving).toBe(false);
		expect(end.dir).toEqual([0, 1]);
	});

	test("extrapolates velocity and lets the caller clamp", () => {
		const move: MoveState = { kind: "vel", pos: [0, 0], dir: [1, 0], speed: 3, at: 0 };
		expect(positionAt(move, 2000)).toEqual([6, 0]);
		expect(positionAt(move, 2000, (p) => [Math.min(p[0], 4), p[1]])).toEqual([4, 0]);
	});
});

describe("Ed25519 agent auth", () => {
	test("sign and verify, reject other payloads and keys", async () => {
		const kp = await generateAgentKeyPair(true);
		const pub = await exportPublicKey(kp.publicKey);
		const payload = authPayload("main", "a_bot1", "nonce123");
		const sig = await signAuth(kp.privateKey, payload);
		expect(await verifyAuth(pub, payload, sig)).toBe(true);
		expect(await verifyAuth(pub, authPayload("other", "a_bot1", "nonce123"), sig)).toBe(false);
		const other = await generateAgentKeyPair(true);
		expect(await verifyAuth(await exportPublicKey(other.publicKey), payload, sig)).toBe(false);
		expect(await verifyAuth(pub, payload, "garbage")).toBe(false);
	});

	test("private key round-trips through PKCS#8", async () => {
		const kp = await generateAgentKeyPair(true);
		const restored = await importPrivateKey(await exportPrivateKey(kp.privateKey));
		const payload = authPayload("main", "a_x", "n");
		expect(
			await verifyAuth(await exportPublicKey(kp.publicKey), payload, await signAuth(restored, payload)),
		).toBe(true);
	});
});
