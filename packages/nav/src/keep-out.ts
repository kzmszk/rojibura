// Rooms some people may not go into (the onsen's changing rooms: only men in the men's, only women in the
// women's, docs/prd.md 3.8.6), laid over the walkable area: the area stays one navmesh for everyone, and this
// keeps a walker out of the rooms that are not theirs.

import type { Vec2 } from "./vec.ts";

/** What keepingOut needs of the walkable area (the host's Walkable, a client navigator). */
export interface WalkQueries {
	isWalkable(p: Vec2): boolean;
	/** Every vertex and every segment midpoint is walkable. */
	validatePath(path: Vec2[]): boolean;
	closestPoint(p: Vec2): Vec2;
	findPath?(from: Vec2, to: Vec2): Vec2[] | null;
}

/** A room to keep out of, and a point to go round by instead when the way goes through it (one's own room). */
export interface KeepOut {
	poly: Vec2[];
	via?: Vec2;
}

/** Whether p is inside the polygon (even-odd). */
export function insidePoly(p: Vec2, poly: readonly Vec2[]): boolean {
	let c = false;
	for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
		const [xi, zi] = poly[i] as Vec2;
		const [xj, zj] = poly[j] as Vec2;
		if (zi > p[1] !== zj > p[1] && p[0] < ((xj - xi) * (p[1] - zi)) / (zj - zi) + xi) c = !c;
	}
	return c;
}

function cross(o: Vec2, a: Vec2, b: Vec2): number {
	return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
}

function segmentsCross(a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean {
	const d1 = cross(c, d, a);
	const d2 = cross(c, d, b);
	const d3 = cross(a, b, c);
	const d4 = cross(a, b, d);
	return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/** Whether walking the path goes into the polygon (a path that starts inside may leave it). */
export function entersPoly(path: readonly Vec2[], poly: readonly Vec2[]): boolean {
	const start = path[0];
	if (!start || insidePoly(start, poly)) return false;
	for (let i = 1; i < path.length; i++) {
		const a = path[i - 1] as Vec2;
		const b = path[i] as Vec2;
		if (insidePoly(b, poly)) return true;
		for (let k = 0, j = poly.length - 1; k < poly.length; j = k++)
			if (segmentsCross(a, b, poly[j] as Vec2, poly[k] as Vec2)) return true;
	}
	return false;
}

/** The point of the polygon's outline nearest p, moved `out` metres outwards (away from the polygon's middle). */
function outside(p: Vec2, poly: readonly Vec2[], out: number): Vec2 {
	let best: Vec2 = p;
	let bd = Number.POSITIVE_INFINITY;
	for (let k = 0, j = poly.length - 1; k < poly.length; j = k++) {
		const a = poly[j] as Vec2;
		const b = poly[k] as Vec2;
		const ex = b[0] - a[0];
		const ez = b[1] - a[1];
		const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * ex + (p[1] - a[1]) * ez) / (ex * ex + ez * ez || 1)));
		const q: Vec2 = [a[0] + ex * t, a[1] + ez * t];
		const d = Math.hypot(q[0] - p[0], q[1] - p[1]);
		if (d < bd) {
			bd = d;
			best = q;
		}
	}
	let cx = 0;
	let cz = 0;
	for (const v of poly) {
		cx += v[0] / poly.length;
		cz += v[1] / poly.length;
	}
	const dx = best[0] - cx;
	const dz = best[1] - cz;
	const len = Math.hypot(dx, dz) || 1;
	return [best[0] + (dx / len) * out, best[1] + (dz / len) * out];
}

/**
 * The walkable area without the rooms in `out`: points in them are not walkable, paths may not go into them,
 * the closest point to one inside them is just outside, and a way that would go through one goes round by its
 * `via` (if that works) or is not found.
 */
export function keepingOut<T extends WalkQueries>(base: T, out: readonly KeepOut[]): WalkQueries {
	if (out.length === 0) return base;
	const blocked = (p: Vec2) => out.some((k) => insidePoly(p, k.poly));
	const enters = (path: readonly Vec2[]) => out.some((k) => entersPoly(path, k.poly));
	const closest = (p: Vec2): Vec2 => {
		const q = base.closestPoint(p);
		const room = out.find((k) => insidePoly(q, k.poly));
		return room ? base.closestPoint(outside(q, room.poly, 0.4)) : q;
	};
	const find = base.findPath?.bind(base);
	return {
		isWalkable: (p) => base.isWalkable(p) && !blocked(p),
		validatePath: (path) => base.validatePath(path) && !enters(path),
		closestPoint: closest,
		...(find
			? {
					findPath: (from: Vec2, to: Vec2) => {
						const end = blocked(to) ? closest(to) : to;
						const way = find(from, end);
						if (way && !enters(way)) return way;
						for (const k of out) {
							if (!k.via) continue;
							const a = find(from, k.via);
							const b = a && find(k.via, end);
							if (a && b) {
								const round = [...a, ...b.slice(1)];
								if (!enters(round)) return round;
							}
						}
						return null;
					},
				}
			: {}),
	};
}

/**
 * Rooms for one sex each (the onsen's changing rooms): for each sex, the others' rooms to keep out of, going round
 * by its own room.
 */
export function roomsKeptOut<S extends string>(
	rooms: readonly { sex: S; poly: Vec2[] }[],
): Partial<Record<S, KeepOut[]>> {
	const middle = (poly: Vec2[]): Vec2 => [
		poly.reduce((a, p) => a + p[0], 0) / poly.length,
		poly.reduce((a, p) => a + p[1], 0) / poly.length,
	];
	const out: Partial<Record<S, KeepOut[]>> = {};
	for (const sex of new Set(rooms.map((r) => r.sex))) {
		const own = rooms.find((r) => r.sex === sex);
		out[sex] = rooms
			.filter((r) => r.sex !== sex)
			.map((r) => ({ poly: r.poly, ...(own ? { via: middle(own.poly) } : {}) }));
	}
	return out;
}
