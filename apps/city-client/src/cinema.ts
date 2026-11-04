// The cinema view (docs/cinema.md): the whole page a film camera on you and your AI, cutting from shot to shot on its
// own (director.ts), and over it two small views, from your eyes and from your AI's. The eyes are drawn in the
// rectangles of two frames on the page (CityScene.insets).

import type { Vec2 } from "@rojibura/protocol";
import * as THREE from "three";
import type { AvatarView } from "./avatars.ts";
import { Director, type Looks, type Shot, type Subjects } from "./director.ts";
import type { CityScene } from "./scene.ts";

/** A layer pair: what only the wearer's eyes see, and what only others see (its head). */
export interface InsideLayers {
	first: number;
	third: number;
}

/** Yours: three-vrm's own. */
export const MY_LAYERS: InsideLayers = { first: 9, third: 10 };
/** Your AIs': a pair each from here, as they are first looked through (three-vrm takes the layers only once). */
const AI_LAYERS_FROM = 11;
const AI_LAYER_PAIRS = 10;
const ALL_LAYERS: InsideLayers[] = [
	MY_LAYERS,
	...Array.from({ length: AI_LAYER_PAIRS }, (_, i) => ({
		first: AI_LAYERS_FROM + i * 2,
		third: AI_LAYERS_FROM + i * 2 + 1,
	})),
];

/**
 * What a camera draws: everyone's heads and no headless copies; at someone's eyes (`inside`), their headless copies
 * and not their head.
 */
export function seeHeads(camera: THREE.Camera, inside: InsideLayers | null): void {
	const layers = camera.layers;
	layers.enable(0);
	for (const pair of ALL_LAYERS) {
		layers.disable(pair.first);
		layers.enable(pair.third);
	}
	if (inside) {
		layers.enable(inside.first);
		layers.disable(inside.third);
	}
}

/** How often the director thinks (ms). */
const STEP_MS = 250;
/**
 * The shot now is looked over one ray at a time, this often (ms): a ray goes through the whole city (some
 * milliseconds), so several at once would be a hitch while they walk. A cut hides the rays it takes.
 */
const RAY_MS = 150;
/** The camera follows them this late (seconds); what it looks at, this late. */
const FOLLOW_S = 0.9;
const AIM_S = 0.35;
/** A camera left in place turns after them this late (seconds): slower, so it turns like a hand on a tripod. */
const PAN_S = 0.6;
/** Above their feet the camera looks at this height (m): heads a third from the top. */
const AIM_UP = 1;
/** Walking, it looks this far ahead of them (m): room in front. */
const LEAD_ROOM = 0.6;
/** The camera stays this far above the ground (m), the height eased this late (seconds). */
const ABOVE_GROUND = 0.4;
const HEIGHT_S = 0.5;
/** The ground under the camera this far above them is a roof, not ground (m). */
const NOT_GROUND = 3;
/** They moved this far at once (a warp): cut (m). */
const JUMP_M = 8;
/** The way from the camera to them is checked this often (m); this part of it may be off the walkable ground. */
const OPEN_STEP_M = 1.5;
const OPEN_MISSES = 0.1;
/** The camera needs this much walkable room round it (m); going along with them, it is looked at this far on (m). */
const ROOM_M = 0.8;
const ROOM: Vec2[] = [
	[0, 0],
	[ROOM_M, 0],
	[-ROOM_M, 0],
	[0, ROOM_M],
	[0, -ROOM_M],
];
const AHEAD_M = 3;
/** The eyes' camera: how late it follows the head, up and down, and sideways (seconds; walking's bobbing to a quarter). */
const EYE_UP_S = 0.3;
const EYE_SIDE_S = 0.12;
/** How late your AI's eyes' camera turns to where it looks (seconds). */
const AI_TURN_S = 1 / 6;
const EYE_FOV = 60;
const EYE_NEAR = 0.03;

/** Part of the way to something that is `late` seconds behind, in `dt` seconds. */
const ease = (dt: number, late: number) => 1 - Math.exp(-dt / late);

/** The camera at someone's eyes: the head's place relative to the body, with the bobbing of walking taken out. */
class EyeCamera {
	readonly camera = new THREE.PerspectiveCamera(EYE_FOV, 16 / 9, EYE_NEAR, 400);
	private readonly fromBody = new THREE.Vector3();
	private started = false;

	moveTo(who: AvatarView, dt: number): void {
		const want = who.eyePosition().sub(who.root.position);
		if (this.started) {
			this.fromBody.x += (want.x - this.fromBody.x) * ease(dt, EYE_SIDE_S);
			this.fromBody.z += (want.z - this.fromBody.z) * ease(dt, EYE_SIDE_S);
			this.fromBody.y += (want.y - this.fromBody.y) * ease(dt, EYE_UP_S);
		} else {
			this.fromBody.copy(want);
			this.started = true;
		}
		this.camera.position.copy(who.root.position).add(this.fromBody);
	}

	/** Forget the last place (shown again, or someone else's eyes). */
	restart(): void {
		this.started = false;
	}
}

export interface CinemaOptions {
	/** Where the frames go on the page. */
	parent: HTMLElement;
	/** Walkable here (the camera keeps out of buildings). */
	walkable: (p: Vec2) => boolean;
}

/** Who the film is about, and how they are now. */
export interface Company {
	/** Your AI close by, or null. */
	partner: AvatarView | null;
	/** You walk (or are on your way somewhere, between legs). */
	moving: boolean;
	talking: boolean;
	/** Behind your AI on the way to a place (LEAD). */
	leading: boolean;
}

export class Cinema {
	private readonly scene: CityScene;
	private readonly walkable: (p: Vec2) => boolean;
	readonly director = new Director();
	private readonly frames: HTMLElement;
	/** The frame of your own eyes: drag it to look round. */
	readonly myFrame: HTMLElement;
	private readonly aiFrame: HTMLElement;
	private readonly aiName: HTMLElement;
	private readonly mine = new EyeCamera();
	private readonly ai = new EyeCamera();
	private readonly aiLook = new THREE.Vector3(0, 0, 1);
	private aiLookStarted = false;
	/** Whose eyes the frames are set up for: an AI's ID, null for nobody's, undefined when not set up yet. */
	private framesFor: string | null | undefined;
	private readonly pairs = new Map<string, InsideLayers>();
	private shot: Shot | null = null;
	private nextStep = 0;
	/** The way they walk, or last walked. */
	private dir: Vec2 = [0, 1];
	private readonly middle = new THREE.Vector3();
	/** The middle of them as the camera follows it, and the point it looks at. */
	private readonly followed = new THREE.Vector3();
	private readonly aim = new THREE.Vector3();
	/** Where they were last frame. */
	private readonly lastMiddle = new THREE.Vector3();
	private cameraY = 0;
	private heightWanted = 0;
	/** What the rays last found: the shot now sees you, your AI. */
	private seesMe = true;
	private seesAi = true;
	private nextRay = 0;
	private rayTurn = 0;
	private on = false;
	/** They walk now (as the film last heard). */
	private moving = false;

	constructor(scene: CityScene, options: CinemaOptions) {
		this.scene = scene;
		this.walkable = options.walkable;
		this.frames = frameEl("rj-pov");
		this.frames.hidden = true;
		this.myFrame = frameEl("rj-pov-frame rj-pov-mine");
		this.myFrame.append(nameEl("自分"));
		this.myFrame.title = "ドラッグで見回せます";
		this.aiFrame = frameEl("rj-pov-frame");
		this.aiName = nameEl("");
		this.aiFrame.append(this.aiName);
		this.frames.append(this.myFrame, this.aiFrame);
		options.parent.append(this.frames);
		seeHeads(this.mine.camera, MY_LAYERS);
	}

	/** The camera your keys walk by: your own eyes'. */
	get walkCamera(): THREE.PerspectiveCamera {
		return this.mine.camera;
	}

	show(on: boolean): void {
		this.on = on;
		this.frames.hidden = !on;
		this.scene.insets = [];
		this.shot = null;
		this.framesFor = undefined;
		this.director.reset();
		this.mine.restart();
		if (on) {
			this.mine.camera.far = this.ai.camera.far = this.scene.camera.far;
			this.mine.camera.updateProjectionMatrix();
			this.ai.camera.updateProjectionMatrix();
		}
	}

	/** Places the three cameras for this frame. `look`: where your own eyes look (a unit vector). */
	update(me: AvatarView, look: THREE.Vector3, company: Company, dt: number, now: number): void {
		if (!this.on) return;
		const pair = this.showEyesOf(company.partner);
		this.film(me, company, dt, now);
		this.mine.moveTo(me, dt);
		me.readyInside(MY_LAYERS);
		const my = this.mine.camera;
		my.lookAt(my.position.clone().add(look));
		const partner = company.partner;
		if (partner && pair) {
			partner.readyInside(pair);
			this.ai.moveTo(partner, dt);
			const want = partner.sightDirection();
			if (this.aiLookStarted) this.aiLook.lerp(want, ease(dt, AI_TURN_S)).normalize();
			else {
				this.aiLook.copy(want);
				this.aiLookStarted = true;
			}
			const their = this.ai.camera;
			their.lookAt(their.position.clone().add(this.aiLook));
		}
	}

	/** Shows the frame of this AI's eyes, or takes it away. Its layer pair, if it has one. */
	private showEyesOf(partner: AvatarView | null): InsideLayers | null {
		const id = partner?.state.id ?? null;
		const pair = id ? this.pairFor(id) : null;
		if (id === this.framesFor) return pair;
		this.framesFor = id;
		this.aiFrame.hidden = !pair;
		this.scene.insets = [{ camera: this.mine.camera, el: this.myFrame }];
		if (partner && pair) {
			seeHeads(this.ai.camera, pair);
			this.ai.restart();
			this.aiLookStarted = false;
			this.aiName.textContent = partner.state.name;
			this.scene.insets.push({ camera: this.ai.camera, el: this.aiFrame });
		}
		return pair;
	}

	/** The layer pair of this AI, the same every time; null when all are taken. */
	private pairFor(id: string): InsideLayers | null {
		const had = this.pairs.get(id);
		if (had) return had;
		const pair = ALL_LAYERS[this.pairs.size + 1];
		if (pair) this.pairs.set(id, pair);
		return pair ?? null;
	}

	/** The film camera. */
	private film(me: AvatarView, company: Company, dt: number, now: number): void {
		const camera = this.scene.camera;
		const a = me.root.position;
		const b = company.partner?.root.position ?? a;
		this.middle.copy(a).add(b).multiplyScalar(0.5);
		const { moving } = company;
		this.moving = moving;
		if (moving) this.dir = [Math.sin(me.heading), Math.cos(me.heading)];
		// a warp: from somewhere else altogether
		if (this.shot && this.lastMiddle.distanceTo(this.middle) > JUMP_M) {
			this.director.reset();
			this.nextStep = 0;
		}
		this.lastMiddle.copy(this.middle);
		let cut = false;
		const stepped = now >= this.nextStep || !this.shot;
		if (stepped) {
			this.nextStep = now + STEP_MS;
			const subjects: Subjects = {
				center: [this.middle.x, this.middle.z],
				dir: this.dir,
				spread: a.distanceTo(b),
				moving,
				talking: company.talking,
				leading: company.leading,
				aspect: camera.aspect,
				reach: this.scene.reach,
			};
			const step = this.director.step(now, subjects, this.looks(me, company.partner));
			cut = step.cut;
			this.shot = step.shot;
		}
		const shot = this.shot;
		if (!shot) return;
		const target = this.middle.clone();
		if (moving) {
			target.x += this.dir[0] * LEAD_ROOM;
			target.z += this.dir[1] * LEAD_ROOM;
		}
		target.y += AIM_UP;
		const fixed = shot.fixed;
		if (cut && fixed) {
			// a camera left in place: where it was put, looking at where they were (or turning after them)
			this.followed.copy(this.middle);
			this.aim.set(fixed.aim[0], this.middle.y + AIM_UP, fixed.aim[1]);
			this.cameraY = this.heightWanted = this.heightOf(shot);
			this.seesMe = this.seesAi = true;
			this.nextRay = now + RAY_MS;
			camera.fov = shot.fov;
			camera.updateProjectionMatrix();
		} else if (fixed) {
			if (now >= this.nextRay) {
				this.nextRay = now + RAY_MS;
				this.lookOver(me, company.partner, shot);
			}
			if (fixed.track) this.aim.lerp(this.middle.clone().setY(this.middle.y + AIM_UP), ease(dt, PAN_S));
			this.cameraY += (this.heightWanted - this.cameraY) * ease(dt, HEIGHT_S);
		} else if (cut) {
			this.followed.copy(this.middle);
			this.aim.copy(target);
			this.cameraY = this.heightWanted = this.heightOf(shot);
			this.seesMe = this.seesAi = true;
			this.nextRay = now + RAY_MS;
			camera.fov = shot.fov;
			camera.updateProjectionMatrix();
		} else {
			if (now >= this.nextRay) {
				this.nextRay = now + RAY_MS;
				this.lookOver(me, company.partner, shot);
			}
			this.followed.lerp(this.middle, ease(dt, FOLLOW_S));
			this.aim.lerp(target, ease(dt, AIM_S));
			this.cameraY += (this.heightWanted - this.cameraY) * ease(dt, HEIGHT_S);
		}
		if (fixed) camera.position.set(fixed.at[0], this.cameraY, fixed.at[1]);
		else
			camera.position.set(this.followed.x + shot.offset[0], this.cameraY, this.followed.z + shot.offset[1]);
		camera.lookAt(this.aim);
		// the shadow and the water follow what is filmed (scene.track)
		this.scene.controls.target.copy(this.middle);
	}

	/** One ray for the shot now: towards you, towards your AI, or down to the ground under the camera. */
	private lookOver(me: AvatarView, partner: AvatarView | null, shot: Shot): void {
		const from = this.scene.camera.position;
		const turn = this.rayTurn++ % 3;
		if (turn === 0) this.seesMe = this.scene.clearBetween(from, me.eyePosition());
		else if (turn === 1) this.seesAi = !partner || this.scene.clearBetween(from, partner.eyePosition());
		else this.heightWanted = this.heightOf(shot);
	}

	/** How high the camera is for this shot, where it stands now. */
	private heightOf(shot: Shot): number {
		const [x, z] = this.spot(shot);
		const y = this.middle.y + shot.height;
		const ground = this.scene.heightAt(x, z, this.middle.y);
		return ground !== null && ground < this.middle.y + NOT_GROUND ? Math.max(y, ground + ABOVE_GROUND) : y;
	}

	/** Where the camera is for this shot now (x, z): where it was left, or beside them as they walk. */
	private spot(shot: Shot): Vec2 {
		return shot.fixed ? shot.fixed.at : [this.middle.x + shot.offset[0], this.middle.z + shot.offset[1]];
	}

	/** What the director may ask about what can be seen from where. */
	private looks(me: AvatarView, partner: AvatarView | null): Looks {
		return {
			open: (shot) => {
				const [x, z] = this.spot(shot);
				// the camera where it is put, with room round it, and, going along with them, where it will be in a moment
				const spots: Vec2[] = [[x, z]];
				const ahead: Vec2 = this.moving ? [this.dir[0] * AHEAD_M, this.dir[1] * AHEAD_M] : [0, 0];
				if (!shot.fixed && this.moving) spots.push([x + ahead[0], z + ahead[1]]);
				// (the camera itself, a little behind where it is put while it catches up)
				if (shot === this.shot) spots.push([this.scene.camera.position.x, this.scene.camera.position.z]);
				for (const [px, pz] of spots)
					for (const [dx, dz] of ROOM) if (!this.walkable([px + dx, pz + dz])) return false;
				// the way from the camera to them (now, and where they will be) has to be ground all along
				const targets: Vec2[] = [[this.middle.x, this.middle.z]];
				if (this.moving) targets.push([this.middle.x + ahead[0], this.middle.z + ahead[1]]);
				for (const [tx, tz] of targets) {
					const along: Vec2 = shot.fixed ? [x, z] : [x + (tx - this.middle.x), z + (tz - this.middle.z)];
					const ox = tx - along[0];
					const oz = tz - along[1];
					const n = Math.max(2, Math.ceil(Math.hypot(ox, oz) / OPEN_STEP_M));
					let misses = 0;
					for (let i = 0; i < n; i++) {
						const t = i / n;
						if (!this.walkable([along[0] + ox * t, along[1] + oz * t])) misses++;
					}
					if (misses > n * OPEN_MISSES) return false;
				}
				return true;
			},
			seen: (shot) => {
				if (shot === this.shot)
					return partner ? (Number(this.seesMe) + Number(this.seesAi)) / 2 : Number(this.seesMe);
				const [x, z] = this.spot(shot);
				const from = new THREE.Vector3(x, this.middle.y + shot.height, z);
				const eyes = partner ? [me.eyePosition(), partner.eyePosition()] : [me.eyePosition()];
				return eyes.filter((e) => this.scene.clearBetween(from, e)).length / eyes.length;
			},
		};
	}
}

function frameEl(className: string): HTMLDivElement {
	const el = document.createElement("div");
	el.className = className;
	return el;
}

function nameEl(text: string): HTMLSpanElement {
	const el = document.createElement("span");
	el.className = "rj-pov-name";
	el.textContent = text;
	return el;
}
