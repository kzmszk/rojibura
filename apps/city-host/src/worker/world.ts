// The walkable ground and landmarks of each area, from tools/city-build output (docs/prd.md 2.3, 3.8). The host
// only has these; the 3D files are for browsers, and may be on another origin.

import {
	applyBuilds,
	type LandmarksData,
	type ModelNav,
	NavMesh,
	type NavMeshData,
	validatePath,
} from "@rojibura/nav";
import type {
	AreaId,
	AreaInfo,
	AreasData,
	JobZone,
	ModelId,
	ModelInfo,
	PublishedBuilds,
	ShopsData,
	Vec2,
} from "@rojibura/protocol";
import publishedJson from "../../../../assets/areas/hajimari/builds.json";
import landmarksJson from "../../../../assets/areas/hajimari/landmarks.json";
import baseNavmeshJson from "../../../../assets/areas/hajimari/navmesh.base.json";
import navmeshJson from "../../../../assets/areas/hajimari/navmesh.json";
import shopsJson from "../../../../assets/areas/hajimari/shops.json";
import zonesJson from "../../../../assets/areas/hajimari/zones.json";
import sagradaLandmarksJson from "../../../../assets/areas/sagrada/landmarks.json";
import sagradaNavmeshJson from "../../../../assets/areas/sagrada/navmesh.json";
import veneziaLandmarksJson from "../../../../assets/areas/venezia/landmarks.json";
import veneziaNavmeshJson from "../../../../assets/areas/venezia/navmesh.json";
import areasJson from "../../../../assets/areas.json";
import benchNav from "../../../../assets/models/bench.nav.json";
import bridgeNav from "../../../../assets/models/bridge.nav.json";
import deckNav from "../../../../assets/models/deck.nav.json";
import houseNav from "../../../../assets/models/house.nav.json";
import modelIndex from "../../../../assets/models/index.json";
import lampNav from "../../../../assets/models/lamp.nav.json";
import towerNav from "../../../../assets/models/tower.nav.json";
import treeNav from "../../../../assets/models/tree.nav.json";
import type { BuildWorld, Walkable, World } from "./room-core.ts";

/** Segments are sampled this densely so a long segment cannot cut across an obstacle. */
const SAMPLE_SPACING = 0.25;

/** Every area and the portals between them (docs/prd.md 3.8). The first is the main one. */
export const AREAS = areasJson as unknown as AreasData;
export const AREA_IDS = Object.keys(AREAS.areas);
export const MAIN_AREA: AreaId = AREA_IDS[0] ?? "main";

/** What the host has of each area besides areas.json (the main area's, はじまりの街, are below). */
const AREA_FILES: Record<AreaId, { navmesh: NavMeshData; landmarks: LandmarksData }> = {
	sagrada: {
		navmesh: sagradaNavmeshJson as NavMeshData,
		landmarks: sagradaLandmarksJson as LandmarksData,
	},
	venezia: {
		navmesh: veneziaNavmeshJson as NavMeshData,
		landmarks: veneziaLandmarksJson as LandmarksData,
	},
};

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

/** The area's landmarks, then its portals: people and AIs can walk to a portal like to any landmark. */
function landmarksOf(data: LandmarksData, area: AreaInfo): World["landmarks"] {
	return [
		...data.landmarks.map((l) => ({ id: l.id, name: l.name, pos: [l.pos[0], l.pos[1]] as Vec2 })),
		...(area.portals ?? []).map((p) => ({ id: p.id, name: p.name, pos: [p.pos[0], p.pos[1]] as Vec2 })),
	];
}

function areaOf(id: AreaId): AreaInfo {
	const area = AREAS.areas[id];
	if (!area) throw new Error(`no area ${id} in areas.json`);
	return area;
}

const [sx, sz] = city.spawn.pos;

/** The main area as everyone sees it: published builds are part of it (fixed). */
export const world: World = {
	walk,
	landmarks: landmarksOf(city, areaOf(MAIN_AREA)),
	spawn: [sx, sz],
	areaName: areaOf(MAIN_AREA).name,
	fixedBuilds: PUBLISHED.builds,
	// two balls and a box near where people arrive (docs/prd.md 3.4.7)
	items: [
		{ kind: "ball", pos: [sx + 2, sz + 1.5] },
		{ kind: "ball", pos: [sx - 2.5, sz + 1] },
		{ kind: "box", pos: [sx + 1, sz - 2.5] },
	],
	// the shops on the main street, and where one works or studies to earn coins (docs/prd.md 3.8.6)
	shops: (shopsJson as unknown as ShopsData).shops,
	jobZones: (zonesJson as unknown as { zones: JobZone[] }).zones.filter(
		(z) => z.kind === "work" || z.kind === "study",
	),
};

const worlds = new Map<AreaId, World>([[MAIN_AREA, world]]);

/** The area as everyone sees it, or undefined if there is no such area. Made once per isolate. */
export function worldOf(id: AreaId): World | undefined {
	const known = worlds.get(id);
	if (known) return known;
	const area = AREAS.areas[id];
	const files = AREA_FILES[id];
	if (!area || !files) return undefined;
	const made: World = {
		walk: walkFor(NavMesh.fromJSON(files.navmesh)),
		landmarks: landmarksOf(files.landmarks, area),
		spawn: [files.landmarks.spawn.pos[0], files.landmarks.spawn.pos[1]],
		areaName: area.name,
	};
	worlds.set(id, made);
	return made;
}

/**
 * Free play: in an area where building is possible (the main one), the city alone with building on it (the
 * published builds come as the area's own builds); elsewhere the area as it is.
 */
export function freePlayWorld(
	id: AreaId,
	registered: (id: ModelId) => ModelNav | undefined,
): World | undefined {
	if (id !== MAIN_AREA || !areaOf(MAIN_AREA).build) return worldOf(id);
	return { ...world, walk: walkFor(baseNavmesh), fixedBuilds: undefined, build: buildWorld(registered) };
}

/** Landmark IDs of every area (the trial LLM's output schema, which does not know the area). */
export const ALL_LANDMARK_IDS = [
	...new Set(
		AREA_IDS.flatMap((id) => {
			const data = id === MAIN_AREA ? city : AREA_FILES[id]?.landmarks;
			return data ? landmarksOf(data, areaOf(id)).map((l) => l.id) : [];
		}),
	),
];

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
	// VRoid's models, slimmed with tools/city-build/src/avatar-cli.ts (docs/prd.md 3.4.4):
	// 千駄ヶ谷 渋 (casual clothes), her older sister 篠 (Welcome School Uniform 2019), their cousin 桜田 史利矢
	// (school uniform), and AvatarSample_C, who has no name of his own and is 神宮 礼 here
	shibu: { id: "shibu", name: "シブ", assets: { thumb: "", lod: "", vrm: "/avatars/shibu.vrm" } },
	shino: { id: "shino", name: "シノ", assets: { thumb: "", lod: "", vrm: "/avatars/shino.vrm" } },
	fumiriya: {
		id: "fumiriya",
		name: "フミリヤ",
		assets: { thumb: "", lod: "", vrm: "/avatars/fumiriya.vrm" },
	},
	rei: { id: "rei", name: "レイ", assets: { thumb: "", lod: "", vrm: "/avatars/rei.vrm" } },
	capsule: { id: "capsule", name: "カプセル", assets: { thumb: "", lod: "", vrm: "" } },
};

/** The guide's look (docs/prd.md 3.5.3): a VRM, so it shakes hands and hugs like everyone else. */
export const GUIDE_PRESET = PRESETS.fumiriya as Preset;
