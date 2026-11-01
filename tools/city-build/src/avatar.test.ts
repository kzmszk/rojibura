import { describe, expect, test } from "vitest";
import { slimVrm } from "./avatar.ts";
import { parseGlb, readAccessor, writeGlb } from "./glb.ts";

interface Json {
	accessors: Record<string, unknown>[];
	bufferViews: { byteOffset: number; byteLength: number }[];
	buffers: { byteLength: number }[];
	images: { bufferView: number; mimeType: string }[];
	textures: { source?: number; extensions?: Record<string, { source: number }> }[];
	extensions: Record<string, unknown>;
	extensionsRequired?: string[];
}

/**
 * A VRM-shaped glb: two images (one is the meta thumbnail), and a face whose morph targets are all zeros,
 * mostly zeros, and everywhere.
 */
function vrm(): { glb: Uint8Array; zero: number[]; few: number[]; all: number[] } {
	const count = 100;
	const zero = new Array(count * 3).fill(0);
	const few = zero.map((_, i) => (i === 31 || i === 152 ? 0.5 : 0));
	const all = zero.map((_, i) => i / 1000 + 0.001);
	const views: Uint8Array[] = [
		new Uint8Array(4000).fill(7), // texture
		new Uint8Array(3000).fill(9), // thumbnail
		new Uint8Array(new Float32Array(zero.map((_, i) => i)).buffer), // POSITION
		new Uint8Array(new Float32Array(zero).buffer),
		new Uint8Array(new Float32Array(few).buffer),
		new Uint8Array(new Float32Array(all).buffer),
	];
	let offset = 0;
	const bufferViews = views.map((v) => {
		const view = { buffer: 0, byteOffset: offset, byteLength: v.byteLength };
		offset += v.byteLength;
		return view;
	});
	const bin = new Uint8Array(offset);
	for (const [i, v] of views.entries()) bin.set(v, bufferViews[i]?.byteOffset);
	const vec3 = (bufferView: number) => ({ bufferView, componentType: 5126, count, type: "VEC3" });
	const json = {
		asset: { version: "2.0" },
		images: [
			{ bufferView: 0, mimeType: "image/png" },
			{ bufferView: 1, mimeType: "image/png" },
		],
		textures: [{ source: 0 }, { source: 1 }],
		accessors: [vec3(2), vec3(3), vec3(4), vec3(5)],
		meshes: [
			{
				primitives: [
					{ attributes: { POSITION: 0 }, targets: [{ POSITION: 1 }, { POSITION: 2 }, { POSITION: 3 }] },
				],
			},
		],
		nodes: [{ name: "Face", mesh: 0 }],
		extensionsUsed: ["VRM"],
		extensions: {
			VRM: { meta: { texture: 1, title: "test" }, humanoid: { humanBones: [{ bone: "hips", node: 0 }] } },
		},
		bufferViews,
		buffers: [{ byteLength: offset }],
	};
	return { glb: writeGlb(json, bin), zero, few, all };
}

/** Reads a float VEC3 accessor, sparse or not (glb.ts's readAccessor does not do sparse). */
function floats(glb: Uint8Array, index: number): number[] {
	const g = parseGlb(glb);
	const json = g.json as unknown as Json;
	const a = json.accessors[index] as {
		bufferView?: number;
		count: number;
		sparse?: {
			count: number;
			indices: { bufferView: number; componentType: number };
			values: { bufferView: number };
		};
	};
	if (a.bufferView !== undefined) return [...readAccessor(g, index)];
	const out = new Array(a.count * 3).fill(0);
	if (!a.sparse) return out;
	const bytes = (v: number) => {
		const view = json.bufferViews[v] as { byteOffset: number; byteLength: number };
		return (g.bin as Uint8Array).slice(view.byteOffset, view.byteOffset + view.byteLength).buffer;
	};
	const indices =
		a.sparse.indices.componentType === 5123
			? new Uint16Array(bytes(a.sparse.indices.bufferView))
			: new Uint32Array(bytes(a.sparse.indices.bufferView));
	const values = new Float32Array(bytes(a.sparse.values.bufferView));
	indices.forEach((v, k) => {
		for (let c = 0; c < 3; c++) out[v * 3 + c] = values[k * 3 + c];
	});
	return out;
}

describe("slimVrm", () => {
	test("re-encodes images, keeps what the VRM extension points at, and makes zero morphs cheap", async () => {
		const input = vrm();
		const asked: number[] = [];
		const { glb, report } = await slimVrm(
			input.glb,
			async (data, maxSide) => {
				asked.push(maxSide);
				return data.slice(0, 100);
			},
			{ maxTexture: 1024, maxThumbnail: 256 },
		);
		expect(asked).toEqual([1024, 256]);
		expect(glb.byteLength).toBeLessThan(input.glb.byteLength);
		expect(report.images).toEqual({ before: 7000, after: 200, webp: 2 });
		expect(report.morphTargets).toMatchObject({ zero: 1, sparse: 1 });

		// parseGlb refuses required extensions, so read the JSON past them
		const json = JSON.parse(
			new TextDecoder().decode(glb.subarray(20, 20 + new DataView(glb.buffer).getUint32(12, true))),
		) as Json;
		expect(json.extensionsRequired).toEqual(["EXT_texture_webp"]);
		expect(json.textures).toEqual([
			{ extensions: { EXT_texture_webp: { source: 0 } } },
			{ extensions: { EXT_texture_webp: { source: 1 } } },
		]);
		expect(json.images.map((i) => i.mimeType)).toEqual(["image/webp", "image/webp"]);
		expect(json.extensions.VRM).toEqual((parseGlb(input.glb).json as unknown as Json).extensions.VRM);
		expect(json.accessors[1]).not.toHaveProperty("bufferView");
		expect(json.accessors[2]).toHaveProperty("sparse.count", 2);
		for (const v of json.bufferViews) expect(v.byteOffset % 4).toBe(0);
		expect(json.buffers[0]?.byteLength).toBeGreaterThan(0);

		// the same numbers come back out (written again without the required extension, which parseGlb refuses)
		const reread = writeGlb({ ...json, extensionsRequired: undefined }, parseBin(glb));
		expect(floats(reread, 0)).toEqual(input.zero.map((_, i) => i));
		expect(floats(reread, 1)).toEqual(input.zero);
		expect(floats(reread, 2)).toEqual(input.few);
		expect(floats(reread, 3).map((v) => Math.fround(v))).toEqual(input.all.map((v) => Math.fround(v)));
	});
});

/** The BIN chunk of a glb. */
function parseBin(glb: Uint8Array): Uint8Array {
	const view = new DataView(glb.buffer, glb.byteOffset);
	const jsonLength = view.getUint32(12, true);
	const binLength = view.getUint32(20 + jsonLength, true);
	return glb.slice(28 + jsonLength, 28 + jsonLength + binLength);
}
