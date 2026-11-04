import { dist, RUN_SPEED, type Vec2, WALK_SPEED } from "@rojibura/protocol";
import { PORTAL_REACH } from "./portals.ts";

const GATE_RUN_M = 10;
const GATE_REPLAN_MS = 1000;
const PLACE_REACH_M = 3;

export interface Destination {
	to: Vec2;
	name: string;
	gate: boolean;
	run: boolean;
	until: number;
	plannedAt: number;
	from: Vec2 | null;
}

type Pose = { pos: Vec2; moving: boolean };

export class Going {
	current: Destination | null = null;

	private readonly pose: () => Pose | undefined;
	private readonly walk: (to: Vec2, speed: number) => boolean;
	private readonly toast: (text: string) => void;
	constructor(
		pose: () => Pose | undefined,
		walk: (to: Vec2, speed: number) => boolean,
		toast: (text: string) => void,
	) {
		this.pose = pose;
		this.walk = walk;
		this.toast = toast;
	}

	step(t: number): void {
		const going = this.current;
		if (!going) return;
		const pose = this.pose();
		if (!pose || t > going.until) {
			this.current = null;
			return;
		}
		if (pose.moving) return;
		const d = dist(pose.pos, going.to);
		if (d <= (going.gate ? PORTAL_REACH : PLACE_REACH_M)) {
			if (!going.gate && !going.run) this.toast(`${going.name}に着きました`);
			this.current = null;
			return;
		}
		if (t - going.plannedAt < GATE_REPLAN_MS) return;
		if (going.from && dist(pose.pos, going.from) < 0.5) {
			this.toast("そこへは行けません");
			this.current = null;
			return;
		}
		going.plannedAt = t;
		going.from = pose.pos;
		if (!this.walk(going.to, going.run && d > GATE_RUN_M ? RUN_SPEED : WALK_SPEED)) {
			this.toast("そこへは行けません");
			this.current = null;
		}
	}
}
