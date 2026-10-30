// The walkable ground and landmarks of the test city.
// TODO(#12): replace the bounding-box placeholder with @rojibura/nav and assets/test-city/navmesh.json.

import type { Vec2 } from "@rojibura/protocol";
import type { Landmark, Walkable, World } from "./room-core.ts";

const HALF = 39;
const inside = (p: Vec2) => Math.abs(p[0]) <= HALF && Math.abs(p[1]) <= HALF;

const walk: Walkable = {
	isWalkable: inside,
	validatePath: (path) => path.every(inside),
	closestPoint: (p) => [Math.max(-HALF, Math.min(HALF, p[0])), Math.max(-HALF, Math.min(HALF, p[1]))],
};

// glTF coordinates (x, z) of the LM_* nodes in assets/test-city/test_city.glb
const landmarks: Landmark[] = [
	{ id: "fountain", name: "中央噴水", pos: [0, -5] },
	{ id: "cafe", name: "オープンカフェ", pos: [18, -9] },
	{ id: "station", name: "駅前", pos: [-20, -22] },
	{ id: "library", name: "図書館の入口", pos: [-18, 14] },
	{ id: "deck", name: "展望デッキ", pos: [22, 20] },
	{ id: "park", name: "小さな公園", pos: [-3, 27] },
];

export const world: World = { walk, landmarks, spawn: [0, -8], areaName: "テストの街" };

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
