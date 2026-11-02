import { describe, expect, test } from "vitest";
import {
	authPayload,
	bodyDuration,
	exportPrivateKey,
	exportPublicKey,
	facing,
	generateAgentKeyPair,
	importPrivateKey,
	MAX_PATH_LENGTH,
	MAX_PATH_POINTS,
	MAX_SAY_LENGTH,
	type MoveState,
	modelUrl,
	parseBodyKeys,
	parseClientMessage,
	pathLeg,
	polylineLength,
	poseAt,
	positionAt,
	sanitizeText,
	signAuth,
	type Vec2,
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

describe("pathLeg", () => {
	test("keeps a path the host accepts as it is", () => {
		const path: Vec2[] = [
			[0, 0],
			[100, 0],
			[100, 50],
		];
		expect(pathLeg(path)).toEqual(path);
	});

	test("cuts a long way where MAX_PATH_LENGTH runs out, on the way", () => {
		const leg = pathLeg([
			[0, 0],
			[150, 0],
			[150, 150],
		]);
		expect(leg).toEqual([
			[0, 0],
			[150, 0],
			[150, MAX_PATH_LENGTH - 1 - 150],
		]);
		expect(polylineLength(leg)).toBeLessThan(MAX_PATH_LENGTH);
	});

	test("keeps at most MAX_PATH_POINTS points", () => {
		const path = Array.from({ length: 40 }, (_, i): Vec2 => [i, i % 2]);
		const leg = pathLeg(path);
		expect(leg).toHaveLength(MAX_PATH_POINTS);
		expect(leg).toEqual(path.slice(0, MAX_PATH_POINTS));
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

describe("BUILD and UNBUILD (free play, docs/prd.md 3.7)", () => {
	const parse = (v: unknown) => parseClientMessage(JSON.stringify(v));

	test("anchors, normalised colours and rotations, sanitised labels", () => {
		expect(
			parse({
				t: "BUILD",
				model: "house",
				at: { landmark: "cafe" },
				color: "Red",
				rot: -90,
				label: "ハルの\n家",
				ref: "r-1",
			}),
		).toEqual({
			ok: true,
			msg: {
				t: "BUILD",
				model: "house",
				at: { landmark: "cafe" },
				color: "#c8473d",
				rot: 270,
				label: "ハルの 家",
				ref: "r-1",
			},
		});
		expect(
			parse({ t: "BUILD", model: "m_0123456789abcdef", at: { avatar: "a_x1", offset: [2, -1] } }).ok,
		).toBe(true);
		expect(
			parse({ t: "BUILD", model: "block", at: { pos: [1, 2] }, size: [2, 3, 0.5], color: "#abc" }),
		).toEqual({
			ok: true,
			msg: { t: "BUILD", model: "block", at: { pos: [1, 2] }, size: [2, 3, 0.5], color: "#aabbcc" },
		});
		expect(parse({ t: "UNBUILD", id: "b_abc", ref: "x" })).toEqual({
			ok: true,
			msg: { t: "UNBUILD", id: "b_abc", ref: "x" },
		});
	});

	test("rejects what does not fit", () => {
		const bad = [
			{ t: "BUILD", model: "castle", at: { pos: [0, 0] } },
			{ t: "BUILD", model: "m_123", at: { pos: [0, 0] } },
			{ t: "BUILD", model: "house", at: {} },
			{ t: "BUILD", model: "house", at: { pos: [0, 0], landmark: "cafe" } },
			{ t: "BUILD", model: "house", at: { pos: [0, 0], offset: [1, 1] } },
			{ t: "BUILD", model: "house", at: { landmark: "cafe", offset: [100, 0] } },
			{ t: "BUILD", model: "house", at: { avatar: "x_1" } },
			{ t: "BUILD", model: "house", at: { pos: [0, 0] }, scale: 10 },
			{ t: "BUILD", model: "block", at: { pos: [0, 0] }, size: [0, 1, 1] },
			{ t: "BUILD", model: "block", at: { pos: [0, 0] }, size: [1, 100, 1] },
			{ t: "BUILD", model: "house", at: { pos: [0, 0] }, color: "chartreuse" },
			{ t: "BUILD", model: "house", at: { pos: [0, 0] }, label: "あ".repeat(25) },
			{ t: "BUILD", model: "house", at: { pos: [0, 0] }, ref: "has space" },
			{ t: "UNBUILD", id: "x" },
		];
		for (const v of bad) expect(parse(v).ok, JSON.stringify(v)).toBe(false);
	});

	test("helpers", () => {
		expect(modelUrl("house", "glb")).toBe("/models/house.glb");
		expect(modelUrl("house", "glb", true)).toBe("/models/house.glb");
		expect(modelUrl("m_0123456789abcdef", "nav.json", true)).toBe("/api/models/m_0123456789abcdef.nav.json");
		expect(modelUrl("m_0123456789abcdef", "glb")).toBe("/models/m_0123456789abcdef.glb");
		expect(facing([0, 0], [0, 5])).toBe(0);
		expect(facing([0, 0], [5, 0])).toBe(90);
		expect(facing([0, 0], [-5, 0])).toBe(270);
	});
});

describe("body scripts", () => {
	test("a script is cleaned up, and what is wrong with one is said in words an AI can act on", () => {
		const ok = parseClientMessage(
			JSON.stringify({
				t: "BODY",
				to: "h_alice",
				keys: [
					{
						at: 0.8,
						right: { part: "head", of: "you", off: [0, 0.02, 0], palm: "down", extra: 1 },
						smile: true,
					},
					{ at: 2, right: { part: "head", of: "you", wiggle: { dir: "side", size: 0.05, hz: 2 } } },
					{ at: 3, right: "rest", look: "ahead", lean: 10, height: -0.1 },
				],
			}),
		);
		expect(ok).toEqual({
			ok: true,
			msg: {
				t: "BODY",
				to: "h_alice",
				keys: [
					{ at: 0.8, right: { part: "head", of: "you", off: [0, 0.02, 0], palm: "down" }, smile: true },
					{ at: 2, right: { part: "head", of: "you", wiggle: { dir: "side", size: 0.05, hz: 2 } } },
					{ at: 3, right: "rest", look: "ahead", lean: 10, height: -0.1 },
				],
			},
		});
		const bad = (keys: unknown) => parseBodyKeys(keys);
		expect(bad([])).toMatch(/keys/);
		expect(bad([{ at: 2 }, { at: 1 }])).toMatch(/前のキーより後/);
		expect(bad([{ at: 1, right: { part: "knee" } }])).toMatch(/part は head/);
		expect(bad([{ at: 1, right: { part: "head", of: "you", off: [0, -0.5, 0] } }])).toMatch(/0.15/);
		expect(bad([{ at: 1, left: { part: "front", of: "you" } }])).toMatch(/front は自分の前だけ/);
		expect(bad([{ at: 9 }])).toMatch(/0〜8秒/);
		expect(bad([{ at: 1, height: -1 }])).toMatch(/height/);
		expect(bodyDuration([{ at: 2 }])).toBeCloseTo(2.8);
	});
});
