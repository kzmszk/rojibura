// Builds an area's navmesh.json and landmarks.json from a float walk raster (docs/prd.md 3.8): はじまりの街, whose
// raster comes from its plan (tools/city-build/blender/hajimari/walk.py), not from voxelising its 3D.
//
//   node tools/city-build/src/build-grid.ts <raster dir> <area dir>
//
// The raster dir has walk.json ({x0, y0, res, nx, ny}, Blender's frame: x east, y north) and walk.f32 (the height
// of the walkable surface per cell, row by row from the south, NaN where blocked) and meta.json (landmarks and
// spawn in rojibura's frame, without heights). Writes <area dir>/navmesh.base.json, landmarks.json and navmesh.json
// (the base with what was published from free play baked in, as build.ts does); every landmark must be reachable
// from the spawn point.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type LandmarksData, NavMesh } from "@rojibura/nav";
import { bake, builtinNavs, EMPTY, type Published } from "./bake.ts";
import type { TriangleSoup } from "./glb.ts";
import { buildNavMesh, defaultBuildOptions } from "./navmesh.ts";

interface GridMeta {
	x0: number;
	y0: number;
	res: number;
	nx: number;
	ny: number;
}

/** A walk raster in rojibura's frame: X = x, Z = -y. */
export class WalkGrid {
	readonly meta: GridMeta;
	readonly h: Float32Array;

	constructor(meta: GridMeta, h: Float32Array) {
		if (h.length !== meta.nx * meta.ny)
			throw new Error(`walk.f32 has ${h.length} cells, not ${meta.nx * meta.ny}`);
		this.meta = meta;
		this.h = h;
	}

	/** Height of the cell at (X, Z), or null where blocked or outside. */
	at(X: number, Z: number): number | null {
		const { x0, y0, res, nx, ny } = this.meta;
		const i = Math.floor((X - x0) / res);
		const j = Math.floor((-Z - y0) / res);
		if (i < 0 || j < 0 || i >= nx || j >= ny) return null;
		const v = this.h[j * nx + i] as number;
		return Number.isNaN(v) ? null : v;
	}

	/** The cell at (X, Z) or the nearest walkable one within `r` metres. */
	heightNear(X: number, Z: number, r = 0.5): number | null {
		const here = this.at(X, Z);
		if (here !== null) return here;
		const step = this.meta.res / 2;
		let best: { d: number; y: number } | null = null;
		for (let dx = -r; dx <= r; dx += step)
			for (let dz = -r; dz <= r; dz += step) {
				const d = Math.hypot(dx, dz);
				if (d > r || (best && d >= best.d)) continue;
				const y = this.at(X + dx, Z + dz);
				if (y !== null) best = { d, y };
			}
		return best?.y ?? null;
	}

	/**
	 * The walkable cells as up-facing quads for Recast: each run of cells of one height (to the centimetre) along a
	 * row is one quad.
	 */
	soup(): TriangleSoup {
		const { x0, y0, res, nx, ny } = this.meta;
		const runs: number[] = [];
		for (let j = 0; j < ny; j++) {
			let i = 0;
			while (i < nx) {
				const v = this.h[j * nx + i] as number;
				if (Number.isNaN(v)) {
					i++;
					continue;
				}
				const cm = Math.round(v * 100);
				let end = i + 1;
				while (end < nx && Math.round((this.h[j * nx + end] as number) * 100) === cm) end++;
				runs.push(j, i, end, cm);
				i = end;
			}
		}
		const n = runs.length / 4;
		const P = new Float32Array(n * 12);
		const I = new Uint32Array(n * 6);
		for (let r = 0; r < n; r++) {
			const j = runs[r * 4] as number;
			const X0 = x0 + (runs[r * 4 + 1] as number) * res;
			const X1 = x0 + (runs[r * 4 + 2] as number) * res;
			const Y = (runs[r * 4 + 3] as number) / 100;
			// row j spans y0 + j*res .. y0 + (j+1)*res, i.e. Z from -(y0 + (j+1) res) to -(y0 + j res)
			const Z0 = -(y0 + (j + 1) * res);
			const Z1 = Z0 + res;
			P.set([X0, Y, Z0, X1, Y, Z0, X1, Y, Z1, X0, Y, Z1], r * 12);
			const v = r * 4;
			// a (X0, Z0), b (X1, Z0), c (X1, Z1), d (X0, Z1); (a, c, b) and (a, d, c) face +Y
			I.set([v, v + 2, v + 1, v, v + 3, v + 2], r * 6);
		}
		return { positions: P, indices: I };
	}
}

export function loadGrid(dir: string): WalkGrid {
	const meta = JSON.parse(readFileSync(join(dir, "walk.json"), "utf8")) as GridMeta;
	const bytes = readFileSync(join(dir, "walk.f32"));
	const h = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
	return new WalkGrid(meta, h);
}

async function main(args: string[]) {
	const [rasterDir, areaDir] = args;
	if (!rasterDir || !areaDir) {
		console.error("usage: node tools/city-build/src/build-grid.ts <raster dir> <area dir>");
		process.exit(2);
	}
	const started = performance.now();
	const grid = loadGrid(rasterDir);
	const city = JSON.parse(readFileSync(join(rasterDir, "meta.json"), "utf8")) as LandmarksData;
	const heightAt = (p: [number, number], what: string) => {
		const y = grid.heightNear(p[0], p[1], 1.0);
		if (y === null) throw new Error(`${what} [${p.join(", ")}] is not on a walkable cell`);
		return Math.round(y * 100) / 100;
	};
	city.spawn.y = heightAt(city.spawn.pos, "SPAWN");
	for (const l of city.landmarks) l.y = heightAt(l.pos, l.id);
	const soup = grid.soup();
	const { data: navmesh, rawPolygonCount } = await buildNavMesh(soup, {
		...defaultBuildOptions,
		seeds: [[city.spawn.pos[0], city.spawn.y, city.spawn.pos[1]]],
		heightAt: (x, z, top) => grid.heightNear(x, z) ?? top,
	});
	const mesh = NavMesh.fromJSON(navmesh);
	const lost = city.landmarks.filter((l) => !mesh.findPath(city.spawn.pos, l.pos));
	if (lost.length > 0)
		throw new Error(
			`landmarks not reachable from SPAWN: ${lost.map((l) => `${l.id} [${l.pos.join(", ")}]`).join("; ")}`,
		);
	const navmeshJson = `${JSON.stringify(navmesh)}\n`;
	writeFileSync(join(areaDir, "navmesh.base.json"), navmeshJson);
	const buildsFile = join(areaDir, "builds.json");
	const published = existsSync(buildsFile)
		? (JSON.parse(readFileSync(buildsFile, "utf8")) as Published)
		: EMPTY;
	const modelsDir = join(areaDir, "..", "..", "models");
	writeFileSync(
		join(areaDir, "navmesh.json"),
		`${JSON.stringify(bake(navmesh, published, builtinNavs(modelsDir)))}\n`,
	);
	writeFileSync(
		join(areaDir, "landmarks.json"),
		[
			"{",
			'\t"landmarks": [',
			city.landmarks.map((l) => `\t\t${JSON.stringify(l)}`).join(",\n"),
			"\t],",
			`\t"spawn": ${JSON.stringify(city.spawn)}`,
			"}\n",
		].join("\n"),
	);
	console.log(
		`navmesh.base.json: ${navmesh.polygons.length} polygons (${rawPolygonCount} before dropping unreachable islands), ` +
			`${navmesh.vertices.length / 3} vertices, ${(Buffer.byteLength(navmeshJson) / 1024).toFixed(1)} KB, ` +
			`from ${soup.indices.length / 3} triangles`,
	);
	console.log(`done in ${Math.round(performance.now() - started)} ms`);
}

if (import.meta.main) await main(process.argv.slice(2));
