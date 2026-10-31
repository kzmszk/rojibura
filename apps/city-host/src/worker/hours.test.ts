import { describe, expect, test } from "vitest";
import { closingTime, isOpen, nextOpening, parseHours } from "./hours.ts";

// 2026-10-31 in JST is UTC+9
const jst = (h: number, m = 0) => Date.UTC(2026, 9, 31, h - 9, m);

describe("parseHours", () => {
	test("always, one range, several ranges", () => {
		expect(parseHours("always")).toBe("always");
		expect(parseHours(undefined)).toBe("always");
		expect(parseHours("20-24")).toEqual([[20, 24]]);
		expect(parseHours("20-24, 12-13")).toEqual([
			[12, 13],
			[20, 24],
		]);
	});

	test("rejects malformed values", () => {
		for (const bad of ["20", "24-20", "20-25", "8pm-12", "20-24,"]) expect(() => parseHours(bad)).toThrow();
	});
});

test("always open", () => {
	const always = parseHours("always");
	expect(isOpen(jst(3), always)).toBe(true);
	expect(nextOpening(jst(3), always)).toBe(jst(3));
	expect(closingTime(jst(3), always)).toBeNull();
});

test("open from 20:00 to 24:00 JST", () => {
	const h = parseHours("20-24");
	expect(isOpen(jst(19, 59), h)).toBe(false);
	expect(isOpen(jst(20, 0), h)).toBe(true);
	expect(isOpen(jst(23, 59), h)).toBe(true);
	expect(isOpen(jst(24, 0), h)).toBe(false);
	expect(isOpen(jst(9, 0), h)).toBe(false);
	expect(nextOpening(jst(10), h)).toBe(jst(20));
	expect(nextOpening(jst(21), h)).toBe(jst(20));
	expect(nextOpening(jst(24, 30), h)).toBe(jst(44)); // after midnight: tonight 20:00
	expect(closingTime(jst(21), h)).toBe(jst(24));
	expect(closingTime(jst(10), h)).toBeNull();
});

test("several sessions a day", () => {
	const h = parseHours("12-13,20-24");
	expect(isOpen(jst(12, 30), h)).toBe(true);
	expect(closingTime(jst(12, 30), h)).toBe(jst(13));
	expect(nextOpening(jst(14), h)).toBe(jst(20));
	expect(nextOpening(jst(25), h)).toBe(jst(36)); // 1:00 -> 12:00 the same day
});

test("ranges that touch across midnight are one session", () => {
	const h = parseHours("20-24,0-2");
	expect(closingTime(jst(23), h)).toBe(jst(26)); // not closed at 0:00
	expect(isOpen(jst(25), h)).toBe(true);
	expect(nextOpening(jst(25), h)).toBe(jst(20));
	expect(isOpen(jst(26), h)).toBe(false);
});
