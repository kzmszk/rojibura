import * as THREE from "three";
import { describe, expect, test } from "vitest";
import { groundSpeed, legLength, MOVES, REFERENCE_LEG, referenceRig } from "./moves.ts";

const clip = (name: string) => (MOVES.find((m) => m.name === name) as (typeof MOVES)[number]).clip();

/** World height of each named bone on the reference rig when `name` is at time `t`. */
function heights(name: string, t: number): Record<string, number> {
	const rig = referenceRig();
	const mixer = new THREE.AnimationMixer(rig);
	const action = mixer.clipAction(clip(name));
	action.setLoop(THREE.LoopOnce, 1);
	action.clampWhenFinished = true;
	action.play();
	mixer.setTime(t);
	rig.updateMatrixWorld(true);
	const out: Record<string, number> = {};
	rig.traverse((o) => {
		if (o.name) out[o.name] = o.getWorldPosition(new THREE.Vector3()).y;
	});
	return out;
}

describe("moves", () => {
	test("every motion builds a clip on the reference rig's bones", () => {
		const names = new Set<string>();
		referenceRig().traverse((o) => {
			if (o.name) names.add(o.name);
		});
		expect(names.size).toBe(19);
		for (const m of MOVES) {
			const c = m.clip();
			expect(c.name).toBe(m.name);
			expect(c.duration).toBeGreaterThan(0);
			for (const track of c.tracks) expect(names.has(track.name.split(".")[0] as string)).toBe(true);
		}
	});

	test("walking and running cover the ground at a human pace, running faster", () => {
		const walk = groundSpeed(clip("walk"));
		const run = groundSpeed(clip("run"));
		// at normal speed, for legs of REFERENCE_LEG (0.82 m); the players scale them to the real speed
		expect(walk).toBeGreaterThan(0.8);
		expect(walk).toBeLessThan(2);
		expect(run).toBeGreaterThan(walk * 1.5);
		expect(legLength(Object.fromEntries(MOVES.length ? collect() : []))).toBeCloseTo(REFERENCE_LEG, 5);
	});

	test("feet stay on the ground while walking", () => {
		const c = clip("walk");
		let lowest = Number.POSITIVE_INFINITY;
		for (let i = 0; i <= 20; i++) {
			const h = heights("walk", (c.duration * i) / 20);
			const low = Math.min(h.leftFoot as number, h.rightFoot as number);
			lowest = Math.min(lowest, low);
			// the lower ankle is where it is when standing (0.08 m up), neither floating nor sinking
			expect(low).toBeCloseTo(0.08, 2);
		}
		expect(lowest).toBeGreaterThan(0.07);
	});

	test("sitting and lying end low, sitting upright and lying flat", () => {
		const sit = heights("sit", 10);
		expect(sit.hips).toBeLessThan(0.2);
		expect(sit.head).toBeGreaterThan(0.6);
		const lie = heights("lie", 10);
		expect(lie.hips).toBeLessThan(0.2);
		expect(lie.head).toBeLessThan(0.3);
	});
});

/** The reference rig's bones by name. */
function collect(): [string, THREE.Object3D][] {
	const out: [string, THREE.Object3D][] = [];
	referenceRig().traverse((o) => {
		if (o.name) out.push([o.name, o]);
	});
	return out;
}
