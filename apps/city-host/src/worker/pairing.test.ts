import { describe, expect, test } from "vitest";
import { newPairCode, normalizePairCode, PAIR_CODE_RE } from "./pairing.ts";

describe("pairing codes", () => {
	test("eight characters without look-alikes", () => {
		for (let i = 0; i < 200; i++) {
			const code = newPairCode();
			expect(code).toMatch(PAIR_CODE_RE);
			expect(code).not.toMatch(/[01OIL]/);
		}
	});

	test("typed in any case, with a space or a hyphen; anything else is not a code", () => {
		expect(normalizePairCode("abcd-2345")).toBe("ABCD2345");
		expect(normalizePairCode(" ABCD 2345 ")).toBe("ABCD2345");
		expect(normalizePairCode("ABCD234")).toBeNull();
		expect(normalizePairCode("ABCD2340")).toBeNull();
		expect(normalizePairCode(12345678)).toBeNull();
	});
});
