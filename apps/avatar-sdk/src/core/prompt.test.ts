import { describe, expect, test } from "vitest";
import { parseSummary } from "./prompt.ts";

describe("parseSummary", () => {
	test("keeps a plain summary", () => {
		expect(parseSummary({ summary: "つばさは昔の詩集を探している。" })).toBe(
			"つばさは昔の詩集を探している。",
		);
	});

	test("drops markup a model appended after the text", () => {
		expect(
			parseSummary({ summary: "初対面のあいさつをした。</summary> <motion>nod</motion> <goTo>stay</goTo>" }),
		).toBe("初対面のあいさつをした。");
	});

	test("rejects empty or missing summaries", () => {
		expect(parseSummary({ summary: "<summary>" })).toBeNull();
		expect(parseSummary({})).toBeNull();
		expect(parseSummary(null)).toBeNull();
	});
});
