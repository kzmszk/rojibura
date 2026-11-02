import type { BodyKey } from "@rojibura/protocol";
import * as THREE from "three";
import { describe, expect, test } from "vitest";
import { BodyRig, BodyScript, type Bones, frameOf, hingeSign, solveChain, spotOn } from "./body.ts";
import { referenceRig } from "./moves.ts";

/** The reference rig as named bones, standing at `x, z` facing `heading`, its arms hanging. */
function body(x = 0, z = 0, heading = 0): { root: THREE.Object3D; bones: Bones } {
	const root = referenceRig();
	root.position.set(x, 0, z);
	root.rotation.y = heading;
	const bones: Bones = {};
	root.traverse((o) => {
		if (o.name) bones[o.name] = o;
	});
	(bones.leftUpperArm as THREE.Object3D).rotation.z = -76 * THREE.MathUtils.DEG2RAD;
	(bones.rightUpperArm as THREE.Object3D).rotation.z = 76 * THREE.MathUtils.DEG2RAD;
	root.updateMatrixWorld(true);
	return { root, bones };
}

const pos = (o: THREE.Object3D | undefined) => (o as THREE.Object3D).getWorldPosition(new THREE.Vector3());
const parts = (bones: Bones, heading = 0) => ({
	spot: (part: Parameters<typeof spotOn>[4], off?: [number, number, number]) =>
		spotOn(bones, heading, 0.22, 1, part, off),
	frame: () => frameOf(heading),
});

describe("arm and leg chains", () => {
	test("an elbow bends forward and a knee backward", () => {
		const { bones } = body();
		const arm = {
			upper: bones.rightUpperArm as THREE.Object3D,
			lower: bones.rightLowerArm as THREE.Object3D,
			end: bones.rightHand as THREE.Object3D,
			axis: new THREE.Vector3(0, 1, 0),
		};
		const sign = hingeSign(arm, new THREE.Vector3(0, 0, 1));
		arm.lower.quaternion.setFromAxisAngle(arm.axis, sign * 1.2);
		arm.lower.updateWorldMatrix(true, true);
		expect(pos(arm.end).z).toBeGreaterThan(0.1);
		const leg = {
			upper: bones.leftUpperLeg as THREE.Object3D,
			lower: bones.leftLowerLeg as THREE.Object3D,
			end: bones.leftFoot as THREE.Object3D,
			axis: new THREE.Vector3(1, 0, 0),
		};
		const knee = hingeSign(leg, new THREE.Vector3(0, 0, -1));
		leg.lower.quaternion.setFromAxisAngle(leg.axis, knee * 1.2);
		leg.lower.updateWorldMatrix(true, true);
		expect(pos(leg.end).z).toBeLessThan(-0.1);
	});

	test("a hand reaches a point in reach, and says how far short it stays of one out of reach", () => {
		const { bones } = body();
		const chain = {
			upper: bones.rightUpperArm as THREE.Object3D,
			lower: bones.rightLowerArm as THREE.Object3D,
			end: bones.rightHand as THREE.Object3D,
			axis: new THREE.Vector3(0, 1, 0),
			sign: 1,
		};
		chain.sign = hingeSign(chain, new THREE.Vector3(0, 0, 1));
		const target = new THREE.Vector3(-0.1, 1.5, 0.35);
		const pole = new THREE.Vector3(-0.6, -1, -0.3);
		expect(solveChain(chain, target, pole)).toBe(0);
		expect(pos(chain.end).distanceTo(target)).toBeLessThan(0.01);
		// the elbow ends up below the line from shoulder to hand, not above it
		expect(pos(chain.lower).y).toBeLessThan((pos(chain.upper).y + target.y) / 2);
		const far = new THREE.Vector3(-0.2, 1.4, 1.2);
		expect(solveChain(chain, far, pole)).toBeGreaterThan(0.5);
	});
});

describe("a body script", () => {
	test("keys are reached at their times and everything goes back to rest", () => {
		const keys: BodyKey[] = [
			{ at: 1, right: { part: "front" }, lean: 10 },
			{ at: 2, lean: 20 },
		];
		const s = new BodyScript(keys, 5000);
		expect(s.end).toBeCloseTo(5000 + 2800);
		const a = s.sample(1);
		expect(a.right.b).toEqual({ part: "front" });
		expect(a.right.u).toBe(0);
		expect(s.sample(0.5).lean).toBeCloseTo(5);
		expect(s.sample(2).lean).toBeCloseTo(20);
		expect(s.sample(2.8).lean).toBeCloseTo(0);
		expect(s.sample(1.5).right.a).toEqual({ part: "front" });
	});

	test("patting someone's head: the hand comes down on top of it, straining up when it is a stretch", () => {
		const ai = body(0, 0, 0);
		// the owner faces the AI 0.38 m in front of it, a little taller
		const owner = body(0, 0.38, Math.PI);
		owner.root.scale.setScalar(1.04);
		owner.root.updateMatrixWorld(true);
		const ownerParts = {
			spot: (part: Parameters<typeof spotOn>[4], off?: [number, number, number]) =>
				spotOn(owner.bones, Math.PI, 0.22 * 1.04, 1.04, part, off),
			frame: () => frameOf(Math.PI),
		};
		const rig = new BodyRig(ai.bones);
		const keys: BodyKey[] = [
			{ at: 1, right: { part: "head", of: "you" }, look: { part: "face", of: "you" } },
			{ at: 3, right: { part: "head", of: "you" } },
		];
		const s = new BodyScript(keys, 0, "h_owner");
		const first = rig.apply(s.sample(1), parts(ai.bones), ownerParts, 1 / 30);
		expect(first.short.right).toBeGreaterThan(0.02);
		// a second on: leaning in and up on its toes, it gets there
		let r = first;
		for (let i = 1; i <= 30; i++) {
			rig.restore();
			ai.root.updateMatrixWorld(true);
			r = rig.apply(s.sample(1 + i / 30), parts(ai.bones), ownerParts, 1 / 30);
		}
		ai.root.updateMatrixWorld(true);
		expect(r.short.right).toBeLessThan(0.02);
		const top = ownerParts.spot("head") as THREE.Vector3;
		// the wrist sits just above the top of the head, on the AI's side of it
		const wrist = pos(ai.bones.rightHand);
		expect(wrist.distanceTo(top)).toBeLessThan(0.12);
		expect(wrist.y).toBeGreaterThan(top.y);
		expect(r.look?.distanceTo(ownerParts.spot("face") as THREE.Vector3)).toBeLessThan(1e-6);
		// next frame starts from the motion's own pose again
		rig.restore();
		ai.root.updateMatrixWorld(true);
		expect(pos(ai.bones.rightHand).y).toBeLessThan(1);
		expect(pos(ai.bones.hips).y).toBeCloseTo(0.9, 5);
	});

	test("crouching keeps the feet where they stand", () => {
		const ai = body();
		const feet = [pos(ai.bones.leftFoot), pos(ai.bones.rightFoot)];
		const rig = new BodyRig(ai.bones);
		const s = new BodyScript([{ at: 1, height: -0.3 }], 0);
		rig.apply(s.sample(1), parts(ai.bones), null, 1 / 30);
		ai.root.updateMatrixWorld(true);
		expect(pos(ai.bones.hips).y).toBeCloseTo(0.6, 2);
		expect(pos(ai.bones.leftFoot).distanceTo(feet[0] as THREE.Vector3)).toBeLessThan(0.01);
		expect(pos(ai.bones.rightFoot).distanceTo(feet[1] as THREE.Vector3)).toBeLessThan(0.01);
		// the knees come forward
		expect(pos(ai.bones.leftLowerLeg).z).toBeGreaterThan(0.1);
	});
});
