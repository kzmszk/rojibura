// Body scripts on screen (docs/prd.md 3.4.11): an AI says where its hands go, where it looks, how far it leans
// and how low it gets; this works the joints out every frame, on top of whatever motion is playing. The arms
// and legs are solved as two-bone chains (shoulder-elbow-wrist, hip-knee-ankle), so a hand finds a head
// whatever the two avatars' heights, and follows it if it moves.
//
// The bones are a VRM's normalized ones (rest rotations identity), or the reference rig's in tests. Changes
// are taken off again before the next frame of the motion (`restore`): three.js's mixer leaves a bone alone
// while its value stays the same, so anything left on would add up.

import { BODY_SETTLE, type BodyHand, type BodyKey, type BodyPart, type BodySpot } from "@rojibura/protocol";
import * as THREE from "three";

/** Where things are on a body, in the world. */
export interface BodyParts {
	/** A part, moved by `off` metres in the body's frame [right, up, front]; null if unknown. */
	spot(part: BodyPart, off?: [number, number, number]): THREE.Vector3 | null;
	/** The body's frame: unit vectors to its right, up and front. */
	frame(): { right: THREE.Vector3; up: THREE.Vector3; front: THREE.Vector3 };
}

type Hand = BodyHand | "rest";
type Look = BodySpot | "ahead";

/** One channel of a script: values reached at times (seconds), from rest at 0 back to rest at the end. */
type Track<T> = [t: number, v: T][];

/** How a channel stands at a moment: going from `a` to `b`, `u` of the way (eased). */
interface Between<T> {
	a: T;
	b: T;
	u: number;
}

/** The shortest a channel takes to leave rest (seconds), so a first key at 0 does not jump. */
const FIRST_MOVE = 0.35;
const ease = (u: number) => u * u * (3 - 2 * u);

function track<T>(keys: readonly BodyKey[], pick: (k: BodyKey) => T | undefined, rest: T): Track<T> {
	const end = keys[keys.length - 1]?.at ?? 0;
	const out: Track<T> = [[0, rest]];
	for (const k of keys) {
		const v = pick(k);
		if (v === undefined) continue;
		const prev = (out[out.length - 1] as [number, T])[0];
		out.push([Math.max(k.at, out.length === 1 ? FIRST_MOVE : prev + 0.05), v]);
	}
	const last = out[out.length - 1] as [number, T];
	// held until the last key of the whole script, then back to rest
	if (last[0] < end) out.push([end, last[1]]);
	out.push([Math.max(end, last[0]) + BODY_SETTLE, rest]);
	return out;
}

/** A hand's keys with the palm kept from the key before when one leaves it out (it stays turned that way). */
function palmKept(pick: (k: BodyKey) => Hand | undefined): (k: BodyKey) => Hand | undefined {
	let palm: BodyHand["palm"];
	return (k) => {
		const h = pick(k);
		if (h === undefined || h === "rest") {
			if (h === "rest") palm = undefined;
			return h;
		}
		if (h.palm) palm = h.palm;
		return palm && !h.palm ? { ...h, palm } : h;
	};
}

function between<T>(tr: Track<T>, t: number): Between<T> {
	for (let i = 1; i < tr.length; i++) {
		const [t1, b] = tr[i] as [number, T];
		if (t < t1) {
			const [t0, a] = tr[i - 1] as [number, T];
			return { a, b, u: ease(t1 > t0 ? (t - t0) / (t1 - t0) : 1) };
		}
	}
	const last = (tr[tr.length - 1] as [number, T])[1];
	return { a: last, b: last, u: 1 };
}

/** A script playing from host time `at` (ms). */
export class BodyScript {
	readonly end: number;
	private readonly right: Track<Hand>;
	private readonly left: Track<Hand>;
	private readonly look: Track<Look>;
	private readonly lean: Track<number>;
	private readonly height: Track<number>;
	private readonly keys: readonly BodyKey[];
	readonly at: number;
	/** The one "you" means, if any. */
	readonly to: string | undefined;

	constructor(keys: readonly BodyKey[], at: number, to?: string) {
		this.keys = keys;
		this.at = at;
		this.to = to;
		this.right = track(
			keys,
			palmKept((k) => k.right),
			"rest",
		);
		this.left = track(
			keys,
			palmKept((k) => k.left),
			"rest",
		);
		this.look = track(keys, (k) => k.look, "ahead");
		this.lean = track(keys, (k) => k.lean, 0);
		this.height = track(keys, (k) => k.height, 0);
		const last = (tr: Track<unknown>) => (tr[tr.length - 1] as [number, unknown])[0];
		const seconds = Math.max(...[this.right, this.left, this.look, this.lean, this.height].map(last));
		this.end = at + seconds * 1000;
	}

	/** Whether any key points at "you". */
	get forSomeone(): boolean {
		return this.keys.some((k) =>
			[k.right, k.left, k.look].some((s) => s !== undefined && typeof s !== "string" && s.of === "you"),
		);
	}

	sample(t: number): BodySample {
		const num = (tr: Track<number>) => {
			const { a, b, u } = between(tr, t);
			return a + (b - a) * u;
		};
		let smile = false;
		for (const k of this.keys) if (k.at <= t && k.smile !== undefined) smile = k.smile;
		return {
			t,
			right: between(this.right, t),
			left: between(this.left, t),
			look: between(this.look, t),
			lean: num(this.lean),
			height: num(this.height),
			smile,
		};
	}
}

export interface BodySample {
	/** Seconds since the start (for wiggles). */
	t: number;
	right: Between<Hand>;
	left: Between<Hand>;
	look: Between<Look>;
	lean: number;
	height: number;
	smile: boolean;
}

/** Bones by humanoid name (normalized VRM bones, or the reference rig's). */
export type Bones = Partial<Record<string, THREE.Object3D>>;

const UP = new THREE.Vector3(0, 1, 0);
const v1 = new THREE.Vector3();
const v2 = new THREE.Vector3();
const q1 = new THREE.Quaternion();
const q2 = new THREE.Quaternion();
const m1 = new THREE.Matrix4();

const worldPos = (o: THREE.Object3D, out = new THREE.Vector3()) => o.getWorldPosition(out);
const worldQuat = (o: THREE.Object3D, out = new THREE.Quaternion()) => o.getWorldQuaternion(out);

/** The rotation whose x axis is `primary` and whose xy plane holds `secondary`. */
function basis(primary: THREE.Vector3, secondary: THREE.Vector3): THREE.Quaternion {
	const x = primary.clone().normalize();
	const y = secondary.clone().addScaledVector(x, -secondary.dot(x));
	// secondary along primary: any direction across it will do
	if (y.lengthSq() < 1e-10) y.set(x.y, -x.x, 0);
	if (y.lengthSq() < 1e-10) y.set(0, x.z, -x.y);
	y.normalize();
	const z = new THREE.Vector3().crossVectors(x, y);
	return new THREE.Quaternion().setFromRotationMatrix(m1.makeBasis(x, y, z));
}

/** Turns `bone` by the world rotation `q` (on top of where it is now). */
function turnInWorld(bone: THREE.Object3D, q: THREE.Quaternion): void {
	const parent = bone.parent;
	if (!parent) return;
	parent.updateWorldMatrix(true, false);
	const pq = worldQuat(parent, q2);
	bone.quaternion.premultiply(pq.clone().invert().multiply(q).multiply(pq));
	bone.updateWorldMatrix(false, true);
}

export interface Chain {
	upper: THREE.Object3D;
	lower: THREE.Object3D;
	end: THREE.Object3D;
	/** The joint between upper and lower turns about this axis of `lower` (elbow: y, knee: x)... */
	axis: THREE.Vector3;
	/** ...this way to bend the right way (found once, see hingeSign). */
	sign: number;
}

/**
 * Which way `chain`'s middle joint bends so that its end moves along `want` (world): +1 or -1. Elbows bend
 * forward and knees backward, whichever way a model's bones are set up.
 */
export function hingeSign(chain: Omit<Chain, "sign">, want: THREE.Vector3): number {
	const before = worldPos(chain.end);
	const saved = chain.lower.quaternion.clone();
	chain.lower.quaternion.multiply(q1.setFromAxisAngle(chain.axis, 0.3));
	chain.lower.updateWorldMatrix(true, true);
	const moved = worldPos(chain.end).sub(before).dot(want);
	chain.lower.quaternion.copy(saved);
	chain.lower.updateWorldMatrix(true, true);
	return moved >= 0 ? 1 : -1;
}

/**
 * Puts `chain`'s end at `target` (world) with the middle joint towards `pole` (a world direction), bending
 * only about the hinge. Returns how far short of the target it stays (m, 0 if it reaches), and leaves the
 * rotations on the bones.
 */
export function solveChain(chain: Chain, target: THREE.Vector3, pole: THREE.Vector3): number {
	const { upper, lower, end } = chain;
	const parent = upper.parent;
	if (!parent) return 0;
	parent.updateWorldMatrix(true, false);
	const inv = m1.copy(parent.matrixWorld).invert();
	const t = target.clone().applyMatrix4(inv);
	const pq = worldQuat(parent, q2).invert();
	const p = pole.clone().applyQuaternion(pq);
	const a = upper.position;
	const l1 = lower.position.length();
	const l2 = end.position.length();
	const want = t.clone().sub(a);
	const reach = (l1 + l2) * 0.999;
	const d = THREE.MathUtils.clamp(want.length(), Math.abs(l1 - l2) + 1e-3, reach);
	const inner = Math.acos(THREE.MathUtils.clamp((l1 * l1 + l2 * l2 - d * d) / (2 * l1 * l2), -1, 1));
	const bend = Math.max(5 * THREE.MathUtils.DEG2RAD, Math.PI - inner);
	lower.quaternion.setFromAxisAngle(chain.axis, chain.sign * bend);
	// with the upper bone at rest: where the elbow and the wrist are, from the shoulder
	const elbow = lower.position.clone();
	const wrist = end.position.clone().applyQuaternion(lower.quaternion).add(elbow);
	upper.quaternion.copy(basis(want, p).multiply(basis(wrist, elbow).invert()));
	upper.updateWorldMatrix(false, true);
	// lengths and the target in the parent's units: back to metres in the world
	const scale = parent.getWorldScale(v1).x;
	return Math.max(0, want.length() - reach) * scale;
}

export interface BodyResult {
	/** Where the eyes look (world), or null for straight ahead. */
	look: THREE.Vector3 | null;
	smile: boolean;
	/** How far each hand stays short of where it should be (m). */
	short: { right: number; left: number };
}

const SIDES = ["right", "left"] as const;
/** The most a body strains for something out of reach: leaning (degrees) and up on the toes (m). */
const STRAIN_LEAN = 20;
const STRAIN_RISE = 0.05;

/**
 * Lays a script's moment on a body. One per avatar: it remembers the bones it changed (restored before the
 * next frame of the motion), which way its joints bend, and how hard it is straining to reach.
 */
export class BodyRig {
	private readonly saved = new Map<THREE.Object3D, THREE.Quaternion>();
	private hipsSaved: THREE.Vector3 | null = null;
	private readonly chains = new Map<string, Chain>();
	/** Straining for something out of reach: leaning towards it (degrees) and rising on the toes (m). */
	private strain = { lean: 0, rise: 0, towards: new THREE.Vector3() };
	private short = { right: 0, left: 0 };
	/** Whether a hand reached for something last frame. */
	private reaching = false;

	private readonly bones: Bones;
	/** The body's size over the reference rig's (part offsets and hand lengths scale with it). */
	private readonly scale: number;

	constructor(bones: Bones, scale = 1) {
		this.bones = bones;
		this.scale = scale;
	}

	/** A new script starts from the body as it is, not straining for the last one's spot. */
	reset(): void {
		this.strain = { lean: 0, rise: 0, towards: new THREE.Vector3() };
		this.short = { right: 0, left: 0 };
	}

	/** Takes this frame's changes off again (call before the motion's next frame). */
	restore(): void {
		for (const [bone, q] of this.saved) bone.quaternion.copy(q);
		this.saved.clear();
		const hips = this.bones.hips;
		if (hips && this.hipsSaved) hips.position.copy(this.hipsSaved);
		this.hipsSaved = null;
	}

	private keep(bone: THREE.Object3D | undefined): THREE.Object3D | undefined {
		if (bone && !this.saved.has(bone)) this.saved.set(bone, bone.quaternion.clone());
		return bone;
	}

	private chain(
		name: string,
		upper: string,
		lower: string,
		end: string,
		axis: THREE.Vector3,
		want: THREE.Vector3,
	) {
		let c = this.chains.get(name);
		if (c) return c;
		const u = this.bones[upper];
		const l = this.bones[lower];
		const e = this.bones[end];
		if (!u || !l || !e) return null;
		c = { upper: u, lower: l, end: e, axis, sign: 1 };
		c.sign = hingeSign(c, want);
		this.chains.set(name, c);
		return c;
	}

	/**
	 * Lays moment `s` on the body (after the motion's frame). `me` gives this body's own parts, `you` the other
	 * one's; `dt` eases the straining.
	 */
	apply(s: BodySample, me: BodyParts, you: BodyParts | null, dt: number): BodyResult {
		const root = this.bones.hips;
		const result: BodyResult = { look: null, smile: s.smile, short: { right: 0, left: 0 } };
		if (!root) return result;
		root.parent?.updateWorldMatrix(true, true);
		const { right, up, front } = me.frame();
		const spotOf = (spot: BodySpot) => (spot.of === "you" ? you : me)?.spot(spot.part, spot.off) ?? null;

		// straining towards a hand that stays short: up on the toes for something high, then leaning further
		// that way until it gets there; held while the hand stays, eased off once no hand reaches for anything
		const wanted = Math.max(this.short.right, this.short.left);
		if (wanted > 0.005) {
			if (this.strain.towards.y > 0.15)
				this.strain.rise = Math.min(STRAIN_RISE, this.strain.rise + dt * 0.15);
			this.strain.lean = Math.min(STRAIN_LEAN, this.strain.lean + dt * 30);
		} else if (!this.reaching) {
			const k = Math.min(1, dt * 3);
			this.strain.lean -= this.strain.lean * k;
			this.strain.rise -= this.strain.rise * k;
		}

		this.legs(s.height + this.strain.rise, up, front, right);
		// a deep crouch leans forward to keep its balance
		const lean = s.lean + Math.max(0, -s.height) * 40;
		this.lean(lean, up, front);
		if (this.strain.lean > 0.5 && this.strain.towards.lengthSq() > 0) {
			const flat = this.strain.towards.clone().setY(0);
			if (flat.lengthSq() > 1e-4) this.lean(this.strain.lean, up, flat.normalize());
		}

		this.reaching = false;
		for (const side of SIDES) {
			const b = s[side];
			const short = this.arm(side, b, s.t, spotOf, { right, up, front });
			result.short[side] = short;
		}
		this.short = result.short;

		const look = s.look;
		const lookAt = (v: Look) => (v === "ahead" ? null : spotOf(v));
		const la = lookAt(look.a);
		const lb = lookAt(look.b);
		result.look = la && lb ? la.lerp(lb, look.u) : look.u < 0.5 ? la : lb;
		return result;
	}

	/** Spine and chest bend by `degrees` towards `towards` (forward when it is the body's front). */
	private lean(degrees: number, up: THREE.Vector3, towards: THREE.Vector3): void {
		if (Math.abs(degrees) < 0.1) return;
		const axis = new THREE.Vector3().crossVectors(up, towards).normalize();
		const half = q1.setFromAxisAngle(axis, (degrees * THREE.MathUtils.DEG2RAD) / 2).clone();
		for (const name of ["spine", "chest"]) {
			const bone = this.keep(this.bones[name]);
			if (bone) turnInWorld(bone, half);
		}
	}

	/** The hips `height` m up (down: a crouch, the feet staying put; up: on tiptoe). */
	private legs(height: number, up: THREE.Vector3, front: THREE.Vector3, right: THREE.Vector3): void {
		if (Math.abs(height) < 0.003) return;
		const hips = this.bones.hips as THREE.Object3D;
		const feet = SIDES.map((side) => {
			const foot = this.bones[`${side}Foot`];
			return foot ? { side, foot, at: worldPos(foot), q: worldQuat(foot) } : null;
		});
		this.hipsSaved = hips.position.clone();
		const parent = hips.parent as THREE.Object3D;
		const there = worldPos(hips).addScaledVector(up, height);
		hips.position.copy(parent.worldToLocal(there));
		hips.updateWorldMatrix(false, true);
		const back = front.clone().negate();
		for (const f of feet) {
			if (!f) continue;
			const outward = right.clone().multiplyScalar(f.side === "right" ? 1 : -1);
			const c = this.chain(
				`${f.side}Leg`,
				`${f.side}UpperLeg`,
				`${f.side}LowerLeg`,
				`${f.side}Foot`,
				new THREE.Vector3(1, 0, 0),
				back,
			);
			if (!c) continue;
			this.keep(c.upper);
			this.keep(c.lower);
			this.keep(f.foot);
			// on tiptoe the heels come up with the hips, the toes stay
			const ankle = height > 0 ? f.at.clone().addScaledVector(up, height) : f.at;
			solveChain(c, ankle, front.clone().addScaledVector(outward, 0.1));
			// the foot keeps its way in the world (flat on the ground), pitched down on tiptoe
			const lower = worldQuat(c.lower).invert();
			let q = f.q.clone();
			if (height > 0) {
				const pitch = Math.asin(Math.min(0.9, height / (0.14 * this.scale)));
				// about the body's left: the toes go down
				q = q1.setFromAxisAngle(right.clone().negate(), pitch).clone().multiply(q);
			}
			f.foot.quaternion.copy(lower.multiply(q));
			f.foot.updateWorldMatrix(false, true);
		}
	}

	/** One arm towards where the script has its hand now; returns how far short it stays (m). */
	private arm(
		side: "right" | "left",
		b: Between<Hand>,
		t: number,
		spotOf: (s: BodySpot) => THREE.Vector3 | null,
		f: { right: THREE.Vector3; up: THREE.Vector3; front: THREE.Vector3 },
	): number {
		const weight = (h: Hand) => (h === "rest" ? 0 : 1);
		const w = weight(b.a) + (weight(b.b) - weight(b.a)) * b.u;
		if (w < 1e-3) return 0;
		this.reaching = true;
		const pa = b.a === "rest" ? null : spotOf(b.a);
		const pb = b.b === "rest" ? null : spotOf(b.b);
		const at = pa && pb ? pa.lerp(pb, b.u) : (pb ?? pa);
		if (!at) return 0;
		const hand = (b.b !== "rest" ? b.b : b.a) as BodyHand;
		const outward = f.right.clone().multiplyScalar(side === "right" ? 1 : -1);
		if (hand.wiggle) {
			const dir = hand.wiggle.dir === "side" ? f.right : hand.wiggle.dir === "up" ? f.up : f.front;
			at.addScaledVector(dir, hand.wiggle.size * Math.sin(t * hand.wiggle.hz * Math.PI * 2));
		}
		const c = this.chain(
			`${side}Arm`,
			`${side}UpperArm`,
			`${side}LowerArm`,
			`${side}Hand`,
			new THREE.Vector3(0, 1, 0),
			f.front,
		);
		if (!c) return 0;
		const before = [c.upper, c.lower, c.end].map((bone) =>
			(this.keep(bone) as THREE.Object3D).quaternion.clone(),
		);
		const shoulder = worldPos(c.upper);
		this.strain.towards.copy(at).sub(shoulder);
		// the palm's middle reaches the spot: the wrist stays a hand's length short of it, on the way from the shoulder
		const palm = palmDirection(hand, f, side);
		const along = at.clone().sub(shoulder);
		if (palm) along.addScaledVector(palm, -along.dot(palm));
		along.normalize();
		const wrist = at.clone().addScaledVector(along, -0.07 * this.scale);
		if (palm) wrist.addScaledVector(palm, -0.025 * this.scale);
		// the elbow hangs down and a little out and back
		const pole = f.up.clone().negate().addScaledVector(outward, 0.6).addScaledVector(f.front, -0.3);
		let short = solveChain(c, wrist, pole);
		if (palm) this.turnHand(c, side, palm, along);
		// where the palm's middle came to, against where it should be: aim again, off by as much the other way
		const landed = palmCentre(this.bones, side, this.scale);
		if (landed && short === 0) {
			const target = palm ? at.clone().addScaledVector(palm, -0.015 * this.scale) : at;
			short = solveChain(c, wrist.add(target.sub(landed)), pole);
			if (palm) this.turnHand(c, side, palm, along);
		}
		// weighed against the motion's own pose (a hand going to or coming back from rest)
		const ik = [c.upper, c.lower, c.end].map((bone) => bone.quaternion.clone());
		[c.upper, c.lower, c.end].forEach((bone, i) => {
			bone.quaternion.slerpQuaternions(before[i] as THREE.Quaternion, ik[i] as THREE.Quaternion, w);
		});
		c.upper.updateWorldMatrix(false, true);
		return short * w;
	}

	/** The hand turned so its palm faces `palm` (world), fingers pointing `fingers`, with the least wrist bend. */
	private turnHand(c: Chain, side: "right" | "left", palm: THREE.Vector3, fingers: THREE.Vector3): void {
		const finger = this.bones[`${side}MiddleProximal`];
		// in the hand's own (rest) frame: fingers along the bone, the palm facing down as in a T-pose
		const fingersLocal = finger
			? finger.position.clone().normalize()
			: v2.set(side === "right" ? -1 : 1, 0, 0);
		const palmLocal = new THREE.Vector3(0, -1, 0);
		const local = basis(fingersLocal, palmLocal);
		const forearm = worldPos(c.end).sub(worldPos(c.lower)).normalize();
		const toward = fingers.clone().lerp(forearm, 0.5).normalize();
		const world = basis(toward, palm).multiply(local.invert());
		c.end.quaternion.copy(worldQuat(c.lower).invert().multiply(world));
		c.end.updateWorldMatrix(false, true);
	}
}

/** Which way a hand's palm should face (world), or null to leave the wrist as the motion has it. */
function palmDirection(
	hand: BodyHand,
	f: { right: THREE.Vector3; up: THREE.Vector3; front: THREE.Vector3 },
	side: "right" | "left",
): THREE.Vector3 | null {
	switch (hand.palm) {
		case "down":
			return f.up.clone().negate();
		case "up":
			return f.up.clone();
		case "forward":
			return f.front.clone();
		case "in":
			return f.right.clone().multiplyScalar(side === "right" ? -1 : 1);
		default:
			// a head is patted from above
			return hand.of === "you" && hand.part === "head" ? f.up.clone().negate() : null;
	}
}

/** Unit vectors of a body facing `heading` (radians; 0 is +Z, its right hand on -X). */
export function frameOf(heading: number): { right: THREE.Vector3; up: THREE.Vector3; front: THREE.Vector3 } {
	return {
		right: new THREE.Vector3(-Math.cos(heading), 0, Math.sin(heading)),
		up: UP.clone(),
		front: new THREE.Vector3(Math.sin(heading), 0, Math.cos(heading)),
	};
}

/**
 * Where the parts of a humanoid are (world), from its bones: `headTop` is how far the top of the head is
 * above the head bone, `scale` its size over the reference rig. Offsets are in the body's frame.
 */
export function spotOn(
	bones: Bones,
	heading: number,
	headTop: number,
	scale: number,
	part: BodyPart,
	off?: [number, number, number],
): THREE.Vector3 | null {
	const { right, up, front } = frameOf(heading);
	const at = (name: string) => {
		const b = bones[name];
		return b ? worldPos(b) : null;
	};
	const s = scale;
	const head = at("head");
	const chest = at("upperChest") ?? at("chest") ?? at("spine");
	let p: THREE.Vector3 | null = null;
	const sideOf = (name: string) => (name.endsWith("_l") ? "left" : "right");
	const outward = (name: string) => right.clone().multiplyScalar(name.endsWith("_l") ? -1 : 1);
	switch (part) {
		case "head":
			p = head?.addScaledVector(up, headTop).addScaledVector(front, 0.01 * s) ?? null;
			break;
		case "face":
			p = head?.addScaledVector(up, 0.06 * s).addScaledVector(front, 0.1 * s) ?? null;
			break;
		case "mouth":
			p = head?.addScaledVector(front, 0.1 * s) ?? null;
			break;
		case "chin":
			p = head?.addScaledVector(up, -0.035 * s).addScaledVector(front, 0.08 * s) ?? null;
			break;
		case "cheek_l":
		case "cheek_r":
			p =
				head
					?.addScaledVector(up, 0.025 * s)
					.addScaledVector(front, 0.075 * s)
					.addScaledVector(outward(part), 0.06 * s) ?? null;
			break;
		case "chest":
			p = chest?.addScaledVector(up, 0.1 * s).addScaledVector(front, 0.13 * s) ?? null;
			break;
		case "back":
			p = chest?.addScaledVector(up, 0.1 * s).addScaledVector(front, -0.12 * s) ?? null;
			break;
		case "front":
			p = chest?.addScaledVector(up, 0.05 * s).addScaledVector(front, 0.35 * s) ?? null;
			break;
		case "shoulder_l":
		case "shoulder_r":
			p = at(`${sideOf(part)}UpperArm`)?.addScaledVector(up, 0.06 * s) ?? null;
			break;
		case "arm_l":
		case "arm_r": {
			const a = at(`${sideOf(part)}UpperArm`);
			const b = at(`${sideOf(part)}LowerArm`);
			p = a && b ? a.lerp(b, 0.5).addScaledVector(outward(part), 0.04 * s) : null;
			break;
		}
		case "hand_l":
		case "hand_r":
			p = palmCentre(bones, sideOf(part), s);
			break;
	}
	if (p && off) p.addScaledVector(right, off[0]).addScaledVector(up, off[1]).addScaledVector(front, off[2]);
	return p;
}

/**
 * The middle of a palm (world): halfway from the wrist to the middle finger's knuckle, or, without finger
 * bones, a little past the wrist along the forearm.
 */
export function palmCentre(bones: Bones, side: "left" | "right", scale = 1): THREE.Vector3 | null {
	const hand = bones[`${side}Hand`];
	if (!hand) return null;
	const wrist = worldPos(hand);
	const knuckle = bones[`${side}MiddleProximal`];
	if (knuckle) return wrist.lerp(worldPos(knuckle), 0.5);
	const elbow = bones[`${side}LowerArm`];
	return elbow
		? wrist.clone().addScaledVector(wrist.clone().sub(worldPos(elbow)).normalize(), 0.05 * scale)
		: wrist;
}

/** Parts of a body without bones (a capsule, Saki): about where they would be on someone 1.6 m tall. */
const ROUGH: Record<BodyPart, [right: number, up: number, front: number]> = {
	head: [0, 1.62, 0],
	face: [0, 1.5, 0.1],
	mouth: [0, 1.44, 0.1],
	chin: [0, 1.4, 0.08],
	cheek_l: [-0.06, 1.47, 0.08],
	cheek_r: [0.06, 1.47, 0.08],
	chest: [0, 1.22, 0.13],
	back: [0, 1.22, -0.12],
	front: [0, 1.15, 0.35],
	shoulder_l: [-0.18, 1.38, 0],
	shoulder_r: [0.18, 1.38, 0],
	arm_l: [-0.24, 1.18, 0],
	arm_r: [0.24, 1.18, 0],
	hand_l: [-0.26, 0.8, 0.05],
	hand_r: [0.26, 0.8, 0.05],
};

export function roughSpot(
	root: THREE.Vector3,
	heading: number,
	part: BodyPart,
	off?: [number, number, number],
): THREE.Vector3 {
	const { right, up, front } = frameOf(heading);
	const [r, u, f] = ROUGH[part];
	const p = root.clone().addScaledVector(right, r).addScaledVector(up, u).addScaledVector(front, f);
	if (off) p.addScaledVector(right, off[0]).addScaledVector(up, off[1]).addScaledVector(front, off[2]);
	return p;
}
