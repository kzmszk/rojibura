import type { AvatarId } from "@rojibura/protocol";
import type * as THREE from "three";
import type { AvatarView } from "./avatars.ts";

const ATTEND_M = 5;
/** After a line between an AI and its owner, it faces them and looks them in the eye this long. */
const TALK_FACE_MS = 20_000;
/** Beside its owner, not talking: how it stands changes this often; it turns this far to them, at most. */
const MOOD_MS = 8_000;
const TOWARD_OWNER = 0.35;

/** An AI stops: it looks at its owner for this long (ms; docs/cinema.md 5). */
const STOP_LOOK_MS = 2_500;
/** What an AI looks at, looking elsewhere: this far off (m) and this far from where it faces (radians). */
const SIGHT_NEAR = 3;
const SIGHT_FAR = 60;
const SIGHT_ANGLE = (60 * Math.PI) / 180;

/** A number in [0, 1) from a string (FNV-1a): the same on every screen. */
function hash01(s: string): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
	return (h >>> 0) / 2 ** 32;
}

/** The way from one heading to another, the short way round (radians). */
function turnBetween(from: number, to: number): number {
	return Math.atan2(Math.sin(to - from), Math.cos(to - from));
}

/** A place worth a look: the area's landmarks. */
type Sight = THREE.Vector3;
type AttentionView = {
	state: Pick<AvatarView["state"], "id" | "status" | "move">;
	root: Pick<AvatarView["root"], "position">;
	heading: AvatarView["heading"];
	eyePosition: AvatarView["eyePosition"];
};
type AttentionDecision = Readonly<{ target: Sight | null; facing: number | null }>;
const NO_ATTENTION: AttentionDecision = { target: null, facing: null };

/**
 * What an AI looking elsewhere looks at, this stretch of time (docs/cinema.md 5): one of the places around it, ahead
 * of it, chosen from its ID and the time and kept for the stretch. Null if there is nothing there.
 */
function sightOf(
	ai: AttentionView,
	slot: number,
	sights: readonly Sight[],
	picked: Map<AvatarId, SightPick>,
): Sight | null {
	const had = picked.get(ai.state.id);
	if (had?.slot === slot) return had.at;
	const p = ai.root.position;
	const around = sights.filter((s) => {
		const d = Math.hypot(s.x - p.x, s.z - p.z);
		if (d < SIGHT_NEAR || d > SIGHT_FAR) return false;
		return Math.abs(turnBetween(ai.heading, Math.atan2(s.x - p.x, s.z - p.z))) < SIGHT_ANGLE;
	});
	const at = around[Math.floor(hash01(`${ai.state.id}:${slot}:sight`) * around.length)] ?? null;
	picked.set(ai.state.id, { slot, at });
	return at;
}

interface SightPick {
	slot: number;
	at: Sight | null;
}

/**
 * An AI standing beside its owner, not talking (docs/prd.md 3.4.9): it faces the way they face, turned a little
 * to them; now and then it looks elsewhere for a while, at something if there is something to see, or glances at
 * them. From the time, so every screen shows the same.
 */
function besideMood(
	ai: AttentionView,
	owner: AttentionView,
	hostNow: number,
	sights: readonly Sight[],
	picked: Map<AvatarId, SightPick>,
): { facing: number; glance: boolean; sight: Sight | null } {
	const slot = Math.floor(hostNow / MOOD_MS);
	const r = hash01(`${ai.state.id}:${slot}`);
	const g = hash01(`${slot}:${ai.state.id}`);
	const a = ai.root.position;
	const o = owner.root.position;
	const toward = Math.atan2(o.x - a.x, o.z - a.z);
	const off = turnBetween(owner.heading, toward);
	const elsewhere = r < 0.5;
	const sight = elsewhere ? sightOf(ai, slot, sights, picked) : null;
	const wander = (r - 0.25) * 2.4;
	const look = !elsewhere
		? 0
		: sight
			? Math.max(-0.6, Math.min(0.6, turnBetween(owner.heading, Math.atan2(sight.x - a.x, sight.z - a.z))))
			: wander;
	return {
		facing: owner.heading + Math.max(-TOWARD_OWNER, Math.min(TOWARD_OWNER, off)) + look,
		glance: g < 0.45 && hostNow % MOOD_MS < 2_500,
		sight,
	};
}

export class Attention {
	private readonly sightPicks = new Map<AvatarId, SightPick>();
	private readonly talkAt = new Map<AvatarId, number>();

	said(id: AvatarId, now: number): void {
		this.talkAt.set(id, now);
	}

	talkingNow(ai: AttentionView, now: number): boolean {
		return ai.state.status === "busy" || now - (this.talkAt.get(ai.state.id) ?? -TALK_FACE_MS) < TALK_FACE_MS;
	}

	decide(
		v: AttentionView,
		owner: AttentionView | undefined,
		now: number,
		sights: readonly Sight[],
	): AttentionDecision {
		const near = owner && owner.root.position.distanceTo(v.root.position) < ATTEND_M;
		if (!near) return NO_ATTENTION;
		const talking = this.talkingNow(v, now);
		const mood = !talking ? besideMood(v, owner, now, sights, this.sightPicks) : null;
		const stopped = v.state.move.kind === "idle" && now - v.state.move.at < STOP_LOOK_MS;
		return {
			target: talking || mood?.glance || stopped ? owner.eyePosition() : (mood?.sight ?? null),
			facing: mood ? mood.facing : null,
		};
	}
}
