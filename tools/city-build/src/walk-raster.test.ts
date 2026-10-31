import { deflateSync } from "node:zlib";
import { NavMesh } from "@rojibura/nav";
import { expect, test } from "vitest";
import { buildNavMesh, defaultBuildOptions } from "./navmesh.ts";
import { readPng } from "./png.ts";
import { heightOfCode, WalkRaster } from "./walk-raster.ts";

/** An RGB PNG of `rows` (one [r, g, b] per pixel), each scanline with the given filter type. */
function png(rows: number[][][], filters: number[]): Uint8Array {
	const width = (rows[0] as number[][]).length;
	const stride = width * 3;
	const flat = rows.map((r) => r.flat());
	const raw: number[] = [];
	flat.forEach((line, y) => {
		const f = filters[y % filters.length] as number;
		raw.push(f);
		for (let x = 0; x < stride; x++) {
			const a = x >= 3 ? (line[x - 3] as number) : 0;
			const b = y > 0 ? ((flat[y - 1] as number[])[x] as number) : 0;
			const c = x >= 3 && y > 0 ? ((flat[y - 1] as number[])[x - 3] as number) : 0;
			const pa = Math.abs(b - c);
			const pb = Math.abs(a - c);
			const pc = Math.abs(a + b - 2 * c);
			const paeth = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
			const predict = [0, a, b, (a + b) >> 1, paeth][f] as number;
			raw.push(((line[x] as number) - predict) & 0xff);
		}
	});
	const chunk = (type: string, body: Uint8Array) => {
		const out = new Uint8Array(12 + body.length);
		const view = new DataView(out.buffer);
		view.setUint32(0, body.length);
		out.set(new TextEncoder().encode(type), 4);
		out.set(body, 8);
		return out; // the reader does not check CRCs
	};
	const ihdr = new Uint8Array(13);
	new DataView(ihdr.buffer).setUint32(0, width);
	new DataView(ihdr.buffer).setUint32(4, rows.length);
	ihdr.set([8, 2, 0, 0, 0], 8);
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", ihdr),
		chunk("IDAT", deflateSync(Buffer.from(raw))),
		chunk("IEND", new Uint8Array()),
	]);
}

test("readPng undoes every scanline filter", () => {
	const rows = Array.from({ length: 5 }, (_, y) =>
		Array.from({ length: 4 }, (_, x) => [(x * 70 + y * 13) & 0xff, (y * 90 + x) & 0xff, (x * y * 31) & 0xff]),
	);
	const img = readPng(png(rows, [0, 1, 2, 3, 4]));
	expect([img.width, img.height, img.channels]).toEqual([4, 5, 3]);
	expect([...img.data]).toEqual(rows.flat(2));
});

/**
 * A 20 x 20 m tile of 1 m cells (Venice's frame, y north): a calle 4 m wide along x at height code 53
 * (1.08 m), with a raised strip (code 58, 1.28 m) crossing it at x 8..10, and water everywhere else.
 */
function tile(): WalkRaster {
	const rows = Array.from({ length: 20 }, (_, py) =>
		Array.from({ length: 20 }, (_, px) => {
			const onCalle = py >= 8 && py < 12;
			if (!onCalle) return [0, 255, 0];
			return [px >= 8 && px < 10 ? 58 : 53, 0, 0];
		}),
	);
	const data = readPng(png(rows, [0]));
	return new WalkRaster([{ name: "t", bbox: [0, 0, 20, 20], png: data }]);
}

test("cells map to rojibura's frame: X = x, Z = -y", () => {
	const r = tile();
	// row 8 of the image is y 11..12 (north up), so Z -12..-11
	expect(r.code(1.5, -11.5)).toBe(53);
	expect(r.code(1.5, -12.5)).toBe(0);
	expect(r.code(9.5, -10)).toBe(58);
	expect(r.code(1.5, 11.5)).toBe(0); // y = -11.5 is outside the tile
	expect(r.heightNear(1.5, -10)).toBeCloseTo(heightOfCode(53), 9);
	// just off the calle, the nearest walkable cell gives the height
	expect(r.heightNear(1.5, -12.3)).toBeCloseTo(heightOfCode(53), 9);
	expect(r.heightNear(1.5, -15)).toBeNull();
});

test("soup: one quad per run of equal height, facing up", () => {
	const { positions, indices } = tile().soup();
	// four rows of three runs (0..8, 8..10, 10..20)
	expect(indices.length / 6).toBe(12);
	for (let t = 0; t < indices.length; t += 3) {
		const [a, b, c] = [0, 1, 2].map((k) => (indices[t + k] as number) * 3);
		const ux = (positions[(b as number) + 0] as number) - (positions[(a as number) + 0] as number);
		const uz = (positions[(b as number) + 2] as number) - (positions[(a as number) + 2] as number);
		const vx = (positions[(c as number) + 0] as number) - (positions[(a as number) + 0] as number);
		const vz = (positions[(c as number) + 2] as number) - (positions[(a as number) + 2] as number);
		expect(uz * vx - ux * vz).toBeGreaterThan(0); // the normal's Y
	}
	const clipped = tile().soup([0, -20, 5, 0]);
	expect(clipped.indices.length / 6).toBe(4);
});

test("Recast walks the calle over the raised strip", async () => {
	const r = tile();
	const { data } = await buildNavMesh(r.soup(), {
		...defaultBuildOptions,
		agent: { ...defaultBuildOptions.agent, maxClimb: 0.25 },
		seeds: [[2, heightOfCode(53), -10]],
		heightAt: (x, z, top) => r.heightNear(x, z) ?? top,
	});
	const mesh = NavMesh.fromJSON(data);
	expect(mesh.findPath([2, -10], [18, -10])).not.toBeNull();
	expect(mesh.isWalkable([2, -14])).toBe(false);
	expect(mesh.heightAt([9, -10])).toBeCloseTo(heightOfCode(58), 1);
});
