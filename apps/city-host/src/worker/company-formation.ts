// Where an owner's AIs keep round them (docs/prd.md 3.4.9): each in a place of its own beside them, never straight
// ahead or behind while the way is wide enough, and the way there does not go through anyone. Only geometry here;
// RoomInteractions knows the ground and moves them.

import { COMPANY_GAP, dist, type MoveState, polylineLength, poseAt, type Vec2 } from "@rojibura/protocol";

/** A place relative to the owner: `front` ahead of them (negative: behind), `aside` to their right (side 1) or left (-1). */
export interface Place {
	front: number;
	aside: number;
	side: number;
}

const FIRST_PAIR = {
	walking: { front: 0.3, aside: 0.9 },
	standing: { front: 0.15, aside: 0.8 },
};
/** Each further pair is this much further back, and further out, than the one before (m): clear of it. */
const NEXT_BACK = 0.85;
const NEXT_OUT = 0.35;
/**
 * Where the way is too narrow for a place: this much of the way out. Or behind the owner, this far, so that it passes a
 * narrow place after them and not through them, still out to the side wherever the way is wide, or a little aside; or
 * this far ahead, if it is in front of them already and they would walk through it.
 */
const NARROW = 0.65;
const BEHIND: readonly number[] = [1.2, 2.2];
const AHEAD = 1.2;
const LITTLE_ASIDE = 0.35;
/** It gets out to its side within this much of the way (m), so it does not walk in line with the owner for long. */
const JOIN_M = 1.5;
/** Already this close to how far out it should be (m): no need to get there first. */
const JOINED_M = 0.15;
/** A way is looked over this often (ms), up to so many times. */
const LOOK_MS = 250;
const LOOKS = 160;
/** Starting too close to someone, this long is left to get away (ms). */
const GET_AWAY_MS = 800;

/** A place for each of `count` AIs: a pair beside the owner, the next pair further back and out, and so on. */
export function placesFor(count: number, gait: keyof typeof FIRST_PAIR): Place[] {
	const { front, aside } = FIRST_PAIR[gait];
	return Array.from({ length: count }, (_, i) => {
		const rank = Math.floor(i / 2);
		return {
			front: front - rank * NEXT_BACK,
			aside: aside + rank * NEXT_OUT,
			side: i % 2 === 0 ? 1 : -1,
		};
	});
}

/** Where a place is, for an owner at `at` facing `ahead`. */
export function placeAt(at: Vec2, ahead: Vec2, place: Place): Vec2 {
	// facing +z the right hand is on -x: right = (-ahead.z, ahead.x)
	const right: Vec2 = [-ahead[1], ahead[0]];
	return [
		at[0] + ahead[0] * place.front + right[0] * place.aside * place.side,
		at[1] + ahead[1] * place.front + right[1] * place.aside * place.side,
	];
}

/**
 * Who goes where: each to the place nearest it that is still free, the closest pair first. So an AI stays on the side
 * of the owner it is on when they turn round, rather than crossing to "its" side through them.
 */
export function assignPlaces(froms: Vec2[], at: Vec2, ahead: Vec2, places: Place[]): Place[] {
	const pairs = froms.flatMap((from, who) =>
		places.map((place, where) => ({ who, where, d: dist(from, placeAt(at, ahead, place)) })),
	);
	pairs.sort((a, b) => a.d - b.d);
	const given = new Map<number, Place>();
	const taken = new Set<number>();
	for (const { who, where } of pairs) {
		if (given.has(who) || taken.has(where)) continue;
		given.set(who, places[where] as Place);
		taken.add(where);
	}
	return froms.map((_, who) => given.get(who) as Place);
}

/** The place itself, then what else will do where it cannot be: in line with the owner only when nothing else fits. */
export function placesToTry(place: Place): Place[] {
	const narrow = place.aside * NARROW;
	const shifted = [...BEHIND.map((back) => place.front - back), place.front + AHEAD];
	return [
		place,
		{ ...place, aside: narrow },
		{ ...place, side: -place.side },
		{ ...place, aside: narrow, side: -place.side },
		...shifted.flatMap((front) => [
			{ ...place, front },
			{ ...place, front, aside: LITTLE_ASIDE },
		]),
		...shifted.map((front) => ({ ...place, front, aside: 0 })),
	];
}

/**
 * A point on the way that takes it out to its side soon, for an owner at `at` going `dir` with `room` metres of that
 * leg left; or null if it is out there already, or the leg ends first. Without it an AI going to a place far on would
 * stay in line with the owner most of the way, when it started in front of them or behind them.
 */
export function joinPoint(from: Vec2, at: Vec2, dir: Vec2, room: number, place: Place): Vec2 | null {
	const off: Vec2 = [from[0] - at[0], from[1] - at[1]];
	const lateral = (-dir[1] * off[0] + dir[0] * off[1]) * place.side;
	if (Math.abs(lateral - place.aside) < JOINED_M) return null;
	const along = off[0] * dir[0] + off[1] * dir[1] + JOIN_M;
	if (along >= room) return null;
	return placeAt([at[0] + dir[0] * along, at[1] + dir[1] * along], dir, { ...place, front: 0 });
}

/** How close a walk along `path` from time `at` comes to anyone moving as `others` do (m). */
export function roomOnTheWay(path: Vec2[], speed: number, at: number, others: MoveState[]): number {
	const me: MoveState = { kind: "path", path, speed, at };
	const ms = (polylineLength(path) / speed) * 1000;
	const looks = Math.max(1, Math.min(LOOKS, Math.ceil(ms / LOOK_MS)));
	const close = others.some((o) => dist(path[0] as Vec2, poseAt(o, at).pos) < COMPANY_GAP);
	let least = Number.POSITIVE_INFINITY;
	for (let i = 0; i <= looks; i++) {
		const t = (ms * i) / looks;
		if (close && t < GET_AWAY_MS && i < looks) continue;
		const here = poseAt(me, at + t).pos;
		for (const o of others) least = Math.min(least, dist(here, poseAt(o, at + t).pos));
	}
	return least;
}
