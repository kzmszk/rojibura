// The walkable ground and landmarks of the test city, from tools/city-build output (docs/prd.md 2.3).

import { type LandmarksData, NavMesh, validatePath } from "@rojibura/nav";
import type { Vec2 } from "@rojibura/protocol";
import landmarksJson from "../../../../assets/test-city/landmarks.json";
import navmeshJson from "../../../../assets/test-city/navmesh.json";
import type { Walkable, World } from "./room-core.ts";

/** Segments are sampled this densely so a long segment cannot cut across an obstacle. */
const SAMPLE_SPACING = 0.25;

export const navmesh = NavMesh.fromJSON(navmeshJson);
const city = landmarksJson as LandmarksData;

const walk: Walkable = {
	isWalkable: (p) => navmesh.isWalkable(p),
	validatePath: (path) => validatePath(navmesh, path, { sampleSpacing: SAMPLE_SPACING }).ok,
	closestPoint: (p) => navmesh.closestPoint(p),
};

export const world: World = {
	walk,
	landmarks: city.landmarks.map((l) => ({ id: l.id, name: l.name, pos: [l.pos[0], l.pos[1]] as Vec2 })),
	spawn: [city.spawn.pos[0], city.spawn.pos[1]],
	areaName: "テストの街",
};

export interface Preset {
	id: string;
	name: string;
	assets: { thumb: string; lod: string; vrm: string };
}

/** Preset avatars served as static assets (repo assets/ is Vite's publicDir). */
export const DEFAULT_PRESET: Preset = {
	id: "saki",
	name: "サキ",
	assets: { thumb: "", lod: "/avatars/saki.glb", vrm: "/avatars/saki.glb" },
};

export const PRESETS: Record<string, Preset> = {
	saki: DEFAULT_PRESET,
	capsule: { id: "capsule", name: "カプセル", assets: { thumb: "", lod: "", vrm: "" } },
};
