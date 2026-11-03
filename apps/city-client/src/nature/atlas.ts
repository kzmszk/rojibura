// The leaf atlas, drawn at start (no photographs): 4 x 4 cells of 512 px, each a spray of life-size leaves
// on fine twigs (after the Kyoto demo's tools/gen/leafatlas.py). Channels are data, coloured by the shader:
// R = luminance (shading, veins), G = a random value per leaf (leaf-by-leaf colour), B = twig mask (bark-coloured),
// A = coverage (alpha test). Mipmaps keep each cell's coverage, so crowns do not thin out in the distance.
//
// Cells: see CELL in species.ts (one per species' leaf shape, cherry blossom, pine needles, cedar sprays, bare
// winter twigs, a patch of fallen leaves, single leaves and petals, a patch of fallen petals).

import * as THREE from "three";
import { Rng } from "./rng.ts";
import { CELL, SINGLE } from "./species.ts";

const C = 512;
const N = 4;
/** Drawing resolution per cell (supersampled, then reduced to C). */
const W = 1024;

type P2 = [number, number];
type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

function canvas(w: number, h: number): HTMLCanvasElement | OffscreenCanvas {
	if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(w, h);
	const c = document.createElement("canvas");
	c.width = w;
	c.height = h;
	return c;
}

const grey = (v: number): string => {
	const g = Math.max(0, Math.min(255, Math.round(v)));
	return `rgb(${g},${g},${g})`;
};

/** The four channels of one cell, drawn alike. */
class Layers {
	readonly cv = [canvas(W, W), canvas(W, W), canvas(W, W), canvas(W, W)];
	readonly ctx: Ctx[];

	constructor() {
		this.ctx = this.cv.map((c) => c.getContext("2d") as Ctx);
		// backgrounds: a mid luminance and random value so the mipmaps blend toward something sensible
		const bg = [150, 128, 0, 0];
		this.ctx.forEach((c, i) => {
			c.fillStyle = grey(bg[i] as number);
			c.fillRect(0, 0, W, W);
			c.lineCap = "round";
			c.lineJoin = "round";
		});
	}

	/** lum, rnd, twig, alpha */
	private style(vals: [number, number, number, number], stroke: boolean, width = 1): void {
		this.ctx.forEach((c, i) => {
			if (stroke) {
				c.strokeStyle = grey(vals[i] as number);
				c.lineWidth = width;
			} else c.fillStyle = grey(vals[i] as number);
		});
	}

	stick(a: P2, b: P2, w: number, shade = 70): void {
		this.style([shade, 128, 255, 255], true, Math.max(1, w));
		for (const c of this.ctx) {
			c.beginPath();
			c.moveTo(a[0], a[1]);
			c.lineTo(b[0], b[1]);
			c.stroke();
		}
	}

	poly(pts: P2[], shade: number, g: number): void {
		if (pts.length < 3) return;
		this.style([shade, g, 0, 255], false);
		for (const c of this.ctx) {
			c.beginPath();
			c.moveTo((pts[0] as P2)[0], (pts[0] as P2)[1]);
			for (let i = 1; i < pts.length; i++) c.lineTo((pts[i] as P2)[0], (pts[i] as P2)[1]);
			c.closePath();
			c.fill();
		}
	}

	/** A line on the luminance only (veins). */
	vein(a: P2, b: P2, w: number, shade: number): void {
		const c = this.ctx[0] as Ctx;
		c.strokeStyle = grey(shade);
		c.lineWidth = Math.max(1, w);
		c.beginPath();
		c.moveTo(a[0], a[1]);
		c.lineTo(b[0], b[1]);
		c.stroke();
	}
}

// ---- leaf outlines: petiole at the origin, blade toward +y (metres)

/** Serrate an outline: teeth pointing forward along it. */
function saw(pts: P2[], amp: number, period: number): P2[] {
	const out: P2[] = [];
	let acc = 0;
	for (let i = 0; i < pts.length; i++) {
		const a = pts[i] as P2;
		const b = pts[(i + 1) % pts.length] as P2;
		const dx = b[0] - a[0];
		const dy = b[1] - a[1];
		const L = Math.hypot(dx, dy);
		if (L < 1e-9) continue;
		const nx = dy / L;
		const ny = -dx / L;
		const k = Math.max(1, Math.floor(L / (period / 4)));
		for (let j = 0; j < k; j++) {
			const t = j / k;
			acc += L / k;
			const ph = (acc / period) % 1;
			out.push([a[0] + dx * t + nx * amp * ph * ph, a[1] + dy * t + ny * amp * ph * ph]);
		}
	}
	return out;
}

const rot = (pts: P2[], a: number): P2[] => {
	const c = Math.cos(a);
	const s = Math.sin(a);
	return pts.map(([x, y]) => [x * c + y * s, -x * s + y * c]);
};
const shift = (pts: P2[], dx: number, dy: number): P2[] => pts.map(([x, y]) => [x + dx, y + dy]);

/** One lanceolate lobe from the leaf centre along +y. */
function lobe(L: number, w: number, tooth: number, tip: number, pb: number, neck: number): P2[] {
	const left: P2[] = [];
	const right: P2[] = [];
	const norm = (pb / (pb + tip)) ** pb * (tip / (pb + tip)) ** tip;
	for (let k = 0; k <= 24; k++) {
		const s = k / 24;
		let ww = (w * s ** pb * (1 - s) ** tip) / norm;
		if (neck) {
			const u = Math.min(1, s / neck);
			ww *= u * u * (3 - 2 * u);
		}
		left.push([-ww, s * L]);
		right.push([ww, s * L]);
	}
	const pts = [...left, ...right.reverse()];
	return tooth ? saw(pts, tooth, L * 0.09) : pts;
}

interface Shape {
	polys: P2[][];
	veins: [P2, P2][];
}

/** Palmate leaves: Japanese maple (7 deep narrow lobes), a rounder maple (9-11 shallow lobes), plane (5 broad lobes). */
function palmate(size: number, kind: "momiji" | "kaede" | "platanus", r: Rng): Shape {
	let angs: number[];
	let lens: number[];
	let w: number;
	let body: number;
	let tooth: number;
	let pb: number;
	let neck: number;
	let tip = 1.0;
	if (kind === "momiji") {
		angs = [0, 0.52, 1.05, 1.68];
		lens = [1, 0.93, 0.78, 0.42];
		w = 0.15;
		body = 0.15;
		tooth = 0.03;
		pb = 0.6;
		neck = 0.5;
		tip = 1.25;
	} else if (kind === "kaede") {
		const n = r.int(4, 5);
		angs = [0];
		lens = [1];
		for (let k = 1; k <= n; k++) {
			angs.push((k * 2.75) / n);
			lens.push(1 - 0.35 * (k / n) ** 2);
		}
		w = 0.2;
		body = 0.55;
		tooth = 0.025;
		pb = 0.45;
		neck = 0;
	} else {
		angs = [0, 0.85, 1.65];
		lens = [1, 0.9, 0.55];
		w = 0.3;
		body = 0.45;
		tooth = 0.05;
		pb = 0.5;
		neck = 0;
		tip = 1.4;
	}
	const polys: P2[][] = [];
	const veins: [P2, P2][] = [];
	const cy = size * 0.25;
	angs.forEach((a, i) => {
		for (const sg of a === 0 ? [1] : [1, -1]) {
			const aa = a * sg * r.range(0.95, 1.05);
			const l = lens[i] as number;
			const pts = lobe(size * l, size * w * r.range(0.9, 1.1), size * tooth, tip, pb, neck);
			polys.push(shift(rot(pts, aa), 0, cy));
			veins.push([
				[0, cy],
				[Math.sin(aa) * size * l * 0.85, cy + Math.cos(aa) * size * l * 0.85],
			]);
		}
	});
	const bodyPts: P2[] = [];
	for (let k = 0; k < 24; k++) {
		const t = (k / 24) * 2 * Math.PI;
		bodyPts.push([Math.sin(t) * size * body, cy + Math.cos(t) * size * body]);
	}
	polys.push(bodyPts);
	return { polys, veins };
}

/** A ginkgo fan: wedge base, wavy outer edge, often notched in the middle; radial veins. */
function ginkgo(size: number, r: Rng): Shape {
	const spread = r.range(1.0, 1.2);
	const notch = r.next() < 0.7 ? r.range(0, 0.35) : 0;
	const pts: P2[] = [[0, size * 0.08]];
	for (let k = 0; k <= 40; k++) {
		const a = -spread + (k / 40) * 2 * spread;
		const rr = size * (1 + 0.04 * Math.sin(a * 23 + r.next())) * (1 - notch * Math.exp(-((a / 0.06) ** 2)));
		pts.push([Math.sin(a) * rr, size * 0.08 + Math.cos(a) * rr * 0.92]);
	}
	const veins: [P2, P2][] = [];
	for (let k = 0; k < 13; k++) {
		const a = -spread * 0.95 + (k / 12) * spread * 1.9;
		veins.push([
			[0, size * 0.08],
			[Math.sin(a) * size * 0.95, size * 0.08 + Math.cos(a) * size * 0.88],
		]);
	}
	return { polys: [pts], veins };
}

/**
 * Simple leaves: ovate (cherry, zelkova), triangular (birch), heart-shaped (linden), lobed (oak).
 * `base` widens the blade near the petiole (birch, linden), `cord` notches it (linden), `lobes` cuts rounded
 * lobes (oak).
 */
function simple(
	L: number,
	w: number,
	o: {
		tooth?: number;
		tip?: number;
		asym?: number;
		base?: number;
		cord?: number;
		lobes?: number;
		obovate?: number;
	},
	r: Rng,
): Shape {
	const left: P2[] = [];
	const right: P2[] = [];
	const tip = o.tip ?? 1.6;
	for (let k = 0; k <= 36; k++) {
		const s = k / 36;
		const sk = o.obovate ? s ** (1 + o.obovate) : s ** 0.85;
		let ww = w * 0.5 * Math.sin(Math.PI * sk) ** 0.9 * (1 - 0.35 * s ** (tip * 2));
		if (o.base) ww = Math.max(ww, w * 0.5 * o.base * Math.sin(Math.PI * Math.min(1, s * 2.2)) * (1 - s));
		if (o.lobes) ww *= 0.72 + 0.28 * Math.abs(Math.sin(s * Math.PI * o.lobes + 0.4)) ** 0.6;
		let y = s * L;
		if (o.cord && s < 0.2) y += o.cord * L * (1 - s / 0.2) * Math.min(1, s * 12) * 0.5;
		left.push([-ww * (1 + (o.asym ?? 0) * (1 - s)), y]);
		right.push([ww, y]);
	}
	let pts = [...left, ...right.reverse()];
	if (o.tooth) pts = saw(pts, o.tooth, L * 0.055);
	const veins: [P2, P2][] = [
		[
			[0, 0],
			[0, L * 0.95],
		],
	];
	for (let k = 0; k < 6; k++) {
		const t = 0.15 + k * 0.11;
		for (const sg of [-1, 1])
			veins.push([
				[0, L * t],
				[sg * w * 0.42, L * (t + 0.12)],
			]);
	}
	r.next();
	return { polys: [pts], veins };
}

/** A cherry petal: a rounded oval with a notch at its tip, base at the origin. */
function petal(L: number): P2[] {
	const pts: P2[] = [];
	for (let k = 0; k <= 30; k++) {
		const t = (k / 30) * 2 * Math.PI;
		const y = ((1 - Math.cos(t)) / 2) * L;
		let x = Math.sin(t) * L * 0.36 * (0.35 + 0.65 * Math.sin(Math.PI * Math.min(1, (y / L) * 1.15)) ** 0.5);
		const notch = Math.exp(-((x / (L * 0.08)) ** 2)) * L * 0.14;
		if (y > L * 0.8) x *= 1;
		pts.push([x, y - (y > L * 0.85 ? notch : 0)]);
	}
	return pts;
}

/** Puts a shape at `at`, blade pointing along angle `ang` (0 = up in the image). */
function put(
	ly: Layers,
	s: Shape,
	at: P2,
	ang: number,
	shade: number,
	g: number,
	veinD: number,
	sx: number,
): void {
	const D: P2 = [Math.sin(ang), -Math.cos(ang)];
	const Pp: P2 = [Math.cos(ang), Math.sin(ang)];
	const tr = ([x, y]: P2): P2 => [at[0] + Pp[0] * x + D[0] * y, at[1] + Pp[1] * x + D[1] * y];
	for (const poly of s.polys) ly.poly(poly.map(tr), shade, g);
	for (const [a, b] of s.veins) ly.vein(tr(a), tr(b), sx, shade + veinD);
}

type Leafy =
	| "momiji"
	| "kaede"
	| "ichou"
	| "keyaki"
	| "nara"
	| "platanus"
	| "bodaiju"
	| "shirakaba"
	| "sakura";

/** Metres across a cell, per kind (the cards of treegen are about this size): leaves are drawn life size. */
const SCALE: Record<Leafy | "blossom", number> = {
	momiji: 0.8,
	kaede: 0.95,
	ichou: 1.1,
	keyaki: 1.2,
	nara: 1.15,
	platanus: 1.3,
	bodaiju: 1.15,
	shirakaba: 0.85,
	sakura: 0.95,
	blossom: 0.95,
};

/** One leaf of a kind, `ppm` pixels per metre. */
function leafShape(kind: Leafy, ppm: number, r: Rng): Shape {
	switch (kind) {
		case "momiji":
			return palmate(ppm * r.range(0.022, 0.03), "momiji", r);
		case "kaede":
			return palmate(ppm * r.range(0.032, 0.042), "kaede", r);
		case "platanus":
			return palmate(ppm * r.range(0.06, 0.085), "platanus", r);
		case "ichou":
			return ginkgo(ppm * r.range(0.025, 0.035), r);
		case "sakura": {
			const L = ppm * r.range(0.07, 0.1);
			return simple(L, L * r.range(0.45, 0.55), { tooth: L * 0.012 }, r);
		}
		case "keyaki": {
			const L = ppm * r.range(0.04, 0.065);
			return simple(L, L * r.range(0.36, 0.44), { tooth: L * 0.035, asym: 0.15 }, r);
		}
		case "shirakaba": {
			const L = ppm * r.range(0.04, 0.06);
			return simple(L, L * r.range(0.6, 0.72), { tooth: L * 0.03, base: 1.0, tip: 1.2 }, r);
		}
		case "bodaiju": {
			const L = ppm * r.range(0.06, 0.085);
			return simple(
				L,
				L * r.range(0.75, 0.9),
				{ tooth: L * 0.018, base: 1.0, cord: 0.25, asym: 0.12, tip: 1.3 },
				r,
			);
		}
		case "nara": {
			const L = ppm * r.range(0.07, 0.1);
			return simple(L, L * r.range(0.5, 0.58), { lobes: r.int(5, 7), obovate: 0.6, tip: 0.9 }, r);
		}
	}
}

/** A spray of life-size leaves on fine twigs (after leafatlas.broadleaf_cell). */
function broadleafCell(ly: Layers, kind: Leafy, r: Rng): void {
	const ppm = W / SCALE[kind];
	const S = W / C;
	const segs: { p: P2; q: P2; depth: number; ang: number; w: number }[] = [];
	const grow = (p: P2, ang: number, length: number, depth: number, w: number, maxd: number): void => {
		const q: P2 = [p[0] + Math.sin(ang) * length, p[1] - Math.cos(ang) * length];
		segs.push({ p, q, depth, ang, w });
		if (depth < maxd) {
			for (const side of [-1, 1]) {
				for (const t of depth < 2 ? [0.35, 0.75] : [0.5]) {
					if (r.next() < 0.85) {
						const mid: P2 = [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
						grow(
							mid,
							ang + side * r.range(0.5, 1.15),
							length * r.range(0.62, 0.8),
							depth + 1,
							w * 0.65,
							maxd,
						);
					}
				}
			}
		}
	};
	grow([W * 0.5, W * 0.95], r.range(-0.12, 0.12), W * 0.4, 0, 5 * S, 4);
	for (const s of segs) ly.stick(s.p, s.q, s.w);
	const leaves: [P2, number][] = [];
	for (const s of segs) {
		if (s.depth < 1) continue;
		const L = Math.hypot(s.q[0] - s.p[0], s.q[1] - s.p[1]);
		const at = (t: number): P2 => [s.p[0] + (s.q[0] - s.p[0]) * t, s.p[1] + (s.q[1] - s.p[1]) * t];
		if (kind === "momiji" || kind === "kaede" || kind === "platanus") {
			// opposite pairs (maples), alternate (plane), a terminal leaf at the end
			const sp = ppm * (kind === "momiji" ? 0.035 : kind === "kaede" ? 0.05 : 0.09);
			const n = Math.max(1, Math.floor(L / sp));
			for (let i = 1; i <= n; i++) {
				const b = at(i / n);
				const a = r.range(0.9, 1.5);
				if (kind === "platanus") leaves.push([b, s.ang + (i % 2 ? a : -a)]);
				else leaves.push([b, s.ang + a], [b, s.ang - a]);
			}
			leaves.push([s.q, s.ang + r.normal(0.2)]);
		} else if (kind === "ichou") {
			// short spurs with 3-5 fans
			const sp = ppm * 0.055;
			const n = Math.max(1, Math.floor(L / sp));
			for (let i = 0; i < n; i++) {
				const b = at((i + 0.5) / n);
				for (let k = r.int(3, 5); k > 0; k--) leaves.push([b, s.ang + r.normal(0.9)]);
			}
		} else {
			// alternate along the twig (two-ranked for zelkova)
			const sp =
				ppm *
				(kind === "keyaki"
					? 0.017
					: kind === "shirakaba"
						? 0.02
						: kind === "sakura"
							? 0.03
							: kind === "bodaiju"
								? 0.03
								: 0.035);
			const n = Math.max(1, Math.floor(L / sp));
			for (let i = 0; i < n; i++) {
				const side = i % 2 ? 1 : -1;
				leaves.push([
					at((i + 0.5) / n),
					s.ang + side * r.range(0.6, 1.1) + (kind === "nara" ? r.normal(0.3) : 0),
				]);
			}
			if (kind === "nara") for (let k = 0; k < 3; k++) leaves.push([s.q, s.ang + r.normal(0.6)]);
		}
	}
	// shuffled, so no side always lies on top
	for (let i = leaves.length - 1; i > 0; i--) {
		const j = Math.floor(r.next() * (i + 1));
		[leaves[i], leaves[j]] = [leaves[j] as [P2, number], leaves[i] as [P2, number]];
	}
	for (const [base, ang] of leaves) {
		// keep the spray inside its cell (a leaf cut by the cell's edge shows a straight line)
		if (Math.hypot((base[0] - W * 0.5) / 0.42, (base[1] - W * 0.52) / 0.45) > W) continue;
		const shape = leafShape(kind, ppm, r);
		const pet =
			(kind === "momiji" || kind === "kaede"
				? r.range(0.5, 0.9)
				: kind === "ichou"
					? r.range(0.6, 1.1)
					: 0.12) *
			0.03 *
			ppm;
		const tip: P2 = [base[0] + Math.sin(ang) * pet, base[1] - Math.cos(ang) * pet];
		ly.stick(base, tip, S * 1.1, 110);
		const veinD = kind === "momiji" || kind === "kaede" || kind === "platanus" ? 22 : -16;
		put(ly, shape, tip, ang + r.normal(0.12), r.range(165, 240), r.range(0, 255), veinD, S);
	}
}

/** Cherry blossom: twigs crowded with clusters of five-petalled flowers (pale; the shader colours them). */
function blossomCell(ly: Layers, r: Rng): void {
	const ppm = W / SCALE.blossom;
	const S = W / C;
	const nodes: [P2, number][] = [];
	const grow = (p: P2, ang: number, length: number, depth: number, w: number): void => {
		const q: P2 = [p[0] + Math.sin(ang) * length, p[1] - Math.cos(ang) * length];
		ly.stick(p, q, w, 60);
		if (depth >= 1) {
			const n = Math.max(1, Math.floor(length / (ppm * 0.055)));
			for (let i = 0; i <= n; i++)
				nodes.push([[p[0] + ((q[0] - p[0]) * i) / n, p[1] + ((q[1] - p[1]) * i) / n], ang]);
		}
		if (depth < 4) {
			for (const t of depth < 2 ? [0.3, 0.6, 0.85] : [0.4, 0.75]) {
				for (const side of [-1, 1]) {
					if (r.next() < 0.8) {
						grow(
							[p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t],
							ang + side * r.range(0.45, 1.0),
							length * r.range(0.55, 0.72),
							depth + 1,
							w * 0.66,
						);
					}
				}
			}
		}
	};
	grow([W * 0.5, W * 0.96], r.range(-0.12, 0.12), W * 0.4, 0, 6 * S);
	for (const [q] of nodes) {
		if (Math.hypot((q[0] - W * 0.5) / 0.43, (q[1] - W * 0.5) / 0.45) > W) continue;
		if (r.next() < 0.2) continue;
		const nf = r.int(3, 6);
		const g = r.range(0, 255);
		for (let f = 0; f < nf; f++) {
			const c: P2 = [q[0] + r.normal(0.016 * ppm), q[1] + r.normal(0.016 * ppm)];
			const L = ppm * r.range(0.014, 0.019);
			const a0 = r.range(0, 2 * Math.PI);
			const gf = Math.max(0, Math.min(255, g + r.normal(30)));
			for (let k = 0; k < 5; k++) {
				const a = a0 + (k * 2 * Math.PI) / 5 + r.normal(0.08);
				put(ly, { polys: [petal(L)], veins: [] }, c, a, r.range(228, 252), gf, 0, S);
			}
			// the centre: darker, pinker
			ly.poly(
				Array.from(
					{ length: 10 },
					(_, k): P2 => [
						c[0] + Math.cos((k / 10) * 6.283) * L * 0.2,
						c[1] + Math.sin((k / 10) * 6.283) * L * 0.2,
					],
				),
				195,
				255,
			);
		}
	}
}

/** Bare winter twigs: fine, forking, tapering, with buds at the tips. */
function twigCell(ly: Layers, r: Rng): void {
	const S = W / C;
	const grow = (p: P2, ang: number, length: number, depth: number, w: number): void => {
		// a twig zigzags a little at each bud
		const n = 3;
		let a = p;
		for (let i = 1; i <= n; i++) {
			const b: P2 = [
				a[0] + Math.sin(ang + r.normal(0.12)) * (length / n),
				a[1] - Math.cos(ang + r.normal(0.12)) * (length / n),
			];
			ly.stick(a, b, w * (1 - (0.35 * i) / n), r.range(55, 95));
			a = b;
		}
		if (depth >= 5 || length < W * 0.04) {
			ly.stick(a, a, w * 1.6, 80);
			return;
		}
		const kids = depth < 2 ? 3 : 2;
		for (let k = 0; k < kids; k++) {
			if (r.next() > 0.92) continue;
			const t = k === kids - 1 ? 1 : r.range(0.35, 0.85);
			const q: P2 = [p[0] + (a[0] - p[0]) * t, p[1] + (a[1] - p[1]) * t];
			const side = k % 2 ? 1 : -1;
			grow(
				q,
				ang + side * r.range(0.25, 0.7),
				length * r.range(0.58, 0.75),
				depth + 1,
				Math.max(S * 0.9, w * 0.68),
			);
		}
	};
	grow([W * 0.5, W * 0.97], r.range(-0.08, 0.08), W * 0.42, 0, 7 * S);
	for (let k = 0; k < 2; k++)
		grow([W * r.range(0.35, 0.65), W * 0.97], r.range(-0.6, 0.6), W * 0.3, 1, 4 * S);
}

/** Pine: tufts of long paired needles fanning from the twigs. */
function pineCell(ly: Layers, r: Rng): void {
	const S = W / C;
	const nodes: [P2, number][] = [];
	const grow = (p: P2, ang: number, length: number, depth: number, w: number): void => {
		const q: P2 = [p[0] + Math.sin(ang) * length, p[1] - Math.cos(ang) * length];
		ly.stick(p, q, w, 70);
		nodes.push([q, ang]);
		for (const t of [0.4, 0.7]) nodes.push([[p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t], ang]);
		if (depth < 3)
			for (const side of [-1, 1])
				if (r.next() < 0.9) {
					const t = r.range(0.3, 0.8);
					grow(
						[p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t],
						ang + side * r.range(0.4, 0.9),
						length * r.range(0.55, 0.7),
						depth + 1,
						w * 0.7,
					);
				}
	};
	grow([W * 0.5, W * 0.95], 0, W * 0.45, 1, 6 * S);
	for (const [q, ang] of nodes) {
		for (let k = 0; k < 40; k++) {
			const a = ang + r.normal(0.8);
			const L = W * r.range(0.08, 0.13);
			const p0: P2 = [q[0] + r.normal(W * 0.02), q[1] + r.normal(W * 0.02)];
			const p1: P2 = [p0[0] + Math.sin(a) * L, p0[1] - Math.cos(a) * L];
			ly.poly([[p0[0] - 1.6 * S, p0[1]], [p0[0] + 1.6 * S, p0[1]], p1], r.range(120, 210), r.range(0, 255));
		}
	}
}

/** Cedar (sugi): flat sprays of short awl needles. */
function cedarCell(ly: Layers, r: Rng): void {
	const S = W / C;
	const spray = (p: P2, ang: number, length: number, depth: number): void => {
		const q: P2 = [p[0] + Math.sin(ang) * length, p[1] - Math.cos(ang) * length];
		const shade = r.range(110, 190);
		ly.poly([[p[0] - 2 * S, p[1]], [p[0] + 2 * S, p[1]], q], shade, r.range(0, 255));
		for (let i = 0; i < 22; i++) {
			const t = 0.05 + (i / 21) * 0.95;
			const m: P2 = [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
			for (const sd of [-1, 1]) {
				const a2 = ang + sd * 0.7;
				const L = W * 0.034 * (1 - t * 0.4);
				ly.poly(
					[
						[m[0] - 1.5 * S, m[1]],
						[m[0] + 1.5 * S, m[1]],
						[m[0] + Math.sin(a2) * L, m[1] - Math.cos(a2) * L],
					],
					r.range(100, 180),
					r.range(0, 255),
				);
			}
		}
		if (depth < 3)
			for (const t of [0.3, 0.55, 0.8])
				for (const sd of [-1, 1])
					if (r.next() < 0.8)
						spray(
							[p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t],
							ang + sd * r.range(0.6, 0.95),
							length * r.range(0.35, 0.5),
							depth + 1,
						);
	};
	spray([W * 0.5, W * 0.95], r.range(-0.1, 0.1), W * 0.8, 0);
}

const LITTER_KINDS: Leafy[] = ["momiji", "momiji", "kaede", "ichou", "keyaki", "sakura", "nara", "platanus"];

/** A patch of fallen leaves, thinning toward its edge (instanced on the ground under the trees). */
function litterCell(ly: Layers, r: Rng): void {
	const ppm = W / 0.9;
	for (let i = 0; i < 420; i++) {
		const a = r.range(0, 2 * Math.PI);
		const d = Math.sqrt(r.next()) * W * 0.46;
		if (d > W * 0.3 && r.next() < (d - W * 0.3) / (W * 0.16)) continue;
		const kind = r.pick(LITTER_KINDS);
		const s = leafShape(kind, ppm, r);
		put(
			ly,
			s,
			[W / 2 + Math.cos(a) * d, W / 2 + Math.sin(a) * d],
			r.range(0, 6.283),
			r.range(140, 235),
			r.range(0, 255),
			-12,
			W / C,
		);
	}
}

/** Single leaves and petals on a 4 x 4 grid (falling leaves and petals pick one each). */
function singlesCell(ly: Layers, r: Rng): void {
	const sub = W / 4;
	const order: (Leafy | "petal")[] = [];
	order[SINGLE.momiji] = "momiji";
	order[SINGLE.kaede] = "kaede";
	order[SINGLE.ichou] = "ichou";
	order[SINGLE.keyaki] = "keyaki";
	order[SINGLE.nara] = "nara";
	order[SINGLE.platanus] = "platanus";
	order[SINGLE.bodaiju] = "bodaiju";
	order[SINGLE.shirakaba] = "shirakaba";
	order[SINGLE.sakura] = "sakura";
	order[SINGLE.petal] = "petal";
	order[SINGLE.petal2] = "petal";
	order[SINGLE.momiji2] = "momiji";
	for (let i = 0; i < 16; i++) {
		const kind = order[i] ?? "keyaki";
		const cx = (i % 4) * sub + sub / 2;
		const cy = Math.floor(i / 4) * sub + sub / 2;
		if (kind === "petal") {
			const L = sub * 0.8;
			put(ly, { polys: [petal(L)], veins: [] }, [cx, cy + L / 2], 0, 235, 128, 0, 1);
			continue;
		}
		// sized to fill the sub-cell (the particle quad sets the real size)
		const probe = leafShape(kind, 1000, new Rng(i + 1));
		let ext = 0;
		for (const p of probe.polys) for (const [x, y] of p) ext = Math.max(ext, Math.abs(x), Math.abs(y));
		const s = leafShape(kind, (1000 * sub * 0.44) / ext, new Rng(i + 1));
		put(
			ly,
			s,
			[
				cx,
				cy +
					sub *
						0.44 *
						(kind === "ichou" || kind === "momiji" || kind === "kaede" || kind === "platanus" ? 0.4 : 0.9),
			],
			0,
			200,
			128,
			kind === "momiji" ? 20 : -15,
			2,
		);
	}
	r.next();
}

/** Fallen cherry petals, a patch thinning toward its edge. */
function petalsCell(ly: Layers, r: Rng): void {
	for (let i = 0; i < 1400; i++) {
		const a = r.range(0, 2 * Math.PI);
		const d = Math.sqrt(r.next()) * W * 0.47;
		if (d > W * 0.25 && r.next() < (d - W * 0.25) / (W * 0.22)) continue;
		const L = (W / 0.9) * r.range(0.015, 0.02);
		put(
			ly,
			{ polys: [petal(L)], veins: [] },
			[W / 2 + Math.cos(a) * d, W / 2 + Math.sin(a) * d],
			r.range(0, 6.283),
			r.range(200, 250),
			r.range(0, 255),
			0,
			1,
		);
	}
}

/** Draws every cell into RGBA (C*N square). */
function drawAtlas(): Uint8Array {
	const out = new Uint8Array(C * N * C * N * 4);
	const small = canvas(C, C);
	const sctx = small.getContext("2d") as Ctx;
	sctx.imageSmoothingQuality = "high";
	const cells: [number, (ly: Layers, r: Rng) => void][] = [
		[CELL.momiji, (l, r) => broadleafCell(l, "momiji", r)],
		[CELL.kaede, (l, r) => broadleafCell(l, "kaede", r)],
		[CELL.ichou, (l, r) => broadleafCell(l, "ichou", r)],
		[CELL.keyaki, (l, r) => broadleafCell(l, "keyaki", r)],
		[CELL.nara, (l, r) => broadleafCell(l, "nara", r)],
		[CELL.platanus, (l, r) => broadleafCell(l, "platanus", r)],
		[CELL.bodaiju, (l, r) => broadleafCell(l, "bodaiju", r)],
		[CELL.shirakaba, (l, r) => broadleafCell(l, "shirakaba", r)],
		[CELL.sakura, (l, r) => broadleafCell(l, "sakura", r)],
		[CELL.blossom, blossomCell],
		[CELL.pine, pineCell],
		[CELL.cedar, cedarCell],
		[CELL.twigs, twigCell],
		[CELL.litter, litterCell],
		[CELL.singles, singlesCell],
		[CELL.petals, petalsCell],
	];
	for (const [cell, draw] of cells) {
		const ly = new Layers();
		draw(ly, new Rng(1000 + cell * 7));
		const x0 = (cell % N) * C;
		const y0 = Math.floor(cell / N) * C;
		ly.cv.forEach((cv, ch) => {
			sctx.clearRect(0, 0, C, C);
			sctx.drawImage(cv, 0, 0, C, C);
			const px = sctx.getImageData(0, 0, C, C).data;
			for (let y = 0; y < C; y++) {
				let o = ((y0 + y) * C * N + x0) * 4 + ch;
				let i = y * C * 4;
				for (let x = 0; x < C; x++, o += 4, i += 4) out[o] = px[i] as number;
			}
		});
	}
	return out;
}

/**
 * Mip levels that keep each cell's alpha-tested coverage (Castaño): a plain box filter lets thin leaves and
 * twigs fade under the threshold, and crowns go thin and bald in the distance.
 */
function mipChain(base: Uint8Array, size: number): { data: Uint8Array; width: number; height: number }[] {
	const levels = [{ data: base, width: size, height: size }];
	const cell = (s: number) => s / N;
	const coverage = (d: Uint8Array, s: number, cx: number, cy: number, k: number): number => {
		const cs = cell(s);
		let n = 0;
		for (let y = cy * cs; y < (cy + 1) * cs; y++)
			for (let x = cx * cs; x < (cx + 1) * cs; x++) if ((d[(y * s + x) * 4 + 3] as number) * k > 127) n++;
		return n / (cs * cs);
	};
	const target: number[] = [];
	for (let c = 0; c < N * N; c++) target.push(coverage(base, size, c % N, Math.floor(c / N), 1));
	let prev = base;
	let s = size;
	while (s > 1) {
		const ns = s >> 1;
		const d = new Uint8Array(ns * ns * 4);
		for (let y = 0; y < ns; y++)
			for (let x = 0; x < ns; x++) {
				const o = (y * ns + x) * 4;
				const a = (2 * y * s + 2 * x) * 4;
				const b = a + 4;
				const c = a + s * 4;
				const e = c + 4;
				for (let ch = 0; ch < 4; ch++)
					d[o + ch] =
						((prev[a + ch] as number) +
							(prev[b + ch] as number) +
							(prev[c + ch] as number) +
							(prev[e + ch] as number) +
							2) >>
						2;
			}
		if (ns >= N * 4) {
			for (let c = 0; c < N * N; c++) {
				// bare twigs fade softly into a haze (alpha to coverage): their coverage is not kept
				if (c === CELL.twigs) continue;
				const cx = c % N;
				const cy = Math.floor(c / N);
				let lo = 0.5;
				let hi = 6;
				for (let it = 0; it < 12; it++) {
					const mid = (lo + hi) / 2;
					if (coverage(d, ns, cx, cy, mid) < (target[c] as number)) lo = mid;
					else hi = mid;
				}
				const k = (lo + hi) / 2;
				const cs = ns / N;
				for (let y = cy * cs; y < (cy + 1) * cs; y++)
					for (let x = cx * cs; x < (cx + 1) * cs; x++) {
						const o = (y * ns + x) * 4 + 3;
						d[o] = Math.min(255, Math.round((d[o] as number) * k));
					}
			}
		}
		levels.push({ data: d, width: ns, height: ns });
		prev = d;
		s = ns;
	}
	return levels;
}

/** The leaf atlas's pixels: the 2048 px image and its mip chain (the first level is the image). */
export type AtlasLevels = { data: Uint8Array; width: number; height: number }[];

/** Draws the leaf atlas (about 1.5 s): leafAtlas() does it in a worker. */
export function leafAtlasLevels(): AtlasLevels {
	return mipChain(drawAtlas(), C * N);
}

/** The leaf atlas texture from its pixels. */
export function atlasTexture(levels: AtlasLevels): THREE.DataTexture {
	const base = levels[0] as AtlasLevels[number];
	const tex = new THREE.DataTexture(base.data, base.width, base.height, THREE.RGBAFormat);
	tex.mipmaps = levels;
	tex.generateMipmaps = false;
	tex.minFilter = THREE.LinearMipmapLinearFilter;
	tex.magFilter = THREE.LinearFilter;
	tex.anisotropy = 8;
	tex.flipY = false;
	tex.colorSpace = THREE.NoColorSpace;
	tex.needsUpdate = true;
	return tex;
}

/** The leaf atlas texture (2048 px with its mip chain), drawn here and now. */
export function makeLeafAtlas(): THREE.DataTexture {
	return atlasTexture(leafAtlasLevels());
}

let drawing: Promise<THREE.DataTexture> | null = null;

/**
 * The leaf atlas drawn in a worker, so the page goes on loading meanwhile (on this thread where there are no
 * workers or no OffscreenCanvas). Started once: call it early, await it when the trees are made.
 */
export function leafAtlas(): Promise<THREE.DataTexture> {
	drawing ??= new Promise<AtlasLevels>((resolve) => {
		const here = () => resolve(leafAtlasLevels());
		if (typeof Worker === "undefined" || typeof OffscreenCanvas === "undefined") return here();
		const worker = new Worker(new URL("./atlas.worker.ts", import.meta.url), { type: "module" });
		worker.onmessage = (e: MessageEvent<AtlasLevels | null>) => {
			worker.terminate();
			if (e.data) resolve(e.data);
			else here();
		};
		worker.onerror = () => {
			worker.terminate();
			here();
		};
	}).then(atlasTexture);
	return drawing;
}

/** Soft round puffs for steam (R = density, as alpha). */
export function makePuff(): THREE.CanvasTexture {
	const s = 128;
	const cv = canvas(s, s);
	const c = cv.getContext("2d") as Ctx;
	const r = new Rng(77);
	c.clearRect(0, 0, s, s);
	for (let i = 0; i < 26; i++) {
		const x = s / 2 + r.normal(s * 0.12);
		const y = s / 2 + r.normal(s * 0.12);
		const rad = s * r.range(0.12, 0.28);
		const g = c.createRadialGradient(x, y, 0, x, y, rad);
		g.addColorStop(0, "rgba(255,255,255,0.22)");
		g.addColorStop(1, "rgba(255,255,255,0)");
		c.fillStyle = g;
		c.fillRect(0, 0, s, s);
	}
	const t = new THREE.CanvasTexture(cv as HTMLCanvasElement);
	t.colorSpace = THREE.NoColorSpace;
	return t;
}
