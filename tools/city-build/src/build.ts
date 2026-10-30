// Builds navmesh.json and landmarks.json from a city glb (docs/prd.md 2.3, issue #12).
//
//   node tools/city-build/src/build.ts <city.glb> <outDir>
//
// Recast (Wasm) is only used here, at build time; the runtime (@rojibura/nav) is pure TypeScript.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type LandmarksData, NavMesh, type NavMeshData } from "@rojibura/nav";
import { collectTriangles, parseGlb } from "./glb.ts";
import { extractLandmarks } from "./landmarks.ts";
import { buildNavMesh, defaultBuildOptions } from "./navmesh.ts";

export interface CityBuild {
	navmesh: NavMeshData;
	landmarks: LandmarksData;
	rawPolygonCount: number;
}

export async function buildCity(glbBytes: Uint8Array): Promise<CityBuild> {
	const glb = parseGlb(glbBytes);
	const landmarks = extractLandmarks(glb);
	const soup = collectTriangles(glb);
	const { spawn } = landmarks;
	const { data: navmesh, rawPolygonCount } = await buildNavMesh(soup, {
		...defaultBuildOptions,
		seeds: [[spawn.pos[0], spawn.y, spawn.pos[1]]],
	});
	// Every landmark must be reachable from the spawn point.
	const mesh = NavMesh.fromJSON(navmesh);
	const lost = landmarks.landmarks.filter((l) => !mesh.findPath(spawn.pos, l.pos));
	if (lost.length > 0) {
		throw new Error(
			`landmarks not reachable from SPAWN: ${lost.map((l) => `${l.id} [${l.pos.join(", ")}]`).join("; ")}`,
		);
	}
	return { navmesh, landmarks, rawPolygonCount };
}

async function main(args: string[]) {
	const [input, outDir] = args;
	if (!input || !outDir) {
		console.error("usage: node tools/city-build/src/build.ts <city.glb> <outDir>");
		process.exit(2);
	}
	const started = performance.now();
	const { navmesh, landmarks, rawPolygonCount } = await buildCity(readFileSync(input));
	mkdirSync(outDir, { recursive: true });
	const navmeshJson = `${JSON.stringify(navmesh)}\n`;
	// One landmark per line keeps the file readable and its diffs small.
	const landmarksJson = [
		"{",
		'\t"landmarks": [',
		landmarks.landmarks.map((l) => `\t\t${JSON.stringify(l)}`).join(",\n"),
		"\t],",
		`\t"spawn": ${JSON.stringify(landmarks.spawn)}`,
		"}\n",
	].join("\n");
	writeFileSync(join(outDir, "navmesh.json"), navmeshJson);
	writeFileSync(join(outDir, "landmarks.json"), landmarksJson);
	const kb = (s: string) => `${(Buffer.byteLength(s) / 1024).toFixed(1)} KB`;
	console.log(
		`navmesh.json: ${navmesh.polygons.length} polygons (${rawPolygonCount} before dropping unreachable islands), ` +
			`${navmesh.vertices.length / 3} vertices, ${kb(navmeshJson)}`,
	);
	console.log(`landmarks.json: ${landmarks.landmarks.length} landmarks + spawn, ${kb(landmarksJson)}`);
	console.log(`done in ${Math.round(performance.now() - started)} ms`);
}

if (import.meta.main) await main(process.argv.slice(2));
