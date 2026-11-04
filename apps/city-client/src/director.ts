// The camera director of the cinema view (docs/cinema.md 3): which shot of the two walking together to take, and
// when to cut to another. Only decisions here, no three.js: where things stand and what can be seen comes in.

import type { Vec2 } from "@rojibura/protocol";

export type ShotKind =
	| "front"
	| "side"
	| "back"
	| "wide"
	| "frontAxis"
	| "backAxis"
	| "two"
	| "near"
	| "ahead"
	| "away"
	| "pan";
export type Side = 1 | -1;

/** `angle` from the way they walk, to the shot's side (degrees); `distance` (m); `height` above them (m); `fov` (degrees). */
const SHOTS: Record<ShotKind, { angle: number; distance: number; height: number; fov: number }> = {
	front: { angle: 32, distance: 8, height: 1.15, fov: 30 },
	// (they walk side by side: from straight beside them, one would hide the other)
	side: { angle: 62, distance: 9, height: 1.3, fov: 30 },
	back: { angle: 150, distance: 10, height: 1.6, fov: 32 },
	wide: { angle: 55, distance: 20, height: 2.4, fov: 28 },
	frontAxis: { angle: 8, distance: 9, height: 1.2, fov: 30 },
	backAxis: { angle: 172, distance: 9, height: 1.6, fov: 30 },
	two: { angle: 20, distance: 5, height: 1.35, fov: 32 },
	near: { angle: 180, distance: 2.8, height: 2.1, fov: 45 },
	// the camera stays where it is (docs/cinema.md 3.1): they come up to it...
	ahead: { angle: 8, distance: 16, height: 1.3, fov: 32 },
	// ...walk off from it...
	away: { angle: 172, distance: 3.5, height: 1.2, fov: 34 },
	// ...or go by it, the camera turning to keep them in the picture
	pan: { angle: 55, distance: 14, height: 1.4, fov: 28 },
};
/** The shots that stay where they were put: held on one spot, or turning to follow them. */
const FIXED: Partial<Record<ShotKind, "hold" | "pan">> = { ahead: "hold", away: "hold", pan: "pan" };
/** A fixed shot ends when they are this close to the camera (those that come up to it), or this far from it (m). */
const PASSED_M = 5;
const GONE_M = 26;
const KINDS = Object.keys(SHOTS) as ShotKind[];

/** How much each shot is wanted while they walk, and while they stand. */
const WALKING: Record<ShotKind, number> = {
	front: 60,
	side: 55,
	back: 50,
	wide: 47,
	frontAxis: 40,
	backAxis: 40,
	two: 0,
	near: 5,
	ahead: 48,
	away: 47,
	pan: 52,
};
const STANDING: Record<ShotKind, number> = {
	two: 65,
	side: 50,
	front: 50,
	wide: 40,
	back: 30,
	frontAxis: 25,
	backAxis: 25,
	near: 5,
	ahead: 0,
	away: 0,
	pan: 0,
};
const TALKING_TWO = 90;
const LEADING_BACK = 65;

/** The shot now counts this much more (hysteresis). */
const KEEP = 20;
/** A shot stays at least this long (ms)... */
export const MIN_HOLD_MS = 4_000;
/** ...and from this long on, while they walk, loses this much a second. */
const LONG_MS = 8_000;
const LONG_PER_S = 4;
/** Standing still, a shot goes on this long (ms) before it starts to lose. */
const LONG_STANDING_MS = 10_000;
/** A shot just left counts this much less, wearing off over this long (ms). */
const RECENT = 30;
const RECENT_MS = 100_000;
/** The other side of the two (the 180 degree rule) counts this much less, unless they turned this far (degrees). */
const OTHER_SIDE = 30;
const NEW_LINE_DEG = 55;
const OLD_LINE = 40;
/** The camera sees neither of them. */
const HIDDEN = 100;
/** Neither seen this long (ms): cut at once. */
export const HIDDEN_CUT_MS = 500;
/** A shot found hidden is not tried again for this long (ms). */
const RETRY_MS = 2_000;
/** How many shots are looked through (with rays) before a cut. */
const TRIES = 3;
/** The two take up at most this part of the width. */
const FIT = 0.6;
/** Far closer than the shot wants, the lens widens up to this (degrees). */
const WIDEST = 50;

/** The two, now. */
export interface Subjects {
	/** The middle of them (x, z). */
	center: Vec2;
	/** The way they walk, or last walked: a unit vector (x, z). */
	dir: Vec2;
	/** How far apart they are (m). */
	spread: number;
	moving: boolean;
	talking: boolean;
	/** Behind the AI on the way to a place (LEAD). */
	leading: boolean;
	/** The picture's width over height. */
	aspect: number;
	/** The area keeps the camera this close (AreaView.camera, m), or null. */
	reach: number | null;
}

export interface Shot {
	kind: ShotKind;
	side: Side;
	/** From the middle of them to the camera (x, z), the same all through the shot. */
	offset: Vec2;
	/** Above them (m). */
	height: number;
	fov: number;
	/** The way they walked when it began. */
	dir: Vec2;
	/**
	 * A shot that stays where it was put: the camera's spot and what it looks at (x, z), and whether it turns to follow
	 * them (`track`) or looks at the same place all along. Null for a shot that goes along with them.
	 */
	fixed: { at: Vec2; aim: Vec2; track: boolean } | null;
}

/** What can be seen; `seen` costs rays, so it is asked only about a few shots. */
export interface Looks {
	/**
	 * The camera is, and will be for the next moments, somewhere open: its spot and its surroundings are walkable
	 * ground, and so is the way from it to them, now and a little ahead.
	 */
	open(shot: Shot): boolean;
	/** How much of the two the camera sees: 1 both, 0.5 one, 0 neither. */
	seen(shot: Shot): number;
}

/** Where a shot puts the camera for the two as they are now. */
export function placeShot(kind: ShotKind, side: Side, s: Subjects): Shot {
	const spec = SHOTS[kind];
	const a = ((spec.angle * Math.PI) / 180) * side;
	const [x, z] = s.dir;
	const half = Math.tan((spec.fov * Math.PI) / 360);
	// far enough that both fit across the picture (the last resort stays close)
	const fit = kind === "near" ? 0 : s.spread / (FIT * 2 * half * s.aspect);
	let distance = Math.max(spec.distance, fit);
	let fov = spec.fov;
	if (s.reach !== null && distance > s.reach) {
		// kept closer than it wants: a wider lens keeps them as large as they would be
		fov = Math.min(WIDEST, (Math.atan((half * distance) / s.reach) * 360) / Math.PI);
		distance = s.reach;
	}
	const offset: Vec2 = [
		(x * Math.cos(a) - z * Math.sin(a)) * distance,
		(x * Math.sin(a) + z * Math.cos(a)) * distance,
	];
	const how = FIXED[kind];
	return {
		kind,
		side,
		offset,
		height: spec.height,
		fov,
		dir: s.dir,
		fixed: how
			? { at: [s.center[0] + offset[0], s.center[1] + offset[1]], aim: [...s.center], track: how === "pan" }
			: null,
	};
}

function degreesBetween(a: Vec2, b: Vec2): number {
	const dot = a[0] * b[0] + a[1] * b[1];
	return (Math.acos(Math.max(-1, Math.min(1, dot))) * 180) / Math.PI;
}

function wanted(kind: ShotKind, s: Subjects): number {
	if (s.talking && kind === "two") return TALKING_TWO;
	if (!s.moving || s.talking) return STANDING[kind];
	return s.leading && kind === "back" ? LEADING_BACK : WALKING[kind];
}

export class Director {
	private shot: Shot | null = null;
	/** When the shot began. */
	private since = 0;
	/** When each kind of shot was last left. */
	private readonly left = new Map<ShotKind, number>();
	/** Since when the camera has seen neither of them. */
	private hiddenSince: number | null = null;
	/** Shots found hidden, by kind and side: not before this time. */
	private readonly retry = new Map<string, number>();

	/** Starts over: the next step cuts (they jumped somewhere else). */
	reset(): void {
		this.shot = null;
		this.hiddenSince = null;
	}

	/** Decides the shot for now; `cut` if it is a new one. Call a few times a second. */
	step(now: number, s: Subjects, looks: Looks): { shot: Shot; cut: boolean } {
		const shot = this.shot;
		let kept = -Infinity;
		let newLine = false;
		if (shot) {
			newLine = degreesBetween(shot.dir, s.dir) > NEW_LINE_DEG;
			const seen = looks.seen(shot);
			this.hiddenSince = seen === 0 ? (this.hiddenSince ?? now) : null;
			kept = wanted(shot.kind, s) + KEEP - (1 - seen) * HIDDEN;
			// (standing about, too, the film cuts to another now and then: later than while they walk)
			if (!s.talking && !shot.fixed)
				kept -= (Math.max(0, now - this.since - (s.moving ? LONG_MS : LONG_STANDING_MS)) / 1000) * LONG_PER_S;
			if (newLine) kept -= OLD_LINE;
		}
		// a camera left where it was: they have gone by it, or are too far to see
		const gone = shot?.fixed ? Math.hypot(s.center[0] - shot.fixed.at[0], s.center[1] - shot.fixed.at[1]) : 0;
		const over = shot?.fixed ? gone > GONE_M || (shot.kind === "ahead" && gone < PASSED_M) : false;
		// the camera is, or is about to be, somewhere it should not be (in a wall, in a building): cut at once
		const closed = shot ? !looks.open(shot) : false;
		const must = over || closed || (this.hiddenSince !== null && now - this.hiddenSince >= HIDDEN_CUT_MS);
		if (shot && !must && now - this.since < MIN_HOLD_MS) return { shot, cut: false };
		const others = this.candidates(now, s, looks, shot, newLine)
			.filter((c) => must || !shot || c.score > kept)
			.slice(0, TRIES);
		for (const c of others) {
			if (looks.seen(c.shot) === 1) return this.cutTo(c.shot, now);
			this.retry.set(key(c.shot), now + RETRY_MS);
		}
		if (shot && !must) return { shot, cut: false };
		return this.cutTo(placeShot("near", 1, s), now);
	}

	/** Every other shot worth taking, the best first. */
	private candidates(
		now: number,
		s: Subjects,
		looks: Looks,
		shot: Shot | null,
		newLine: boolean,
	): { shot: Shot; score: number }[] {
		const out: { shot: Shot; score: number }[] = [];
		for (const kind of KINDS) {
			// (straight behind is the same from either side, and is what is left when nothing else can be seen)
			if (kind === "near") continue;
			// (a camera left in place is no good where the camera may not be far from them)
			if (FIXED[kind] && s.reach !== null) continue;
			for (const side of [1, -1] as const) {
				if (shot && kind === shot.kind && side === shot.side) continue;
				const base = wanted(kind, s);
				if (base <= 0) continue;
				const next = placeShot(kind, side, s);
				if ((this.retry.get(key(next)) ?? 0) > now) continue;
				let score = base;
				if (shot && side !== shot.side && !newLine) score -= OTHER_SIDE;
				const left = this.left.get(kind);
				if (left !== undefined) score -= RECENT * Math.max(0, 1 - (now - left) / RECENT_MS);
				// (never a shot whose camera could end up in a wall or a building)
				if (!looks.open(next)) continue;
				out.push({ shot: next, score });
			}
		}
		return out.sort((a, b) => b.score - a.score);
	}

	private cutTo(next: Shot, now: number): { shot: Shot; cut: boolean } {
		if (this.shot) this.left.set(this.shot.kind, now);
		this.shot = next;
		this.since = now;
		this.hiddenSince = null;
		return { shot: next, cut: true };
	}
}

function key(shot: Shot): string {
	return `${shot.kind}/${shot.side}`;
}
