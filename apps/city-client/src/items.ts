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

function meshFor(item: Item): { mesh: THREE.Object3D; lift: number } {
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
