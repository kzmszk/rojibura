// The mirror (docs/prd.md 3.4.11): a page with no city and no connection, where an AI rehearses a body script
// before doing it in the city. Its runtime (avatar-sdk's node mirror, through headless Chrome) puts the AI's
// avatar and the one the script is for where they stand, plays the script on the city's own avatar code,
// and gets back one picture of a few moments from two sides, and how far each hand stayed from its spot.

import { type BodyKey, type BodyPart, bodyDuration } from "@rojibura/protocol";
import * as THREE from "three";
import { AvatarView as Avatar } from "./avatars.ts";

export interface MirrorBody {
	/** The avatar's VRM (or glTF) URL, as in AvatarState.assets. */
	vrm: string;
}

export interface RehearseRequest {
	me: MirrorBody;
	/** The one "you" means: where they stand from me, metres to my right and to my front; they face me. */
	you?: MirrorBody & { at: [right: number, front: number] };
	keys: BodyKey[];
}

export interface RehearseResult {
	/** JPEG data URL: the moments in columns, seen from the right (top) and the left (bottom). */
	image: string;
	/** Per moment shown: its time, and for each hand on a spot how far its palm stayed from it (cm). */
	moments: { at: number; right?: number; left?: number }[];
	/** Whether each avatar loaded with bones to move. */
	loaded: { me: boolean; you: boolean | null };
}

const CELL = 360;
const MOMENTS_MAX = 6;
const FPS = 30;
/** Standing about before the script starts, so the motion and the hair settle (seconds). */
const LEAD_IN = 1.2;

const heightAt = () => 0;
const state = (id: string, kind: "human" | "ai", vrm: string, pos: [number, number]) => ({
	id,
	kind,
	name: id,
	status: "active" as const,
	assets: { thumb: "", lod: vrm, vrm },
	move: { kind: "idle" as const, pos, at: 0 },
});

export function mountMirror(root: HTMLElement): void {
	const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
	renderer.setPixelRatio(1);
	renderer.setSize(CELL, CELL);
	renderer.outputColorSpace = THREE.SRGBColorSpace;
	root.appendChild(renderer.domElement);
	const scene = new THREE.Scene();
	scene.background = new THREE.Color(0xdfe7ee);
	scene.add(new THREE.HemisphereLight(0xeaf2ff, 0x6b6250, 1.8));
	const sun = new THREE.DirectionalLight(0xfff1dc, 2.0);
	sun.position.set(3, 6, 4);
	scene.add(sun);
	const floor = new THREE.Mesh(
		new THREE.CircleGeometry(6, 48).rotateX(-Math.PI / 2),
		new THREE.MeshLambertMaterial({ color: 0xb9b2a4 }),
	);
	scene.add(floor);
	const camera = new THREE.PerspectiveCamera(40, 1, 0.05, 50);

	let cast: { key: string; me: Avatar; you: Avatar | null } | null = null;

	async function stage(req: RehearseRequest): Promise<{ me: Avatar; you: Avatar | null }> {
		const key = JSON.stringify([req.me.vrm, req.you?.vrm ?? null, req.you?.at ?? null]);
		if (cast?.key === key) return cast;
		if (cast) {
			cast.me.dispose();
			cast.you?.dispose();
		}
		const me = new Avatar(state("a_mirror", "ai", req.me.vrm, [0, 0]), false);
		let you: Avatar | null = null;
		if (req.you) {
			// facing +z my right is -x
			const [r, f] = req.you.at;
			you = new Avatar(state("h_mirror", "human", req.you.vrm, [-r, f]), false);
		}
		scene.add(me.root);
		if (you) scene.add(you.root);
		await Promise.all([me.ready, you?.ready]);
		cast = { key, me, you };
		return cast;
	}

	async function rehearse(req: RehearseRequest): Promise<RehearseResult> {
		const { me, you } = await stage(req);
		const dt = 1 / FPS;
		let now = 0;
		const step = () => {
			now += dt * 1000;
			// the one it is for faces it; it looks at them, as an AI does at its owner close by
			if (you) {
				you.attend(me.eyePosition());
				me.attend(you.eyePosition());
			}
			me.update(now, dt, { heightAt });
			you?.update(now, dt, { heightAt });
			scene.updateMatrixWorld(true);
		};
		// both facing each other and settled before it starts
		if (you) {
			me.turnTowards(you.root.position);
			you.turnTowards(me.root.position);
		}
		for (let t = 0; t < LEAD_IN; t += dt) step();
		const start = now;
		me.moveBody(req.keys, start, you, you ? "h_mirror" : undefined);

		const times = momentsOf(req.keys);
		const shots: { at: number; cells: HTMLCanvasElement[]; right?: number; left?: number }[] = [];
		const end = bodyDuration(req.keys);
		let next = 0;
		for (let t = 0; t <= end + dt && next < times.length; t += dt) {
			step();
			const at = times[next] as number;
			if ((now - start) / 1000 + 1e-6 < at) continue;
			next++;
			shots.push({ at, cells: views(me, you), ...misses(req.keys, at, me, you) });
		}
		return {
			image: compose(shots),
			moments: shots.map(({ cells: _, ...m }) => m),
			loaded: loadedOf(me, you),
		};
	}

	function views(me: Avatar, you: Avatar | null): HTMLCanvasElement[] {
		const f = me.frame();
		const center = me.root.position.clone();
		if (you) center.lerp(you.root.position, 0.5);
		center.y = 1.25;
		const out: HTMLCanvasElement[] = [];
		for (const side of [1, -1]) {
			camera.position
				.copy(center)
				.addScaledVector(f.right, 1.75 * side)
				.addScaledVector(f.front, 0.75)
				.setY(1.5);
			camera.lookAt(center);
			renderer.render(scene, camera);
			const c = document.createElement("canvas");
			c.width = c.height = CELL;
			(c.getContext("2d") as CanvasRenderingContext2D).drawImage(renderer.domElement, 0, 0);
			out.push(c);
		}
		return out;
	}

	(window as unknown as { rjMirror: unknown }).rjMirror = { rehearse };
	root.dataset.ready = "1";
}

/** The moments to show: each key's time, at most MOMENTS_MAX of them (spread out), and the end. */
function momentsOf(keys: BodyKey[]): number[] {
	let at = keys.map((k) => k.at);
	if (at.length > MOMENTS_MAX - 1) {
		const pick = MOMENTS_MAX - 1;
		at = Array.from({ length: pick }, (_, i) => at[Math.round((i * (at.length - 1)) / (pick - 1))] as number);
	}
	return [...new Set([...at, bodyDuration(keys)])].sort((a, b) => a - b);
}

/** How far each hand's palm is from the spot the script has it on at `at` (cm), for keys that set one. */
function misses(
	keys: BodyKey[],
	at: number,
	me: Avatar,
	you: Avatar | null,
): { right?: number; left?: number } {
	const out: { right?: number; left?: number } = {};
	const key = [...keys].reverse().find((k) => k.at <= at + 1e-6);
	if (!key) return out;
	for (const side of ["right", "left"] as const) {
		const h = key[side];
		if (!h || h === "rest" || key.at !== at) continue;
		const body = h.of === "you" ? you : me;
		const spot = body?.spot(h.part, h.off);
		const palm = me.spot(`hand_${side === "right" ? "r" : "l"}` as BodyPart);
		if (spot && palm) out[side] = Math.round(palm.distanceTo(spot) * 100);
	}
	return out;
}

function compose(shots: { at: number; cells: HTMLCanvasElement[] }[]): string {
	const c = document.createElement("canvas");
	c.width = CELL * Math.max(1, shots.length);
	c.height = CELL * 2;
	const g = c.getContext("2d") as CanvasRenderingContext2D;
	g.fillStyle = "#fff";
	g.fillRect(0, 0, c.width, c.height);
	g.font = "bold 22px sans-serif";
	shots.forEach((s, i) => {
		s.cells.forEach((cell, row) => {
			g.drawImage(cell, i * CELL, row * CELL);
		});
		g.fillStyle = "rgba(255,255,255,0.8)";
		g.fillRect(i * CELL + 6, 6, 92, 30);
		g.fillStyle = "#222";
		g.fillText(`${s.at.toFixed(1)}秒`, i * CELL + 12, 30);
		g.strokeStyle = "#999";
		g.strokeRect(i * CELL, 0, CELL, CELL * 2);
	});
	return c.toDataURL("image/jpeg", 0.85);
}

function loadedOf(me: Avatar, you: Avatar | null): RehearseResult["loaded"] {
	return { me: me.hasBones, you: you ? you.hasBones : null };
}
