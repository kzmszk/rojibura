// Walk rasters as Venice writes them (demos/venice/tools/gen/walk.py): tiles of 0.25 m cells, R = height code of
// the walkable surface (0 = blocked), G = 255 where a boat can float. Venice's frame is x east, y north, z up;
// here, as in glTF and the rest of rojibura, X = x, Y = z, Z = -y.

import type { TriangleSoup } from "./glb.ts";
import type { Png } from "./png.ts";

export interface WalkTile {
	name: string;
	/** Venice's frame: [x0, y0, x1, y1] (metres). */
	bbox: [number, number, number, number];
	png: Png;
}

/** Height code to metres (walk.py `zcode`). */
export const heightOfCode = (code: number): number => (code - 1) * 0.04 - 1.0;

export class WalkRaster {
	private readonly tiles: WalkTile[];

	constructor(tiles: WalkTile[]) {
		for (const t of tiles)
			if (t.png.channels < 2) throw new Error(`${t.name}: a walk raster has at least two channels`);
		this.tiles = tiles;
	}

	/** Height code of the cell at rojibura (X, Z): 0 where blocked or outside every tile. */
	code(X: number, Z: number): number {
		const y = -Z;
		for (const t of this.tiles) {
			const [x0, y0, x1, y1] = t.bbox;
			if (X < x0 || X >= x1 || y <= y0 || y > y1) continue;
			const { width, height, channels, data } = t.png;
			const px = Math.floor(((X - x0) / (x1 - x0)) * width);
			const py = Math.floor(((y1 - y) / (y1 - y0)) * height);
			return data[(py * width + px) * channels] as number;
		}
		return 0;
	}

	/**
	 * Height (Y) of the walkable surface at (X, Z): the cell there, or the nearest walkable one within `r` metres
	 * (polygon corners can sit on a cell's edge). Null if there is none.
	 */
	heightNear(X: number, Z: number, r = 0.5): number | null {
		const here = this.code(X, Z);
		if (here) return heightOfCode(here);
		const step = 0.125;
		let best: { d: number; code: number } | null = null;
		for (let dx = -r; dx <= r; dx += step)
			for (let dz = -r; dz <= r; dz += step) {
				const d = Math.hypot(dx, dz);
				if (d > r || (best && d >= best.d)) continue;
				const c = this.code(X + dx, Z + dz);
				if (c) best = { d, code: c };
			}
		return best ? heightOfCode(best.code) : null;
	}

	/**
	 * The walkable cells as triangles facing up, for Recast: each run of cells of one height along a row is one
	 * quad. `clip` ([X0, Z0, X1, Z1]) keeps only the cells whose centre is inside it.
	 */
	soup(clip?: [number, number, number, number]): TriangleSoup {
		const P: number[] = [];
		const I: number[] = [];
		for (const t of this.tiles) {
			const [x0, , x1, y1] = t.bbox;
			const { width, height, channels, data } = t.png;
			const res = (x1 - x0) / width;
			const inside = (px: number) => {
				const X = x0 + (px + 0.5) * res;
				return !clip || (X >= clip[0] && X <= clip[2]);
			};
			for (let py = 0; py < height; py++) {
				const Z0 = py * res - y1;
				const Zc = Z0 + res / 2;
				if (clip && (Zc < clip[1] || Zc > clip[3])) continue;
				let px = 0;
				while (px < width) {
					const code = data[(py * width + px) * channels] as number;
					if (!code || !inside(px)) {
						px++;
						continue;
					}
					let end = px + 1;
					while (end < width && data[(py * width + end) * channels] === code && inside(end)) end++;
					const X0 = x0 + px * res;
					const X1 = x0 + end * res;
					const Y = heightOfCode(code);
					const v = P.length / 3;
					// a (X0, Z0), b (X1, Z0), c (X1, Z1), d (X0, Z1); (a, c, b) and (a, d, c) face +Y
					P.push(X0, Y, Z0, X1, Y, Z0, X1, Y, Z0 + res, X0, Y, Z0 + res);
					I.push(v, v + 2, v + 1, v, v + 3, v + 2);
					px = end;
				}
			}
		}
		return { positions: new Float32Array(P), indices: new Uint32Array(I) };
	}
}
