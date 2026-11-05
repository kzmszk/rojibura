import type { AvatarState } from "@rojibura/protocol";
import { Vector3 } from "three";
import { expect, test, vi } from "vitest";
import { showExpression } from "./city-expression.ts";

function avatar(id: string, kind: "human" | "ai" = "human", ownerId?: string) {
	const state: AvatarState = {
		id,
		name: id,
		kind,
		...(ownerId ? { ownerId } : {}),
		status: "active",
		assets: { thumb: "", lod: "", vrm: "" },
		move: { kind: "idle", pos: [0, 0], at: 0 },
	};
	const position = new Vector3();
	return {
		state,
		root: { position },
		act: vi.fn(() => false),
		moveBody: vi.fn(() => false),
		say: vi.fn(),
		spot: () => null,
		frame: () => ({ right: position, up: position, front: position }),
	};
}
function setup() {
	const speaker = avatar("speaker", "ai", "owner");
	const owner = avatar("owner");
	const avatars = new Map([
		["speaker", speaker],
		["owner", owner],
	]);
	const relations = { silenced: vi.fn(() => false) };
	const attention = { said: vi.fn() };
	let time = 0;
	const hostNow = vi.fn(() => ++time);
	const addLog = vi.fn();
	return { speaker, owner, deps: { avatars, relations, attention, hostNow, addLog, myId: "speaker" } };
}

test("silenced expression messages have no effects", () => {
	const { speaker, deps } = setup();
	deps.relations.silenced.mockReturnValue(true);
	showExpression({ t: "ACTED", id: "speaker", motion: "wave", at: 99 }, deps);
	showExpression({ t: "BODIED", id: "speaker", keys: [], at: 99 }, deps);
	showExpression({ t: "SAID", id: "speaker", text: "hello", at: 99 }, deps);
	expect(speaker.act).not.toHaveBeenCalled();
	expect(speaker.moveBody).not.toHaveBeenCalled();
	expect(speaker.say).not.toHaveBeenCalled();
	expect(deps.hostNow).not.toHaveBeenCalled();
	expect(deps.attention.said).not.toHaveBeenCalled();
	expect(deps.addLog).not.toHaveBeenCalled();
});

test("actions face their target and use emoji only when animation fails", () => {
	const { speaker, owner, deps } = setup();
	showExpression({ t: "ACTED", id: "speaker", motion: "wave", target: "owner", at: 99 }, deps);
	expect(speaker.act).toHaveBeenCalledWith("wave", 1, owner.root.position);
	expect(speaker.say).toHaveBeenCalledWith("👋", 2);
	speaker.act.mockReturnValue(true);
	showExpression({ t: "ACTED", id: "speaker", motion: "nod", at: 99 }, deps);
	expect(speaker.say).toHaveBeenCalledTimes(1);
	showExpression({ t: "ACTED", id: "absent", motion: "nod", at: 99 }, deps);
	expect(deps.hostNow).toHaveBeenCalledTimes(3);
});

test("body expressions use host timestamp and pass the partner itself", () => {
	const { speaker, owner, deps } = setup();
	showExpression({ t: "BODIED", id: "speaker", keys: [], to: "owner", at: 99 }, deps);
	expect(speaker.moveBody).toHaveBeenCalledWith([], 99, owner, "owner");
	expect(speaker.say).toHaveBeenCalledWith("🤲", 1);
	showExpression({ t: "BODIED", id: "speaker", keys: [], to: "absent", at: 100 }, deps);
	expect(speaker.moveBody).toHaveBeenLastCalledWith([], 100, null, "absent");
});

test("speech shows the text, records attention and logs even for missing speakers", () => {
	const { speaker, deps } = setup();
	showExpression({ t: "SAID", id: "speaker", text: "hello", to: "owner", at: 99 }, deps);
	expect(speaker.say).toHaveBeenCalledWith("hello", 1);
	expect(deps.attention.said).toHaveBeenCalledWith("speaker", 2);
	expect(deps.addLog).toHaveBeenLastCalledWith("speaker → owner", "hello", "mine");
	showExpression({ t: "SAID", id: "owner", text: "hi", to: "speaker", at: 99 }, deps);
	expect(deps.attention.said).toHaveBeenLastCalledWith("speaker", 4);
	expect(deps.addLog).toHaveBeenLastCalledWith("owner → speaker", "hi", "");
	showExpression({ t: "SAID", id: "absent", text: "?", to: "missing", at: 99 }, deps);
	expect(deps.addLog).toHaveBeenLastCalledWith("?", "?", "");
	expect(deps.hostNow).toHaveBeenCalledTimes(4);
});
