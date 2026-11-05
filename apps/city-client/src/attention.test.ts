import type { AvatarState } from "@rojibura/protocol";
import { Vector3 } from "three";
import { expect, test } from "vitest";
import { Attention } from "./attention.ts";

function avatar(id: string, position: Vector3, heading = 0) {
	const state: Pick<AvatarState, "id" | "status" | "move"> = {
		id,
		status: "active",
		move: { kind: "vel", pos: [0, 0], dir: [1, 0], speed: 1, at: 0 },
	};
	return {
		state,
		root: { position },
		heading,
		eyePosition: () => position.clone().add(new Vector3(0, 1.6, 0)),
	};
}

test("keeps a null sight through the slot and chooses again in the next slot", () => {
	const attention = new Attention();
	const ai = avatar("cache", new Vector3(0, 0, 0));
	const owner = avatar("owner", new Vector3(1, 0, 0));
	const sight = new Vector3(0, 1.5, 10);
	expect(attention.decide(ai, owner, 0, [])).toEqual({ target: null, facing: -0.13765735235065224 });
	expect(attention.decide(ai, owner, 1, [sight])).toEqual({ target: null, facing: -0.13765735235065224 });
	expect(attention.decide(ai, owner, 8000, [sight])).toEqual({ target: sight, facing: 0.35 });
	expect(attention.decide(ai, owner, 8001, [])).toEqual({ target: sight, facing: 0.35 });
});

test("faces the owner for speech or busy status and looks at them after stopping", () => {
	const attention = new Attention();
	const ai = avatar("alpha", new Vector3(1, 0, 2), 0.25);
	const owner = avatar("owner", new Vector3(2, 0, 3), -0.4);
	const sights = [new Vector3(1, 1.5, 10), new Vector3(5, 4, 9), new Vector3(-3, 1, 15)];
	const eye = new Vector3(2, 1.6, 3);
	expect(attention.decide(ai, owner, 0, sights)).toEqual({ target: sights[1], facing: 0.5499999999999999 });
	ai.state.status = "busy";
	expect(attention.talkingNow(ai, 0)).toBe(true);
	expect(attention.decide(ai, owner, 0, sights)).toEqual({ target: eye, facing: null });
	ai.state.status = "active";
	attention.said(ai.state.id, 0);
	expect(attention.talkingNow(ai, 19999)).toBe(true);
	expect(attention.talkingNow(ai, 20000)).toBe(false);
	expect(attention.decide(ai, owner, 19999, sights)).toEqual({ target: eye, facing: null });
	ai.state.move = { kind: "idle", pos: [0, 0], at: 0 };
	expect(attention.decide(ai, owner, 100, sights)).toEqual({ target: eye, facing: null });
	const stopped = new Attention();
	expect(stopped.decide(ai, owner, 100, sights)).toEqual({ target: eye, facing: 0.5499999999999999 });
	expect(stopped.decide(ai, owner, 2500, sights)).toEqual({ target: sights[1], facing: 0.5499999999999999 });
});

test("ignores missing or distant owners using three-dimensional distance", () => {
	const attention = new Attention();
	const ai = avatar("alpha", new Vector3(1, 0, 2));
	const owner = avatar("owner", new Vector3(2, 6, 3));
	expect(attention.decide(ai, undefined, 0, [])).toEqual({ target: null, facing: null });
	expect(attention.decide(ai, owner, 0, [])).toEqual({ target: null, facing: null });
	owner.root.position.set(6, 0, 2);
	expect(attention.decide(ai, owner, 0, [])).toEqual({ target: null, facing: null });
});
