// Three.js scene: renderer, camera that follows the player, lights, the area and ground picking.

import type { AreaView } from "@rojibura/protocol";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { CSS2DRenderer } from "three/examples/jsm/renderers/CSS2DRenderer.js";
import { applyTriplanar, wantsTriplanar } from "./triplanar.ts";

/** The sun's direction (from the target) and the default reach of its shadow (metres around the camera). */
const SUN_OFFSET = new THREE.Vector3(30, 50, 20);
const SHADOW_HALF = 50;
/** The orbiting camera goes no lower than this above the ground under it. */
const CAMERA_ABOVE_GROUND = 0.25;

export class CityScene {
	readonly renderer: THREE.WebGLRenderer;
	readonly labels: CSS2DRenderer;
	readonly scene = new THREE.Scene();
	readonly camera: THREE.PerspectiveCamera;
	readonly controls: OrbitControls;
	/** Meshes that count as ground for clicks and for snapping feet. */
	private ground: THREE.Object3D[] = [];
	/**
	 * Height of the walkable area at (x, z) from the navmesh, when known: feet are found by looking down from
	 * a little above it, so roofs and treetops overhead are not taken for the ground (docs/prd.md 3.7).
	 */
	heightHint: ((x: number, z: number) => number | null) | null = null;
	private readonly down = new THREE.Raycaster();
	private readonly root: HTMLElement;
	private readonly sun: THREE.DirectionalLight;
	private readonly hemi: THREE.HemisphereLight;
	private water: THREE.Mesh | null = null;
	private shadowHalf = SHADOW_HALF;

	constructor(root: HTMLElement) {
		this.root = root;
		this.renderer = new THREE.WebGLRenderer({ antialias: true });
		this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
		this.renderer.shadowMap.enabled = true;
		this.renderer.outputColorSpace = THREE.SRGBColorSpace;
		root.appendChild(this.renderer.domElement);
		this.labels = new CSS2DRenderer();
		this.labels.domElement.className = "rj-labels";
		root.appendChild(this.labels.domElement);

		this.scene.background = new THREE.Color(0xbfd6e8);
		this.scene.fog = new THREE.Fog(0xbfd6e8, 60, 160);
		this.camera = new THREE.PerspectiveCamera(55, 1, 0.1, 400);
		this.camera.position.set(0, 9, 14);
		this.controls = new OrbitControls(this.camera, this.renderer.domElement);
		this.controls.enableDamping = true;
		// close to the avatar, and down near the ground looking up at it (follow keeps it above the ground)
		this.controls.maxPolarAngle = Math.PI * 0.62;
		this.controls.minDistance = 1.2;
		this.controls.maxDistance = 45;
		this.controls.enablePan = false;

		this.hemi = new THREE.HemisphereLight(0xeaf2ff, 0x6b6250, 1.6);
		this.scene.add(this.hemi);
		const sun = new THREE.DirectionalLight(0xfff1dc, 2.4);
		sun.position.copy(SUN_OFFSET);
		sun.castShadow = true;
		sun.shadow.mapSize.set(2048, 2048);
		sun.shadow.bias = -0.0005;
		sun.shadow.normalBias = 0.04;
		this.sun = sun;
		this.setShadow(SHADOW_HALF);
		this.scene.add(sun, sun.target);

		this.resize();
		addEventListener("resize", () => this.resize());
	}

	/** The area's sky, fog, view distance, water, shadow reach and sun (docs/prd.md 3.8). */
	applyView(view: AreaView | undefined): void {
		if (!view) return;
		if (view.sky) {
			const sky = new THREE.Color(view.sky);
			this.scene.background = sky;
			if (this.scene.fog) this.scene.fog.color = sky;
		}
		if (view.fog && this.scene.fog instanceof THREE.Fog) [this.scene.fog.near, this.scene.fog.far] = view.fog;
		if (view.far) {
			this.camera.far = view.far;
			this.camera.updateProjectionMatrix();
		}
		if (view.water !== undefined) {
			const water = new THREE.Mesh(
				new THREE.PlaneGeometry(1, 1),
				new THREE.MeshStandardMaterial({ color: 0x2f4f57, roughness: 0.25, metalness: 0.1 }),
			);
			water.name = "water";
			water.rotation.x = -Math.PI / 2;
			water.position.y = view.water;
			const size = (view.far ?? this.camera.far) * 2;
			water.scale.set(size, size, 1);
			water.receiveShadow = true;
			this.scene.add(water);
			this.water = water;
		}
		if (view.shadow) this.setShadow(view.shadow);
		// an invisible light is left out, and with it the shadow pass
		if (view.sun === false) this.sun.visible = false;
		if (view.camera) this.controls.maxDistance = view.camera;
	}

	private setShadow(half: number): void {
		this.shadowHalf = half;
		const s = this.sun.shadow.camera;
		s.left = s.bottom = -half;
		s.right = s.top = half;
		s.far = 100 + half * 2;
		s.updateProjectionMatrix();
	}

	/**
	 * The area seen from straight above, north up (docs/prd.md 3.4.14): `bounds` in metres (x0, z0, x1, z1), `width`
	 * pixels wide. With `cut`, from that height (under a roof). `hide` is left out while drawing.
	 */
	renderMap(
		bounds: [number, number, number, number],
		width: number,
		cut: number | undefined,
		hide: THREE.Object3D[],
	): HTMLCanvasElement {
		const [x0, z0, x1, z1] = bounds;
		const w = x1 - x0;
		const h = z1 - z0;
		const height = Math.round((width * h) / w);
		// drawn twice the size and scaled down, for smooth edges
		const ss = 2;
		const top = cut ?? 600;
		const cam = new THREE.OrthographicCamera(-w / 2, w / 2, h / 2, -h / 2, 0.05, top + 200);
		cam.up.set(0, 0, -1);
		cam.position.set((x0 + x1) / 2, top, (z0 + z1) / 2);
		cam.lookAt((x0 + x1) / 2, 0, (z0 + z1) / 2);
		const target = new THREE.WebGLRenderTarget(width * ss, height * ss);
		target.texture.colorSpace = THREE.SRGBColorSpace;
		const fog = this.scene.fog;
		const half = this.shadowHalf;
		const shown = hide.filter((o) => o.visible);
		for (const o of shown) o.visible = false;
		this.scene.fog = null;
		// the sun's shadow over the whole area while drawing it
		this.setShadow(Math.max(w, h) / 2 + 10);
		this.sun.target.position.set((x0 + x1) / 2, 0, (z0 + z1) / 2);
		this.sun.position.copy(this.sun.target.position).add(SUN_OFFSET.clone().multiplyScalar(6));
		const pixels = new Uint8Array(width * ss * height * ss * 4);
		try {
			this.renderer.setRenderTarget(target);
			this.renderer.render(this.scene, cam);
			this.renderer.readRenderTargetPixels(target, 0, 0, width * ss, height * ss, pixels);
		} finally {
			this.renderer.setRenderTarget(null);
			target.dispose();
			this.scene.fog = fog;
			this.setShadow(half);
			for (const o of shown) o.visible = true;
		}
		// GL rows go up from the bottom
		const big = document.createElement("canvas");
		big.width = width * ss;
		big.height = height * ss;
		const image = new ImageData(width * ss, height * ss);
		const row = width * ss * 4;
		for (let y = 0; y < height * ss; y++)
			image.data.set(pixels.subarray((height * ss - 1 - y) * row, (height * ss - y) * row), y * row);
		(big.getContext("2d") as CanvasRenderingContext2D).putImageData(image, 0, 0);
		const out = document.createElement("canvas");
		out.width = width;
		out.height = height;
		const ctx = out.getContext("2d") as CanvasRenderingContext2D;
		ctx.imageSmoothingQuality = "high";
		ctx.drawImage(big, 0, 0, width, height);
		return out;
	}

	/** Loads the area's glb files (meshopt-compressed ones too); `onFile` after each. Resolves to their roots. */
	async loadCity(urls: string[], onFile?: (done: number) => void): Promise<THREE.Object3D[]> {
		const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
		let done = 0;
		return await Promise.all(
			urls.map(async (url) => {
				const gltf = await loader.loadAsync(url);
				gltf.scene.traverse((o) => {
					if ((o as THREE.Mesh).isMesh) {
						// snow lies in shadow, it casts none worth drawing
						o.castShadow = !o.name.startsWith("snow_");
						o.receiveShadow = true;
						// trees' crowns, water and the winter's snow (feet sink into it) are not ground
						if (!/^(tree_crown|snow_|water_)/.test(o.name) && !o.name.includes("fountain_water"))
							this.ground.push(o);
						const m = (o as THREE.Mesh).material;
						if (!Array.isArray(m) && wantsTriplanar(m)) applyTriplanar(m as THREE.MeshStandardMaterial);
					}
				});
				this.scene.add(gltf.scene);
				onFile?.(++done);
				return gltf.scene;
			}),
		);
	}

	/** The sky, fog and light of a season (nature/season.ts); the fog keeps to the area's view distance. */
	applySeason(v: {
		sky: string;
		fog: [number, number];
		sunColor: number;
		sunIntensity: number;
		hemiSky: number;
		hemiGround: number;
		hemiIntensity: number;
	}): void {
		const sky = new THREE.Color(v.sky);
		this.scene.background = sky;
		if (this.scene.fog instanceof THREE.Fog) {
			this.scene.fog.color = sky;
			this.scene.fog.near = v.fog[0];
			this.scene.fog.far = Math.min(v.fog[1], this.camera.far);
		}
		this.sun.color.setHex(v.sunColor);
		this.sun.intensity = v.sunIntensity;
		this.hemi.color.setHex(v.hemiSky);
		this.hemi.groundColor.setHex(v.hemiGround);
		this.hemi.intensity = v.hemiIntensity;
	}

	/** Things people can walk on that were built (decks, bridges) count as ground too. */
	addGround(o: THREE.Object3D): void {
		if (!this.ground.includes(o)) this.ground.push(o);
	}

	removeGround(o: THREE.Object3D): void {
		this.ground = this.ground.filter((g) => g !== o);
	}

	/**
	 * Height of the walkable surface under (x, z), or null. Looked for from a little above the walkable area's
	 * height there; off it, from a little above `near` (where one was a moment ago: on a mountain, high above a
	 * fixed height), else from 30 m.
	 */
	heightAt(x: number, z: number, near?: number): number | null {
		const hint = this.heightHint?.(x, z) ?? near ?? null;
		this.down.set(new THREE.Vector3(x, hint === null ? 30 : hint + 2, z), new THREE.Vector3(0, -1, 0));
		// colliders of built models are hidden but still in the scene
		const hit = this.down.intersectObjects(this.ground, true).find((h) => h.object.visible);
		return hit ? hit.point.y : null;
	}

	/** Ground point under the pointer, or null. Objects in `also` (builds) stop the ray too. */
	pickGround(ndc: THREE.Vector2, also: THREE.Object3D[] = []): THREE.Vector3 | null {
		const ray = new THREE.Raycaster();
		ray.setFromCamera(ndc, this.camera);
		return ray.intersectObjects([...this.ground, ...also], true).find((h) => h.object.visible)?.point ?? null;
	}

	/** Puts the camera behind and above `target` (on first join). */
	jumpTo(target: THREE.Vector3): void {
		this.controls.target.copy(target).add(new THREE.Vector3(0, 1.4, 0));
		this.camera.position.copy(target).add(new THREE.Vector3(0, 5.5, 9));
		this.controls.update();
	}

	/** Keeps the camera orbiting around `target` as it moves. */
	follow(target: THREE.Vector3, dt: number): void {
		const desired = target.clone().add(new THREE.Vector3(0, 1.4, 0));
		const delta = desired.sub(this.controls.target).multiplyScalar(Math.min(1, dt * 6));
		this.controls.target.add(delta);
		this.camera.position.add(delta);
		this.controls.update();
		const p = this.camera.position;
		const ground = this.heightAt(p.x, p.z);
		// a roof above the avatar's head is not the ground (the camera may be in a building)
		if (ground !== null && ground < this.controls.target.y && p.y < ground + CAMERA_ABOVE_GROUND) {
			p.y = ground + CAMERA_ABOVE_GROUND;
			this.camera.lookAt(this.controls.target);
		}
	}

	/** The sun's shadow and the water follow what the camera looks at, so a large area has them everywhere. */
	private track(): void {
		const t = this.controls.target;
		// whole texels, so shadow edges do not shimmer as the camera moves
		const s = this.sun.shadow.camera;
		const texel = (s.right - s.left) / this.sun.shadow.mapSize.x;
		const x = Math.round(t.x / texel) * texel;
		const z = Math.round(t.z / texel) * texel;
		this.sun.target.position.set(x, 0, z);
		this.sun.position.set(x + SUN_OFFSET.x, SUN_OFFSET.y, z + SUN_OFFSET.z);
		this.water?.position.set(t.x, this.water.position.y, t.z);
	}

	render(): void {
		this.track();
		this.renderer.render(this.scene, this.camera);
		this.labels.render(this.scene, this.camera);
	}

	private resize(): void {
		const w = this.root.clientWidth || innerWidth;
		const h = this.root.clientHeight || innerHeight;
		this.renderer.setSize(w, h);
		this.labels.setSize(w, h);
		this.camera.aspect = w / h;
		this.camera.updateProjectionMatrix();
	}
}
