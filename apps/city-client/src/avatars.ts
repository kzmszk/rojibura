// Avatars in the scene: model (shared glTF, cloned; or a VRM per avatar), animation, name label, chat bubble,
// and pose from the host's move state (docs/prd.md 3.4, フロー④).

import { type VRM, type VRMHumanBoneName, VRMLoaderPlugin, VRMUtils } from "@pixiv/three-vrm";
import {
	type AvatarState,
	isPosture,
	type Motion,
	type MoveState,
	poseAt,
	type Status,
} from "@rojibura/protocol";
import * as THREE from "three";
import { GLTFLoader, type GLTFParser } from "three/examples/jsm/loaders/GLTFLoader.js";
import { CSS2DObject } from "three/examples/jsm/renderers/CSS2DRenderer.js";
import { clone as cloneSkinned } from "three/examples/jsm/utils/SkeletonUtils.js";
import { groundSpeed, legLength, MOVES, type MoveName, REFERENCE_LEG, referenceRig } from "./moves.ts";
import { retarget } from "./retarget.ts";
import type { CityScene } from "./scene.ts";

/** The city's motions on one skeleton, and how fast walk and run cover the ground at normal speed. */
interface Motions {
	clips: THREE.AnimationClip[];
	pace: Partial<Record<MoveName, number>>;
}

interface Template {
	scene: THREE.Object3D;
	clips: THREE.AnimationClip[];
	/** Lifts the model so its feet are at y = 0. */
	footOffset: number;
}

const BUBBLE_MS = 7000;
/** Small things done while standing about (moves.ts), one at random now and then. */
const FIDGETS: MoveName[] = ["look", "tilt", "shift", "hands", "stretch"];
/** Motions that come with a smile. */
const SMILING = new Set<string>(["tilt", "wave", "jump", "handshake", "hug"]);
const FADE = 0.3;
const RAD = Math.PI / 180;

const PLAY = new Map(MOVES.map((m) => [m.name as string, m.play]));
/** Motions that move the avatar along its heading (metres), see MOVES. */
export const TRAVEL = new Map(
	MOVES.filter((m) => m.travel).map((m) => [m.name as string, m.travel as number]),
);
let city: { clips: THREE.AnimationClip[]; pace: Record<"walk" | "run", number> } | null = null;

/** The city's motions on the reference rig (made once). */
function cityMoves() {
	if (!city) {
		const clips = MOVES.map((m) => m.clip());
		const of = (name: MoveName) => clips.find((c) => c.name === name) as THREE.AnimationClip;
		city = { clips, pace: { walk: groundSpeed(of("walk")), run: groundSpeed(of("run")) } };
	}
	return city;
}

/** The city's motions retargeted to a VRM's normalized bones at rest (humanoid bone name -> node). */
function motionsFor(bones: Record<string, THREE.Object3D>): Motions {
	const { clips, pace } = cityMoves();
	const rig = referenceRig();
	const legs = legLength(bones) / REFERENCE_LEG;
	return {
		clips: clips.map((c) => retarget(rig, c, bones)),
		pace: { walk: pace.walk * legs, run: pace.run * legs },
	};
}

class ModelCache {
	private readonly loading = new Map<string, Promise<Template | null>>();

	get(url: string): Promise<Template | null> {
		let p = this.loading.get(url);
		if (!p) {
			p = new GLTFLoader()
				.loadAsync(url)
				.then((g) => {
					const box = new THREE.Box3().setFromObject(g.scene);
					return { scene: g.scene, clips: g.animations, footOffset: -box.min.y };
				})
				.catch(() => null);
			this.loading.set(url, p);
		}
		return p;
	}
}

const models = new ModelCache();

/**
 * Makes every VRM parsed from the same file share its textures: one decode and one GPU copy however many
 * people wear it. GLTFLoader caches dependencies for one parse; this keeps textures for the file.
 */
function shareTextures(parser: GLTFParser, textures: Map<number, Promise<unknown>>) {
	const load = parser.getDependency.bind(parser);
	parser.getDependency = (type: string, index: number) => {
		if (type !== "texture") return load(type, index);
		let t = textures.get(index);
		if (!t) {
			t = load(type, index);
			textures.set(index, t);
		}
		return t;
	};
	return { name: "RJ_shared_textures" };
}

interface VrmFile {
	data: ArrayBuffer;
	textures: Map<number, Promise<unknown>>;
	/** The motions on this file's bones, made from the first VRM parsed (at rest). */
	moves: Motions | null;
}

/**
 * VRMs cannot be cloned like plain glTF (spring bones, expressions and the humanoid rig point at their own
 * nodes), so each avatar parses its own copy from the downloaded bytes. Textures are shared between them.
 */
class VrmCache {
	private readonly files = new Map<string, Promise<VrmFile | null>>();

	async get(url: string): Promise<{ vrm: VRM; moves: Motions } | null> {
		let p = this.files.get(url);
		if (!p) {
			p = fetch(url)
				.then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`${r.status}`))))
				.then((data) => ({ data, textures: new Map(), moves: null }))
				.catch(() => null);
			this.files.set(url, p);
		}
		const file = await p;
		if (!file) return null;
		const loader = new GLTFLoader();
		loader.register((parser) => new VRMLoaderPlugin(parser));
		loader.register((parser) => shareTextures(parser, file.textures));
		const gltf = await loader.parseAsync(file.data, url.slice(0, url.lastIndexOf("/") + 1)).catch(() => null);
		const vrm = gltf?.userData.vrm as VRM | undefined;
		if (!gltf || !vrm) return null;
		VRMUtils.removeUnnecessaryVertices(gltf.scene);
		VRMUtils.combineSkeletons(gltf.scene);
		// a VRM 0.x faces -Z; turned, it faces +Z like a VRM 1.0 and the city's motions
		VRMUtils.rotateVRM0(vrm);
		if (!file.moves) {
			vrm.scene.updateMatrixWorld(true);
			const bones: Record<string, THREE.Object3D> = {};
			for (const name of Object.keys(vrm.humanoid.humanBones)) {
				const node = vrm.humanoid.getNormalizedBoneNode(name as VRMHumanBoneName);
				if (node) bones[name] = node;
			}
			file.moves = motionsFor(bones);
		}
		return { vrm, moves: file.moves };
	}
}

const vrms = new VrmCache();

/**
 * Relaxed hands: a VRM's rest flat, fingers fanned out and the thumb sticking out, which looks stiff (the
 * fingers are not animated). Each finger: curl at its three joints (more towards the little finger) and how
 * far it turns at the knuckle to lie against its neighbours. The thumb comes in along the index finger.
 * Degrees for the right hand; the left is mirrored. A VRM 0.x's normalized bones keep its own frame, which
 * faces -Z (VRMUtils.rotateVRM0 turns the scene, not the bones), so turns about X and Z go the other way.
 */
const FINGERS: [finger: string, curl: [number, number, number], together: number][] = [
	["Index", [22, 32, 18], -12],
	["Middle", [28, 38, 20], -4],
	["Ring", [34, 42, 22], 6],
	["Little", [40, 44, 22], 14],
];

function relaxFingers(vrm: VRM): void {
	const bone = (name: string) => vrm.humanoid.getNormalizedBoneNode(name as VRMHumanBoneName);
	const v0 = vrm.meta.metaVersion === "0" ? -1 : 1;
	for (const [side, s] of [
		["left", -1],
		["right", 1],
	] as const) {
		const z = s * v0 * RAD;
		for (const [finger, [a, b, c], together] of FINGERS) {
			bone(`${side}${finger}Proximal`)?.rotation.set(0, s * together * RAD, a * z);
			bone(`${side}${finger}Intermediate`)?.rotation.set(0, 0, b * z);
			bone(`${side}${finger}Distal`)?.rotation.set(0, 0, c * z);
		}
		bone(`${side}ThumbMetacarpal`)?.rotation.set(0, s * -35 * RAD, 25 * z);
		bone(`${side}ThumbProximal`)?.rotation.set(0, s * -10 * RAD, 20 * z);
		bone(`${side}ThumbDistal`)?.rotation.set(0, 0, 25 * z);
	}
}

function capsule(color: number): THREE.Object3D {
	const g = new THREE.Group();
	const body = new THREE.Mesh(
		new THREE.CapsuleGeometry(0.3, 1.0, 6, 12),
		new THREE.MeshStandardMaterial({ color, roughness: 0.6 }),
	);
	body.position.y = 0.8;
	body.castShadow = true;
	const nose = new THREE.Mesh(
		new THREE.SphereGeometry(0.08),
		new THREE.MeshStandardMaterial({ color: 0x222222 }),
	);
	nose.position.set(0, 1.35, 0.28);
	g.add(body, nose);
	return g;
}

export class AvatarView {
	readonly root = new THREE.Group();
	state: AvatarState;
	private model: THREE.Object3D;
	private vrm: VRM | null = null;
	/** Spring bones settle once the avatar is where it belongs (not swinging in from the origin). */
	private settled = false;
	private nextBlink = 0;
	private talkUntil = 0;
	/** The next fidget while standing about (host time; 0 until the first update). */
	private nextFidget = 0;
	/** A smile (the "relaxed" expression): how much now, how much wanted until when, and the next one. */
	private smile = 0;
	private smileWant = 0;
	private smileUntil = 0;
	private nextSmile = 0;
	private disposed = false;
	private mixer: THREE.AnimationMixer | null = null;
	private actions: Record<string, THREE.AnimationAction> = {};
	private pace: Motions["pace"] = {};
	private current = "";
	/** A gesture playing once, until this host time. */
	private gesture: { name: string; until: number } | null = null;
	/** The next play starts over even if it is the motion already playing (the same gesture again). */
	private replay = false;
	/** Something done together that starts at a host time, once both have walked to their places. */
	private pending: { name: string; at: number } | null = null;
	/** Heading to turn to while standing (towards whom a gesture is for). */
	private faceTo: number | null = null;
	private readonly label: HTMLDivElement;
	private readonly bubble: HTMLDivElement;
	private readonly tag: CSS2DObject;
	/** Seen from its own eyes (the first-person view): the head is not drawn, nor the name over it. */
	private inside = false;
	private firstPersonReady = false;
	private bubbleUntil = 0;
	/** Smoothed height so stairs do not jitter. */
	private y = 0;
	private facing = 0;
	private readonly isMe: boolean;

	constructor(state: AvatarState, isMe: boolean) {
		this.state = state;
		this.isMe = isMe;
		this.model = capsule(state.kind === "ai" ? 0x6aa7d8 : isMe ? 0xe3a14f : 0xd9d2c5);
		this.root.add(this.model);
		this.root.userData.avatarId = state.id;

		const tag = document.createElement("div");
		tag.className = "rj-tag";
		this.label = document.createElement("div");
		this.label.className = "rj-name";
		this.bubble = document.createElement("div");
		this.bubble.className = "rj-bubble";
		tag.append(this.bubble, this.label);
		const obj = new CSS2DObject(tag);
		obj.position.set(0, 2.05, 0);
		this.root.add(obj);
		this.tag = obj;
		this.updateLabel();

		const url = state.assets.lod || state.assets.vrm;
		if (url)
			void (/\.vrm$/i.test(new URL(url, location.href).pathname) ? this.loadVrm(url) : this.loadModel(url));
	}

	private async loadVrm(url: string): Promise<void> {
		const loaded = await vrms.get(url);
		if (!loaded) return;
		const { vrm, moves } = loaded;
		if (this.disposed) {
			disposeVrm(vrm);
			return;
		}
		vrm.scene.traverse((o) => {
			if (!(o as THREE.Mesh).isMesh) return;
			o.castShadow = true;
			// spring bones and expressions move vertices outside the bind-pose bounds
			o.frustumCulled = false;
		});
		relaxFingers(vrm);
		this.root.remove(this.model);
		this.model = vrm.scene;
		this.root.add(vrm.scene);
		this.vrm = vrm;
		this.seenFromInside(this.inside);
		this.setClips(new THREE.AnimationMixer(vrm.scene), moves.clips);
		this.pace = moves.pace;
	}

	private async loadModel(url: string): Promise<void> {
		const t = await models.get(url);
		if (!t || this.disposed) return;
		const m = cloneSkinned(t.scene);
		m.traverse((o) => {
			if ((o as THREE.Mesh).isMesh) o.castShadow = true;
		});
		m.position.y = t.footOffset;
		// models face -Z (glTF export of a +Y facing Blender model); headings below assume +Z
		m.rotation.y = Math.PI;
		const holder = new THREE.Group();
		holder.add(m);
		this.root.remove(this.model);
		this.model = holder;
		this.root.add(holder);
		// glTF avatars (Saki) play their own clips; the city's motions are for VRMs
		this.setClips(new THREE.AnimationMixer(m), t.clips);
	}

	private setClips(mixer: THREE.AnimationMixer, clips: THREE.AnimationClip[]): void {
		this.mixer = mixer;
		for (const clip of clips) {
			const action = mixer.clipAction(clip);
			if ((PLAY.get(clip.name) ?? "loop") !== "loop") {
				action.setLoop(THREE.LoopOnce, 1);
				action.clampWhenFinished = true;
			}
			this.actions[clip.name] = action;
		}
		this.current = "";
	}

	setMove(move: MoveState): void {
		this.state.move = move;
	}

	setStatus(status: Status): void {
		this.state.status = status;
		this.updateLabel();
	}

	say(text: string, now: number): void {
		this.bubble.textContent = text;
		this.bubble.classList.add("show");
		this.bubbleUntil = now + BUBBLE_MS;
		// the mouth moves for about as long as the line takes to say
		this.talkUntil = now + Math.min(4000, 400 + [...text].length * 90);
	}

	/**
	 * Shows a motion with the body (docs/prd.md 3.4.5), turned towards `towards` if given. Postures (sit, lie)
	 * come with the move state and last; gestures play once while standing, and the ones that travel (rolls)
	 * while the avatar moves along the path sent with them. Returns false when the avatar cannot show it (no
	 * such motion, or walking), so the caller can show it some other way.
	 */
	act(motion: Motion, hostNow: number, towards?: THREE.Vector3): boolean {
		const action = this.actions[motion];
		if (!action || (!TRAVEL.has(motion) && poseAt(this.state.move, hostNow).moving)) return false;
		if (towards) {
			const p = this.root.position;
			if (Math.hypot(towards.x - p.x, towards.z - p.z) > 0.3)
				this.faceTo = Math.atan2(towards.x - p.x, towards.z - p.z);
		}
		if (isPosture(motion)) return true;
		return this.perform(motion, hostNow);
	}

	/** Plays one of the city's motions once from now (picking up, throwing); false if the model has none. */
	perform(name: MoveName, hostNow: number, towards?: THREE.Vector3): boolean {
		const action = this.actions[name];
		if (!action) return false;
		if (towards) {
			const p = this.root.position;
			if (Math.hypot(towards.x - p.x, towards.z - p.z) > 0.2)
				this.faceTo = Math.atan2(towards.x - p.x, towards.z - p.z);
		}
		this.gesture = { name, until: hostNow + action.getClip().duration * 1000 };
		if (SMILING.has(name)) this.smileFor(this.gesture.until, 0.6);
		this.replay = true;
		return true;
	}

	/**
	 * Something done together (docs/prd.md 3.4.6): faces the other one at `towards` and starts at host time
	 * `at`, when both have walked to their places. False if the model cannot show it.
	 */
	together(name: MoveName, towards: THREE.Vector3, at: number): boolean {
		if (!this.actions[name]) return false;
		const p = this.root.position;
		this.faceTo = Math.atan2(towards.x - p.x, towards.z - p.z);
		this.pending = { name, at };
		return true;
	}

	/** Where the right hand is (world), for what it holds: a VRM's hand bone, or about there on others. */
	handPosition(): THREE.Vector3 {
		const hand = this.vrm?.humanoid.getRawBoneNode("rightHand");
		if (hand) return hand.localToWorld(new THREE.Vector3(-0.07, -0.02, 0.03));
		const side = new THREE.Vector3(-0.28, 0.95, 0.1).applyAxisAngle(new THREE.Vector3(0, 1, 0), this.facing);
		return side.add(this.root.position);
	}

	/** Blinks now and then, and moves the mouth while talking (VRM expressions). */
	private smileFor(until: number, how: number): void {
		this.smileUntil = Math.max(this.smileUntil, until);
		this.smileWant = Math.max(this.smileWant, how);
	}

	/**
	 * Blinks now and then, smiles now and then (and with friendly motions), and moves the mouth while talking
	 * (VRM expressions). The smile is "relaxed": a closed-mouth smile ("happy" opens the mouth wide).
	 */
	private express(hostNow: number, dt: number): void {
		const expressions = this.vrm?.expressionManager;
		if (!expressions) return;
		if (this.nextSmile === 0) this.nextSmile = hostNow + 4000 + Math.random() * 10_000;
		if (hostNow > this.nextSmile) {
			this.smileFor(hostNow + 1500 + Math.random() * 3000, 0.45 + Math.random() * 0.3);
			this.nextSmile = this.smileUntil + 6000 + Math.random() * 14_000;
		}
		if (hostNow > this.smileUntil) this.smileWant = 0;
		this.smile += (this.smileWant - this.smile) * Math.min(1, dt * 4);
		expressions.setValue("relaxed", this.smile);
		if (hostNow > this.nextBlink + 150) this.nextBlink = hostNow + 2000 + Math.random() * 4000;
		// smiling eyes are already half closed: a full blink on top looks odd
		const blink = Math.max(0, 1 - Math.abs(hostNow - this.nextBlink - 75) / 75) * (1 - this.smile);
		expressions.setValue("blink", blink);
		const talking = hostNow < this.talkUntil;
		expressions.setValue("aa", talking ? 0.25 + 0.35 * Math.abs(Math.sin(hostNow / 70)) : 0);
	}

	/**
	 * Standing about: a fidget now and then (looking round, a head tilt, the weight on one leg, the hands
	 * together, a stretch), each picked at random, so nobody stands frozen. Not while moving, sitting or
	 * doing something else; each avatar fidgets on its own clock (nothing goes to the host).
	 */
	private fidget(hostNow: number, busy: boolean): void {
		if (this.nextFidget === 0) this.nextFidget = hostNow + 2000 + Math.random() * 6000;
		const fidgeting = this.gesture !== null && FIDGETS.includes(this.gesture.name as MoveName);
		if (busy) {
			if (!fidgeting) this.nextFidget = Math.max(this.nextFidget, hostNow + 3000 + Math.random() * 5000);
			return;
		}
		if (hostNow < this.nextFidget) return;
		const can = FIDGETS.filter((f) => this.actions[f]);
		const pick = can[Math.floor(Math.random() * can.length)];
		if (pick) this.perform(pick, hostNow);
		this.nextFidget = hostNow + (this.durationOf(pick ?? "") ?? 0) * 1000 + 3000 + Math.random() * 8000;
	}

	private updateLabel(): void {
		const s = this.state;
		const suffix = s.kind === "ai" ? (s.status === "resting" ? " 💤" : " · AI") : "";
		this.label.textContent = `${s.name}${suffix}`;
		this.label.classList.toggle("me", this.isMe);
		this.label.classList.toggle("ai", s.kind === "ai");
		this.label.title = s.owner ? `オーナー: ${s.owner}` : "";
	}

	private turnTo(heading: number, rate: number): void {
		const diff = Math.atan2(Math.sin(heading - this.facing), Math.cos(heading - this.facing));
		this.facing += diff * Math.min(1, rate);
	}

	update(hostNow: number, dt: number, scene: CityScene): void {
		const move = this.state.move;
		const pose = poseAt(move, hostNow);
		const ground = scene.heightAt(pose.pos[0], pose.pos[1]);
		if (ground !== null)
			this.y = Math.abs(ground - this.y) > 2 ? ground : this.y + (ground - this.y) * Math.min(1, dt * 12);
		this.root.position.set(pose.pos[0], this.y, pose.pos[1]);
		// a roll travels along its path without turning to it (a back roll goes backwards)
		const rolling = this.gesture !== null && TRAVEL.has(this.gesture.name) && hostNow < this.gesture.until;
		if (pose.moving && !rolling) {
			this.gesture = null;
			this.faceTo = null;
			this.turnTo(Math.atan2(pose.dir[0], pose.dir[1]), dt * 10);
		} else if (this.faceTo !== null) {
			this.turnTo(this.faceTo, dt * 6);
		}
		this.root.rotation.y = this.facing;

		const posture0 = move.kind === "idle" ? move.posture : undefined;
		this.fidget(
			hostNow,
			pose.moving ||
				posture0 !== undefined ||
				this.pending !== null ||
				(this.gesture !== null && hostNow < this.gesture.until),
		);
		if (this.pending && hostNow >= this.pending.at && !pose.moving) {
			this.perform(this.pending.name as MoveName, hostNow);
			this.pending = null;
		}
		const speed = move.kind === "idle" ? 0 : move.speed;
		const posture = move.kind === "idle" ? move.posture : undefined;
		let want = "stand";
		if (rolling && this.gesture) want = this.gesture.name;
		else if (pose.moving) want = speed > 2.5 && this.actions.run ? "run" : "walk";
		else if (this.gesture && hostNow < this.gesture.until) want = this.gesture.name;
		else if (posture && this.actions[posture]) want = posture;
		// a posture that began before this avatar was drawn (someone who came later) shows as it is now
		const settled =
			posture === want && hostNow - move.at > (this.actions[want]?.getClip().duration ?? 0) * 1000;
		this.play(want, settled);
		// walk and run keep pace with the ground, so the feet do not slide
		const pace = this.pace[want as MoveName];
		const action = this.actions[want];
		if (pace && action && speed > 0) action.timeScale = Math.min(2.5, Math.max(0.4, speed / pace));

		this.mixer?.update(dt);
		if (this.vrm) {
			this.express(hostNow, dt);
			if (!this.settled) {
				this.root.updateMatrixWorld(true);
				this.vrm.springBoneManager?.reset();
				this.settled = true;
			}
			this.vrm.update(dt);
		}
		const thinking = this.state.status === "busy" && this.state.kind === "ai";
		if (thinking && !this.bubble.classList.contains("show")) {
			this.bubble.textContent = "…";
			this.bubble.classList.add("show", "thinking");
			this.bubbleUntil = Number.POSITIVE_INFINITY;
		} else if (!thinking && this.bubble.classList.contains("thinking")) {
			this.bubble.classList.remove("show", "thinking");
		}
		if (hostNow > this.bubbleUntil) this.bubble.classList.remove("show");
	}

	/**
	 * Seen from its own eyes or not (docs/prd.md 3.4.8). A VRM hides its head with three-vrm's first-person
	 * layers (the camera picks the layer); other models hide altogether.
	 */
	seenFromInside(on: boolean): void {
		this.inside = on;
		this.tag.visible = !on;
		if (this.vrm) {
			if (!this.firstPersonReady) {
				this.vrm.firstPerson?.setup();
				this.firstPersonReady = true;
			}
			this.model.visible = true;
		} else {
			this.model.visible = !on;
		}
	}

	/** Where the eyes are (world), for the first-person view. */
	eyePosition(): THREE.Vector3 {
		const ahead = new THREE.Vector3(Math.sin(this.facing), 0, Math.cos(this.facing));
		const head = this.vrm?.humanoid.getRawBoneNode("head");
		if (head)
			return head
				.getWorldPosition(new THREE.Vector3())
				.add(new THREE.Vector3(0, 0.07, 0))
				.addScaledVector(ahead, 0.09);
		return this.root.position
			.clone()
			.add(new THREE.Vector3(0, 1.55, 0))
			.addScaledVector(ahead, 0.12);
	}

	/** Where the avatar faces (radians; 0 is +Z). */
	get heading(): number {
		return this.facing;
	}

	/** How long a motion takes (seconds), once the model has loaded it. */
	durationOf(motion: string): number | null {
		return this.actions[motion]?.getClip().duration ?? null;
	}

	/** For debugging in the browser console. */
	get debug(): { clips: string[]; playing: string } {
		return { clips: Object.keys(this.actions), playing: this.current };
	}

	private play(name: string, settled = false): void {
		if (name === this.current && !this.replay) return;
		this.replay = false;
		const next = this.actions[name] ?? this.actions.stand ?? this.actions.idle;
		if (!next) return;
		const prev = this.current ? this.actions[this.current] : undefined;
		next.reset();
		if (settled) next.time = next.getClip().duration;
		next.fadeIn(FADE).play();
		if (prev !== next) prev?.fadeOut(FADE);
		this.current = name;
	}

	dispose(): void {
		this.disposed = true;
		this.root.removeFromParent();
		this.root.traverse((o) => {
			if (o instanceof CSS2DObject) o.element.remove();
		});
		if (this.vrm) disposeVrm(this.vrm);
	}
}

/** Frees one avatar's geometry and materials. Textures are shared by the file (VrmCache) and stay. */
function disposeVrm(vrm: VRM): void {
	vrm.scene.traverse((o) => {
		const mesh = o as THREE.Mesh;
		if (!mesh.isMesh) return;
		mesh.geometry.dispose();
		for (const m of [mesh.material].flat()) m.dispose();
	});
}
