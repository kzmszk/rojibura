import * as THREE from "three";
import { describe, expect, test } from "vitest";
import { clearance, groundSpeed, legLength, MOVES, REFERENCE_LEG, referenceRig } from "./moves.ts";

const clip = (name: string) => (MOVES.find((m) => m.name === name) as (typeof MOVES)[number]).clip();

/** The reference rig posed as `name` is at time `t` (postures held after their end). */
function posed(name: string, t: number): THREE.Object3D {
	const rig = referenceRig();
	const mixer = new THREE.AnimationMixer(rig);
	const action = mixer.clipAction(clip(name));
	action.setLoop(THREE.LoopOnce, 1);
	action.clampWhenFinished = true;
	action.play();
	mixer.setTime(t);
	rig.updateMatrixWorld(true);
	return rig;
}

/** World height of each named bone when `name` is at time `t`. */
function heights(name: string, t: number): Record<string, number> {
	const out: Record<string, number> = {};
	posed(name, t).traverse((o) => {
		if (o.name) out[o.name] = o.getWorldPosition(new THREE.Vector3()).y;
	});
	return out;
}

/** `name` at `n + 1` moments from start to end. */
const moments = (name: string, n = 30) => {
	const d = clip(name).duration;
	return Array.from({ length: n + 1 }, (_, i) => (d * i) / n);
};

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

	test("nothing goes into the ground, at any moment of any motion", () => {
		for (const m of MOVES) {
			for (const t of moments(m.name))
				expect(clearance(posed(m.name, t)), `${m.name} at ${t}`).toBeGreaterThan(-0.005);
		}
	});

	test("walking, sitting and lying rest on the ground (nothing floats)", () => {
		for (const t of moments("walk")) expect(clearance(posed("walk", t)), `walk at ${t}`).toBeLessThan(0.005);
		for (const t of moments("sit")) expect(clearance(posed("sit", t)), `sit at ${t}`).toBeLessThan(0.005);
		for (const t of moments("lie")) expect(clearance(posed("lie", t)), `lie at ${t}`).toBeLessThan(0.005);
	});

	test("sitting and lying end low, sitting upright and lying flat", () => {
		const sit = heights("sit", 10);
		expect(sit.hips).toBeLessThan(0.2);
		expect(sit.head).toBeGreaterThan(0.6);
		// leaning back on the hands
		expect(sit.leftHand).toBeLessThan(0.12);
		expect(sit.rightHand).toBeLessThan(0.12);
		const lie = heights("lie", 10);
		expect(lie.hips).toBeLessThan(0.2);
		expect(lie.head).toBeLessThan(0.3);
		// the arms lie on the ground by the sides, not in the air
		for (const b of ["leftHand", "rightHand", "leftLowerArm", "rightLowerArm"])
			expect(lie[b], b).toBeLessThan(0.09);
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
