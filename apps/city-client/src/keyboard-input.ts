import type { Motion } from "@rojibura/protocol";

type KeyboardIntent =
	| { kind: "look" | "move"; key: string }
	| { kind: "lift"; direction: "up" | "down" }
	| { kind: "act"; motion: Motion }
	| { kind: "turn"; degrees: -15 | 15 }
	| { kind: "follow"; targetId: string }
	| {
			kind: "focus" | "map" | "fly" | "view" | "pick" | "seat" | "pat" | "throw" | "drop" | "escape" | "none";
	  };

export function keyboardIntent(input: {
	key: string;
	movement: string | null;
	typing: boolean;
	/** Shift with the movement keys looks round instead of walking (the cinema view; lying down in your own eyes). */
	shiftLooks: boolean;
	shiftHeld: boolean;
	flying: boolean;
	panelOpen: boolean;
	flyAllowed: boolean;
	motion: Motion | undefined;
	followTarget: string | null;
}): KeyboardIntent {
	const {
		key,
		movement,
		typing,
		shiftLooks,
		shiftHeld,
		flying,
		panelOpen,
		flyAllowed,
		motion,
		followTarget,
	} = input;
	const lower = key.toLowerCase();
	if (movement && movement !== "shift" && !typing && shiftLooks && shiftHeld)
		return { kind: "look", key: movement };
	if (movement && !typing) return { kind: "move", key: movement };
	if (key === "Enter" && !typing) return { kind: "focus" };
	if (!typing && flying && (key === " " || lower === "c"))
		return { kind: "lift", direction: key === " " ? "up" : "down" };
	if (!typing && !panelOpen) {
		if (lower === "m") return { kind: "map" };
		if (lower === "u" && flyAllowed) return { kind: "fly" };
		if (key === " ") return { kind: "act", motion: "jump" };
		if (motion !== undefined) return { kind: "act", motion };
		if (lower === "v") return { kind: "view" };
		if (lower === "e") return { kind: "pick" };
		if (lower === "r") return { kind: "seat" };
		if (lower === "h") return { kind: "pat" };
		if (lower === "t") return { kind: "throw" };
		if (lower === "g") return { kind: "drop" };
	}
	if (lower === "f" && !typing && followTarget) return { kind: "follow", targetId: followTarget };
	if (panelOpen && !typing && (lower === "q" || lower === "e"))
		return { kind: "turn", degrees: lower === "q" ? -15 : 15 };
	if (key === "Escape") return { kind: "escape" };
	return { kind: "none" };
}
