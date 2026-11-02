// Tree templates, grown procedurally: a branching skeleton inside the species' crown envelope, bark tubes
// down to the fine twigs, and leaf cards (atlas.ts) at the twigs and over the crown's outer shell.
// Ported from the Kyoto demo's generator (~/work/demos/kyoto/tools/gen/treegen.py), in three's frame (Y up).
//
// Wood vertex data:   (wind weight 0 trunk .. 1 twig, depth 0..1, 0, 0); uv = metres around, metres along.
// Leaf vertex data:   (outerness 0..1, random per card, height in the crown 0..1, wind weight); uv in the atlas.
// The leaf cards that sit on twigs come first: in winter a bare tree draws only those (with the twig cell).

import { Rng } from "./rng.ts";
import { SPECIES, type Species, type SpeciesDef } from "./species.ts";

export interface PartMesh {
	position: Float32Array;
	normal: Float32Array;
	uv: Float32Array;
	data: Float32Array;
	index: Uint32Array;
}

export interface TreeTemplate {
	species: Species;
	variant: number;
	lod: 0 | 1;
	/** Top of the tree and the crown's horizontal radius (metres, s = 1). */
	height: number;
	radius: number;
	wood: PartMesh;
	leaves: PartMesh;
	/** Leaf cards on twigs (drawn first); the rest fill the crown's shell. */
	twigCards: number;
}

/** Template variants per species. */
export const VARIANTS = 3;
/** Atlas cells per row. */
export const ATLAS_N = 4;

type V3 = [number, number, number];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [
	a[1] * b[2] - a[2] * b[1],
	a[2] * b[0] - a[0] * b[2],
	a[0] * b[1] - a[1] * b[0],
];
const len = (a: V3): number => Math.hypot(a[0], a[1], a[2]);
const norm = (a: V3): V3 => {
	const l = len(a);
	return l > 1e-9 ? mul(a, 1 / l) : [0, 1, 0];
};
const UP: V3 = [0, 1, 0];

/** Crown radius at height y (metres) for a tree of height H. */
export function envelope(sp: SpeciesDef, H: number, y: number): number {
	const R = sp.R * H;
	const zc = sp.zc * H;
	const zr = sp.zr * H;
	const zs = sp.zs * H;
	if (y < zs * 0.9) return 0;
	const t = (y - zs) / Math.max(H - zs, 1e-3);
	switch (sp.crown) {
		case "dome":
		case "round":
		case "spread": {
			const u = (y - zc) / Math.max(zr, 1e-3);
			if (Math.abs(u) >= 1) return 0;
			let r = R * Math.sqrt(1 - u * u);
			if (sp.crown === "dome" && u > 0.4) r *= 1 - (u - 0.4) * 0.6;
			if (sp.crown === "spread" && u > 0.15) r *= 1 - (u - 0.15) * 0.55;
			return r;
		}
		case "oval":
			if (t < 0 || t > 1) return 0;
			return R * Math.sin(Math.PI * t) ** 0.75 * (1.15 - 0.3 * t);
		case "vase":
			if (t < 0 || t >= 1) return 0;
			return R * Math.min(1, t * 1.4) ** 0.7 * (1 - (Math.max(0, t - 0.8) / 0.2) * 0.7);
		case "cone":
			if (t < 0 || t >= 1) return 0;
			return R * (1 - t) ** 1.05 + 0.25;
		case "pine":
			if (t < 0 || t >= 1) return 0;
			return R * (0.6 + 0.4 * Math.sin(t * Math.PI)) * (1 - t * 0.45);
	}
}

class Builder {
	readonly p: number[] = [];
	readonly n: number[] = [];
	readonly uv: number[] = [];
	readonly d: number[] = [];
	readonly i: number[] = [];

	get count(): number {
		return this.p.length / 3;
	}

	vertex(p: V3, n: V3, u: number, v: number, d: [number, number, number, number]): void {
		this.p.push(p[0], p[1], p[2]);
		this.n.push(n[0], n[1], n[2]);
		this.uv.push(u, v);
		this.d.push(d[0], d[1], d[2], d[3]);
	}

	mesh(): PartMesh {
		return {
			position: new Float32Array(this.p),
			normal: new Float32Array(this.n),
			uv: new Float32Array(this.uv),
			data: new Float32Array(this.d),
			index: new Uint32Array(this.i),
		};
	}
}

/** A tube along `pts` with `radii`, parallel-transport frames; uv in metres (around, along). */
function tube(b: Builder, pts: V3[], radii: number[], sides: number, wind: number[], depth: number): void {
	const k = pts.length;
	if (k < 2) return;
	const base = b.count;
	const T: V3[] = pts.map((_, i) =>
		norm(sub(pts[Math.min(k - 1, i + 1)] as V3, pts[Math.max(0, i - 1)] as V3)),
	);
	const t0 = T[0] as V3;
	let N = norm(cross(t0, Math.abs(t0[1]) < 0.95 ? UP : [1, 0, 0]));
	let along = 0;
	for (let i = 0; i < k; i++) {
		const Ti = T[i] as V3;
		if (i > 0) {
			along += len(sub(pts[i] as V3, pts[i - 1] as V3));
			N = norm(sub(N, mul(Ti, dot(N, Ti))));
		}
		const B = cross(Ti, N);
		const r = radii[i] as number;
		for (let j = 0; j <= sides; j++) {
			const a = (2 * Math.PI * j) / sides;
			const dir = add(mul(N, Math.cos(a)), mul(B, Math.sin(a)));
			b.vertex(add(pts[i] as V3, mul(dir, r)), dir, a * Math.max(r, 0.02), along, [
				wind[i] as number,
				depth,
				0,
				0,
			]);
		}
	}
	for (let i = 0; i < k - 1; i++) {
		for (let j = 0; j < sides; j++) {
			const a = base + i * (sides + 1) + j;
			const c = a + sides + 1;
			b.i.push(a, a + 1, c, a + 1, c + 1, c);
		}
	}
}

interface Card {
	p: V3;
	dir: V3;
	size: number;
	depth: number;
}

/** Grows one template; deterministic in (species, variant, lod). */
export function makeTree(species: Species, variant: number, lod: 0 | 1): TreeTemplate {
	const sp = SPECIES[species];
	const r = new Rng(1000 + SPECIES_SEED(species) * 97 + variant * 13);
	const H = r.range(sp.height[0], sp.height[1]);
	const wood = new Builder();
	const twigs: Card[] = [];
	const sides = lod === 0 ? [8, 5, 4, 3, 3] : [5, 3, 3, 3, 3];
	/** Deepest branch level drawn as tubes. */
	const tubeDepth = lod === 0 ? sp.levels : 1;
	const zs = sp.zs * H;
	const crownC: V3 = [0, sp.zc * H, 0];

	const room = (p: V3, d: V3): number => {
		let s = 0;
		for (let i = 0; i < 80; i++) {
			s += 0.2;
			const q = add(p, mul(d, s));
			if (Math.hypot(q[0], q[2]) > envelope(sp, H, q[1]) + 0.15 || q[1] > H || q[1] < 0.3) return s;
		}
		return s;
	};

	const branch = (p0: V3, d0: V3, length: number, depth: number, rad0: number): void => {
		const step = depth === 1 ? 0.6 : depth === 2 ? 0.45 : 0.5;
		const k = Math.max(depth >= 3 ? 2 : 3, Math.floor(length / step) + 1);
		const pts: V3[] = [p0];
		let d = d0;
		const jitter = sp.crown === "pine" ? 0.14 : sp.deciduous ? 0.13 : 0.08;
		for (let i = 1; i < k; i++) {
			d = norm(add(add(d, [0, sp.bend, 0]), [r.normal(jitter), r.normal(jitter), r.normal(jitter)]));
			pts.push(add(pts[i - 1] as V3, mul(d, length / (k - 1))));
		}
		const radii = pts.map((_, i) => Math.max(0.0035, rad0 * (1 - (0.7 * i) / (k - 1))));
		const w0 = Math.min(1, 0.25 + 0.2 * depth);
		const wind = pts.map((_, i) => Math.min(1, w0 + (0.25 * i) / (k - 1)));
		if (depth <= tubeDepth) tube(wood, pts, radii, sides[Math.min(depth, 4)] as number, wind, depth / 4);
		if (depth < sp.levels) {
			const nc = (depth === 1 ? sp.kids[0] : sp.kids[1]) + (r.next() < 0.4 ? 1 : 0);
			for (let c = 0; c < nc; c++) {
				const t = r.range(0.3, 0.95);
				const fi = t * (k - 1);
				const i = Math.min(k - 2, Math.floor(fi));
				const p = add(pts[i] as V3, mul(sub(pts[i + 1] as V3, pts[i] as V3), fi - i));
				let side = cross(d, UP);
				side = len(side) > 1e-6 ? norm(side) : [1, 0, 0];
				const a = r.range(-1.3, 1.3);
				const spread = r.range(0.55, 0.85);
				const nd = norm(
					add(
						mul(d, Math.cos(spread)),
						mul(add(mul(side, Math.cos(a)), mul(cross(side, d), Math.sin(a))), Math.sin(spread)),
					),
				);
				const L2 = Math.min(length * r.range(0.45, 0.7), room(p, nd) * 0.95);
				if (L2 > 0.2) branch(p, nd, L2, depth + 1, (radii[i] as number) * 0.62);
			}
		}
		if (depth >= sp.levels - 1) {
			const nl = Math.max(1, Math.floor(length / 0.4));
			for (let i = 0; i < nl; i++) {
				const t = r.range(0.35, 1);
				const fi = t * (k - 1);
				const j = Math.min(k - 2, Math.floor(fi));
				twigs.push({
					p: add(pts[j] as V3, mul(sub(pts[j + 1] as V3, pts[j] as V3), fi - j)),
					dir: d,
					size: 1,
					depth,
				});
			}
		}
	};

	// trunk
	const lean: [number, number] = [
		r.normal(sp.crown === "pine" ? 0.07 : 0.025),
		r.normal(sp.crown === "pine" ? 0.07 : 0.025),
	];
	const top =
		sp.crown === "cone" || sp.crown === "oval"
			? H * 0.96
			: sp.crown === "spread"
				? H * (sp.zs + 0.18)
				: H * Math.max(0.45, sp.zs + 0.28);
	const nseg = 10;
	const trunk: V3[] = [];
	const trunkR: number[] = [];
	const wob = r.range(0, 6.28);
	for (let s = 0; s < nseg; s++) {
		const t = s / (nseg - 1);
		const bow = sp.crown === "pine" ? Math.sin(t * 3 + wob) * 0.04 * H * t : 0;
		trunk.push([lean[0] * t * H + bow, t * top, lean[1] * t * H + bow * 0.5]);
		trunkR.push(sp.r0 * H * (1 - 0.72 * t) * (t < 0.06 ? 1.3 : 1));
	}
	tube(
		wood,
		trunk,
		trunkR,
		sides[0] as number,
		trunk.map((_, s) => (0.3 * s) / (nseg - 1)),
		0,
	);

	// main branches inside the envelope
	const n1 = r.int(sp.n1[0], sp.n1[1]);
	const ga = r.range(0, 2 * Math.PI);
	const topY = (trunk[nseg - 1] as V3)[1];
	for (let bi = 0; bi < n1; bi++) {
		const y =
			sp.crown === "cone" || sp.crown === "pine"
				? zs + (topY * 0.98 - zs) * ((bi + 0.5) / n1)
				: zs + (topY - zs) * r.range(0, 0.9) ** 0.8;
		const f = Math.min(nseg - 1.001, (y / topY) * (nseg - 1));
		const i = Math.floor(f);
		const p = add(trunk[i] as V3, mul(sub(trunk[i + 1] as V3, trunk[i] as V3), f - i));
		const a = ga + bi * 2.39996 + r.normal(0.25);
		const el = (r.range(sp.el1[0], sp.el1[1]) * Math.PI) / 180;
		const d: V3 = [Math.cos(a) * Math.cos(el), Math.sin(el), Math.sin(a) * Math.cos(el)];
		const L = room(p, d);
		if (L > 0.4) branch(p, d, L, 1, (trunkR[i] as number) * (sp.crown === "cone" ? 0.35 : 0.62));
	}
	// a leader tuft for conifers and ginkgo
	const tufts: Card[] = [];
	if (sp.crown === "cone" || sp.crown === "oval") {
		const tip = trunk[nseg - 1] as V3;
		for (let k = 0; k < 6; k++)
			tufts.push({ p: add(tip, [r.normal(0.3), -k * 0.35, r.normal(0.3)]), dir: UP, size: 1, depth: 3 });
	}

	// cards: those on twigs first (kept bare in winter), then the shell for a full silhouette
	const want = lod === 0 ? sp.cards : Math.max(16, Math.round(sp.cards / 4.5));
	const ntw = Math.min(twigs.length, Math.round(want * (sp.deciduous ? 0.5 : 0.35)));
	const chosen: Card[] = [];
	const pool = twigs.slice();
	for (let i = 0; i < ntw; i++) {
		const j = Math.floor(r.next() * pool.length);
		chosen.push(pool[j] as Card);
		pool[j] = pool[pool.length - 1] as Card;
		pool.pop();
	}
	const twigCards = chosen.length;
	chosen.push(...tufts);
	const tips = chosen.map((c) => c.p);
	let tries = 0;
	while (chosen.length < want && tries++ < want * 40) {
		const y = r.range(zs, H);
		const R = envelope(sp, H, y);
		if (R < 0.2) continue;
		if (sp.crown === "pine" && tips.length) {
			// pine: flat pads of needles around the branch ends
			const c0 = tips[Math.floor(r.next() * tips.length)] as V3;
			chosen.push({ p: add(c0, [r.normal(0.5), r.normal(0.12), r.normal(0.5)]), dir: UP, size: 1, depth: 3 });
			continue;
		}
		const a = r.range(0, 2 * Math.PI);
		const rr = R * r.range(0.55, 1) ** 0.5;
		chosen.push({
			p: [Math.cos(a) * rr, y, Math.sin(a) * rr],
			dir: norm([Math.cos(a), 0.6, Math.sin(a)]),
			size: 1,
			depth: 3,
		});
	}

	const leaves = new Builder();
	const scale = lod === 0 ? 1 : 1.9;
	let rmax = 1e-3;
	for (const c of chosen) rmax = Math.max(rmax, Math.hypot(c.p[0], c.p[2]));
	const cell = sp.leafCell;
	const cu = cell % ATLAS_N;
	const cv = Math.floor(cell / ATLAS_N);
	const U = (x: number): number => (cu + x) / ATLAS_N;
	const V = (y: number): number => (cv + y) / ATLAS_N;
	let radius = 0;
	let height = 0;
	for (const c of chosen) {
		const size = r.range(sp.card[0], sp.card[1]) * scale;
		const o = sub(c.p, crownC);
		const ol = len(o);
		const out: V3 = ol > 1e-6 ? mul(o, 1 / ol) : UP;
		let up: V3;
		let n: V3;
		if (sp.crown === "pine" && r.next() < 0.5) {
			// a pad lying flat: needles seen from above and below
			up = norm([out[0], 0.15, out[2]]);
			n = norm(add(UP, [r.normal(0.2), 0, r.normal(0.2)]));
			n = norm(sub(n, mul(up, dot(n, up))));
		} else {
			up = norm(add(add(mul(c.dir, 0.6), mul(out, 0.4)), [0, 0.35, 0]));
			// sprays do not hang straight down (bare, they would look like brooms)
			if (up[1] < 0.1) up = norm([up[0], 0.1 + (0.1 - up[1]) * 0.5, up[2]]);
			n = sub(out, mul(up, dot(out, up)));
			n = len(n) > 1e-3 ? norm(n) : norm(cross(up, [1, 0, 0]));
			n = add(n, [r.normal(0.35), r.normal(0.35), r.normal(0.35)]);
			n = norm(sub(n, mul(up, dot(n, up))));
		}
		const side = cross(up, n);
		// the atlas cluster grows from the bottom centre of its cell: that point sits on the twig
		const base = sub(c.p, mul(up, size * 0.05));
		const q: V3[] = [
			sub(base, mul(side, size / 2)),
			add(base, mul(side, size / 2)),
			add(add(base, mul(side, size / 2)), mul(up, size)),
			add(sub(base, mul(side, size / 2)), mul(up, size)),
		];
		const uvs: [number, number][] = [
			[U(0.02), V(0.98)],
			[U(0.98), V(0.98)],
			[U(0.98), V(0.02)],
			[U(0.02), V(0.02)],
		];
		const nn = norm(add(mul(n, 0.45), mul(out, 0.55)));
		const hz = Math.min(1, Math.max(0, (c.p[1] - zs) / Math.max(H - zs, 1e-3)));
		const rnd = r.next();
		const outer = Math.min(1, Math.hypot(c.p[0], c.p[2]) / rmax) * 0.7 + hz * 0.3;
		const w = 0.7 + 0.3 * Math.min(1, c.depth / 3);
		const b0 = leaves.count;
		for (let k = 0; k < 4; k++) {
			const v = q[k] as V3;
			const t = uvs[k] as [number, number];
			leaves.vertex(v, nn, t[0], t[1], [outer, rnd, hz, w]);
			radius = Math.max(radius, Math.hypot(v[0], v[2]));
			height = Math.max(height, v[1]);
		}
		leaves.i.push(b0, b0 + 1, b0 + 2, b0, b0 + 2, b0 + 3);
	}
	for (let i = 0; i < wood.p.length; i += 3) {
		radius = Math.max(radius, Math.hypot(wood.p[i] as number, wood.p[i + 2] as number));
		height = Math.max(height, wood.p[i + 1] as number);
	}
	return { species, variant, lod, height, radius, wood: wood.mesh(), leaves: leaves.mesh(), twigCards };
}

function SPECIES_SEED(sp: Species): number {
	let h = 7;
	for (let i = 0; i < sp.length; i++) h = (h * 31 + sp.charCodeAt(i)) >>> 0;
	return h % 10007;
}

/** Triangles in a template (wood + leaves). */
export const triangles = (t: TreeTemplate): number => (t.wood.index.length + t.leaves.index.length) / 3;
