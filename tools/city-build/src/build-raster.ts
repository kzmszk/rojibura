// Builds an area's navmesh.json from walk rasters (docs/prd.md 3.8): the venezia area from Venice's tiles.
//
//   node tools/city-build/src/build-raster.ts <tiles dir or URL> <area dir> <tile> [<tile> ...]
//
// The tiles dir has Venice's tiles.json and <tile>.walk.png (public/data/island, locally or as deployed). The
// area dir has a hand-written landmarks.json (rojibura's frame); its heights are set from the raster and every
// landmark must be reachable from the spawn point.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type LandmarksData, NavMesh } from "@rojibura/nav";
import { assertReachable, formatLandmarks } from "./landmarks.ts";
import { buildNavMesh, defaultBuildOptions } from "./navmesh.ts";
import { readPng } from "./png.ts";
import { WalkRaster, type WalkTile } from "./walk-raster.ts";

/** Venice's tiles.json: what this needs of it. */
interface TileIndex {
	tiles: Record<string, { bbox: [number, number, number, number]; walk?: boolean }>;
}

async function read(base: string, file: string): Promise<Uint8Array> {
	if (!/^https?:/.test(base)) return readFileSync(join(base, file));
	const r = await fetch(`${base.replace(/\/$/, "")}/${file}`);
	if (!r.ok) throw new Error(`${file}: ${r.status}`);
	return new Uint8Array(await r.arrayBuffer());
}

export async function loadRaster(base: string, names: string[]): Promise<WalkRaster> {
	const index = JSON.parse(new TextDecoder().decode(await read(base, "tiles.json"))) as TileIndex;
	const tiles: WalkTile[] = [];
	for (const name of names) {
		const t = index.tiles[name];
		if (!t) throw new Error(`no tile ${name} in tiles.json`);
		tiles.push({ name, bbox: t.bbox, png: readPng(await read(base, `${name}.walk.png`)) });
	}
	return new WalkRaster(tiles);
}

async function main(args: string[]) {
	const [base, areaDir, ...names] = args;
	if (!base || !areaDir || names.length === 0) {
		console.error(
			"usage: node tools/city-build/src/build-raster.ts <tiles dir or URL> <area dir> <tile> [<tile> ...]",
		);
		process.exit(2);
	}
	const started = performance.now();
	const raster = await loadRaster(base, names);
	const soup = raster.soup();
	const landmarksFile = join(areaDir, "landmarks.json");
	const city = JSON.parse(readFileSync(landmarksFile, "utf8")) as LandmarksData;
	// heights from the raster: the seed has to be on the surface, and renderers use `y`
	const heightAt = (p: [number, number], what: string) => {
		const y = raster.heightNear(p[0], p[1]);
		if (y === null) throw new Error(`${what} [${p.join(", ")}] is not on a walkable cell`);
		return Math.round(y * 100) / 100;
	};
	city.spawn.y = heightAt(city.spawn.pos, "SPAWN");
	for (const l of city.landmarks) l.y = heightAt(l.pos, l.id);
	const { data: navmesh, rawPolygonCount } = await buildNavMesh(soup, {
		...defaultBuildOptions,
		seeds: [[city.spawn.pos[0], city.spawn.y, city.spawn.pos[1]]],
		heightAt: (x, z, top) => raster.heightNear(x, z) ?? top,
	});
	const mesh = NavMesh.fromJSON(navmesh);
	assertReachable(mesh, city);
	const navmeshJson = `${JSON.stringify(navmesh)}\n`;
	writeFileSync(join(areaDir, "navmesh.json"), navmeshJson);
	writeFileSync(landmarksFile, formatLandmarks(city));
	console.log(
		`navmesh.json: ${navmesh.polygons.length} polygons (${rawPolygonCount} before dropping unreachable islands), ` +
			`${navmesh.vertices.length / 3} vertices, ${(Buffer.byteLength(navmeshJson) / 1024).toFixed(1)} KB, ` +
			`from ${soup.indices.length / 3} triangles`,
	);
	console.log(`done in ${Math.round(performance.now() - started)} ms`);
}

if (import.meta.main) await main(process.argv.slice(2));
