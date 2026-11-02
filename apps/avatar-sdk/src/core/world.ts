// What an agent knows about the city around it, kept current from the host's messages (docs/prd.md 3.2).
// Shared by the rule-based Agent and the pi resident.

import {
	type AvatarId,
	type AvatarState,
	type BudgetLevel,
	decay,
	dist,
	type HostToClient,
	type LifeState,
	poseAt,
	type Vec2,
} from "@rojibura/protocol";
import type { Landmark } from "./types.ts";

export class World {
	me: AvatarId | null = null;
	readonly avatars = new Map<AvatarId, AvatarState>();
	budget: BudgetLevel = 0;
	/** The owner this agent walks with now (docs/prd.md 3.4.9): the host moves it meanwhile. */
	company: AvatarId | null = null;
	/** This agent's life as the host last told it (docs/life.md 2); `lifeNow` brings it up to now. */
	life: LifeState | null = null;
	/** Coins in its wallet as the host last told it (WALLET); null before that. */
	coins: number | null = null;
	private offset = 0;
	/** Which way each avatar last walked or turned (a unit vector), for where it faces standing. */
	private readonly lastDir = new Map<AvatarId, Vec2>();

	/** Applies a state message (WELCOME, JOINED, MOVED...). False for anything else. */
	apply(msg: HostToClient): boolean {
		switch (msg.t) {
			case "WELCOME":
				this.me = msg.you;
				this.offset = msg.serverTime - Date.now();
				this.budget = msg.budget;
				// back after a dropped connection: still walking with its owner, if it was
				if (!msg.resumed) this.company = null;
				this.avatars.clear();
				for (const a of msg.avatars) this.avatars.set(a.id, a);
				this.life = msg.life ?? null;
				return true;
			case "JOINED":
				this.avatars.set(msg.avatar.id, msg.avatar);
				return true;
			case "LEFT":
				this.avatars.delete(msg.id);
				return true;
			case "MOVED": {
				const a = this.avatars.get(msg.id);
				if (a) this.setMove(a, msg.move);
				return true;
			}
			case "CORRECT": {
				const a = this.me ? this.avatars.get(this.me) : undefined;
				if (a) this.setMove(a, msg.move);
				return true;
			}
			case "STATUS_CHANGED": {
				const a = this.avatars.get(msg.id);
				if (a) a.status = msg.status;
				return true;
			}
			case "BUDGET":
				this.budget = msg.level;
				return true;
			case "COMPANY":
				this.company = msg.on ? msg.owner : null;
				return true;
			case "ACTING": {
				const a = this.avatars.get(msg.id);
				if (a) {
					if (msg.doing) a.doing = msg.doing;
					else delete a.doing;
				}
				return true;
			}
			case "LIFE":
				if (msg.id === this.me) {
					this.life = msg.life;
					if (msg.coins !== undefined) this.coins = msg.coins;
				}
				return true;
			// these the agent hears of too (false)
			case "WALLET":
				this.coins = msg.coins;
				return false;
			case "JOBBED": {
				const a = this.avatars.get(msg.id);
				if (a) {
					if (msg.job) a.job = msg.job;
					else delete a.job;
				}
				return false;
			}
			// these also tell the agent what happened: its mind hears of them (false)
			case "ACT_DONE":
				if (msg.life) this.life = msg.life;
				return false;
			case "DAY":
				this.life = msg.life;
				return false;
			default:
				return false;
		}
	}

	private setMove(a: AvatarState, move: AvatarState["move"]): void {
		// the way it was going, kept for when it stands
		const before = this.headingOf(a.id);
		if (before) this.lastDir.set(a.id, before);
		a.move = move;
	}

	/**
	 * Which way an avatar faces (a unit vector), as every screen shows it: the way it walks, the way it chose
	 * to face standing, else, for this agent by its owner within 5 m, towards them (screens turn an AI to its
	 * owner), else the way it last went. Null if unknown.
	 */
	headingOf(id: AvatarId): Vec2 | null {
		const a = this.avatars.get(id);
		if (!a) return null;
		const pose = poseAt(a.move, this.hostNow());
		if (pose.moving) return pose.dir;
		if (a.move.kind === "idle" && a.move.face) return a.move.face;
		const owner = a.ownerId ? this.positionOf(a.ownerId) : null;
		if (owner && a.kind === "ai") {
			const d = dist(owner, pose.pos);
			if (d > 0.1 && d <= 5) return [(owner[0] - pose.pos[0]) / d, (owner[1] - pose.pos[1]) / d];
		}
		return this.lastDir.get(id) ?? null;
	}

	/** Where `to` is as seen from avatar `from` (its facing): 前, 右前, 右, 右後ろ, 後ろ, 左後ろ, 左, 左前. */
	directionTo(from: AvatarId, to: Vec2): string | null {
		const here = this.positionOf(from);
		const h = this.headingOf(from);
		if (!here || !h) return null;
		const v: Vec2 = [to[0] - here[0], to[1] - here[1]];
		if (Math.hypot(v[0], v[1]) < 0.3) return null;
		// facing +z, its right hand is on -x: right = (-h.z, h.x)
		const ahead = v[0] * h[0] + v[1] * h[1];
		const right = v[0] * -h[1] + v[1] * h[0];
		const deg = (Math.atan2(right, ahead) * 180) / Math.PI;
		const ways = ["前", "右前", "右", "右後ろ", "後ろ", "左後ろ", "左", "左前"];
		return ways[((Math.round(deg / 45) % 8) + 8) % 8] ?? null;
	}

	/** Host time estimated from WELCOME.serverTime. */
	hostNow(): number {
		return Date.now() + this.offset;
	}

	positionOf(id: AvatarId): Vec2 | null {
		const a = this.avatars.get(id);
		return a ? poseAt(a.move, this.hostNow()).pos : null;
	}

	/** This agent's life now: energy goes down with time (the host decides the same way). */
	lifeNow(): LifeState | null {
		return this.life ? decay(this.life, this.hostNow()) : null;
	}

	/** This agent's own avatar. */
	get self(): AvatarState | undefined {
		return this.me ? this.avatars.get(this.me) : undefined;
	}

	/** Whether this agent is walking right now. */
	moving(): boolean {
		const me = this.self;
		return me ? poseAt(me.move, this.hostNow()).moving : false;
	}

	/** The closest landmarks to `from`, distances rounded to 0.1 m. */
	landmarksNear(
		landmarks: Landmark[],
		from: Vec2,
		max = 5,
	): { id: string; name: string; distance: number }[] {
		return landmarks
			.map((l) => ({ id: l.id, name: l.name, distance: Math.round(dist(l.pos, from) * 10) / 10 }))
			.sort((a, b) => a.distance - b.distance)
			.slice(0, max);
	}
}
