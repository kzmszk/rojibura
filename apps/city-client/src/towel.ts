// In the bath (the onsen inn's open-air bath and its changing room): an avatar takes its clothes off and has a
// white bath towel wrapped round it from the armpits to mid-thigh, tucked in at the chest, like a modest
// onsen scene on television. The towel always covers the chest to the thighs; shoulders, arms and legs are
// bare.
//
// The towel is a skinned mesh on the avatar's own skeleton, made from the body at rest: rings round the trunk
// and the thighs (the body's outline at each height, taut over the waist like cloth, hanging a little loose
// below the hips), each vertex moved by the bones that move the skin under it, so it walks, sits, lies and
// hugs with the body. Clothes are hidden (VRoid's "…_CLOTH" meshes); skin VRoid deleted under them and
// clothes painted on the skin are dealt with in bath-body.ts. Everything is made the first time the avatar
// bathes (and what does not depend on the avatar is kept for the next one of the same model); after that,
// going in and out is only switching meshes and materials.

import { MToonMaterial } from "@pixiv/three-vrm";
import * as THREE from "three";
import {
	type Body,
	bodyShape,
	type Cloud,
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

/** A mesh's vertices: what a towel or new skin is made of. Shared by every avatar of the model. */
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
	towel: MeshData;
	/** Skin made again where it was deleted under clothes; on the main skin's material. */
	fill: MeshData | null;
	/** The towel's top and bottom (bind space y). */
	top: number;
	bottom: number;
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

const towelColor = new THREE.Color(1, 1, 1);
const towelShade = new THREE.Color(0.74, 0.74, 0.79);

/** Ours: the towel and the new skin (not the model's own meshes). */
const OURS = "rj-towel";

export class Bath {
	private built = false;
	private on = false;
	private towel: THREE.SkinnedMesh | null = null;
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
	 * In the bath or not: switching meshes and materials. The first time in, the towel is made: some hundreds
	 * of milliseconds for the first avatar of a model, some tens for the next (see `prepare`).
	 */
	set(on: boolean): void {
		if (on) this.prepare();
		this.on = on;
		if (!this.towel) return;
		this.towel.visible = on;
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

	/** Makes the towel (and the rest) now, if not made yet, without going in: e.g. when the avatar is idle. */
	prepare(): void {
		if (!this.built) this.build();
	}

	dispose(): void {
		if (this.on) this.set(false);
		for (const m of [this.towel, this.fill]) {
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
		this.towel = null;
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
		let plan = plans.get(this.model.key);
		if (plan === undefined) {
			const b = measured();
			plan = b ? planFor(b, parts) : null;
			plans.set(this.model.key, plan);
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

		const towel = new THREE.SkinnedMesh(geometryOf(plan.towel), towelMaterial(main.material));
		this.towel = this.attach(towel, `${OURS}`, main.skeleton, parent);
		this.own.push(towel.material as THREE.Material);
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
		// on the main skin's skeleton (the towel's bone indices are its), in bind space
		mesh.bind(skeleton, new THREE.Matrix4());
		mesh.castShadow = true;
		mesh.frustumCulled = false;
		mesh.visible = false;
		parent.add(mesh);
		return mesh;
	}

	/**
	 * Bath materials for the skin: clothes painted on the skin texture are painted over with skin where the
	 * towel does not cover them (socks, trousers, a T-shirt's shoulders). Underwear under the towel stays.
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
				// out of the towel: what reaches above its top or below its hem (by a little), and the arms
				done = paintOver(map, shade, meshes, faces, boneIndex, this.model.vroid, body, (low, high, bone) => {
					if (!this.model.vroid && isFoot(body, bone, feet)) return false;
					return high > plan.top - 0.03 * s || low < plan.bottom + 0.03 * s || body.arm.has(bone);
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

// ---- the plan: new skin and the towel, at rest ----

function planFor(body: Body, parts: Part[]): Plan | null {
	const s = body.size;
	const { at } = body;
	const ua = [at.leftUpperArm, at.rightUpperArm];
	const ul = [at.leftUpperLeg, at.rightUpperLeg];
	const ll = [at.leftLowerLeg, at.rightLowerLeg];
	if (!ua[0] || !ua[1] || !ul[0] || !ul[1] || !ll[0] || !ll[1]) return null;
	const armpit = (ua[0].y + ua[1].y) / 2 - 0.085 * s;
	const hip = (ul[0].y + ul[1].y) / 2;
	const knee = (ll[0].y + ll[1].y) / 2;
	const top = armpit;
	const bottom = hip - (hip - knee) * 0.45;
	const fill = parts.some((p) => p.kind === "cloth") ? skinFill(body) : null;
	const towel = towelOf(body, fill, top, bottom);
	return towel ? { towel, fill, top, bottom, fillUV: false } : null;
}

/** Skin made again where VRoid deleted it under clothes (bath-body.ts), or null if nothing is missing. */
function skinFill(body: Body): MeshData | null {
	const s = body.size;
	const shape = bodyShape(body);
	if (!shape) return null;
	// only where clothes were: the skin elsewhere is whole
	const box = new THREE.Box3();
	const p = new THREE.Vector3();
	const c = body.cloth;
	for (let i = 0; i < c.count; i++) box.expandByPoint(p.fromArray(c.pos, i * 3));
	if (box.isEmpty()) return null;
	box.expandByScalar(0.03 * s);
	box.min.y = Math.max(box.min.y, body.floor + 0.02 * s);
	const surf = surfaceOf(shape, box, 0.011 * s);
	const n = surf.pos.length / 3;
	if (n === 0) return null;
	const grid = new TriangleGrid(body.skinTris, 0.03 * s);
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
	const index = new Uint32Array(tris.length);
	tris.forEach((v, i) => {
		if (remap[v] === -1) {
			remap[v] = pos.length / 3;
			pos.push(surf.pos[v * 3] as number, surf.pos[v * 3 + 1] as number, surf.pos[v * 3 + 2] as number);
			nrm.push(surf.nrm[v * 3] as number, surf.nrm[v * 3 + 1] as number, surf.nrm[v * 3 + 2] as number);
		}
		index[i] = remap[v] as number;
	});
	const fpos = new Float32Array(pos);
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

const RINGS = 18;
const COLUMNS = 72;
/** Where the towel's end is tucked in: this far round from the front towards the wearer's left (radians). */
const TUCK = 0.5;
/** How far round the end lies over the towel (radians). */
const OVERLAP = 1.4;

/**
 * The towel at rest: rings from mid-thigh up to the armpits round the body's outline (the trunk and both
 * thighs together, not the arms), taut over hollows, with a rolled hem at the top and the bottom, the end
 * lying over the towel and tucked in at the chest, soft folds below the hips, and a terry texture.
 */
function towelOf(body: Body, fill: MeshData | null, top: number, bottom: number): MeshData | null {
	const s = body.size;
	const { front, left } = body;
	// the outline at each height, from the skin and the new skin (not arms, not the head)
	const pts: [number, number, number][] = [];
	const skin = body.skin;
	for (let i = 0; i < skin.count; i++) {
		const b = skin.main[i] as number;
		if (body.arm.has(b) || body.head.has(b)) continue;
		pts.push([skin.pos[i * 3] as number, skin.pos[i * 3 + 1] as number, skin.pos[i * 3 + 2] as number]);
	}
	if (fill)
		for (let i = 0; i < fill.pos.length / 3; i++) {
			if (body.arm.has(fill.joints[i * 4] as number)) continue;
			pts.push([fill.pos[i * 3] as number, fill.pos[i * 3 + 1] as number, fill.pos[i * 3 + 2] as number]);
		}
	const ys = Array.from({ length: RINGS }, (_, k) => bottom + ((top - bottom) * k) / (RINGS - 1));
	const half = ((top - bottom) / (RINGS - 1)) * 0.8;
	const hulls = ys.map((y) => hull2(pts.filter((p) => Math.abs(p[1] - y) < half).map((p) => [p[0], p[2]])));
	// one upright axis through the middle of them all
	let cx = 0;
	let cz = 0;
	let nh = 0;
	for (const h of hulls) {
		if (h.length < 3) continue;
		const [x, z] = centroid(h);
		cx += x;
		cz += z;
		nh++;
	}
	if (nh === 0) return null;
	cx /= nh;
	cz /= nh;
	// radius at each ring and column (angle from the front towards the left, starting at the tuck)
	const angle = (j: number) => TUCK - (j / COLUMNS) * Math.PI * 2;
	const dirOf = (a: number): [number, number] => [
		front.x * Math.cos(a) + left.x * Math.sin(a),
		front.z * Math.cos(a) + left.z * Math.sin(a),
	];
	const r: number[][] = hulls.map((h) =>
		Array.from({ length: COLUMNS + 1 }, (_, j) => (h.length >= 3 ? rayHull(h, cx, cz, dirOf(angle(j))) : -1)),
	);
	// rings with no outline take their neighbours'
	for (let k = 0; k < RINGS; k++) {
		if ((r[k] as number[])[0] !== -1) continue;
		const below = [...r.slice(0, k)].reverse().find((x) => x[0] !== -1);
		const above = r.slice(k + 1).find((x) => x[0] !== -1);
		r[k] = (above ?? below ?? []).slice();
		if ((r[k] as number[]).length === 0) return null;
	}
	// smooth round each ring
	for (const ring of r)
		for (let pass = 0; pass < 3; pass++) {
			const old = ring.slice(0, COLUMNS);
			for (let j = 0; j < COLUMNS; j++)
				ring[j] =
					((old[(j + COLUMNS - 1) % COLUMNS] as number) +
						2 * (old[j] as number) +
						(old[(j + 1) % COLUMNS] as number)) /
					4;
			ring[COLUMNS] = ring[0] as number;
		}
	// up each column: taut over hollows (the waist), and hanging from the hips rather than hugging the thighs
	for (let j = 0; j <= COLUMNS; j++) {
		const col = r.map((ring) => ring[j] as number);
		const env = upperEnvelope(ys, col);
		let hipK = 0;
		for (let k = 0; k < Math.ceil(RINGS * 0.6); k++) if ((env[k] as number) > (env[hipK] as number)) hipK = k;
		const rh = env[hipK] as number;
		const yh = ys[hipK] as number;
		for (let k = 0; k < RINGS; k++) {
			let v = env[k] as number;
			if (k < hipK)
				v = Math.max(v, rh * (1 - 0.1 * ((yh - (ys[k] as number)) / Math.max(1e-6, yh - bottom))));
			(r[k] as number[])[j] = v;
		}
	}

	// the cloth: rings out from the body, with a hem rolled at each end and the end lying over the towel
	const gap = 0.013 * s;
	const thick = 0.005 * s;
	const rand = mulberry32(7);
	// the profile from the inside of the bottom hem round to the inside of the top one: ring, radial offset,
	// height offset, texture v (0 top, 1 bottom)
	const profile: [k: number, dr: number, dy: number, v: number][] = [];
	profile.push(
		[0, -0.011 * s, 0.03 * s, 1.0],
		[0, -0.008 * s, 0.002 * s, 1.0],
		[0, -0.002 * s, -0.006 * s, 0.99],
	);
	for (let k = 0; k < RINGS; k++) profile.push([k, 0, 0, 0.97 - (k / (RINGS - 1)) * 0.94]);
	profile.push(
		[RINGS - 1, -0.001 * s, 0.006 * s, 0.01],
		[RINGS - 1, -0.007 * s, 0.004 * s, 0.0],
		[RINGS - 1, -0.01 * s, -0.03 * s, 0.0],
	);
	const rows = profile.length;
	const pos: number[] = [];
	const uv: number[] = [];
	const radiusAt = (k: number, j: number, dr: number, row: number) => {
		const phi = (j / COLUMNS) * Math.PI * 2;
		// the end lies over the towel for OVERLAP before the tuck, thickening in from nothing
		const over =
			phi > Math.PI * 2 - OVERLAP ? Math.min(1, (phi - (Math.PI * 2 - OVERLAP)) / 0.35) * thick : 0;
		const y = ys[k] as number;
		// soft folds below the hips, deeper towards the hem
		const low = Math.max(0, Math.min(1, (bottom + (top - bottom) * 0.45 - y) / ((top - bottom) * 0.45)));
		const fold = low * low * 0.0045 * s * (0.5 + 0.5 * Math.sin(phi * 7 + Math.sin(phi * 3) * 1.3));
		const noise = (rand() - 0.5) * 0.0012 * s * (row > 2 && row < rows - 3 ? 1 : 0);
		return ((r[k] as number[])[j] as number) + gap + over + fold + noise + dr;
	};
	for (let row = 0; row < rows; row++) {
		const [k, dr, dy, v] = profile[row] as [number, number, number, number];
		for (let j = 0; j <= COLUMNS; j++) {
			const [dx, dz] = dirOf(angle(j));
			const rad = radiusAt(k, j, dr, row);
			pos.push(cx + dx * rad, (ys[k] as number) + dy, cz + dz * rad);
			uv.push((j / COLUMNS) * 5, v);
		}
	}
	const index: number[] = [];
	const at = (row: number, j: number) => row * (COLUMNS + 1) + j;
	for (let row = 0; row < rows - 1; row++)
		for (let j = 0; j < COLUMNS; j++) {
			const a = at(row, j);
			const b = at(row, j + 1);
			const c = at(row + 1, j + 1);
			const d = at(row + 1, j);
			// the columns go round from the front to the right: this way faces out
			index.push(a, c, b, a, d, c);
		}
	// smooth normals over the cloth; the edge and the tucked corner below keep theirs
	const sheet = new THREE.BufferGeometry();
	sheet.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
	sheet.setIndex(index);
	sheet.computeVertexNormals();
	const nrm = Array.from((sheet.attributes.normal as THREE.BufferAttribute).array as Float32Array);
	sheet.dispose();
	// the end's edge: from the outer layer (last column) down to the towel under it (first column), both ways
	for (let row = 2; row < rows - 3; row++) {
		const a = at(row, COLUMNS);
		const b = at(row, 0);
		const c = at(row + 1, 0);
		const d = at(row + 1, COLUMNS);
		index.push(a, b, c, a, c, d, a, c, b, a, d, c);
	}
	// the tucked corner: a little fold of the end standing out at the top, by the tuck (both ways)
	const tuckBase = pos.length / 3;
	const kTop = RINGS - 1;
	const corner = (j: number, dk: number, out: number) => {
		const [dx, dz] = dirOf(angle(j));
		const rad = radiusAt(kTop - dk, j, out, 5);
		pos.push(cx + dx * rad, (ys[kTop - dk] as number) + 0.002 * s, cz + dz * rad);
		nrm.push(dx, 0.3, dz);
		uv.push((j / COLUMNS) * 5, 0.05 + dk * 0.05);
	};
	corner(COLUMNS - 1, 0, 0.004 * s);
	corner(COLUMNS - 6, 0, 0.003 * s);
	corner(COLUMNS - 2, 3, 0.002 * s);
	corner(COLUMNS - 4, 1, 0.006 * s);
	for (const [a, b, c] of [
		[0, 3, 1],
		[0, 2, 3],
		[3, 2, 1],
	] as const)
		index.push(tuckBase + a, tuckBase + b, tuckBase + c, tuckBase + a, tuckBase + c, tuckBase + b);

	const fpos = new Float32Array(pos);
	const findex = new Uint32Array(index);
	// the bones that move the skin under each part (not the arms, not the head)
	const trunk = (cloud: Cloud) => (i: number) =>
		!body.arm.has(cloud.main[i] as number) && !body.head.has(cloud.main[i] as number);
	const parts = [{ cloud: skin, keep: trunk(skin) }];
	if (fill) {
		const fc = cloudFrom(fill);
		parts.push({ cloud: fc, keep: trunk(fc) });
	}
	const w = weightsFor(fpos, findex, mergeClouds(parts), 10, 2);
	legsUnder(body, fpos, w, cx, cz);
	return {
		pos: fpos,
		nrm: new Float32Array(nrm),
		uv: new Float32Array(uv),
		joints: w.joints,
		weights: w.weights,
		index: findex,
	};
}

/**
 * Below the crotch the towel goes with the thighs: each side with its own thigh, the middle (front and back)
 * half and half, so it lies over the lap and is sat on rather than hanging from the hips.
 */
function legsUnder(
	body: Body,
	pos: Float32Array,
	w: { joints: Uint16Array; weights: Float32Array },
	cx: number,
	cz: number,
): void {
	const { leftUpperLeg: l, rightUpperLeg: r } = body.at;
	const bl = body.bone.leftUpperLeg;
	const br = body.bone.rightUpperLeg;
	if (!l || !r || bl === undefined || br === undefined) return;
	const s = body.size;
	const crotch = (l.y + r.y) / 2 - 0.06 * s;
	const half = Math.max(0.02, Math.abs(l.clone().sub(r).dot(body.left)) / 2);
	for (let i = 0; i < pos.length / 3; i++) {
		const y = pos[i * 3 + 1] as number;
		const f = Math.max(0, Math.min(1, (crotch + 0.03 * s - y) / (0.08 * s)));
		if (f <= 0) continue;
		const side =
			((pos[i * 3] as number) - cx) * body.left.x + ((pos[i * 3 + 2] as number) - cz) * body.left.z;
		const toLeft = Math.max(0, Math.min(1, 0.5 + side / half));
		const sum = new Map<number, number>();
		for (let c = 0; c < 4; c++) {
			const b = w.joints[i * 4 + c] as number;
			sum.set(b, (sum.get(b) ?? 0) + (w.weights[i * 4 + c] as number) * (1 - f));
		}
		sum.set(bl, (sum.get(bl) ?? 0) + f * toLeft);
		sum.set(br, (sum.get(br) ?? 0) + f * (1 - toLeft));
		const top = [...sum].sort((a, b) => b[1] - a[1]).slice(0, 4);
		const total = top.reduce((t, [, v]) => t + v, 0) || 1;
		for (let c = 0; c < 4; c++) {
			const e = top[c];
			w.joints[i * 4 + c] = e ? e[0] : 0;
			w.weights[i * 4 + c] = e ? e[1] / total : 0;
		}
	}
}

function cloudFrom(d: MeshData): Cloud {
	const count = d.pos.length / 3;
	const main = new Uint16Array(count);
	for (let i = 0; i < count; i++) main[i] = d.joints[i * 4] as number;
	return { count, pos: d.pos, nrm: d.nrm, joints: d.joints, weights: d.weights, main };
}

/** Convex hull of 2D points (counter-clockwise), Andrew's monotone chain. */
function hull2(points: [number, number][]): [number, number][] {
	const p = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
	if (p.length < 3) return p;
	const cross = (o: [number, number], a: [number, number], b: [number, number]) =>
		(a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
	const lower: [number, number][] = [];
	for (const q of p) {
		while (
			lower.length >= 2 &&
			cross(lower[lower.length - 2] as [number, number], lower[lower.length - 1] as [number, number], q) <= 0
		)
			lower.pop();
		lower.push(q);
	}
	const upper: [number, number][] = [];
	for (let i = p.length - 1; i >= 0; i--) {
		const q = p[i] as [number, number];
		while (
			upper.length >= 2 &&
			cross(upper[upper.length - 2] as [number, number], upper[upper.length - 1] as [number, number], q) <= 0
		)
			upper.pop();
		upper.push(q);
	}
	return lower.slice(0, -1).concat(upper.slice(0, -1));
}

function centroid(h: [number, number][]): [number, number] {
	let x = 0;
	let z = 0;
	for (const p of h) {
		x += p[0];
		z += p[1];
	}
	return [x / h.length, z / h.length];
}

/** How far from (cx, cz) along `dir` the ray leaves the convex polygon `h` (0 if it starts outside). */
function rayHull(h: [number, number][], cx: number, cz: number, dir: [number, number]): number {
	let best = 0;
	for (let i = 0; i < h.length; i++) {
		const a = h[i] as [number, number];
		const b = h[(i + 1) % h.length] as [number, number];
		const ex = b[0] - a[0];
		const ez = b[1] - a[1];
		const den = dir[0] * ez - dir[1] * ex;
		if (Math.abs(den) < 1e-9) continue;
		const t = ((a[0] - cx) * ez - (a[1] - cz) * ex) / den;
		const u = ((a[0] - cx) * dir[1] - (a[1] - cz) * dir[0]) / den;
		if (t > 0 && u >= -1e-6 && u <= 1 + 1e-6) best = Math.max(best, t);
	}
	return best;
}

/** The least concave curve over (x, y) points (x ascending): their upper hull, read at each x. */
function upperEnvelope(xs: number[], ys: number[]): number[] {
	const hull: number[] = [];
	for (let i = 0; i < xs.length; i++) {
		while (hull.length >= 2) {
			const a = hull[hull.length - 2] as number;
			const b = hull[hull.length - 1] as number;
			const cross =
				((xs[b] as number) - (xs[a] as number)) * ((ys[i] as number) - (ys[a] as number)) -
				((ys[b] as number) - (ys[a] as number)) * ((xs[i] as number) - (xs[a] as number));
			if (cross >= 0) hull.pop();
			else break;
		}
		hull.push(i);
	}
	const out: number[] = [];
	let h = 0;
	for (let i = 0; i < xs.length; i++) {
		while (h < hull.length - 2 && (xs[hull[h + 1] as number] as number) < (xs[i] as number)) h++;
		const a = hull[h] as number;
		const b = hull[Math.min(h + 1, hull.length - 1)] as number;
		const xa = xs[a] as number;
		const xb = xs[b] as number;
		const u = xb > xa ? ((xs[i] as number) - xa) / (xb - xa) : 0;
		out.push((ys[a] as number) + ((ys[b] as number) - (ys[a] as number)) * Math.max(0, Math.min(1, u)));
	}
	return out;
}

function mulberry32(seed: number): () => number {
	let a = seed;
	return () => {
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

// ---- painting over painted clothes ----

/**
 * The skin texture `map` (and its shade texture) with what is not skin painted over on the triangles of
 * `meshes` that `uncovered(lowest y, highest y, bone)` says are out of the towel (the textures themselves if
 * they cannot be read or have nothing to paint over), and a spot of plain skin on it.
 */
function paintOver(
	map: THREE.Texture,
	shade: THREE.Texture | null,
	meshes: THREE.SkinnedMesh[],
	faces: THREE.SkinnedMesh[],
	boneIndex: (bone: THREE.Object3D | undefined) => number,
	vroid: boolean,
	body: Body,
	uncovered: (low: number, high: number, bone: number) => boolean,
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
		const ys = new Float32Array(pos.count);
		for (let i = 0; i < pos.count; i++) ys[i] = p.fromBufferAttribute(pos, i).applyMatrix4(m.bindMatrix).y;
		const idx = g.index;
		const n = idx ? idx.count : pos.count;
		for (let t = 0; t + 2 < n; t += 3) {
			const a = idx ? idx.getX(t) : t;
			const b = idx ? idx.getX(t + 1) : t + 1;
			const c = idx ? idx.getX(t + 2) : t + 2;
			const ya = ys[a] as number;
			const yb = ys[b] as number;
			const yc = ys[c] as number;
			// with no face to go by, the arms and the legs (bare, or the towel would hide them anyway)
			const main = mainOf(a);
			if (faces.length === 0 && t % 3 === 0 && (body.arm.has(main) || body.leg.has(main)))
				sample(samples, px, w, h, uv.getX(a), uv.getY(a));
			if (t % 6 === 0)
				middles.push((uv.getX(a) + uv.getX(b) + uv.getX(c)) / 3, (uv.getY(a) + uv.getY(b) + uv.getY(c)) / 3);
			if (!uncovered(Math.min(ya, yb, yc), Math.max(ya, yb, yc), main)) continue;
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
	const spot = plainSkin(middles, px, skin, w, h, tone);
	if (!some) return { ...unchanged, skin: spot };
	const local = vroid ? 0.6 : 0;
	const texture = textureFrom(paintSkin(px, w, h, skin, where, tone.rgb, local), w, h, map);
	// the shade texture (MToon) the same way, by the same pixels of skin
	let shaded = shade;
	if (shade === map) shaded = texture;
	else if (shade && sizeOf(shade).w === w && sizeOf(shade).h === h) {
		const spx = pixelsOf(shade.image, w, h);
		shaded = spx ? textureFrom(paintSkin(spx, w, h, skin, where, tone.rgb, local), w, h, shade) : shade;
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

// ---- the towel's look ----

let terryTexture: THREE.Texture | null = null;

/** Terry cloth: off-white, a fine weave of loops, and a woven band near each hem (v: 0 top, 1 bottom). */
function terry(): THREE.Texture {
	if (terryTexture) return terryTexture;
	const W = 256;
	const H = 512;
	const c = document.createElement("canvas");
	c.width = W;
	c.height = H;
	const g = c.getContext("2d") as CanvasRenderingContext2D;
	g.fillStyle = "#f2efe8";
	g.fillRect(0, 0, W, H);
	const rand = mulberry32(11);
	for (let i = 0; i < 14000; i++) {
		const x = rand() * W;
		const y = rand() * H;
		const l = rand();
		g.strokeStyle =
			l < 0.5 ? `rgba(150,140,125,${0.12 + l * 0.2})` : `rgba(255,255,252,${0.25 + (l - 0.5) * 0.4})`;
		g.lineWidth = 0.8;
		g.beginPath();
		g.arc(x, y, 0.8 + rand() * 1.1, 0, Math.PI * 2);
		g.stroke();
	}
	// the woven bands: flat ribs across, a little darker
	for (const [y0, y1] of [
		[0.045, 0.085],
		[0.915, 0.955],
	] as const) {
		g.fillStyle = "rgba(205,196,182,0.55)";
		g.fillRect(0, y0 * H, W, (y1 - y0) * H);
		g.fillStyle = "rgba(255,255,255,0.5)";
		for (let y = y0 * H; y < y1 * H; y += 3) g.fillRect(0, y, W, 1);
	}
	const t = new THREE.CanvasTexture(c);
	t.flipY = false;
	t.wrapS = THREE.RepeatWrapping;
	t.wrapT = THREE.ClampToEdgeWrapping;
	t.colorSpace = THREE.SRGBColorSpace;
	t.anisotropy = 4;
	terryTexture = t;
	return t;
}

/** The towel's material: toon-shaded like the avatar (MToon) or lit like it (standard). */
function towelMaterial(like: THREE.Material | THREE.Material[]): THREE.Material {
	const first = [like].flat()[0] as THREE.Material | undefined;
	if ((first as MToonMaterial | undefined)?.isMToonMaterial)
		return new MToonMaterial({
			color: towelColor,
			map: terry(),
			shadeColorFactor: towelShade,
			shadeMultiplyTexture: terry(),
			shadingToonyFactor: 0.7,
			shadingShiftFactor: -0.1,
			giEqualizationFactor: 0.9,
		});
	return new THREE.MeshStandardMaterial({ color: 0xffffff, map: terry(), roughness: 0.95, metalness: 0 });
}
