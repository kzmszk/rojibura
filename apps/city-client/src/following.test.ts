import { type AvatarState, RUN_SPEED } from "@rojibura/protocol";
import { expect, test, vi } from "vitest";
import { Following } from "./following.ts";

function person(id: string, x: number): { state: AvatarState } {
	return {
		state: {
			id,
			name: id,
			kind: "human",
			status: "active",
			assets: { thumb: "", lod: "", vrm: "" },
			move: { kind: "idle", pos: [x, 0], at: 0 },
		},
	};
}
function setup() {
	const mine = person("me", 0);
	const them = person("friend", 8);
	const walk = vi.fn(() => true);
	const toast = vi.fn();
	const arrived = vi.fn();
	const resumeCompanion = vi.fn();
	const follow = new Following({
		person: (id) => (id === "friend" ? them : undefined),
		me: () => mine,
		hostNow: () => 2000,
		walk,
		toast,
		arrived,
		resumeCompanion,
	});
	follow.current = { id: "friend", until: 10000, plannedAt: 0 };
	return { follow, mine, them, walk, toast, arrived, resumeCompanion };
}

test("replans toward a person and stops nearby", () => {
	const { follow, them, walk, toast } = setup();
	follow.step(1000);
	expect(walk).toHaveBeenCalledWith([6.5, 0], RUN_SPEED);
	them.state.move = { kind: "idle", pos: [1, 0], at: 0 };
	follow.step(2000);
	expect(follow.current).toBeNull();
	expect(toast).toHaveBeenCalledWith("friend のそばに着きました");
});

test("gives up normal following if neither route can be found", () => {
	const { follow, walk, toast } = setup();
	walk.mockReturnValue(false);
	follow.step(1000);
	expect(walk).toHaveBeenCalledTimes(2);
	expect(follow.current).toBeNull();
	expect(toast).toHaveBeenCalledWith("そこへは行けません");
});

test("lead retries a missing route and resumes the companion on arrival", () => {
	const { follow, walk, mine, them, arrived, resumeCompanion } = setup();
	if (!follow.current) throw new Error("missing follow");
	follow.current.lead = { to: [8, 0], place: "公園" };
	walk.mockReturnValue(false);
	follow.step(1000);
	expect(follow.current).not.toBeNull();
	expect(walk).toHaveBeenCalledTimes(2);
	mine.state.move = { kind: "idle", pos: [7, 0], at: 0 };
	them.state.move = { kind: "idle", pos: [8, 0], at: 0 };
	follow.step(2000);
	expect(arrived).toHaveBeenCalledWith("friend", "公園");
	expect(resumeCompanion).toHaveBeenCalledOnce();
	expect(follow.current).toBeNull();
});

test("losing a lead target resumes the companion", () => {
	const { follow, toast, resumeCompanion } = setup();
	follow.current = { id: "missing", until: 10000, plannedAt: 0, lead: { to: [8, 0], place: "公園" } };
	follow.step(1000);
	expect(toast).toHaveBeenCalledWith("相手を見失いました");
	expect(resumeCompanion).toHaveBeenCalledOnce();
	expect(follow.current).toBeNull();
});

test("an expired lead resumes the companion", () => {
	const { follow, resumeCompanion } = setup();
	follow.current = { id: "friend", until: 500, plannedAt: 0, lead: { to: [8, 0], place: "公園" } };
	follow.step(1000);
	expect(follow.current).toBeNull();
	expect(resumeCompanion).toHaveBeenCalledOnce();
});
