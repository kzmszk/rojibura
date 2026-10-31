// Checks a model for building in the city and works out how it changes where people can walk
// (docs/prd.md 3.7). Recast runs here, at check time; the host and browsers only use the result.

import {
	assemble,
	convexHull,
	GROUND_Y,
	MODEL_LIMITS,
	type ModelNav,
	NavMesh,
	type NavMeshData,
	overlaps,
	type Piece,
	piecesOf,
	subtract,
	type Vec2,
	xz,
} from "@rojibura/nav";
import { collectTriangles, type Glb, parseGlb, sceneNodes, type TriangleSoup } from "./glb.ts";
import { buildNavMesh, defaultBuildOptions } from "./navmesh.ts";

/** Without colliders, the parts of a model below this height (m) are what blocks walking. */
const FOOT_HEIGHT = 2.0;
/** The ground Recast walks on reaches this far beyond the model (m): past the region it joins the city in. */
const GROUND_MARGIN = 2.5;

export interface ModelCheck {
	nav: ModelNav;
	triangles: number;
	/** People can walk on it. */
	walkable: boolean;
	/** Bounding box: width, height, depth (m). */
	size: [number, number, number];
	/** Default colour of the `paint*` materials. */
	color?: string;
}

const mm = (v: number) => Math.round(v * 1000) / 1000;

function isCollider(name: string | undefined): boolean {
	return (name ?? "").toLowerCase().startsWith("collider");
}

/** Linear glTF colour to "#rrggbb" (sRGB). */
function hex(rgb: readonly number[]): string {
	return `#${rgb
		.slice(0, 3)
		.map((c) => {
			const s = c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055;
			return Math.round(Math.min(1, Math.max(0, s)) * 255)
				.toString(16)
				.padStart(2, "0");
		})
		.join("")}`;
}

function paintColor(glb: Glb): string | undefined {
	const materials = (
		glb.json as { materials?: { name?: string; pbrMetallicRoughness?: { baseColorFactor?: number[] } }[] }
	).materials;
	const paint = materials?.find((m) => (m.name ?? "").toLowerCase().startsWith("paint"));
	return paint ? hex(paint.pbrMetallicRoughness?.baseColorFactor ?? [1, 1, 1]) : undefined;
}

/** Rejects what browsers or the host must not load: external files, unknown required extensions. */
function checkSelfContained(glb: Glb): void {
	const json = glb.json as { buffers?: { uri?: string }[]; images?: { uri?: string }[] };
	if (json.buffers?.some((b) => b.uri !== undefined)) throw new Error("buffers must be inside the glb");
	if (json.images?.some((i) => i.uri !== undefined)) throw new Error("textures must be embedded in the glb");
}

function points(soup: TriangleSoup, below = Number.POSITIVE_INFINITY): Vec2[] {
	const out: Vec2[] = [];
	const p = soup.positions;
	for (let i = 0; i < p.length; i += 3)
		if ((p[i + 1] as number) < below) out.push([p[i] as number, p[i + 2] as number]);
	return out;
}

/** A flat square of ground under and around the model, facing up, for Recast. */
function withGround(soup: TriangleSoup, x0: number, z0: number, x1: number, z1: number): TriangleSoup {
	const n = soup.positions.length / 3;
	const positions = new Float32Array(soup.positions.length + 12);
	positions.set(soup.positions);
	positions.set([x0, 0, z0, x0, 0, z1, x1, 0, z1, x1, 0, z0], soup.positions.length);
	const indices = new Uint32Array(soup.indices.length + 6);
	indices.set(soup.indices);
	// counter-clockwise seen from above: normals point up
	indices.set([n, n + 1, n + 2, n, n + 2, n + 3], soup.indices.length);
	return { positions, indices };
}

/** Where two walkable polygons overlap on the XZ plane (one under the other), the lower loses that part. */
function dropUnderneath(data: NavMeshData): NavMeshData {
	const height = (p: Piece) => p.reduce((s, v) => s + v[1], 0) / p.length;
	const sorted = piecesOf(data).sort((a, b) => height(b) - height(a));
	const kept: Piece[] = [];
	for (const piece of sorted) {
		let parts = [piece];
		for (const upper of kept) {
			const top = xz(upper);
			parts = parts.flatMap((q) => (overlaps(xz(q), top, 1e-3) ? subtract(q, top) : [q]));
		}
		kept.push(...parts);
	}
	return assemble(kept);
}

export async function checkModel(bytes: Uint8Array): Promise<ModelCheck> {
	if (bytes.byteLength > MODEL_LIMITS.bytes)
		throw new Error(
			`too large: ${(bytes.byteLength / 1048576).toFixed(1)} MB (at most ${MODEL_LIMITS.bytes / 1048576} MB)`,
		);
	const glb = parseGlb(bytes);
	checkSelfContained(glb);
	const soup = collectTriangles(glb);
	const triangles = soup.indices.length / 3;
	if (triangles === 0) throw new Error("the model has no triangles");
	if (triangles > MODEL_LIMITS.triangles)
		throw new Error(`too many triangles: ${triangles} (at most ${MODEL_LIMITS.triangles})`);

	const min = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
	const max = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY];
	for (let i = 0; i < soup.positions.length; i++) {
		const c = i % 3;
		min[c] = Math.min(min[c] as number, soup.positions[i] as number);
		max[c] = Math.max(max[c] as number, soup.positions[i] as number);
	}
	const size = [0, 1, 2].map((c) => mm((max[c] as number) - (min[c] as number))) as [number, number, number];
	MODEL_LIMITS.extent.forEach((limit, c) => {
		if ((size[c] as number) > limit)
			throw new Error(`too big: ${size.join(" x ")} m (at most ${MODEL_LIMITS.extent.join(" x ")} m)`);
	});
	const [x0, y0, z0] = min as [number, number, number];
	const [x1, , z1] = max as [number, number, number];
	if (y0 < -0.5 || y0 > 0.3)
		throw new Error(
			`the base should be on the ground (z = 0 in Blender), but the lowest point is at ${mm(y0)} m`,
		);
	if (Math.max(Math.abs(x0), Math.abs(x1), Math.abs(z0), Math.abs(z1)) > MODEL_LIMITS.extent[0] / 2)
		throw new Error("the origin should be at the centre of the model's base");

	// what blocks walking: colliders, or else everything near the ground
	const colliders = sceneNodes(glb)
		.filter(({ node }) => node.mesh !== undefined && isCollider(node.name))
		.map(({ node }) => convexHull(points(collectTriangles(glb, (n) => n === node))))
		.filter((h) => h.length >= 3);
	const low = points(soup, FOOT_HEIGHT);
	const footprint = colliders.length > 0 ? colliders : [convexHull(low.length >= 3 ? low : points(soup))];

	// where people can walk on it: Recast over the model standing on a ground plane
	const gx0 = x0 - GROUND_MARGIN;
	const gz0 = z0 - GROUND_MARGIN;
	const { data } = await buildNavMesh(withGround(soup, gx0, gz0, x1 + GROUND_MARGIN, z1 + GROUND_MARGIN), {
		...defaultBuildOptions,
		seeds: [[gx0 + 0.6, 0, gz0 + 0.6]],
	});
	const walkable = data.vertices.some((v, i) => i % 3 === 1 && v >= GROUND_Y);
	const nav: ModelNav = {
		version: 1,
		min: min.map(mm) as [number, number, number],
		max: max.map(mm) as [number, number, number],
		footprint: footprint.map((part) => part.map(([x, z]): Vec2 => [mm(x), mm(z)])),
	};
	if (walkable) {
		const walk = dropUnderneath(data);
		if (walk.polygons.length > MODEL_LIMITS.navPolygons)
			throw new Error(
				`the walkable surface is too complex: ${walk.polygons.length} polygons (at most ${MODEL_LIMITS.navPolygons})`,
			);
		NavMesh.fromJSON(walk); // throws if it is malformed
		nav.walk = walk;
		// a walkable model claims all of its ground: nothing else may stand inside it
		nav.footprint = [convexHull(points(soup)).map(([x, z]): Vec2 => [mm(x), mm(z)])];
	}
	const check: ModelCheck = { nav, triangles, walkable, size };
	const color = paintColor(glb);
	if (color) check.color = color;
	return check;
}
