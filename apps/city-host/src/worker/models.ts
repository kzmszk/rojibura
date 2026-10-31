// Registered models (free play, docs/prd.md 3.7): what the host checks before it stores and serves one.
// The model CLI (tools/city-build) runs Recast and sends the result; the host does not run Recast, it only
// checks that the glb is self-contained and that the navmesh data is sane and fits the model.

import {
	convexHull,
	MODEL_LIMITS,
	type ModelNav,
	NavMesh,
	type NavMeshData,
	overlaps,
	type Piece,
	piecesOf,
	xz,
} from "@rojibura/nav";
import { type ModelId, sanitizeText, textLength, type Vec2 } from "@rojibura/protocol";

const GLB_MAGIC = 0x46546c67;
const CHUNK_JSON = 0x4e4f534a;

/** "m_" + the first 16 hex digits of the glb's SHA-256: the same file is the same model. */
export async function modelIdOf(glb: Uint8Array<ArrayBuffer>): Promise<ModelId> {
	const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", glb));
	return `m_${[...hash.slice(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

export function cleanModelName(v: unknown): string | null {
	if (typeof v !== "string") return null;
	const s = sanitizeText(v);
	return s && textLength(s) <= MODEL_LIMITS.nameLength ? s : null;
}

interface GltfJson {
	buffers?: { uri?: string }[];
	images?: { uri?: string }[];
	extensionsRequired?: string[];
	materials?: { name?: string; pbrMetallicRoughness?: { baseColorFactor?: number[] } }[];
}

/** The glb's JSON, if it is a glb browsers can load without fetching anything else. */
export function glbJson(glb: Uint8Array): GltfJson | string {
	if (glb.byteLength > MODEL_LIMITS.bytes) return "the model is too large";
	const view = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
	if (glb.byteLength < 20 || view.getUint32(0, true) !== GLB_MAGIC || view.getUint32(4, true) !== 2)
		return "not a glb (glTF 2.0 binary)";
	const length = view.getUint32(12, true);
	if (view.getUint32(16, true) !== CHUNK_JSON || 20 + length > glb.byteLength)
		return "the glb has no JSON chunk";
	let json: GltfJson;
	try {
		json = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + length))) as GltfJson;
	} catch {
		return "the glb's JSON is broken";
	}
	if (json.buffers?.some((b) => b.uri !== undefined) || json.images?.some((i) => i.uri !== undefined))
		return "the glb refers to other files (embed everything)";
	if (json.extensionsRequired?.length)
		return `unsupported glTF extensions: ${json.extensionsRequired.join(", ")}`;
	return json;
}

/** Default colour of the `paint*` materials, "#rrggbb" (glTF colours are linear). */
export function paintColor(json: GltfJson): string | undefined {
	const paint = json.materials?.find((m) => (m.name ?? "").toLowerCase().startsWith("paint"));
	const rgb = paint?.pbrMetallicRoughness?.baseColorFactor;
	if (!paint) return undefined;
	return `#${(rgb ?? [1, 1, 1])
		.slice(0, 3)
		.map((c) => {
			const s = c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055;
			return Math.round(Math.min(1, Math.max(0, s)) * 255)
				.toString(16)
				.padStart(2, "0");
		})
		.join("")}`;
}

const isVec2 = (v: unknown): v is Vec2 =>
	Array.isArray(v) && v.length === 2 && v.every((n) => typeof n === "number" && Number.isFinite(n));
const isVec3 = (v: unknown): v is [number, number, number] =>
	Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === "number" && Number.isFinite(n));

/** Checks `<model>.nav.json` from the model CLI. */
export function checkModelNav(v: unknown): ModelNav | string {
	if (typeof v !== "object" || v === null) return "nav: not an object";
	const n = v as Partial<ModelNav>;
	if (n.version !== 1 || !isVec3(n.min) || !isVec3(n.max)) return "nav: bad version or bounds";
	for (let c = 0; c < 3; c++) {
		const size = (n.max[c] as number) - (n.min[c] as number);
		if (!(size >= 0 && size <= (MODEL_LIMITS.extent[c] as number))) return "nav: the model is too big";
	}
	const reach = MODEL_LIMITS.extent[0] / 2;
	const inside = (p: Vec2) => Math.abs(p[0]) <= reach && Math.abs(p[1]) <= reach;
	if (
		!Array.isArray(n.footprint) ||
		n.footprint.length === 0 ||
		n.footprint.length > 32 ||
		!n.footprint.every(
			(part) =>
				Array.isArray(part) &&
				part.length >= 3 &&
				part.length <= 64 &&
				part.every((p) => isVec2(p) && inside(p)),
		)
	)
		return "nav: bad footprint";
	const nav: ModelNav = {
		version: 1,
		min: n.min,
		max: n.max,
		// the footprint must be convex: take each part's hull
		footprint: n.footprint.map((part) => convexHull(part)),
	};
	if (nav.footprint.some((part) => part.length < 3)) return "nav: a footprint part has no area";
	if (n.walk !== undefined) {
		const walk = n.walk as NavMeshData;
		if (!Array.isArray(walk?.polygons) || walk.polygons.length > MODEL_LIMITS.navPolygons)
			return "nav: too many walkable polygons";
		try {
			NavMesh.fromJSON(walk);
		} catch (e) {
			return `nav: ${(e as Error).message}`;
		}
		const pieces = piecesOf(walk);
		const ring = reach + 5;
		if (
			pieces.some((p) =>
				p.some(
					([x, y, z]) => Math.abs(x) > ring || Math.abs(z) > ring || y < -1 || y > MODEL_LIMITS.extent[1],
				),
			)
		)
			return "nav: the walkable surface is outside the model";
		// a 2D navmesh cannot have one floor above another
		for (let i = 0; i < pieces.length; i++)
			for (let j = i + 1; j < pieces.length; j++)
				if (overlaps(xz(pieces[i] as Piece), xz(pieces[j] as Piece), 1e-3))
					return "nav: walkable surfaces overlap";
		nav.walk = walk;
	}
	return nav;
}
