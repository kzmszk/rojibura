// In the bath (the onsen inn's open-air bath and its changing room): everyone bathes in a swimsuit
// (2026-11-03, issue 46; a bath towel before). Women wear a one-piece with shoulder straps, cut high at the
// legs; men wear swimming trunks.
//
// The swimsuit is a skinned mesh on the avatar's own skeleton, cut from the body's own surface at rest: the
// skin's triangles (and the skin made again where VRoid deleted it under clothes, bath-body.ts) inside the
// suit's outline, cut cleanly along it and lifted a few millimetres off the skin, each vertex moved by the
// bones that move the skin under it, so it fits the body as it is and walks, sits, lies and hugs with it.
// Clothes are hidden (VRoid's "…_CLOTH" meshes); clothes painted on the skin outside the suit are painted
// over (bath-body.ts). Everything is made the first time the avatar bathes (and what does not depend on the
// avatar is kept for the next one of the same model); after that, going in and out is only switching meshes
// and materials.

import { MToonMaterial } from "@pixiv/three-vrm";
import * as THREE from "three";
import {
	type Body,
	bodyShape,
	isSkin,
	kindOf,
	maskOf,
	measureBody,
	mergeClouds,
	type Part,
	paintSkin,
	pixelsOf,
	surfaceOf,
	type Tone,
	TriangleGrid,
	toneOf,
	weightsFor,
} from "./bath-body.ts";

export interface BathModel {
	/** The model's root (a VRM's scene, or a glTF's). */
	root: THREE.Object3D;
	/** The bones that move its skin, by humanoid bone name. */
	bones: Partial<Record<string, THREE.Object3D>>;
	/** Which model it is (its URL): what is worked out for one is kept for the next of the same model. */
	key: string;
	/** A VRM's materials (three-vrm updates them every frame): the bath's own are added while it lasts. */
	materials?: THREE.Material[];
	/**
	 * A VRoid model: its texture is in large pieces (painted clothes are painted over with the skin around
	 * them) and its feet are bare skin (painted socks are painted over). Otherwise painted clothes get the
	 * skin's colour and the feet stay as they are (sandals).
	 */
	vroid: boolean;
	/** Which swimsuit: a woman's one-piece or bikini, or a man's trunks. */
	suit: Suit;
}

export type Suit = "one-piece" | "bikini" | "trunks";

/** Models that bathe in another swimsuit than their sex's (Shibu in a bikini: the user chose it, issue 46). */
const SUITS: Record<string, Suit> = { shibu: "bikini", "shibu-wsu": "bikini" };

/**
 * Models whose skin VRoid deleted under their clothes (a trunk with no breasts or waist to put a swimsuit on),
 * and the model of the same character, with her skin whole, who bathes in their place (Shibu in her casual
 * clothes goes into the bath as Shibu in her school uniform's body: clothes off, so it shows only in the body).
 */
const BATH_BODIES: Record<string, string> = { shibu: "shibu-wsu" };

/** The model to draw in the bath in place of this one, or null if it bathes as it is. */
export function bathBodyUrl(url: string): string | null {
	const name = url.slice(url.lastIndexOf("/") + 1).replace(/\.vrm$/, "");
	const other = BATH_BODIES[name];
	return other ? `${url.slice(0, url.lastIndexOf("/") + 1)}${other}.vrm` : null;
}

/** The swimsuit a model wears: its own if it has one, else trunks for men, a one-piece for others. */
export function suitFor(url: string, sex: string | undefined): Suit {
	const name = url.slice(url.lastIndexOf("/") + 1).replace(/\.(vrm|glb)$/, "");
	return SUITS[name] ?? (sex === "m" ? "trunks" : "one-piece");
}

/** Bone names of a glTF avatar rigged like Blender's Rigify (Saki), by humanoid name. */
const RIGIFY: Record<string, string> = {
	hips: "hips",
	spine: "spine",
	chest: "chest",
	neck: "neck",
	head: "head",
	leftShoulder: "shoulderL",
	leftUpperArm: "upperarmL",
	leftLowerArm: "forearmL",
	leftHand: "handL",
	rightShoulder: "shoulderR",
	rightUpperArm: "upperarmR",
	rightLowerArm: "forearmR",
	rightHand: "handR",
	leftUpperLeg: "thighL",
	leftLowerLeg: "shinL",
	leftFoot: "footL",
	rightUpperLeg: "thighR",
	rightLowerLeg: "shinR",
	rightFoot: "footR",
};

/** A glTF avatar's bones by humanoid name (GLTFLoader drops the dots: "upperarm.L" is "upperarmL"). */
export function rigifyBones(root: THREE.Object3D): Partial<Record<string, THREE.Object3D>> {
	const out: Partial<Record<string, THREE.Object3D>> = {};
	for (const [human, name] of Object.entries(RIGIFY)) {
		const node = root.getObjectByName(name);
		if (node) out[human] = node;
	}
	return out;
}

/** A mesh's vertices: what a swimsuit or new skin is made of. Shared by every avatar of the model. */
interface MeshData {
	pos: Float32Array;
	nrm: Float32Array;
	uv: Float32Array;
	joints: Uint16Array;
	weights: Float32Array;
	index: Uint32Array;
}

/** What bathing does to a model, worked out once per model. */
interface Plan {
	suit: MeshData;
	/** Skin made again where it was deleted under clothes; on the main skin's material. */
	fill: MeshData | null;
	/** How far a point (bind space) is inside the suit's outline (metres; negative outside). */
	inside: (p: THREE.Vector3, bone: number) => number;
	/** Whether the new skin's UVs point at plain skin on the main skin texture yet. */
	fillUV: boolean;
}

const plans = new Map<string, Plan | null>();
/**
 * Per skin texture's image (shared by a model's avatars): the texture with clothes painted on it painted over
 * (the texture itself if there are none), and a spot on it of plain skin (UV), for the new skin.
 */
const painted = new WeakMap<object, Painted>();

interface Painted {
	texture: THREE.Texture;
	/** The material's shade texture (MToon) painted over the same way. */
	shade: THREE.Texture | null;
	skin: [number, number] | null;
}

/** Ours: the swimsuit and the new skin (not the model's own meshes). */
const OURS = "rj-suit";

export class Bath {
	private built = false;
	private on = false;
	private suit: THREE.SkinnedMesh | null = null;
	private fill: THREE.SkinnedMesh | null = null;
	/** Each skin material and what it is in the bath (clothes painted over). */
	private readonly swap = new Map<THREE.Material, THREE.Material>();
	private readonly own: THREE.Material[] = [];
	/** Clothes hidden for the bath, to show again after. */
	private readonly hidden = new Set<THREE.Object3D>();

	private readonly model: BathModel;

	constructor(model: BathModel) {
		this.model = model;
	}

	/**
	 * In the bath or not: switching meshes and materials. The first time in, the swimsuit is made: some hundreds
	 * of milliseconds for the first avatar of a model, some tens for the next (see `prepare`).
	 */
	set(on: boolean): void {
		if (on) this.prepare();
		this.on = on;
		if (!this.suit) return;
		this.suit.visible = on;
		if (this.fill) this.fill.visible = on;
		const back = new Map([...this.swap].map(([a, b]) => [b, a]));
		const to = on ? this.swap : back;
		this.model.root.traverse((o) => {
			const mesh = o as THREE.Mesh;
			if (!mesh.isMesh || mesh.name.startsWith(OURS)) return;
			// (three-vrm's first-person copies of a mesh too, made later on)
			if (kindOf(mesh) === "cloth") {
				if (on && mesh.visible) {
					mesh.visible = false;
					this.hidden.add(mesh);
				} else if (!on && this.hidden.has(mesh)) {
					mesh.visible = true;
				}
				return;
			}
			if (Array.isArray(mesh.material)) mesh.material = mesh.material.map((m) => to.get(m) ?? m);
			else mesh.material = to.get(mesh.material) ?? mesh.material;
		});
		if (!on) this.hidden.clear();
	}

	get bathing(): boolean {
		return this.on;
	}

	/** Makes the swimsuit (and the rest) now, if not made yet, without going in: e.g. when the avatar is idle. */
	prepare(): void {
		if (!this.built) this.build();
	}

	dispose(): void {
		if (this.on) this.set(false);
		for (const m of [this.suit, this.fill]) {
			if (!m) continue;
			m.removeFromParent();
			m.geometry.dispose();
		}
		for (const m of this.own) {
			m.dispose();
			const list = this.model.materials;
			const i = list?.indexOf(m) ?? -1;
			if (list && i >= 0) list.splice(i, 1);
		}
		this.suit = null;
		this.fill = null;
	}

	private build(): void {
		this.built = true;
		const parts: Part[] = [];
		this.model.root.traverse((o) => {
			const mesh = o as THREE.SkinnedMesh;
			if (!mesh.isSkinnedMesh || mesh.name.startsWith(OURS) || mesh.name.endsWith("(erase)")) return;
			parts.push({ mesh, kind: kindOf(mesh) });
		});
		const skins = parts.filter((p) => p.kind === "skin").map((p) => p.mesh);
		if (skins.length === 0) return;
		// the body at rest is measured only when there is something to work out (the first of a model)
		let body: Body | null | undefined;
		const measured = () => {
			if (body === undefined) body = measureBody(parts, this.model.bones);
			return body;
		};
		const key = `${this.model.key} ${this.model.suit}`;
		let plan = plans.get(key);
		if (plan === undefined) {
			const b = measured();
			plan = b ? planFor(b, parts, this.model.suit) : null;
			plans.set(key, plan);
		}
		if (!plan) return;
		const main = mainOf(skins);
		this.paint(measured, plan, skins, parts);
		const parent = main.parent ?? this.model.root;
		const mainMap = [main.material]
			.flat()
			.map((m) => (m as THREE.MeshBasicMaterial).map)
			.find((t) => t);
		const spot = mainMap ? painted.get(mainMap.source)?.skin : null;
		if (plan.fill && !plan.fillUV && spot) {
			for (let i = 0; i < plan.fill.uv.length; i += 2) plan.fill.uv.set(spot, i);
			plan.fillUV = true;
		}

		const suit = new THREE.SkinnedMesh(geometryOf(plan.suit), suitMaterial(main.material, this.model));
		this.suit = this.attach(suit, `${OURS}`, main.skeleton, parent);
		this.own.push(suit.material as THREE.Material);
		if (plan.fill) {
			// the skin's own material (not its outline)
			const first = [main.material].flat()[0] as THREE.Material;
			const mat = this.swap.get(first) ?? first;
			this.fill = this.attach(
				new THREE.SkinnedMesh(geometryOf(plan.fill), mat),
				`${OURS}-skin`,
				main.skeleton,
				parent,
			);
		}
		for (const m of this.own) this.model.materials?.push(m);
	}

	private attach(
		mesh: THREE.SkinnedMesh,
		name: string,
		skeleton: THREE.Skeleton,
		parent: THREE.Object3D,
	): THREE.SkinnedMesh {
		mesh.name = name;
		// on the main skin's skeleton (the suit's bone indices are its), in bind space
		mesh.bind(skeleton, new THREE.Matrix4());
		mesh.castShadow = true;
		mesh.frustumCulled = false;
		mesh.visible = false;
		parent.add(mesh);
		return mesh;
	}

	/**
	 * Bath materials for the skin: clothes painted on the skin texture are painted over with skin where the
	 * suit does not cover them (socks, trousers, a T-shirt's shoulders). Underwear under the suit stays.
	 */
	private paint(measured: () => Body | null, plan: Plan, skins: THREE.SkinnedMesh[], parts: Part[]): void {
		const byMap = new Map<THREE.Texture, THREE.SkinnedMesh[]>();
		for (const m of skins)
			for (const mat of [m.material].flat()) {
				const map = (mat as THREE.MeshBasicMaterial).map;
				if (!map) continue;
				const list = byMap.get(map) ?? [];
				if (!list.includes(m)) list.push(m);
				byMap.set(map, list);
			}
		const faces = parts.filter((p) => p.kind === "face").map((p) => p.mesh);
		for (const [map, meshes] of byMap) {
			let done = painted.get(map.source);
			const body = done ? null : measured();
			if (!done && body) {
				const s = body.size;
				const feet = new Set([body.bone.leftFoot, body.bone.rightFoot]);
				const boneIndex = (b: THREE.Object3D | undefined) => {
					for (let o: THREE.Object3D | null | undefined = b; o; o = o.parent) {
						const i = body.skeleton.bones.indexOf(o as THREE.Bone);
						if (i >= 0) return i;
					}
					return 0;
				};
				const like = meshes
					.flatMap((m) => [m.material].flat())
					.find((m) => (m as THREE.MeshBasicMaterial).map === map) as MToonMaterial | undefined;
				const shade = like?.isMToonMaterial ? like.shadeMultiplyTexture : null;
				// out of the suit: a triangle with a corner outside it, or within a little of its edge (not the
				// head: a model in one piece has its hair, eyes and brows there)
				done = paintOver(map, shade, meshes, faces, boneIndex, this.model.vroid, body, (corners, bone) => {
					if (body.head.has(bone)) return false;
					if (!this.model.vroid && isFoot(body, bone, feet)) return false;
					return corners.some((c) => plan.inside(c, bone) < 0.015 * s);
				});
				painted.set(map.source, done);
			}
			if (!done) continue;
			const { shade } = done;
			// (painted for another avatar of the model, whose textures are copies of these)
			const unchanged = done.texture.source === map.source;
			const texture = unchanged ? map : done.texture;
			for (const m of meshes)
				for (const mat of [m.material].flat()) {
					if ((mat as THREE.MeshBasicMaterial).map !== map || this.swap.has(mat)) continue;
					const shaded = mat as MToonMaterial;
					// a VRoid skin is drawn on both sides, and outlined: where skin was deleted under clothes, its
					// inside and the outline along its edges (where the new skin goes under them) would show dark
					const holed = this.model.vroid && plan.fill !== null;
					const twoSided = holed && mat.side === THREE.DoubleSide && !shaded.isOutline;
					const outline = holed && !!shaded.isOutline;
					if (unchanged && !twoSided && !outline) continue;
					const copy = mat.clone();
					if (outline) copy.visible = false;
					(copy as THREE.MeshBasicMaterial).map = texture;
					const copyShaded = copy as MToonMaterial;
					if (copyShaded.isMToonMaterial && copyShaded.shadeMultiplyTexture && shade && !unchanged)
						copyShaded.shadeMultiplyTexture = shade;
					if (twoSided) copy.side = THREE.FrontSide;
					this.swap.set(mat, copy);
					this.own.push(copy);
				}
		}
	}
}

/** The skin mesh with the most vertices (the body; the others are hands, feet and the like). */
function mainOf(skins: THREE.SkinnedMesh[]): THREE.SkinnedMesh {
	return skins.reduce((a, m) =>
		(m.geometry.attributes.position?.count ?? 0) > (a.geometry.attributes.position?.count ?? 0) ? m : a,
	);
}

function isFoot(body: Body, bone: number, feet: Set<number | undefined>): boolean {
	for (let o: THREE.Object3D | null = body.skeleton.bones[bone] ?? null; o; o = o.parent) {
		const i = body.skeleton.bones.indexOf(o as THREE.Bone);
		if (feet.has(i)) return true;
	}
	return false;
}

function geometryOf(d: MeshData): THREE.BufferGeometry {
	const g = new THREE.BufferGeometry();
	g.setAttribute("position", new THREE.BufferAttribute(d.pos, 3));
	g.setAttribute("normal", new THREE.BufferAttribute(d.nrm, 3));
	g.setAttribute("uv", new THREE.BufferAttribute(d.uv, 2));
	g.setAttribute("skinIndex", new THREE.BufferAttribute(d.joints, 4));
	g.setAttribute("skinWeight", new THREE.BufferAttribute(d.weights, 4));
	g.setIndex(new THREE.BufferAttribute(d.index, 1));
	return g;
}

// ---- the plan: new skin and the swimsuit, at rest ----

function planFor(body: Body, parts: Part[], kind: Suit): Plan | null {
	const inside = outline(body, kind);
	if (!inside) return null;
	const fill = parts.some((p) => p.kind === "cloth") ? skinFill(body, kind !== "trunks") : null;
	const main = mainOf(parts.filter((p) => p.kind === "skin").map((p) => p.mesh));
	const suit = suitOf(body, main, fill, inside);
	return suit ? { suit, fill, inside, fillUV: false } : null;
}

/**
 * Skin made again where VRoid deleted it under clothes, or null if nothing is missing: a smooth body modelled
 * from its bones and skin (bath-body.ts) for whatever is missing (the shoulders, the upper arms).
 */
function skinFill(body: Body, bust: boolean): MeshData | null {
	const s = body.size;
	const parts: Bare[] = [];
	const covered = body.skinTris;
	const shape = bodyShape(body, bust);
	if (shape) {
		// only where clothes were: the skin elsewhere is whole
		const box = new THREE.Box3();
		const p = new THREE.Vector3();
		const c = body.cloth;
		for (let i = 0; i < c.count; i++) box.expandByPoint(p.fromArray(c.pos, i * 3));
		if (!box.isEmpty()) {
			box.expandByScalar(0.03 * s);
			box.min.y = Math.max(box.min.y, body.floor + 0.02 * s);
			const part = bareOf(surfaceOf(shape, box, 0.011 * s), new TriangleGrid(covered, 0.03 * s), s);
			if (part) parts.push(part);
		}
	}
	if (parts.length === 0) return null;
	const pos: number[] = [];
	const nrm: number[] = [];
	const idx: number[] = [];
	for (const part of parts) {
		const base = pos.length / 3;
		pos.push(...part.pos);
		nrm.push(...part.nrm);
		for (const i of part.index) idx.push(base + i);
	}
	const fpos = new Float32Array(pos);
	const index = new Uint32Array(idx);
	const sources = mergeClouds([
		{ cloud: body.skin, keep: (i) => !body.head.has(body.skin.main[i] as number) },
		{ cloud: body.cloth, keep: () => true },
	]);
	const w = weightsFor(fpos, index, sources, 6, 3);
	return {
		pos: fpos,
		nrm: new Float32Array(nrm),
		uv: new Float32Array((fpos.length / 3) * 2),
		joints: w.joints,
		weights: w.weights,
		index,
	};
}

/** A piece of skin made again: positions, normals, triangles. */
interface Bare {
	pos: number[];
	nrm: number[];
	index: number[];
}

/**
 * The part of `surf` where there is no skin (`grid`: what is there), with rows round it tucked just under the
 * skin's edge; null if it is all covered.
 */
function bareOf(
	surf: { pos: Float32Array; nrm: Float32Array; index: Uint32Array },
	grid: TriangleGrid,
	s: number,
): Bare | null {
	const n = surf.pos.length / 3;
	if (n === 0) return null;
	// a vertex where there is no skin: none near it, or the nearest is off to the side (the edge of a hole),
	// not under it (where the shape bulges out of the skin) nor over it (inside the body)
	const bare = new Uint8Array(n);
	const at = new THREE.Vector3();
	const v = new THREE.Vector3();
	const nv = new THREE.Vector3();
	for (let i = 0; i < n; i++) {
		v.fromArray(surf.pos, i * 3);
		const d = grid.closest(v.x, v.y, v.z, 0.03 * s, at);
		if (d <= 0.005 * s) continue;
		const across = d < 0.03 * s ? Math.abs(v.sub(at).dot(nv.fromArray(surf.nrm, i * 3))) / d : 0;
		if (across < 0.5) bare[i] = 1;
	}
	// the triangles with such a vertex, and rows round them (tucked under the skin's edge)
	let keep = bare;
	for (let r = 0; r < 3; r++) {
		const next = new Uint8Array(keep);
		for (let t = 0; t < surf.index.length; t += 3) {
			const a = surf.index[t] as number;
			const b = surf.index[t + 1] as number;
			const d = surf.index[t + 2] as number;
			if (keep[a] || keep[b] || keep[d]) next[a] = next[b] = next[d] = 1;
		}
		keep = next;
	}
	const tris: number[] = [];
	for (let t = 0; t < surf.index.length; t += 3) {
		const a = surf.index[t] as number;
		const b = surf.index[t + 1] as number;
		const d = surf.index[t + 2] as number;
		if (keep[a] && keep[b] && keep[d]) tris.push(a, b, d);
	}
	// the rows by the skin's edge go just under it, so the skin overlaps them (no step, no gap)
	for (let i = 0; i < n; i++) {
		if (!keep[i] || bare[i]) continue;
		v.fromArray(surf.pos, i * 3);
		if (grid.closest(v.x, v.y, v.z, 0.03 * s, at) >= 0.03 * s) continue;
		nv.fromArray(surf.nrm, i * 3);
		const out = v.clone().sub(at).dot(nv) + 0.002 * s;
		if (out > 0) v.addScaledVector(nv, -out).toArray(surf.pos, i * 3);
	}
	if (tris.length === 0) return null;
	// compacted to the vertices used
	const remap = new Int32Array(n).fill(-1);
	const pos: number[] = [];
	const nrm: number[] = [];
	const index = tris.map((v) => {
		if (remap[v] === -1) {
			remap[v] = pos.length / 3;
			pos.push(surf.pos[v * 3] as number, surf.pos[v * 3 + 1] as number, surf.pos[v * 3 + 2] as number);
			nrm.push(surf.nrm[v * 3] as number, surf.nrm[v * 3 + 1] as number, surf.nrm[v * 3 + 2] as number);
		}
		return remap[v] as number;
	});
	return { pos, nrm, index };
}

/** Where a VroId model's breasts are at rest (its J_Sec_*_Bust2 bones, left then right), if it has them. */
function bustOf(body: Body): [THREE.Vector3, THREE.Vector3] | null {
	const at = (side: "L" | "R") => {
		const i = body.skeleton.bones.findIndex((b) => b.name.endsWith(`J_Sec_${side}_Bust2`));
		const inv = body.skeleton.boneInverses[i];
		return i >= 0 && inv ? new THREE.Vector3().setFromMatrixPosition(inv.clone().invert()) : null;
	};
	const l = at("L");
	const r = at("R");
	return l && r ? [l, r] : null;
}

// ---- the swimsuit's outline and its mesh, at rest ----

const smooth = (a: number, b: number, x: number) => {
	const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
	return t * t * (3 - 2 * t);
};

/**
 * How far a point of the body at rest (bind space) is inside the swimsuit's outline, in metres (negative
 * outside); `bone` is the bone that moves it most (the arms and the head are never in it). Null if the body
 * lacks the bones to measure it by.
 * - one-piece: up to just over the armpits in front (a little lower at the back), straps over the shoulders,
 *   and leg openings cut from the crotch up over the hip bones at the sides;
 * - trunks: from below the navel to a hand's breadth down the thighs.
 */
function outline(body: Body, kind: Suit): ((p: THREE.Vector3, bone: number) => number) | null {
	const s = body.size;
	const { at, front, left } = body;
	const [ul, ur, al, ar, neck] = [
		at.leftUpperLeg,
		at.rightUpperLeg,
		at.leftUpperArm,
		at.rightUpperArm,
		at.neck,
	];
	if (!ul || !ur || !al || !ar || !neck) return null;
	const centre = ul.clone().add(ur).multiplyScalar(0.5);
	const hip = centre.y;
	// half the hips' width (between the thighs' joints), and the shoulders'
	const legs = Math.abs(ul.clone().sub(ur).dot(left)) / 2;
	const shoulders = Math.abs(al.clone().sub(ar).dot(left)) / 2;
	const armpit = (al.y + ar.y) / 2 - 0.085 * s;
	const d = new THREE.Vector3();
	const out = (bone: number) => body.arm.has(bone) || body.head.has(bone);
	if (kind === "trunks") {
		const top = hip + 0.1 * s;
		const bottom = hip - 0.15 * s;
		return (p, bone) => (out(bone) ? -1 : Math.min(top - p.y, p.y - bottom));
	}
	const crotch = hip - 0.1 * s;
	const high = hip + 0.04 * s;
	if (kind === "bikini") {
		const bust = bustOf(body);
		if (!bust) return null;
		const [bl, br] = bust;
		// the cups: round over each breast, from just below it to a little above, a hand's width across
		const r = 0.068 * s;
		const yb = (bl.y + br.y) / 2;
		// the band under them round the back; from each cup's top a string up to the neck, and round it
		const band = yb - 0.055 * s;
		const lc = (Math.abs(bl.clone().sub(centre).dot(left)) + Math.abs(br.clone().sub(centre).dot(left))) / 2;
		const yTop = yb + r * 0.75;
		const yNeck = neck.y + 0.02 * s;
		const lNeck = 0.04 * s;
		const sw = 0.006 * s;
		const seg = (l: number, y: number) => {
			// distance in the front view (across, up) to the line from the cup's top to the neck
			const ax = lc;
			const ay = yTop;
			const bx = lNeck;
			const by = yNeck;
			const t = Math.max(
				0,
				Math.min(1, ((l - ax) * (bx - ax) + (y - ay) * (by - ay)) / ((bx - ax) ** 2 + (by - ay) ** 2)),
			);
			return Math.hypot(l - (ax + (bx - ax) * t), y - (ay + (by - ay) * t));
		};
		return (p, bone) => {
			if (out(bone)) return -1;
			d.subVectors(p, centre);
			const l = Math.abs(d.dot(left));
			// the bottom: briefs cut low at the front and high at the sides, all of it raised (waist and legs)
			// (the legs are raised in front; at the back the edge is a flat U under the cheeks, not a V running
			// down between the thighs)
			const back = 1 - smooth(-0.05 * s, 0.03 * s, d.dot(body.front));
			const t = smooth(0.15 * legs, 1.9 * legs, l) ** 0.8;
			const cutFront = crotch + RAISE * s + (high - crotch) * t;
			const fold = hip - 0.06 * s;
			const cutBack = fold + (high - fold) * smooth(0.3 * legs, 1.9 * legs, l) ** 1.6;
			const cut = cutFront + (cutBack - cutFront) * back;
			const briefs = Math.min(hip + (0.035 + RAISE) * s - p.y, p.y - cut);
			// the top: the cups (only in front: none through the back), the band, the strings
			const front = d.dot(body.front) > 0;
			// (and a little piece joining them in the middle)
			const gore = Math.min(0.012 * s - l, 0.018 * s - Math.abs(p.y - (yb - 0.01 * s)));
			const cups = front ? Math.max(r - p.distanceTo(bl), r - p.distanceTo(br), gore) : -1;
			const under = 0.011 * s - Math.abs(p.y - band);
			// strings in front (to the neck) and round the neck at its root
			const strings = Math.max(
				front ? sw - seg(l, p.y) : -1,
				Math.min(sw - Math.abs(p.y - yNeck), 0.09 * s - Math.hypot(d.dot(left), d.dot(body.front))),
			);
			// (a band only below the cups, joining them at the sides and the back)
			return Math.max(briefs, cups, Math.min(under, yb - p.y), strings);
		};
	}
	const strap = shoulders * 0.5;
	const strapW = 0.013 * s;
	const over = neck.y + 0.06 * s;
	return (p, bone) => {
		if (out(bone)) return -1;
		d.subVectors(p, centre);
		const l = Math.abs(d.dot(left));
		const f = d.dot(front);
		// higher in front than at the back, scooped a little between the straps
		const top =
			armpit -
			0.04 * s +
			0.09 * s * smooth(-0.06 * s, 0.04 * s, f) -
			0.04 * s * (1 - smooth(0.3 * strap, strap, l));
		// the leg openings: at the crotch in the middle, rising over the hip bones at the sides
		const cut = crotch + (high - crotch) * smooth(0.15 * legs, 1.9 * legs, l) ** 0.8;
		const body0 = Math.min(top - p.y, p.y - cut);
		// a strap over each shoulder, from the top in front to the top at the back
		const band = Math.min(strapW - Math.abs(l - strap), over - p.y, p.y - (top - 0.02 * s));
		return Math.max(body0, band);
	};
}

/**
 * Where the cheeks part at the back, the suit is made to run straight across instead of dipping into the cleft
 * (its lifted vertices there cross and show a grey gap): the middle's vertices at the back move out to the
 * plane of the cheeks' rearmost vertices on either side, facing straight back.
 */
function bridgeCleft(body: Body, pos: number[], nrm: number[]): void {
	const { at, front, left, size: s } = body;
	const ul = at.leftUpperLeg;
	const ur = at.rightUpperLeg;
	if (!ul || !ur) return;
	const centre = ul.clone().add(ur).multiplyScalar(0.5);
	const d = new THREE.Vector3();
	const seen = (i: number) => {
		d.fromArray(pos, i * 3).sub(centre);
		return { l: Math.abs(d.dot(left)), f: d.dot(front), y: d.y };
	};
	// the cheeks' rearmost point, a little to either side of the middle
	let rear = 0;
	for (let i = 0; i < pos.length / 3; i++) {
		const v = seen(i);
		if (v.l > 0.045 * s && v.l < 0.09 * s && v.y < 0.02 * s && v.y > -0.09 * s) rear = Math.min(rear, v.f);
	}
	if (rear >= 0) return;
	for (let i = 0; i < pos.length / 3; i++) {
		const v = seen(i);
		if (v.l >= 0.07 * s || v.f >= 0 || v.f <= rear || v.y > 0.02 * s || v.y < -0.12 * s) continue;
		const k = (rear - v.f) * (1 - smooth(0.03 * s, 0.07 * s, v.l));
		pos[i * 3] = (pos[i * 3] as number) + front.x * k;
		pos[i * 3 + 1] = (pos[i * 3 + 1] as number) + front.y * k;
		pos[i * 3 + 2] = (pos[i * 3 + 2] as number) + front.z * k;
		// and it faces straight back, not into the cleft
		const w = 1 - smooth(0.03 * s, 0.07 * s, v.l);
		d.fromArray(nrm, i * 3)
			.lerp(front.clone().negate(), w)
			.normalize()
			.toArray(nrm, i * 3);
	}
}

/** How much higher a bikini's bottom sits than the plain low-rise cut (times the body's size). */
const RAISE = 0.03;

/** How far the swimsuit stands off the skin (times the body's size, metres). */
const LIFT = 0.0035;

/**
 * The swimsuit at rest: the skin's triangles inside the outline (the main skin mesh, and the skin made again
 * where VRoid deleted it), cut along the outline, lifted off the skin along its normals, each vertex moved by
 * the bones of the skin under it.
 */
function suitOf(
	body: Body,
	main: THREE.SkinnedMesh,
	fill: MeshData | null,
	inside: (p: THREE.Vector3, bone: number) => number,
): MeshData | null {
	const s = body.size;
	const pos: number[] = [];
	const nrm: number[] = [];
	const joints: number[] = [];
	const weights: number[] = [];
	interface V {
		p: THREE.Vector3;
		n: THREE.Vector3;
		j: number[];
		w: number[];
		f: number;
	}
	const emit = (v: V) => {
		pos.push(v.p.x + v.n.x * LIFT * s, v.p.y + v.n.y * LIFT * s, v.p.z + v.n.z * LIFT * s);
		nrm.push(v.n.x, v.n.y, v.n.z);
		joints.push(...v.j);
		weights.push(...v.w);
	};
	const heaviest = (j: number[], w: number[]) => {
		let best = 0;
		for (let c = 1; c < 4; c++) if ((w[c] as number) > (w[best] as number)) best = c;
		return j[best] as number;
	};
	/**
	 * A point `t` along the edge from `a` to `b`: its bones are both ends' blended (the same whichever way
	 * round the edge is taken, so the two triangles on it move it alike and do not part).
	 */
	const along = (a: V, b: V, t: number): V => {
		const sum = new Map<number, number>();
		for (const [v, k] of [
			[a, 1 - t],
			[b, t],
		] as const)
			v.j.forEach((j, c) => {
				sum.set(j, (sum.get(j) ?? 0) + (v.w[c] as number) * k);
			});
		const top = [...sum].sort((x, y) => y[1] - x[1] || x[0] - y[0]).slice(0, 4);
		while (top.length < 4) top.push([0, 0]);
		const total = top.reduce((m, [, w]) => m + w, 0) || 1;
		const j = top.map(([i]) => i);
		const w = top.map(([, x]) => x / total);
		const p = a.p.clone().lerp(b.p, t);
		return { p, n: a.n.clone().lerp(b.n, t).normalize(), j, w, f: inside(p, heaviest(j, w)) };
	};
	// where an edge crosses the outline (on it)
	const cross = (a: V, b: V): V => ({ ...along(a, b, a.f / (a.f - b.f)), f: 0 });
	// the middle of an edge, for cutting finer along the outline
	const mid = (a: V, b: V): V => along(a, b, 0.5);
	/**
	 * The part of a triangle inside the outline (none, a triangle, or a quad as two). One the outline crosses
	 * is first cut in four, three times, so the edge follows the outline's curves and thin strings show (the
	 * skin's triangles are large).
	 */
	const clip = (tri: V[], depth = 0) => {
		const [a, b, c] = tri as [V, V, V];
		const crossed = tri.some((v) => v.f >= 0) && tri.some((v) => v.f < 0);
		if (crossed && depth < 3) {
			const ab = mid(a, b);
			const bc = mid(b, c);
			const ca = mid(c, a);
			for (const t of [
				[a, ab, ca],
				[ab, b, bc],
				[ca, bc, c],
				[ab, bc, ca],
			])
				clip(t, depth + 1);
			return;
		}
		const poly: V[] = [];
		for (let i = 0; i < 3; i++) {
			const a = tri[i] as V;
			const b = tri[(i + 1) % 3] as V;
			if (a.f >= 0) poly.push(a);
			if (a.f >= 0 !== b.f >= 0) poly.push(cross(a, b));
		}
		for (let i = 1; i + 1 < poly.length; i++) {
			emit(poly[0] as V);
			emit(poly[i] as V);
			emit(poly[i + 1] as V);
		}
	};
	// the main skin, in bind space (its skeleton is the body's)
	const g = main.geometry;
	const gp = g.attributes.position;
	const gn = g.attributes.normal;
	const gj = g.attributes.skinIndex;
	const gw = g.attributes.skinWeight;
	if (gp && gn && gj && gw) {
		const nm = new THREE.Matrix3().getNormalMatrix(main.bindMatrix);
		const verts: V[] = [];
		for (let i = 0; i < gp.count; i++) {
			const j = [0, 1, 2, 3].map((c) => gj.getComponent(i, c));
			const w = [0, 1, 2, 3].map((c) => gw.getComponent(i, c));
			const p = new THREE.Vector3().fromBufferAttribute(gp, i).applyMatrix4(main.bindMatrix);
			const n = new THREE.Vector3().fromBufferAttribute(gn, i).applyMatrix3(nm).normalize();
			verts.push({ p, n, j, w, f: inside(p, heaviest(j, w)) });
		}
		const idx = g.index;
		const count = idx ? idx.count : gp.count;
		for (let t = 0; t + 2 < count; t += 3) {
			const tri = [0, 1, 2].map((k) => verts[idx ? idx.getX(t + k) : t + k] as V);
			if (tri.some((v) => v.f >= 0)) clip(tri);
		}
	}
	// the skin made again where clothes were
	if (fill) {
		const verts: V[] = [];
		for (let i = 0; i < fill.pos.length / 3; i++) {
			const j = [...fill.joints.subarray(i * 4, i * 4 + 4)];
			const w = [...fill.weights.subarray(i * 4, i * 4 + 4)];
			const p = new THREE.Vector3().fromArray(fill.pos, i * 3);
			verts.push({
				p,
				n: new THREE.Vector3().fromArray(fill.nrm, i * 3),
				j,
				w,
				f: inside(p, heaviest(j, w)),
			});
		}
		for (let t = 0; t + 2 < fill.index.length; t += 3) {
			const tri = [0, 1, 2].map((k) => verts[fill.index[t + k] as number] as V);
			if (tri.some((v) => v.f >= 0)) clip(tri);
		}
	}
	bridgeCleft(body, pos, nrm);
	const n = pos.length / 3;
	if (n === 0) return null;
	return {
		pos: new Float32Array(pos),
		nrm: new Float32Array(nrm),
		uv: new Float32Array(n * 2),
		joints: new Uint16Array(joints),
		weights: new Float32Array(weights),
		index: Uint32Array.from({ length: n }, (_, i) => i),
	};
}

// ---- painting over painted clothes ----

/**
 * The skin texture `map` (and its shade texture) with what is not skin painted over on the triangles of
 * `meshes` that `uncovered(corners, bone)` says are out of the suit (the textures themselves if they cannot be
 * read or have nothing to paint over), and a spot of plain skin on it.
 */
function paintOver(
	map: THREE.Texture,
	shade: THREE.Texture | null,
	meshes: THREE.SkinnedMesh[],
	faces: THREE.SkinnedMesh[],
	boneIndex: (bone: THREE.Object3D | undefined) => number,
	vroid: boolean,
	body: Body,
	uncovered: (corners: THREE.Vector3[], bone: number) => boolean,
): Painted {
	const unchanged: Painted = { texture: map, shade, skin: null };
	const { w, h } = sizeOf(map);
	if (!w || !h) return unchanged;
	const px = pixelsOf(map.image, w, h);
	if (!px) return unchanged;
	const sample = (out: number[], data: Uint8ClampedArray, dw: number, dh: number, u: number, v: number) => {
		const x = Math.min(dw - 1, Math.max(0, Math.floor((u - Math.floor(u)) * dw)));
		const y = Math.min(dh - 1, Math.max(0, Math.floor((v - Math.floor(v)) * dh)));
		const i = (y * dw + x) * 4;
		if ((data[i + 3] as number) > 200)
			out.push(data[i] as number, data[i + 1] as number, data[i + 2] as number);
	};
	// the skin's colour: from the face if there is one (VRoid), else from the skin itself
	const samples: number[] = [];
	for (const f of faces) {
		if (
			!/_SKIN/.test(
				[f.material]
					.flat()
					.map((m) => m.name)
					.join(" "),
			)
		)
			continue;
		const fmap = [f.material]
			.flat()
			.map((m) => (m as THREE.MeshBasicMaterial).map)
			.find((t) => t);
		const fuv = f.geometry.attributes.uv;
		if (!fmap || !fuv) continue;
		const fs = sizeOf(fmap);
		const fpx = fmap === map ? px : pixelsOf(fmap.image, fs.w, fs.h);
		if (!fpx) continue;
		for (let i = 0; i < fuv.count; i += 3) sample(samples, fpx, fs.w, fs.h, fuv.getX(i), fuv.getY(i));
	}
	// the trunk's own skin: what skin made again there is coloured like (a face is often lighter than a body)
	const trunk = new Set(
		[body.bone.spine, body.bone.chest, body.bone.upperChest].filter((b) => b !== undefined),
	);
	const trunkSamples: number[] = [];
	const uvTris: number[] = [];
	/** Triangles' middles (UV), where plain skin may be. */
	const middles: number[] = [];
	const p = new THREE.Vector3();
	for (const m of meshes) {
		const g = m.geometry;
		const uv = g.attributes.uv;
		const pos = g.attributes.position;
		const si = g.attributes.skinIndex;
		const sw = g.attributes.skinWeight;
		if (!uv || !pos || !si || !sw) continue;
		const bones = m.skeleton.bones;
		const mainOf = (i: number) => {
			let best = 0;
			for (let c = 1; c < 4; c++) if (sw.getComponent(i, c) > sw.getComponent(i, best)) best = c;
			return boneIndex(bones[si.getComponent(i, best)]);
		};
		const at = new Float32Array(pos.count * 3);
		for (let i = 0; i < pos.count; i++)
			p.fromBufferAttribute(pos, i)
				.applyMatrix4(m.bindMatrix)
				.toArray(at, i * 3);
		const corners = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
		const idx = g.index;
		const n = idx ? idx.count : pos.count;
		for (let t = 0; t + 2 < n; t += 3) {
			const a = idx ? idx.getX(t) : t;
			const b = idx ? idx.getX(t + 1) : t + 1;
			const c = idx ? idx.getX(t + 2) : t + 2;
			// with no face to go by, the arms and the legs (bare, or the suit would hide them anyway)
			const main = mainOf(a);
			if (faces.length === 0 && t % 3 === 0 && (body.arm.has(main) || body.leg.has(main)))
				sample(samples, px, w, h, uv.getX(a), uv.getY(a));
			if (trunk.has(main) && t % 3 === 0) sample(trunkSamples, px, w, h, uv.getX(a), uv.getY(a));
			if (t % 6 === 0)
				middles.push((uv.getX(a) + uv.getX(b) + uv.getX(c)) / 3, (uv.getY(a) + uv.getY(b) + uv.getY(c)) / 3);
			corners[0]?.fromArray(at, a * 3);
			corners[1]?.fromArray(at, b * 3);
			corners[2]?.fromArray(at, c * 3);
			if (!uncovered(corners, main)) continue;
			uvTris.push(uv.getX(a), uv.getY(a), uv.getX(b), uv.getY(b), uv.getX(c), uv.getY(c));
		}
	}
	const tone: Tone | null = toneOf(samples);
	if (!tone) return unchanged;
	const skin = new Uint8Array(w * h);
	let some = false;
	const where = maskOf(uvTris, w, h);
	for (let i = 0; i < w * h; i++) {
		skin[i] = isSkin(tone, px[i * 4] as number, px[i * 4 + 1] as number, px[i * 4 + 2] as number) ? 1 : 0;
		if (!skin[i] && where[i] && (px[i * 4 + 3] as number) >= 8) some = true;
	}
	const body0 = toneOf(trunkSamples) ?? tone;
	const spot = plainSkin(middles, px, skin, w, h, body0);
	if (!some) return { ...unchanged, skin: spot };
	const local = vroid ? 0.6 : 0;
	const texture = textureFrom(paintSkin(px, w, h, skin, where, body0.rgb, local), w, h, map);
	// the shade texture (MToon) the same way, by the same pixels of skin
	let shaded = shade;
	if (shade === map) shaded = texture;
	else if (shade && sizeOf(shade).w === w && sizeOf(shade).h === h) {
		const spx = pixelsOf(shade.image, w, h);
		shaded = spx ? textureFrom(paintSkin(spx, w, h, skin, where, body0.rgb, local), w, h, shade) : shade;
	}
	return { texture, shade: shaded, skin: spot };
}

function sizeOf(t: THREE.Texture): { w: number; h: number } {
	const image = t.image as { width?: number; height?: number } | undefined;
	return { w: image?.width ?? 0, h: image?.height ?? 0 };
}

/** A texture of RGBA pixels, sampled like `like`. */
function textureFrom(px: Uint8ClampedArray, w: number, h: number, like: THREE.Texture): THREE.Texture {
	const canvas = document.createElement("canvas");
	canvas.width = w;
	canvas.height = h;
	canvas.getContext("2d")?.putImageData(new ImageData(px as Uint8ClampedArray<ArrayBuffer>, w, h), 0, 0);
	const tex = new THREE.CanvasTexture(canvas);
	tex.flipY = like.flipY;
	tex.colorSpace = like.colorSpace;
	tex.wrapS = like.wrapS;
	tex.wrapT = like.wrapT;
	tex.magFilter = like.magFilter;
	tex.minFilter = like.minFilter;
	tex.anisotropy = like.anisotropy;
	tex.offset.copy(like.offset);
	tex.repeat.copy(like.repeat);
	tex.channel = like.channel;
	return tex;
}

/** Of `middles` (UVs), one where the skin is plain all round (5 x 5 pixels of skin) and nearest the tone. */
function plainSkin(
	middles: number[],
	px: Uint8ClampedArray,
	skin: Uint8Array,
	w: number,
	h: number,
	tone: Tone,
): [number, number] | null {
	let best: [number, number] | null = null;
	let bestD = Infinity;
	for (let m = 0; m + 1 < middles.length; m += 2) {
		const u = middles[m] as number;
		const v = middles[m + 1] as number;
		const x = Math.floor((u - Math.floor(u)) * w);
		const y = Math.floor((v - Math.floor(v)) * h);
		if (x < 2 || y < 2 || x > w - 3 || y > h - 3) continue;
		let plain = true;
		let d = 0;
		for (let dy = -2; dy <= 2 && plain; dy++)
			for (let dx = -2; dx <= 2; dx++) {
				const i = (y + dy) * w + x + dx;
				if (!skin[i] || (px[i * 4 + 3] as number) < 250) {
					plain = false;
					break;
				}
				for (let c = 0; c < 3; c++) d += Math.abs((px[i * 4 + c] as number) - (tone.rgb[c] as number));
			}
		if (plain && d < bestD) {
			bestD = d;
			best = [(x + 0.5) / w, (y + 0.5) / h];
		}
	}
	return best;
}

// ---- the swimsuit's look ----

/** Swimsuit colours (sRGB): each model always wears the same one. */
const ONE_PIECE = ["#1f2b4d", "#7b1e2e", "#135a5c", "#262626", "#3d2b5c"];
const TRUNKS = ["#1f2b4d", "#262626", "#2f4a2a", "#5a1f1f"];

/** A number in [0, 1) from a string (FNV-1a). */
function hash01(s: string): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
	return (h >>> 0) / 2 ** 32;
}

/** The swimsuit's material: toon-shaded like the avatar (MToon) or lit like it (standard), a little glossy. */
function suitMaterial(like: THREE.Material | THREE.Material[], model: BathModel): THREE.Material {
	const list = model.suit === "trunks" ? TRUNKS : ONE_PIECE;
	const color = new THREE.Color(list[Math.floor(hash01(model.key) * list.length)] as string);
	const first = [like].flat()[0] as THREE.Material | undefined;
	if ((first as MToonMaterial | undefined)?.isMToonMaterial)
		return new MToonMaterial({
			color,
			shadeColorFactor: color.clone().multiplyScalar(0.55),
			shadingToonyFactor: 0.8,
			shadingShiftFactor: -0.1,
			giEqualizationFactor: 0.9,
			rimLightingMixFactor: 1,
			parametricRimColorFactor: new THREE.Color(0.22, 0.22, 0.24),
			parametricRimFresnelPowerFactor: 4,
		});
	return new THREE.MeshStandardMaterial({ color, roughness: 0.45, metalness: 0 });
}
