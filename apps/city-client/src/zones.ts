// Places with a rule of their own (an area's zones.json, docs/prd.md 3.8.6): indoors, where the camera looks from
// your eyes (it would be above the ceiling otherwise); the onsen, where everyone wears a swimsuit; its changing
// rooms, which only men or only women go into.

import { type KeepOut, roomsKeptOut } from "@rojibura/nav";
import type { Sex, Vec2 } from "@rojibura/protocol";

export type ZoneKind = "indoor" | "bath" | "water" | "work" | "study" | "changing";

export interface Zone {
	id: string;
	kind: ZoneKind;
	name?: string;
	poly: Vec2[];
	/** water: the surface's height. */
	y?: number;
	/** changing: who goes in. */
	sex?: Sex;
}

function inside(p: Vec2, poly: Vec2[]): boolean {
	let c = false;
	for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
		const [xi, zi] = poly[i] as Vec2;
		const [xj, zj] = poly[j] as Vec2;
		if (zi > p[1] !== zj > p[1] && p[0] < ((xj - xi) * (p[1] - zi)) / (zj - zi) + xi) c = !c;
	}
	return c;
}

export class Zones {
	private zones: Zone[] = [];

	/** The area's zones (its dir has zones.json, or it has none). */
	async load(dir: string): Promise<void> {
		const r = await fetch(`${dir}/zones.json`).catch(() => null);
		const data = r?.ok ? ((await r.json().catch(() => null)) as { zones?: Zone[] } | null) : null;
		this.zones = data?.zones ?? [];
	}

	/** Whether `p` is within `margin` metres of a zone of this kind's bounding box (to get ready for it). */
	near(p: Vec2, kind: ZoneKind, margin: number): boolean {
		return this.zones.some((z) => {
			if (z.kind !== kind) return false;
			const xs = z.poly.map((q) => q[0]);
			const zs = z.poly.map((q) => q[1]);
			return (
				p[0] > Math.min(...xs) - margin &&
				p[0] < Math.max(...xs) + margin &&
				p[1] > Math.min(...zs) - margin &&
				p[1] < Math.max(...zs) + margin
			);
		});
	}

	/** The rooms someone of this sex keeps out of (none without a sex). */
	keepOut(sex: Sex | undefined): KeepOut[] {
		if (!sex) return [];
		const rooms = this.zones.filter((z): z is Zone & { sex: Sex } => z.kind === "changing" && !!z.sex);
		return roomsKeptOut(rooms)[sex] ?? [];
	}

	/** The first zone of this kind at `p`, or null. */
	at(p: Vec2, kind: ZoneKind): Zone | null {
		return this.zones.find((z) => z.kind === kind && inside(p, z.poly)) ?? null;
	}
}
