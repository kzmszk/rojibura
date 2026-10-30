import type { NavMesh } from "./navmesh.ts";
import { distance, type Vec2 } from "./vec.ts";

export interface ValidatePathOptions {
	/** Maximum number of points (docs/prd.md 3.2.3: 24). No limit if omitted. */
	maxPoints?: number;
	/** Maximum total length in metres (3.2.3: 200). No limit if omitted. */
	maxLength?: number;
	/** The path must start within `maxDistance` metres of `pos` (3.2.3: the host's estimate, 2 m). */
	start?: { pos: Vec2; maxDistance: number };
	/**
	 * Also test points along every segment at most this many metres apart. Off by default: the 3.2.3 rule
	 * only tests vertices and segment midpoints, which lets a long segment cut across a small obstacle.
	 */
	sampleSpacing?: number;
}

export type PathProblem =
	| "malformed" // not an array of [finite, finite]
	| "empty"
	| "too_many_points"
	| "bad_start"
	| "too_long"
	| "not_walkable";

export type PathValidation =
	| { ok: true }
	| {
			ok: false;
			problem: PathProblem;
			/** The offending point (or, for "not_walkable" between points, the segment's first point). */
			index?: number;
	  };

/**
 * Checks a path received from a participant (MOVE_PATH, docs/prd.md 3.2.3): every vertex and every segment
 * midpoint must be walkable, plus the optional limits in `opts`. Safe to call on untrusted input.
 */
export function validatePath(
	mesh: NavMesh,
	path: readonly Vec2[],
	opts: ValidatePathOptions = {},
): PathValidation {
	if (!Array.isArray(path)) return { ok: false, problem: "malformed" };
	for (let i = 0; i < path.length; i++) {
		const p: unknown = path[i];
		if (!Array.isArray(p) || p.length !== 2 || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) {
			return { ok: false, problem: "malformed", index: i };
		}
	}
	const first = path[0];
	if (!first) return { ok: false, problem: "empty" };
	if (opts.maxPoints !== undefined && path.length > opts.maxPoints) {
		return { ok: false, problem: "too_many_points" };
	}
	if (opts.start && !(distance(first, opts.start.pos) <= opts.start.maxDistance)) {
		return { ok: false, problem: "bad_start", index: 0 };
	}
	if (opts.maxLength !== undefined) {
		let length = 0;
		for (let i = 1; i < path.length; i++) length += distance(path[i - 1] as Vec2, path[i] as Vec2);
		if (!(length <= opts.maxLength)) return { ok: false, problem: "too_long" };
	}
	for (let i = 0; i < path.length; i++) {
		if (!mesh.isWalkable(path[i] as Vec2)) return { ok: false, problem: "not_walkable", index: i };
	}
	const spacing = opts.sampleSpacing;
	for (let i = 1; i < path.length; i++) {
		const [ax, az] = path[i - 1] as Vec2;
		const [bx, bz] = path[i] as Vec2;
		// Midpoint always; with sampleSpacing, also evenly spaced points in between.
		const steps = spacing && spacing > 0 ? Math.max(2, Math.ceil(Math.hypot(bx - ax, bz - az) / spacing)) : 2;
		for (let s = 1; s < steps; s++) {
			const t = s / steps;
			if (!mesh.isWalkable([ax + (bx - ax) * t, az + (bz - az) * t])) {
				return { ok: false, problem: "not_walkable", index: i - 1 };
			}
		}
		if (steps % 2 === 1 && !mesh.isWalkable([(ax + bx) / 2, (az + bz) / 2])) {
			return { ok: false, problem: "not_walkable", index: i - 1 };
		}
	}
	return { ok: true };
}
