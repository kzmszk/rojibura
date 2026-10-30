// Three.js scene: renderer, camera that follows the player, lights, the city and ground picking.

import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { CSS2DRenderer } from "three/examples/jsm/renderers/CSS2DRenderer.js";

export class CityScene {
	readonly renderer: THREE.WebGLRenderer;
	readonly labels: CSS2DRenderer;
	readonly scene = new THREE.Scene();
	readonly camera: THREE.PerspectiveCamera;
	readonly controls: OrbitControls;
	/** Meshes that count as ground for clicks and for snapping feet. */
	private ground: THREE.Object3D[] = [];
	private readonly down = new THREE.Raycaster();
	private readonly root: HTMLElement;

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
		this.controls.maxPolarAngle = Math.PI * 0.47;
		this.controls.minDistance = 3;
		this.controls.maxDistance = 45;
		this.controls.enablePan = false;

		this.scene.add(new THREE.HemisphereLight(0xeaf2ff, 0x6b6250, 1.6));
		const sun = new THREE.DirectionalLight(0xfff1dc, 2.4);
		sun.position.set(30, 50, 20);
		sun.castShadow = true;
		sun.shadow.mapSize.set(2048, 2048);
		sun.shadow.bias = -0.0005;
		sun.shadow.normalBias = 0.04;
		const s = sun.shadow.camera;
		s.left = s.bottom = -50;
		s.right = s.top = 50;
		s.far = 150;
		this.scene.add(sun);

		this.resize();
		addEventListener("resize", () => this.resize());
	}

	async loadCity(url: string): Promise<void> {
		const gltf = await new GLTFLoader().loadAsync(url);
		gltf.scene.traverse((o) => {
			if ((o as THREE.Mesh).isMesh) {
				o.castShadow = true;
				o.receiveShadow = true;
				// trees' crowns are not ground
				if (!o.name.startsWith("tree_crown") && !o.name.includes("fountain_water")) this.ground.push(o);
			}
		});
		this.scene.add(gltf.scene);
	}

	/** Height of the walkable surface under (x, z), or null. */
	heightAt(x: number, z: number): number | null {
		this.down.set(new THREE.Vector3(x, 30, z), new THREE.Vector3(0, -1, 0));
		const hit = this.down.intersectObjects(this.ground, false)[0];
		return hit ? hit.point.y : null;
	}

	/** Ground point under the pointer, or null. */
	pickGround(ndc: THREE.Vector2): THREE.Vector3 | null {
		const ray = new THREE.Raycaster();
		ray.setFromCamera(ndc, this.camera);
		return ray.intersectObjects(this.ground, false)[0]?.point ?? null;
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
	}

	render(): void {
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
