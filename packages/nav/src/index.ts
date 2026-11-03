// Navigation shared by the client, the AI runtimes and the host (docs/prd.md 2.3). Pure TypeScript:
// no Wasm, no Node APIs, no DOM.
export {
	applyBuilds,
	boxNav,
	claimed,
	GROUND_Y,
	MODEL_LIMITS,
	type ModelNav,
	NAV_MARGIN,
	occupied,
	type PlacedModel,
	toWorld,
	WALK_RING,
	walkRegion,
} from "./builds.ts";
export {
	area2,
	assemble,
	carveObstacles,
	ccw,
	convexHull,
	expand,
	intersect,
	overlaps,
	type Piece,
	piecesOf,
	subtract,
	type Vec3,
	xz,
} from "./carve.ts";
export {
	entersPoly,
	insidePoly,
	type KeepOut,
	keepingOut,
	roomsKeptOut,
	type WalkQueries,
} from "./keep-out.ts";
export type { Landmark, LandmarksData, SpawnPoint } from "./landmarks.ts";
export {
	NAVMESH_VERSION,
	NavMesh,
	type NavMeshData,
	type NavMeshOptions,
	type NavMeshPolygonData,
} from "./navmesh.ts";
export { type PathProblem, type PathValidation, type ValidatePathOptions, validatePath } from "./validate.ts";
export { distance, pathLength, pointAlongPath, type Vec2 } from "./vec.ts";
