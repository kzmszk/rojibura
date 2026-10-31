// Position of an avatar at a given host time (docs/prd.md 3.3, lazy position evaluation).
// Shared by the host (validation, context) and clients (interpolation) so both agree.

import { MAX_PATH_LENGTH, MAX_PATH_POINTS } from "./limits.ts";
import type { MoveState, Vec2 } from "./types.ts";

export function dist(a: Vec2, b: Vec2): number {
	return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

export function polylineLength(path: readonly Vec2[]): number {
	let len = 0;
	for (let i = 1; i < path.length; i++) len += dist(path[i - 1] as Vec2, path[i] as Vec2);
	return len;
}

/** Point at distance `d` along `path`, clamped to its ends. Also returns the heading of that segment. */
export function alongPolyline(path: readonly Vec2[], d: number): { pos: Vec2; dir: Vec2; done: boolean } {
	const first = path[0];
	if (!first) return { pos: [0, 0], dir: [0, 1], done: true };
	let rest = Math.max(0, d);
	let dir: Vec2 = [0, 1];
	for (let i = 1; i < path.length; i++) {
		const a = path[i - 1] as Vec2;
		const b = path[i] as Vec2;
		const seg = dist(a, b);
		if (seg > 1e-9) dir = [(b[0] - a[0]) / seg, (b[1] - a[1]) / seg];
		if (rest <= seg) {
			const f = seg > 1e-9 ? rest / seg : 1;
			return { pos: [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f], dir, done: false };
		}
		rest -= seg;
	}
	const last = path[path.length - 1] as Vec2;
	return { pos: [last[0], last[1]], dir, done: true };
}

/**
 * The start of `path` that one MOVE_PATH may carry: at most MAX_PATH_POINTS points and MAX_PATH_LENGTH metres
 * (with a metre to spare). A longer way is walked in several legs.
 */
export function pathLeg(path: readonly Vec2[]): Vec2[] {
	const first = path[0];
	if (!first) return [];
	const max = MAX_PATH_LENGTH - 1;
	const out: Vec2[] = [first];
	let len = 0;
	for (let i = 1; i < path.length && out.length < MAX_PATH_POINTS; i++) {
		const a = path[i - 1] as Vec2;
		const b = path[i] as Vec2;
		const seg = dist(a, b);
		if (len + seg > max) {
			out.push(alongPolyline([a, b], max - len).pos);
			break;
		}
		len += seg;
		out.push(b);
	}
	return out;
}

export interface Pose {
	pos: Vec2;
	/** Unit heading on the XZ plane. */
	dir: Vec2;
	moving: boolean;
}

/**
 * Pose of a move state at host time `now`. Velocity moves are extrapolated without collision;
 * callers that know the walkable area clamp the result (`clamp`).
 */
export function poseAt(move: MoveState, now: number, clamp?: (p: Vec2) => Vec2): Pose {
	const t = Math.max(0, now - move.at) / 1000;
	switch (move.kind) {
		case "idle":
			return { pos: move.pos, dir: [0, 1], moving: false };
		case "path": {
			const r = alongPolyline(move.path, move.speed * t);
			return { pos: r.pos, dir: r.dir, moving: !r.done };
		}
		case "vel": {
			const moving = move.speed > 0 && (move.dir[0] !== 0 || move.dir[1] !== 0);
			const p: Vec2 = [
				move.pos[0] + move.dir[0] * move.speed * t,
				move.pos[1] + move.dir[1] * move.speed * t,
			];
			return { pos: clamp && moving ? clamp(p) : p, dir: moving ? move.dir : [0, 1], moving };
		}
	}
}

export function positionAt(move: MoveState, now: number, clamp?: (p: Vec2) => Vec2): Vec2 {
	return poseAt(move, now, clamp).pos;
}
