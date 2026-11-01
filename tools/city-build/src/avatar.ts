// Avatars shipped with the city (docs/prd.md 3.4.1, 3.4.4): slim a VRM to the budget without touching what
// the VRM extension points at. Only buffers and the JSON that points into them are rewritten: node, mesh,
// material and texture indices stay as they are, because the VRM extension refers to them by index.

import { type Glb, parseGlb, readAccessor, writeGlb } from "./glb.ts";

interface Accessor {
	bufferView?: number;
	byteOffset?: number;
	componentType: number;
	normalized?: boolean;
	count: number;
	type: string;
	sparse?: {
		count: number;
		indices: { bufferView: number; byteOffset?: number; componentType: number };
		values: { bufferView: number; byteOffset?: number };
	};
	[key: string]: unknown;
}

interface BufferView {
	buffer: number;
	byteOffset?: number;
	byteLength: number;
	byteStride?: number;
	[key: string]: unknown;
}

interface Texture {
	source?: number;
	extensions?: Record<string, unknown>;
	[key: string]: unknown;
}

interface Json {
	accessors?: Accessor[];
	bufferViews?: BufferView[];
	buffers?: { byteLength: number }[];
	images?: { bufferView?: number; mimeType?: string; name?: string }[];
	textures?: Texture[];
	meshes?: { primitives: { targets?: Record<string, number>[] }[] }[];
	extensions?: Record<string, unknown>;
	extensionsUsed?: string[];
	extensionsRequired?: string[];
	[key: string]: unknown;
}

const FLOAT = 5126;
const UNSIGNED_SHORT = 5123;
const UNSIGNED_INT = 5125;
const WEBP = "EXT_texture_webp";
const align4 = (n: number) => (n + 3) & ~3;

/** The bytes of one bufferView of a parsed glb. */
function viewBytes(glb: Glb, json: Json, index: number): Uint8Array {
	const view = json.bufferViews?.[index];
	if (view?.buffer !== 0 || !glb.bin) throw new Error(`bufferView ${index} is not in the BIN chunk`);
	const start = view.byteOffset ?? 0;
	return glb.bin.subarray(start, start + view.byteLength);
}

/**
 * Drops bufferViews nothing points at any more and lays the rest out as one BIN chunk.
 * `views[i]` holds the bytes of bufferView i (replaced or kept).
 */
function pack(json: Json, views: Uint8Array[]): Uint8Array {
	const used = new Set<number>();
	for (const a of json.accessors ?? []) {
		if (a.bufferView !== undefined) used.add(a.bufferView);
		if (a.sparse) used.add(a.sparse.indices.bufferView).add(a.sparse.values.bufferView);
	}
	for (const image of json.images ?? []) if (image.bufferView !== undefined) used.add(image.bufferView);
	const remap = new Map<number, number>();
	const bufferViews: BufferView[] = [];
	const parts: Uint8Array[] = [];
	let size = 0;
	(json.bufferViews ?? []).forEach((view, i) => {
		const bytes = views[i];
		if (!used.has(i) || !bytes) return;
		remap.set(i, bufferViews.length);
		bufferViews.push({ ...view, buffer: 0, byteOffset: size, byteLength: bytes.byteLength });
		parts.push(bytes);
		size += align4(bytes.byteLength);
	});
	const at = (i: number) => remap.get(i) as number;
	for (const a of json.accessors ?? []) {
		if (a.bufferView !== undefined) a.bufferView = at(a.bufferView);
		if (a.sparse) {
			a.sparse.indices.bufferView = at(a.sparse.indices.bufferView);
			a.sparse.values.bufferView = at(a.sparse.values.bufferView);
		}
	}
	for (const image of json.images ?? [])
		if (image.bufferView !== undefined) image.bufferView = at(image.bufferView);
	const bin = new Uint8Array(size);
	for (const [i, view] of bufferViews.entries()) bin.set(parts[i] as Uint8Array, view.byteOffset);
	json.bufferViews = bufferViews;
	json.buffers = size ? [{ byteLength: size }] : [];
	return bin;
}

/** Re-encodes an image as WebP whose longest side is at most `maxSide`. */
export type EncodeWebp = (data: Uint8Array, maxSide: number) => Promise<Uint8Array>;

export interface SlimOptions {
	/** Longest side of a texture. */
	maxTexture: number;
	/** Longest side of the VRM's own thumbnail (meta), which the city does not draw. */
	maxThumbnail: number;
}

export interface SlimReport {
	bytes: { before: number; after: number };
	images: { before: number; after: number; webp: number };
	morphTargets: { before: number; after: number; zero: number; sparse: number };
}

/** Index of the VRM's thumbnail image (VRM 0.x meta.texture is a texture, VRM 1.0 meta.thumbnailImage an image). */
function thumbnailImage(json: Json): number | undefined {
	const v0 = (json.extensions?.VRM as { meta?: { texture?: number } } | undefined)?.meta?.texture;
	if (v0 !== undefined && v0 >= 0) return json.textures?.[v0]?.source;
	return (json.extensions?.VRMC_vrm as { meta?: { thumbnailImage?: number } } | undefined)?.meta
		?.thumbnailImage;
}

/**
 * Makes a VRM smaller for the city:
 * - textures become WebP (EXT_texture_webp, which three.js reads) no larger than `maxTexture`,
 * - morph targets that are all zeros lose their data (an accessor without a bufferView is zeros by spec),
 *   and mostly-zero ones become sparse accessors. VRoid faces are like this: one vertex buffer for the
 *   whole face, so each expression moves a small part of it.
 */
export async function slimVrm(
	input: Uint8Array,
	encode: EncodeWebp,
	options: SlimOptions,
): Promise<{ glb: Uint8Array; report: SlimReport }> {
	const glb = parseGlb(input);
	const json = glb.json as unknown as Json;
	const views = (json.bufferViews ?? []).map((_, i) => viewBytes(glb, json, i));
	const report: SlimReport = {
		bytes: { before: input.byteLength, after: 0 },
		images: { before: 0, after: 0, webp: 0 },
		morphTargets: { before: 0, after: 0, zero: 0, sparse: 0 },
	};

	const thumb = thumbnailImage(json);
	const webp = new Set<number>();
	for (const [i, image] of (json.images ?? []).entries()) {
		if (image.bufferView === undefined) continue;
		const bytes = views[image.bufferView] as Uint8Array;
		report.images.before += bytes.byteLength;
		// placeholders (VRoid's 8x8 "Shader_None..." images) are smaller as they are
		if (bytes.byteLength > 1024) {
			const out = await encode(bytes, i === thumb ? options.maxThumbnail : options.maxTexture);
			if (out.byteLength < bytes.byteLength) {
				views[image.bufferView] = out;
				image.mimeType = "image/webp";
				webp.add(i);
				report.images.webp++;
			}
		}
		report.images.after += (views[image.bufferView] as Uint8Array).byteLength;
	}
	if (webp.size) {
		for (const texture of json.textures ?? []) {
			if (texture.source === undefined || !webp.has(texture.source)) continue;
			texture.extensions = { ...texture.extensions, [WEBP]: { source: texture.source } };
			delete texture.source;
		}
		json.extensionsUsed = [...new Set([...(json.extensionsUsed ?? []), WEBP])];
		json.extensionsRequired = [...new Set([...(json.extensionsRequired ?? []), WEBP])];
	}

	const targets = new Set<number>();
	for (const mesh of json.meshes ?? []) {
		for (const primitive of mesh.primitives) {
			for (const target of primitive.targets ?? []) for (const a of Object.values(target)) targets.add(a);
		}
	}
	for (const index of [...targets].sort((a, b) => a - b)) {
		const accessor = json.accessors?.[index];
		if (!accessor || accessor.bufferView === undefined || accessor.sparse) continue;
		if (accessor.componentType !== FLOAT || accessor.type !== "VEC3" || accessor.normalized) continue;
		const values = readAccessor(glb, index);
		const moved: number[] = [];
		for (let v = 0; v < accessor.count; v++) {
			if (values[v * 3] !== 0 || values[v * 3 + 1] !== 0 || values[v * 3 + 2] !== 0) moved.push(v);
		}
		const dense = accessor.count * 12;
		report.morphTargets.before += dense;
		const wide = accessor.count > 0xffff;
		const sparseBytes = moved.length * ((wide ? 4 : 2) + 12);
		if (moved.length === 0) {
			report.morphTargets.zero++;
		} else if (sparseBytes < dense * 0.75) {
			const indices = wide ? Uint32Array.from(moved) : Uint16Array.from(moved);
			const data = new Float32Array(moved.length * 3);
			for (const [k, v] of moved.entries()) data.set(values.subarray(v * 3, v * 3 + 3), k * 3);
			accessor.sparse = {
				count: moved.length,
				indices: { bufferView: views.length, componentType: wide ? UNSIGNED_INT : UNSIGNED_SHORT },
				values: { bufferView: views.length + 1 },
			};
			json.bufferViews?.push(
				{ buffer: 0, byteLength: indices.byteLength },
				{ buffer: 0, byteLength: data.byteLength },
			);
			views.push(new Uint8Array(indices.buffer), new Uint8Array(data.buffer));
			report.morphTargets.sparse++;
			report.morphTargets.after += indices.byteLength + data.byteLength;
		} else {
			report.morphTargets.after += dense;
			continue;
		}
		delete accessor.bufferView;
		delete accessor.byteOffset;
	}

	const out = writeGlb(json, pack(json, views));
	report.bytes.after = out.byteLength;
	return { glb: out, report };
}
