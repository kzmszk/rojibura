/** 2D (XZ) point on the walkable plane. Height is decided by the renderer (docs/prd.md 2.3). */
export type Vec2 = [x: number, z: number];

export function distance(a: Vec2, b: Vec2): number {
	return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

/** Total length of a polyline (0 for fewer than two points). */
export function pathLength(path: readonly Vec2[]): number {
	let length = 0;
	for (let i = 1; i < path.length; i++) length += distance(path[i - 1] as Vec2, path[i] as Vec2);
	return length;
}

/**
 * The point `dist` metres along `path` from its first point, clamped to the ends.
 * Used to evaluate where an avatar on a `path` move is (speed * elapsed time).
 * Throws on an empty path.
 */
export function pointAlongPath(path: readonly Vec2[], dist: number): Vec2 {
	const first = path[0];
	if (!first) throw new Error("pointAlongPath: empty path");
	if (!(dist > 0)) return [first[0], first[1]]; // also catches NaN
	let remaining = dist;
	for (let i = 1; i < path.length; i++) {
		const a = path[i - 1] as Vec2;
		const b = path[i] as Vec2;
		const length = distance(a, b);
		if (remaining < length) {
			const t = remaining / length;
			return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
		}
		remaining -= length;
	}
	const last = path[path.length - 1] as Vec2;
	return [last[0], last[1]];
}
