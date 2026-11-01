// Plays a motion made for one humanoid skeleton on another (docs/prd.md 3.4.5): the city's motions are written
// for a T-pose reference rig (moves.ts) and played on each VRM's normalized bones. A clip is sampled on the
// source and re-expressed on the target, so each bone points the same way at every moment, whatever the
// proportions.
//
// The two rest poses may differ (a model whose arms hang lower than a T-pose), so each bone first gets the
// rotation that turns its rest direction into the source's, and then follows how far the source bone turned
// from its rest.

import * as THREE from "three";

/** Humanoid bones the motions move, parents first: [bone, the bone it points at, or the bone to copy]. */
const BONES: [bone: string, child: string | null, like?: string][] = [
	["hips", "spine"],
	["spine", "chest"],
	["chest", "neck"],
	["neck", "head"],
	["head", null, "neck"],
	["leftShoulder", "leftUpperArm"],
	["leftUpperArm", "leftLowerArm"],
	["leftLowerArm", "leftHand"],
	["leftHand", null, "leftLowerArm"],
	["rightShoulder", "rightUpperArm"],
	["rightUpperArm", "rightLowerArm"],
	["rightLowerArm", "rightHand"],
	["rightHand", null, "rightLowerArm"],
	["leftUpperLeg", "leftLowerLeg"],
	["leftLowerLeg", "leftFoot"],
	["leftFoot", null, "leftLowerLeg"],
	["rightUpperLeg", "rightLowerLeg"],
	["rightLowerLeg", "rightFoot"],
	["rightFoot", null, "rightLowerLeg"],
];

const worldQuat = (o: THREE.Object3D) => o.getWorldQuaternion(new THREE.Quaternion());
const worldPos = (o: THREE.Object3D) => o.getWorldPosition(new THREE.Vector3());

/**
 * Returns a clip that moves `target`'s nodes like `clip` moves `source`.
 * - `source`: the motions' scene at rest (left at rest afterwards). Its bones are found by humanoid name.
 * - `target`: normalized bone nodes by humanoid bone name (rest rotations are identity), at rest.
 * Both must face the same way. Tracks address the target nodes by name, so the clip plays on any copy of them.
 */
export function retarget(
	source: THREE.Object3D,
	clip: THREE.AnimationClip,
	target: Partial<Record<string, THREE.Object3D>>,
	fps = 30,
): THREE.AnimationClip {
	const bones = BONES.filter(([b]) => target[b] && source.getObjectByName(b));
	const src = (b: string) => source.getObjectByName(b) as THREE.Object3D;
	const tgt = (b: string) => target[b] as THREE.Object3D;
	const mapped = new Set(bones.map(([b]) => b));

	const srcRest = new Map(bones.map(([b]) => [b, worldQuat(src(b))]));
	// turns the target bone's rest direction into the source's, by the bone it points at (or a neighbour's)
	const turn = new Map<string, THREE.Quaternion>();
	for (const [b, child, like] of bones) {
		let q = new THREE.Quaternion();
		if (child && mapped.has(child)) {
			const to = worldPos(src(child))
				.sub(worldPos(src(b)))
				.normalize();
			const from = worldPos(tgt(child))
				.sub(worldPos(tgt(b)))
				.normalize();
			q = q.setFromUnitVectors(from, to);
		} else if (like) {
			q = turn.get(like)?.clone() ?? q;
		}
		turn.set(b, q);
	}
	/** The target bone's rest rotation in world space, turned to point like the source's rest. */
	const fix = new Map(
		bones.map(([b]) => [b, (turn.get(b) as THREE.Quaternion).clone().multiply(worldQuat(tgt(b)))]),
	);
	// what each target bone hangs from: the nearest mapped ancestor and the rest rotation of the nodes between
	const hangs = new Map<string, { from: string | null; between: THREE.Quaternion }>();
	for (const [b] of bones) {
		const between = new THREE.Quaternion();
		let node = tgt(b).parent;
		let from: string | null = null;
		while (node) {
			from = bones.find(([m]) => tgt(m) === node)?.[0] ?? null;
			if (from) break;
			between.premultiply(node.quaternion);
			node = node.parent;
		}
		hangs.set(b, { from, between: from ? between : worldQuat(tgt(b).parent ?? tgt(b)) });
	}

	const hips = mapped.has("hips") ? "hips" : null;
	const footY = (o: (b: string) => THREE.Object3D) =>
		["leftFoot", "rightFoot"]
			.filter((f) => mapped.has(f))
			.reduce((y, f, _, all) => y + worldPos(o(f)).y / all.length, 0);
	const srcHips0 = hips ? worldPos(src(hips)) : new THREE.Vector3();
	const tgtHips0 = hips ? worldPos(tgt(hips)) : new THREE.Vector3();
	const legScale = hips ? (tgtHips0.y - footY(tgt)) / (srcHips0.y - footY(src) || 1) : 1;
	const toHipsParent = new THREE.Matrix4();
	if (hips) toHipsParent.copy(tgt(hips).parent?.matrixWorld ?? new THREE.Matrix4()).invert();

	// sample, then put the source back at rest
	const saved = new Map<THREE.Object3D, [THREE.Vector3, THREE.Quaternion, THREE.Vector3]>();
	source.traverse((o) => saved.set(o, [o.position.clone(), o.quaternion.clone(), o.scale.clone()]));
	const mixer = new THREE.AnimationMixer(source);
	const action = mixer.clipAction(clip);
	action.setLoop(THREE.LoopOnce, 1);
	action.clampWhenFinished = true;
	action.play();
	const steps = Math.max(1, Math.round(clip.duration * fps));
	const times: number[] = [];
	const rotations = new Map(bones.map(([b]) => [b, [] as number[]]));
	const positions: number[] = [];
	const world = new Map<string, THREE.Quaternion>();
	for (let i = 0; i <= steps; i++) {
		const t = (clip.duration * i) / steps;
		mixer.setTime(t);
		source.updateMatrixWorld(true);
		times.push(t);
		for (const [b] of bones) {
			// how far the source bone turned from rest, applied to the target bone's corrected rest
			const w = worldQuat(src(b))
				.multiply(srcRest.get(b)?.clone().invert() as THREE.Quaternion)
				.multiply(fix.get(b) as THREE.Quaternion);
			world.set(b, w);
			const { from, between } = hangs.get(b) as { from: string | null; between: THREE.Quaternion };
			const parent = from ? (world.get(from) as THREE.Quaternion).clone().multiply(between) : between.clone();
			const local = parent.invert().multiply(w);
			const out = rotations.get(b) as number[];
			// keep neighbouring keys on the same side so interpolation takes the short way
			if (out.length && new THREE.Quaternion().fromArray(out, out.length - 4).dot(local) < 0) {
				local.set(-local.x, -local.y, -local.z, -local.w);
			}
			out.push(local.x, local.y, local.z, local.w);
		}
		if (hips) {
			const p = worldPos(src(hips))
				.sub(srcHips0)
				.multiplyScalar(legScale)
				.add(tgtHips0)
				.applyMatrix4(toHipsParent);
			positions.push(p.x, p.y, p.z);
		}
	}
	mixer.stopAllAction();
	mixer.uncacheRoot(source);
	for (const [o, [p, q, s]] of saved) {
		o.position.copy(p);
		o.quaternion.copy(q);
		o.scale.copy(s);
	}
	source.updateMatrixWorld(true);

	const tracks: THREE.KeyframeTrack[] = bones.map(
		([b]) =>
			new THREE.QuaternionKeyframeTrack(`${tgt(b).name}.quaternion`, times, rotations.get(b) as number[]),
	);
	if (hips) tracks.push(new THREE.VectorKeyframeTrack(`${tgt(hips).name}.position`, times, positions));
	return new THREE.AnimationClip(clip.name, clip.duration, tracks);
}
