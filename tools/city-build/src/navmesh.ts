import { init } from "@recast-navigation/core";
import { generateSoloNavMesh } from "@recast-navigation/generators";
import type { NavMeshData } from "@rojibura/nav";
import type { TriangleSoup } from "./glb.ts";

export interface AgentParams {
	/** Metres. */
	radius: number;
	/** Metres. */
	height: number;
	/** Highest step the agent can walk up (metres). */
	maxClimb: number;
	/** Degrees. */
	maxSlope: number;
}

export interface NavMeshBuildOptions {
	agent: AgentParams;
	/** Voxel size on XZ (metres). The agent radius is rounded up to a multiple of it. */
	cellSize: number;
	/** Voxel size on Y (metres). The climb is rounded down and the height up to multiples of it. */
	cellHeight: number;
	/**
	 * Points (x, y, z) on the walkable area that matter, typically the spawn point. Only polygons connected
	 * to one of them are kept, which drops roofs, the top of the fountain and other unreachable islands.
	 */
	seeds: [number, number, number][];
}

export const defaultBuildOptions: Omit<NavMeshBuildOptions, "seeds"> = {
	agent: { radius: 0.3, height: 1.8, maxClimb: 0.2, maxSlope: 45 },
	cellSize: 0.15,
	cellHeight: 0.05,
};

export interface NavMeshBuildResult {
	data: NavMeshData;
	/** Polygons Recast produced before unreachable islands were dropped. */
	rawPolygonCount: number;
}

const DT_EXT_LINK = 0x8000;

let initialised: Promise<void> | undefined;

/** Voxelises the triangles with Recast and converts the resulting Detour tile to navmesh.json. */
export async function buildNavMesh(
	soup: TriangleSoup,
	options: NavMeshBuildOptions,
): Promise<NavMeshBuildResult> {
	initialised ??= init();
	await initialised;
	const { agent, cellSize: cs, cellHeight: ch } = options;
	const result = generateSoloNavMesh(soup.positions, soup.indices, {
		cs,
		ch,
		walkableSlopeAngle: agent.maxSlope,
		walkableHeight: Math.ceil(agent.height / ch),
		walkableClimb: Math.floor(agent.maxClimb / ch + 1e-6),
		walkableRadius: Math.ceil(agent.radius / cs - 1e-6),
		maxEdgeLen: Math.round(12 / cs), // 12 m
		maxSimplificationError: 1.3, // voxels
		// The generator squares these two ("size" in voxels, as in RecastDemo): 64 and 400 voxels of area.
		// Small islands are dropped anyway by keepReachable().
		minRegionArea: 8,
		mergeRegionArea: 20,
		maxVertsPerPoly: 6,
		// The detail mesh is not exported (heights come from the polygon vertices). These are the library
		// defaults (multiplied by cs and ch by the generator); some smaller values crash the 0.43.1 Wasm build
		// with "memory access out of bounds".
		detailSampleDist: 6,
		detailSampleMaxError: 1,
	});
	if (!result.success) throw new Error(`recast failed: ${result.error}`);
	const { navMesh } = result;
	try {
		const tile = navMesh.getTile(0);
		const header = tile.header();
		if (!header) throw new Error("recast produced an empty navmesh");
		const polyCount = header.polyCount();
		const vertCount = header.vertCount();
		const verts: number[] = [];
		for (let i = 0; i < vertCount * 3; i++) verts.push(tile.verts(i));
		snapHeights(verts, soup, ch, agent.maxClimb);
		const polys: { verts: number[]; neighbors: number[] }[] = [];
		for (let p = 0; p < polyCount; p++) {
			const poly = tile.polys(p);
			if (poly.getType() !== 0) throw new Error("off-mesh connections are not supported");
			const n = poly.vertCount();
			const pv: number[] = [];
			const pn: number[] = [];
			for (let j = 0; j < n; j++) {
				pv.push(poly.verts(j));
				const nei = poly.neis(j);
				if (nei & DT_EXT_LINK) throw new Error("unexpected tile link in a solo navmesh");
				pn.push(nei === 0 ? -1 : nei - 1);
			}
			polys.push({ verts: pv, neighbors: pn });
		}
		return { data: keepReachable(verts, polys, options.seeds), rawPolygonCount: polyCount };
	} finally {
		navMesh.destroy();
	}
}

/**
 * Recast puts polygon vertices at the top of the voxel column, up to one cell height above the floor
 * (and on stairs sometimes at the height of the neighbouring step). Moves each vertex down onto the
 * highest input surface below it within that band, or half a cell down if there is none.
 */
function snapHeights(verts: number[], soup: TriangleSoup, ch: number, climb: number) {
	const { positions: P, indices: I } = soup;
	const EPS = 1e-6;
	for (let v = 0; v < verts.length; v += 3) {
		const x = verts[v] as number;
		const top = verts[v + 1] as number;
		const z = verts[v + 2] as number;
		let best = Number.NEGATIVE_INFINITY;
		for (let t = 0; t < I.length; t += 3) {
			const a = (I[t] as number) * 3;
			const b = (I[t + 1] as number) * 3;
			const c = (I[t + 2] as number) * 3;
			const ax = P[a] as number;
			const az = P[a + 2] as number;
			const bx = (P[b] as number) - ax;
			const bz = (P[b + 2] as number) - az;
			const cx = (P[c] as number) - ax;
			const cz = (P[c + 2] as number) - az;
			const det = bx * cz - bz * cx;
			if (Math.abs(det) < 1e-9) continue; // vertical
			const px = x - ax;
			const pz = z - az;
			const u = (px * cz - pz * cx) / det;
			const w = (bx * pz - bz * px) / det;
			if (u < -EPS || w < -EPS || u + w > 1 + EPS) continue;
			const y = (P[a + 1] as number) * (1 - u - w) + (P[b + 1] as number) * u + (P[c + 1] as number) * w;
			if (y <= top + 1e-3 && y >= top - ch - climb - 1e-3 && y > best) best = y;
		}
		verts[v + 1] = best > Number.NEGATIVE_INFINITY ? best : top - ch / 2;
	}
}

/** Drops polygons that are not connected to a seed, then the unused vertices; rounds to the millimetre. */
function keepReachable(
	verts: number[],
	polys: { verts: number[]; neighbors: number[] }[],
	seeds: [number, number, number][],
): NavMeshData {
	const keep = new Uint8Array(polys.length);
	const stack: number[] = [];
	for (const seed of seeds) {
		const p = polygonUnder(verts, polys, seed);
		if (p < 0) throw new Error(`seed (${seed.join(", ")}) is not on the navmesh`);
		stack.push(p);
	}
	while (stack.length > 0) {
		const p = stack.pop() as number;
		if (keep[p]) continue;
		keep[p] = 1;
		for (const n of (polys[p] as { neighbors: number[] }).neighbors) if (n >= 0 && !keep[n]) stack.push(n);
	}
	const polyIndex = new Int32Array(polys.length).fill(-1);
	const vertIndex = new Int32Array(verts.length / 3).fill(-1);
	const vertices: number[] = [];
	const polygons: { verts: number[]; neighbors: number[] }[] = [];
	polys.forEach((_, p) => {
		if (keep[p]) polyIndex[p] = polygons.push({ verts: [], neighbors: [] }) - 1;
	});
	const round = (v: number) => Math.round(v * 1000) / 1000;
	polys.forEach((poly, p) => {
		const out = polygons[polyIndex[p] as number];
		if (!out) return;
		for (let j = 0; j < poly.verts.length; j++) {
			const v = poly.verts[j] as number;
			if (vertIndex[v] === -1) {
				vertIndex[v] = vertices.length / 3;
				vertices.push(
					round(verts[v * 3] as number),
					round(verts[v * 3 + 1] as number),
					round(verts[v * 3 + 2] as number),
				);
			}
			out.verts.push(vertIndex[v] as number);
			const n = poly.neighbors[j] as number;
			out.neighbors.push(n < 0 ? -1 : (polyIndex[n] as number));
		}
	});
	return { version: 1, vertices, polygons };
}

/** The polygon whose XZ footprint contains the point and whose surface is nearest in height, or -1. */
function polygonUnder(
	verts: number[],
	polys: { verts: number[] }[],
	[x, y, z]: [number, number, number],
): number {
	let best = -1;
	let bestDy = Number.POSITIVE_INFINITY;
	polys.forEach((poly, p) => {
		const n = poly.verts.length;
		let sign = 0;
		let height = 0;
		for (let j = 0; j < n; j++) {
			const a = (poly.verts[j] as number) * 3;
			const b = (poly.verts[(j + 1) % n] as number) * 3;
			const ax = verts[a] as number;
			const az = verts[a + 2] as number;
			const c = ((verts[b] as number) - ax) * (z - az) - ((verts[b + 2] as number) - az) * (x - ax);
			if (c !== 0) {
				if (sign !== 0 && Math.sign(c) !== sign) return;
				sign = Math.sign(c);
			}
			height += (verts[a + 1] as number) / n;
		}
		const dy = Math.abs(height - y);
		if (dy < bestDy) {
			bestDy = dy;
			best = p;
		}
	});
	return best;
}
