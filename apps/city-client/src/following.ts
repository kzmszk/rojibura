import {
	type AvatarId,
	type AvatarState,
	dist,
	poseAt,
	RUN_SPEED,
	type Vec2,
	WALK_SPEED,
} from "@rojibura/protocol";

const FOLLOW_STOP_M = 2;
const FOLLOW_REPLAN_MS = 1000;
const LEAD_BEHIND_M = 1.5;

export type FollowState = {
	id: AvatarId;
	until: number;
	plannedAt: number;
	lead?: { to: Vec2; place: string };
};
type Person = { state: AvatarState };

export class Following {
	current: FollowState | null = null;
	private readonly deps: {
		person: (id: AvatarId) => Person | undefined;
		me: () => Person | undefined;
		hostNow: () => number;
		walk: (to: Vec2, speed: number) => boolean;
		toast: (text: string) => void;
		arrived: (name: string, place: string) => void;
		resumeCompanion: () => void;
	};
	constructor(deps: Following["deps"]) {
		this.deps = deps;
	}

	end(): void {
		if (this.current?.lead) this.deps.resumeCompanion();
		this.current = null;
	}

	step(t: number): void {
		const following = this.current;
		if (!following) return;
		const mine = this.deps.me();
		const them = this.deps.person(following.id);
		if (!mine || !them || t > following.until) {
			if (!them) this.deps.toast("相手を見失いました");
			this.end();
			return;
		}
		const now = this.deps.hostNow();
		const here = poseAt(mine.state.move, now).pos;
		const there = poseAt(them.state.move, now).pos;
		const d = Math.hypot(there[0] - here[0], there[1] - here[1]);
		const lead = following.lead;
		if (lead) {
			if (!poseAt(them.state.move, now).moving && dist(there, lead.to) < 1.5 && d <= FOLLOW_STOP_M + 0.5) {
				this.deps.toast(`${lead.place}に着きました`);
				this.deps.arrived(them.state.name, lead.place);
				this.end();
				return;
			}
			if (t - following.plannedAt < FOLLOW_REPLAN_MS) return;
			const soon = poseAt(them.state.move, now + FOLLOW_REPLAN_MS).pos;
			const ds = Math.hypot(soon[0] - here[0], soon[1] - here[1]);
			if (ds < LEAD_BEHIND_M + 0.3) return;
			following.plannedAt = t;
			const k = LEAD_BEHIND_M / ds;
			const goal: Vec2 = [soon[0] + (here[0] - soon[0]) * k, soon[1] + (here[1] - soon[1]) * k];
			const speed = d > 5 ? RUN_SPEED : WALK_SPEED;
			if (!this.deps.walk(goal, speed)) this.deps.walk(soon, speed);
			return;
		}
		if (d <= FOLLOW_STOP_M) {
			this.deps.toast(`${them.state.name} のそばに着きました`);
			this.current = null;
			return;
		}
		if (t - following.plannedAt < FOLLOW_REPLAN_MS) return;
		following.plannedAt = t;
		const k = Math.min(1, (FOLLOW_STOP_M * 0.75) / d);
		const goal: Vec2 = [there[0] + (here[0] - there[0]) * k, there[1] + (here[1] - there[1]) * k];
		if (
			!this.deps.walk(goal, d > 4 ? RUN_SPEED : WALK_SPEED) &&
			!this.deps.walk(there, d > 4 ? RUN_SPEED : WALK_SPEED)
		) {
			this.deps.toast("そこへは行けません");
			this.current = null;
		}
	}
}
