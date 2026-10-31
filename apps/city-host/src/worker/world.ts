// The walkable ground and landmarks of the test city, from tools/city-build output (docs/prd.md 2.3).

import {
	applyBuilds,
	type LandmarksData,
	type ModelNav,
	NavMesh,
	type NavMeshData,
	validatePath,
} from "@rojibura/nav";
import type { ModelId, ModelInfo, PublishedBuilds, Vec2 } from "@rojibura/protocol";
import benchNav from "../../../../assets/models/bench.nav.json";
import bridgeNav from "../../../../assets/models/bridge.nav.json";
import deckNav from "../../../../assets/models/deck.nav.json";
import houseNav from "../../../../assets/models/house.nav.json";
import modelIndex from "../../../../assets/models/index.json";
import lampNav from "../../../../assets/models/lamp.nav.json";
import towerNav from "../../../../assets/models/tower.nav.json";
import treeNav from "../../../../assets/models/tree.nav.json";
import publishedJson from "../../../../assets/test-city/builds.json";
import landmarksJson from "../../../../assets/test-city/landmarks.json";
import baseNavmeshJson from "../../../../assets/test-city/navmesh.base.json";
import navmeshJson from "../../../../assets/test-city/navmesh.json";
import type { BuildWorld, Walkable, World } from "./room-core.ts";

/** Segments are sampled this densely so a long segment cannot cut across an obstacle. */
const SAMPLE_SPACING = 0.25;

/** The city with the published builds baked in (docs/prd.md 3.7.8): production and `pnpm dev`. */
export const navmesh = NavMesh.fromJSON(navmeshJson);
/** The city alone: free play builds on it (its own builds include what was published). */
const baseNavmesh = NavMesh.fromJSON(baseNavmeshJson);
const city = landmarksJson as LandmarksData;
/** What was built in free play and published: shown to everyone, fixed outside free play. */
export const PUBLISHED = publishedJson as unknown as PublishedBuilds<ModelNav>;

export function walkFor(mesh: NavMesh): Walkable {
	return {
		isWalkable: (p) => mesh.isWalkable(p),
		validatePath: (path) => validatePath(mesh, path, { sampleSpacing: SAMPLE_SPACING }).ok,
		closestPoint: (p) => mesh.closestPoint(p),
		findPath: (from, to) => mesh.findPath(from, to),
	};
}
const walk = walkFor(navmesh);

// ---- building in free play (docs/prd.md 3.7) ----

/** The built-in models (assets/models, made by `pnpm build:models`); "block" is drawn in code. */
export const BUILTIN_MODELS = modelIndex as ModelInfo[];
const BUILTIN_NAVS: Record<string, ModelNav> = {
	bench: benchNav as unknown as ModelNav,
	bridge: bridgeNav as unknown as ModelNav,
	deck: deckNav as unknown as ModelNav,
	house: houseNav as unknown as ModelNav,
	lamp: lampNav as unknown as ModelNav,
	tower: towerNav as unknown as ModelNav,
	tree: treeNav as unknown as ModelNav,
};

/** Building on the test city: built-in, registered (`registered`) and published models. */
function buildWorld(registered: (id: ModelId) => ModelNav | undefined): BuildWorld {
	return {
		model: (id) => BUILTIN_NAVS[id] ?? registered(id) ?? PUBLISHED.models[id]?.nav,
		groundHeight: (p) => baseNavmesh.heightAt(p),
		walkWith: (placed) => walkFor(NavMesh.fromJSON(applyBuilds(baseNavmeshJson as NavMeshData, placed))),
	};
}

/** The city as everyone sees it: published builds are part of it (fixed). */
export const world: World = {
	walk,
	landmarks: city.landmarks.map((l) => ({ id: l.id, name: l.name, pos: [l.pos[0], l.pos[1]] as Vec2 })),
	spawn: [city.spawn.pos[0], city.spawn.pos[1]],
	areaName: "テストの街",
	fixedBuilds: PUBLISHED.builds,
};

/** Free play: the city alone, with building on it (the published builds come as the area's own builds). */
export function freePlayWorld(registered: (id: ModelId) => ModelNav | undefined): World {
	return { ...world, walk: walkFor(baseNavmesh), fixedBuilds: undefined, build: buildWorld(registered) };
}

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
