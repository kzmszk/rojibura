// Changing the walkable area at run time (docs/prd.md 3.7): convex polygons are cut out of the navmesh
// and new walkable polygons are added, then everything is put back together as navmesh.json data, so
// NavMesh (A*, funnel, point location) works on the result unchanged. Pure TypeScript like the rest.

import type { NavMeshData } from "./navmesh.ts";
import type { Vec2 } from "./vec.ts";

export type Vec3 = [x: number, y: number, z: number];
/** A convex polygon with heights, counter-clockwise on the XZ plane (inside is to the left of each edge). */
export type Piece = Vec3[];

/** Points this close to a line count as on it (m). */
const SIDE_EPS = 1e-7;
/** Pieces smaller than this are slivers and dropped (m²). */
const MIN_AREA = 1e-5;
/** Vertices this close on XZ are welded into one (m). */
const WELD = 1e-4;
/** ... unless their heights differ more than this (m): then they are on different floors. */
const Y_TOL = 0.5;

/** Twice the signed area on the XZ plane: positive when counter-clockwise. */
export function area2(poly: readonly Vec2[]): number {
	let a = 0;
	for (let i = 0; i < poly.length; i++) {
		const p = poly[i] as Vec2;
		const q = poly[(i + 1) % poly.length] as Vec2;
		a += p[0] * q[1] - q[0] * p[1];
	}
	return a;
}

function pieceArea2(poly: readonly Vec3[]): number {
	let a = 0;
	for (let i = 0; i < poly.length; i++) {
		const p = poly[i] as Vec3;
		const q = poly[(i + 1) % poly.length] as Vec3;
		a += p[0] * q[2] - q[0] * p[2];
	}
	return a;
}

/** The polygon counter-clockwise. */
export function ccw<T extends Vec2 | Vec3>(poly: readonly T[], area: (p: readonly T[]) => number): T[] {
	return area(poly) < 0 ? [...poly].reverse() : [...poly];
}

export const xz = (p: readonly Vec3[]): Vec2[] => p.map((v) => [v[0], v[2]]);

/** Signed distance of (x, z) from the line a -> b: positive on the left. */
function side(ax: number, az: number, bx: number, bz: number, x: number, z: number): number {
	const dx = bx - ax;
	const dz = bz - az;
	const len = Math.hypot(dx, dz);
	return len > 0 ? (dx * (z - az) - dz * (x - ax)) / len : 0;
}

/** The part of `poly` to the left (or right) of the line a -> b (Sutherland–Hodgman; heights interpolated). */
export function clip(poly: readonly Vec3[], a: Vec2, b: Vec2, keepLeft: boolean): Piece {
	const s = keepLeft ? 1 : -1;
	const out: Piece = [];
	const n = poly.length;
	for (let i = 0; i < n; i++) {
		const cur = poly[i] as Vec3;
		const next = poly[(i + 1) % n] as Vec3;
		const dc = s * side(a[0], a[1], b[0], b[1], cur[0], cur[2]);
		const dn = s * side(a[0], a[1], b[0], b[1], next[0], next[2]);
		if (dc >= -SIDE_EPS) out.push(cur);
		if ((dc > SIDE_EPS && dn < -SIDE_EPS) || (dc < -SIDE_EPS && dn > SIDE_EPS)) {
			const t = dc / (dc - dn);
			out.push([
				cur[0] + (next[0] - cur[0]) * t,
				cur[1] + (next[1] - cur[1]) * t,
				cur[2] + (next[2] - cur[2]) * t,
			]);
		}
	}
	return out;
}

/**
 * True if two convex polygons (counter-clockwise) share more than a boundary: no edge of either has the
 * other entirely on its outside, allowing `touch` metres of overlap.
 */
export function overlaps(a: readonly Vec2[], b: readonly Vec2[], touch = 1e-6): boolean {
	const separated = (p: readonly Vec2[], q: readonly Vec2[]) => {
		for (let i = 0; i < p.length; i++) {
			const u = p[i] as Vec2;
			const v = p[(i + 1) % p.length] as Vec2;
			if (q.every((w) => side(u[0], u[1], v[0], v[1], w[0], w[1]) <= touch)) return true;
		}
		return false;
	};
	return !separated(a, b) && !separated(b, a);
}

/** `piece` minus a convex obstacle (counter-clockwise): up to one convex piece per obstacle edge. */
export function subtract(piece: Piece, obstacle: readonly Vec2[]): Piece[] {
	if (!overlaps(xz(piece), obstacle)) return [piece];
	const out: Piece[] = [];
	let rest: Piece = piece;
	for (let i = 0; i < obstacle.length; i++) {
		const a = obstacle[i] as Vec2;
		const b = obstacle[(i + 1) % obstacle.length] as Vec2;
		const outside = clip(rest, a, b, false);
		if (outside.length >= 3 && pieceArea2(outside) > 2 * MIN_AREA) out.push(outside);
		rest = clip(rest, a, b, true);
		if (rest.length < 3 || pieceArea2(rest) <= 2 * MIN_AREA) break;
	}
	return out;
}

/** The part of `piece` inside a convex region (counter-clockwise), or null. */
export function intersect(piece: Piece, region: readonly Vec2[]): Piece | null {
	let rest: Piece = piece;
	for (let i = 0; i < region.length && rest.length >= 3; i++)
		rest = clip(rest, region[i] as Vec2, region[(i + 1) % region.length] as Vec2, true);
	return rest.length >= 3 && pieceArea2(rest) > 2 * MIN_AREA ? rest : null;
}

/** Convex hull on the XZ plane, counter-clockwise (Andrew's monotone chain). */
export function convexHull(points: readonly Vec2[]): Vec2[] {
	const pts = [...points].sort((p, q) => p[0] - q[0] || p[1] - q[1]);
	if (pts.length < 3) return pts;
	const cross = (o: Vec2, a: Vec2, b: Vec2) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
	const half = (list: Vec2[]) => {
		const h: Vec2[] = [];
		for (const p of list) {
			while (h.length >= 2 && cross(h[h.length - 2] as Vec2, h[h.length - 1] as Vec2, p) <= 1e-12) h.pop();
			h.push(p);
		}
		h.pop();
		return h;
	};
	return [...half(pts), ...half([...pts].reverse())];
}

/** A convex polygon (counter-clockwise) grown by `d` metres: mitred corners, bevelled where very sharp. */
export function expand(poly: readonly Vec2[], d: number): Vec2[] {
	if (d === 0) return [...poly];
	const n = poly.length;
	const normal = (i: number): Vec2 => {
		const a = poly[i] as Vec2;
		const b = poly[(i + 1) % n] as Vec2;
		const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
		// outside is to the right of a counter-clockwise edge
		return [(b[1] - a[1]) / len, -(b[0] - a[0]) / len];
	};
	const out: Vec2[] = [];
	for (let i = 0; i < n; i++) {
		const p = poly[i] as Vec2;
		const n1 = normal((i + n - 1) % n);
		const n2 = normal(i);
		const dot = n1[0] * n2[0] + n1[1] * n2[1];
		if (1 + dot < 0.5) {
			out.push([p[0] + n1[0] * d, p[1] + n1[1] * d], [p[0] + n2[0] * d, p[1] + n2[1] * d]);
		} else {
			const k = d / (1 + dot);
			out.push([p[0] + (n1[0] + n2[0]) * k, p[1] + (n1[1] + n2[1]) * k]);
		}
	}
	return out;
}

/** The polygons of navmesh data as pieces. */
export function piecesOf(data: NavMeshData): Piece[] {
	const v = data.vertices;
	return data.polygons.map((p) =>
		ccw(
			p.verts.map((i): Vec3 => [v[i * 3] as number, v[i * 3 + 1] as number, v[i * 3 + 2] as number]),
			pieceArea2,
		),
	);
}

/** Cuts convex obstacles (either winding) out of navmesh data. */
export function carveObstacles(data: NavMeshData, obstacles: readonly (readonly Vec2[])[]): NavMeshData {
	let pieces = piecesOf(data);
	for (const o of obstacles) {
		const ob = ccw(o, area2);
		pieces = pieces.flatMap((p) => subtract(p, ob));
	}
	return assemble(pieces);
}

/**
 * Puts convex pieces together as navmesh data: welds vertices, splits edges where another piece's corner
 * lies on them (T-junctions), and links edges that two pieces share (in opposite directions) as neighbours.
 */
export function assemble(input: readonly Piece[]): NavMeshData {
	// clean: no repeated points, no slivers, counter-clockwise
	const pieces: Piece[] = [];
	for (const raw of input) {
		const q: Piece = [];
		for (const p of raw) {
			const last = q[q.length - 1];
			if (!last || Math.hypot(p[0] - last[0], p[2] - last[2]) > 1e-6) q.push(p);
		}
		while (
			q.length > 1 &&
			Math.hypot(
				(q[0] as Vec3)[0] - (q[q.length - 1] as Vec3)[0],
				(q[0] as Vec3)[2] - (q[q.length - 1] as Vec3)[2],
			) <= 1e-6
		)
			q.pop();
		if (q.length < 3) continue;
		const a = pieceArea2(q);
		if (Math.abs(a) <= 2 * MIN_AREA) continue;
		pieces.push(a < 0 ? q.reverse() : q);
	}

	// weld
	const vx: number[] = [];
	const vy: number[] = [];
	const vz: number[] = [];
	const weldGrid = new Map<string, number[]>();
	const cellOf = (x: number, z: number): [number, number] => [Math.floor(x / WELD), Math.floor(z / WELD)];
	const vertexFor = ([x, y, z]: Vec3): number => {
		const [cx, cz] = cellOf(x, z);
		for (let i = -1; i <= 1; i++)
			for (let j = -1; j <= 1; j++)
				for (const k of weldGrid.get(`${cx + i},${cz + j}`) ?? [])
					if (
						Math.abs((vx[k] as number) - x) <= WELD &&
						Math.abs((vz[k] as number) - z) <= WELD &&
						Math.abs((vy[k] as number) - y) <= Y_TOL
					)
						return k;
		const k = vx.push(x) - 1;
		vy.push(y);
		vz.push(z);
		const key = `${cx},${cz}`;
		const list = weldGrid.get(key);
		if (list) list.push(k);
		else weldGrid.set(key, [k]);
		return k;
	};
	let polys: number[][] = [];
	for (const p of pieces) {
		const ids: number[] = [];
		for (const v of p) {
			const k = vertexFor(v);
			if (ids[ids.length - 1] !== k) ids.push(k);
		}
		while (ids.length > 1 && ids[0] === ids[ids.length - 1]) ids.pop();
		if (ids.length >= 3) polys.push(ids);
	}

	// T-junctions: a vertex lying inside another polygon's edge becomes a vertex of that edge too
	const CELL = 1;
	const grid = new Map<string, number[]>();
	for (let k = 0; k < vx.length; k++) {
		const key = `${Math.floor((vx[k] as number) / CELL)},${Math.floor((vz[k] as number) / CELL)}`;
		const list = grid.get(key);
		if (list) list.push(k);
		else grid.set(key, [k]);
	}
	const ON = 2 * WELD;
	polys = polys.map((ids) => {
		const out: number[] = [];
		for (let e = 0; e < ids.length; e++) {
			const u = ids[e] as number;
			const w = ids[(e + 1) % ids.length] as number;
			out.push(u);
			const ax = vx[u] as number;
			const az = vz[u] as number;
			const dx = (vx[w] as number) - ax;
			const dz = (vz[w] as number) - az;
			const len2 = dx * dx + dz * dz;
			if (len2 <= 0) continue;
			const len = Math.sqrt(len2);
			const found: [number, number][] = [];
			const c0 = Math.floor((Math.min(ax, ax + dx) - ON) / CELL);
			const c1 = Math.floor((Math.max(ax, ax + dx) + ON) / CELL);
			const r0 = Math.floor((Math.min(az, az + dz) - ON) / CELL);
			const r1 = Math.floor((Math.max(az, az + dz) + ON) / CELL);
			for (let c = c0; c <= c1; c++)
				for (let r = r0; r <= r1; r++)
					for (const k of grid.get(`${c},${r}`) ?? []) {
						if (k === u || k === w) continue;
						const px = (vx[k] as number) - ax;
						const pz = (vz[k] as number) - az;
						const t = (px * dx + pz * dz) / len2;
						if (t * len <= ON || (1 - t) * len <= ON) continue;
						if (Math.abs(px * dz - pz * dx) / len > ON) continue;
						const y = (vy[u] as number) + ((vy[w] as number) - (vy[u] as number)) * t;
						if (Math.abs((vy[k] as number) - y) > Y_TOL) continue;
						found.push([t, k]);
					}
			found.sort((p, q) => p[0] - q[0]);
			for (const [, k] of found) if (out[out.length - 1] !== k) out.push(k);
		}
		return out;
	});

	// neighbours: the same edge walked the other way by another polygon
	const edges = new Map<string, [number, number]>();
	polys.forEach((ids, p) => {
		ids.forEach((u, j) => {
			const key = `${u},${ids[(j + 1) % ids.length]}`;
			if (!edges.has(key)) edges.set(key, [p, j]);
		});
	});
	const used = new Int32Array(vx.length).fill(-1);
	const vertices: number[] = [];
	const round = (v: number) => Math.round(v * 1e4) / 1e4;
	const polygons = polys.map((ids, p) => ({
		verts: ids.map((k) => {
			if (used[k] === -1) {
				used[k] = vertices.length / 3;
				vertices.push(round(vx[k] as number), round(vy[k] as number), round(vz[k] as number));
			}
			return used[k] as number;
		}),
		neighbors: ids.map((u, j) => {
			const other = edges.get(`${ids[(j + 1) % ids.length]},${u}`);
			return other && other[0] !== p ? other[0] : -1;
		}),
	}));
	return { version: 1, vertices, polygons };
}
