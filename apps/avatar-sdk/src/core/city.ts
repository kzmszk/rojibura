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

/** places.json: a short description of each landmark, by landmark ID. Optional. */
export interface PlacesData {
	places: Record<string, string>;
}

/** The city's landmarks with their descriptions. */
export function landmarksOf(data: LandmarksData, places?: PlacesData | null): Landmark[] {
	return data.landmarks.map((l) => {
		const description = places?.places[l.id];
		return { id: l.id, name: l.name, pos: [l.pos[0], l.pos[1]], ...(description ? { description } : {}) };
	});
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
			// optional: a host without it (or one answering with its app page) still gives the landmarks
			const places = await fetch(`${baseUrl}${cityPath}/places.json`)
				.then((p) => (p.ok ? (p.json() as Promise<PlacesData>) : null))
				.catch(() => null);
			landmarks = landmarksOf(data, places);
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
