// An area's trees and seasons (docs/prd.md 3.8.6): its trees.json drawn by nature/, the season of the date (or the
// one chosen with the season button), the winter's snow glb, and the season's sky and light on the scene.

import type * as THREE from "three";
import type { Area } from "./areas.ts";
import { Nature, type Season, type Species, seasonFor } from "./nature/index.ts";
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

	at(x: number, z: number): number | null {
		const { x0, z0, step, nx, nz, scale, offset } = this.meta;
		const u = (x - x0) / step;
		const v = (z - z0) / step;
		if (u < 0 || v < 0 || u > nx - 1 || v > nz - 1) return null;
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

	/** The area's nature, or null if it has no trees.json. `?season=` chooses the season. */
	static async create(
		scene: CityScene,
		area: Area,
		roots: THREE.Object3D[],
		params: URLSearchParams,
	): Promise<AreaNature | null> {
		const r = await fetch(`${area.dir}/trees.json`).catch(() => null);
		if (!r?.ok) return null;
		const data = (await r.json().catch(() => null)) as {
			trees?: [Species, number, number, number, number][];
		} | null;
		if (!data?.trees) return null;
		const grid = await loadGrid(area.dir);
		const heightAt = (x: number, z: number) => grid?.at(x, z) ?? scene.heightAt(x, z);
		const asked = params.get("season") as Season | null;
		const season = asked && SEASON_ORDER.includes(asked) ? asked : seasonFor(new Date());
		const trees = data.trees.map(([sp, x, z, s, rot]) => ({ sp, x, z, s, r: rot }));
		const nature = new Nature(scene.scene, { trees, heightAt, season });
		const made = new AreaNature(scene, area, roots, nature, season);
		if (season === "winter") await made.loadWinter();
		return made;
	}

	/** The next season round (spring, autumn, winter). */
	next(): Season {
		const s = SEASON_ORDER[(SEASON_ORDER.indexOf(this.season) + 1) % SEASON_ORDER.length] as Season;
		void this.setSeason(s);
		return s;
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
