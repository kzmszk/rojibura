// Runtime validation of messages from participants (docs/prd.md 3.2.3).
// Checks shape and protocol limits only; spatial checks (walkable area, position) are the host's job.

import {
	INTEREST_RADIUS_MAX,
	INTEREST_RADIUS_MIN,
	MAX_MESSAGE_BYTES,
	MAX_PATH_POINTS,
	MAX_SAY_LENGTH,
	MAX_SPEED,
} from "./limits.ts";
import type { ClientToHost, HostToClient, Motion, Status, Vec2 } from "./types.ts";

export type Parsed<T> = { ok: true; msg: T } | { ok: false; error: string };

const MOTIONS: readonly Motion[] = ["wave", "nod", "bow", "jump", "sit"];
const STATUSES: readonly Status[] = ["active", "busy", "resting"];
const COORD_LIMIT = 10_000;
const ID_RE = /^[ha]_[A-Za-z0-9_-]{1,64}$/;
const CONV_RE = /^c_[A-Za-z0-9_-]{1,64}$/;

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isNum(v: unknown, min = -COORD_LIMIT, max = COORD_LIMIT): v is number {
	return typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;
}

export function isVec2(v: unknown): v is Vec2 {
	return Array.isArray(v) && v.length === 2 && isNum(v[0]) && isNum(v[1]);
}

function isSeq(v: unknown): v is number {
	return Number.isSafeInteger(v) && (v as number) >= 0;
}

export function isAvatarId(v: unknown): v is string {
	return typeof v === "string" && ID_RE.test(v);
}

/** Removes control characters (keeps ordinary spaces) and trims. */
export function sanitizeText(s: string): string {
	let out = "";
	for (const ch of s) {
		const c = ch.codePointAt(0) ?? 0;
		if (c < 0x20 || (c >= 0x7f && c < 0xa0) || c === 0x2028 || c === 0x2029) {
			if (c === 0x0a || c === 0x09) out += " ";
			continue;
		}
		out += ch;
	}
	return out.trim();
}

/** Length in user-perceived characters (code points), as the limits in the design doc mean. */
export function textLength(s: string): number {
	let n = 0;
	for (const _ of s) n++;
	return n;
}

function fail<T>(error: string): Parsed<T> {
	return { ok: false, error };
}

export function parseClientMessage(raw: string | ArrayBuffer): Parsed<ClientToHost> {
	if (typeof raw !== "string") return fail("binary messages are not supported");
	if (raw.length > MAX_MESSAGE_BYTES) return fail("message too large");
	let v: unknown;
	try {
		v = JSON.parse(raw);
	} catch {
		return fail("invalid JSON");
	}
	if (!isObj(v) || typeof v.t !== "string") return fail("missing type");
	switch (v.t) {
		case "AUTH":
			if (typeof v.sig !== "string" || v.sig.length === 0 || v.sig.length > 256) return fail("bad sig");
			return { ok: true, msg: { t: "AUTH", sig: v.sig } };
		case "MOVE_PATH": {
			const path = v.path;
			if (!Array.isArray(path) || path.length < 2 || path.length > MAX_PATH_POINTS) return fail("bad path");
			if (!path.every(isVec2)) return fail("bad path point");
			if (!isNum(v.speed, 0.1, MAX_SPEED)) return fail("bad speed");
			if (!isSeq(v.seq)) return fail("bad seq");
			return {
				ok: true,
				msg: {
					t: "MOVE_PATH",
					path: path.map((p: Vec2) => [p[0], p[1]] as Vec2),
					speed: v.speed,
					seq: v.seq,
				},
			};
		}
		case "MOVE_VEL": {
			if (!isVec2(v.pos) || !isVec2(v.dir)) return fail("bad vector");
			if (!isNum(v.speed, 0, MAX_SPEED)) return fail("bad speed");
			if (!isSeq(v.seq)) return fail("bad seq");
			const len = Math.hypot(v.dir[0], v.dir[1]);
			const dir: Vec2 = len < 1e-6 ? [0, 0] : [v.dir[0] / len, v.dir[1] / len];
			return { ok: true, msg: { t: "MOVE_VEL", pos: [v.pos[0], v.pos[1]], dir, speed: v.speed, seq: v.seq } };
		}
		case "ACTION": {
			if (!MOTIONS.includes(v.motion as Motion)) return fail("bad motion");
			if (v.target !== undefined && !isAvatarId(v.target)) return fail("bad target");
			const msg: ClientToHost = { t: "ACTION", motion: v.motion as Motion };
			if (v.target !== undefined) msg.target = v.target as string;
			return { ok: true, msg };
		}
		case "SAY": {
			if (typeof v.text !== "string") return fail("bad text");
			const text = sanitizeText(v.text);
			if (text.length === 0 || textLength(text) > MAX_SAY_LENGTH) return fail("bad text length");
			if (v.to !== undefined && !isAvatarId(v.to)) return fail("bad to");
			if (v.convId !== undefined && (typeof v.convId !== "string" || !CONV_RE.test(v.convId)))
				return fail("bad convId");
			const msg: ClientToHost = { t: "SAY", text };
			if (v.to !== undefined) msg.to = v.to as string;
			if (v.convId !== undefined) msg.convId = v.convId as string;
			return { ok: true, msg };
		}
		case "STATUS":
			if (!STATUSES.includes(v.status as Status)) return fail("bad status");
			return { ok: true, msg: { t: "STATUS", status: v.status as Status } };
		case "INTEREST":
			if (!isNum(v.radius, INTEREST_RADIUS_MIN, INTEREST_RADIUS_MAX)) return fail("bad radius");
			return { ok: true, msg: { t: "INTEREST", radius: v.radius } };
		case "WATCH_USAGE":
			if (typeof v.on !== "boolean") return fail("bad on");
			return { ok: true, msg: { t: "WATCH_USAGE", on: v.on } };
		default:
			return fail("unknown type");
	}
}

/**
 * Parses a message from the host. The host is trusted, so this only checks that it is JSON with a type;
 * clients still render text with textContent.
 */
export function parseHostMessage(raw: string): HostToClient | null {
	try {
		const v: unknown = JSON.parse(raw);
		return isObj(v) && typeof v.t === "string" ? (v as unknown as HostToClient) : null;
	} catch {
		return null;
	}
}

export function encode(msg: ClientToHost | HostToClient): string {
	return JSON.stringify(msg);
}
