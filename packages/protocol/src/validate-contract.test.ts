import { describe, expect, test } from "vitest";
import { parseClientMessage } from "./index.ts";
import { DIARY_PART_MAX, DIARY_PARTS_MAX, MAX_MESSAGE_BYTES } from "./limits.ts";

const parse = (value: unknown) => parseClientMessage(JSON.stringify(value));

describe("client message contract", () => {
	test("checks the envelope before message fields", () => {
		expect(parseClientMessage(new ArrayBuffer(0))).toStrictEqual({
			ok: false,
			error: "binary messages are not supported",
		});
		expect(parseClientMessage(" ".repeat(MAX_MESSAGE_BYTES + 1))).toStrictEqual({
			ok: false,
			error: "message too large",
		});
		expect(parseClientMessage("{")).toStrictEqual({ ok: false, error: "invalid JSON" });
		expect(parse([])).toStrictEqual({ ok: false, error: "missing type" });
		expect(parse({ t: "MOVE_PATH", path: [], speed: -1, seq: -1 })).toStrictEqual({
			ok: false,
			error: "bad path",
		});
		expect(parse({ t: "SAY", text: "", to: "invalid" })).toStrictEqual({
			ok: false,
			error: "bad text length",
		});
		expect(parse({ t: "DIARY", to: "bad", day: "bad", parts: 0 })).toStrictEqual({
			ok: false,
			error: "bad to",
		});
	});
	test("omits optional and unknown fields and sanitizes text", () => {
		expect(parse({ t: "ACTION", motion: "sit", extra: true })).toStrictEqual({
			ok: true,
			msg: { t: "ACTION", motion: "sit" },
		});
		expect(parse({ t: "SAY", text: " \tHi\nthere\u0000\u2028 ", extra: 1 })).toStrictEqual({
			ok: true,
			msg: { t: "SAY", text: "Hi there" },
		});
		expect(parse({ t: "LEAD", to: [1, 2], place: "  park\nplace  " })).toStrictEqual({
			ok: true,
			msg: { t: "LEAD", to: [1, 2], place: "park place" },
		});
		expect(parse({ t: "DIARY_ASK", id: "a_1" })).toStrictEqual({
			ok: true,
			msg: { t: "DIARY_ASK", id: "a_1" },
		});
	});
	test("normalizes movement and rejects a zero throw", () => {
		expect(parse({ t: "MOVE_VEL", pos: [2, 3], dir: [3, 4], speed: 1, seq: 0 })).toStrictEqual({
			ok: true,
			msg: { t: "MOVE_VEL", pos: [2, 3], dir: [0.6, 0.8], speed: 1, seq: 0 },
		});
		expect(parse({ t: "MOVE_VEL", pos: [0, 0], dir: [0, 0], speed: 0, seq: 0 })).toStrictEqual({
			ok: true,
			msg: { t: "MOVE_VEL", pos: [0, 0], dir: [0, 0], speed: 0, seq: 0 },
		});
		expect(parse({ t: "THROW", dir: [0, 0] })).toStrictEqual({ ok: false, error: "bad dir" });
		expect(parse({ t: "FLY", alt: 1.234 })).toStrictEqual({ ok: true, msg: { t: "FLY", alt: 1.23 } });
	});
	test("enforces diary bounds in order and preserves diary whitespace", () => {
		const diary = { t: "DIARY", to: "a_1", day: "life", part: 0, parts: 1, text: " \tline\n\u0000end " };
		expect(parse(diary)).toStrictEqual({ ok: true, msg: { ...diary, text: " \tline\nend " } });
		expect(parse({ ...diary, parts: DIARY_PARTS_MAX + 1, part: -1 })).toStrictEqual({
			ok: false,
			error: "bad parts",
		});
		expect(parse({ ...diary, part: 1 })).toStrictEqual({ ok: false, error: "bad part" });
		expect(parse({ ...diary, text: "x".repeat(DIARY_PART_MAX + 1) })).toStrictEqual({
			ok: false,
			error: "bad text length",
		});
		expect(parse({ ...diary, days: ["life"] })).toStrictEqual({ ok: false, error: "bad days" });
	});
});
