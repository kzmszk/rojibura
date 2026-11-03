// Portals to other areas (docs/prd.md 3.8): an arch with its name, and which one you are standing at. A quiet
// portal (a door that is a way in) has no arch, and its name shows only close by.

import type { Portal, Vec2 } from "@rojibura/protocol";
import * as THREE from "three";
import { signSprite } from "./signs.ts";

/** Standing this close to a portal offers the way through (metres). */
export const PORTAL_REACH = 3;
/** A quiet portal's name shows within this distance (metres). */
const QUIET_NAME_M = 12;

export class PortalsView {
	readonly objects: THREE.Object3D[] = [];
	private readonly portals: Portal[];
	private readonly quietNames: { pos: Vec2; sign: THREE.Sprite }[] = [];

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
		const faint = floor.clone();
		faint.opacity = 0.14;
		for (const p of portals) {
			const g = new THREE.Group();
			g.name = `portal:${p.id}`;
			const disc = new THREE.Mesh(new THREE.CircleGeometry(1.2, 40), p.quiet ? faint : floor);
			disc.rotation.x = -Math.PI / 2;
			disc.position.y = 0.03;
			g.add(disc);
			if (!p.quiet) {
				const arch = new THREE.Mesh(new THREE.TorusGeometry(1.4, 0.09, 12, 48, Math.PI), glow);
				arch.position.y = 1.0;
				const legGeo = new THREE.CylinderGeometry(0.09, 0.09, 1.0, 12);
				for (const x of [-1.4, 1.4]) {
					const leg = new THREE.Mesh(legGeo, glow);
					leg.position.set(x, 0.5, 0);
					g.add(leg);
				}
				g.add(arch);
			}
			const sign = signSprite(`🚪 ${p.name}`, { background: "rgba(20, 90, 140, .82)", color: "#fff" });
			sign.position.y = p.quiet ? 2.2 : 2.6;
			g.add(sign);
			if (p.quiet) {
				sign.visible = false;
				this.quietNames.push({ pos: p.pos, sign });
			}
			g.position.set(p.pos[0], heightAt(p.pos[0], p.pos[1]) ?? 0, p.pos[1]);
			scene.add(g);
			this.objects.push(g);
		}
	}

	/** Shows the names of quiet portals close to `pos` (yours). */
	update(pos: Vec2 | null): void {
		for (const q of this.quietNames)
			q.sign.visible = pos !== null && Math.hypot(q.pos[0] - pos[0], q.pos[1] - pos[1]) <= QUIET_NAME_M;
	}

	/** The portal within reach of `pos`, nearest first, or null. */
	near(pos: Vec2): Portal | null {
		const p = this.nearest(pos);
		return p && Math.hypot(p.pos[0] - pos[0], p.pos[1] - pos[1]) <= PORTAL_REACH ? p : null;
	}

	/** The portal nearest to `pos` (in a straight line), or null if the area has none. */
	nearest(pos: Vec2): Portal | null {
		let best: { p: Portal; d: number } | null = null;
		for (const p of this.portals) {
			const d = Math.hypot(p.pos[0] - pos[0], p.pos[1] - pos[1]);
			if (!best || d < best.d) best = { p, d };
		}
		return best?.p ?? null;
	}

	/** The portal an object belongs to (a click on the arch), or null. */
	portalOf(o: THREE.Object3D | null): Portal | null {
		while (o && !o.name.startsWith("portal:")) o = o.parent;
		return o ? (this.portals.find((p) => `portal:${p.id}` === o?.name) ?? null) : null;
	}
}
