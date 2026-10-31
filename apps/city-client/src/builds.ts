// Things built in the city (free play, docs/prd.md 3.7): their models in the scene, and the walkable area
// with them on it. Models are glb files made with Blender (tools/city-build); "block" is a box drawn here.

import { boxNav, type ModelNav, type PlacedModel } from "@rojibura/nav";
import { type Build, type BuildId, type ModelId, modelUrl } from "@rojibura/protocol";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { CSS2DObject } from "three/examples/jsm/renderers/CSS2DRenderer.js";
import type { CityScene } from "./scene.ts";

const BLOCK_COLOR = "#dbc8a6";

interface Model {
	nav: ModelNav;
	scene: THREE.Object3D;
}

interface View {
	build: Build;
	root: THREE.Object3D;
	label?: CSS2DObject;
}

const loader = new GLTFLoader();
const models = new Map<ModelId, Promise<Model | null>>();
/** In free play, registered models come from the host; otherwise every model is a static asset. */
let fromHost = false;

export function modelsFromHost(on: boolean): void {
	fromHost = on;
}

/** A model's glb and nav.json (cached). Null if it cannot be loaded. */
function loadModel(id: ModelId): Promise<Model | null> {
	let p = models.get(id);
	if (!p) {
		p = Promise.all([
			fetch(modelUrl(id, "nav.json", fromHost)).then((r) =>
				r.ok ? (r.json() as Promise<ModelNav>) : Promise.reject(),
			),
			loader.loadAsync(modelUrl(id, "glb", fromHost)),
		])
			.then(([nav, gltf]) => ({ nav, scene: gltf.scene }))
			.catch(() => null);
		models.set(id, p);
	}
	return p;
}

/** The nav data of a build, if its model is loaded (blocks always are). */
function navOf(b: Build, model: Model | null | undefined): ModelNav | null {
	if (b.model === "block") return boxNav(...(b.size ?? [1, 1, 1]));
	return model?.nav ?? null;
}

/**
 * A new object for a build (or a preview of one): the model with its `paint*` materials in `color`
 * and its `collider*` objects hidden, at the build's place, turn and scale.
 */
export async function makeObject(
	b: Pick<Build, "model" | "pos" | "y" | "rot" | "scale" | "size" | "color">,
	ghost = false,
): Promise<THREE.Object3D | null> {
	let root: THREE.Object3D;
	if (b.model === "block") {
		const [w, h, d] = b.size ?? [1, 1, 1];
		const geometry = new THREE.BoxGeometry(w, h, d);
		geometry.translate(0, h / 2, 0);
		root = new THREE.Mesh(
			geometry,
			new THREE.MeshStandardMaterial({ color: b.color ?? BLOCK_COLOR, roughness: 0.8 }),
		);
	} else {
		const model = await loadModel(b.model);
		if (!model) return null;
		root = model.scene.clone(true);
	}
	const hidden: THREE.Object3D[] = [];
	root.traverse((o) => {
		if (o.name.toLowerCase().startsWith("collider")) hidden.push(o);
		const mesh = o as THREE.Mesh;
		if (!mesh.isMesh) return;
		mesh.castShadow = !ghost;
		mesh.receiveShadow = !ghost;
		const recolor = (m: THREE.Material) => {
			const copy = m.clone() as THREE.MeshStandardMaterial;
			if (b.color && m.name.toLowerCase().startsWith("paint")) copy.color = new THREE.Color(b.color);
			if (ghost) {
				copy.transparent = true;
				copy.opacity = 0.5;
				copy.depthWrite = false;
			}
			return copy;
		};
		mesh.material = Array.isArray(mesh.material) ? mesh.material.map(recolor) : recolor(mesh.material);
	});
	for (const o of hidden) o.visible = false;
	root.position.set(b.pos[0], b.y, b.pos[1]);
	root.rotation.y = (b.rot * Math.PI) / 180;
	root.scale.setScalar(b.scale);
	return root;
}

export class BuildsView {
	/** What is built (from the host), oldest first. */
	private readonly builds = new Map<BuildId, Build>();
	/** Their objects in the scene, once the models have loaded. */
	private readonly views = new Map<BuildId, View>();
	private readonly scene: CityScene;
	/** Called when the walkable area changes. */
	private readonly changed: () => void;

	constructor(scene: CityScene, changed: () => void) {
		this.scene = scene;
		this.changed = changed;
	}

	/** Everything built, as WELCOME lists it. */
	set(builds: Build[]): void {
		for (const id of [...this.views.keys()]) this.drop(id);
		this.builds.clear();
		for (const b of builds) this.builds.set(b.id, b);
		this.changed();
		for (const b of builds) void this.show(b);
	}

	add(b: Build): void {
		this.builds.set(b.id, b);
		this.changed();
		void this.show(b);
	}

	remove(id: BuildId): void {
		this.builds.delete(id);
		this.drop(id);
		this.changed();
	}

	private async show(b: Build): Promise<void> {
		const root = await makeObject(b);
		if (!root || this.builds.get(b.id) !== b || this.views.has(b.id)) return;
		root.userData.buildId = b.id;
		const view: View = { build: b, root };
		if (b.label) {
			const tag = document.createElement("div");
			tag.className = "rj-build-label";
			tag.textContent = b.label;
			view.label = new CSS2DObject(tag);
			const top = new THREE.Box3().setFromObject(root).max.y;
			view.label.position.set(b.pos[0], top + 0.4, b.pos[1]);
			this.scene.scene.add(view.label);
		}
		this.scene.scene.add(root);
		this.views.set(b.id, view);
		// people stand on decks and bridges
		if (navOf(b, await models.get(b.model))?.walk) this.scene.addGround(root);
	}

	private drop(id: BuildId): void {
		const v = this.views.get(id);
		if (!v) return;
		this.scene.scene.remove(v.root);
		this.scene.removeGround(v.root);
		if (v.label) {
			this.scene.scene.remove(v.label);
			v.label.element.remove();
		}
		this.views.delete(id);
	}

	get list(): Build[] {
		return [...this.builds.values()];
	}

	/** The builds as the navmesh sees them, oldest first (the host applies them in the same order). */
	async placed(): Promise<PlacedModel[]> {
		const builds = this.list.sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1));
		const out: PlacedModel[] = [];
		for (const b of builds) {
			const nav = navOf(b, b.model === "block" ? null : await loadModel(b.model));
			if (nav) out.push({ nav, pos: b.pos, y: b.y, rot: b.rot, scale: b.scale });
		}
		return out;
	}

	/** The objects to test clicks against. */
	get objects(): THREE.Object3D[] {
		return [...this.views.values()].map((v) => v.root);
	}

	/** The build an intersected object belongs to. */
	buildOf(o: THREE.Object3D | null): BuildId | null {
		for (let p: THREE.Object3D | null = o; p; p = p.parent)
			if (p.userData.buildId) return p.userData.buildId as string;
		return null;
	}
}
