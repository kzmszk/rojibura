// Standing about with its owner (docs/prd.md 3.4.9): while the owner stands still and they are not talking, an
// AI walking with them now and then takes a step or two somewhere close, on the side of them it is on (never
// across in front of them). No LLM: a timer of its own, while it walks with its owner.

import {
	type ClientToHost,
	COMPANION_FREE,
	COMPANION_FREE_STEP,
	dist,
	polylineLength,
	poseAt,
	type Vec2,
	WALK_SPEED,
} from "@rojibura/protocol";
import type { Navigator } from "./types.ts";
import type { World } from "./world.ts";

/** A step now and then: this often (ms). */
const EVERY_MS: [number, number] = [9_000, 22_000];
/** The owner has stood still this long before it steps about (ms). */
const OWNER_STILL_MS = 4_000;

export interface StrollOptions {
	world: World;
	nav: () => Navigator;
	send: (msg: ClientToHost) => void;
	seq: () => number;
	/** Talking, or busy with something: it stays put. */
	busy: () => boolean;
	random: () => number;
}

export class Stroll {
	private timer: ReturnType<typeof setTimeout> | null = null;
	private readonly o: StrollOptions;

	constructor(opts: StrollOptions) {
		this.o = opts;
	}

	/** Runs while it walks with its owner; call after each message. */
	sync(): void {
		if (this.o.world.company && !this.timer) this.schedule();
		else if (!this.o.world.company) this.stop();
	}

	stop(): void {
		if (this.timer) clearTimeout(this.timer);
		this.timer = null;
	}

	private schedule(): void {
		const [min, max] = EVERY_MS;
		this.timer = setTimeout(
			() => {
				this.timer = null;
				this.step();
				this.sync();
			},
			min + this.o.random() * (max - min),
		);
	}

	/** The way to a spot near the owner on its side of them, or null (now is not the time, or nowhere to go). */
	way(): Vec2[] | null {
		const w = this.o.world;
		const me = w.self;
		const owner = w.company ? w.avatars.get(w.company) : undefined;
		if (!me || !owner || this.o.busy()) return null;
		const now = w.hostNow();
		const mine = poseAt(me.move, now);
		const theirs = poseAt(owner.move, now);
		if (mine.moving || theirs.moving || now - owner.move.at < OWNER_STILL_MS || me.doing) return null;
		const from = mine.pos;
		const o = theirs.pos;
		if (dist(from, o) > COMPANION_FREE) return null;
		// round the owner, within 35° of where it is now, 0.75 to 1.55 m from them
		const bearing = Math.atan2(from[1] - o[1], from[0] - o[0]);
		const a = bearing + (this.o.random() - 0.5) * 1.2;
		const r = 0.75 + this.o.random() * 0.8;
		const to: Vec2 = [o[0] + Math.cos(a) * r, o[1] + Math.sin(a) * r];
		const path = this.o.nav().findPath(from, to);
		if (!path || path.length < 2) return null;
		const end = path[path.length - 1] as Vec2;
		const length = polylineLength(path);
		if (length < 0.3 || length > COMPANION_FREE_STEP || dist(end, o) > COMPANION_FREE - 0.1) return null;
		return path;
	}

	private step(): void {
		if (this.o.random() > 0.7) return;
		const path = this.way();
		// an amble, slower than a walk
		if (path) this.o.send({ t: "MOVE_PATH", path, speed: WALK_SPEED * 0.7, seq: this.o.seq() });
	}
}
