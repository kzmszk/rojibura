import type { AvatarState, Doing } from "@rojibura/protocol";
import { expect, test, vi } from "vitest";
import { CityAvatars } from "./city-avatars.ts";

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

function setup(badgeOf: (doing?: Doing | null) => { emoji: string; name: string } | null = () => null) {
	const events: string[] = [];
	const create = vi.fn((avatar: AvatarState, isMine: boolean) => {
		events.push(`create:${avatar.id}:${isMine}`);
		return {
			state: avatar,
			dispose: vi.fn(() => {
				events.push(`dispose:${avatar.id}`);
			}),
			setDoing: vi.fn(),
			setStatus: vi.fn(),
			setFly: vi.fn(),
		};
	});
	const owner = new CityAvatars(
		{
			create,
			attach: (view) => {
				events.push(`attach:${view.state.id}`);
			},
		},
		badgeOf,
	);
	return { owner, create, events };
}

const none = new Set<string>();

test("reuses matching views, removes departed views, and reflects state", () => {
	const { owner, create } = setup();
	owner.add({ ...state("a"), fly: 7, doing: { activity: "old", since: 0, until: 1 } }, "a", none);
	owner.add(state("b"), "a", none);
	const existing = owner.avatars.get("a");
	const departed = owner.avatars.get("b");
	const show = vi.fn();
	const present = vi.fn();
	owner.reconcile([state("a")], "a", none, show, present);
	expect(owner.avatars.get("a")).toBe(existing);
	expect(existing?.state.fly).toBe(7);
	expect(existing?.state.doing).toBeUndefined();
	expect(existing?.setDoing).toHaveBeenLastCalledWith(null);
	expect(existing?.setFly).toHaveBeenCalledWith(null);
	expect(existing?.setStatus).toHaveBeenCalledWith("active");
	expect(departed?.dispose).toHaveBeenCalledOnce();
	expect(owner.avatars.has("b")).toBe(false);
	expect(show).toHaveBeenCalledWith(null);
	expect(present).toHaveBeenCalledWith("a");
	expect(create).toHaveBeenCalledTimes(2);
});

test("replaces changed names and assets, and removes blocked entries", () => {
	const { owner, events } = setup();
	for (const id of ["a", "b", "c"]) owner.add(state(id), "a", none);
	const old = [...owner.avatars.values()];
	events.length = 0;
	const changed = state("b");
	changed.assets = { ...changed.assets, vrm: "new" };
	owner.reconcile(
		[{ ...state("a"), name: "new" }, changed, state("c")],
		"a",
		new Set(["c"]),
		vi.fn(),
		vi.fn(),
	);
	for (const view of old) expect(view.dispose).toHaveBeenCalledOnce();
	expect(events).toEqual([
		"dispose:a",
		"create:a:true",
		"attach:a",
		"dispose:b",
		"create:b:false",
		"attach:b",
		"dispose:c",
	]);
	expect(owner.avatars.has("c")).toBe(false);
});

test("blocked joins leave existing views alone and repeated removal disposes once", () => {
	const { owner, create, events } = setup();
	owner.add(state("a"), "a", none);
	const original = owner.avatars.get("a");
	owner.add(state("a"), "a", new Set(["a"]));
	expect(owner.avatars.get("a")).toBe(original);
	expect(create).toHaveBeenCalledOnce();
	owner.add(state("a"), "a", none);
	const replacement = owner.avatars.get("a");
	owner.remove("a");
	owner.remove("a");
	owner.remove("missing");
	expect(original?.dispose).toHaveBeenCalledOnce();
	expect(replacement?.dispose).toHaveBeenCalledOnce();
	expect(events).toEqual([
		"create:a:true",
		"attach:a",
		"dispose:a",
		"create:a:true",
		"attach:a",
		"dispose:a",
	]);
});

test("runs flying and presence effects for every incoming avatar, even blocked", () => {
	const { owner, events } = setup();
	owner.add(state("a"), "a", none);
	events.length = 0;
	owner.reconcile(
		[state("a"), { ...state("b"), fly: 4 }],
		"a",
		new Set(["a"]),
		(alt) => {
			events.push(`fly:${alt}`);
		},
		(id) => {
			events.push(`present:${id}`);
		},
	);
	expect(events).toEqual(["dispose:a", "fly:null", "present:a", "create:b:false", "attach:b", "present:b"]);
	expect(owner.avatars.get("b")?.setFly).toHaveBeenCalledWith(4);
});

test("refreshes badges on current views when activities arrive", () => {
	let name = "pending";
	const { owner } = setup((doing) => (doing ? { emoji: "⏳", name } : null));
	owner.add({ ...state("a"), doing: { activity: "work", since: 0, until: 1 } }, "a", none);
	const existing = owner.avatars.get("a");
	expect(existing?.setDoing).toHaveBeenLastCalledWith({ emoji: "⏳", name: "pending" });
	name = "work";
	owner.refreshBadges();
	expect(existing?.setDoing).toHaveBeenLastCalledWith({ emoji: "⏳", name: "work" });
});
