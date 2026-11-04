// Where the camera looks from (docs/prd.md 3.4.8): orbiting the avatar (drag to turn, wheel to zoom), a drone
// just behind it, its own eyes, or a film of it and its AI with the eyes of both in frames (docs/cinema.md). Dragging
// turns the drone and the eyes; while the avatar walks they come round behind it again, unless one turned them while
// it walks: then they look that way until it stops.

import * as THREE from "three";
import type { AvatarView } from "./avatars.ts";
import { Cinema, type CinemaOptions, type Company, MY_LAYERS, seeHeads } from "./cinema.ts";
import type { CityScene } from "./scene.ts";

export type View = "orbit" | "drone" | "eyes" | "cinema";
export const VIEWS: View[] = ["orbit", "drone", "eyes", "cinema"];
export const VIEW_LABEL: Record<View, string> = {
	orbit: "ふつう",
	drone: "うしろ",
	eyes: "一人称",
	cinema: "シネマ",
};

/** The main camera's lens, but in the cinema view (degrees). */
const FOV = 55;
const DRONE_BACK = 2.4;
const DRONE_UP = 0.7;
const PITCH_LIMIT = Math.PI * 0.4;
/**
 * Looking round with the keys in the cinema view (docs/cinema.md 2): as fast as this (radians a second), and as far as
 * a person can: up 40° and down 45° (neck and eyes), and walking, 55° to either side of the way they go. Standing,
 * the body turns, so all the way round.
 */
const LOOK_RATE = 1.8;
const LOOK_UP = 0.7;
const LOOK_DOWN = -0.8;
const LOOK_WALKING = 0.96;
/** What the head is made to look at: this far off (m). */
const GAZE_M = 10;

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
	readonly cinema: Cinema;

	constructor(scene: CityScene, cinema: CinemaOptions) {
		this.scene = scene;
		this.cinema = new Cinema(scene, cinema);
		const dom = scene.renderer.domElement;
		dom.addEventListener("pointerdown", (e) => {
			// (the film goes its own way; your eyes are turned on their frame)
			if (this.view === "drone" || this.view === "eyes") this.drag = { x: e.clientX, y: e.clientY };
		});
		addEventListener("pointerup", () => {
			this.drag = null;
		});
		const turn = (e: PointerEvent) => {
			if (!this.drag || this.view === "orbit") return;
			this.yaw -= (e.clientX - this.drag.x) * 0.005;
			this.held = true;
			this.pitch = Math.max(
				-PITCH_LIMIT,
				Math.min(PITCH_LIMIT, this.pitch - (e.clientY - this.drag.y) * 0.004),
			);
			this.drag = { x: e.clientX, y: e.clientY };
		};
		dom.addEventListener("pointermove", turn);
		const frame = this.cinema.myFrame;
		frame.addEventListener("pointerdown", (e) => {
			frame.setPointerCapture(e.pointerId);
			this.drag = { x: e.clientX, y: e.clientY };
		});
		frame.addEventListener("pointermove", turn);
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

	/** Looks round by the keys (the cinema view only): `x` left (+) or right (-), `y` up (+) or down (-), -1 to 1. */
	turnBy(x: number, y: number, dt: number): void {
		if (this.view !== "cinema") return;
		this.yaw += x * LOOK_RATE * dt;
		this.pitch += y * LOOK_RATE * dt;
		this.held = true;
	}

	private lookVector(): THREE.Vector3 {
		return new THREE.Vector3(
			Math.sin(this.yaw) * Math.cos(this.pitch),
			Math.sin(this.pitch),
			Math.cos(this.yaw) * Math.cos(this.pitch),
		);
	}

	/** What your head looks at in the cinema view (world), so that your face goes where your eyes look; else null. */
	gazePoint(me: AvatarView): THREE.Vector3 | null {
		return this.view === "cinema" ? me.eyePosition().addScaledVector(this.lookVector(), GAZE_M) : null;
	}

	/** The camera that "forward" is taken from, for keys: your eyes in the cinema view (the film cuts about). */
	get walkCamera(): THREE.PerspectiveCamera {
		return this.view === "cinema" ? this.cinema.walkCamera : this.scene.camera;
	}

	/** Switches the view; the avatar is yours (its head hides in the eyes view). */
	set(view: View, me: AvatarView | null): void {
		this.view = view;
		this.me = me;
		this.scene.controls.enabled = view === "orbit";
		this.cinema.show(view === "cinema");
		if (me) {
			this.yaw = me.heading;
			// the eyes look a little down, at the ground ahead and whoever walks there
			this.pitch = view === "eyes" ? -0.12 : -0.15;
			me.seenFromInside(view === "eyes");
			if (view === "orbit") this.scene.jumpTo(me.root.position);
		}
		this.scene.camera.near = view === "eyes" ? 0.03 : 0.1;
		if (view !== "cinema") this.scene.camera.fov = FOV;
		this.scene.camera.updateProjectionMatrix();
		this.layers();
	}

	/** The first-person layers: in the eyes view your own head (third-person only) is not drawn. */
	private layers(): void {
		seeHeads(this.scene.camera, this.view === "eyes" ? MY_LAYERS : null);
	}

	/**
	 * Places the camera for this frame. `moving`: the avatar walks, so the view comes round behind it. `company`,
	 * `now`: for the film, who is with you, and a clock in milliseconds.
	 */
	update(
		me: AvatarView,
		moving: boolean,
		dt: number,
		company: Omit<Company, "moving"> = { partner: null, talking: false, leading: false },
		now = 0,
	): void {
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
		if (this.view === "cinema") {
			// as far as a person can look: walking, not over the shoulder; standing, the body turns
			this.pitch = Math.max(LOOK_DOWN, Math.min(LOOK_UP, this.pitch));
			if (moving) {
				const off = Math.atan2(Math.sin(this.yaw - me.heading), Math.cos(this.yaw - me.heading));
				this.yaw = me.heading + Math.max(-LOOK_WALKING, Math.min(LOOK_WALKING, off));
			}
		}
		const look = this.lookVector();
		if (this.view === "cinema") {
			this.cinema.update(me, look, { ...company, moving }, dt, now);
			return;
		}
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
