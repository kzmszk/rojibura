import { describe, expect, it } from "vitest";
import { keyboardIntent } from "./keyboard-input.ts";

const base = {
	key: "",
	movement: null,
	typing: false,
	cinema: false,
	shiftHeld: false,
	flying: false,
	panelOpen: false,
	flyAllowed: false,
	motion: undefined,
	followTarget: null,
};

describe("keyboard intent priority", () => {
	it("uses movement for Shift and cinema look only for other movement keys", () => {
		expect(
			keyboardIntent({ ...base, key: "Shift", movement: "shift", cinema: true, shiftHeld: true }),
		).toEqual({ kind: "move", key: "shift" });
		expect(keyboardIntent({ ...base, key: "ArrowUp", movement: "w", cinema: true, shiftHeld: true })).toEqual(
			{ kind: "look", key: "w" },
		);
	});
	it("prioritizes flight over actions, even with the panel open", () => {
		expect(keyboardIntent({ ...base, key: " ", flying: true, panelOpen: true })).toEqual({
			kind: "lift",
			direction: "up",
		});
		expect(keyboardIntent({ ...base, key: "C", flying: true })).toEqual({ kind: "lift", direction: "down" });
	});
	it("selects panel turning or picking and permits following with a panel open", () => {
		expect(keyboardIntent({ ...base, key: "E", panelOpen: true })).toEqual({ kind: "turn", degrees: 15 });
		expect(keyboardIntent({ ...base, key: "E" })).toEqual({ kind: "pick" });
		expect(keyboardIntent({ ...base, key: "F", panelOpen: true, followTarget: "avatar" })).toEqual({
			kind: "follow",
			targetId: "avatar",
		});
	});
	it("leaves text alone except Escape and uses the matched action", () => {
		expect(keyboardIntent({ ...base, key: "w", movement: "w", typing: true })).toEqual({ kind: "none" });
		expect(keyboardIntent({ ...base, key: "Escape", typing: true })).toEqual({ kind: "escape" });
		expect(keyboardIntent({ ...base, key: "1", motion: "wave" })).toEqual({ kind: "act", motion: "wave" });
		expect(keyboardIntent({ ...base, key: "!" })).toEqual({ kind: "none" });
	});
	it("gates focus, map, flight, follow, and grounded jump", () => {
		const cases = [
			[{ key: "Enter", typing: true }, { kind: "none" }],
			[{ key: "Enter" }, { kind: "focus" }],
			[{ key: "m" }, { kind: "map" }],
			[{ key: "m", panelOpen: true }, { kind: "none" }],
			[{ key: "u", flyAllowed: true }, { kind: "fly" }],
			[{ key: "u", flyAllowed: false }, { kind: "none" }],
			[{ key: "u", flyAllowed: true, panelOpen: true }, { kind: "none" }],
			[
				{ key: "q", panelOpen: true },
				{ kind: "turn", degrees: -15 },
			],
			[{ key: "f" }, { kind: "none" }],
			[{ key: "f", followTarget: "" }, { kind: "none" }],
			[{ key: " " }, { kind: "act", motion: "jump" }],
		] as const;
		for (const [input, expected] of cases) {
			expect(keyboardIntent({ ...base, ...input })).toEqual(expected);
		}
	});
});
