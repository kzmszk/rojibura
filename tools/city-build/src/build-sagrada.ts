// Builds the sagrada area's navmesh.json (docs/prd.md 3.8): the floor of the Sagrada Família, from the runtime glb
// of the reconstruction in ~/work/demos/sagrada-familia (build/sagrada_familia.glb, uncompressed; the area's 3D is
// its export by tools/rj_export.mjs there, in the same frame).
//
//   node tools/city-build/src/build-sagrada.ts <sagrada_familia.glb> <area dir> [--debug <png>]
//
// Only the church floor at ground level is walkable (docs/prd.md 1.8: one level, no galleries, towers or roofs).
// The floor is rasterised at 0.1 m inside the plan (nave, transept, apse): a cell is walkable where there is floor
// at y = 0 and nothing between 5 cm and 2 m above it (column feet, walls, chairs, the presbytery's steps). The
// walkable cells go to Recast as flat quads, as for venezia's walk rasters, so it adds the agent's radius and the
// navmesh cannot leave through the open doors. The area dir has a hand-written landmarks.json (the model's frame:
// the crossing at (52.5, 0), the Nativity door at +Z); every landmark must be reachable from the spawn point.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type LandmarksData, NavMesh } from "@rojibura/nav";
import { collectTriangles, type GltfJson, type GltfNode, parseGlb, type TriangleSoup } from "./glb.ts";
import { buildNavMesh, defaultBuildOptions } from "./navmesh.ts";

/** The raster: cells of RES metres over [X0, X0 + W * RES] x [Z0, Z0 + H * RES]. */
const RES = 0.1;
const X0 = -2;
const Z0 = -38;
const W = 940;
const H = 760;
/** What stands between these heights above the floor blocks walking (the agent is 1.8 m tall). */
const SLAB = [0.05, 2.0] as const;

/**
 * The church's plan: the nave and aisles, the transept with the porches at its ends and the apse. The transept is
 * open at floor level into both porches; the Nativity porch ends at its bronze doors (z = 36.7, open at the
 * central pier), the Passion porch at its row of columns (z = -35.5), both open to the street, so the walkable
 * floor stops just inside them.
 */
export const NATIVITY_DOORS_Z = 36.4;
export const PASSION_COLUMNS_Z = -35.0;
function inPlan(x: number, z: number): boolean {
	if (x >= 0 && x <= 67.5 && Math.abs(z) <= 22.5) return true;
	if (x >= 37.5 && x <= 67.5 && z <= NATIVITY_DOORS_Z && z >= PASSION_COLUMNS_Z) return true;
	return x >= 67.5 && (x - 67.5) ** 2 + z ** 2 <= 22.5 ** 2;
}

/** Marks the cells whose centre is inside the XZ polygon, and the cells its edges pass through. */
function fillPolygon(mask: Uint8Array, poly: [number, number][]) {
	let minX = Infinity;
	let maxX = -Infinity;
	let minZ = Infinity;
	let maxZ = -Infinity;
	for (const [x, z] of poly) {
		minX = Math.min(minX, x);
		maxX = Math.max(maxX, x);
		minZ = Math.min(minZ, z);
		maxZ = Math.max(maxZ, z);
	}
	const i0 = Math.max(0, Math.floor((minX - X0) / RES));
	const i1 = Math.min(W - 1, Math.floor((maxX - X0) / RES));
	const j0 = Math.max(0, Math.floor((minZ - Z0) / RES));
	const j1 = Math.min(H - 1, Math.floor((maxZ - Z0) / RES));
	if (i0 > i1 || j0 > j1) return;
	const n = poly.length;
	for (let j = j0; j <= j1; j++) {
		const z = Z0 + (j + 0.5) * RES;
		for (let i = i0; i <= i1; i++) {
			const x = X0 + (i + 0.5) * RES;
			let inside = false;
			for (let a = 0, b = n - 1; a < n; b = a++) {
				const [xa, za] = poly[a] as [number, number];
				const [xb, zb] = poly[b] as [number, number];
				if (za > z !== zb > z && x < ((xb - xa) * (z - za)) / (zb - za) + xa) inside = !inside;
			}
			if (inside) mask[j * W + i] = 1;
		}
	}
	// walls seen from above are lines: their cells by sampling the edges
	for (let a = 0, b = n - 1; a < n; b = a++) {
		const [xa, za] = poly[a] as [number, number];
		const [xb, zb] = poly[b] as [number, number];
		const steps = Math.ceil(Math.hypot(xb - xa, zb - za) / (RES / 2)) + 1;
		for (let s = 0; s <= steps; s++) {
			const t = s / steps;
			const i = Math.floor((xa + (xb - xa) * t - X0) / RES);
			const j = Math.floor((za + (zb - za) * t - Z0) / RES);
			if (i >= 0 && i < W && j >= 0 && j < H) mask[j * W + i] = 1;
		}
	}
}

/** Clips a triangle to lo <= y <= hi (Sutherland–Hodgman); the XZ outline of what is left. */
function clipToSlab(tri: [number, number, number][], lo: number, hi: number): [number, number][] {
	let poly = tri;
	for (const [limit, keepBelow] of [
		[lo, false],
		[hi, true],
	] as const) {
		const out: [number, number, number][] = [];
		for (let a = 0; a < poly.length; a++) {
			const p = poly[a] as [number, number, number];
			const q = poly[(a + 1) % poly.length] as [number, number, number];
			const pin = keepBelow ? p[1] <= limit : p[1] >= limit;
			const qin = keepBelow ? q[1] <= limit : q[1] >= limit;
			if (pin) out.push(p);
			if (pin !== qin) {
				const t = (limit - p[1]) / (q[1] - p[1]);
				out.push([p[0] + (q[0] - p[0]) * t, limit, p[2] + (q[2] - p[2]) * t]);
			}
		}
		poly = out;
		if (poly.length === 0) return [];
	}
	return poly.map((p) => [p[0], p[2]]);
}

export interface FloorRaster {
	/** 1 where walkable. */
	walk: Uint8Array;
	/** 1 where there is floor at y = 0 (for the debug picture). */
	floor: Uint8Array;
	/** 1 where something stands in the slab. */
	blocked: Uint8Array;
}

export function rasterise(soup: TriangleSoup): FloorRaster {
	const floor = new Uint8Array(W * H);
	const blocked = new Uint8Array(W * H);
	const { positions: P, indices: I } = soup;
	for (let t = 0; t < I.length; t += 3) {
		const tri = [0, 1, 2].map((k) => {
			const v = (I[t + k] as number) * 3;
			return [P[v] as number, P[v + 1] as number, P[v + 2] as number];
		}) as [number, number, number][];
		const ys = tri.map((p) => p[1]);
		const yMin = Math.min(...ys);
		const yMax = Math.max(...ys);
		if (yMax < SLAB[0]) {
			// floor: a face turned up (either way: the model's materials are double-sided) at y = 0
			if (yMin < -0.1) continue;
			const [a, b, c] = tri as [[number, number, number], [number, number, number], [number, number, number]];
			const ux = b[0] - a[0];
			const uy = b[1] - a[1];
			const uz = b[2] - a[2];
			const vx = c[0] - a[0];
			const vy = c[1] - a[1];
			const vz = c[2] - a[2];
			const nx = uy * vz - uz * vy;
			const ny = uz * vx - ux * vz;
			const nz = ux * vy - uy * vx;
			if (Math.abs(ny) > 0.9 * Math.hypot(nx, ny, nz))
				fillPolygon(
					floor,
					tri.map((p) => [p[0], p[2]]),
				);
			continue;
		}
		if (yMin > SLAB[1]) continue;
		const poly = clipToSlab(tri, SLAB[0], SLAB[1]);
		if (poly.length > 0) fillPolygon(blocked, poly);
	}
	const walk = new Uint8Array(W * H);
	for (let j = 0; j < H; j++)
		for (let i = 0; i < W; i++) {
			const k = j * W + i;
			if (floor[k] && !blocked[k] && inPlan(X0 + (i + 0.5) * RES, Z0 + (j + 0.5) * RES)) walk[k] = 1;
		}
	return { walk, floor, blocked };
}

/** The walkable cells as quads facing up at y = 0, one per run along a row (as WalkRaster.soup). */
export function floorSoup(walk: Uint8Array): TriangleSoup {
	const P: number[] = [];
	const I: number[] = [];
	for (let j = 0; j < H; j++) {
		const za = Z0 + j * RES;
		let i = 0;
		while (i < W) {
			if (!walk[j * W + i]) {
				i++;
				continue;
			}
			let end = i + 1;
			while (end < W && walk[j * W + end]) end++;
			const xa = X0 + i * RES;
			const xb = X0 + end * RES;
			const v = P.length / 3;
			// a (xa, za), b (xb, za), c (xb, za + RES), d (xa, za + RES); (a, c, b) and (a, d, c) face +Y
			P.push(xa, 0, za, xb, 0, za, xb, 0, za + RES, xa, 0, za + RES);
			I.push(v, v + 2, v + 1, v, v + 3, v + 2);
			i = end;
		}
	}
	return { positions: new Float32Array(P), indices: new Uint32Array(I) };
}

/** Skips the meshes that lie wholly above the slab (vaults, towers), which cannot block the floor. */
function lowEnough(glbJson: GltfJson) {
	return (node: GltfNode) => {
		const mesh = node.mesh === undefined ? undefined : glbJson.meshes?.[node.mesh];
		if (!mesh) return false;
		return mesh.primitives.some((p) => {
			// accessor bounds (glTF requires them for POSITION)
			const accessor = glbJson.accessors?.[p.attributes.POSITION as number] as { min?: number[] } | undefined;
			const min = accessor?.min;
			return !min || (min[1] as number) <= SLAB[1];
		});
	};
}

async function debugPng(file: string, r: FloorRaster, mesh: NavMesh, city: LandmarksData) {
	const { default: sharp } = await import("sharp");
	const px = new Uint8Array(W * H * 3);
	for (let j = 0; j < H; j++)
		for (let i = 0; i < W; i++) {
			const k = j * W + i;
			const x = X0 + (i + 0.5) * RES;
			const z = Z0 + (j + 0.5) * RES;
			// north up in the picture: +Z (the Nativity side) at the top
			const o = ((H - 1 - j) * W + i) * 3;
			const c = mesh.isWalkable([x, z])
				? [120, 200, 120]
				: r.walk[k]
					? [230, 230, 230]
					: r.blocked[k]
						? [170, 60, 60]
						: r.floor[k]
							? [120, 120, 140]
							: [30, 30, 30];
			px.set(c, o);
		}
	for (const p of [...city.landmarks.map((l) => l.pos), city.spawn.pos]) {
		const i0 = Math.floor((p[0] - X0) / RES);
		const j0 = Math.floor((p[1] - Z0) / RES);
		for (let dj = -4; dj <= 4; dj++)
			for (let di = -4; di <= 4; di++) {
				const i = i0 + di;
				const j = j0 + dj;
				if (i >= 0 && i < W && j >= 0 && j < H) px.set([20, 20, 220], ((H - 1 - j) * W + i) * 3);
			}
	}
	await sharp(px, { raw: { width: W, height: H, channels: 3 } })
		.png()
		.toFile(file);
}

async function main(args: string[]) {
	const debugAt = args.indexOf("--debug");
	const debug = debugAt >= 0 ? args.splice(debugAt, 2)[1] : undefined;
	const [input, areaDir] = args;
	if (!input || !areaDir) {
		console.error(
			"usage: node tools/city-build/src/build-sagrada.ts <sagrada_familia.glb> <area dir> [--debug <png>]",
		);
		process.exit(2);
	}
	const started = performance.now();
	const glb = parseGlb(readFileSync(input));
	const raster = rasterise(collectTriangles(glb, lowEnough(glb.json)));
	const soup = floorSoup(raster.walk);
	const landmarksFile = join(areaDir, "landmarks.json");
	const city = JSON.parse(readFileSync(landmarksFile, "utf8")) as LandmarksData;
	const onFloor = (p: [number, number], what: string) => {
		const i = Math.floor((p[0] - X0) / RES);
		const j = Math.floor((p[1] - Z0) / RES);
		if (!raster.walk[j * W + i]) throw new Error(`${what} [${p.join(", ")}] is not on the walkable floor`);
		return 0;
	};
	city.spawn.y = onFloor(city.spawn.pos, "SPAWN");
	for (const l of city.landmarks) l.y = onFloor(l.pos, l.id);
	const { data: navmesh, rawPolygonCount } = await buildNavMesh(soup, {
		...defaultBuildOptions,
		seeds: [[city.spawn.pos[0], 0, city.spawn.pos[1]]],
		heightAt: () => 0,
	});
	const mesh = NavMesh.fromJSON(navmesh);
	if (debug) await debugPng(debug, raster, mesh, city);
	const lost = city.landmarks.filter((l) => !mesh.findPath(city.spawn.pos, l.pos));
	if (lost.length > 0)
		throw new Error(
			`landmarks not reachable from SPAWN: ${lost.map((l) => `${l.id} [${l.pos.join(", ")}]`).join("; ")}`,
		);
	const navmeshJson = `${JSON.stringify(navmesh)}\n`;
	writeFileSync(join(areaDir, "navmesh.json"), navmeshJson);
	writeFileSync(
		landmarksFile,
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
		`navmesh.json: ${navmesh.polygons.length} polygons (${rawPolygonCount} before dropping unreachable islands), ` +
			`${navmesh.vertices.length / 3} vertices, ${(Buffer.byteLength(navmeshJson) / 1024).toFixed(1)} KB, ` +
			`from ${soup.indices.length / 3} triangles`,
	);
	console.log(`done in ${Math.round(performance.now() - started)} ms`);
}

if (import.meta.main) await main(process.argv.slice(2));
