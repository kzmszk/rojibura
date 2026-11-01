// The city's own motions (docs/prd.md 3.4.5): joint angles on a T-pose humanoid, written as code and played
// on every VRM (and on Saki) through retarget.ts, so no motion files and no licences are involved.
//
// Angles are degrees, Euler order XYZ, in each bone's own frame; the T-pose is all zeros. The rig faces +Z
// with its left on +X, so for both sides alike:
// - legs and hanging arms: x < 0 swings forward; knees and feet: x > 0 bends back / points the toes down;
// - spine, neck, head, hips: x > 0 bends forward, y > 0 turns to the left, z > 0 leans to the right;
// - arms hang with z = -76 (left) / +76 (right); elbows bend forward with y < 0 (left) / y > 0 (right).

import * as THREE from "three";

export type MoveName =
	| "stand"
	| "walk"
	| "run"
	| "wave"
	| "nod"
	| "bow"
	| "jump"
	| "sit"
	| "lie"
	| "handstand"
	| "roll"
	| "backroll"
	| "backflip"
	| "handshake"
	| "hug"
	| "pick"
	| "throw";

type Angles = [x: number, y: number, z: number];
type Bones = Record<string, Angles>;
interface Frame {
	bones: Bones;
	/** Hips offset from rest, in metres of the reference rig (scaled to each avatar's legs). */
	hips?: [x: number, y: number, z: number];
}

/** The reference skeleton: [bone, parent, position] with the hips 0.9 m up, facing +Z. */
const RIG: [string, string | null, [number, number, number]][] = [
	["hips", null, [0, 0.9, 0]],
	["spine", "hips", [0, 1.0, 0]],
	["chest", "spine", [0, 1.15, 0]],
	["neck", "chest", [0, 1.4, 0]],
	["head", "neck", [0, 1.5, 0]],
	["leftShoulder", "chest", [0.02, 1.36, 0]],
	["leftUpperArm", "leftShoulder", [0.15, 1.36, 0]],
	["leftLowerArm", "leftUpperArm", [0.4, 1.36, 0]],
	["leftHand", "leftLowerArm", [0.63, 1.36, 0]],
	["rightShoulder", "chest", [-0.02, 1.36, 0]],
	["rightUpperArm", "rightShoulder", [-0.15, 1.36, 0]],
	["rightLowerArm", "rightUpperArm", [-0.4, 1.36, 0]],
	["rightHand", "rightLowerArm", [-0.63, 1.36, 0]],
	["leftUpperLeg", "hips", [0.09, 0.86, 0]],
	["leftLowerLeg", "leftUpperLeg", [0.09, 0.48, 0]],
	["leftFoot", "leftLowerLeg", [0.09, 0.08, 0]],
	["rightUpperLeg", "hips", [-0.09, 0.86, 0]],
	["rightLowerLeg", "rightUpperLeg", [-0.09, 0.48, 0]],
	["rightFoot", "rightLowerLeg", [-0.09, 0.08, 0]],
];
const HIPS_Y = 0.9;
const FOOT_Y = 0.08;

/** Builds the reference skeleton. */
export function referenceRig(): THREE.Object3D {
	const root = new THREE.Group();
	const nodes = new Map<string, THREE.Object3D>();
	for (const [name, parent, [x, y, z]] of RIG) {
		const bone = new THREE.Object3D();
		bone.name = name;
		const p = parent ? (nodes.get(parent) as THREE.Object3D) : root;
		const at = parent ? (RIG.find(([n]) => n === parent)?.[2] ?? [0, 0, 0]) : [0, 0, 0];
		bone.position.set(x - (at[0] as number), y - (at[1] as number), z - (at[2] as number));
		p.add(bone);
		nodes.set(name, bone);
	}
	root.updateMatrixWorld(true);
	return root;
}

const RAD = Math.PI / 180;
const euler = new THREE.Euler();
const quat = new THREE.Quaternion();

/**
 * Points of the body that can rest on the ground: [bone, offset in the bone's T-pose frame, radius]. The
 * offsets reach from the joint to the skin (heels, toes, buttocks, back, the back of the head).
 */
const CONTACTS: [string, [number, number, number], number][] = [
	["leftFoot", [0, -0.07, -0.04], 0],
	["rightFoot", [0, -0.07, -0.04], 0],
	["leftFoot", [0, -0.06, 0.15], 0],
	["rightFoot", [0, -0.06, 0.15], 0],
	["leftLowerLeg", [0, 0, 0], 0.05],
	["rightLowerLeg", [0, 0, 0], 0.05],
	["hips", [0, -0.1, -0.08], 0],
	["hips", [0, 0.04, -0.11], 0],
	["spine", [0, 0.06, -0.11], 0],
	["chest", [0, 0.1, -0.12], 0],
	["head", [0, 0.1, -0.1], 0],
	["head", [0, 0.22, 0], 0],
	["leftUpperArm", [0, 0, 0], 0.05],
	["rightUpperArm", [0, 0, 0], 0.05],
	["leftLowerArm", [0, 0, 0], 0.04],
	["rightLowerArm", [0, 0, 0], 0.04],
	["leftHand", [0, 0, 0], 0.03],
	["rightHand", [0, 0, 0], 0.03],
	["leftHand", [0.09, -0.01, 0], 0.01],
	["rightHand", [-0.09, -0.01, 0], 0.01],
];

/**
 * How the hips keep the body on the ground: `touch` — the lowest point of the body just touches it (walking
 * rolls from heel to toe, sitting and lying rest on it: nothing sinks or floats); `above` — nothing goes
 * below it, but the body may leave it (running, jumping).
 */
type Ground = "touch" | "above";

/** Samples `f` at 30 fps into a clip on the reference rig's bones, kept on the ground as `ground` says. */
function sampled(
	name: MoveName,
	duration: number,
	f: (t: number) => Frame,
	ground?: Ground,
): THREE.AnimationClip {
	const steps = Math.max(1, Math.round(duration * 30));
	const rig = ground ? referenceRig() : null;
	const times: number[] = [];
	const rotations = new Map(RIG.map(([b]) => [b, [] as number[]]));
	const hips: number[] = [];
	for (let i = 0; i <= steps; i++) {
		const t = (duration * i) / steps;
		const frame = f(t);
		times.push(t);
		for (const [b] of RIG) {
			const [x, y, z] = frame.bones[b] ?? [0, 0, 0];
			quat.setFromEuler(euler.set(x * RAD, y * RAD, z * RAD, "XYZ"));
			(rotations.get(b) as number[]).push(quat.x, quat.y, quat.z, quat.w);
		}
		const [hx, hy, hz] = frame.hips ?? [0, 0, 0];
		hips.push(hx, HIPS_Y + hy + (rig && ground ? lift(rig, frame, ground) : 0), hz);
	}
	const tracks: THREE.KeyframeTrack[] = RIG.map(
		([b]) => new THREE.QuaternionKeyframeTrack(`${b}.quaternion`, times, rotations.get(b) as number[]),
	);
	tracks.push(new THREE.VectorKeyframeTrack("hips.position", times, hips));
	return new THREE.AnimationClip(name, duration, tracks);
}

const point = new THREE.Vector3();

/** How far to raise the hips (negative: lower them) with `frame` applied to `rig`, to keep it on the ground. */
function lift(rig: THREE.Object3D, frame: Frame, ground: Ground): number {
	for (const [b] of RIG) {
		const [x, y, z] = frame.bones[b] ?? [0, 0, 0];
		(rig.getObjectByName(b) as THREE.Object3D).quaternion.setFromEuler(
			euler.set(x * RAD, y * RAD, z * RAD, "XYZ"),
		);
	}
	const [hx, hy, hz] = frame.hips ?? [0, 0, 0];
	(rig.getObjectByName("hips") as THREE.Object3D).position.set(hx, HIPS_Y + hy, hz);
	const lowest = clearance(rig);
	return ground === "touch" ? -lowest : Math.max(0, -lowest);
}

/** How far the lowest point of the reference rig's body is above the ground (negative: below it), as posed. */
export function clearance(rig: THREE.Object3D): number {
	rig.updateMatrixWorld(true);
	return Math.min(
		...CONTACTS.map(
			([b, at, r]) => (rig.getObjectByName(b) as THREE.Object3D).localToWorld(point.set(...at)).y - r,
		),
	);
}

const ease = (u: number) => u * u * (3 - 2 * u);

/** Every bone at rest (the T-pose). */
const ZERO: Bones = Object.fromEntries(RIG.map(([b]) => [b, [0, 0, 0] as Angles]));

/** Eases from key to key; bones a key leaves out are in the standing pose. */
function keyed(keys: [t: number, frame: Frame][]): (t: number) => Frame {
	const full = keys.map(
		([t, f]) => [t, { bones: { ...ZERO, ...STAND, ...f.bones }, hips: f.hips ?? [0, 0, 0] }] as const,
	);
	return (t) => {
		let i = 0;
		while (i < full.length - 2 && t > (full[i + 1] as (typeof full)[number])[0]) i++;
		const [t0, a] = full[i] as (typeof full)[number];
		const [t1, b] = full[Math.min(i + 1, full.length - 1)] as (typeof full)[number];
		const u = t1 > t0 ? ease(Math.min(1, Math.max(0, (t - t0) / (t1 - t0)))) : 1;
		const bones: Bones = {};
		for (const name of Object.keys(a.bones)) {
			const p = a.bones[name] as Angles;
			const q = b.bones[name] ?? p;
			bones[name] = [p[0] + (q[0] - p[0]) * u, p[1] + (q[1] - p[1]) * u, p[2] + (q[2] - p[2]) * u];
		}
		const h = a.hips as number[];
		const k = b.hips as number[];
		return {
			bones,
			hips: [0, 1, 2].map(
				(j) => (h[j] as number) + ((k[j] as number) - (h[j] as number)) * u,
			) as Frame["hips"],
		};
	};
}

/** Relaxed standing: arms down along the body, elbows a little bent, feet under the hips. */
const STAND: Bones = {
	leftUpperArm: [-4, 0, -76],
	rightUpperArm: [-4, 0, 76],
	leftLowerArm: [0, -10, 0],
	rightLowerArm: [0, 10, 0],
	leftUpperLeg: [0, 0, -1],
	rightUpperLeg: [0, 0, 1],
};

const TAU = Math.PI * 2;
const cos = (u: number) => Math.cos(TAU * u);
const sin = (u: number) => Math.sin(TAU * u);
/** A bump of height 1 at `c` (in cycles) and width `w`, repeating every cycle. */
const bump = (u: number, c: number, w: number) => {
	const d = ((((u - c) % 1) + 1.5) % 1) - 0.5;
	return Math.exp(-(d * d) / (2 * w * w));
};

/** One leg through a gait cycle (`u` = 0 at heel strike). */
function leg(u: number, run: boolean): { hip: number; knee: number; ankle: number } {
	if (run) {
		return {
			hip: -(12 + 36 * cos(u)),
			knee: 18 + 22 * bump(u, 0.15, 0.08) + 85 * bump(u, 0.68, 0.14),
			ankle:
				10 * bump(u, 0.05, 0.05) - 12 * bump(u, 0.3, 0.1) + 22 * bump(u, 0.48, 0.06) - 8 * bump(u, 0.8, 0.1),
		};
	}
	return {
		hip: -(5 + 25 * cos(u)),
		knee: 4 + 14 * bump(u, 0.14, 0.07) + 60 * bump(u, 0.72, 0.11),
		ankle:
			4 * bump(u, 0.06, 0.04) - 9 * bump(u, 0.36, 0.12) + 16 * bump(u, 0.6, 0.06) - 6 * bump(u, 0.82, 0.08),
	};
}

/** Walking or running in place: the avatar's position comes from the host; the legs keep pace with it. */
function gait(run: boolean): (t: number, duration: number) => Frame {
	return (t, duration) => {
		const u = t / duration;
		const r = leg(u, run);
		const l = leg(u + 0.5, run);
		const swing = run ? 32 : 18;
		const bend = run ? 80 : 14;
		// the right arm goes forward with the left leg (u = 0.5)
		const rArm = swing * cos(u);
		const lArm = -swing * cos(u);
		const lean = run ? 9 : 3;
		return {
			bones: {
				hips: [run ? 4 : 0, (run ? 7 : 5) * cos(u), 2 * sin(u)],
				spine: [lean * 0.6, (run ? -3 : -2) * cos(u), 0],
				chest: [lean * 0.4, (run ? -6 : -4) * cos(u), -1 * sin(u)],
				// hips, spine and chest turn against each other; the head keeps looking ahead
				neck: [-lean * 0.4, (run ? 1 : 0.5) * cos(u), 0],
				head: [-lean * 0.3, (run ? 1 : 0.5) * cos(u), 0],
				leftShoulder: [0, 0, run ? 4 : 0],
				rightShoulder: [0, 0, run ? -4 : 0],
				leftUpperArm: [lArm - (run ? 8 : 4), 0, run ? -70 : -77],
				rightUpperArm: [rArm - (run ? 8 : 4), 0, run ? 70 : 77],
				// an elbow bends a little more while its arm is in front
				leftLowerArm: [0, -(bend + (run ? 10 : 8) * Math.max(0, cos(u))), 0],
				rightLowerArm: [0, bend + (run ? 10 : 8) * Math.max(0, -cos(u)), 0],
				// feet land close to the middle line, not apart
				leftUpperLeg: [l.hip, 0, -2],
				rightUpperLeg: [r.hip, 0, 2],
				leftLowerLeg: [l.knee, 0, 0],
				rightLowerLeg: [r.knee, 0, 0],
				leftFoot: [l.ankle, 0, 0],
				rightFoot: [r.ankle, 0, 0],
			},
			hips: [
				-(run ? 0.01 : 0.012) * cos(u - 0.25),
				// walking: the hips follow the foot on the ground (sampled with `touch`)
				run ? -0.03 - 0.035 * cos(2 * (u - 0.15)) : 0,
				0,
			],
		};
	};
}

function breathe(t: number): Frame {
	const u = t / 4;
	return {
		bones: {
			...STAND,
			spine: [0.6 * sin(u), 0, 0.4 * sin(u * 0.5)],
			chest: [1.2 * sin(u), 0, 0],
			head: [-0.6 * sin(u), 1.5 * sin(u * 0.5), 0],
			leftUpperArm: [-4 + 1.5 * sin(u), 0, -76],
			rightUpperArm: [-4 + 1.5 * sin(u), 0, 76],
		},
		hips: [0.008 * sin(u * 0.5), 0, 0],
	};
}

function wave(t: number): Frame {
	const raise = keyed([
		[0, { bones: {} }],
		[0.4, { bones: { rightUpperArm: [0, 15, -32], rightLowerArm: [0, 10, -95], head: [0, -6, 4] } }],
		[1.7, { bones: { rightUpperArm: [0, 15, -32], rightLowerArm: [0, 10, -95], head: [0, -6, 4] } }],
		[2.1, { bones: {} }],
	])(t);
	// the hand sways while the arm is up
	const sway = t > 0.4 && t < 1.7 ? 22 * Math.sin((t - 0.4) * TAU * 2.4) : 0;
	const fore = raise.bones.rightLowerArm as Angles;
	raise.bones.rightLowerArm = [fore[0], fore[1], fore[2] + sway];
	return raise;
}

const SQUAT: Frame = {
	bones: {
		spine: [22, 0, 0],
		chest: [8, 0, 0],
		head: [-10, 0, 0],
		leftUpperArm: [-35, 0, -70],
		rightUpperArm: [-35, 0, 70],
		leftUpperLeg: [-95, 0, -6],
		rightUpperLeg: [-95, 0, 6],
		leftLowerLeg: [120, 0, 0],
		rightLowerLeg: [120, 0, 0],
		leftFoot: [-25, 0, 0],
		rightFoot: [-25, 0, 0],
	},
	hips: [0, -0.45, -0.05],
};

/**
 * Sitting on the ground, leaning back on the hands behind: the thighs rise a little from the hips, the
 * shins come down to the heels. (The hips' height comes from touching the ground, see `sampled`.)
 */
const SITTING: Frame = {
	bones: {
		hips: [-35, 0, 0],
		neck: [12, 0, 0],
		head: [18, 0, 0],
		// arms straight down to the ground, a little behind and outside the shoulders: the body leans back
		// 35°, so they swing back 50° from it to point 15° behind straight down
		leftUpperArm: [50, 0, -80],
		rightUpperArm: [50, 0, 80],
		leftLowerArm: [0, 0, 0],
		rightLowerArm: [0, 0, 0],
		leftUpperLeg: [-75, 0, -6],
		rightUpperLeg: [-70, 0, 8],
		leftLowerLeg: [44, 0, 0],
		rightLowerLeg: [30, 0, 0],
		leftFoot: [20, 0, 0],
		rightFoot: [22, 0, 0],
	},
	hips: [0, 0, -0.12],
};

/** Lying on the back, the arms by the sides on the ground, the left knee up with the foot flat. */
const LYING: Frame = {
	bones: {
		hips: [-90, 0, 0],
		neck: [10, 0, 0],
		head: [8, 8, 0],
		// x > 0 takes the arms back, which is down to the ground when lying
		leftUpperArm: [12, 0, -72],
		rightUpperArm: [12, 0, 72],
		leftLowerArm: [0, -4, 0],
		rightLowerArm: [0, 4, 0],
		leftUpperLeg: [-45, 0, -4],
		leftLowerLeg: [90, 0, 0],
		leftFoot: [45, 0, 0],
		rightUpperLeg: [0, 0, 5],
		rightLowerLeg: [4, 0, 0],
		rightFoot: [22, 0, 0],
	},
	hips: [0, 0, -0.25],
};

/** Knees to the chest, chin tucked, arms round the shins: rolling. */
const TUCK: Bones = {
	spine: [32, 0, 0],
	chest: [24, 0, 0],
	// chin on the chest, so the back rolls on the ground and not the head
	neck: [50, 0, 0],
	head: [35, 0, 0],
	leftUpperArm: [-70, 0, -72],
	rightUpperArm: [-70, 0, 72],
	leftLowerArm: [0, -70, 0],
	rightLowerArm: [0, 70, 0],
	leftUpperLeg: [-135, 0, -8],
	rightUpperLeg: [-135, 0, 8],
	leftLowerLeg: [140, 0, 0],
	rightLowerLeg: [140, 0, 0],
	leftFoot: [30, 0, 0],
	rightFoot: [30, 0, 0],
};

/** Crouching with the hands reaching to the ground ahead: before a roll and after landing. */
const CROUCH: Bones = {
	spine: [28, 0, 0],
	chest: [14, 0, 0],
	head: [-12, 0, 0],
	leftUpperArm: [-75, 0, -74],
	rightUpperArm: [-75, 0, 74],
	leftUpperLeg: [-105, 0, -8],
	rightUpperLeg: [-105, 0, 8],
	leftLowerLeg: [125, 0, 0],
	rightLowerLeg: [125, 0, 0],
	leftFoot: [-25, 0, 0],
	rightFoot: [-25, 0, 0],
};

/** Hands by the ears, ready to push the ground over the head: rolling backwards. */
const PUSH: Bones = {
	leftUpperArm: [-150, 0, -50],
	rightUpperArm: [-150, 0, 50],
	leftLowerArm: [0, -140, 0],
	rightLowerArm: [0, 140, 0],
};

/** Arms straight up along the body, the hands bent back so the palms are flat (on the ground, upside down). */
const OVERHEAD: Bones = {
	leftShoulder: [0, 0, 12],
	rightShoulder: [0, 0, -12],
	leftUpperArm: [0, 0, 80],
	rightUpperArm: [0, 0, -80],
	leftLowerArm: [0, 0, 0],
	rightLowerArm: [0, 0, 0],
	leftHand: [90, 0, 90],
	rightHand: [90, 0, -90],
};

/** The back arched and the head back, looking for the ground behind. */
const ARCH: Bones = { spine: [-18, 0, 0], chest: [-14, 0, 0], neck: [-30, 0, 0], head: [-20, 0, 0] };

/** Upside down on the hands, legs together, toes pointed. */
const HANDSTAND: Bones = {
	...OVERHEAD,
	neck: [-25, 0, 0],
	head: [-20, 0, 0],
	leftUpperLeg: [0, 0, -3],
	rightUpperLeg: [0, 0, 3],
	leftFoot: [40, 0, 0],
	rightFoot: [40, 0, 0],
};

/** One foot forward, bending down with the hands to the ground; the other leg behind, ready to kick up. */
const LUNGE: Bones = {
	...OVERHEAD,
	spine: [10, 0, 0],
	leftUpperLeg: [-70, 0, -4],
	leftLowerLeg: [60, 0, 0],
	rightUpperLeg: [-10, 0, 4],
	rightFoot: [20, 0, 0],
};

/** Half way up (or down): the body leaning over the hands, one leg up, the other bent. */
const KICK: Bones = {
	...OVERHEAD,
	neck: [-15, 0, 0],
	leftUpperLeg: [-60, 0, -4],
	leftLowerLeg: [50, 0, 0],
	rightUpperLeg: [10, 0, 4],
	rightFoot: [40, 0, 0],
};

/**
 * The right hand held out to someone standing TOGETHER_GAP.handshake (0.65 m) away: it reaches to the middle
 * line, 0.33 m ahead at waist height, where the other's right hand comes too.
 */
const SHAKE: Bones = { spine: [4, 0, 0], rightUpperArm: [0, 110, 46], rightLowerArm: [0, 12, 0] };

/** Arms round someone 0.4 m away: the left over the shoulder, the right lower round the back; head aside. */
const HUG: Bones = {
	spine: [6, 0, 0],
	chest: [4, 0, 0],
	head: [0, 25, 0],
	leftUpperArm: [0, -70, -5],
	leftLowerArm: [0, -85, 0],
	rightUpperArm: [0, 70, 30],
	rightLowerArm: [0, 85, 0],
};

/** A whole-body turn (forward, about the hips) of `x` degrees with `bones`, the hips moved by `at`. */
const turn = (x: number, bones: Bones, at: [number, number, number] = [0, 0, 0]): Frame => ({
	bones: { ...bones, hips: [x, 0, 0] },
	hips: at,
});

/**
 * Every motion, and how it plays: loops, once, or once and then held (a posture). `travel`: metres the
 * avatar moves along its heading meanwhile (backwards if negative); the clip itself stays in place and the
 * client walks the avatar there (a path at the speed that takes as long as the clip).
 */
export const MOVES: {
	name: MoveName;
	play: "loop" | "once" | "hold";
	travel?: number;
	clip: () => THREE.AnimationClip;
}[] = [
	{ name: "stand", play: "loop", clip: () => sampled("stand", 4, breathe) },
	{ name: "walk", play: "loop", clip: () => sampled("walk", 1.05, (t) => gait(false)(t, 1.05), "touch") },
	{ name: "run", play: "loop", clip: () => sampled("run", 0.7, (t) => gait(true)(t, 0.7), "above") },
	{ name: "wave", play: "once", clip: () => sampled("wave", 2.1, wave) },
	{
		name: "nod",
		play: "once",
		clip: () =>
			sampled(
				"nod",
				1.1,
				keyed([
					[0, { bones: {} }],
					[0.22, { bones: { neck: [8, 0, 0], head: [16, 0, 0] } }],
					[0.45, { bones: { neck: [1, 0, 0], head: [2, 0, 0] } }],
					[0.66, { bones: { neck: [6, 0, 0], head: [13, 0, 0] } }],
					[1.1, { bones: {} }],
				]),
			),
	},
	{
		name: "bow",
		play: "once",
		clip: () =>
			sampled(
				"bow",
				2.2,
				keyed([
					[0, { bones: {} }],
					[
						0.6,
						{
							bones: { spine: [22, 0, 0], chest: [16, 0, 0], neck: [6, 0, 0], head: [6, 0, 0] },
							hips: [0, -0.01, -0.05],
						},
					],
					[
						1.4,
						{
							bones: { spine: [22, 0, 0], chest: [16, 0, 0], neck: [6, 0, 0], head: [6, 0, 0] },
							hips: [0, -0.01, -0.05],
						},
					],
					[2.2, { bones: {} }],
				]),
				"above",
			),
	},
	{
		name: "jump",
		play: "once",
		clip: () =>
			sampled(
				"jump",
				1.2,
				keyed([
					[0, { bones: {} }],
					[
						0.28,
						{
							bones: {
								spine: [16, 0, 0],
								leftUpperArm: [38, 0, -72],
								rightUpperArm: [38, 0, 72],
								leftUpperLeg: [-42, 0, -2],
								rightUpperLeg: [-42, 0, 2],
								leftLowerLeg: [78, 0, 0],
								rightLowerLeg: [78, 0, 0],
								leftFoot: [-24, 0, 0],
								rightFoot: [-24, 0, 0],
							},
							hips: [0, -0.16, -0.03],
						},
					],
					[
						0.4,
						{
							bones: {
								spine: [-2, 0, 0],
								leftUpperArm: [-150, 0, -40],
								rightUpperArm: [-150, 0, 40],
								leftFoot: [30, 0, 0],
								rightFoot: [30, 0, 0],
							},
							hips: [0, 0.12, 0],
						},
					],
					[
						0.55,
						{
							bones: {
								leftUpperArm: [-140, 0, -45],
								rightUpperArm: [-140, 0, 45],
								leftUpperLeg: [-28, 0, -2],
								rightUpperLeg: [-28, 0, 2],
								leftLowerLeg: [50, 0, 0],
								rightLowerLeg: [50, 0, 0],
								leftFoot: [20, 0, 0],
								rightFoot: [20, 0, 0],
							},
							hips: [0, 0.32, 0],
						},
					],
					[
						0.72,
						{
							bones: {
								leftFoot: [12, 0, 0],
								rightFoot: [12, 0, 0],
								leftUpperArm: [-60, 0, -60],
								rightUpperArm: [-60, 0, 60],
							},
							hips: [0, 0.04, 0],
						},
					],
					[
						0.84,
						{
							bones: {
								spine: [14, 0, 0],
								leftUpperArm: [-20, 0, -70],
								rightUpperArm: [-20, 0, 70],
								leftUpperLeg: [-36, 0, -2],
								rightUpperLeg: [-36, 0, 2],
								leftLowerLeg: [66, 0, 0],
								rightLowerLeg: [66, 0, 0],
								leftFoot: [-22, 0, 0],
								rightFoot: [-22, 0, 0],
							},
							hips: [0, -0.13, -0.02],
						},
					],
					[1.2, { bones: {} }],
				]),
				"above",
			),
	},
	{
		name: "sit",
		play: "hold",
		clip: () =>
			sampled(
				"sit",
				1.5,
				keyed([
					[0, { bones: {} }],
					[0.55, SQUAT],
					[1.5, SITTING],
				]),
				"touch",
			),
	},
	{
		name: "lie",
		play: "hold",
		clip: () =>
			sampled(
				"lie",
				2.4,
				keyed([
					[0, { bones: {} }],
					[0.55, SQUAT],
					[1.4, SITTING],
					[2.4, LYING],
				]),
				"touch",
			),
	},
	{
		name: "handstand",
		play: "once",
		clip: () =>
			sampled(
				"handstand",
				5,
				keyed([
					[0, { bones: {} }],
					[0.6, turn(75, LUNGE, [0, 0, 0.25])],
					[1.1, turn(150, KICK, [0, 0, 0.4])],
					[1.5, turn(180, HANDSTAND, [0, 0, 0.45])],
					// keeping the balance
					[
						2.2,
						turn(184, { ...HANDSTAND, leftUpperLeg: [4, 0, -6], rightUpperLeg: [-4, 0, 6] }, [0, 0, 0.45]),
					],
					[
						2.9,
						turn(177, { ...HANDSTAND, leftUpperLeg: [-5, 0, -3], rightUpperLeg: [5, 0, 3] }, [0, 0, 0.45]),
					],
					[3.5, turn(181, HANDSTAND, [0, 0, 0.45])],
					[3.9, turn(150, KICK, [0, 0, 0.4])],
					[4.4, turn(75, LUNGE, [0, 0, 0.25])],
					[5, { bones: {} }],
				]),
				"touch",
			),
	},
	{
		name: "roll",
		play: "once",
		travel: 1,
		clip: () =>
			sampled(
				"roll",
				1.7,
				keyed([
					[0, { bones: {} }],
					[0.35, turn(10, CROUCH)],
					[0.6, turn(80, TUCK)],
					[0.85, turn(170, TUCK)],
					[1.1, turn(260, TUCK)],
					[1.35, turn(345, CROUCH)],
					[1.7, turn(360, {})],
				]),
				"touch",
			),
	},
	{
		name: "backroll",
		play: "once",
		travel: -0.9,
		clip: () =>
			sampled(
				"backroll",
				1.7,
				keyed([
					[0, { bones: {} }],
					[0.35, turn(8, CROUCH)],
					[0.6, turn(-40, { ...TUCK, ...PUSH })],
					[0.85, turn(-130, { ...TUCK, ...PUSH })],
					[1.1, turn(-225, { ...TUCK, ...PUSH })],
					[1.35, turn(-320, CROUCH)],
					[1.7, turn(-360, {})],
				]),
				"touch",
			),
	},
	{
		// a back handspring: jump back, hands on the ground behind, legs over, land on the feet
		name: "backflip",
		play: "once",
		travel: -1.4,
		clip: () =>
			sampled(
				"backflip",
				1.45,
				keyed([
					[0, { bones: {} }],
					[
						0.28,
						{
							bones: {
								spine: [18, 0, 0],
								leftUpperArm: [45, 0, -72],
								rightUpperArm: [45, 0, 72],
								leftUpperLeg: [-60, 0, -4],
								rightUpperLeg: [-60, 0, 4],
								leftLowerLeg: [95, 0, 0],
								rightLowerLeg: [95, 0, 0],
								leftFoot: [-20, 0, 0],
								rightFoot: [-20, 0, 0],
							},
							hips: [0, -0.22, 0],
						},
					],
					[
						0.48,
						turn(
							-55,
							{
								...ARCH,
								...OVERHEAD,
								leftUpperLeg: [-10, 0, -4],
								rightUpperLeg: [-10, 0, 4],
								leftLowerLeg: [20, 0, 0],
								rightLowerLeg: [20, 0, 0],
								leftFoot: [30, 0, 0],
								rightFoot: [30, 0, 0],
							},
							[0, 0.14, 0],
						),
					],
					[
						0.66,
						turn(
							-165,
							{
								...ARCH,
								...OVERHEAD,
								leftUpperLeg: [15, 0, -4],
								rightUpperLeg: [15, 0, 4],
								leftFoot: [40, 0, 0],
								rightFoot: [40, 0, 0],
							},
							[0, 0.05, 0],
						),
					],
					[
						0.84,
						turn(
							-250,
							{
								// the legs snap down over the head while the hands push off, the body passing high
								...OVERHEAD,
								leftUpperLeg: [-80, 0, -4],
								rightUpperLeg: [-80, 0, 4],
								leftLowerLeg: [30, 0, 0],
								rightLowerLeg: [30, 0, 0],
								leftFoot: [20, 0, 0],
								rightFoot: [20, 0, 0],
							},
							[0, 0.12, 0],
						),
					],
					[
						1.02,
						turn(
							-330,
							{
								spine: [15, 0, 0],
								leftUpperArm: [-60, 0, -70],
								rightUpperArm: [-60, 0, 70],
								leftUpperLeg: [-55, 0, -6],
								rightUpperLeg: [-55, 0, 6],
								leftLowerLeg: [80, 0, 0],
								rightLowerLeg: [80, 0, 0],
								leftFoot: [-20, 0, 0],
								rightFoot: [-20, 0, 0],
							},
							[0, -0.25, 0],
						),
					],
					[1.45, turn(-360, {})],
				]),
				"above",
			),
	},
	// done together (docs/prd.md 3.4.6): both play the same clip, facing each other
	{
		name: "handshake",
		play: "once",
		clip: () =>
			sampled("handshake", 2.2, (t) => {
				const f = keyed([
					[0, { bones: {} }],
					[0.5, { bones: SHAKE }],
					[1.7, { bones: SHAKE }],
					[2.2, { bones: {} }],
				])(t);
				// three shakes
				if (t > 0.5 && t < 1.7) {
					const arm = f.bones.rightUpperArm as Angles;
					f.bones.rightUpperArm = [arm[0], arm[1], arm[2] + 7 * Math.sin((t - 0.5) * TAU * 2.5)];
				}
				return f;
			}),
	},
	{
		name: "hug",
		play: "once",
		clip: () =>
			sampled("hug", 3, (t) => {
				const f = keyed([
					[0, { bones: {} }],
					[0.6, { bones: HUG }],
					[2.4, { bones: HUG }],
					[3, { bones: {} }],
				])(t);
				if (t > 0.6 && t < 2.4) f.bones.spine = [6, 3 * Math.sin((t - 0.6) * TAU * 0.6), 0];
				return f;
			}),
	},
	// small things (docs/prd.md 3.4.7): the thing follows the right hand
	{
		name: "pick",
		play: "once",
		clip: () =>
			sampled(
				"pick",
				1.1,
				keyed([
					[0, { bones: {} }],
					[
						0.45,
						{
							// down to the ground: bend over in the squat, the right arm straight down
							bones: {
								...SQUAT.bones,
								spine: [45, 0, 0],
								chest: [20, 0, 0],
								head: [-25, 0, 0],
								rightUpperArm: [-65, 0, 78],
								rightLowerArm: [0, 5, 0],
							},
							hips: SQUAT.hips,
						},
					],
					[1.1, { bones: {} }],
				]),
				"touch",
			),
	},
	{
		name: "throw",
		play: "once",
		clip: () =>
			sampled(
				"throw",
				0.9,
				keyed([
					[0, { bones: {} }],
					// wind up: the hand back over the shoulder, the body turned away
					[
						0.25,
						{
							bones: {
								spine: [-4, -14, 0],
								chest: [0, -10, 0],
								rightUpperArm: [35, 0, -40],
								rightLowerArm: [0, 95, 0],
							},
						},
					],
					// the hand lets go here (THROW_RELEASE_MS)
					[
						0.35,
						{
							bones: {
								spine: [6, 10, 0],
								chest: [4, 8, 0],
								rightUpperArm: [-110, 0, 20],
								rightLowerArm: [0, 20, 0],
							},
						},
					],
					[0.6, { bones: { spine: [14, 12, 0], rightUpperArm: [-60, 0, 60], rightLowerArm: [0, 15, 0] } }],
					[0.9, { bones: {} }],
				]),
				"above",
			),
	},
];

/** Leg length of a skeleton at rest: hips height above the feet (humanoid bone names). */
export function legLength(bones: Partial<Record<string, THREE.Object3D>>): number {
	const y = (b: string) => bones[b]?.getWorldPosition(new THREE.Vector3()).y ?? 0;
	return y("hips") - (y("leftFoot") + y("rightFoot")) / 2;
}

export const REFERENCE_LEG = HIPS_Y - FOOT_Y;

/**
 * How fast the reference rig moves over the ground when `clip` plays at normal speed: the speed at which the
 * lower foot (the one on the ground) stays put. Players scale walk and run to their real speed with it, so
 * the feet do not slide.
 */
export function groundSpeed(clip: THREE.AnimationClip): number {
	const rig = referenceRig();
	const mixer = new THREE.AnimationMixer(rig);
	mixer.clipAction(clip).play();
	const feet = ["leftFoot", "rightFoot"].map((f) => rig.getObjectByName(f) as THREE.Object3D);
	const hips = rig.getObjectByName("hips") as THREE.Object3D;
	const at = (t: number) => {
		mixer.setTime(t);
		rig.updateMatrixWorld(true);
		const h = hips.getWorldPosition(new THREE.Vector3());
		return feet.map((f) => {
			const p = f.getWorldPosition(new THREE.Vector3());
			return { y: p.y, z: p.z - h.z };
		});
	};
	const steps = 120;
	const dt = clip.duration / steps;
	let moved = 0;
	let time = 0;
	for (let i = 0; i < steps; i++) {
		const a = at(i * dt);
		const b = at((i + 1) * dt);
		const low = (a[0]?.y ?? 0) <= (a[1]?.y ?? 0) ? 0 : 1;
		// in the air (running): no foot to keep still
		if ((a[low]?.y ?? 0) > FOOT_Y + 0.03) continue;
		moved += (a[low]?.z ?? 0) - (b[low]?.z ?? 0);
		time += dt;
	}
	return time > 0 ? moved / time : 1;
}
