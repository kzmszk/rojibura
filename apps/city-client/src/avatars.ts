// Avatars in the scene: model (shared glTF, cloned), animation, name label, chat bubble,
// and pose from the host's move state (docs/prd.md 3.4, フロー④).

import { type AvatarState, type MoveState, poseAt, type Status } from "@rojibura/protocol";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { CSS2DObject } from "three/examples/jsm/renderers/CSS2DRenderer.js";
import { clone as cloneSkinned } from "three/examples/jsm/utils/SkeletonUtils.js";
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
		if (url) void this.loadModel(url);
	}

	private async loadModel(url: string): Promise<void> {
		const t = await models.get(url);
		if (!t) return;
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
		this.root.removeFromParent();
		this.root.traverse((o) => {
			if (o instanceof CSS2DObject) o.element.remove();
		});
	}
}
