// Builds navmesh.json and landmarks.json from a city glb (issue #12). CLI: src/build.ts.
export { buildCity, type CityBuild } from "./build.ts";
export { collectTriangles, parseGlb } from "./glb.ts";
export { extractLandmarks } from "./landmarks.ts";
export { type AgentParams, buildNavMesh, defaultBuildOptions, type NavMeshBuildOptions } from "./navmesh.ts";
