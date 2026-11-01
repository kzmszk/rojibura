import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { retarget } from "./retarget.ts";

type Spec = [
	name: string,
	parent: string | null,
	pos: [number, number, number],
	dir: [number, number, number],
];

const Y = new THREE.Vector3(0, 1, 0);

/** Builds a skeleton from world positions; each bone's local Y points along `dir`, twisted by `twist`. */
function rig(
	specs: Spec[],
	twist: number,
	prefix = "",
): { root: THREE.Group; nodes: Record<string, THREE.Object3D> } {
	const root = new THREE.Group();
	const nodes: Record<string, THREE.Object3D> = {};
	for (const [name, parent, pos, dir] of specs) {
		const bone = new THREE.Object3D();
		bone.name = prefix + name;
		bone.position.set(...pos);
		bone.quaternion
			.setFromUnitVectors(Y, new THREE.Vector3(...dir).normalize())
			.multiply(new THREE.Quaternion().setFromAxisAngle(Y, twist));
		root.add(bone);
		root.updateMatrixWorld(true);
		(parent ? (nodes[parent] as THREE.Object3D) : root).attach(bone);
		nodes[name] = bone;
	}
	return { root, nodes };
}

/** A source in an A-pose with twisted bone frames (like a Blender armature), facing +Z (left is +X). */
const SOURCE: Spec[] = [
	["hips", null, [0, 1, 0], [0, 1, 0]],
	["spine", "hips", [0, 1.1, 0], [0, 1, 0]],
	["chest", "spine", [0, 1.25, 0], [0, 1, 0.1]],
	["neck", "chest", [0, 1.45, 0.02], [0, 1, 0]],
	["head", "neck", [0, 1.55, 0.02], [0, 1, 0]],
	["leftShoulder", "chest", [0.05, 1.4, 0], [1, 0, 0]],
	["leftUpperArm", "leftShoulder", [0.15, 1.4, 0], [1, -1, 0]],
	["leftLowerArm", "leftUpperArm", [0.33, 1.22, 0], [1, -1, 0]],
	["leftHand", "leftLowerArm", [0.49, 1.06, 0], [1, -1, 0]],
	["rightShoulder", "chest", [-0.05, 1.4, 0], [-1, 0, 0]],
	["rightUpperArm", "rightShoulder", [-0.15, 1.4, 0], [-1, -1, 0]],
	["rightLowerArm", "rightUpperArm", [-0.33, 1.22, 0], [-1, -1, 0]],
	["rightHand", "rightLowerArm", [-0.49, 1.06, 0], [-1, -1, 0]],
	["leftUpperLeg", "hips", [0.1, 0.95, 0], [0, -1, 0]],
	["leftLowerLeg", "leftUpperLeg", [0.1, 0.5, 0], [0, -1, 0]],
	["leftFoot", "leftLowerLeg", [0.1, 0.08, 0], [0, -0.3, 1]],
	["rightUpperLeg", "hips", [-0.1, 0.95, 0], [0, -1, 0]],
	["rightLowerLeg", "rightUpperLeg", [-0.1, 0.5, 0], [0, -1, 0]],
	["rightFoot", "rightLowerLeg", [-0.1, 0.08, 0], [0, -0.3, 1]],
];

/** A smaller target in a T-pose with identity rest rotations and an extra upper chest (like a VRM's normalized bones). */
function target() {
	const s = 0.8;
	const specs: Spec[] = [
		["hips", null, [0, 0.85 * s, 0], [0, 1, 0]],
		["spine", "hips", [0, 0.95 * s, 0], [0, 1, 0]],
		["chest", "spine", [0, 1.08 * s, 0], [0, 1, 0]],
		["upperChest", "chest", [0, 1.2 * s, 0], [0, 1, 0]],
		["neck", "upperChest", [0, 1.35 * s, 0], [0, 1, 0]],
		["head", "neck", [0, 1.45 * s, 0], [0, 1, 0]],
		["leftShoulder", "upperChest", [0.04, 1.3 * s, 0], [0, 1, 0]],
		["leftUpperArm", "leftShoulder", [0.12, 1.3 * s, 0], [0, 1, 0]],
		["leftLowerArm", "leftUpperArm", [0.38, 1.3 * s, 0], [0, 1, 0]],
		["leftHand", "leftLowerArm", [0.6, 1.3 * s, 0], [0, 1, 0]],
		["rightShoulder", "upperChest", [-0.04, 1.3 * s, 0], [0, 1, 0]],
		["rightUpperArm", "rightShoulder", [-0.12, 1.3 * s, 0], [0, 1, 0]],
		["rightLowerArm", "rightUpperArm", [-0.38, 1.3 * s, 0], [0, 1, 0]],
		["rightHand", "rightLowerArm", [-0.6, 1.3 * s, 0], [0, 1, 0]],
		["leftUpperLeg", "hips", [0.08, 0.8 * s, 0], [0, 1, 0]],
		["leftLowerLeg", "leftUpperLeg", [0.08, 0.45 * s, 0], [0, 1, 0]],
		["leftFoot", "leftLowerLeg", [0.08, 0.07 * s, 0], [0, 1, 0]],
		["rightUpperLeg", "hips", [-0.08, 0.8 * s, 0], [0, 1, 0]],
		["rightLowerLeg", "rightUpperLeg", [-0.08, 0.45 * s, 0], [0, 1, 0]],
		["rightFoot", "rightLowerLeg", [-0.08, 0.07 * s, 0], [0, 1, 0]],
	];
	return rig(specs, 0, "Normalized_");
}

/** Swings the left arm and a leg, bends the spine and bobs the hips (local rotations, as an exporter writes them). */
function clip(source: Record<string, THREE.Object3D>): THREE.AnimationClip {
	const turned = (name: string, axis: [number, number, number], angles: number[]) => {
		const rest = (source[name] as THREE.Object3D).quaternion;
		const values = angles.flatMap((a) =>
			rest
				.clone()
				.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(...axis).normalize(), a))
				.toArray(),
		);
		return new THREE.QuaternionKeyframeTrack(`${name}.quaternion`, [0, 0.5, 1], values);
	};
	const hips = (source.hips as THREE.Object3D).position;
	return new THREE.AnimationClip("walk", 1, [
		turned("leftUpperArm", [1, 0, 0.3], [0, 1.0, 0.2]),
		turned("leftLowerArm", [1, 0, 0], [0, 0.8, 0.4]),
		turned("spine", [1, 0, 0], [0, 0.3, 0]),
		turned("rightUpperLeg", [0, 0, 1], [0, -0.6, 0.1]),
		new THREE.VectorKeyframeTrack(
			"hips.position",
			[0, 0.5, 1],
			[...hips.toArray(), hips.x, hips.y - 0.1, hips.z, ...hips.toArray()],
		),
	]);
}

const CHILD: Record<string, string> = {
	spine: "chest",
	leftUpperArm: "leftLowerArm",
	leftLowerArm: "leftHand",
	rightUpperArm: "rightLowerArm",
	rightUpperLeg: "rightLowerLeg",
	leftUpperLeg: "leftLowerLeg",
	neck: "head",
};

function direction(nodes: Record<string, THREE.Object3D>, bone: string): THREE.Vector3 {
	const a = (nodes[bone] as THREE.Object3D).getWorldPosition(new THREE.Vector3());
	return (nodes[CHILD[bone] as string] as THREE.Object3D)
		.getWorldPosition(new THREE.Vector3())
		.sub(a)
		.normalize();
}

describe("retarget", () => {
	it("points every bone the way the source's points, at rest and while moving", () => {
		const src = rig(SOURCE, 0.7);
		const tgt = target();
		const motion = clip(src.nodes);
		const out = retarget(src.root, motion, tgt.nodes);
		expect(out.name).toBe("walk");

		const srcMixer = new THREE.AnimationMixer(src.root);
		srcMixer.clipAction(motion).play();
		const tgtMixer = new THREE.AnimationMixer(tgt.root);
		tgtMixer.clipAction(out).play();
		// sample times of the 30 fps clip, so no interpolation between keys
		for (const t of [0, 0.3, 0.5, 0.9]) {
			srcMixer.setTime(t);
			tgtMixer.setTime(t);
			src.root.updateMatrixWorld(true);
			tgt.root.updateMatrixWorld(true);
			for (const bone of Object.keys(CHILD)) {
				expect(
					direction(tgt.nodes, bone).angleTo(direction(src.nodes, bone)),
					`${bone} at ${t}`,
				).toBeLessThan(1e-4);
			}
		}
		// the hips dip in proportion to leg length
		srcMixer.setTime(0.5);
		tgtMixer.setTime(0.5);
		const legs = (0.85 - 0.07) / (1 - 0.08);
		expect((tgt.nodes.hips as THREE.Object3D).position.y).toBeCloseTo(0.85 * 0.8 - 0.1 * legs * 0.8 * 1.0, 4);
	});

	it("leaves the source at rest", () => {
		const src = rig(SOURCE, 0.7);
		const before = Object.values(src.nodes).map((n) => n.quaternion.clone());
		retarget(src.root, clip(src.nodes), target().nodes);
		Object.values(src.nodes).forEach((n, i) => {
			expect(n.quaternion.toArray()).toEqual((before[i] as THREE.Quaternion).toArray());
		});
	});
});
