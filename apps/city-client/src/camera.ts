// Where the camera looks from (docs/prd.md 3.4.8): orbiting the avatar (drag to turn, wheel to zoom), a drone
// just behind it, or its own eyes. Dragging turns the drone and the eyes; while the avatar walks they come
// round behind it again, unless one turned them while it walks: then they look that way until it stops.

import * as THREE from "three";
import type { AvatarView } from "./avatars.ts";
import type { CityScene } from "./scene.ts";

export type View = "orbit" | "drone" | "eyes";
export const VIEWS: View[] = ["orbit", "drone", "eyes"];
export const VIEW_LABEL: Record<View, string> = { orbit: "ふつう", drone: "うしろ", eyes: "一人称" };

/** three-vrm's VRMFirstPerson layers: meshes only the wearer sees, and meshes only others see (the head). */
const FIRST_PERSON_ONLY = 9;
const THIRD_PERSON_ONLY = 10;

const DRONE_BACK = 2.4;
const DRONE_UP = 0.7;
const PITCH_LIMIT = Math.PI * 0.4;

export class ViewController {
	view: View = "orbit";
	private yaw = 0;
	private pitch = 0;
	private drag: { x: number; y: number } | null = null;
	/** Turned by hand while walking: the view stays where it was put until the avatar stops. */
	private held = false;
	private orbiting = false;
	private readonly scene: CityScene;
	private me: AvatarView | null = null;

	constructor(scene: CityScene) {
		this.scene = scene;
		const dom = scene.renderer.domElement;
		dom.addEventListener("pointerdown", (e) => {
			if (this.view !== "orbit") this.drag = { x: e.clientX, y: e.clientY };
		});
		addEventListener("pointerup", () => {
			this.drag = null;
		});
		dom.addEventListener("pointermove", (e) => {
			if (!this.drag || this.view === "orbit") return;
			this.yaw -= (e.clientX - this.drag.x) * 0.005;
			this.held = true;
			this.pitch = Math.max(
				-PITCH_LIMIT,
				Math.min(PITCH_LIMIT, this.pitch - (e.clientY - this.drag.y) * 0.004),
			);
			this.drag = { x: e.clientX, y: e.clientY };
		});
		scene.controls.addEventListener("start", () => {
			this.orbiting = true;
		});
		scene.controls.addEventListener("end", () => {
			this.orbiting = false;
		});
		this.layers();
	}

	/** The person is turning the view by dragging (keys then walk relative to where it looks now). */
	get dragging(): boolean {
		return this.drag !== null || this.orbiting;
	}

	/** Switches the view; the avatar is yours (its head hides in the eyes view). */
	set(view: View, me: AvatarView | null): void {
		this.view = view;
		this.me = me;
		this.scene.controls.enabled = view === "orbit";
		if (me) {
			this.yaw = me.heading;
			// the eyes look a little down, at the ground ahead and whoever walks there
			this.pitch = view === "eyes" ? -0.12 : -0.15;
			me.seenFromInside(view === "eyes");
			if (view === "orbit") this.scene.jumpTo(me.root.position);
		}
		this.scene.camera.near = view === "eyes" ? 0.03 : 0.1;
		this.scene.camera.updateProjectionMatrix();
		this.layers();
	}

	/** The first-person layers: in the eyes view your own head (third-person only) is not drawn. */
	private layers(): void {
		const layers = this.scene.camera.layers;
		layers.enable(0);
		if (this.view === "eyes") {
			layers.enable(FIRST_PERSON_ONLY);
			layers.disable(THIRD_PERSON_ONLY);
		} else {
			layers.disable(FIRST_PERSON_ONLY);
			layers.enable(THIRD_PERSON_ONLY);
		}
	}

	/** Places the camera for this frame. `moving`: the avatar walks, so the view comes round behind it. */
	update(me: AvatarView, moving: boolean, dt: number): void {
		if (me !== this.me) this.set(this.view, me);
		const at = me.root.position;
		if (this.view === "orbit") {
			this.scene.follow(at, dt);
			return;
		}
		if (!moving) this.held = false;
		if (moving && !this.drag && !this.held) {
			const diff = Math.atan2(Math.sin(me.heading - this.yaw), Math.cos(me.heading - this.yaw));
			this.yaw += diff * Math.min(1, dt * 3);
		}
		const look = new THREE.Vector3(
			Math.sin(this.yaw) * Math.cos(this.pitch),
			Math.sin(this.pitch),
			Math.cos(this.yaw) * Math.cos(this.pitch),
		);
		const camera = this.scene.camera;
		if (this.view === "eyes") {
			camera.position.copy(me.eyePosition());
		} else {
			const head = at.clone().add(new THREE.Vector3(0, 1.5, 0));
			const behind = head
				.clone()
				.addScaledVector(look, -DRONE_BACK)
				.add(new THREE.Vector3(0, DRONE_UP, 0));
			// stay above the ground on slopes and stairs
			const ground = this.scene.heightAt(behind.x, behind.z);
			if (ground !== null) behind.y = Math.max(behind.y, ground + 0.4);
			camera.position.lerp(behind, Math.min(1, dt * 8));
		}
		// the eyes look where they face; the drone at a point ahead of the avatar's head
		camera.lookAt(
			this.view === "eyes"
				? camera.position.clone().add(look)
				: at
						.clone()
						.add(new THREE.Vector3(0, 1.4, 0))
						.addScaledVector(look, 1.5),
		);
		// the shadow and the water follow what is looked at (scene.track)
		this.scene.controls.target.copy(at);
	}
}
