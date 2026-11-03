// Seasonal looks for the city glb, by material (or mesh) name prefix:
//   grass, moss, hedge   tinted by season (patchy in autumn)
//   water_pond           moving ripples, sky reflected by Fresnel, the sun's glint
//   water_onsen          milky white (乳白色), gentle ripples, steam rising softly over it
//   water_onsen_clear    clear hot water: see-through (the bathers' bodies and the pebbles under it show), more
//                        so looking down into it than across it, with the same ripples and steam
//   snow_soft            deep fresh snow (meshes snow_soft_*): bright, bluish in shade, fine grain, glints
//   snow_trod            trampled snow on streets and paths (meshes snow_trod_*): greyer, footprints, wet patches
// snow_* meshes show only in winter. In winter every other up-facing surface (roofs, stone, timber, wood, ...)
// gets a dusting of snow by its normal. The glb's own materials are kept and put back when the season changes.

import * as THREE from "three";
import { makePuff } from "./atlas.ts";
import { NOISE, patch } from "./glsl.ts";
import { Rng } from "./rng.ts";
import { type Season, VIEWS } from "./season.ts";

type Kind =
	| "grass"
	| "moss"
	| "hedge"
	| "pond"
	| "onsen"
	| "onsenClear"
	| "snowSoft"
	| "snowTrod"
	| "dust"
	| "keep";

/** Shared, live values: time, sun, sky. */
export interface Env {
	uTime: { value: number };
	uSunDir: { value: THREE.Vector3 };
	uSunColor: { value: THREE.Color };
	uSkyZenith: { value: THREE.Color };
	uSkyHorizon: { value: THREE.Color };
}

/** Materials that never take snow (lights, glass, water, sky, the snow itself). */
const NO_DUST = /^(water|snow|glass|window|lamp|light|emissive|neon|fire|sky|steam|lantern)/;

export function kindOf(meshName: string, matName: string): Kind {
	const m = matName.toLowerCase();
	const o = meshName.toLowerCase();
	if (o.startsWith("snow_trod") || m.startsWith("snow_trod")) return "snowTrod";
	if (o.startsWith("snow_soft") || m.startsWith("snow_soft") || o.startsWith("snow_") || m.startsWith("snow"))
		return "snowSoft";
	if (m.startsWith("water_onsen_clear")) return "onsenClear";
	if (m.startsWith("water_onsen")) return "onsen";
	if (m.startsWith("water_pond")) return "pond";
	if (m.startsWith("grass")) return "grass";
	if (m.startsWith("moss")) return "moss";
	if (m.startsWith("hedge")) return "hedge";
	if (NO_DUST.test(m)) return "keep";
	return "dust";
}

const SNOW_RGB = "vec3(0.87, 0.9, 0.95)";

/** Vertex code: world position and normal for the nature patches. */
const WORLD_VARYINGS = /* glsl */ `
varying vec3 vNWP;
varying vec3 vNWN;
`;
function patchWorldVertex(src: string): string {
	let s = patch(src, "#include <common>", `#include <common>\n${WORLD_VARYINGS}`);
	s = patch(
		s,
		"#include <project_vertex>",
		/* glsl */ `#include <project_vertex>
		{
			vec4 nwp = vec4(transformed, 1.0);
			#ifdef USE_INSTANCING
			nwp = instanceMatrix * nwp;
			#endif
			vNWP = (modelMatrix * nwp).xyz;
			vNWN = normalize(mat3(modelMatrix) * objectNormal);
		}`,
	);
	return s;
}

interface Grade {
	a: [number, number, number];
	b: [number, number, number];
	amt: number;
	gain: number;
}
const GRADES: Record<"grass" | "moss" | "hedge", Record<Season, Grade>> = {
	grass: {
		spring: { a: [0.2, 0.5, 0.07], b: [0.26, 0.52, 0.08], amt: 0.35, gain: 1.05 },
		autumn: { a: [0.36, 0.4, 0.1], b: [0.42, 0.33, 0.12], amt: 0.5, gain: 0.95 },
		winter: { a: [0.36, 0.33, 0.18], b: [0.3, 0.3, 0.16], amt: 0.55, gain: 0.82 },
	},
	moss: {
		spring: { a: [0.16, 0.4, 0.06], b: [0.2, 0.42, 0.08], amt: 0.3, gain: 1.05 },
		autumn: { a: [0.22, 0.34, 0.08], b: [0.28, 0.32, 0.08], amt: 0.3, gain: 1.0 },
		winter: { a: [0.2, 0.26, 0.1], b: [0.22, 0.25, 0.12], amt: 0.4, gain: 0.85 },
	},
	hedge: {
		spring: { a: [0.18, 0.45, 0.08], b: [0.24, 0.48, 0.08], amt: 0.3, gain: 1.05 },
		// dodan-tsutsuji and the like turn scarlet in patches
		autumn: { a: [0.28, 0.3, 0.08], b: [0.55, 0.1, 0.04], amt: 0.4, gain: 0.95 },
		winter: { a: [0.14, 0.2, 0.08], b: [0.18, 0.2, 0.1], amt: 0.3, gain: 0.8 },
	},
};

/** A copy of a glb material with a seasonal tint and/or a dusting of snow on what faces up. */
function seasonal(orig: THREE.Material, grade: Grade | null, dust: number, dustLo: number): THREE.Material {
	const m = orig.clone();
	const uniforms = {
		uGradeA: { value: new THREE.Vector3(...(grade?.a ?? [0, 0, 0])) },
		uGradeB: { value: new THREE.Vector3(...(grade?.b ?? [0, 0, 0])) },
		uGradeAmt: { value: grade?.amt ?? 0 },
		uGradeGain: { value: grade?.gain ?? 1 },
		uDust: { value: dust },
		uDustLo: { value: dustLo },
	};
	// the glb material's own patch (the Sagrada Família's projected stone, triplanar.ts) comes first
	const own = orig.onBeforeCompile.bind(orig);
	const ownKey = orig.customProgramCacheKey();
	m.onBeforeCompile = (shader, renderer) => {
		own(shader, renderer);
		Object.assign(shader.uniforms, uniforms);
		shader.vertexShader = patchWorldVertex(shader.vertexShader);
		let f = patch(
			shader.fragmentShader,
			"#include <common>",
			/* glsl */ `#include <common>
			${WORLD_VARYINGS}
			uniform vec3 uGradeA; uniform vec3 uGradeB; uniform float uGradeAmt; uniform float uGradeGain;
			uniform float uDust; uniform float uDustLo;
			${NOISE}`,
		);
		f = patch(
			f,
			"#include <color_fragment>",
			/* glsl */ `#include <color_fragment>
			if (uGradeAmt > 0.0) {
				float gn = fbm2(vNWP.xz * 0.11);
				vec3 tgt = mix(uGradeA, uGradeB, smoothstep(0.38, 0.62, gn));
				float l = dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722));
				float lt = dot(tgt, vec3(0.2126, 0.7152, 0.0722));
				diffuseColor.rgb = mix(diffuseColor.rgb, tgt * (l / max(lt, 1e-3)), uGradeAmt) * uGradeGain;
			}
			float dust = 0.0;
			if (uDust > 0.0) {
				float dn = vnoise3(vNWP * 1.3) * 0.6 + vnoise3(vNWP * 5.0) * 0.4;
				dust = smoothstep(uDustLo, uDustLo + 0.22, vNWN.y + (dn - 0.5) * 0.35) * uDust;
				float grain = vnoise3(vNWP * 31.0);
				diffuseColor.rgb = mix(diffuseColor.rgb, ${SNOW_RGB} * (0.93 + 0.05 * dn + 0.04 * grain), dust);
			}`,
		);
		if (f.includes("#include <roughnessmap_fragment>"))
			f = patch(
				f,
				"#include <roughnessmap_fragment>",
				"#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.85, dust);",
			);
		if (f.includes("#include <metalnessmap_fragment>"))
			f = patch(
				f,
				"#include <metalnessmap_fragment>",
				"#include <metalnessmap_fragment>\nmetalnessFactor = mix(metalnessFactor, 0.0, dust);",
			);
		if (f.includes("#include <normal_fragment_maps>"))
			f = patch(
				f,
				"#include <normal_fragment_maps>",
				"#include <normal_fragment_maps>\nnormal = normalize(mix(normal, nonPerturbedNormal, dust));",
			);
		// snow in the shade reads blue, as on the deep snow (city snow materials)
		f = patch(
			f,
			"#include <lights_fragment_end>",
			"#include <lights_fragment_end>\nreflectedLight.indirectDiffuse *= mix(vec3(1.0), vec3(0.86, 0.94, 1.1), dust);\nreflectedLight.indirectDiffuse += diffuseColor.rgb * vec3(0.03, 0.045, 0.07) * dust;",
		);
		shader.fragmentShader = f;
	};
	m.customProgramCacheKey = () => `nature-seasonal-${orig.type}-${ownKey}`;
	return m;
}

/** Water: ripples by moving noise, Fresnel sky, the sun's glint (standard specular on the rippled normal). */
function water(
	env: Env,
	onsen: boolean,
	clear = false,
): { mat: THREE.MeshStandardMaterial; rip: { value: number } } {
	const rip = { value: onsen ? 0.05 : 0.07 };
	const mat = new THREE.MeshStandardMaterial({
		color: clear
			? new THREE.Color(0.28, 0.52, 0.52)
			: onsen
				? new THREE.Color(0.74, 0.77, 0.7)
				: new THREE.Color(0.035, 0.07, 0.07),
		roughness: onsen ? 0.16 : 0.05,
		metalness: 0,
	});
	if (clear) {
		// drawn after what is under it, which shows through
		mat.transparent = true;
		mat.depthWrite = false;
		mat.defines = { RJ_CLEAR: "" };
	}
	mat.onBeforeCompile = (shader) => {
		Object.assign(shader.uniforms, env, { uRip: rip, uReflect: { value: onsen ? 0.5 : 0.75 } });
		shader.vertexShader = patchWorldVertex(shader.vertexShader);
		let f = patch(
			shader.fragmentShader,
			"#include <common>",
			/* glsl */ `#include <common>
			${WORLD_VARYINGS}
			uniform float uTime; uniform float uRip; uniform float uReflect;
			uniform vec3 uSkyZenith; uniform vec3 uSkyHorizon;
			${NOISE}
			float wave(vec2 p, float t) {
				return vnoise2(p * 0.6 + t * vec2(0.21, 0.13)) * 0.6 + vnoise2(p * 1.5 - t * vec2(0.17, 0.29)) * 0.3
					+ vnoise2(p * 3.7 + t * vec2(0.4, -0.33)) * 0.1;
			}`,
		);
		f = patch(
			f,
			"#include <normal_fragment_maps>",
			/* glsl */ `
			vec2 wpp = vNWP.xz;
			float e = 0.04;
			float h0 = wave(wpp, uTime);
			float hx = wave(wpp + vec2(e, 0.0), uTime);
			float hz = wave(wpp + vec2(0.0, e), uTime);
			vec3 nW = normalize(vec3(-(hx - h0) / e * uRip, 1.0, -(hz - h0) / e * uRip));
			normal = normalize((viewMatrix * vec4(nW, 0.0)).xyz);
			`,
		);
		f = patch(
			f,
			"#include <opaque_fragment>",
			/* glsl */ `
			{
				vec3 Vw = normalize(cameraPosition - vNWP);
				float fr = 0.02 + 0.98 * pow(1.0 - max(dot(nW, Vw), 0.0), 5.0);
				vec3 R = reflect(-Vw, nW);
				// the far shore and its trees darken the low reflections; the sky shows higher up
				vec3 sky = mix(uSkyHorizon * 0.45, uSkyZenith, smoothstep(0.02, 0.5, R.y));
				outgoingLight = mix(outgoingLight, sky, fr * uReflect);
				#ifdef RJ_CLEAR
				// looking down into it one sees through; across it, mostly the sky
				diffuseColor.a = mix(0.34, 0.92, fr);
				#endif
			}
			#include <opaque_fragment>`,
		);
		shader.fragmentShader = f;
	};
	mat.customProgramCacheKey = () => `nature-water-${onsen}-${clear}`;
	return { mat, rip };
}

/** Sparkles: tiny facets that catch the sun as the view moves (shared by both snows). */
const GLINT = /* glsl */ `
float glint(vec3 wp, vec3 Vw, float density) {
	vec3 cellp = floor(wp * 70.0);
	float h = nHash3(cellp);
	vec3 rn = normalize(vec3(nHash3(cellp + 1.7), nHash3(cellp + 3.1), nHash3(cellp + 5.3)) - 0.5 + vec3(0.0, 0.55, 0.0));
	vec3 Hh = normalize(uSunDir + Vw);
	float g = step(1.0 - density, h) * pow(max(dot(rn, Hh), 0.0), 220.0);
	return g * smoothstep(28.0, 5.0, length(cameraPosition - wp));
}`;

/** Fresh soft snow (trod = false) or trampled snow on paths (trod = true). */
function snowMaterial(
	env: Env,
	tex: Record<string, THREE.Texture>,
	trod: boolean,
): THREE.MeshStandardMaterial {
	const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: trod ? 0.8 : 0.72, metalness: 0 });
	const uniforms = {
		uAlb: { value: trod ? tex.trod : tex.snow },
		uNrm: { value: trod ? tex.trodN : tex.snowN },
		uSlush: { value: tex.slush },
		uTile: { value: trod ? 2.5 : 2.0 },
	};
	mat.onBeforeCompile = (shader) => {
		Object.assign(shader.uniforms, env, uniforms);
		shader.vertexShader = patchWorldVertex(shader.vertexShader);
		let f = patch(
			shader.fragmentShader,
			"#include <common>",
			/* glsl */ `#include <common>
			${WORLD_VARYINGS}
			uniform float uTime; uniform vec3 uSunDir; uniform vec3 uSunColor;
			uniform sampler2D uAlb; uniform sampler2D uNrm; uniform sampler2D uSlush; uniform float uTile;
			${NOISE}
			${GLINT}
			vec3 triW(vec3 n) { vec3 w = pow(abs(n), vec3(4.0)); return w / (w.x + w.y + w.z); }
			vec4 tri(sampler2D t, vec3 p, vec3 w) {
				return texture2D(t, p.zy / uTile) * w.x + texture2D(t, p.xz / uTile) * w.y + texture2D(t, p.xy / uTile) * w.z;
			}
			// footprints: an oval dent per cell, two staggered grids, roughly along the path's run
			float prints(vec2 p) {
				float acc = 0.0;
				for (int k = 0; k < 2; k++) {
					vec2 q = p / 0.42 + float(k) * vec2(0.5, 0.37);
					vec2 c = floor(q);
					vec2 f = fract(q) - 0.5;
					float h = nHash2(c + float(k) * 7.1);
					if (h < 0.5) continue;
					vec2 off = (vec2(nHash2(c + 3.3), nHash2(c + 5.9)) - 0.5) * 0.45;
					float dir = (fbm2(c * 0.07) > 0.5 ? 0.0 : 1.5708) + (nHash2(c + 9.1) - 0.5) * 1.4;
					mat2 R = mat2(cos(dir), -sin(dir), sin(dir), cos(dir));
					vec2 d = R * (f - off);
					float e = length(d / vec2(0.3, 0.12));
					acc = max(acc, (1.0 - smoothstep(0.6, 1.0, e)) * (0.3 + 0.7 * (h - 0.5) * 2.0));
				}
				return acc;
			}`,
		);
		f = patch(
			f,
			"#include <color_fragment>",
			/* glsl */ `#include <color_fragment>
			vec3 tw = triW(vNWN);
			float L = dot(tri(uAlb, vNWP, tw).rgb, vec3(0.333));
			vec3 Vw = normalize(cameraPosition - vNWP);
			float grain = vnoise3(vNWP * 31.0);
			#ifdef SNOW_TROD
			float fp = prints(vNWP.xz);
			// mostly packed white-grey snow; wet slush only in patches (from afar the paths stay snowy)
			float wet = smoothstep(0.64, 0.8, fbm2(vNWP.xz * 0.22)) * 0.55;
			vec3 slush = texture2D(uSlush, vNWP.xz / 1.0).rgb;
			diffuseColor.rgb = vec3(0.8, 0.82, 0.86) * mix(1.0, L / 0.58, 0.55);
			diffuseColor.rgb *= 1.0 - fp * 0.07;
			diffuseColor.rgb = mix(diffuseColor.rgb, slush * 0.75, wet * 0.85);
			#else
			float fp = 0.0;
			float wet = 0.0;
			float macro = fbm2(vNWP.xz * 0.05);
			diffuseColor.rgb = vec3(0.88, 0.905, 0.94) * mix(1.0, L / 0.38, 0.16) * (0.97 + 0.06 * grain) * (0.96 + 0.08 * macro);
			#endif
			diffuseColor.rgb = clamp(diffuseColor.rgb, 0.0, 0.96);
			`,
		);
		f = patch(
			f,
			"#include <roughnessmap_fragment>",
			"#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.32, wet);",
		);
		f = patch(
			f,
			"#include <normal_fragment_maps>",
			/* glsl */ `
			{
				// world-space detail: the texture's normal on the dominant plane, fine grain, the prints' rims
				vec3 tn = tri(uNrm, vNWP, tw).xyz * 2.0 - 1.0;
				float s = 0.02;
				float g0 = vnoise3(vNWP * 40.0);
				vec3 gg = vec3(vnoise3(vNWP * 40.0 + vec3(s * 40.0, 0.0, 0.0)) - g0, 0.0, vnoise3(vNWP * 40.0 + vec3(0.0, 0.0, s * 40.0)) - g0);
				vec3 nW = normalize(vNWN + vec3(tn.x, 0.0, -tn.y) * tw.y * 0.35 + vec3(0.0, tn.y, tn.x) * tw.x * 0.5 + vec3(tn.x, tn.y, 0.0) * tw.z * 0.5 + gg * 0.6);
				#ifdef SNOW_TROD
				float fe = 0.03;
				float f0 = prints(vNWP.xz);
				vec2 fg = vec2(prints(vNWP.xz + vec2(fe, 0.0)) - f0, prints(vNWP.xz + vec2(0.0, fe)) - f0) / fe;
				nW = normalize(nW + vec3(fg.x, 0.0, fg.y) * 0.05);
				nW = normalize(mix(nW, vNWN, wet * 0.6));
				#endif
				normal = normalize((viewMatrix * vec4(nW, 0.0)).xyz);
			}`,
		);
		f = patch(
			f,
			"#include <lights_fragment_end>",
			/* glsl */ `#include <lights_fragment_end>
			{
				// shade lit by the sky reads blue; light scattered inside the snow lifts it
				reflectedLight.indirectDiffuse *= vec3(0.84, 0.93, 1.12);
				reflectedLight.indirectDiffuse += diffuseColor.rgb * vec3(0.035, 0.055, 0.085);
				// glints where the sun reaches (direct light, shadows included, against what it would be unshadowed)
				float ndl = max(dot(normalize(vNWN), uSunDir), 0.05);
				float full = dot(diffuseColor.rgb * uSunColor, vec3(0.333)) * ndl / PI;
				float lit = clamp(dot(reflectedLight.directDiffuse, vec3(0.333)) / max(full, 1e-4), 0.0, 1.0);
				#ifdef SNOW_TROD
				float gl = glint(vNWP, Vw, 0.015) * (1.0 - wet);
				#else
				float gl = glint(vNWP, Vw, 0.06);
				#endif
				reflectedLight.directSpecular += uSunColor * gl * lit * 3.0;
			}`,
		);
		shader.fragmentShader = f;
		if (trod) shader.defines = { ...(shader.defines ?? {}), SNOW_TROD: 1 };
	};
	mat.customProgramCacheKey = () => (trod ? "nature-snow-trod" : "nature-snow-soft");
	return mat;
}

/** Steam rising softly over the hot springs: puffs that grow and fade, moved in the shader. */
class Steam {
	readonly mesh: THREE.Mesh;
	private readonly mat: THREE.ShaderMaterial;

	constructor(boxes: THREE.Box3[], env: Env, puff: THREE.Texture) {
		const r = new Rng(17);
		const seeds: number[] = [];
		const box: number[] = [];
		const top: number[] = [];
		for (const b of boxes) {
			const sx = b.max.x - b.min.x;
			const sz = b.max.z - b.min.z;
			const n = Math.max(16, Math.min(400, Math.round(sx * sz * 0.7)));
			for (let i = 0; i < n; i++) {
				seeds.push(r.next(), r.next(), r.next(), r.next());
				box.push(b.min.x, b.min.z, sx, sz);
				top.push(b.max.y);
			}
		}
		const g = new THREE.InstancedBufferGeometry();
		g.setAttribute(
			"position",
			new THREE.BufferAttribute(
				new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]),
				3,
			),
		);
		g.setIndex([0, 1, 2, 0, 2, 3]);
		g.setAttribute("aSeed", new THREE.InstancedBufferAttribute(new Float32Array(seeds), 4));
		g.setAttribute("aBox", new THREE.InstancedBufferAttribute(new Float32Array(box), 4));
		g.setAttribute("aTop", new THREE.InstancedBufferAttribute(new Float32Array(top), 1));
		g.instanceCount = top.length;
		this.mat = new THREE.ShaderMaterial({
			transparent: true,
			depthWrite: false,
			fog: true,
			uniforms: THREE.UniformsUtils.merge([
				THREE.UniformsLib.fog,
				{
					uMap: { value: puff },
					uAmount: { value: 1 },
					uLight: { value: new THREE.Color(1, 1, 1) },
					uWind: { value: new THREE.Vector3() },
				},
			]),
		});
		this.mat.uniforms.uTime = env.uTime;
		this.mat.uniforms.uMap = { value: puff };
		this.mat.vertexShader = /* glsl */ `
			attribute vec4 aSeed;
			attribute vec4 aBox;
			attribute float aTop;
			uniform float uTime;
			uniform vec3 uWind;
			varying vec2 vUv;
			varying float vA;
			#include <fog_pars_vertex>
			void main() {
				float life = 6.0 + aSeed.w * 5.0;
				float t = fract(uTime / life + aSeed.x);
				vec3 base = vec3(aBox.x + aSeed.y * aBox.z, aTop + 0.05, aBox.y + aSeed.z * aBox.w);
				float age = t * life;
				vec3 c = base + vec3(
					uWind.x * age * 0.25 + sin(age * 0.9 + aSeed.x * 30.0) * 0.25,
					age * (0.22 + aSeed.w * 0.12),
					uWind.z * age * 0.25 + cos(age * 0.8 + aSeed.y * 21.0) * 0.25);
				float size = mix(0.7, 2.6, sqrt(t)) * (0.8 + aSeed.z * 0.5);
				vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
				vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
				float a = aSeed.y * 6.283 + age * 0.15;
				vec2 p = mat2(cos(a), -sin(a), sin(a), cos(a)) * position.xy;
				vec3 wp = c + (right * p.x + up * p.y) * size;
				vUv = position.xy + 0.5;
				float d = length(wp - cameraPosition);
				vA = pow(sin(3.14159 * t), 1.5) * smoothstep(0.6, 3.0, d);
				vec4 mvPosition = viewMatrix * vec4(wp, 1.0);
				gl_Position = projectionMatrix * mvPosition;
				#include <fog_vertex>
			}`;
		this.mat.fragmentShader = /* glsl */ `
			uniform sampler2D uMap;
			uniform float uAmount;
			uniform vec3 uLight;
			varying vec2 vUv;
			varying float vA;
			#include <fog_pars_fragment>
			void main() {
				float a = texture2D(uMap, vUv).a * vA * uAmount * 0.7;
				if (a < 0.004) discard;
				gl_FragColor = vec4(uLight, a);
				#include <colorspace_fragment>
				#include <fog_fragment>
			}`;
		this.mesh = new THREE.Mesh(g, this.mat);
		this.mesh.frustumCulled = false;
		this.mesh.renderOrder = 9;
		this.mesh.name = "nature:steam";
	}

	set(amount: number, light: THREE.Color, wind: THREE.Vector3): void {
		const u = this.mat.uniforms as Record<string, THREE.IUniform>;
		(u.uAmount as THREE.IUniform).value = amount;
		((u.uLight as THREE.IUniform).value as THREE.Color).copy(light);
		((u.uWind as THREE.IUniform).value as THREE.Vector3).copy(wind);
	}

	dispose(): void {
		this.mesh.removeFromParent();
		this.mesh.geometry.dispose();
		this.mat.dispose();
	}
}

interface Entry {
	mesh: THREE.Mesh;
	orig: THREE.Material | THREE.Material[];
	kinds: Kind[];
}

export class CityLooks {
	private readonly entries: Entry[] = [];
	private readonly cache = new Map<string, THREE.Material>();
	private readonly tex: Record<string, THREE.Texture>;
	private readonly pond: ReturnType<typeof water>;
	private readonly onsen: ReturnType<typeof water>;
	private readonly onsenClear: ReturnType<typeof water>;
	private readonly snowSoft: THREE.MeshStandardMaterial;
	private readonly snowTrod: THREE.MeshStandardMaterial;
	private readonly puff = makePuff();
	private steam: Steam | null = null;
	private season: Season = "autumn";

	private readonly scene: THREE.Scene;
	private readonly env: Env;

	constructor(scene: THREE.Scene, env: Env, texBase: string) {
		this.scene = scene;
		this.env = env;
		const loader = new THREE.TextureLoader();
		const load = (name: string, srgb: boolean): THREE.Texture => {
			const t = loader.load(`${texBase}${name}`);
			t.wrapS = t.wrapT = THREE.RepeatWrapping;
			t.anisotropy = 8;
			if (srgb) t.colorSpace = THREE.SRGBColorSpace;
			return t;
		};
		this.tex = {
			snow: load("snow.jpg", true),
			snowN: load("snow_nrm.jpg", false),
			trod: load("trod.jpg", true),
			trodN: load("trod_nrm.jpg", false),
			slush: load("slush.jpg", true),
		};
		this.pond = water(env, false);
		this.onsen = water(env, true);
		this.onsenClear = water(env, true, true);
		this.snowSoft = snowMaterial(env, this.tex, false);
		this.snowTrod = snowMaterial(env, this.tex, true);
	}

	apply(root: THREE.Object3D): void {
		const onsenBoxes: THREE.Box3[] = [];
		root.updateMatrixWorld(true);
		root.traverse((o) => {
			const mesh = o as THREE.Mesh;
			if (!mesh.isMesh || this.entries.some((e) => e.mesh === mesh)) return;
			const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
			const kinds = mats.map((m) => kindOf(mesh.name, m.name));
			this.entries.push({ mesh, orig: mesh.material, kinds });
			if (kinds.includes("onsen") || kinds.includes("onsenClear")) {
				mesh.geometry.computeBoundingBox();
				const b = (mesh.geometry.boundingBox as THREE.Box3).clone().applyMatrix4(mesh.matrixWorld);
				onsenBoxes.push(b);
			}
			if (kinds.includes("snowSoft") || kinds.includes("snowTrod")) {
				mesh.castShadow = false;
				mesh.receiveShadow = true;
			}
		});
		if (onsenBoxes.length) {
			this.steam?.dispose();
			this.steam = new Steam(onsenBoxes, this.env, this.puff);
			this.scene.add(this.steam.mesh);
		}
		this.setSeason(this.season);
	}

	private derived(orig: THREE.Material, kind: Kind, season: Season): THREE.Material {
		switch (kind) {
			case "snowSoft":
				return this.snowSoft;
			case "snowTrod":
				return this.snowTrod;
			case "pond":
				return this.pond.mat;
			case "onsen":
				return this.onsen.mat;
			case "onsenClear":
				return this.onsenClear.mat;
			case "keep":
				return orig;
			default:
				break;
		}
		const winter = season === "winter";
		if (kind === "dust" && !winter) return orig;
		const key = `${orig.uuid}/${season}`;
		let m = this.cache.get(key);
		if (!m) {
			const name = orig.name.toLowerCase();
			const grade = kind === "grass" || kind === "moss" || kind === "hedge" ? GRADES[kind][season] : null;
			// roofs hold the most snow; hedges and lawns a lot; other things what settles on their tops
			const dust = winter ? (name.startsWith("roof") ? 1 : grade ? 0.9 : 0.85) : 0;
			const lo = name.startsWith("roof") ? 0.42 : grade ? 0.5 : 0.62;
			m = seasonal(orig, grade, dust, lo);
			this.cache.set(key, m);
		}
		return m;
	}

	setSeason(season: Season): void {
		this.season = season;
		const winter = season === "winter";
		for (const e of this.entries) {
			const origs = Array.isArray(e.orig) ? e.orig : [e.orig];
			const mats = origs.map((m, i) => this.derived(m, e.kinds[i] as Kind, season));
			e.mesh.material = Array.isArray(e.orig) ? mats : (mats[0] as THREE.Material);
			if (e.kinds.includes("snowSoft") || e.kinds.includes("snowTrod")) e.mesh.visible = winter;
		}
		this.pond.rip.value = winter ? 0.025 : 0.07;
		const v = VIEWS[season];
		this.env.uSkyZenith.value.set(v.sky).multiplyScalar(0.85);
		this.env.uSkyHorizon.value.set(v.sky).lerp(new THREE.Color(1, 1, 1), 0.25);
	}

	update(light: THREE.Color, wind: THREE.Vector3): void {
		this.steam?.set(this.season === "winter" ? 1 : this.season === "autumn" ? 0.75 : 0.5, light, wind);
	}

	/** Puts every glb material back as it came. */
	restore(): void {
		for (const e of this.entries) {
			e.mesh.material = e.orig;
			if (e.kinds.includes("snowSoft") || e.kinds.includes("snowTrod")) e.mesh.visible = true;
		}
	}

	dispose(): void {
		this.restore();
		this.steam?.dispose();
		for (const m of this.cache.values()) m.dispose();
		for (const t of Object.values(this.tex)) t.dispose();
		this.pond.mat.dispose();
		this.onsen.mat.dispose();
		this.onsenClear.mat.dispose();
		this.snowSoft.dispose();
		this.snowTrod.dispose();
		this.puff.dispose();
	}
}
