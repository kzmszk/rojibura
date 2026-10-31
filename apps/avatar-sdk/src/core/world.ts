// What an agent knows about the city around it, kept current from the host's messages (docs/prd.md 3.2).
// Shared by the rule-based Agent and the pi resident.

import {
	type AvatarId,
	type AvatarState,
	type BudgetLevel,
	dist,
	type HostToClient,
	poseAt,
	type Vec2,
} from "@rojibura/protocol";
import type { Landmark } from "./types.ts";

export class World {
	me: AvatarId | null = null;
	readonly avatars = new Map<AvatarId, AvatarState>();
	budget: BudgetLevel = 0;
	private offset = 0;

	/** Applies a state message (WELCOME, JOINED, MOVED...). False for anything else. */
	apply(msg: HostToClient): boolean {
		switch (msg.t) {
			case "WELCOME":
				this.me = msg.you;
				this.offset = msg.serverTime - Date.now();
				this.budget = msg.budget;
				this.avatars.clear();
				for (const a of msg.avatars) this.avatars.set(a.id, a);
				return true;
			case "JOINED":
				this.avatars.set(msg.avatar.id, msg.avatar);
				return true;
			case "LEFT":
				this.avatars.delete(msg.id);
				return true;
			case "MOVED": {
				const a = this.avatars.get(msg.id);
				if (a) a.move = msg.move;
				return true;
			}
			case "CORRECT": {
				const a = this.me ? this.avatars.get(this.me) : undefined;
				if (a) a.move = msg.move;
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
			default:
				return false;
		}
	}

	/** Host time estimated from WELCOME.serverTime. */
	hostNow(): number {
		return Date.now() + this.offset;
	}

	positionOf(id: AvatarId): Vec2 | null {
		const a = this.avatars.get(id);
		return a ? poseAt(a.move, this.hostNow()).pos : null;
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
