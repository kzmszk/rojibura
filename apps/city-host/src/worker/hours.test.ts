import { expect, test } from "vitest";
import { closingTime, isOpen, nextOpening } from "./hours.ts";

// 2026-10-31 in JST is UTC+9
const jst = (h: number, m = 0) => Date.UTC(2026, 9, 31, h - 9, m);

test("open from 20:00 to 24:00 JST", () => {
	expect(isOpen(jst(19, 59))).toBe(false);
	expect(isOpen(jst(20, 0))).toBe(true);
	expect(isOpen(jst(23, 59))).toBe(true);
	expect(isOpen(jst(24, 0))).toBe(false);
	expect(isOpen(jst(9, 0))).toBe(false);
});

test("next opening and closing time", () => {
	expect(nextOpening(jst(10))).toBe(jst(20));
	expect(nextOpening(jst(21))).toBe(jst(20));
	expect(nextOpening(jst(24, 30))).toBe(jst(44)); // after midnight: tonight 20:00
	expect(closingTime(jst(21))).toBe(jst(24));
});
