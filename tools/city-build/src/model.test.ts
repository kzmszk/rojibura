import { NavMesh } from "@rojibura/nav";
import { describe, expect, test } from "vitest";
import { checkModel } from "./model.ts";

type Mesh = { name: string; positions: number[]; indices: number[] };

/** A glb with one node per mesh (glTF space: Y up). */
function glb(meshes: Mesh[], extra: Record<string, unknown> = {}): Uint8Array {
	const chunks: Uint8Array[] = [];
	const bufferViews: unknown[] = [];
	const accessors: unknown[] = [];
	let offset = 0;
	const add = (bytes: Uint8Array) => {
		bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: bytes.byteLength });
		chunks.push(bytes);
		offset += bytes.byteLength;
		return bufferViews.length - 1;
	};
	const gltfMeshes = meshes.map((m) => {
		const pos = add(new Uint8Array(new Float32Array(m.positions).buffer));
		accessors.push({ bufferView: pos, componentType: 5126, count: m.positions.length / 3, type: "VEC3" });
		const idx = add(new Uint8Array(new Uint32Array(m.indices).buffer));
		accessors.push({ bufferView: idx, componentType: 5125, count: m.indices.length, type: "SCALAR" });
		return {
			name: m.name,
			primitives: [{ attributes: { POSITION: accessors.length - 2 }, indices: accessors.length - 1 }],
		};
	});
	const bin = new Uint8Array(offset);
	let at = 0;
	for (const c of chunks) {
		bin.set(c, at);
		at += c.byteLength;
	}
	const json = {
		asset: { version: "2.0" },
		scene: 0,
		scenes: [{ nodes: meshes.map((_, i) => i) }],
		nodes: meshes.map((m, i) => ({ name: m.name, mesh: i })),
		meshes: gltfMeshes,
		accessors,
		bufferViews,
		buffers: [{ byteLength: bin.byteLength }],
		...extra,
	};
	const pad = (b: Uint8Array, fill: number) => {
		const out = new Uint8Array(Math.ceil(b.byteLength / 4) * 4).fill(fill);
		out.set(b);
		return out;
	};
	const jsonBytes = pad(new TextEncoder().encode(JSON.stringify(json)), 0x20);
	const binBytes = pad(bin, 0);
	const total = 12 + 8 + jsonBytes.byteLength + 8 + binBytes.byteLength;
	const out = new Uint8Array(total);
	const view = new DataView(out.buffer);
	view.setUint32(0, 0x46546c67, true);
	view.setUint32(4, 2, true);
	view.setUint32(8, total, true);
	view.setUint32(12, jsonBytes.byteLength, true);
	view.setUint32(16, 0x4e4f534a, true);
	out.set(jsonBytes, 20);
	view.setUint32(20 + jsonBytes.byteLength, binBytes.byteLength, true);
	view.setUint32(24 + jsonBytes.byteLength, 0x004e4942, true);
	out.set(binBytes, 28 + jsonBytes.byteLength);
	return out;
}

/** A closed box (outward faces) from (x0, y0, z0) to (x1, y1, z1). */
function box(name: string, [x0, y0, z0]: number[], [x1, y1, z1]: number[]): Mesh {
	const p = [
		[x0, y0, z0],
		[x1, y0, z0],
		[x1, y0, z1],
		[x0, y0, z1],
		[x0, y1, z0],
		[x1, y1, z0],
		[x1, y1, z1],
		[x0, y1, z1],
	].flat() as number[];
	// counter-clockwise seen from outside
	const quads = [
		[0, 1, 2, 3], // bottom (faces down)
		[4, 7, 6, 5], // top (faces up)
		[0, 4, 5, 1],
		[1, 5, 6, 2],
		[2, 6, 7, 3],
		[3, 7, 4, 0],
	];
	return { name, positions: p, indices: quads.flatMap(([a, b, c, d]) => [a, b, c, a, c, d] as number[]) };
}

/** A slope from (x0..x1, y = 0, z = z0) up to y = h at z = z1, closed underneath. */
function ramp(name: string, x0: number, x1: number, z0: number, z1: number, h: number): Mesh {
	const p = [
		[x0, 0, z0],
		[x1, 0, z0],
		[x1, 0, z1],
		[x0, 0, z1],
		[x1, h, z1],
		[x0, h, z1],
	].flat() as number[];
	const faces = [
		[0, 5, 4],
		[0, 4, 1], // slope (up)
		[0, 1, 2],
		[0, 2, 3], // bottom
		[3, 2, 4],
		[3, 4, 5], // back
		[0, 3, 5], // side
		[1, 4, 2], // side
	];
	return { name, positions: p, indices: faces.flat() };
}

describe("checkModel", () => {
	test("a box is an obstacle whose footprint is its base", async () => {
		const r = await checkModel(glb([box("body", [-1, 0, -1], [1, 2, 1])]));
		expect(r.walkable).toBe(false);
		expect(r.size).toEqual([2, 2, 2]);
		expect(r.nav.walk).toBeUndefined();
		const [part] = r.nav.footprint as [[number, number][]];
		expect(part).toHaveLength(4);
		for (const [x, z] of part) expect([Math.abs(x), Math.abs(z)]).toEqual([1, 1]);
	});

	test("colliders replace the automatic footprint", async () => {
		const r = await checkModel(
			glb([
				box("crown", [-2, 2.5, -2], [2, 4, 2]),
				box("trunk", [-0.1, 0, -0.1], [0.1, 2.5, 0.1]),
				box("collider_trunk", [-0.3, 0, -0.3], [0.3, 2, 0.3]),
			]),
		);
		const [part] = r.nav.footprint as [[number, number][]];
		for (const [x, z] of part) expect([Math.abs(x), Math.abs(z)]).toEqual([0.3, 0.3]);
	});

	test("a platform with a ramp is walkable, up to its top", async () => {
		// a 0.6 m platform on z 0..3, and a slope up to it from z = -4
		const r = await checkModel(
			glb([box("top", [-1.5, 0, 0], [1.5, 0.6, 3]), ramp("ramp", -1, 1, -4, 0, 0.6)]),
		);
		expect(r.walkable).toBe(true);
		const walk = NavMesh.fromJSON(r.nav.walk as NonNullable<typeof r.nav.walk>);
		expect(walk.isWalkable([0, 1.5])).toBe(true);
		expect(walk.heightAt([0, 1.5])).toBeGreaterThan(0.4);
		// reachable from the ground around it, and its footprint is the whole model
		expect(walk.findPath([3.5, -6], [0, 1.5])).not.toBeNull();
		const xs = (r.nav.footprint[0] as [number, number][]).map((p) => p[1]);
		expect(Math.min(...xs)).toBeCloseTo(-4, 3);
	});

	test("refuses external files and models off the ground", async () => {
		await expect(
			checkModel(glb([box("b", [-1, 0, -1], [1, 1, 1])], { images: [{ uri: "https://example.com/x.png" }] })),
		).rejects.toThrow(/embedded/);
		await expect(checkModel(glb([box("b", [-1, 3, -1], [1, 4, 1])]))).rejects.toThrow(/ground/);
		await expect(checkModel(new TextEncoder().encode("not a model"))).rejects.toThrow(/glb/);
	});
});
