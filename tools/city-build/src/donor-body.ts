// The trunk of a VRoid model whose skin VRoid deleted under its clothes, taken from another VRoid model's whole
// body (docs/prd.md 3.8.6, issue 46): for the bath, where the clothes come off. The donor's trunk is moved onto
// the model's skeleton bone by bone (each vertex by the bones that move it, the donor's bones put where the
// model's are, its proportions scaled to the model's), then bent onto the model's own skin where that is left,
// the bend spreading smoothly over where it is not. The result is a plain surface in the model's bind space
// (positions and triangles); the city's page skins it and keeps only the part where skin is missing.
//
//   node tools/city-build/src/donor-body.ts <model.vrm> <donor.vrm> -o assets/avatars/<model>.torso.json

import { type Glb, parseGlb, readAccessor } from "./glb.ts";

interface Skin {
	/** Body skin vertices (bind space), normals, four joints (by name) and weights; skin triangles. */
	pos: Float64Array;
	nrm: Float64Array;
	joints: string[][];
	weights: number[][];
	tris: number[];
	/** Where each joint is at rest, by name. */
	at: Map<string, [number, number, number]>;
}

type V3 = [number, number, number];

interface GltfJsonish {
	nodes: { name?: string; mesh?: number; skin?: number }[];
	meshes: {
		name?: string;
		primitives: { attributes: Record<string, number>; indices?: number; material?: number }[];
	}[];
	materials: { name?: string }[];
	skins: { joints: number[]; inverseBindMatrices?: number }[];
}

/** The body's skin (its "…_Body_…_SKIN" primitives) of a VRoid VRM. */
export function skinOf(data: Uint8Array): Skin {
	// (only the geometry is read: the textures' format does not matter)
	const glb: Glb = parseGlb(data, ["EXT_texture_webp"]);
	const json = glb.json as unknown as GltfJsonish;
	const mi = json.meshes.findIndex((m) => m.name?.startsWith("Body"));
	const node = json.nodes.find((n) => n.mesh === mi);
	const mesh = json.meshes[mi];
	if (!mesh || node?.skin === undefined) throw new Error("no skinned Body mesh");
	const skin = json.skins[node.skin];
	if (!skin || skin.inverseBindMatrices === undefined) throw new Error("no skin");
	const names = skin.joints.map((j) => json.nodes[j]?.name ?? "");
	const ibm = readAccessor(glb, skin.inverseBindMatrices);
	const at = new Map<string, V3>();
	names.forEach((name, k) => {
		// the joint's place: the inverse bind matrix maps it to the origin (VRoid's are translations and
		// rotations; solve M p + t = 0)
		const m = ibm.subarray(k * 16, k * 16 + 16);
		const t: V3 = [m[12] as number, m[13] as number, m[14] as number];
		const r = [0, 1, 2].map((c) => [m[c * 4] as number, m[c * 4 + 1] as number, m[c * 4 + 2] as number]);
		// p = -R^T t for an orthonormal R (columns c of the 3 x 3 part)
		const p = [0, 1, 2].map(
			(i) => -[0, 1, 2].reduce((sum, c) => sum + (r[c]?.[i] as number) * (t[c] as number), 0),
		);
		at.set(name, p as V3);
	});
	const first = mesh.primitives[0];
	if (!first) throw new Error("empty Body mesh");
	const pos = readAccessor(glb, first.attributes.POSITION as number);
	const nrm = readAccessor(glb, first.attributes.NORMAL as number);
	const jj = readAccessor(glb, first.attributes.JOINTS_0 as number);
	const ww = readAccessor(glb, first.attributes.WEIGHTS_0 as number);
	const joints: string[][] = [];
	const weights: number[][] = [];
	for (let i = 0; i < pos.length / 3; i++) {
		joints.push([0, 1, 2, 3].map((c) => names[jj[i * 4 + c] as number] ?? ""));
		weights.push([0, 1, 2, 3].map((c) => ww[i * 4 + c] as number));
	}
	const tris: number[] = [];
	for (const p of mesh.primitives) {
		const mat = json.materials[p.material ?? -1]?.name ?? "";
		if (!/_Body_.*_SKIN/.test(mat) || p.indices === undefined) continue;
		// (the primitives share the first one's vertices)
		if (p.attributes.POSITION !== first.attributes.POSITION) continue;
		for (const i of readAccessor(glb, p.indices)) tris.push(i);
	}
	return { pos, nrm, joints, weights, tris, at };
}

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);

/** The closest point to p on triangle abc (Ericson's). */
function closestOnTriangle(p: V3, a: V3, b: V3, c: V3): V3 {
	const ab = sub(b, a);
	const ac = sub(c, a);
	const ap = sub(p, a);
	const d1 = dot(ab, ap);
	const d2 = dot(ac, ap);
	if (d1 <= 0 && d2 <= 0) return a;
	const bp = sub(p, b);
	const d3 = dot(ab, bp);
	const d4 = dot(ac, bp);
	if (d3 >= 0 && d4 <= d3) return b;
	const vc = d1 * d4 - d3 * d2;
	if (vc <= 0 && d1 >= 0 && d3 <= 0) {
		const v = d1 / (d1 - d3);
		return [a[0] + ab[0] * v, a[1] + ab[1] * v, a[2] + ab[2] * v];
	}
	const cp = sub(p, c);
	const d5 = dot(ab, cp);
	const d6 = dot(ac, cp);
	if (d6 >= 0 && d5 <= d6) return c;
	const vb = d5 * d2 - d1 * d6;
	if (vb <= 0 && d2 >= 0 && d6 <= 0) {
		const w = d2 / (d2 - d6);
		return [a[0] + ac[0] * w, a[1] + ac[1] * w, a[2] + ac[2] * w];
	}
	const va = d3 * d6 - d5 * d4;
	if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
		const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
		return [b[0] + (c[0] - b[0]) * w, b[1] + (c[1] - b[1]) * w, b[2] + (c[2] - b[2]) * w];
	}
	const denom = 1 / (va + vb + vc);
	const v = vb * denom;
	const w = vc * denom;
	return [a[0] + ab[0] * v + ac[0] * w, a[1] + ab[1] * v + ac[1] * w, a[2] + ab[2] * v + ac[2] * w];
}

/**
 * Bones whose skin makes up the trunk (the chest, the breasts, the back and the waist). The shoulders and the
 * upper arms are left to the city's own modelled body: the donor's are cut short by its own sleeves.
 */
const TRUNK = /^J_(Bip_C_(Hips|Spine|Chest|UpperChest|Neck)|Sec_[LR]_Bust\d)$/;

export interface Torso {
	/** Bind-space positions (x, y, z) and triangles. */
	pos: number[];
	index: number[];
}

/**
 * The donor's trunk on the model: moved bone by bone onto the model's skeleton and proportions, then bent onto
 * the model's skin where the two lie together (within `snap` metres, facing alike).
 */
export function donorTorso(model: Skin, donor: Skin, snap = 0.035): Torso {
	const j = (s: Skin, name: string): V3 => {
		const p = s.at.get(name);
		if (!p) throw new Error(`no joint ${name}`);
		return p;
	};
	// proportions: the trunk's height (hips to neck) and the shoulders' width
	const height = (s: Skin) => j(s, "J_Bip_C_Neck")[1] - j(s, "J_Bip_C_Hips")[1];
	const width = (s: Skin) => len(sub(j(s, "J_Bip_L_UpperArm"), j(s, "J_Bip_R_UpperArm")));
	const sy = height(model) / height(donor);
	const sx = width(model) / width(donor);
	const scale: V3 = [sx, sy, sx];
	// the donor's trunk vertices, each moved by its bones from the donor's joints to the model's
	const n = donor.pos.length / 3;
	const keep = new Int32Array(n).fill(-1);
	const used: number[] = [];
	for (let t = 0; t + 2 < donor.tris.length; t += 3) {
		const vs = [donor.tris[t], donor.tris[t + 1], donor.tris[t + 2]] as number[];
		const trunk = vs.every((v) => {
			const w = donor.weights[v] as number[];
			const best = w.indexOf(Math.max(...w));
			return TRUNK.test((donor.joints[v] as string[])[best] ?? "");
		});
		if (!trunk) continue;
		for (const v of vs) if (keep[v] === -1) keep[v] = used.push(v) - 1;
	}
	const moved: V3[] = used.map((v) => {
		const p: V3 = [
			donor.pos[v * 3] as number,
			donor.pos[v * 3 + 1] as number,
			donor.pos[v * 3 + 2] as number,
		];
		const out = [0, 0, 0];
		let total = 0;
		(donor.joints[v] as string[]).forEach((name, c) => {
			const w = (donor.weights[v] as number[])[c] as number;
			if (w <= 0 || !donor.at.has(name) || !model.at.has(name)) return;
			const a = j(donor, name);
			const b = j(model, name);
			for (let k = 0; k < 3; k++)
				out[k] =
					(out[k] as number) +
					w * ((b[k] as number) + (scale[k] as number) * ((p[k] as number) - (a[k] as number)));
			total += w;
		});
		return total > 0 ? ([0, 1, 2].map((k) => (out[k] as number) / total) as V3) : p;
	});
	const normal = (v: number): V3 => [
		donor.nrm[v * 3] as number,
		donor.nrm[v * 3 + 1] as number,
		donor.nrm[v * 3 + 2] as number,
	];
	// bent onto the model's own skin where it is there: the nearest skin point, if close and facing alike
	const mt: V3[][] = [];
	for (let t = 0; t + 2 < model.tris.length; t += 3)
		mt.push(
			[0, 1, 2].map((k) => {
				const v = model.tris[t + k] as number;
				return [model.pos[v * 3], model.pos[v * 3 + 1], model.pos[v * 3 + 2]] as V3;
			}),
		);
	const anchor: (V3 | null)[] = moved.map((p, i) => {
		let best: V3 | null = null;
		let bd = snap;
		const nd = normal(used[i] as number);
		for (const [a, b, c] of mt as [V3, V3, V3][]) {
			// (a cheap bound first)
			if (Math.abs(a[1] - p[1]) > snap + 0.1 || Math.abs(a[0] - p[0]) > snap + 0.1) continue;
			const q = closestOnTriangle(p, a, b, c);
			const d = len(sub(q, p));
			if (d >= bd) continue;
			const tn = norm3(crossV(sub(b, a), sub(c, a)));
			if (dot(tn, nd) < 0.5) continue;
			bd = d;
			best = q;
		}
		return best ? sub(best, p) : null;
	});
	// where there is no skin to bend onto, the bend of the nearest anchored points, fading with distance
	const anchored = anchor.map((a, i) => (a ? i : -1)).filter((i) => i >= 0);
	const out: number[] = [];
	moved.forEach((p, i) => {
		let d = anchor[i];
		if (!d) {
			const near = anchored
				.map((k) => ({ k, r: len(sub(moved[k] as V3, p)) }))
				.sort((x, y) => x.r - y.r)
				.slice(0, 12);
			let sw = 0;
			const acc = [0, 0, 0];
			for (const { k, r } of near) {
				const w = 1 / (r * r + 1e-4);
				const a = anchor[k] as V3;
				for (let c = 0; c < 3; c++) acc[c] = (acc[c] as number) + (a[c] as number) * w;
				sw += w;
			}
			// far from any skin it keeps its own shape
			const fade = near[0] ? Math.max(0, 1 - near[0].r / 0.25) : 0;
			d = sw > 0 ? ([0, 1, 2].map((c) => ((acc[c] as number) / sw) * fade) as V3) : [0, 0, 0];
		}
		const dd = d as V3;
		out.push(...p.map((x, c) => Math.round((x + (dd[c] as number)) * 1e4) / 1e4));
	});
	const index: number[] = [];
	for (let t = 0; t + 2 < donor.tris.length; t += 3) {
		const vs = [donor.tris[t], donor.tris[t + 1], donor.tris[t + 2]] as number[];
		if (vs.every((v) => keep[v] !== -1)) index.push(...vs.map((v) => keep[v] as number));
	}
	return { pos: out, index };
}

function crossV(a: V3, b: V3): V3 {
	return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function norm3(a: V3): V3 {
	const l = len(a) || 1;
	return [a[0] / l, a[1] / l, a[2] / l];
}

if (import.meta.main) {
	const { readFileSync, writeFileSync } = await import("node:fs");
	const [modelPath, donorPath, flag, outPath] = process.argv.slice(2);
	if (!modelPath || !donorPath || flag !== "-o" || !outPath) {
		console.error("usage: node tools/city-build/src/donor-body.ts <model.vrm> <donor.vrm> -o <out.json>");
		process.exit(2);
	}
	const torso = donorTorso(skinOf(readFileSync(modelPath)), skinOf(readFileSync(donorPath)));
	writeFileSync(outPath, `${JSON.stringify({ donor: donorPath.split("/").pop(), ...torso })}\n`);
	console.log(
		JSON.stringify({ out: outPath, vertices: torso.pos.length / 3, triangles: torso.index.length / 3 }),
	);
}
