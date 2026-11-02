// Things in the air near the camera: cherry petals drifting down in spring, leaves tumbling from the trees in
// autumn (both from the crowns of trees near the camera, simulated on the CPU), and snow falling gently
// in winter (a box of flakes that travels with the camera, moved in the shader).

import * as THREE from "three";
import { patch } from "./glsl.ts";
import { Rng } from "./rng.ts";
import type { Season } from "./season.ts";
import { CELL, SINGLE, SPECIES, type Species } from "./species.ts";
import { ATLAS_N } from "./treegen.ts";

interface Tree {
	sp: Species;
	x: number;
	y: number;
	z: number;
	h: number;
	rad: number;
}

interface Bit {
	alive: boolean;
	p: THREE.Vector3;
	v: THREE.Vector3;
	axis: THREE.Vector3;
	angle: number;
	spin: number;
	phase: number;
	ground: number;
	/** Seconds lying on the ground so far (then it fades). */
	rest: number;
	size: number;
	single: number;
	color: THREE.Color;
}

const MAX_BITS = 700;
/** Trees within this distance shed what falls (metres). */
const REACH = 38;

/** Leaves and petals falling from trees near the camera. */
export class Falling {
	readonly mesh: THREE.InstancedMesh;
	private readonly bits: Bit[] = [];
	private readonly r = new Rng(99);
	private season: Season = "autumn";
	private trees: Tree[] = [];
	private treesAt = new THREE.Vector3(1e9, 0, 0);
	private readonly m = new THREE.Matrix4();
	private readonly q = new THREE.Quaternion();
	private readonly s = new THREE.Vector3();
	private spawnDebt = 0;

	private readonly nearTrees: (x: number, z: number, r: number) => Tree[];
	private readonly heightAt: (x: number, z: number) => number | null;

	constructor(
		atlas: THREE.Texture,
		nearTrees: (x: number, z: number, r: number) => Tree[],
		heightAt: (x: number, z: number) => number | null,
	) {
		this.nearTrees = nearTrees;
		this.heightAt = heightAt;
		const g = new THREE.PlaneGeometry(1, 1);
		g.setAttribute("aSingle", new THREE.InstancedBufferAttribute(new Float32Array(MAX_BITS), 1));
		const mat = new THREE.MeshStandardMaterial({
			map: atlas,
			side: THREE.DoubleSide,
			alphaTest: 0.5,
			roughness: 0.8,
		});
		const cu = CELL.singles % ATLAS_N;
		const cv = Math.floor(CELL.singles / ATLAS_N);
		mat.onBeforeCompile = (shader) => {
			let v = patch(shader.vertexShader, "#include <common>", "#include <common>\nattribute float aSingle;");
			v = patch(
				v,
				"#include <uv_vertex>",
				/* glsl */ `
				#include <uv_vertex>
				{
					float k = floor(aSingle + 0.5);
					vec2 sub = vec2(mod(k, 4.0), floor(k / 4.0));
					vMapUv = (vec2(${cu}.0, ${cv}.0) + (sub + vec2(uv.x, 1.0 - uv.y)) / 4.0) / ${ATLAS_N}.0;
				}
				`,
			);
			shader.vertexShader = v;
			shader.fragmentShader = patch(
				shader.fragmentShader,
				"#include <map_fragment>",
				/* glsl */ `
				vec4 tx = texture2D(map, vMapUv);
				diffuseColor.rgb *= tx.r * 1.1 + 0.2;
				diffuseColor.a = tx.a;
				`,
			);
		};
		mat.customProgramCacheKey = () => "nature-falling";
		this.mesh = new THREE.InstancedMesh(g, mat, MAX_BITS);
		this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
		this.mesh.setColorAt(0, new THREE.Color());
		this.mesh.frustumCulled = false;
		this.mesh.count = 0;
		this.mesh.name = "nature:falling";
		for (let i = 0; i < MAX_BITS; i++) {
			this.bits.push({
				alive: false,
				p: new THREE.Vector3(),
				v: new THREE.Vector3(),
				axis: new THREE.Vector3(0, 1, 0),
				angle: 0,
				spin: 0,
				phase: 0,
				ground: 0,
				rest: 0,
				size: 0.05,
				single: 0,
				color: new THREE.Color(),
			});
		}
	}

	setSeason(season: Season): void {
		this.season = season;
		for (const b of this.bits) b.alive = false;
	}

	private spawn(b: Bit, cam: THREE.Vector3): boolean {
		const petals = this.season === "spring";
		const pool = this.trees.filter((t) => (petals ? t.sp === "sakura" : SPECIES[t.sp].litter > 0));
		if (!pool.length) return false;
		const t = this.r.pick(pool);
		const a = this.r.range(0, Math.PI * 2);
		const d = t.rad * Math.sqrt(this.r.next()) * 0.9;
		b.p.set(t.x + Math.cos(a) * d, t.y + t.h * this.r.range(0.45, 0.9), t.z + Math.sin(a) * d);
		// nearer the camera is where it shows
		if (b.p.distanceTo(cam) > REACH) return false;
		b.ground = this.heightAt(b.p.x, b.p.z) ?? t.y;
		b.v.set(this.r.normal(0.2), 0, this.r.normal(0.2));
		b.axis.set(this.r.normal(), this.r.normal(), this.r.normal()).normalize();
		b.angle = this.r.range(0, 6.28);
		b.spin = this.r.range(1.5, 5) * (this.r.next() < 0.5 ? -1 : 1);
		b.phase = this.r.range(0, 6.28);
		b.rest = 0;
		const sp = SPECIES[t.sp];
		if (petals) {
			b.size = this.r.range(0.018, 0.026);
			b.single = this.r.next() < 0.5 ? SINGLE.petal : SINGLE.petal2;
			b.color.setRGB(0.98, 0.84, 0.88).multiplyScalar(this.r.range(0.95, 1.05));
		} else {
			b.size =
				t.sp === "platanus"
					? this.r.range(0.14, 0.2)
					: t.sp === "momiji"
						? this.r.range(0.06, 0.08)
						: this.r.range(0.07, 0.1);
			b.single = t.sp === "momiji" && this.r.next() < 0.5 ? SINGLE.momiji2 : sp.single;
			const ramp = sp.ramps.autumn;
			const p = Math.min(1, Math.max(0, ramp.base + this.r.normal(0.18) + 0.1));
			const x = p * 5;
			const i = Math.min(4, Math.floor(x));
			const c0 = ramp.stops[i] as [number, number, number];
			const c1 = ramp.stops[i + 1] as [number, number, number];
			const f = x - i;
			b.color.setRGB(c0[0] + (c1[0] - c0[0]) * f, c0[1] + (c1[1] - c0[1]) * f, c0[2] + (c1[2] - c0[2]) * f);
		}
		b.alive = true;
		return true;
	}

	update(dt: number, camera: THREE.Camera, now: number, wind: THREE.Vector3): void {
		const on = this.season !== "winter";
		this.mesh.visible = on;
		if (!on) return;
		const cam = camera.getWorldPosition(new THREE.Vector3());
		if (cam.distanceToSquared(this.treesAt) > 25) {
			this.trees = this.nearTrees(cam.x, cam.z, REACH + 10);
			this.treesAt.copy(cam);
		}
		const petals = this.season === "spring";
		// how many start falling per second, from the trees around
		const rate = Math.min(petals ? 90 : 45, this.trees.length * (petals ? 9 : 3));
		this.spawnDebt += rate * Math.min(dt, 0.1);
		let n = 0;
		const singles = this.mesh.geometry.getAttribute("aSingle") as THREE.InstancedBufferAttribute;
		for (const b of this.bits) {
			if (!b.alive && this.spawnDebt >= 1) {
				this.spawnDebt--;
				if (!this.spawn(b, cam)) continue;
			}
			if (!b.alive) continue;
			if (b.p.y > b.ground + 0.01) {
				// flutter: a sideways swing as it falls, carried by the wind
				const fall = petals ? 0.55 : 0.9;
				const sw = Math.sin(now * (petals ? 2.2 : 1.7) + b.phase);
				b.v.x += (wind.x * (petals ? 1.1 : 0.7) - b.v.x) * dt * 0.8;
				b.v.z += (wind.z * (petals ? 1.1 : 0.7) - b.v.z) * dt * 0.8;
				b.p.x += (b.v.x + sw * 0.35) * dt;
				b.p.z += (b.v.z + Math.cos(now * 1.3 + b.phase) * 0.25) * dt;
				b.p.y -= fall * (0.75 + 0.5 * Math.abs(sw)) * dt;
				b.angle += b.spin * dt;
				if (b.p.y <= b.ground + 0.01) {
					b.p.y = b.ground + 0.012;
					b.axis.set(1, 0, 0);
					b.angle = -Math.PI / 2;
				}
			} else {
				b.rest += dt;
				if (b.rest > 6) {
					b.alive = false;
					continue;
				}
			}
			if (b.p.distanceToSquared(cam) > (REACH + 8) ** 2) {
				b.alive = false;
				continue;
			}
			this.q.setFromAxisAngle(b.axis, b.angle);
			const k = b.rest > 4 ? Math.max(0, 1 - (b.rest - 4) / 2) : 1;
			this.s.setScalar(b.size * k);
			this.m.compose(b.p, this.q, this.s);
			this.mesh.setMatrixAt(n, this.m);
			this.mesh.setColorAt(n, b.color);
			(singles.array as Float32Array)[n] = b.single;
			n++;
		}
		this.spawnDebt = Math.min(this.spawnDebt, 20);
		this.mesh.count = n;
		this.mesh.instanceMatrix.needsUpdate = true;
		if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
		singles.needsUpdate = true;
	}

	dispose(): void {
		this.mesh.removeFromParent();
		this.mesh.geometry.dispose();
		(this.mesh.material as THREE.Material).dispose();
		this.mesh.dispose();
	}
}

/** Snow falling gently around the camera: flakes in a box that wraps with the camera, drifting as they fall. */
export class Snowfall {
	readonly mesh: THREE.Mesh;
	private readonly mat: THREE.ShaderMaterial;
	private amount = 0;
	private on = false;

	constructor(count = 7000, half = 26) {
		const g = new THREE.InstancedBufferGeometry();
		g.setAttribute(
			"position",
			new THREE.BufferAttribute(
				new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]),
				3,
			),
		);
		g.setIndex([0, 1, 2, 0, 2, 3]);
		const seeds = new Float32Array(count * 4);
		const r = new Rng(31);
		for (let i = 0; i < seeds.length; i++) seeds[i] = r.next();
		g.setAttribute("aSeed", new THREE.InstancedBufferAttribute(seeds, 4));
		g.instanceCount = count;
		this.mat = new THREE.ShaderMaterial({
			transparent: true,
			depthWrite: false,
			fog: true,
			uniforms: THREE.UniformsUtils.merge([
				THREE.UniformsLib.fog,
				{
					uTime: { value: 0 },
					uAmount: { value: 0 },
					uHalf: { value: half },
					uWind: { value: new THREE.Vector3() },
					uLight: { value: new THREE.Color(1, 1, 1) },
				},
			]),
			vertexShader: /* glsl */ `
				attribute vec4 aSeed;
				uniform float uTime;
				uniform float uHalf;
				uniform vec3 uWind;
				varying vec2 vUv;
				varying float vFade;
				#include <fog_pars_vertex>
				void main() {
					float box = uHalf * 2.0;
					float fall = uTime * (0.55 + aSeed.w * 0.45);
					vec3 local = aSeed.xyz * box;
					local.y -= fall;
					local.x += sin(uTime * 0.6 + aSeed.w * 20.0) * 0.5 + uWind.x * uTime * 0.5;
					local.z += cos(uTime * 0.5 + aSeed.z * 17.0) * 0.5 + uWind.z * uTime * 0.5;
					vec3 rel = local - cameraPosition + uHalf;
					vec3 wp = (fract(rel / box) * box) - uHalf + cameraPosition;
					vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
					vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
					float size = 0.012 + aSeed.w * 0.014;
					vec3 p = wp + (right * position.x + up * position.y) * size;
					vUv = position.xy + 0.5;
					float d = length(wp - cameraPosition);
					vFade = smoothstep(uHalf, uHalf * 0.55, d) * smoothstep(0.15, 0.9, d);
					vec4 mvPosition = viewMatrix * vec4(p, 1.0);
					gl_Position = projectionMatrix * mvPosition;
					#include <fog_vertex>
				}`,
			fragmentShader: /* glsl */ `
				uniform float uAmount;
				uniform vec3 uLight;
				varying vec2 vUv;
				varying float vFade;
				#include <fog_pars_fragment>
				void main() {
					float d = length(vUv - 0.5) * 2.0;
					float a = smoothstep(1.0, 0.25, d) * vFade * uAmount * 0.9;
					if (a < 0.01) discard;
					gl_FragColor = vec4(uLight, a);
					#include <colorspace_fragment>
					#include <fog_fragment>
				}`,
		});
		this.mesh = new THREE.Mesh(g, this.mat);
		this.mesh.frustumCulled = false;
		this.mesh.renderOrder = 10;
		this.mesh.name = "nature:snowfall";
		this.mesh.visible = false;
	}

	setSeason(season: Season): void {
		this.on = season === "winter";
	}

	update(dt: number, now: number, wind: THREE.Vector3, light: THREE.Color): void {
		this.amount += ((this.on ? 1 : 0) - this.amount) * Math.min(1, dt * 1.5);
		this.mesh.visible = this.amount > 0.01;
		const u = this.mat.uniforms as Record<string, THREE.IUniform>;
		(u.uTime as THREE.IUniform).value = now;
		(u.uAmount as THREE.IUniform).value = this.amount;
		((u.uWind as THREE.IUniform).value as THREE.Vector3).copy(wind);
		((u.uLight as THREE.IUniform).value as THREE.Color).copy(light);
	}

	dispose(): void {
		this.mesh.removeFromParent();
		this.mesh.geometry.dispose();
		this.mat.dispose();
	}
}
