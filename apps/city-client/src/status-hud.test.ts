import { newLife } from "@rojibura/protocol";
import { describe, expect, test } from "vitest";
import { dutiesText, itemName } from "./status-hud.ts";

describe("the status always on screen (#53)", () => {
	test("today's must-dos in a line", () => {
		const life = newLife(0);
		expect(dutiesText(life)).toBe("ごはん 0/2・仕事か勉強 0/60分・運動 きのう済み");
		expect(
			dutiesText({
				...life,
				days: 2,
				duties: { meals: 1, work: false, exercise: false, worked: 25.4 },
			}),
		).toBe("ごはん 1/2・仕事か勉強 25/60分・運動 まだ");
		expect(
			dutiesText({ ...life, days: 2, duties: { meals: 2, work: true, exercise: true, worked: 60 } }),
		).toBe("ごはん 2/2・仕事か勉強 ✓・運動 ✓");
	});

	test("what is in a hand", () => {
		expect(itemName(undefined)).toBe("なし");
		expect(itemName({ id: "i_1", kind: "ball", pos: [0, 0] })).toBe("ボール");
		expect(
			itemName({
				id: "i_2",
				kind: "goods",
				pos: [0, 0],
				goods: { id: "anpan", name: "あんぱん", color: "#b5733a", food: true },
			}),
		).toBe("あんぱん");
	});
});
