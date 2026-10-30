// Navigation shared by the client, the AI runtimes and the host (docs/prd.md 2.3). Pure TypeScript:
// no Wasm, no Node APIs, no DOM.
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
