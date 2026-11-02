// What lies under the trees: fallen leaves in autumn (thicker under maples and ginkgo, coloured like their tree)
// and fallen cherry petals in spring. Patches of many leaves (atlas cells), flat on the ground (heightAt), in
// chunks so far ones are culled.

import * as THREE from "three";
import { patch } from "./glsl.ts";
import { Rng } from "./rng.ts";
import type { Season } from "./season.ts";
import { CELL, SPECIES, type Species } from "./species.ts";
import { ATLAS_N } from "./treegen.ts";

const CHUNK = 60;
/** Chunks farther than this (centre to camera, metres) are hidden. */
const SHOW = 130;

interface Crown {
	sp: Species;
	x: number;
	y: number;
	z: number;
	rad: number;
	seed: number;
}

/** A colour from a species' autumn ramp at stage p (no shader at hand: the same walk on the CPU). */
function rampColor(sp: Species, season: Season, p: number, out: THREE.Color): THREE.Color {
	const st = SPECIES[sp].ramps[season].stops;
	const x = Math.min(1, Math.max(0, p)) * 5;
	const i = Math.min(4, Math.floor(x));
	const a = st[i] as [number, number, number];
	const b = st[i + 1] as [number, number, number];
	const f = x - i;
	return out.setRGB(a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f);
}

function cellQuad(cell: number): THREE.BufferGeometry {
	const g = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
	const uv = g.getAttribute("uv") as THREE.BufferAttribute;
	const cu = cell % ATLAS_N;
	const cv = Math.floor(cell / ATLAS_N);
	for (let i = 0; i < uv.count; i++) {
		uv.setXY(i, (cu + 0.01 + uv.getX(i) * 0.98) / ATLAS_N, (cv + 0.01 + (1 - uv.getY(i)) * 0.98) / ATLAS_N);
	}
	return g;
}

function coverMaterial(atlas: THREE.Texture): THREE.MeshStandardMaterial {
	const m = new THREE.MeshStandardMaterial({
		map: atlas,
		roughness: 0.9,
		alphaTest: 0.5,
		polygonOffset: true,
		polygonOffsetFactor: -2,
		polygonOffsetUnits: -4,
	});
	m.onBeforeCompile = (shader) => {
		shader.fragmentShader = patch(
			shader.fragmentShader,
			"#include <map_fragment>",
			/* glsl */ `
			vec4 tx = texture2D(map, vMapUv);
			// leaf by leaf a little warmer or cooler, lighter or darker
			diffuseColor.rgb *= mix(vec3(1.12, 0.92, 0.75), vec3(0.88, 1.04, 1.12), tx.g) * (tx.r * 1.1 + 0.2);
			diffuseColor.a = tx.a;
			`,
		);
	};
	m.customProgramCacheKey = () => "nature-cover";
	return m;
}

export class GroundCover {
	readonly group = new THREE.Group();
	private readonly chunks: { mesh: THREE.InstancedMesh; season: Season; cx: number; cz: number }[] = [];
	private readonly mat: THREE.MeshStandardMaterial;
	private readonly geos: THREE.BufferGeometry[] = [];
	private season: Season = "autumn";

	constructor(crowns: Crown[], heightAt: (x: number, z: number) => number | null, atlas: THREE.Texture) {
		this.group.name = "nature:ground";
		this.mat = coverMaterial(atlas);
		const litter = cellQuad(CELL.litter);
		const petals = cellQuad(CELL.petals);
		this.geos.push(litter, petals);
		const r = new Rng(4242);
		type Patch = { m: THREE.Matrix4; c: THREE.Color };
		const byChunk = new Map<string, { season: Season; cx: number; cz: number; items: Patch[] }>();
		// one height sample per patch; the slope once per tree (heightAt may be a raycast)
		let slope = new THREE.Vector3(0, 1, 0);
		const add = (season: Season, x: number, z: number, size: number, c: THREE.Color): void => {
			const y = heightAt(x, z);
			if (y === null) return;
			const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), slope);
			q.multiply(
				new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), r.range(0, Math.PI * 2)),
			);
			const m = new THREE.Matrix4().compose(
				new THREE.Vector3(x, y + 0.015, z),
				q,
				new THREE.Vector3(size, 1, size),
			);
			const cx = Math.floor(x / CHUNK);
			const cz = Math.floor(z / CHUNK);
			const key = `${season}/${cx}/${cz}`;
			let ch = byChunk.get(key);
			if (!ch) {
				ch = { season, cx, cz, items: [] };
				byChunk.set(key, ch);
			}
			ch.items.push({ m, c });
		};
		for (const t of crowns) {
			const sp = SPECIES[t.sp];
			const d = Math.max(1, t.rad * 0.6);
			const h = (dx: number, dz: number): number => heightAt(t.x + dx, t.z + dz) ?? t.y;
			slope = new THREE.Vector3(
				-(h(d, 0) - h(-d, 0)) / (2 * d),
				1,
				-(h(0, d) - h(0, -d)) / (2 * d),
			).normalize();
			const area = Math.PI * t.rad * t.rad;
			// autumn: leaves of the tree's own colours, most within the drip line
			const n = Math.round(sp.litter * 0.6 * area);
			for (let i = 0; i < n; i++) {
				const a = r.range(0, Math.PI * 2);
				const d = t.rad * 1.2 * r.next() ** 0.75;
				const p = SPECIES[t.sp].ramps.autumn.base + r.normal(0.25) + 0.05;
				const c = rampColor(t.sp, "autumn", p, new THREE.Color());
				// fallen leaves dry: a little browner and darker
				c.lerp(new THREE.Color(0.3, 0.17, 0.08), t.sp === "ichou" ? 0.08 : 0.22).multiplyScalar(
					t.sp === "ichou" ? 0.92 : 0.72,
				);
				// ginkgo carpets the ground under it
				const size = t.sp === "ichou" ? r.range(0.7, 1.2) : r.range(0.45, 0.85);
				add("autumn", t.x + Math.cos(a) * d, t.z + Math.sin(a) * d, size, c);
			}
			if (t.sp === "sakura") {
				const np = Math.round(1.0 * area);
				for (let i = 0; i < np; i++) {
					const a = r.range(0, Math.PI * 2);
					const d = t.rad * 1.25 * Math.sqrt(r.next());
					const c = new THREE.Color(0.98, 0.84, 0.88).multiplyScalar(r.range(0.92, 1.02));
					add("spring", t.x + Math.cos(a) * d, t.z + Math.sin(a) * d, r.range(1.0, 1.6), c);
				}
			}
		}
		for (const ch of byChunk.values()) {
			const mesh = new THREE.InstancedMesh(
				ch.season === "spring" ? petals : litter,
				this.mat,
				ch.items.length,
			);
			ch.items.forEach((it, i) => {
				mesh.setMatrixAt(i, it.m);
				mesh.setColorAt(i, it.c);
			});
			mesh.computeBoundingSphere();
			mesh.receiveShadow = true;
			mesh.name = `nature:cover:${ch.season}`;
			this.group.add(mesh);
			this.chunks.push({ mesh, season: ch.season, cx: (ch.cx + 0.5) * CHUNK, cz: (ch.cz + 0.5) * CHUNK });
		}
	}

	setSeason(season: Season): void {
		this.season = season;
	}

	update(camera: THREE.Camera): void {
		const p = camera.getWorldPosition(new THREE.Vector3());
		for (const c of this.chunks) {
			c.mesh.visible = c.season === this.season && Math.hypot(c.cx - p.x, c.cz - p.z) < SHOW + CHUNK * 0.7;
		}
	}

	/** Patches drawn (instances in visible chunks). */
	stats(): { draws: number; patches: number } {
		let draws = 0;
		let patches = 0;
		for (const c of this.chunks)
			if (c.mesh.visible) {
				draws++;
				patches += c.mesh.count;
			}
		return { draws, patches };
	}

	dispose(): void {
		this.group.removeFromParent();
		for (const c of this.chunks) c.mesh.dispose();
		for (const g of this.geos) g.dispose();
		this.mat.dispose();
	}
}
