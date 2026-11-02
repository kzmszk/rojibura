// Body scripts (docs/prd.md 3.4.11): an AI moves its own body by saying where its hands go, where it looks,
// how far it leans and how low it gets, key by key. Nothing here is a motion of its own: every screen works
// the joints out (inverse kinematics) from the parts of the bodies the keys point at.

import { BODY_KEYS_MAX, BODY_OFFSET_MAX, BODY_OFFSET_YOU_MAX, BODY_SECONDS_MAX } from "./limits.ts";

/** Parts of a body a key can point at. "front" is a point in front of your own chest (yours only). */
export type BodyPart =
	| "head"
	| "face"
	| "mouth"
	| "chin"
	| "cheek_l"
	| "cheek_r"
	| "chest"
	| "back"
	| "shoulder_l"
	| "shoulder_r"
	| "arm_l"
	| "arm_r"
	| "hand_l"
	| "hand_r"
	| "front";

export const BODY_PARTS: readonly BodyPart[] = [
	"head",
	"face",
	"mouth",
	"chin",
	"cheek_l",
	"cheek_r",
	"chest",
	"back",
	"shoulder_l",
	"shoulder_r",
	"arm_l",
	"arm_r",
	"hand_l",
	"hand_r",
	"front",
];
/** The parts of someone else a hand may touch (only one's owner, docs/prd.md 3.4.11). */
export const TOUCHABLE: readonly BodyPart[] = [
	"head",
	"cheek_l",
	"cheek_r",
	"shoulder_l",
	"shoulder_r",
	"arm_l",
	"arm_r",
	"hand_l",
	"hand_r",
	"back",
];

/**
 * A point on a body: `part` of yourself ("me", the default) or of the one the script is for ("you"), moved
 * by `off` metres in that body's own frame: [to its right, up, to its front].
 */
export interface BodySpot {
	part: BodyPart;
	of?: "me" | "you";
	off?: [right: number, up: number, front: number];
}

/** Which way the palm faces: down, up, the way the body faces, or in towards the body's middle. */
export type Palm = "down" | "up" | "forward" | "in";
export const PALMS: readonly Palm[] = ["down", "up", "forward", "in"];

/** Where a hand goes: a spot, the palm turned one way, and a back-and-forth on top (`size` metres, `hz`). */
export interface BodyHand extends BodySpot {
	palm?: Palm;
	wiggle?: { dir: "side" | "up" | "front"; size: number; hz: number };
}

/**
 * One key: what each part has reached by `at` seconds from the start. A part a key leaves out keeps what the
 * last key said; a hand set to "rest" goes back to what the body is doing anyway. After the last key
 * everything goes back to rest.
 */
export interface BodyKey {
	at: number;
	right?: BodyHand | "rest";
	left?: BodyHand | "rest";
	look?: BodySpot | "ahead";
	/** Degrees, forward (negative: back). */
	lean?: number;
	/** Metres from standing: down to crouch, up to stand on tiptoe. */
	height?: number;
	smile?: boolean;
}

export const BODY_LEAN = [-20, 45] as const;
export const BODY_HEIGHT = [-0.45, 0.06] as const;
const WIGGLE_SIZE_MAX = 0.15;
const WIGGLE_HZ_MAX = 4;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const isNum = (v: unknown, min: number, max: number): v is number =>
	typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;

function parseSpot(v: unknown, where: string): BodySpot | string {
	if (!isObj(v)) return `${where}: { part, of?, off? } のオブジェクトにする`;
	if (!BODY_PARTS.includes(v.part as BodyPart)) return `${where}.part は ${BODY_PARTS.join(" / ")} のどれか`;
	if (v.of !== undefined && v.of !== "me" && v.of !== "you") return `${where}.of は me か you`;
	const spot: BodySpot = { part: v.part as BodyPart };
	if (v.of === "you") {
		if (spot.part === "front") return `${where}: front は自分の前だけ（of は me）`;
		spot.of = "you";
	}
	if (v.off !== undefined) {
		const max = spot.of === "you" ? BODY_OFFSET_YOU_MAX : BODY_OFFSET_MAX;
		const o = v.off;
		if (!Array.isArray(o) || o.length !== 3 || !o.every((n) => isNum(n, -max, max)))
			return `${where}.off は [右, 上, 前] の3つの数（メートル、${max}まで）`;
		const [r, u, f] = o as number[];
		spot.off = [r as number, u as number, f as number];
	}
	return spot;
}

function parseHand(v: unknown, where: string): BodyHand | "rest" | string {
	if (v === "rest") return "rest";
	const spot = parseSpot(v, where);
	if (typeof spot === "string") return spot;
	const o = v as Obj;
	const hand: BodyHand = spot;
	if (o.palm !== undefined) {
		if (!PALMS.includes(o.palm as Palm)) return `${where}.palm は ${PALMS.join(" / ")} のどれか`;
		hand.palm = o.palm as Palm;
	}
	if (o.wiggle !== undefined) {
		const w = o.wiggle;
		if (
			!isObj(w) ||
			!["side", "up", "front"].includes(w.dir as string) ||
			!isNum(w.size, 0, WIGGLE_SIZE_MAX) ||
			!isNum(w.hz, 0, WIGGLE_HZ_MAX)
		)
			return `${where}.wiggle は { dir: side / up / front, size: ${WIGGLE_SIZE_MAX}m まで, hz: ${WIGGLE_HZ_MAX} まで }`;
		hand.wiggle = { dir: w.dir as "side" | "up" | "front", size: w.size, hz: w.hz };
	}
	return hand;
}

/**
 * Checks a body script and returns it cleaned up (only known fields), or what is wrong with it, in words an
 * AI can act on.
 */
export function parseBodyKeys(v: unknown): BodyKey[] | string {
	if (!Array.isArray(v) || v.length === 0 || v.length > BODY_KEYS_MAX)
		return `keys は1〜${BODY_KEYS_MAX}個の配列にする`;
	const keys: BodyKey[] = [];
	let last = -1;
	for (const [i, raw] of v.entries()) {
		const where = `keys[${i}]`;
		if (!isObj(raw)) return `${where} はオブジェクトにする`;
		if (!isNum(raw.at, 0, BODY_SECONDS_MAX)) return `${where}.at は0〜${BODY_SECONDS_MAX}秒`;
		if (raw.at <= last) return `${where}.at は前のキーより後にする`;
		last = raw.at;
		const key: BodyKey = { at: raw.at };
		for (const side of ["right", "left"] as const) {
			if (raw[side] === undefined) continue;
			const hand = parseHand(raw[side], `${where}.${side}`);
			if (typeof hand === "string" && hand !== "rest") return hand;
			key[side] = hand;
		}
		if (raw.look !== undefined) {
			const look = raw.look === "ahead" ? "ahead" : parseSpot(raw.look, `${where}.look`);
			if (typeof look === "string" && look !== "ahead") return look;
			key.look = look as BodySpot | "ahead";
		}
		if (raw.lean !== undefined) {
			if (!isNum(raw.lean, BODY_LEAN[0], BODY_LEAN[1]))
				return `${where}.lean は ${BODY_LEAN[0]}〜${BODY_LEAN[1]} 度`;
			key.lean = raw.lean;
		}
		if (raw.height !== undefined) {
			if (!isNum(raw.height, BODY_HEIGHT[0], BODY_HEIGHT[1]))
				return `${where}.height は ${BODY_HEIGHT[0]}〜${BODY_HEIGHT[1]} メートル`;
			key.height = raw.height;
		}
		if (raw.smile !== undefined) {
			if (typeof raw.smile !== "boolean") return `${where}.smile は true か false`;
			key.smile = raw.smile;
		}
		keys.push(key);
	}
	return keys;
}

/** How long a script plays (seconds): its last key, then the way back to rest. */
export function bodyDuration(keys: readonly BodyKey[]): number {
	return (keys[keys.length - 1]?.at ?? 0) + BODY_SETTLE;
}
/** From the last key back to rest (seconds). */
export const BODY_SETTLE = 0.8;

/** Whether a script touches the one it is for (a hand on a part of "you"). */
export function bodyTouches(keys: readonly BodyKey[]): boolean {
	return keys.some((k) => [k.right, k.left].some((h) => h !== undefined && h !== "rest" && h.of === "you"));
}

/** Whether a script points at the one it is for at all (touching, or looking at them). */
export function bodyNeedsPartner(keys: readonly BodyKey[]): boolean {
	return (
		bodyTouches(keys) || keys.some((k) => k.look !== undefined && k.look !== "ahead" && k.look.of === "you")
	);
}

/** Whether a hand touches a part of "you" a hand may not. */
export function bodyUntouchable(keys: readonly BodyKey[]): BodyPart | null {
	for (const k of keys)
		for (const h of [k.right, k.left])
			if (h !== undefined && h !== "rest" && h.of === "you" && !TOUCHABLE.includes(h.part)) return h.part;
	return null;
}
