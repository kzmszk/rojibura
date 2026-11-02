// The living nature of the town (はじまりの街): trees of many species through spring (cherry blossom), autumn
// (koyo) and winter (bare twigs and 20 cm of snow), what lies under them, what falls through the air near the
// camera, and the seasonal looks of the city glb's lawns, water, hot spring and snow (city.ts).
//
// Usage: new Nature(scene, { trees, heightAt, season }); applyToCity(gltf.scene) once it is loaded;
// update(dt, camera, now) every frame before rendering; view() for the sky, fog and lights of the season.

import * as THREE from "three";
import { CityLooks, type Env } from "./city.ts";
import { GroundCover } from "./ground.ts";
import { Falling, Snowfall } from "./particles.ts";
import { type Season, type SeasonView, VIEWS } from "./season.ts";
import { type TreeSpec, Trees } from "./trees.ts";

export { type Season, type SeasonView, seasonFor } from "./season.ts";
export { SPECIES_NAMES, type Species } from "./species.ts";
export type { TreeSpec } from "./trees.ts";

export interface NatureOptions {
	trees: TreeSpec[];
	/** Ground height at (x, z), or null outside the area. */
	heightAt: (x: number, z: number) => number | null;
	season: Season;
	/** Where the nature textures are served (assets/tex/nature). */
	texBase?: string;
}

export interface NatureStats {
	trees: number;
	near: number;
	mid: number;
	impostors: number;
	treeDraws: number;
	treeTriangles: number;
	coverDraws: number;
	coverPatches: number;
	falling: number;
}

export class Nature {
	private readonly scene: THREE.Scene;
	private readonly trees: Trees;
	private readonly cover: GroundCover;
	private readonly falling: Falling;
	private readonly snow: Snowfall;
	private readonly city: CityLooks;
	private readonly env: Env;
	private readonly prevHook: THREE.Object3D["onBeforeRender"];
	private season: Season;
	private readonly wind = new THREE.Vector3(1, 0, 0.35);
	private readonly light = new THREE.Color(1, 1, 1);
	private sun: THREE.DirectionalLight | null = null;
	private hemi: THREE.HemisphereLight | null = null;
	private lightSearch = 0;

	constructor(scene: THREE.Scene, opts: NatureOptions) {
		this.scene = scene;
		this.season = opts.season;
		const texBase = opts.texBase ?? "/tex/nature/";
		this.trees = new Trees(opts.trees, opts.heightAt, texBase);
		this.cover = new GroundCover(this.trees.crowns(), opts.heightAt, this.trees.atlas);
		this.falling = new Falling(this.trees.atlas, (x, z, r) => this.trees.near(x, z, r), opts.heightAt);
		this.snow = new Snowfall();
		this.env = {
			uTime: this.trees.u.uTime,
			uSunDir: this.trees.u.uSunDir,
			uSunColor: this.trees.u.uSunColor,
			uSkyZenith: { value: new THREE.Color() },
			uSkyHorizon: { value: new THREE.Color() },
		};
		this.city = new CityLooks(scene, this.env, texBase);
		scene.add(this.trees.group, this.cover.group, this.falling.mesh, this.snow.mesh);
		// the impostors are baked with the renderer, just before the scene is drawn
		this.prevHook = scene.onBeforeRender;
		scene.onBeforeRender = (renderer, ...rest) => {
			this.prevHook.call(scene, renderer, ...rest);
			this.trees.bake(renderer);
		};
		this.setSeason(opts.season);
	}

	/** Seasonal looks for the city glb: call once after it is loaded (materials by name, see city.ts). */
	applyToCity(root: THREE.Object3D): void {
		this.city.apply(root);
	}

	/** Switches everything live: trees, ground cover, city materials, particles. */
	setSeason(season: Season): void {
		this.season = season;
		this.trees.setSeason(season);
		this.cover.setSeason(season);
		this.falling.setSeason(season);
		this.snow.setSeason(season);
		this.city.setSeason(season);
	}

	get currentSeason(): Season {
		return this.season;
	}

	/** Wind sway, particles near the camera, levels of detail. `now` in milliseconds (the host clock is fine). */
	update(dt: number, camera: THREE.Camera, now: number): void {
		// seconds, wrapped so shader time keeps its precision
		const t = (now / 1000) % 3600;
		this.findLights();
		if (this.sun) {
			this.env.uSunDir.value.copy(this.sun.position).sub(this.sun.target.position).normalize();
			this.env.uSunColor.value.copy(this.sun.color).multiplyScalar(this.sun.intensity);
		}
		// light for steam and flakes: the sky's, a little of the sun's
		const v = VIEWS[this.season];
		const hemiI = this.hemi?.intensity ?? v.hemiIntensity;
		const sunI = this.sun?.intensity ?? v.sunIntensity;
		const k = Math.min(1, 0.32 * hemiI + 0.12 * sunI + 0.2);
		this.light
			.set(this.hemi?.color ?? v.hemiSky)
			.lerp(new THREE.Color(1, 1, 1), 0.6)
			.multiplyScalar(k);
		// the wind turns and gusts slowly
		const a = 0.35 + Math.sin(t * 0.021) * 0.5;
		const g = 0.8 + 0.4 * Math.sin(t * 0.13) * Math.sin(t * 0.071);
		this.wind.set(Math.cos(a) * g, 0, Math.sin(a) * g);
		this.trees.u.uWindDir.value.set(Math.cos(a), 0, Math.sin(a));
		this.trees.u.uWind.value = g;
		this.trees.update(dt, camera, t);
		this.cover.update(camera);
		this.falling.update(dt, camera, t, this.wind);
		this.snow.update(dt, t, this.wind, this.light);
		this.city.update(this.light, this.wind);
	}

	/** Bakes what needs the renderer now (otherwise done on the next render). */
	bake(renderer: THREE.WebGLRenderer): void {
		this.trees.bake(renderer);
	}

	/** Sky colour, fog, hemisphere and sun colours and intensities that suit the season, for the scene to apply. */
	view(): SeasonView {
		const v = VIEWS[this.season];
		return { ...v, fog: [v.fog[0], v.fog[1]] };
	}

	stats(): NatureStats {
		const t = this.trees.stats();
		const c = this.cover.stats();
		return {
			trees: t.trees,
			near: this.trees.drawn.near,
			mid: this.trees.drawn.mid,
			impostors: this.trees.drawn.imp,
			treeDraws: t.draws,
			treeTriangles: t.triangles,
			coverDraws: c.draws,
			coverPatches: c.patches,
			falling: this.falling.mesh.count,
		};
	}

	dispose(): void {
		this.scene.onBeforeRender = this.prevHook;
		this.city.dispose();
		this.trees.dispose();
		this.cover.dispose();
		this.falling.dispose();
		this.snow.dispose();
	}

	private findLights(): void {
		if (this.sun?.parent && this.hemi?.parent) return;
		// look again now and then (a scene without one of them should not be searched every frame)
		if (this.lightSearch++ % 120 !== 0) return;
		this.scene.traverse((o) => {
			if ((o as THREE.DirectionalLight).isDirectionalLight && !this.sun?.parent)
				this.sun = o as THREE.DirectionalLight;
			if ((o as THREE.HemisphereLight).isHemisphereLight && !this.hemi?.parent)
				this.hemi = o as THREE.HemisphereLight;
		});
	}
}
