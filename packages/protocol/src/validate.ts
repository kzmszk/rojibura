// Runtime validation of messages from participants (docs/prd.md 3.2.3).
// Checks shape and protocol limits only; spatial checks (walkable area, position) are the host's job.

import { parseBodyKeys } from "./body.ts";
import { isBuildId, isModelId, normalizeColor, normalizeRot } from "./build.ts";
import {
	BLOCK_HEIGHT_MAX,
	BLOCK_SIZE_MAX,
	BLOCK_SIZE_MIN,
	BUILD_LABEL_MAX,
	BUILD_OFFSET_MAX,
	BUILD_SCALE_MAX,
	BUILD_SCALE_MIN,
	DIARY_DAYS_MAX,
	DIARY_PART_MAX,
	DIARY_PARTS_MAX,
	FLY_ALT_MAX,
	FLY_ALT_MIN,
	FLY_RUN_SPEED,
	INTEREST_RADIUS_MAX,
	INTEREST_RADIUS_MIN,
	LEAD_PLACE_MAX,
	LEAD_TEXT_MAX,
	MAX_MESSAGE_BYTES,
	MAX_PATH_POINTS,
	MAX_SAY_LENGTH,
} from "./limits.ts";
import type {
	BuildAt,
	ClientToHost,
	HostToClient,
	Motion,
	Posture,
	Status,
	Together,
	Vec2,
} from "./types.ts";

export type Parsed<T> = { ok: true; msg: T } | { ok: false; error: string };

export const MOTIONS: readonly Motion[] = [
	"wave",
	"nod",
	"bow",
	"jump",
	"sit",
	"lie",
	"handstand",
	"roll",
	"backroll",
	"backflip",
	"stepback",
];
/** Motions that last until the avatar moves: the host keeps them in its idle MoveState. */
export const POSTURES: readonly Posture[] = ["sit", "lie"];
export const TOGETHERS: readonly Together[] = ["handshake", "hug"];
const ITEM_RE = /^i_[A-Za-z0-9_-]{1,32}$/;
/** Shop and goods IDs (shops.json). */
const NAME_ID_RE = /^[a-z][a-z0-9_]{0,31}$/;
export const isPosture = (m: Motion): m is Posture => (POSTURES as readonly Motion[]).includes(m);
const STATUSES: readonly Status[] = ["active", "busy", "resting"];
const COORD_LIMIT = 10_000;
const ID_RE = /^[ha]_[A-Za-z0-9_-]{1,64}$/;
const CONV_RE = /^c_[A-Za-z0-9_-]{1,64}$/;
const REF_RE = /^[A-Za-z0-9_-]{1,32}$/;
const LANDMARK_RE = /^[A-Za-z0-9_-]{1,32}$/;
const AREA_RE = /^[A-Za-z0-9_-]{1,32}$/;
const ACTIVITY_RE = /^[A-Za-z0-9_-]{1,32}$/;
/** A diary's day: a JST date. DIARY_ASK may also ask for "life", the long-term memory. */
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const isDiaryDay = (v: unknown): v is string => typeof v === "string" && (DAY_RE.test(v) || v === "life");

/**
 * Going through a portal, a page closes its connection with this reason (docs/prd.md 3.8.2): the area it goes
 * to and where it arrives there. The room always gets a close, with who it was, so it can tell the AIs walking
 * with them to come along (FOLLOW) even when a last message would be lost to the close.
 */
export function travelReason(to: string, at: string): string {
	return `travel ${to} ${at}`;
}

export function parseTravelReason(reason: string): { to: string; at: string } | null {
	const [word, to, at, ...rest] = reason.split(" ");
	if (word !== "travel" || rest.length > 0 || !to || !at || !AREA_RE.test(to) || !LANDMARK_RE.test(at))
		return null;
	return { to, at };
}

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

/** Like sanitizeText for a page of a diary: line breaks and tabs are kept, nothing is trimmed. */
export function sanitizeDiary(s: string): string {
	let out = "";
	for (const ch of s) {
		const c = ch.codePointAt(0) ?? 0;
		if (c === 0x0a || c === 0x09) out += ch;
		else if (!(c < 0x20 || (c >= 0x7f && c < 0xa0) || c === 0x2028 || c === 0x2029)) out += ch;
	}
	return out;
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
		case "MOVE_PATH":
			return parseMovePath(v);
		case "MOVE_VEL":
			return parseMoveVel(v);
		case "ACTION":
			return parseAction(v);
		case "SAY":
			return parseSay(v);
		case "STATUS":
			if (!STATUSES.includes(v.status as Status)) return fail("bad status");
			return { ok: true, msg: { t: "STATUS", status: v.status as Status } };
		case "INTEREST":
			if (!isNum(v.radius, INTEREST_RADIUS_MIN, INTEREST_RADIUS_MAX)) return fail("bad radius");
			return { ok: true, msg: { t: "INTEREST", radius: v.radius } };
		case "WATCH_USAGE":
			if (typeof v.on !== "boolean") return fail("bad on");
			return { ok: true, msg: { t: "WATCH_USAGE", on: v.on } };
		case "OFFER":
			if (!TOGETHERS.includes(v.kind as Together)) return fail("bad kind");
			if (!isAvatarId(v.to)) return fail("bad to");
			return { ok: true, msg: { t: "OFFER", kind: v.kind as Together, to: v.to } };
		case "ANSWER":
			if (!isAvatarId(v.to)) return fail("bad to");
			if (typeof v.accept !== "boolean") return fail("bad accept");
			return { ok: true, msg: { t: "ANSWER", to: v.to, accept: v.accept } };
		case "PICK":
			if (typeof v.item !== "string" || !ITEM_RE.test(v.item)) return fail("bad item");
			return { ok: true, msg: { t: "PICK", item: v.item } };
		case "THROW":
			return parseThrow(v);
		case "DROP":
			return { ok: true, msg: { t: "DROP" } };
		case "BUY":
			if (typeof v.shop !== "string" || !NAME_ID_RE.test(v.shop)) return fail("bad shop");
			if (typeof v.goods !== "string" || !NAME_ID_RE.test(v.goods)) return fail("bad goods");
			return { ok: true, msg: { t: "BUY", shop: v.shop, goods: v.goods } };
		case "USE":
			return { ok: true, msg: { t: "USE" } };
		case "JOB":
			if (v.kind !== null && v.kind !== "work" && v.kind !== "study") return fail("bad kind");
			return { ok: true, msg: { t: "JOB", kind: v.kind } };
		case "FLY":
			if (v.alt !== null && !isNum(v.alt, FLY_ALT_MIN, FLY_ALT_MAX)) return fail("bad alt");
			return { ok: true, msg: { t: "FLY", alt: v.alt === null ? null : Math.round(v.alt * 100) / 100 } };
		case "WARP":
			if (typeof v.to !== "string" || !NAME_ID_RE.test(v.to)) return fail("bad to");
			return { ok: true, msg: { t: "WARP", to: v.to } };
		case "COMPANION":
			if (typeof v.on !== "boolean") return fail("bad on");
			return { ok: true, msg: { t: "COMPANION", on: v.on } };
		case "LEAD":
			return parseLead(v);
		case "BODY":
			return parseBody(v);
		case "BUILD":
			return parseBuild(v);
		case "ACT":
			if (typeof v.activity !== "string" || !ACTIVITY_RE.test(v.activity)) return fail("bad activity");
			return { ok: true, msg: { t: "ACT", activity: v.activity } };
		case "ACT_STOP":
			return { ok: true, msg: { t: "ACT_STOP" } };
		case "DIARY_ASK":
			return parseDiaryAsk(v);
		case "DIARY":
			return parseDiary(v);
		case "UNBUILD":
			return parseUnbuild(v);
		default:
			return fail("unknown type");
	}
}

function parseMovePath(v: Obj): Parsed<Extract<ClientToHost, { t: "MOVE_PATH" }>> {
	const path = v.path;
	if (!Array.isArray(path) || path.length < 2 || path.length > MAX_PATH_POINTS) return fail("bad path");
	if (!path.every(isVec2)) return fail("bad path point");
	if (!isNum(v.speed, 0.1, FLY_RUN_SPEED)) return fail("bad speed");
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

function parseMoveVel(v: Obj): Parsed<Extract<ClientToHost, { t: "MOVE_VEL" }>> {
	if (!isVec2(v.pos) || !isVec2(v.dir)) return fail("bad vector");
	if (!isNum(v.speed, 0, FLY_RUN_SPEED)) return fail("bad speed");
	if (!isSeq(v.seq)) return fail("bad seq");
	const len = Math.hypot(v.dir[0], v.dir[1]);
	const dir: Vec2 = len < 1e-6 ? [0, 0] : [v.dir[0] / len, v.dir[1] / len];
	return { ok: true, msg: { t: "MOVE_VEL", pos: [v.pos[0], v.pos[1]], dir, speed: v.speed, seq: v.seq } };
}

function parseAction(v: Obj): Parsed<Extract<ClientToHost, { t: "ACTION" }>> {
	if (!MOTIONS.includes(v.motion as Motion)) return fail("bad motion");
	if (v.target !== undefined && !isAvatarId(v.target)) return fail("bad target");
	if (v.seat !== undefined && (v.motion !== "sit" || !Number.isInteger(v.seat) || !isNum(v.seat, 0, 99_999)))
		return fail("bad seat");
	const msg: Extract<ClientToHost, { t: "ACTION" }> = { t: "ACTION", motion: v.motion as Motion };
	if (v.target !== undefined) msg.target = v.target as string;
	if (v.seat !== undefined) msg.seat = v.seat as number;
	return { ok: true, msg };
}

function parseSay(v: Obj): Parsed<Extract<ClientToHost, { t: "SAY" }>> {
	if (typeof v.text !== "string") return fail("bad text");
	const text = sanitizeText(v.text);
	if (text.length === 0 || textLength(text) > MAX_SAY_LENGTH) return fail("bad text length");
	if (v.to !== undefined && !isAvatarId(v.to)) return fail("bad to");
	if (v.convId !== undefined && (typeof v.convId !== "string" || !CONV_RE.test(v.convId)))
		return fail("bad convId");
	const msg: Extract<ClientToHost, { t: "SAY" }> = { t: "SAY", text };
	if (v.to !== undefined) msg.to = v.to as string;
	if (v.convId !== undefined) msg.convId = v.convId as string;
	return { ok: true, msg };
}

function parseThrow(v: Obj): Parsed<Extract<ClientToHost, { t: "THROW" }>> {
	if (!isVec2(v.dir)) return fail("bad dir");
	const len = Math.hypot(v.dir[0], v.dir[1]);
	if (len < 1e-6) return fail("bad dir");
	return { ok: true, msg: { t: "THROW", dir: [v.dir[0] / len, v.dir[1] / len] } };
}

function parseLead(v: Obj): Parsed<Extract<ClientToHost, { t: "LEAD" }>> {
	if (!isVec2(v.to)) return fail("bad to");
	if (typeof v.place !== "string") return fail("bad place");
	const place = sanitizeText(v.place).trim();
	if (place.length === 0 || textLength(place) > LEAD_PLACE_MAX) return fail("bad place length");
	const msg: Extract<ClientToHost, { t: "LEAD" }> = { t: "LEAD", to: [v.to[0], v.to[1]], place };
	if (v.text !== undefined) {
		if (typeof v.text !== "string") return fail("bad text");
		const text = sanitizeText(v.text).trim();
		if (text.length === 0 || textLength(text) > LEAD_TEXT_MAX) return fail("bad text length");
		msg.text = text;
	}
	return { ok: true, msg };
}

function parseBody(v: Obj): Parsed<Extract<ClientToHost, { t: "BODY" }>> {
	const keys = parseBodyKeys(v.keys);
	if (typeof keys === "string") return fail(`bad keys: ${keys}`);
	if (v.to !== undefined && !isAvatarId(v.to)) return fail("bad to");
	const msg: Extract<ClientToHost, { t: "BODY" }> = { t: "BODY", keys };
	if (v.to !== undefined) msg.to = v.to as string;
	return { ok: true, msg };
}

function parseDiaryAsk(v: Obj): Parsed<Extract<ClientToHost, { t: "DIARY_ASK" }>> {
	if (!isAvatarId(v.id)) return fail("bad id");
	if (v.day !== undefined && !isDiaryDay(v.day)) return fail("bad day");
	const msg: Extract<ClientToHost, { t: "DIARY_ASK" }> = { t: "DIARY_ASK", id: v.id };
	if (v.day !== undefined) msg.day = v.day;
	return { ok: true, msg };
}

function parseDiary(v: Obj): Parsed<Extract<ClientToHost, { t: "DIARY" }>> {
	if (!isAvatarId(v.to)) return fail("bad to");
	if (v.day !== null && !isDiaryDay(v.day)) return fail("bad day");
	const parts = v.parts;
	const part = v.part;
	if (typeof parts !== "number" || !Number.isInteger(parts) || parts < 1 || parts > DIARY_PARTS_MAX)
		return fail("bad parts");
	if (typeof part !== "number" || !Number.isInteger(part) || part < 0 || part >= parts)
		return fail("bad part");
	if (typeof v.text !== "string") return fail("bad text");
	const text = sanitizeDiary(v.text);
	if (textLength(text) > DIARY_PART_MAX) return fail("bad text length");
	const msg: Extract<ClientToHost, { t: "DIARY" }> = {
		t: "DIARY",
		to: v.to,
		day: v.day as string | null,
		part,
		parts,
		text,
	};
	if (v.days !== undefined) {
		const days = v.days;
		if (!Array.isArray(days) || days.length > DIARY_DAYS_MAX) return fail("bad days");
		if (!days.every((d) => typeof d === "string" && DAY_RE.test(d))) return fail("bad days");
		msg.days = days as string[];
	}
	return { ok: true, msg };
}

function parseUnbuild(v: Obj): Parsed<Extract<ClientToHost, { t: "UNBUILD" }>> {
	if (!isBuildId(v.id)) return fail("bad id");
	if (v.ref !== undefined && !(typeof v.ref === "string" && REF_RE.test(v.ref))) return fail("bad ref");
	const msg: Extract<ClientToHost, { t: "UNBUILD" }> = { t: "UNBUILD", id: v.id };
	if (v.ref !== undefined) msg.ref = v.ref as string;
	return { ok: true, msg };
}

function parseBuildAt(v: unknown): BuildAt | null {
	if (!isObj(v)) return null;
	const keys = ["pos", "landmark", "avatar", "build"].filter((k) => v[k] !== undefined);
	if (keys.length !== 1) return null;
	let offset: Vec2 | undefined;
	if (v.offset !== undefined) {
		const o = v.offset;
		if (!isVec2(o) || Math.abs(o[0]) > BUILD_OFFSET_MAX || Math.abs(o[1]) > BUILD_OFFSET_MAX) return null;
		offset = [o[0], o[1]];
	}
	const withOffset = <T extends object>(at: T) => (offset ? { ...at, offset } : at);
	if (v.pos !== undefined)
		return isVec2(v.pos) && offset === undefined ? { pos: [v.pos[0], v.pos[1]] } : null;
	if (v.landmark !== undefined)
		return typeof v.landmark === "string" && LANDMARK_RE.test(v.landmark)
			? withOffset({ landmark: v.landmark })
			: null;
	if (v.avatar !== undefined) return isAvatarId(v.avatar) ? withOffset({ avatar: v.avatar }) : null;
	return isBuildId(v.build) ? withOffset({ build: v.build }) : null;
}

function parseBuild(v: Obj): Parsed<ClientToHost> {
	if (!isModelId(v.model)) return fail("bad model");
	const at = parseBuildAt(v.at);
	if (!at) return fail("bad at");
	const msg: Extract<ClientToHost, { t: "BUILD" }> = { t: "BUILD", model: v.model, at };
	if (v.rot !== undefined) {
		if (!isNum(v.rot, -3600, 3600)) return fail("bad rot");
		msg.rot = normalizeRot(v.rot);
	}
	if (v.scale !== undefined) {
		if (!isNum(v.scale, BUILD_SCALE_MIN, BUILD_SCALE_MAX)) return fail("bad scale");
		msg.scale = v.scale;
	}
	if (v.size !== undefined) {
		const z = v.size;
		if (
			!Array.isArray(z) ||
			z.length !== 3 ||
			!isNum(z[0], BLOCK_SIZE_MIN, BLOCK_SIZE_MAX) ||
			!isNum(z[1], BLOCK_SIZE_MIN, BLOCK_HEIGHT_MAX) ||
			!isNum(z[2], BLOCK_SIZE_MIN, BLOCK_SIZE_MAX)
		)
			return fail("bad size");
		msg.size = [z[0], z[1], z[2]];
	}
	if (v.color !== undefined) {
		const color = typeof v.color === "string" ? normalizeColor(v.color) : null;
		if (!color) return fail("bad color");
		msg.color = color;
	}
	if (v.label !== undefined) {
		if (typeof v.label !== "string") return fail("bad label");
		const label = sanitizeText(v.label);
		if (textLength(label) > BUILD_LABEL_MAX) return fail("bad label length");
		if (label) msg.label = label;
	}
	if (v.ref !== undefined) {
		if (typeof v.ref !== "string" || !REF_RE.test(v.ref)) return fail("bad ref");
		msg.ref = v.ref;
	}
	return { ok: true, msg };
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
