// Avatars shipped with the city (docs/prd.md 3.4.1, 3.4.4): slim a VRM to the budget without touching what
// the VRM extension points at, and cut the motions everyone shares out of Saki's glb.
//
// Both only rewrite buffers and the JSON that points into them. Node, mesh, material and texture indices stay
// as they are (except for the nodes `extractMotions` drops), because the VRM extension refers to them by index.

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

interface Node {
	name?: string;
	children?: number[];
	matrix?: number[];
	translation?: number[];
	rotation?: number[];
	scale?: number[];
	[key: string]: unknown;
}

interface Animation {
	name?: string;
	channels: { sampler: number; target: { node?: number; path: string } }[];
	samplers: { input: number; output: number; interpolation?: string }[];
}

interface Json {
	accessors?: Accessor[];
	bufferViews?: BufferView[];
	buffers?: { byteLength: number }[];
	images?: { bufferView?: number; mimeType?: string; name?: string }[];
	textures?: Texture[];
	meshes?: { primitives: { targets?: Record<string, number>[] }[] }[];
	nodes?: Node[];
	scene?: number;
	scenes?: { nodes?: number[] }[];
	animations?: Animation[];
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

/** Saki's bones (assets/avatars/saki.glb), by the VRM humanoid bone each one plays. */
export const SAKI_BONES: Record<string, string> = {
	hips: "hips",
	spine: "spine",
	chest: "chest",
	neck: "neck",
	head: "head",
	"shoulder.L": "leftShoulder",
	"upperarm.L": "leftUpperArm",
	"forearm.L": "leftLowerArm",
	"hand.L": "leftHand",
	"shoulder.R": "rightShoulder",
	"upperarm.R": "rightUpperArm",
	"forearm.R": "rightLowerArm",
	"hand.R": "rightHand",
	"thigh.L": "leftUpperLeg",
	"shin.L": "leftLowerLeg",
	"foot.L": "leftFoot",
	"thigh.R": "rightUpperLeg",
	"shin.R": "rightLowerLeg",
	"foot.R": "rightFoot",
};

/**
 * Cuts the humanoid motions out of a glb: the bones in `bones` (renamed to their VRM humanoid names) and
 * their ancestors, and only the `clips` named. Meshes, skins and textures are dropped. Mapped bones keep
 * their rotation tracks, the hips their translation, and the ancestors (the armature) every track.
 */
export function extractMotions(
	input: Uint8Array,
	bones: Record<string, string>,
	clips: string[],
): Uint8Array {
	const glb = parseGlb(input);
	const json = glb.json as unknown as Json;
	const nodes = json.nodes ?? [];
	const parent = new Map<number, number>();
	nodes.forEach((n, i) => {
		for (const c of n.children ?? []) parent.set(c, i);
	});
	const humanoid = new Map<number, string>();
	const keep = new Set<number>();
	nodes.forEach((n, i) => {
		const bone = n.name === undefined ? undefined : bones[n.name];
		if (!bone) return;
		humanoid.set(i, bone);
		for (let at: number | undefined = i; at !== undefined && !keep.has(at); at = parent.get(at)) keep.add(at);
	});
	const missing = Object.keys(bones).filter((name) => !nodes.some((n) => n.name === name));
	if (missing.length) throw new Error(`bones not found: ${missing.join(", ")}`);

	const nodeIndex = new Map<number, number>();
	const outNodes: Node[] = [];
	nodes.forEach((n, i) => {
		if (!keep.has(i)) return;
		nodeIndex.set(i, outNodes.length);
		const out: Node = { name: humanoid.get(i) ?? n.name };
		for (const key of ["matrix", "translation", "rotation", "scale"] as const) if (n[key]) out[key] = n[key];
		outNodes.push(out);
	});
	nodes.forEach((n, i) => {
		const out = nodeIndex.has(i) ? outNodes[nodeIndex.get(i) as number] : undefined;
		const children = (n.children ?? []).filter((c) => keep.has(c)).map((c) => nodeIndex.get(c) as number);
		if (out && children.length) out.children = children;
	});

	const accessors: Accessor[] = [];
	const views: Uint8Array[] = [];
	const bufferViews: BufferView[] = [];
	const accessorIndex = new Map<number, number>();
	const copyAccessor = (index: number): number => {
		const known = accessorIndex.get(index);
		if (known !== undefined) return known;
		const a = json.accessors?.[index];
		if (!a || a.bufferView === undefined || a.sparse) throw new Error(`accessor ${index} cannot be copied`);
		const view = json.bufferViews?.[a.bufferView];
		const width = readAccessor(glb, index).length / a.count;
		if (view?.byteStride && view.byteStride !== width * 4)
			throw new Error(`accessor ${index} is interleaved`);
		const start = a.byteOffset ?? 0;
		views.push(viewBytes(glb, json, a.bufferView).subarray(start, start + a.count * width * 4));
		bufferViews.push({ buffer: 0, byteLength: 0 });
		const { byteOffset: _, ...rest } = a;
		accessors.push({ ...rest, bufferView: bufferViews.length - 1 });
		accessorIndex.set(index, accessors.length - 1);
		return accessors.length - 1;
	};

	const animations: Animation[] = [];
	for (const name of clips) {
		const animation = json.animations?.find((a) => a.name === name);
		if (!animation) throw new Error(`clip not found: ${name}`);
		const out: Animation = { name, channels: [], samplers: [] };
		const samplerIndex = new Map<number, number>();
		for (const channel of animation.channels) {
			const node = channel.target.node;
			if (node === undefined || !keep.has(node)) continue;
			const bone = humanoid.get(node);
			const path = channel.target.path;
			if (bone && path !== "rotation" && !(bone === "hips" && path === "translation")) continue;
			let sampler = samplerIndex.get(channel.sampler);
			if (sampler === undefined) {
				const s = animation.samplers[channel.sampler];
				if (!s) throw new Error(`clip ${name} has no sampler ${channel.sampler}`);
				sampler = out.samplers.length;
				out.samplers.push({
					input: copyAccessor(s.input),
					output: copyAccessor(s.output),
					...(s.interpolation ? { interpolation: s.interpolation } : {}),
				});
				samplerIndex.set(channel.sampler, sampler);
			}
			out.channels.push({ sampler, target: { node: nodeIndex.get(node) as number, path } });
		}
		animations.push(out);
	}

	const roots = (json.scenes?.[json.scene ?? 0]?.nodes ?? []).filter((n) => keep.has(n));
	const out: Json = {
		asset: { version: "2.0", generator: "rojibura tools/city-build/src/avatar.ts" },
		scene: 0,
		scenes: [{ nodes: roots.map((n) => nodeIndex.get(n) as number) }],
		nodes: outNodes,
		animations,
		accessors,
		bufferViews,
	};
	return writeGlb(out, pack(out, views));
}
