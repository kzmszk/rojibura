// Avatars in the scene: model (shared glTF, cloned; or a VRM per avatar), animation, name label, chat bubble,
// and pose from the host's move state (docs/prd.md 3.4, フロー④).

import { type VRM, VRMLoaderPlugin, VRMUtils } from "@pixiv/three-vrm";
import { type AvatarState, type MoveState, poseAt, type Status } from "@rojibura/protocol";
import * as THREE from "three";
import { GLTFLoader, type GLTFParser } from "three/examples/jsm/loaders/GLTFLoader.js";
import { CSS2DObject } from "three/examples/jsm/renderers/CSS2DRenderer.js";
import { clone as cloneSkinned } from "three/examples/jsm/utils/SkeletonUtils.js";
import { retarget } from "./retarget.ts";
import type { CityScene } from "./scene.ts";

interface Template {
	scene: THREE.Object3D;
	clips: THREE.AnimationClip[];
	/** Lifts the model so its feet are at y = 0. */
	footOffset: number;
}

const BUBBLE_MS = 7000;

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

/** The motions every VRM plays (docs/prd.md 3.4.4): Saki's, on bones named after VRM humanoid bones. */
const MOTIONS_URL = "/avatars/motions.glb";
let motions: Promise<{ scene: THREE.Object3D; clips: THREE.AnimationClip[] } | null> | null = null;

function loadMotions() {
	motions ??= new GLTFLoader()
		.loadAsync(MOTIONS_URL)
		.then((g) => {
			// Saki faces -Z; a VRM faces +Z once VRMUtils.rotateVRM0 has turned it
			const scene = new THREE.Group();
			scene.rotation.y = Math.PI;
			scene.add(g.scene);
			return { scene, clips: g.animations };
		})
		.catch(() => null);
	return motions;
}

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
	clips: Promise<THREE.AnimationClip[]> | null;
}

/**
 * VRMs cannot be cloned like plain glTF (spring bones, expressions and the humanoid rig point at their own
 * nodes), so each avatar parses its own copy from the downloaded bytes. Textures are shared between them.
 */
class VrmCache {
	private readonly files = new Map<string, Promise<VrmFile | null>>();

	async get(url: string): Promise<{ vrm: VRM; clips: THREE.AnimationClip[] } | null> {
		let p = this.files.get(url);
		if (!p) {
			p = fetch(url)
				.then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`${r.status}`))))
				.then((data) => ({ data, textures: new Map(), clips: null }))
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
		VRMUtils.rotateVRM0(vrm);
		file.clips ??= loadMotions().then((m) => {
			if (!m) return [];
			vrm.scene.updateMatrixWorld(true);
			const bones: Record<string, THREE.Object3D> = {};
			for (const name of Object.keys(vrm.humanoid.humanBones)) {
				const node = vrm.humanoid.getNormalizedBoneNode(name as keyof typeof vrm.humanoid.humanBones);
				if (node) bones[name] = node;
			}
			return m.clips.map((clip) => retarget(m.scene, clip, bones));
		});
		return { vrm, clips: await file.clips };
	}
}

const vrms = new VrmCache();

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
	private disposed = false;
	private mixer: THREE.AnimationMixer | null = null;
	private actions: Record<string, THREE.AnimationAction> = {};
	private current = "";
	private readonly label: HTMLDivElement;
	private readonly bubble: HTMLDivElement;
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
		this.updateLabel();

		const url = state.assets.lod || state.assets.vrm;
		if (url)
			void (/\.vrm$/i.test(new URL(url, location.href).pathname) ? this.loadVrm(url) : this.loadModel(url));
	}

	private async loadVrm(url: string): Promise<void> {
		const loaded = await vrms.get(url);
		if (!loaded) return;
		const { vrm, clips } = loaded;
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
		this.root.remove(this.model);
		this.model = vrm.scene;
		this.root.add(vrm.scene);
		this.vrm = vrm;
		this.mixer = new THREE.AnimationMixer(vrm.scene);
		for (const clip of clips) this.actions[clip.name] = this.mixer.clipAction(clip);
		this.current = "";
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
		this.mixer = new THREE.AnimationMixer(m);
		for (const clip of t.clips) this.actions[clip.name] = this.mixer.clipAction(clip);
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

	/** Blinks now and then, and moves the mouth while talking (VRM expressions). */
	private express(hostNow: number): void {
		const expressions = this.vrm?.expressionManager;
		if (!expressions) return;
		if (hostNow > this.nextBlink + 150) this.nextBlink = hostNow + 2000 + Math.random() * 4000;
		const blink = Math.max(0, 1 - Math.abs(hostNow - this.nextBlink - 75) / 75);
		expressions.setValue("blink", blink);
		const talking = hostNow < this.talkUntil;
		expressions.setValue("aa", talking ? 0.25 + 0.35 * Math.abs(Math.sin(hostNow / 70)) : 0);
	}

	private updateLabel(): void {
		const s = this.state;
		const suffix = s.kind === "ai" ? (s.status === "resting" ? " 💤" : " · AI") : "";
		this.label.textContent = `${s.name}${suffix}`;
		this.label.classList.toggle("me", this.isMe);
		this.label.classList.toggle("ai", s.kind === "ai");
		this.label.title = s.owner ? `オーナー: ${s.owner}` : "";
	}

	update(hostNow: number, dt: number, scene: CityScene): void {
		const pose = poseAt(this.state.move, hostNow);
		const ground = scene.heightAt(pose.pos[0], pose.pos[1]);
		if (ground !== null)
			this.y = Math.abs(ground - this.y) > 2 ? ground : this.y + (ground - this.y) * Math.min(1, dt * 12);
		this.root.position.set(pose.pos[0], this.y, pose.pos[1]);
		if (pose.moving) {
			const target = Math.atan2(pose.dir[0], pose.dir[1]);
			let diff = target - this.facing;
			diff = Math.atan2(Math.sin(diff), Math.cos(diff));
			this.facing += diff * Math.min(1, dt * 10);
		}
		this.root.rotation.y = this.facing;
		this.play(
			pose.moving
				? this.state.move.kind === "path" && this.state.move.speed > 2.5
					? "run"
					: "walk"
				: "stand",
		);
		this.mixer?.update(dt);
		if (this.vrm) {
			this.express(hostNow);
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

	/** For debugging in the browser console. */
	get debug(): { clips: string[]; playing: string } {
		return { clips: Object.keys(this.actions), playing: this.current };
	}

	private play(name: string): void {
		if (name === this.current) return;
		const next = this.actions[name] ?? this.actions.stand ?? this.actions.idle;
		if (!next) return;
		const prev = this.current ? this.actions[this.current] : undefined;
		next.reset().fadeIn(0.25).play();
		prev?.fadeOut(0.25);
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
