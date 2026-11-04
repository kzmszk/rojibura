import type { AvatarState } from "@rojibura/protocol";
import { expect, test, vi } from "vitest";
import type { AvatarView } from "./avatars.ts";
import { reconcileAvatars } from "./reconcile-avatars.ts";

function state(id: string): AvatarState {
	return {
		id,
		name: id,
		kind: "human",
		status: "active",
		assets: { thumb: "", lod: "", vrm: "" },
		move: { kind: "idle", pos: [0, 0], at: 0 },
	};
}
function view(avatar: AvatarState) {
	return { state: avatar, dispose: vi.fn(), setDoing: vi.fn(), setStatus: vi.fn(), setFly: vi.fn() };
}

test("reuses matching views, removes departed views, and reflects state", () => {
	const existing = view({ ...state("a"), doing: { activity: "old", since: 0 } } as AvatarState);
	const departed = view(state("b"));
	const avatars = new Map([
		["a", existing],
		["b", departed],
	]) as unknown as Map<string, AvatarView>;
	const show = vi.fn();
	const present = vi.fn();
	const add = vi.fn();
	reconcileAvatars(avatars, [{ ...state("a"), fly: 4 }], "a", new Set(), add, () => null, show, present);
	expect(avatars.get("a")).toBe(existing);
	expect(existing.state.doing).toBeUndefined();
	expect(existing.setDoing).toHaveBeenCalledWith(null);
	expect(existing.setFly).toHaveBeenCalledWith(4);
	expect(existing.setStatus).toHaveBeenCalledWith("active");
	expect(departed.dispose).toHaveBeenCalledOnce();
	expect(avatars.has("b")).toBe(false);
	expect(show).toHaveBeenCalledWith(4);
	expect(present).toHaveBeenCalledWith("a");
	expect(add).not.toHaveBeenCalled();
});

test("replaces changed or blocked views", () => {
	const changed = view(state("a"));
	const blocked = view(state("b"));
	const avatars = new Map([
		["a", changed],
		["b", blocked],
	]) as unknown as Map<string, AvatarView>;
	const add = vi.fn();
	reconcileAvatars(
		avatars,
		[{ ...state("a"), name: "new" }, state("b")],
		"a",
		new Set(["b"]),
		add,
		() => null,
		vi.fn(),
		vi.fn(),
	);
	expect(changed.dispose).toHaveBeenCalledOnce();
	expect(blocked.dispose).toHaveBeenCalledOnce();
	expect(add).toHaveBeenCalledTimes(2);
	expect(avatars.size).toBe(0);
});
