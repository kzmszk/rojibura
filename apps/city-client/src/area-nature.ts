// An area's trees and seasons (docs/prd.md 3.8.6): its trees.json drawn by nature/, the season of the date (or the
// one chosen with the season button), the winter's snow glb, and the season's sky and light on the scene.

import type * as THREE from "three";
import type { Area } from "./areas.ts";
import { leafAtlas, Nature, type Season, type Species, seasonFor } from "./nature/index.ts";
import type { CityScene } from "./scene.ts";

export const SEASON_LABEL: Record<Season, string> = { spring: "🌸 春", autumn: "🍁 秋", winter: "❄️ 冬" };
const SEASON_ORDER: Season[] = ["spring", "autumn", "winter"];

/** The terrain's height on a grid (ground.json + ground.bin), sampled bilinearly. */
class HeightGrid {
	private readonly meta: {
		x0: number;
		z0: number;
		step: number;
		nx: number;
		nz: number;
		scale: number;
		offset: number;
	};
	private readonly h: Uint16Array;

	constructor(meta: HeightGrid["meta"], h: Uint16Array) {
		this.meta = meta;
		this.h = h;
	}

	/** The height at (x, z); up to `edge` metres off the grid, the height at its edge; null farther out. */
	at(x: number, z: number, edge = 0): number | null {
		const { x0, z0, step, nx, nz, scale, offset } = this.meta;
		let u = (x - x0) / step;
		let v = (z - z0) / step;
		const e = edge / step;
		if (u < -e || v < -e || u > nx - 1 + e || v > nz - 1 + e) return null;
		u = Math.min(Math.max(u, 0), nx - 1);
		v = Math.min(Math.max(v, 0), nz - 1);
		const i = Math.min(Math.floor(u), nx - 2);
		const j = Math.min(Math.floor(v), nz - 2);
		const fu = u - i;
		const fv = v - j;
		const g = (a: number, b: number) => (this.h[b * nx + a] as number) * scale + offset;
		return (
			(g(i, j) * (1 - fu) + g(i + 1, j) * fu) * (1 - fv) +
			(g(i, j + 1) * (1 - fu) + g(i + 1, j + 1) * fu) * fv
		);
	}
}

/** What AreaNature.prepare() fetches. */
export interface Prepared {
	trees: [Species, number, number, number, number][];
	grid: HeightGrid | null;
	atlas: THREE.DataTexture;
}

export class AreaNature {
	readonly nature: Nature;
	private readonly scene: CityScene;
	private readonly area: Area;
	private readonly roots: THREE.Object3D[];
	private winterRoots: THREE.Object3D[] | null = null;
	private loadingWinter: Promise<void> | null = null;
	season: Season;

	private constructor(scene: CityScene, area: Area, roots: THREE.Object3D[], nature: Nature, season: Season) {
		this.scene = scene;
		this.area = area;
		this.roots = roots;
		this.nature = nature;
		this.season = season;
		for (const r of roots) nature.applyToCity(r);
		scene.applySeason(nature.view());
	}

	/**
	 * Starts on the area's nature before its 3D has loaded: its trees.json, the ground's heights, and the leaf
	 * atlas (drawn in a worker). Null if the area has no trees.json.
	 */
	static async prepare(area: Area): Promise<Prepared | null> {
		const r = await fetch(`${area.dir}/trees.json`).catch(() => null);
		if (!r?.ok) return null;
		const data = (await r.json().catch(() => null)) as {
			trees?: [Species, number, number, number, number][];
		} | null;
		if (!data?.trees) return null;
		const [grid, atlas] = await Promise.all([loadGrid(area.dir), leafAtlas()]);
		return { trees: data.trees, grid, atlas };
	}

	/** The area's nature from what prepare() fetched (null: none). `?season=` chooses the season. */
	static async create(
		scene: CityScene,
		area: Area,
		roots: THREE.Object3D[],
		params: URLSearchParams,
		prepared: Prepared | null,
	): Promise<AreaNature | null> {
		if (!prepared) return null;
		const { grid, atlas } = prepared;
		// the ground's heights where there are (and just off them, round the edge); looking down on everything
		// drawn costs some milliseconds a time, and ground cover asks for thousands of heights
		const heightAt = grid
			? (x: number, z: number) => grid.at(x, z, 12)
			: (x: number, z: number) => scene.heightAt(x, z);
		const asked = params.get("season") as Season | null;
		const season = asked && SEASON_ORDER.includes(asked) ? asked : seasonFor(new Date());
		const trees = prepared.trees.map(([sp, x, z, s, rot]) => ({ sp, x, z, s, r: rot }));
		const nature = new Nature(scene.scene, { trees, heightAt, season, atlas });
		const made = new AreaNature(scene, area, roots, nature, season);
		if (season === "winter") await made.loadWinter();
		return made;
	}

	/** More of the area's 3D, loaded after entering: the season's looks on it too. */
	addCity(roots: THREE.Object3D[]): void {
		for (const r of roots) this.nature.applyToCity(r);
		this.roots.push(...roots);
	}

	async setSeason(season: Season): Promise<void> {
		this.season = season;
		if (season === "winter") await this.loadWinter();
		this.nature.setSeason(season);
		this.scene.applySeason(this.nature.view());
	}

	update(dt: number, now: number): void {
		this.nature.update(dt, this.scene.camera, now);
	}

	/** The winter's glb files (the snow), loaded once, the first time it is winter. */
	private loadWinter(): Promise<void> {
		const files = this.area.winter ?? [];
		if (this.winterRoots || files.length === 0) return Promise.resolve();
		this.loadingWinter ??= (async () => {
			const urls = files.map((f) => new URL(f, new URL(this.area.assetBase, location.href)).href);
			const roots = await this.scene.loadCity(urls);
			for (const r of roots) this.nature.applyToCity(r);
			this.winterRoots = roots;
			// the snow shows only in winter: nature hides it otherwise, on the next season change
			this.nature.setSeason(this.season);
		})();
		return this.loadingWinter;
	}

	/** Everything the area drew (the city and, once loaded, the snow). */
	get cityRoots(): THREE.Object3D[] {
		return [...this.roots, ...(this.winterRoots ?? [])];
	}
}

async function loadGrid(dir: string): Promise<HeightGrid | null> {
	const [m, b] = await Promise.all([
		fetch(`${dir}/ground.json`).catch(() => null),
		fetch(`${dir}/ground.bin`).catch(() => null),
	]);
	if (!m?.ok || !b?.ok) return null;
	const meta = (await m.json()) as ConstructorParameters<typeof HeightGrid>[0];
	return new HeightGrid(meta, new Uint16Array(await b.arrayBuffer()));
}
