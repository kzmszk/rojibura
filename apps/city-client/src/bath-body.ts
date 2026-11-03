// What a body looks like with its clothes off, for the bath (swimsuit.ts). Everything here works on the body at
// rest, in its skeleton's bind space (where the skinned meshes' vertices are before any bone moves them).
//
// A VRoid model's clothes are separate meshes (materials named "…_CLOTH"), but VRoid deletes the skin hidden
// under them, so taking them off can leave the shoulders, the upper arms or the chest missing. Clothes can
// also be painted on the skin's own texture (socks, a T-shirt, trousers). So, for a body in the bath:
// - painted clothes outside the swimsuit are painted over with skin (the colours of the skin around them), and
// - skin that was deleted is made again: a smooth body is modelled from the bones and the skin that is left
//   (tubes for the limbs and the neck, slices for the trunk), and the part of it where no skin is gets drawn,
//   skinned to the bones like the skin around it.

import * as THREE from "three";

export type Kind = "skin" | "face" | "cloth" | "hair" | "other";

/** What a mesh of an avatar is, by its material's name (VRoid's naming; anything else is skin). */
export function kindOf(mesh: THREE.Mesh): Kind {
	const names = [mesh.material]
		.flat()
		.map((m) => m.name)
		.join(" ");
	if (/_CLOTH/.test(names)) return "cloth";
	if (/_HAIR/.test(names)) return "hair";
	if (/_FACE|_EYE|Face_\d+_SKIN/.test(names)) return "face";
	if (/wing/i.test(`${names} ${mesh.name}`)) return "other";
	return "skin";
}

/** Humanoid bones the bath measures the body by. */
export const JOINTS = [
	"hips",
	"spine",
	"chest",
	"upperChest",
	"neck",
	"head",
	"leftShoulder",
	"leftUpperArm",
	"leftLowerArm",
	"leftHand",
	"rightShoulder",
	"rightUpperArm",
	"rightLowerArm",
	"rightHand",
	"leftUpperLeg",
	"leftLowerLeg",
	"leftFoot",
	"rightUpperLeg",
	"rightLowerLeg",
	"rightFoot",
] as const;
export type Joint = (typeof JOINTS)[number];

/** Vertices at rest: position, normal, four bones (indices into the body's skeleton) and their weights. */
export interface Cloud {
	count: number;
	pos: Float32Array;
	nrm: Float32Array;
	joints: Uint16Array;
	weights: Float32Array;
	/** The bone that moves each vertex most. */
	main: Uint16Array;
}

export interface Body {
	skeleton: THREE.Skeleton;
	/** Where each joint is at rest. */
	at: Partial<Record<Joint, THREE.Vector3>>;
	bone: Partial<Record<Joint, number>>;
	/** Unit vectors to the body's front and its left (up is +y). */
	front: THREE.Vector3;
	left: THREE.Vector3;
	/** About 1 for a grown-up VRoid model (the head bone 1.4 m above the feet). */
	size: number;
	/** The feet's height. */
	floor: number;
	/** Bones of the arms (from the upper arm out), the legs (from the thigh down) and the head (and up). */
	arm: Set<number>;
	leg: Set<number>;
	head: Set<number>;
	/** Skin (and face) vertices, and the clothes' vertices. */
	skin: Cloud;
	cloth: Cloud;
	/** Skin and face triangles (9 floats each), for how far something is from the skin. */
	skinTris: Float32Array;
}

export interface Part {
	mesh: THREE.SkinnedMesh;
	kind: Kind;
}

const v3 = new THREE.Vector3();
const m4 = new THREE.Matrix4();
const m3 = new THREE.Matrix3();

function boneSet(skeleton: THREE.Skeleton, roots: (THREE.Object3D | undefined)[]): Set<number> {
	const out = new Set<number>();
	skeleton.bones.forEach((b, i) => {
		for (let o: THREE.Object3D | null = b; o; o = o.parent)
			if (roots.includes(o)) {
				out.add(i);
				return;
			}
	});
	return out;
}

/** The vertices of `parts` (all of the same skeleton's bones) in bind space, bones by `skeleton`'s indices. */
function cloudOf(parts: THREE.SkinnedMesh[], skeleton: THREE.Skeleton): { cloud: Cloud; tris: number[] } {
	const index = new Map(skeleton.bones.map((b, i) => [b as THREE.Object3D, i]));
	const indexOf = (b: THREE.Object3D | undefined): number => {
		for (let o: THREE.Object3D | null | undefined = b; o; o = o.parent) {
			const i = index.get(o);
			if (i !== undefined) return i;
		}
		return 0;
	};
	let count = 0;
	for (const m of parts) count += m.geometry.attributes.position?.count ?? 0;
	const cloud: Cloud = {
		count,
		pos: new Float32Array(count * 3),
		nrm: new Float32Array(count * 3),
		joints: new Uint16Array(count * 4),
		weights: new Float32Array(count * 4),
		main: new Uint16Array(count),
	};
	const tris: number[] = [];
	let at = 0;
	for (const m of parts) {
		const g = m.geometry;
		const pos = g.attributes.position;
		const nrm = g.attributes.normal;
		const si = g.attributes.skinIndex;
		const sw = g.attributes.skinWeight;
		if (!pos || !si || !sw) continue;
		const map = m.skeleton.bones.map((b) => indexOf(b));
		m3.getNormalMatrix(m.bindMatrix);
		for (let i = 0; i < pos.count; i++) {
			const k = at + i;
			v3.fromBufferAttribute(pos, i)
				.applyMatrix4(m.bindMatrix)
				.toArray(cloud.pos, k * 3);
			if (nrm)
				v3.fromBufferAttribute(nrm, i)
					.applyMatrix3(m3)
					.normalize()
					.toArray(cloud.nrm, k * 3);
			let best = -1;
			for (let c = 0; c < 4; c++) {
				const j = map[si.getComponent(i, c)] ?? 0;
				const w = sw.getComponent(i, c);
				cloud.joints[k * 4 + c] = j;
				cloud.weights[k * 4 + c] = w;
				if (w > best) {
					best = w;
					cloud.main[k] = j;
				}
			}
		}
		const idx = g.index;
		const n = idx ? idx.count : pos.count;
		for (let t = 0; t + 2 < n; t += 3)
			for (let c = 0; c < 3; c++) {
				const i = at + (idx ? idx.getX(t + c) : t + c);
				tris.push(cloud.pos[i * 3] as number, cloud.pos[i * 3 + 1] as number, cloud.pos[i * 3 + 2] as number);
			}
		at += pos.count;
	}
	return { cloud, tris };
}

/** Measures a body at rest. `bones`: the bones that move the skin, by humanoid name. */
export function measureBody(parts: Part[], bones: Partial<Record<string, THREE.Object3D>>): Body | null {
	const skins = parts.filter((p) => p.kind === "skin").map((p) => p.mesh);
	const main = skins.reduce<THREE.SkinnedMesh | null>(
		(a, m) =>
			!a || (m.geometry.attributes.position?.count ?? 0) > (a.geometry.attributes.position?.count ?? 0)
				? m
				: a,
		null,
	);
	if (!main) return null;
	const skeleton = main.skeleton;
	const at: Body["at"] = {};
	const bone: Body["bone"] = {};
	for (const j of JOINTS) {
		const node = bones[j];
		const i = node ? skeleton.bones.indexOf(node as THREE.Bone) : -1;
		const inv = skeleton.boneInverses[i];
		if (i < 0 || !inv) continue;
		bone[j] = i;
		at[j] = new THREE.Vector3().setFromMatrixPosition(m4.copy(inv).invert());
	}
	const { hips, head, leftUpperLeg, rightUpperLeg, leftFoot, rightFoot } = at;
	if (!hips || !head || !leftUpperLeg || !rightUpperLeg) return null;
	const floor = Math.min(leftFoot?.y ?? 0, rightFoot?.y ?? 0);
	const up = new THREE.Vector3(0, 1, 0);
	const left = leftUpperLeg.clone().sub(rightUpperLeg).setY(0).normalize();
	const front = left.clone().cross(up).normalize();
	const skin = cloudOf(
		parts.filter((p) => p.kind === "skin" || p.kind === "face").map((p) => p.mesh),
		skeleton,
	);
	const cloth = cloudOf(
		parts.filter((p) => p.kind === "cloth").map((p) => p.mesh),
		skeleton,
	);
	const node = (j: Joint) => bones[j];
	return {
		skeleton,
		at,
		bone,
		front,
		left,
		size: (head.y - floor) / 1.4,
		floor,
		arm: boneSet(skeleton, [node("leftUpperArm"), node("rightUpperArm")]),
		leg: boneSet(skeleton, [node("leftUpperLeg"), node("rightUpperLeg")]),
		head: boneSet(skeleton, [node("head")]),
		skin: skin.cloud,
		cloth: cloth.cloud,
		skinTris: new Float32Array(skin.tris),
	};
}

// ---- finding things near a point ----

/** Points in a grid of cells, for the nearest few. */
export class PointGrid {
	private readonly cells = new Map<number, number[]>();
	private readonly pos: Float32Array;
	private readonly cell: number;
	constructor(pos: Float32Array, cell: number, keep: (i: number) => boolean = () => true) {
		this.pos = pos;
		this.cell = cell;
		for (let i = 0; i < pos.length / 3; i++) {
			if (!keep(i)) continue;
			const k = this.key(
				Math.floor((pos[i * 3] as number) / cell),
				Math.floor((pos[i * 3 + 1] as number) / cell),
				Math.floor((pos[i * 3 + 2] as number) / cell),
			);
			const c = this.cells.get(k);
			if (c) c.push(i);
			else this.cells.set(k, [i]);
		}
	}

	private key(x: number, y: number, z: number): number {
		return ((x + 512) * 1024 + (y + 512)) * 1024 + (z + 512);
	}

	/** Up to `k` nearest points within `max`: [index, distance] nearest first. */
	nearest(x: number, y: number, z: number, k: number, max: number): [number, number][] {
		const out: [number, number][] = [];
		const cx = Math.floor(x / this.cell);
		const cy = Math.floor(y / this.cell);
		const cz = Math.floor(z / this.cell);
		const reach = Math.ceil(max / this.cell);
		for (let r = 0; r <= reach; r++) {
			// a shell of cells r away; once k are found nearer than the shell, nothing further can beat them
			if (out.length >= k && (out[k - 1] as [number, number])[1] <= (r - 1) * this.cell) break;
			for (let i = -r; i <= r; i++)
				for (let j = -r; j <= r; j++)
					for (let l = -r; l <= r; l++) {
						if (Math.max(Math.abs(i), Math.abs(j), Math.abs(l)) !== r) continue;
						const c = this.cells.get(this.key(cx + i, cy + j, cz + l));
						if (!c) continue;
						for (const p of c) {
							const dx = (this.pos[p * 3] as number) - x;
							const dy = (this.pos[p * 3 + 1] as number) - y;
							const dz = (this.pos[p * 3 + 2] as number) - z;
							const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
							if (d > max) continue;
							out.push([p, d]);
						}
					}
			out.sort((a, b) => a[1] - b[1]);
			if (out.length > k) out.length = k;
		}
		return out;
	}
}

/** Triangles in a grid of cells, for how far a point is from the nearest. */
export class TriangleGrid {
	private readonly cells = new Map<number, number[]>();
	private readonly tris: Float32Array;
	private readonly cell: number;
	constructor(tris: Float32Array, cell: number) {
		this.tris = tris;
		this.cell = cell;
		for (let t = 0; t < tris.length / 9; t++) {
			let x0 = Infinity;
			let y0 = Infinity;
			let z0 = Infinity;
			let x1 = -Infinity;
			let y1 = -Infinity;
			let z1 = -Infinity;
			for (let c = 0; c < 3; c++) {
				const x = tris[t * 9 + c * 3] as number;
				const y = tris[t * 9 + c * 3 + 1] as number;
				const z = tris[t * 9 + c * 3 + 2] as number;
				x0 = Math.min(x0, x);
				y0 = Math.min(y0, y);
				z0 = Math.min(z0, z);
				x1 = Math.max(x1, x);
				y1 = Math.max(y1, y);
				z1 = Math.max(z1, z);
			}
			for (let i = Math.floor(x0 / cell); i <= Math.floor(x1 / cell); i++)
				for (let j = Math.floor(y0 / cell); j <= Math.floor(y1 / cell); j++)
					for (let l = Math.floor(z0 / cell); l <= Math.floor(z1 / cell); l++) {
						const k = this.key(i, j, l);
						const c = this.cells.get(k);
						if (c) c.push(t);
						else this.cells.set(k, [t]);
					}
		}
	}

	private key(x: number, y: number, z: number): number {
		return ((x + 512) * 1024 + (y + 512)) * 1024 + (z + 512);
	}

	/** How far the nearest triangle is from (x, y, z), or `max` if none is that near. */
	distance(x: number, y: number, z: number, max: number): number {
		return this.closest(x, y, z, max, null);
	}

	/** How far the nearest triangle is (or `max`), and the nearest point on it into `at` (if given and found). */
	closest(x: number, y: number, z: number, max: number, at: THREE.Vector3 | null): number {
		let best = max;
		const reach = Math.ceil(max / this.cell);
		const cx = Math.floor(x / this.cell);
		const cy = Math.floor(y / this.cell);
		const cz = Math.floor(z / this.cell);
		const seen = new Set<number>();
		for (let i = -reach; i <= reach; i++)
			for (let j = -reach; j <= reach; j++)
				for (let l = -reach; l <= reach; l++) {
					const c = this.cells.get(this.key(cx + i, cy + j, cz + l));
					if (!c) continue;
					for (const t of c) {
						if (seen.has(t)) continue;
						seen.add(t);
						const d = pointTriangle(x, y, z, this.tris, t * 9);
						if (d < best) {
							best = d;
							at?.copy(v3);
						}
					}
				}
		return best;
	}
}

const pa = new THREE.Vector3();
const pb = new THREE.Vector3();
const pc = new THREE.Vector3();
const pp = new THREE.Vector3();
const tri = new THREE.Triangle();

function pointTriangle(x: number, y: number, z: number, t: Float32Array, o: number): number {
	pa.fromArray(t, o);
	pb.fromArray(t, o + 3);
	pc.fromArray(t, o + 6);
	tri.set(pa, pb, pc);
	pp.set(x, y, z);
	return tri.closestPointToPoint(pp, v3).distanceTo(pp);
}

// ---- skin weights ----

/** The vertices of some clouds that pass `keep`, as one. */
export function mergeClouds(parts: { cloud: Cloud; keep: (i: number) => boolean }[]): Cloud {
	const picked: [Cloud, number][] = [];
	for (const { cloud, keep } of parts)
		for (let i = 0; i < cloud.count; i++) if (keep(i)) picked.push([cloud, i]);
	const count = picked.length;
	const out: Cloud = {
		count,
		pos: new Float32Array(count * 3),
		nrm: new Float32Array(count * 3),
		joints: new Uint16Array(count * 4),
		weights: new Float32Array(count * 4),
		main: new Uint16Array(count),
	};
	picked.forEach(([c, i], k) => {
		out.pos.set(c.pos.subarray(i * 3, i * 3 + 3), k * 3);
		out.nrm.set(c.nrm.subarray(i * 3, i * 3 + 3), k * 3);
		out.joints.set(c.joints.subarray(i * 4, i * 4 + 4), k * 4);
		out.weights.set(c.weights.subarray(i * 4, i * 4 + 4), k * 4);
		out.main[k] = c.main[i] as number;
	});
	return out;
}

/**
 * Skin weights for new vertices, from the nearest of the body's own (each nearer one counting more), smoothed
 * over the new mesh's edges so it bends evenly. Returns four bones and weights per vertex.
 */
export function weightsFor(
	pos: Float32Array,
	index: ArrayLike<number>,
	cloud: Cloud,
	k: number,
	smooth: number,
): { joints: Uint16Array; weights: Float32Array } {
	const grid = new PointGrid(cloud.pos, 0.03);
	const n = pos.length / 3;
	// the bones that turn up, numbered compactly: each vertex's weights as a dense row
	const slot = new Map<number, number>();
	const bones: number[] = [];
	const rows: [number, number][][] = [];
	for (let i = 0; i < n; i++) {
		const x = pos[i * 3] as number;
		const y = pos[i * 3 + 1] as number;
		const z = pos[i * 3 + 2] as number;
		const near = grid.nearest(x, y, z, k, 0.4);
		const row: [number, number][] = [];
		const d0 = near[0]?.[1] ?? 0;
		for (const [p, d] of near) {
			const f = 1 / (0.004 + (d - d0)) ** 2;
			for (let c = 0; c < 4; c++) {
				const wc = (cloud.weights[p * 4 + c] as number) * f;
				if (wc <= 0) continue;
				const b = cloud.joints[p * 4 + c] as number;
				let sl = slot.get(b);
				if (sl === undefined) {
					sl = bones.length;
					slot.set(b, sl);
					bones.push(b);
				}
				row.push([sl, wc]);
			}
		}
		rows.push(row);
	}
	const m = Math.max(1, bones.length);
	let cur = new Float32Array(n * m);
	rows.forEach((row, i) => {
		let sum = 0;
		for (const [, w] of row) sum += w;
		for (const [sl, w] of row) cur[i * m + sl] = (cur[i * m + sl] as number) + w / (sum || 1);
	});
	// neighbours by the triangles' edges
	const nb: Set<number>[] = Array.from({ length: n }, () => new Set());
	for (let t = 0; t + 2 < index.length; t += 3)
		for (let c = 0; c < 3; c++) {
			const a = index[t + c] as number;
			const b = index[t + ((c + 1) % 3)] as number;
			nb[a]?.add(b);
			nb[b]?.add(a);
		}
	// each round: half its own, half its neighbours' average
	for (let s = 0; s < smooth; s++) {
		const next = new Float32Array(n * m);
		for (let i = 0; i < n; i++) {
			const ns = nb[i] as Set<number>;
			const share = ns.size > 0 ? 0.5 / ns.size : 0;
			for (let b = 0; b < m; b++) next[i * m + b] = (cur[i * m + b] as number) * (ns.size > 0 ? 0.5 : 1);
			for (const j of ns)
				for (let b = 0; b < m; b++) add(next, i * m + b, (cur[j * m + b] as number) * share);
		}
		cur = next;
	}
	const joints = new Uint16Array(n * 4);
	const weights = new Float32Array(n * 4);
	const top: number[] = [];
	for (let i = 0; i < n; i++) {
		top.length = 0;
		for (let b = 0; b < m; b++) if ((cur[i * m + b] as number) > 0) top.push(b);
		top.sort((a, b) => (cur[i * m + b] as number) - (cur[i * m + a] as number));
		if (top.length > 4) top.length = 4;
		let sum = 0;
		for (const b of top) sum += cur[i * m + b] as number;
		top.forEach((b, c) => {
			joints[i * 4 + c] = bones[b] as number;
			weights[i * 4 + c] = (cur[i * m + b] as number) / (sum || 1);
		});
		if (top.length === 0) weights[i * 4] = 1;
	}
	return { joints, weights };
}

// ---- the body as a smooth shape ----

interface Slice {
	y: number;
	cx: number;
	cz: number;
	/** Half widths across (x) and front to back (z). */
	a: number;
	b: number;
}

const smin = (a: number, b: number, k: number) => {
	const h = Math.max(k - Math.abs(a - b), 0) / k;
	return Math.min(a, b) - h * h * k * 0.25;
};

/** A tube from a to b, its radius going from ra to rb: about how far p is outside it. */
function tube(p: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3, ra: number, rb: number): number {
	const abx = b.x - a.x;
	const aby = b.y - a.y;
	const abz = b.z - a.z;
	const len2 = abx * abx + aby * aby + abz * abz || 1;
	const t = Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.y - a.y) * aby + (p.z - a.z) * abz) / len2));
	const dx = p.x - a.x - abx * t;
	const dy = p.y - a.y - aby * t;
	const dz = p.z - a.z - abz * t;
	const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
	return d - (ra + (rb - ra) * t);
}

/** How far points of `cloud` (whose main bone passes `keep`) lie from the line a-b, near each end. */
function radiiAlong(
	cloud: Cloud,
	keep: (i: number) => boolean,
	a: THREE.Vector3,
	b: THREE.Vector3,
): [number | null, number | null] {
	const ab = b.clone().sub(a);
	const len2 = ab.lengthSq() || 1;
	const ends: number[][] = [[], []];
	for (let i = 0; i < cloud.count; i++) {
		if (!keep(i)) continue;
		v3.fromArray(cloud.pos, i * 3).sub(a);
		const t = v3.dot(ab) / len2;
		if (t < 0.05 || t > 0.95) continue;
		const d = v3.addScaledVector(ab, -t).length();
		if (t < 0.4) ends[0]?.push(d);
		else if (t > 0.6) ends[1]?.push(d);
	}
	const fit = (ds: number[]) => {
		if (ds.length < 12) return null;
		ds.sort((x, y) => x - y);
		return (ds[Math.floor(ds.length * 0.4)] as number) * 0.97;
	};
	return [fit(ends[0] as number[]), fit(ends[1] as number[])];
}

/**
 * The body as a smooth shape (negative inside): the trunk in slices fitted to its skin (made up where the skin
 * is missing), and tubes for the neck, shoulders, arms and legs, all blended together.
 */
export function bodyShape(body: Body): ((p: THREE.Vector3) => number) | null {
	const { at, skin, size: s } = body;
	const { neck, head, hips, leftUpperArm, rightUpperArm, leftUpperLeg, rightUpperLeg } = at;
	if (!neck || !head || !hips || !leftUpperArm || !rightUpperArm || !leftUpperLeg || !rightUpperLeg)
		return null;
	const isSkin = (bone: number | undefined) => (i: number) => skin.main[i] === bone;
	const tubes: [THREE.Vector3, THREE.Vector3, number, number][] = [];

	const limb = (a: Joint, b: Joint, c: Joint, defaults: [number, number, number]) => {
		const pa = at[a];
		const pb = at[b];
		const pc = at[c];
		if (!pa || !pb) return;
		const upper = radiiAlong(skin, isSkin(body.bone[a]), pa, pb);
		const lower = pc ? radiiAlong(skin, isSkin(body.bone[b]), pb, pc) : [null, null];
		const [d0, d1, d2] = defaults.map((d) => d * s) as [number, number, number];
		const rb = lower[0] ?? upper[1] ?? d1;
		const rc = lower[1] ?? rb * (d2 / d1);
		const ra = upper[0] ?? Math.max(rb * (d0 / d1), upper[1] ?? 0);
		tubes.push([pa, pb, ra, upper[1] ?? rb]);
		if (pc) tubes.push([pb, pc, lower[0] ?? rb, rc]);
	};
	for (const side of ["left", "right"] as const) {
		limb(`${side}UpperArm`, `${side}LowerArm`, `${side}Hand`, [0.045, 0.035, 0.026]);
		limb(`${side}UpperLeg`, `${side}LowerLeg`, `${side}Foot`, [0.08, 0.05, 0.032]);
	}
	// the neck, a little into the trunk and up into the head
	const neckR = radiiAlong(skin, isSkin(body.bone.neck), neck, head);
	const rn = Math.min(neckR[0] ?? neckR[1] ?? 0.042 * s, 0.06 * s);
	tubes.push([neck.clone().setY(neck.y - 0.04 * s), head.clone().setY(head.y + 0.02 * s), rn, rn * 0.95]);

	// the trunk: slices from the crotch up to the shoulders, each reaching as far to the right, left, front and
	// back as the skin there does (each way on its own: what is left of the skin still counts), and made up
	// (from the slices above and below, and the shoulders) where there is no skin that way
	const axis = new THREE.Vector3((leftUpperArm.x + rightUpperArm.x) / 2, 0, at.spine?.z ?? hips.z);
	const y0 = Math.min(leftUpperLeg.y, rightUpperLeg.y) - 0.05 * s;
	const yShoulder = (leftUpperArm.y + rightUpperArm.y) / 2;
	const yNeck = neck.y;
	const step = 0.015 * s;
	const trunk = (i: number) =>
		!body.arm.has(skin.main[i] as number) && !body.head.has(skin.main[i] as number);
	const ys: number[] = [];
	// reach to +x, -x, +z, -z
	const reach: (number | null)[][] = [[], [], [], []];
	for (let y = y0; y <= yShoulder - 0.02 * s; y += step) {
		const far = [-1, -1, -1, -1];
		for (let i = 0; i < skin.count; i++) {
			const py = skin.pos[i * 3 + 1] as number;
			if (Math.abs(py - y) > step || !trunk(i)) continue;
			const dx = (skin.pos[i * 3] as number) - axis.x;
			const dz = (skin.pos[i * 3 + 2] as number) - axis.z;
			if (Math.abs(dx) > 0.3 * s) continue;
			// the way it lies from the axis (within 45 degrees)
			const way = Math.abs(dx) >= Math.abs(dz) ? (dx > 0 ? 0 : 1) : dz > 0 ? 2 : 3;
			far[way] = Math.max(far[way] as number, Math.abs(way < 2 ? dx : dz));
		}
		ys.push(y);
		for (let w = 0; w < 4; w++)
			(reach[w] as (number | null)[]).push((far[w] as number) > 0 ? (far[w] as number) : null);
	}
	const half = Math.abs(leftUpperArm.x - rightUpperArm.x) / 2;
	// at the shoulders: the trunk is narrower than the shoulder joints, and a little less deep than below
	const depth = (w: number) => {
		const known = (reach[w] as (number | null)[]).filter((v): v is number => v !== null);
		return Math.min((known[known.length - 1] ?? 0.09 * s) * 0.92, 0.1 * s);
	};
	const shoulderReach = [half * 0.72, half * 0.72, depth(2), depth(3)];
	const filled = reach.map((list, w) => fillGaps(ys, list, shoulderReach[w] as number));
	const table: Slice[] = ys.map((y, k) => {
		const [px, nx, pz, nz] = filled.map((list) => (list[k] as number) * 0.97) as [
			number,
			number,
			number,
			number,
		];
		return { y, cx: axis.x + (px - nx) / 2, cz: axis.z + (pz - nz) / 2, a: (px + nx) / 2, b: (pz + nz) / 2 };
	});
	const [spx, snx, spz, snz] = shoulderReach as [number, number, number, number];
	const shoulder: Slice = {
		y: yShoulder,
		cx: axis.x + (spx - snx) / 2,
		cz: axis.z + (spz - snz) / 2,
		a: (spx + snx) / 2,
		b: (spz + snz) / 2,
	};
	const neckBase: Slice = { y: yNeck - 0.01 * s, cx: neck.x, cz: neck.z, a: rn * 1.3, b: rn * 1.15 };
	table.push(shoulder);
	for (let u = 0.25; u <= 1.001; u += 0.25) {
		const e = Math.sin((u * Math.PI) / 2);
		table.push(lerpSlice(shoulder, neckBase, e, shoulder.y + (neckBase.y - shoulder.y) * u));
	}

	// shoulders: from the neck's root out to the top of each arm
	for (const ua of [leftUpperArm, rightUpperArm]) {
		const from = new THREE.Vector3(axis.x + (ua.x - axis.x) * 0.25, yShoulder + 0.03 * s, shoulder.cz);
		const r = tubes.find((t) => t[0] === ua)?.[2] ?? 0.045 * s;
		tubes.push([from, ua.clone().setY(ua.y + 0.004 * s), 0.035 * s, r * 1.05]);
	}

	const k = 0.02 * s;
	const yTop = neckBase.y;
	return (p: THREE.Vector3) => {
		let d = Infinity;
		if (p.y > y0 - 0.05 && p.y < yTop + 0.05) {
			const sl = sliceAt(table, p.y);
			const qx = (p.x - sl.cx) / sl.a;
			const qz = (p.z - sl.cz) / sl.b;
			d = Math.max((Math.sqrt(qx * qx + qz * qz) - 1) * Math.min(sl.a, sl.b), y0 - p.y, p.y - yTop);
		}
		for (const [a, b, ra, rb] of tubes) d = smin(d, tube(p, a, b, ra, rb), k);
		return d;
	};
}

/**
 * Values along `xs` with gaps (null) filled: straight across between known ones, the first known below the
 * first, and from the last known one towards `end` (at the last x) above it.
 */
function fillGaps(xs: number[], list: (number | null)[], end: number): number[] {
	const known = list.map((v, i) => (v === null ? -1 : i)).filter((i) => i >= 0);
	if (known.length === 0) return list.map(() => end);
	const first = known[0] as number;
	const last = known[known.length - 1] as number;
	const xEnd = (xs[xs.length - 1] as number) + (xs.length > 1 ? (xs[1] as number) - (xs[0] as number) : 1);
	return list.map((v, i) => {
		if (v !== null) return v;
		if (i < first) return list[first] as number;
		const x = xs[i] as number;
		if (i > last) {
			const lv = list[last] as number;
			const xl = xs[last] as number;
			return lv + (end - lv) * ((x - xl) / (xEnd - xl));
		}
		const a = [...known].reverse().find((j) => j < i) as number;
		const b = known.find((j) => j > i) as number;
		const u = (x - (xs[a] as number)) / ((xs[b] as number) - (xs[a] as number));
		return (list[a] as number) + ((list[b] as number) - (list[a] as number)) * u;
	});
}

function lerpSlice(a: Slice, b: Slice, u: number, y: number): Slice {
	return {
		y,
		cx: a.cx + (b.cx - a.cx) * u,
		cz: a.cz + (b.cz - a.cz) * u,
		a: a.a + (b.a - a.a) * u,
		b: a.b + (b.b - a.b) * u,
	};
}

function sliceAt(table: Slice[], y: number): Slice {
	const first = table[0] as Slice;
	if (y <= first.y) return first;
	for (let i = 1; i < table.length; i++) {
		const b = table[i] as Slice;
		if (y <= b.y) {
			const a = table[i - 1] as Slice;
			return lerpSlice(a, b, b.y > a.y ? (y - a.y) / (b.y - a.y) : 0, y);
		}
	}
	return table[table.length - 1] as Slice;
}

/**
 * A surface where `f` is 0 (surface nets on a grid of `h`), inside `box`: positions, normals (from the
 * gradient) and triangles facing out (f grows outwards).
 */
export function surfaceOf(
	f: (p: THREE.Vector3) => number,
	box: THREE.Box3,
	h: number,
): { pos: Float32Array; nrm: Float32Array; index: Uint32Array } {
	const nx = Math.ceil((box.max.x - box.min.x) / h) + 1;
	const ny = Math.ceil((box.max.y - box.min.y) / h) + 1;
	const nz = Math.ceil((box.max.z - box.min.z) / h) + 1;
	const o = box.min;
	const val = new Float32Array(nx * ny * nz);
	const p = new THREE.Vector3();
	const at = (i: number, j: number, k: number) => (k * ny + j) * nx + i;
	for (let k = 0; k < nz; k++)
		for (let j = 0; j < ny; j++)
			for (let i = 0; i < nx; i++) val[at(i, j, k)] = f(p.set(o.x + i * h, o.y + j * h, o.z + k * h));
	const cellVertex = new Int32Array((nx - 1) * (ny - 1) * (nz - 1)).fill(-1);
	const cellAt = (i: number, j: number, k: number) => (k * (ny - 1) + j) * (nx - 1) + i;
	const pos: number[] = [];
	const corners = [
		[0, 0, 0],
		[1, 0, 0],
		[0, 1, 0],
		[1, 1, 0],
		[0, 0, 1],
		[1, 0, 1],
		[0, 1, 1],
		[1, 1, 1],
	] as const;
	const edges = [
		[0, 1],
		[2, 3],
		[4, 5],
		[6, 7],
		[0, 2],
		[1, 3],
		[4, 6],
		[5, 7],
		[0, 4],
		[1, 5],
		[2, 6],
		[3, 7],
	] as const;
	const cv = new Float32Array(8);
	for (let k = 0; k < nz - 1; k++)
		for (let j = 0; j < ny - 1; j++)
			for (let i = 0; i < nx - 1; i++) {
				let inside = 0;
				for (let c = 0; c < 8; c++) {
					const [di, dj, dk] = corners[c] as readonly [number, number, number];
					const v = val[at(i + di, j + dj, k + dk)] as number;
					cv[c] = v;
					if (v < 0) inside++;
				}
				if (inside === 0 || inside === 8) continue;
				let sx = 0;
				let sy = 0;
				let sz = 0;
				let n = 0;
				for (const [a, b] of edges) {
					const va = cv[a] as number;
					const vb = cv[b] as number;
					if (va < 0 === vb < 0) continue;
					const t = va / (va - vb);
					const ca = corners[a] as readonly [number, number, number];
					const cb = corners[b] as readonly [number, number, number];
					sx += ca[0] + (cb[0] - ca[0]) * t;
					sy += ca[1] + (cb[1] - ca[1]) * t;
					sz += ca[2] + (cb[2] - ca[2]) * t;
					n++;
				}
				cellVertex[cellAt(i, j, k)] = pos.length / 3;
				pos.push(o.x + (i + sx / n) * h, o.y + (j + sy / n) * h, o.z + (k + sz / n) * h);
			}
	const index: number[] = [];
	const quad = (a: number, b: number, c: number, d: number, flip: boolean) => {
		if (a < 0 || b < 0 || c < 0 || d < 0) return;
		if (flip) index.push(a, c, b, a, d, c);
		else index.push(a, b, c, a, c, d);
	};
	for (let k = 1; k < nz - 1; k++)
		for (let j = 1; j < ny - 1; j++)
			for (let i = 1; i < nx - 1; i++) {
				const v0 = (val[at(i, j, k)] as number) < 0;
				// the edge to +x: cells around it in y and z
				if (v0 !== (val[at(i + 1, j, k)] as number) < 0)
					quad(
						cellVertex[cellAt(i, j - 1, k - 1)] as number,
						cellVertex[cellAt(i, j, k - 1)] as number,
						cellVertex[cellAt(i, j, k)] as number,
						cellVertex[cellAt(i, j - 1, k)] as number,
						!v0,
					);
				if (v0 !== (val[at(i, j + 1, k)] as number) < 0)
					quad(
						cellVertex[cellAt(i - 1, j, k - 1)] as number,
						cellVertex[cellAt(i - 1, j, k)] as number,
						cellVertex[cellAt(i, j, k)] as number,
						cellVertex[cellAt(i, j, k - 1)] as number,
						!v0,
					);
				if (v0 !== (val[at(i, j, k + 1)] as number) < 0)
					quad(
						cellVertex[cellAt(i - 1, j - 1, k)] as number,
						cellVertex[cellAt(i, j - 1, k)] as number,
						cellVertex[cellAt(i, j, k)] as number,
						cellVertex[cellAt(i - 1, j, k)] as number,
						!v0,
					);
			}
	const out = new Float32Array(pos);
	const nrm = new Float32Array(out.length);
	const e = h * 0.5;
	const q = new THREE.Vector3();
	for (let i = 0; i < out.length / 3; i++) {
		q.fromArray(out, i * 3);
		const x = q.x;
		const y = q.y;
		const z = q.z;
		const g = new THREE.Vector3(
			f(p.set(x + e, y, z)) - f(p.set(x - e, y, z)),
			f(p.set(x, y + e, z)) - f(p.set(x, y - e, z)),
			f(p.set(x, y, z + e)) - f(p.set(x, y, z - e)),
		).normalize();
		g.toArray(nrm, i * 3);
	}
	// each triangle facing the way the shape grows
	const a = new THREE.Vector3();
	const b = new THREE.Vector3();
	const c = new THREE.Vector3();
	for (let t = 0; t < index.length; t += 3) {
		a.fromArray(out, (index[t] as number) * 3);
		b.fromArray(out, (index[t + 1] as number) * 3);
		c.fromArray(out, (index[t + 2] as number) * 3);
		const face = b.sub(a).cross(c.sub(a));
		q.fromArray(nrm, (index[t] as number) * 3);
		if (face.dot(q) < 0) {
			const tmp = index[t + 1] as number;
			index[t + 1] = index[t + 2] as number;
			index[t + 2] = tmp;
		}
	}
	return { pos: out, nrm, index: new Uint32Array(index) };
}

// ---- painting over painted clothes ----

/** Pixels of an image (RGBA), drawn from a texture's image; null where there is no canvas (tests). */
export function pixelsOf(image: unknown, w: number, h: number): Uint8ClampedArray | null {
	if (typeof document === "undefined") return null;
	const c = document.createElement("canvas");
	c.width = w;
	c.height = h;
	const g = c.getContext("2d", { willReadFrequently: true });
	if (!g) return null;
	g.drawImage(image as CanvasImageSource, 0, 0, w, h);
	return g.getImageData(0, 0, w, h).data;
}

/** Hue (0..1), saturation and value of an RGB colour (0..255). */
function hsv(r: number, g: number, b: number): [number, number, number] {
	const max = Math.max(r, g, b);
	const min = Math.min(r, g, b);
	const d = max - min;
	let hue = 0;
	if (d > 0) {
		if (max === r) hue = ((g - b) / d + 6) % 6;
		else if (max === g) hue = (b - r) / d + 2;
		else hue = (r - g) / d + 4;
	}
	return [hue / 6, max > 0 ? d / max : 0, max / 255];
}

/** A skin colour, and how far a colour may be from it and still be skin. */
export interface Tone {
	rgb: [number, number, number];
	h: number;
	s: number;
	v: number;
}

/** The skin's colour: the commonest skin-like colour among `samples` (RGB 0..255, flat). */
export function toneOf(samples: number[]): Tone | null {
	const bins = new Map<number, number[]>();
	for (let i = 0; i + 2 < samples.length; i += 3) {
		const r = samples[i] as number;
		const g = samples[i + 1] as number;
		const b = samples[i + 2] as number;
		const [h, s, v] = hsv(r, g, b);
		// skin: reddish to yellowish, a little saturated, not dark
		if (!(h < 0.14 || h > 0.95) || s < 0.04 || s > 0.75 || v < 0.35) continue;
		const key = (r >> 4) * 256 + (g >> 4) * 16 + (b >> 4);
		const bin = bins.get(key);
		if (bin) bin.push(r, g, b);
		else bins.set(key, [r, g, b]);
	}
	let best: number[] | null = null;
	for (const bin of bins.values()) if (!best || bin.length > best.length) best = bin;
	if (!best) return null;
	const n = best.length / 3;
	const rgb: [number, number, number] = [0, 0, 0];
	for (let i = 0; i < best.length; i++) rgb[i % 3] = (rgb[i % 3] as number) + (best[i] as number) / n;
	const [h, s, v] = hsv(...rgb);
	return { rgb, h, s, v };
}

/**
 * Whether a colour (0..255) looks like the skin of `tone` (in its light or its shade; painted shading on
 * skin is redder and darker, and still skin). Called for every pixel of a texture, so it makes no arrays.
 */
export function isSkin(tone: Tone, r: number, g: number, b: number): boolean {
	const max = Math.max(r, g, b);
	if (max < tone.v * 0.55 * 255) return false;
	const min = Math.min(r, g, b);
	const d = max - min;
	const s = max > 0 ? d / max : 0;
	if (s <= tone.s * 0.45 || s >= tone.s * 3 + 0.12) return false;
	let h = 0;
	if (d > 0) {
		if (max === r) h = ((g - b) / d + 6) % 6;
		else if (max === g) h = (b - r) / d + 2;
		else h = (r - g) / d + 4;
	}
	let dh = Math.abs(h / 6 - tone.h);
	if (dh > 0.5) dh = 1 - dh;
	return dh < 0.08;
}

/**
 * Paints skin over what is not skin inside `where` (a mask, 0..255 per pixel, of the parts left uncovered):
 * each such pixel gets the colour of the skin around it, the skin pixels pulled down to coarser and coarser
 * grids and pushed back up smoothly (bilinear), so the colour flows in from all sides; that, `local` of it,
 * and the skin's `tone` for the rest (all of it on a texture of many small pieces, where the pixels around
 * are not the skin around). Returns new RGBA.
 */
export function paintSkin(
	px: Uint8ClampedArray,
	w: number,
	h: number,
	skin: Uint8Array,
	where: Uint8Array,
	tone: [number, number, number],
	local: number,
): Uint8ClampedArray {
	// a level: colour (averaged) and how much of it is known (0..1), here at a quarter of the size
	interface Level {
		w: number;
		h: number;
		c: Float32Array;
		k: Float32Array;
	}
	const level = (lw: number, lh: number): Level => ({
		w: lw,
		h: lh,
		c: new Float32Array(lw * lh * 3),
		k: new Float32Array(lw * lh),
	});
	// skin well inside the skin (not the blend at the edge of a sock, half skin and half sock)
	const inner = (x: number, y: number) => {
		for (let dy = -3; dy <= 3; dy += 3)
			for (let dx = -3; dx <= 3; dx += 3) {
				const xx = Math.max(0, Math.min(w - 1, x + dx));
				const yy = Math.max(0, Math.min(h - 1, y + dy));
				if (!skin[yy * w + xx]) return false;
			}
		return true;
	};
	const first = level(Math.max(1, w >> 2), Math.max(1, h >> 2));
	for (let y = 0; y < h; y++)
		for (let x = 0; x < w; x++) {
			const i = y * w + x;
			if (!skin[i] || (px[i * 4 + 3] as number) < 250 || !inner(x, y)) continue;
			const j = Math.min(first.h - 1, y >> 2) * first.w + Math.min(first.w - 1, x >> 2);
			for (let c = 0; c < 3; c++) add(first.c, j * 3 + c, px[i * 4 + c] as number);
			add(first.k, j, 1);
		}
	const levels = [first];
	for (let l = first; l.w > 1 || l.h > 1; ) {
		const next = level(Math.max(1, l.w >> 1), Math.max(1, l.h >> 1));
		for (let y = 0; y < l.h; y++)
			for (let x = 0; x < l.w; x++) {
				const i = y * l.w + x;
				const j = Math.min(next.h - 1, y >> 1) * next.w + Math.min(next.w - 1, x >> 1);
				for (let c = 0; c < 3; c++) add(next.c, j * 3 + c, l.c[i * 3 + c] as number);
				add(next.k, j, l.k[i] as number);
			}
		levels.push(next);
		l = next;
	}
	// sums to colours; a cell is fully known with 4 or more skin pixels in it
	for (const l of levels)
		for (let i = 0; i < l.w * l.h; i++) {
			const n = l.k[i] as number;
			for (let c = 0; c < 3; c++) l.c[i * 3 + c] = n > 0 ? (l.c[i * 3 + c] as number) / n : 0;
			l.k[i] = Math.min(1, n / 4);
		}
	const bilinear = (l: Level, fx: number, fy: number, c: number) => {
		const x = Math.max(0, Math.min(l.w - 1, fx));
		const y = Math.max(0, Math.min(l.h - 1, fy));
		const x0 = Math.floor(x);
		const y0 = Math.floor(y);
		const x1 = Math.min(l.w - 1, x0 + 1);
		const y1 = Math.min(l.h - 1, y0 + 1);
		const tx = x - x0;
		const ty = y - y0;
		const v = (xx: number, yy: number) => l.c[(yy * l.w + xx) * 3 + c] as number;
		return (v(x0, y0) * (1 - tx) + v(x1, y0) * tx) * (1 - ty) + (v(x0, y1) * (1 - tx) + v(x1, y1) * tx) * ty;
	};
	// from the coarsest up: what is not known comes from the level above, smoothly
	for (let li = levels.length - 2; li >= 0; li--) {
		const l = levels[li] as Level;
		const up = levels[li + 1] as Level;
		const sx = up.w / l.w;
		const sy = up.h / l.h;
		for (let y = 0; y < l.h; y++)
			for (let x = 0; x < l.w; x++) {
				const i = y * l.w + x;
				const k = l.k[i] as number;
				if (k >= 1) continue;
				const fx = (x + 0.5) * sx - 0.5;
				const fy = (y + 0.5) * sy - 0.5;
				for (let c = 0; c < 3; c++)
					l.c[i * 3 + c] = (l.c[i * 3 + c] as number) * k + bilinear(up, fx, fy, c) * (1 - k);
				l.k[i] = 1;
			}
	}
	// not skin: painted over; skin-like but by something that is not and far from the skin around it (a
	// pale print, the edge of a sock): painted over more the further it is. (Skin by itself stays as it is,
	// shading painted on it and all.)
	const cloth = new Uint8Array(w * h);
	for (let i = 0; i < w * h; i++) cloth[i] = where[i] && !skin[i] && (px[i * 4 + 3] as number) >= 8 ? 1 : 0;
	const byCloth = dilate(cloth, w, h, Math.max(2, Math.round(w / 170)));
	// (and the pixel next to it, half one and half the other)
	const edge = dilate(cloth, w, h, 1);
	const out = new Uint8ClampedArray(px);
	const fill = [0, 0, 0];
	for (let y = 0; y < h; y++)
		for (let x = 0; x < w; x++) {
			const i = y * w + x;
			if (!where[i] || !byCloth[i] || (px[i * 4 + 3] as number) < 8) continue;
			const fx = (x + 0.5) / 4 - 0.5;
			const fy = (y + 0.5) / 4 - 0.5;
			let d = 0;
			for (let c = 0; c < 3; c++) {
				fill[c] = (tone[c] as number) * (1 - local) + (local > 0 ? bilinear(first, fx, fy, c) * local : 0);
				d = Math.max(d, Math.abs((px[i * 4 + c] as number) - (fill[c] as number)));
			}
			const t = skin[i] && !edge[i] ? Math.max(0, Math.min(1, (d - 20) / 24)) : 1;
			if (t <= 0) continue;
			for (let c = 0; c < 3; c++)
				out[i * 4 + c] = (px[i * 4 + c] as number) * (1 - t) + (fill[c] as number) * t;
			out[i * 4 + 3] = 255;
		}
	return out;
}

/** A mask grown by `r` pixels each way (a square), by running counts across and then down. */
function dilate(mask: Uint8Array, w: number, h: number, r: number): Uint8Array {
	const across = new Uint8Array(w * h);
	for (let y = 0; y < h; y++) {
		let n = 0;
		for (let x = 0; x < Math.min(w, r); x++) n += mask[y * w + x] as number;
		for (let x = 0; x < w; x++) {
			if (x + r < w) n += mask[y * w + x + r] as number;
			if (x - r - 1 >= 0) n -= mask[y * w + x - r - 1] as number;
			across[y * w + x] = n > 0 ? 1 : 0;
		}
	}
	const out = new Uint8Array(w * h);
	for (let x = 0; x < w; x++) {
		let n = 0;
		for (let y = 0; y < Math.min(h, r); y++) n += across[y * w + x] as number;
		for (let y = 0; y < h; y++) {
			if (y + r < h) n += across[(y + r) * w + x] as number;
			if (y - r - 1 >= 0) n -= across[(y - r - 1) * w + x] as number;
			out[y * w + x] = n > 0 ? 1 : 0;
		}
	}
	return out;
}

function add(a: Float32Array, i: number, v: number): void {
	a[i] = (a[i] as number) + v;
}

/**
 * Fills the triangles (UVs, 6 floats each) into a w x h mask (1 inside), with every pixel a triangle touches
 * (so thin ones and their edges are not missed). UVs are wrapped into 0..1 by each triangle's first corner.
 */
export function maskOf(uvTris: number[], w: number, h: number): Uint8Array {
	const mask = new Uint8Array(w * h);
	// a pixel is in if its middle is within half a pixel (and a little) of the triangle
	const pad = 0.75;
	for (let t = 0; t + 5 < uvTris.length; t += 6) {
		const u0 = uvTris[t] as number;
		const v0 = uvTris[t + 1] as number;
		const du = Math.floor(u0);
		const dv = Math.floor(v0);
		const ax = (u0 - du) * w;
		const ay = (v0 - dv) * h;
		const bx = ((uvTris[t + 2] as number) - du) * w;
		const by = ((uvTris[t + 3] as number) - dv) * h;
		const cx = ((uvTris[t + 4] as number) - du) * w;
		const cy = ((uvTris[t + 5] as number) - dv) * h;
		const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
		const sign = area < 0 ? -1 : 1;
		// edges as a*x + b*y + c >= 0 inside, scaled to pixels (so pad is a distance)
		const edges: [number, number, number][] = [];
		for (const [px, py, qx, qy] of [
			[ax, ay, bx, by],
			[bx, by, cx, cy],
			[cx, cy, ax, ay],
		] as const) {
			const ea = -(qy - py) * sign;
			const eb = (qx - px) * sign;
			const len = Math.sqrt(ea * ea + eb * eb) || 1;
			edges.push([ea / len, eb / len, -(ea * px + eb * py) / len]);
		}
		const x0 = Math.max(0, Math.floor(Math.min(ax, bx, cx) - pad));
		const x1 = Math.min(w - 1, Math.ceil(Math.max(ax, bx, cx) + pad));
		const y0 = Math.max(0, Math.floor(Math.min(ay, by, cy) - pad));
		const y1 = Math.min(h - 1, Math.ceil(Math.max(ay, by, cy) + pad));
		for (let y = y0; y <= y1; y++)
			for (let x = x0; x <= x1; x++) {
				const mx = x + 0.5;
				const my = y + 0.5;
				let inside = true;
				for (const [ea, eb, ec] of edges)
					if (ea * mx + eb * my + ec < -pad) {
						inside = false;
						break;
					}
				if (inside) mask[y * w + x] = 1;
			}
	}
	return mask;
}
