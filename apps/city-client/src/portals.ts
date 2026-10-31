// Portals to other areas (docs/prd.md 3.8): an arch with its name, and which one you are standing at.

import type { Portal, Vec2 } from "@rojibura/protocol";
import * as THREE from "three";
import { CSS2DObject } from "three/examples/jsm/renderers/CSS2DRenderer.js";

/** Standing this close to a portal offers the way through (metres). */
export const PORTAL_REACH = 3;

export class PortalsView {
	readonly objects: THREE.Object3D[] = [];
	private readonly portals: Portal[];

	constructor(scene: THREE.Scene, portals: Portal[], heightAt: (x: number, z: number) => number | null) {
		this.portals = portals;
		const glow = new THREE.MeshStandardMaterial({
			color: 0x6fd0ff,
			emissive: 0x2a8fd0,
			emissiveIntensity: 1.2,
			transparent: true,
			opacity: 0.85,
		});
		const floor = new THREE.MeshBasicMaterial({
			color: 0x8fe0ff,
			transparent: true,
			opacity: 0.35,
			depthWrite: false,
		});
		for (const p of portals) {
			const g = new THREE.Group();
			g.name = `portal:${p.id}`;
			const arch = new THREE.Mesh(new THREE.TorusGeometry(1.4, 0.09, 12, 48, Math.PI), glow);
			arch.position.y = 1.0;
			const legGeo = new THREE.CylinderGeometry(0.09, 0.09, 1.0, 12);
			for (const x of [-1.4, 1.4]) {
				const leg = new THREE.Mesh(legGeo, glow);
				leg.position.set(x, 0.5, 0);
				g.add(leg);
			}
			const disc = new THREE.Mesh(new THREE.CircleGeometry(1.2, 40), floor);
			disc.rotation.x = -Math.PI / 2;
			disc.position.y = 0.03;
			const tag = document.createElement("div");
			tag.className = "rj-portal";
			tag.textContent = `🚪 ${p.name}`;
			const label = new CSS2DObject(tag);
			label.position.y = 2.9;
			g.add(arch, disc, label);
			g.position.set(p.pos[0], heightAt(p.pos[0], p.pos[1]) ?? 0, p.pos[1]);
			scene.add(g);
			this.objects.push(g);
		}
	}

	/** The portal within reach of `pos`, nearest first, or null. */
	near(pos: Vec2): Portal | null {
		let best: { p: Portal; d: number } | null = null;
		for (const p of this.portals) {
			const d = Math.hypot(p.pos[0] - pos[0], p.pos[1] - pos[1]);
			if (d <= PORTAL_REACH && (!best || d < best.d)) best = { p, d };
		}
		return best?.p ?? null;
	}

	/** The portal an object belongs to (a click on the arch), or null. */
	portalOf(o: THREE.Object3D | null): Portal | null {
		while (o && !o.name.startsWith("portal:")) o = o.parent;
		return o ? (this.portals.find((p) => `portal:${p.id}` === o?.name) ?? null) : null;
	}
}
