// Loads the city's landmarks and navmesh from the host's static assets.

import { type LandmarksData, NavMesh, type NavMeshData } from "@rojibura/nav";
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

export function navigatorFor(mesh: NavMesh): Navigator {
	return { findPath: (from, to) => mesh.findPath(mesh.closestPoint(from), mesh.closestPoint(to)) };
}

export async function loadCity(baseUrl: string, cityPath = "/test-city"): Promise<City> {
	let landmarks: Landmark[] = [];
	let spawn: Vec2 | null = null;
	let nav = straightLine;
	let hasNavmesh = false;
	try {
		const r = await fetch(`${baseUrl}${cityPath}/landmarks.json`);
		if (r.ok) {
			const data = (await r.json()) as LandmarksData;
			landmarks = data.landmarks.map((l) => ({ id: l.id, name: l.name, pos: [l.pos[0], l.pos[1]] }));
			spawn = [data.spawn.pos[0], data.spawn.pos[1]];
		}
		const n = await fetch(`${baseUrl}${cityPath}/navmesh.json`);
		if (n.ok) {
			nav = navigatorFor(NavMesh.fromJSON((await n.json()) as NavMeshData));
			hasNavmesh = true;
		}
	} catch {
		// keep the fallbacks
	}
	return { landmarks, spawn, nav, hasNavmesh };
}
