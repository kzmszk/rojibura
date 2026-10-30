// Loads the city's landmarks and navmesh from the host's static assets.

import type { Vec2 } from "@rojibura/protocol";
import type { Landmark, Navigator } from "./types.ts";

export interface City {
	landmarks: Landmark[];
	spawn: Vec2 | null;
	nav: Navigator;
	hasNavmesh: boolean;
}

/** Fallback when no navmesh is available: walk in a straight line (the host still validates). */
export const straightLine: Navigator = { findPath: (from, to) => [from, to] };

export async function loadCity(baseUrl: string, cityPath = "/test-city"): Promise<City> {
	let landmarks: Landmark[] = [];
	let spawn: Vec2 | null = null;
	try {
		const r = await fetch(`${baseUrl}${cityPath}/landmarks.json`);
		if (r.ok) {
			const data = (await r.json()) as { landmarks: Landmark[]; spawn?: { pos: Vec2 } };
			landmarks = data.landmarks.map((l) => ({ id: l.id, name: l.name, pos: l.pos }));
			spawn = data.spawn?.pos ?? null;
		}
	} catch {
		// keep defaults
	}
	return { landmarks, spawn, nav: straightLine, hasNavmesh: false };
}
