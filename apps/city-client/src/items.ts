// Small things in the area (docs/prd.md 3.4.7): drawn on the ground, in their holder's right hand, or flying
// along an arc from the thrower's hand to where the host says they land.

import type { AvatarId, Item, ItemId } from "@rojibura/protocol";
import * as THREE from "three";
import type { CityScene } from "./scene.ts";

/** How long a pick-up takes to reach the ground (the "pick" clip); the thing stays put until then. */
const REACH_MS = 450;
/** The hand lets go over the shoulder, this high. */
const RELEASE_HEIGHT = 1.6;

interface Drawn {
	item: Item;
	mesh: THREE.Object3D;
	/** Lifted off the ground: half its height. */
	lift: number;
	/** When it was picked up (host time), to leave it on the ground until the hand gets there. */
	pickedAt: number;
	/** Who threw it: it stays in their hand until the flight starts. */
	thrower: AvatarId | null;
}

/** What was bought, shaped after what it is (docs/prd.md 3.8.6): a cup, a bottle, a rice ball, a book... */
function goodsMesh(goods: NonNullable<Item["goods"]>): { mesh: THREE.Object3D; lift: number } {
	const color = new THREE.Color(goods.color);
	const mat = (c: THREE.ColorRepresentation, rough = 0.7) =>
		new THREE.MeshStandardMaterial({ color: c, roughness: rough });
	const g = new THREE.Group();
	const add = (geo: THREE.BufferGeometry, m: THREE.Material, y = 0, rx = 0) => {
		const o = new THREE.Mesh(geo, m);
		o.position.y = y;
		o.rotation.x = rx;
		o.castShadow = true;
		g.add(o);
		return o;
	};
	switch (goods.id) {
		case "coffee":
			add(new THREE.CylinderGeometry(0.045, 0.036, 0.11, 16), mat(0xf4efe6), 0);
			add(new THREE.CylinderGeometry(0.047, 0.047, 0.03, 16), mat(color), 0.035);
			return { mesh: g, lift: 0.055 };
		case "tea":
			add(new THREE.CylinderGeometry(0.035, 0.035, 0.18, 14), mat(0xcfe6ef, 0.2), 0);
			add(new THREE.CylinderGeometry(0.036, 0.036, 0.06, 14), mat(color), 0.01);
			add(new THREE.CylinderGeometry(0.015, 0.015, 0.03, 10), mat(0xffffff), 0.105);
			return { mesh: g, lift: 0.09 };
		case "onigiri": {
			const tri = new THREE.CylinderGeometry(0.06, 0.06, 0.035, 3);
			add(tri, mat(color, 0.9), 0, Math.PI / 2);
			add(new THREE.BoxGeometry(0.05, 0.05, 0.037), mat(0x1d2a1d), -0.03);
			return { mesh: g, lift: 0.06 };
		}
		case "nikuman":
		case "anpan":
		case "bread":
		case "croissant":
		case "pretzel": {
			const bun = add(new THREE.SphereGeometry(0.065, 16, 10), mat(color, 0.8), 0);
			bun.scale.set(goods.id === "croissant" ? 1.5 : 1, 0.65, 1);
			return { mesh: g, lift: 0.04 };
		}
		case "baguette":
			add(new THREE.CapsuleGeometry(0.035, 0.42, 4, 10), mat(color, 0.8), 0, Math.PI / 2.4);
			return { mesh: g, lift: 0.05 };
		case "icecream":
			add(new THREE.ConeGeometry(0.035, 0.11, 12), mat(0xd9a45b), -0.03, Math.PI);
			add(new THREE.SphereGeometry(0.042, 12, 10), mat(color, 0.6), 0.04);
			return { mesh: g, lift: 0.085 };
		case "umbrella":
			add(new THREE.CylinderGeometry(0.03, 0.012, 0.75, 10), mat(color, 0.3), 0, Math.PI / 2);
			return { mesh: g, lift: 0.03 };
		case "sandwich":
			add(new THREE.CylinderGeometry(0.07, 0.07, 0.04, 3), mat(color, 0.85), 0, Math.PI / 2);
			return { mesh: g, lift: 0.06 };
		case "map":
			add(new THREE.BoxGeometry(0.18, 0.012, 0.12), mat(color, 0.9), 0);
			return { mesh: g, lift: 0.01 };
		default:
			// books and notebooks: covers in the goods' colour, pale page edges
			add(new THREE.BoxGeometry(0.15, 0.035, 0.21), mat(color, 0.6), 0);
			add(new THREE.BoxGeometry(0.14, 0.028, 0.2), mat(0xf3eedf, 0.9), 0).position.x = 0.006;
			return { mesh: g, lift: 0.018 };
	}
}

function meshFor(item: Item): { mesh: THREE.Object3D; lift: number } {
	if (item.kind === "goods" && item.goods) return goodsMesh(item.goods);
	if (item.kind === "box") {
		const mesh = new THREE.Mesh(
			new THREE.BoxGeometry(0.28, 0.22, 0.28),
			new THREE.MeshStandardMaterial({ color: 0xc19a6b, roughness: 0.9 }),
		);
		return { mesh, lift: 0.11 };
	}
	const mesh = new THREE.Mesh(
		new THREE.SphereGeometry(0.11, 20, 14),
		new THREE.MeshStandardMaterial({ color: 0xe8553e, roughness: 0.5 }),
	);
	return { mesh, lift: 0.11 };
}

export class ItemsView {
	readonly group = new THREE.Group();
	private readonly drawn = new Map<ItemId, Drawn>();

	private readonly scene: CityScene;
	/** Where an avatar's right hand is now (world), or null if it is not here. */
	private readonly handOf: (id: AvatarId) => THREE.Vector3 | null;

	constructor(scene: CityScene, handOf: (id: AvatarId) => THREE.Vector3 | null) {
		this.scene = scene;
		this.handOf = handOf;
	}

	/** Adds or updates a thing; returns what changed for its holder ("pick", "throw" or null). */
	set(item: Item, hostNow: number): { who: AvatarId; did: "pick" | "throw" } | null {
		const known = this.drawn.get(item.id);
		const before = known?.item;
		let d = known;
		if (!d) {
			const { mesh, lift } = meshFor(item);
			mesh.castShadow = true;
			mesh.userData.itemId = item.id;
			this.group.add(mesh);
			d = { item, mesh, lift, pickedAt: 0, thrower: null };
			this.drawn.set(item.id, d);
		}
		d.item = item;
		if (item.holder && before && !before.holder) {
			d.pickedAt = hostNow;
			return { who: item.holder, did: "pick" };
		}
		if (item.flight && before?.holder) {
			d.thrower = before.holder;
			return { who: before.holder, did: "throw" };
		}
		if (!item.flight) d.thrower = null;
		return null;
	}

	/** Every thing at once (WELCOME). */
	reset(items: Item[]): void {
		for (const d of this.drawn.values()) d.mesh.removeFromParent();
		this.drawn.clear();
		for (const item of items) this.set(item, 0);
	}

	/** A thing is gone (eaten, or tidied away). */
	remove(id: ItemId): void {
		const d = this.drawn.get(id);
		if (!d) return;
		d.mesh.removeFromParent();
		d.mesh.traverse((o) => {
			const m = o as THREE.Mesh;
			if (m.isMesh) {
				m.geometry.dispose();
				for (const mat of [m.material].flat()) mat.dispose();
			}
		});
		this.drawn.delete(id);
	}

	/** The thing an avatar holds. */
	heldBy(id: AvatarId): Item | undefined {
		for (const d of this.drawn.values()) if (d.item.holder === id) return d.item;
		return undefined;
	}

	get meshes(): THREE.Object3D[] {
		return [...this.drawn.values()].map((d) => d.mesh);
	}

	itemAt(o: THREE.Object3D): Item | undefined {
		const id = o.userData.itemId as ItemId | undefined;
		return id ? this.drawn.get(id)?.item : undefined;
	}

	private onGround(d: Drawn, x: number, z: number): THREE.Vector3 {
		return new THREE.Vector3(x, (this.scene.heightAt(x, z) ?? 0) + d.lift, z);
	}

	update(hostNow: number): void {
		for (const d of this.drawn.values()) {
			const { item, mesh } = d;
			const lying = this.onGround(d, item.pos[0], item.pos[1]);
			const hand = item.holder ? this.handOf(item.holder) : null;
			if (item.holder && hand && hostNow - d.pickedAt >= REACH_MS) {
				mesh.position.copy(hand);
			} else if (item.flight && hostNow < item.flight.at + item.flight.dur) {
				const { from, at, dur } = item.flight;
				const thrown = d.thrower ? this.handOf(d.thrower) : null;
				if (hostNow < at && thrown) {
					mesh.position.copy(thrown);
					continue;
				}
				const start = new THREE.Vector3(
					from[0],
					(this.scene.heightAt(from[0], from[1]) ?? 0) + RELEASE_HEIGHT,
					from[1],
				);
				const u = Math.min(1, Math.max(0, (hostNow - at) / dur));
				const peak = Math.max(start.y, lying.y) + 1.2;
				mesh.position.lerpVectors(start, lying, u);
				mesh.position.y += 4 * (peak - Math.max(start.y, lying.y)) * u * (1 - u);
				mesh.rotation.x += 0.25;
			} else {
				mesh.position.copy(lying);
			}
		}
	}
}
