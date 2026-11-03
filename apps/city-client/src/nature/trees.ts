// Trees: species templates (treegen.ts) drawn instanced, in three levels of detail: full trees near the camera
// (they alone cast shadows), light ones to the middle distance and camera-facing impostors beyond (baked from the
// templates at start and whenever the season changes). Broadleaf trees right by the camera (CLOSE) draw their
// leaves one by one instead of the cards (treegen.ts, issue 46). Instances are culled and sorted into their
// level every frame on the CPU; one draw per template, part and level that has trees in view.
// Leaves take their colour in the shader from the species' ramp for the season (species.ts), per tree, per
// card and leaf by leaf; bare trees in winter draw only their twig cards with the twig cell; snow lies on
// whatever faces up.

import * as THREE from "three";
import { makeLeafAtlas } from "./atlas.ts";
import { COTANGENT, NOISE, patch, type Uniforms } from "./glsl.ts";
import type { Season } from "./season.ts";
import { BARK_SIZE, CELL, SPECIES, SPECIES_NAMES, type Species, speciesIndex } from "./species.ts";
import {
	ATLAS_N,
	hasCloseLeaves,
	type LeafRect,
	makeTree,
	type PartMesh,
	type TreeTemplate,
	VARIANTS,
} from "./treegen.ts";

export interface TreeSpec {
	sp: Species;
	x: number;
	z: number;
	/** Scale, 1 = a typical adult. */
	s: number;
	/** Rotation about Y (radians). */
	r: number;
}

/** Broadleaf trees within this distance (metres) draw their leaves one by one; full trees within NEAR, light
 * ones to MID, impostors beyond. */
export const CLOSE = 13;
export const NEAR = 55;
export const MID = 140;
/** Trees this near are drawn even out of view: their shadows may fall into it. */
const SHADOW_KEEP = 40;

const NSP = SPECIES_NAMES.length;
const IMP_COLS = 6;
const IMP_W = 192;
const IMP_H = 384;

interface Placed {
	spec: TreeSpec;
	y: number;
	si: number;
	variant: number;
	seed: number;
	matrix: Float32Array;
	/** Bounding sphere centre height and radius (world). */
	cy: number;
	rad: number;
}

interface Group {
	tpl: TreeTemplate;
	si: number;
	variant: number;
	lod: 0 | 1;
	wood: THREE.InstancedMesh;
	leaves: THREE.InstancedMesh;
	/**
	 * The leaves one by one (full templates of broadleaf trees), for trees within CLOSE: made the first time one
	 * comes that close (`closeMade`), with its single leaf's rectangle in the atlas and room for `cap` trees.
	 */
	close: THREE.InstancedMesh | null;
	closeMade: boolean;
	rect: LeafRect | undefined;
	cap: number;
	/** Trees this frame: all (the wood), and those of them drawn with their leaves one by one. */
	n: number;
	nClose: number;
}

function geometry(m: PartMesh): THREE.BufferGeometry {
	const g = new THREE.BufferGeometry();
	g.setAttribute("position", new THREE.BufferAttribute(m.position, 3));
	g.setAttribute("normal", new THREE.BufferAttribute(m.normal, 3));
	g.setAttribute("uv", new THREE.BufferAttribute(m.uv, 2));
	g.setAttribute("aData", new THREE.BufferAttribute(m.data, 4));
	g.setIndex(new THREE.BufferAttribute(m.index, 1));
	return g;
}

/** Vertex code shared by trees and their shadows: instance data and sway in the wind. */
const VERT_PARS = /* glsl */ `
attribute vec4 aData;
attribute vec4 aInst;
uniform float uTime;
uniform float uWind;
uniform vec3 uWindDir;
varying vec4 vData;
varying vec4 vInst;
varying vec3 vWorldPos;
varying vec3 vWorldNrm;
varying vec2 vBarkUv;
vec3 sway(vec3 p, float w, vec3 root, vec3 dirL) {
	float ph = dot(root.xz, vec2(0.13, 0.17));
	float gust = 0.55 + 0.45 * sin(uTime * 0.31 + root.x * 0.021 + root.z * 0.017);
	float h = max(p.y, 0.0);
	// the whole tree bends (more with height), branches and leaves flutter
	vec3 o = dirL * (h * h * 0.0022 * uWind * gust * (0.65 + 0.35 * sin(uTime * 1.05 + ph)));
	o += vec3(sin(uTime * 2.1 + ph + p.y * 0.6), sin(uTime * 2.7 + ph * 1.3 + p.x * 0.8) * 0.6, sin(uTime * 2.4 + p.z * 0.7 + ph))
		* (w * w * 0.045 * uWind * (0.5 + gust));
	return o;
}
`;

const VERT_MAIN = /* glsl */ `
#include <begin_vertex>
vData = aData;
vInst = aInst;
vBarkUv = uv;
{
	vec3 root = instanceMatrix[3].xyz;
	vec3 dirL = normalize(transpose(mat3(instanceMatrix)) * uWindDir);
	#ifdef NATURE_LEAF
	transformed += sway(transformed, aData.w, root, dirL);
	#else
	transformed += sway(transformed, aData.x, root, dirL);
	#endif
	vWorldPos = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
	#ifndef NATURE_DEPTH
	vWorldNrm = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * objectNormal);
	#endif
}
`;

/** Fragment code: leaf colour ramps and snow. */
const FRAG_PARS = /* glsl */ `
uniform vec3 uRamp[${NSP * 6}];
uniform vec4 uRampP[${NSP}];
uniform vec2 uRampG[${NSP}];
uniform float uBare[${NSP}];
uniform vec3 uTwig[${NSP}];
uniform float uGlow[${NSP}];
uniform vec4 uBarkCell[${NSP}];
uniform vec3 uBarkTint[${NSP}];
uniform float uSnow;
uniform float uSpring;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform sampler2D uBarkNrm;
varying vec4 vData;
varying vec4 vInst;
varying vec3 vWorldPos;
varying vec3 vWorldNrm;
varying vec2 vBarkUv;
${NOISE}
vec3 rampAt(int sp, float p) {
	float x = clamp(p, 0.0, 1.0) * 5.0;
	int i = int(min(floor(x), 4.0));
	return mix(uRamp[sp * 6 + i], uRamp[sp * 6 + i + 1], smoothstep(0.0, 1.0, x - float(i)));
}
// seed: per tree; outer: the card's place in the crown (sunlit outside and top first); rnd: per card; lv: per leaf
vec3 leafColor(int sp, float seed, float outer, float rnd, float lv) {
	vec4 P = uRampP[sp];
	vec2 G = uRampG[sp];
	float t1 = fract(seed * 7.31);
	float stage = P.x + (t1 - 0.5) * P.y;
	if (fract(seed * 13.71) < G.x) stage = G.y + t1 * 0.12;
	float p = stage + (outer - 0.5) * P.z + (lv - 0.5) * P.w + (rnd - 0.5) * P.w * 0.5;
	return rampAt(sp, p) * (0.92 + 0.16 * rnd);
}
const vec3 SNOW = vec3(0.86, 0.89, 0.94);
`;

/** Colour of the fine twigs (linear), per species: what a bare crown is made of in winter. */
const TWIG: Partial<Record<Species, [number, number, number]>> = {
	sakura: [0.085, 0.055, 0.05],
	momiji: [0.11, 0.09, 0.075],
	kaede: [0.12, 0.1, 0.085],
	ichou: [0.12, 0.105, 0.09],
	keyaki: [0.13, 0.115, 0.095],
	nara: [0.11, 0.095, 0.08],
	platanus: [0.13, 0.115, 0.09],
	bodaiju: [0.1, 0.075, 0.06],
	shirakaba: [0.12, 0.065, 0.045],
};

export interface TreeUniforms {
	uTime: { value: number };
	uWind: { value: number };
	uWindDir: { value: THREE.Vector3 };
	uRamp: { value: THREE.Vector3[] };
	uRampP: { value: THREE.Vector4[] };
	uRampG: { value: THREE.Vector2[] };
	uBare: { value: number[] };
	uTwig: { value: THREE.Vector3[] };
	uGlow: { value: number[] };
	uCellShift: { value: THREE.Vector2[] };
	uBarkCell: { value: THREE.Vector4[] };
	uBarkTint: { value: THREE.Vector3[] };
	uSnow: { value: number };
	uSpring: { value: number };
	uSunDir: { value: THREE.Vector3 };
	uSunColor: { value: THREE.Color };
	uBarkNrm: { value: THREE.Texture | null };
}

export function makeTreeUniforms(): TreeUniforms {
	return {
		uTime: { value: 0 },
		uWind: { value: 1 },
		uWindDir: { value: new THREE.Vector3(1, 0, 0.35).normalize() },
		uRamp: { value: Array.from({ length: NSP * 6 }, () => new THREE.Vector3()) },
		uRampP: { value: Array.from({ length: NSP }, () => new THREE.Vector4()) },
		uRampG: { value: Array.from({ length: NSP }, () => new THREE.Vector2()) },
		uBare: { value: Array.from({ length: NSP }, () => 0) },
		uTwig: { value: SPECIES_NAMES.map((n) => new THREE.Vector3(...(TWIG[n] ?? [0.1, 0.09, 0.075]))) },
		uGlow: { value: Array.from({ length: NSP }, () => 0) },
		uCellShift: { value: Array.from({ length: NSP }, () => new THREE.Vector2()) },
		uBarkCell: {
			value: SPECIES_NAMES.map((n) => {
				const b = SPECIES[n].bark;
				const sz = BARK_SIZE[b] as [number, number];
				return new THREE.Vector4(b % 4, Math.floor(b / 4), sz[0], sz[1]);
			}),
		},
		uBarkTint: { value: SPECIES_NAMES.map((n) => new THREE.Vector3(...SPECIES[n].barkTint)) },
		uSnow: { value: 0 },
		uSpring: { value: 0 },
		uSunDir: { value: new THREE.Vector3(0.5, 0.75, 0.4).normalize() },
		uSunColor: { value: new THREE.Color(1, 0.95, 0.9) },
		uBarkNrm: { value: null },
	};
}

/** Sets the season's colours, cells and snow into the shared uniforms. */
export function setTreeSeason(u: TreeUniforms, season: Season): void {
	SPECIES_NAMES.forEach((n, i) => {
		const sp = SPECIES[n];
		const ramp = sp.ramps[season];
		ramp.stops.forEach((c, k) => {
			(u.uRamp.value[i * 6 + k] as THREE.Vector3).set(c[0], c[1], c[2]);
		});
		(u.uRampP.value[i] as THREE.Vector4).set(ramp.base, ramp.spread, ramp.outer, ramp.leaf);
		(u.uRampG.value[i] as THREE.Vector2).set(ramp.greenFrac, ramp.greenAt);
		const bare = season === "winter" && sp.deciduous;
		u.uBare.value[i] = bare ? 1 : 0;
		// cherry blossom glows: light scatters through the petals even in the crown's shade
		u.uGlow.value[i] = season === "spring" && n === "sakura" ? 0.32 : 0;
		const to = bare ? CELL.twigs : season === "spring" && n === "sakura" ? CELL.blossom : sp.leafCell;
		(u.uCellShift.value[i] as THREE.Vector2).set(
			((to % ATLAS_N) - (sp.leafCell % ATLAS_N)) / ATLAS_N,
			(Math.floor(to / ATLAS_N) - Math.floor(sp.leafCell / ATLAS_N)) / ATLAS_N,
		);
	});
	u.uSnow.value = season === "winter" ? 1 : 0;
	u.uSpring.value = season === "spring" ? 1 : 0;
}

function addUniforms(shader: THREE.WebGLProgramParametersWithUniforms, u: TreeUniforms): void {
	Object.assign(shader.uniforms, u as unknown as Uniforms);
}

/** Vertex patches for trees (and their shadow depth). */
function patchVertex(src: string, leaf: boolean): string {
	let s = (leaf ? "#define NATURE_LEAF\n" : "") + src;
	s = patch(
		s,
		"#include <common>",
		`#include <common>\n${VERT_PARS}\n${leaf ? `uniform vec2 uCellShift[${NSP}];` : ""}`,
	);
	s = patch(s, "#include <begin_vertex>", VERT_MAIN);
	if (leaf)
		s = patch(s, "#include <uv_vertex>", `#include <uv_vertex>\nvMapUv += uCellShift[int(aInst.y + 0.5)];`);
	return s;
}

function barkMaterial(u: TreeUniforms, bark: THREE.Texture): THREE.MeshStandardMaterial {
	const m = new THREE.MeshStandardMaterial({ map: bark, roughness: 0.92, metalness: 0 });
	m.onBeforeCompile = (shader) => {
		addUniforms(shader, u);
		shader.vertexShader = patchVertex(shader.vertexShader, false);
		let f = patch(
			shader.fragmentShader,
			"#include <common>",
			`#include <common>\n${FRAG_PARS}\n${COTANGENT}`,
		);
		f = patch(
			f,
			"#include <map_fragment>",
			/* glsl */ `
			int sp = int(vInst.y + 0.5);
			vec4 bc = uBarkCell[sp];
			vec2 buv = vBarkUv / bc.zw + vec2(0.0, vInst.x * 7.0);
			vec2 cs = vec2(0.25, 0.5);
			vec2 cuv = (bc.xy + 0.004 + fract(buv) * 0.992) * cs;
			vec4 bt = textureGrad(map, cuv, dFdx(buv) * cs, dFdy(buv) * cs);
			vec3 barkN = textureGrad(uBarkNrm, cuv, dFdx(buv) * cs, dFdy(buv) * cs).xyz * 2.0 - 1.0;
			diffuseColor.rgb = bt.rgb * uBarkTint[sp] * (0.85 + 0.3 * fract(vInst.x * 3.7));
			// thin twigs read darker and greyer than the trunk
			diffuseColor.rgb = mix(diffuseColor.rgb, uTwig[sp], smoothstep(0.5, 1.0, vData.y) * 0.6);
			float snowK = 0.0;
			if (uSnow > 0.5) {
				float nz = vnoise3(vWorldPos * 2.3) * 0.6 + vnoise3(vWorldPos * 9.0) * 0.4;
				snowK = smoothstep(0.35, 0.7, vWorldNrm.y + (nz - 0.5) * 0.5);
				diffuseColor.rgb = mix(diffuseColor.rgb, SNOW, snowK);
			}
			`,
		);
		f = patch(
			f,
			"#include <normal_fragment_maps>",
			/* glsl */ `
			{
				mat3 tbn = cotangentFrame(normal, -vViewPosition, vBarkUv);
				vec3 bn = normalize(tbn * vec3(barkN.xy * 1.2, barkN.z));
				normal = normalize(mix(bn, normal, snowK));
			}
			`,
		);
		shader.fragmentShader = f;
	};
	m.customProgramCacheKey = () => "nature-bark";
	return m;
}

/**
 * Leaf cards. Leaves are alpha-tested (crisp); bare winter twigs (`soft`) are not: their fine tips fade into
 * a haze in the distance by alpha to coverage, as real twigs do. Shadows test at 0.5 either way.
 */
function leafMaterial(
	u: TreeUniforms,
	atlas: THREE.Texture,
	soft: boolean,
	close = false,
): THREE.MeshStandardMaterial {
	const m = new THREE.MeshStandardMaterial({
		map: atlas,
		roughness: 0.78,
		metalness: 0,
		side: THREE.DoubleSide,
		alphaTest: soft ? 0 : 0.5,
		alphaToCoverage: soft,
	});
	m.onBeforeCompile = (shader) => {
		addUniforms(shader, u);
		if (soft) shader.defines = { ...(shader.defines ?? {}), NATURE_SOFT: 1 };
		if (close) shader.defines = { ...(shader.defines ?? {}), NATURE_CLOSE: 1 };
		shader.vertexShader = patchVertex(shader.vertexShader, true);
		let f = patch(shader.fragmentShader, "#include <common>", `#include <common>\n${FRAG_PARS}`);
		f = patch(
			f,
			"#include <map_fragment>",
			/* glsl */ `
			int sp = int(vInst.y + 0.5);
			#ifdef NATURE_CLOSE
			// a single leaf is small on screen: the atlas's smaller levels keep each cell's coverage, which turns
			// a lone leaf into its whole square; sharper levels keep its shape
			vec4 tx = texture2D(map, vMapUv, -2.5);
			#else
			vec4 tx = texture2D(map, vMapUv);
			#endif
			float bare = uBare[sp];
			vec3 col = leafColor(sp, vInst.x, vData.x, vData.y, tx.g) * (tx.r * 1.15 + 0.18);
			vec3 twig = uTwig[sp] * (0.55 + tx.r * 0.9);
			col = mix(col, twig, tx.b);
			col = mix(col, twig, bare);
			#ifdef NATURE_SOFT
			float alpha = clamp(tx.a * 2.0, 0.0, 1.0);
			#else
			float alpha = tx.a;
			#endif
			{
				// cards seen edge-on show as streaks near the camera: let them fade out there
				vec3 gn = normalize(cross(dFdx(vWorldPos), dFdy(vWorldPos)));
				vec3 toCam = cameraPosition - vWorldPos;
				float edge = abs(dot(gn, normalize(toCam)));
				alpha *= mix(smoothstep(0.06, 0.3, edge), 1.0, smoothstep(12.0, 30.0, length(toCam)));
				// and a card right at the camera is a blurred sheet: let it go (a single leaf only right at the eye)
				#ifdef NATURE_CLOSE
				alpha *= smoothstep(0.12, 0.35, length(toCam));
				#else
				alpha *= smoothstep(0.7, 2.2, length(toCam));
				#endif
			}
			if (alpha < 0.01) discard;
			float snowK = 0.0;
			if (uSnow > 0.5) {
				float nz = vnoise3(vWorldPos * 1.7) * 0.7 + vnoise3(vWorldPos * 6.0) * 0.3;
				// evergreens hold clumps on their sprays; bare twigs a thin line
				snowK = smoothstep(mix(0.2, 0.45, bare), mix(0.7, 0.85, bare), vWorldNrm.y + (nz - 0.5) * 0.8) * mix(0.75, 0.35, bare);
				col = mix(col, SNOW, snowK);
			}
			diffuseColor = vec4(col, alpha);
			`,
		);
		// leaves keep their crown-shaped normal on both faces (no flip on the back): the crown shades as a volume
		f = patch(f, "#include <normal_fragment_maps>", "normal = normalize(vNormal);");
		f = patch(
			f,
			"#include <lights_fragment_end>",
			/* glsl */ `
			#include <lights_fragment_end>
			{
				// light through thin leaves when the sun is behind them
				vec3 V = normalize(vWorldPos - cameraPosition);
				float back = pow(max(dot(V, uSunDir), 0.0), 3.0) * (1.0 - bare) * (1.0 - snowK);
				reflectedLight.directDiffuse += diffuseColor.rgb * uSunColor * back * 0.45 * (0.4 + 0.6 * vData.x);
				reflectedLight.indirectDiffuse += diffuseColor.rgb * uGlow[sp];
			}
			`,
		);
		shader.fragmentShader = f;
	};
	m.customProgramCacheKey = () => (soft ? "nature-twigs" : close ? "nature-leaf-close" : "nature-leaf");
	return m;
}

/** The depth (shadow) material; `cutout`: cut to the atlas's shapes (single leaves, not their squares). */
function depthMaterial(u: TreeUniforms, leaf: boolean, cutout?: THREE.Texture): THREE.MeshDepthMaterial {
	const m = new THREE.MeshDepthMaterial({
		depthPacking: THREE.RGBADepthPacking,
		...(cutout ? { map: cutout, alphaTest: 0.5 } : {}),
	});
	m.onBeforeCompile = (shader) => {
		addUniforms(shader, u);
		shader.vertexShader = `#define NATURE_DEPTH\n${patchVertex(shader.vertexShader, leaf)}`;
		// (sharper atlas levels for single leaves, as in leafMaterial)
		if (cutout)
			shader.fragmentShader = patch(
				shader.fragmentShader,
				"#include <map_fragment>",
				"diffuseColor *= texture2D(map, vMapUv, -2.5);",
			);
	};
	m.customProgramCacheKey = () =>
		leaf ? (cutout ? "nature-leaf-cutout-depth" : "nature-leaf-depth") : "nature-bark-depth";
	return m;
}

/** The impostor: a camera-facing card per tree showing its template's baked side view. */
function impostorMaterial(
	u: TreeUniforms,
	tex: THREE.Texture,
	cells: THREE.Vector4[],
	rows: number,
): THREE.MeshStandardMaterial {
	const m = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.85, metalness: 0, alphaTest: 0.4 });
	m.onBeforeCompile = (shader) => {
		addUniforms(shader, u);
		shader.uniforms.uImpCell = { value: cells };
		let v = patch(
			shader.vertexShader,
			"#include <common>",
			/* glsl */ `#include <common>
			attribute vec4 aInst;
			attribute float aCell;
			uniform vec4 uImpCell[${cells.length}];
			varying vec4 vInst;
			varying vec2 vImpUv;
			varying float vUp;
			vec3 impN;
			`,
		);
		v = patch(
			v,
			"#include <beginnormal_vertex>",
			/* glsl */ `
			vec3 root = (modelMatrix * instanceMatrix[3]).xyz;
			float sc = length(instanceMatrix[0].xyz);
			vec4 ic = uImpCell[int(aCell + 0.5)];
			vec3 toCam = cameraPosition - root; toCam.y = 0.0;
			vec3 fw = normalize(toCam + vec3(1e-4, 0.0, 0.0));
			vec3 side = vec3(fw.z, 0.0, -fw.x);
			// a rounded crown: the normal leans out to the sides and up toward the top
			impN = normalize(fw * 0.75 + side * position.x * 1.2 + vec3(0.0, position.y - 0.35, 0.0));
			vec3 objectNormal = impN;
			`,
		);
		v = patch(v, "#include <defaultnormal_vertex>", "vec3 transformedNormal = normalMatrix * objectNormal;");
		v = patch(
			v,
			"#include <project_vertex>",
			/* glsl */ `
			vec3 wp = root + side * (position.x * ic.z * 2.0 * sc) + vec3(0.0, position.y * ic.w * sc, 0.0);
			vec4 mvPosition = viewMatrix * vec4(wp, 1.0);
			gl_Position = projectionMatrix * mvPosition;
			vNormal = normalize(mat3(viewMatrix) * impN);
			vInst = aInst;
			vUp = position.y;
			vImpUv = (ic.xy + vec2(position.x + 0.5, position.y)) / vec2(${IMP_COLS}.0, ${rows}.0);
			`,
		);
		shader.vertexShader = v;
		let f = patch(
			shader.fragmentShader,
			"#include <common>",
			/* glsl */ `#include <common>
			${FRAG_PARS.replace("varying vec4 vInst;", "")}
			varying vec4 vInst;
			varying vec2 vImpUv;
			varying float vUp;
			`,
		);
		f = patch(
			f,
			"#include <map_fragment>",
			/* glsl */ `
			int sp = int(vInst.y + 0.5);
			vec4 tx = texture2D(map, vImpUv);
			float bare = uBare[sp];
			float lv = vnoise2(vImpUv * 300.0);
			vec3 col = leafColor(sp, vInst.x, tx.g, fract(vInst.x * 5.3), lv) * (tx.r * 1.15 + 0.18);
			vec3 bark = (sp == ${speciesIndex("shirakaba")} && tx.r > 0.55 ? vec3(0.5, 0.5, 0.48) : uTwig[sp]) * (0.55 + tx.r * 0.9);
			col = mix(col, bark, max(tx.b, bare));
			if (uSnow > 0.5) col = mix(col, SNOW, smoothstep(0.35, 1.0, vUp) * mix(0.38, 0.3, bare) * (0.6 + 0.4 * lv));
			diffuseColor = vec4(col, tx.a);
			`,
		);
		f = patch(f, "#include <normal_fragment_maps>", "normal = normalize(vNormal);");
		shader.fragmentShader = f;
	};
	m.customProgramCacheKey = () => "nature-impostor";
	return m;
}

/** Bakes side views of templates into the impostor atlas: R shade, G crown stage, B wood, A cover. */
function impostorBaker(u: TreeUniforms, atlas: THREE.Texture) {
	const encode = (leaf: boolean) =>
		new THREE.ShaderMaterial({
			side: THREE.DoubleSide,
			uniforms: {
				map: { value: atlas },
				uCellShift: u.uCellShift,
				uSp: { value: 0 },
				uBareNow: { value: 0 },
			},
			defines: leaf ? { LEAF: 1 } : {},
			vertexShader: /* glsl */ `
				attribute vec4 aData;
				uniform vec2 uCellShift[${NSP}];
				uniform float uSp;
				varying vec4 vData;
				varying vec2 vUv;
				varying vec3 vN;
				void main() {
					vData = aData;
					vUv = uv + uCellShift[int(uSp + 0.5)];
					vN = normal;
					gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
				}`,
			fragmentShader: /* glsl */ `
				uniform sampler2D map;
				uniform float uBareNow;
				varying vec4 vData;
				varying vec2 vUv;
				varying vec3 vN;
				void main() {
					float shade = 0.62 + 0.38 * clamp(vN.y * 0.5 + 0.5, 0.0, 1.0);
					#ifdef LEAF
					vec4 t = texture2D(map, vUv);
					if (t.a < mix(0.5, 0.12, uBareNow)) discard;
					gl_FragColor = vec4(t.r * shade * (0.75 + 0.25 * vData.x), mix(vData.x, t.g, 0.35), t.b, 1.0);
					#else
					gl_FragColor = vec4(0.7 * shade, 0.5, 1.0, 1.0);
					#endif
				}`,
		});
	return { wood: encode(false), leaf: encode(true) };
}

export class Trees {
	readonly group = new THREE.Group();
	readonly u: TreeUniforms;
	private readonly placed: Placed[] = [];
	private readonly groups: Group[] = [];
	private readonly byKey = new Map<string, Group>();
	private readonly templates: TreeTemplate[] = [];
	readonly atlas: THREE.DataTexture;
	private readonly leafMat: THREE.MeshStandardMaterial;
	private readonly closeMat: THREE.MeshStandardMaterial;
	private readonly closeDepth: THREE.MeshDepthMaterial;
	/** Whether trees by the camera draw their leaves one by one (not on phones: many more triangles). */
	private readonly closeLeaves: boolean;
	private readonly twigMat: THREE.MeshStandardMaterial;
	private readonly barkTex: THREE.Texture;
	private readonly barkNrm: THREE.Texture;
	private readonly mats: THREE.Material[] = [];
	private readonly imp: THREE.InstancedMesh;
	private readonly impRT: THREE.WebGLRenderTarget;
	private readonly impCells: THREE.Vector4[] = [];
	private readonly impTpl = new Map<TreeTemplate, number>();
	private impDirty = true;
	private season: Season = "autumn";
	private readonly frustum = new THREE.Frustum();
	private readonly pv = new THREE.Matrix4();
	private readonly sphere = new THREE.Sphere();
	/** Per frame counts, for stats. */
	readonly drawn = { near: 0, mid: 0, imp: 0 };

	constructor(
		specs: TreeSpec[],
		heightAt: (x: number, z: number) => number | null,
		texBase: string,
		atlas?: THREE.DataTexture,
		closeLeaves = true,
	) {
		this.u = makeTreeUniforms();
		this.closeLeaves = closeLeaves;
		this.group.name = "nature:trees";
		this.atlas = atlas ?? makeLeafAtlas();
		const loader = new THREE.TextureLoader();
		this.barkTex = loader.load(`${texBase}bark.jpg`);
		this.barkTex.colorSpace = THREE.SRGBColorSpace;
		this.barkNrm = loader.load(`${texBase}bark_nrm.jpg`);
		for (const t of [this.barkTex, this.barkNrm]) {
			t.anisotropy = 8;
			t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
		}
		this.u.uBarkNrm.value = this.barkNrm;
		const bark = barkMaterial(this.u, this.barkTex);
		const leaf = leafMaterial(this.u, this.atlas, false);
		this.twigMat = leafMaterial(this.u, this.atlas, true);
		this.leafMat = leaf;
		this.closeMat = leafMaterial(this.u, this.atlas, false, true);
		const barkDepth = depthMaterial(this.u, false);
		const leafDepth = depthMaterial(this.u, true);
		this.closeDepth = depthMaterial(this.u, true, this.atlas);
		this.mats.push(bark, leaf, barkDepth, leafDepth, this.twigMat, this.closeMat, this.closeDepth);

		// place the trees; templates only for species in use
		const used = new Set<string>();
		specs.forEach((spec, i) => {
			const y = heightAt(spec.x, spec.z);
			if (y === null) return;
			const si = speciesIndex(spec.sp);
			if (si < 0) return;
			const seed = fract(Math.sin(spec.x * 12.9898 + spec.z * 78.233 + i * 0.1) * 43758.5453);
			const variant = Math.floor(seed * 997) % VARIANTS;
			const m = new THREE.Matrix4().compose(
				new THREE.Vector3(spec.x, y - 0.05, spec.z),
				new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), spec.r),
				new THREE.Vector3(spec.s, spec.s, spec.s),
			);
			this.placed.push({ spec, y, si, variant, seed, matrix: new Float32Array(m.elements), cy: 0, rad: 0 });
			used.add(`${spec.sp}/${variant}`);
		});
		const count = new Map<string, number>();
		for (const p of this.placed)
			count.set(`${p.si}/${p.variant}`, (count.get(`${p.si}/${p.variant}`) ?? 0) + 1);
		for (const key of used) {
			const [sp, v] = key.split("/") as [Species, string];
			const variant = Number(v);
			const si = speciesIndex(sp);
			const rect = leafRect(this.atlas, SPECIES[sp].single);
			for (const lod of [0, 1] as const) {
				const tpl = makeTree(sp, variant, lod, rect);
				this.templates.push(tpl);
				const cap = count.get(`${si}/${variant}`) ?? 0;
				const mk = (part: PartMesh, mat: THREE.Material, depth: THREE.Material): THREE.InstancedMesh =>
					this.instanced(part, mat, depth, cap, lod === 0);
				const grp: Group = {
					tpl,
					si,
					variant,
					lod,
					wood: mk(tpl.wood, bark, barkDepth),
					leaves: mk(tpl.leaves, leaf, leafDepth),
					close: null,
					closeMade: lod !== 0 || !closeLeaves || !hasCloseLeaves(sp),
					rect,
					cap,
					n: 0,
					nClose: 0,
				};
				this.groups.push(grp);
				this.byKey.set(`${si}/${variant}/${lod}`, grp);
			}
		}
		for (const p of this.placed) {
			const tpl = this.byKey.get(`${p.si}/${p.variant}/0`)?.tpl;
			if (!tpl) continue;
			p.cy = p.y + tpl.height * p.spec.s * 0.5;
			p.rad = Math.max(tpl.height * 0.5, tpl.radius) * p.spec.s * 1.1;
		}

		// impostors: one card per tree beyond MID, from a baked atlas of the full templates
		const near = this.groups.filter((g) => g.lod === 0);
		const rows = Math.max(1, Math.ceil(near.length / IMP_COLS));
		this.impRT = new THREE.WebGLRenderTarget(IMP_COLS * IMP_W, rows * IMP_H, {
			generateMipmaps: true,
			minFilter: THREE.LinearMipmapLinearFilter,
			magFilter: THREE.LinearFilter,
		});
		near.forEach((g, i) => {
			const half = g.tpl.radius * 1.04 + 0.1;
			const h = g.tpl.height * 1.02 + 0.1;
			// cell column, row (in cells), half width and height (metres at s = 1)
			this.impCells.push(new THREE.Vector4(i % IMP_COLS, Math.floor(i / IMP_COLS), half, h));
			this.impTpl.set(g.tpl, i);
		});
		const quad = new THREE.PlaneGeometry(1, 1).translate(0, 0.5, 0);
		quad.setAttribute(
			"aInst",
			new THREE.InstancedBufferAttribute(new Float32Array(this.placed.length * 4), 4),
		);
		quad.setAttribute("aCell", new THREE.InstancedBufferAttribute(new Float32Array(this.placed.length), 1));
		const impMat = impostorMaterial(
			this.u,
			this.impRT.texture,
			this.impCells.length ? this.impCells : [new THREE.Vector4()],
			rows,
		);
		this.mats.push(impMat);
		this.imp = new THREE.InstancedMesh(quad, impMat, Math.max(1, this.placed.length));
		this.imp.frustumCulled = false;
		this.imp.count = 0;
		this.imp.castShadow = false;
		this.imp.receiveShadow = false;
		this.group.add(this.imp);
		this.setSeason("autumn");
	}

	/** An instanced mesh of a template's part, for up to `cap` trees, in the group (hidden until drawn). */
	private instanced(
		part: PartMesh,
		mat: THREE.Material,
		depth: THREE.Material,
		cap: number,
		shadow: boolean,
	): THREE.InstancedMesh {
		const g = geometry(part);
		g.setAttribute("aInst", new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4));
		const mesh = new THREE.InstancedMesh(g, mat, cap);
		mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
		mesh.frustumCulled = false;
		mesh.castShadow = shadow;
		mesh.receiveShadow = true;
		mesh.customDepthMaterial = depth;
		mesh.count = 0;
		mesh.visible = false;
		this.group.add(mesh);
		return mesh;
	}

	/** A template's leaves one by one (some tens of milliseconds), the first time one of its trees comes close. */
	private makeClose(g: Group): void {
		g.closeMade = true;
		const tpl = makeTree(g.tpl.species, g.variant, 0, g.rect, true);
		if (tpl.close) g.close = this.instanced(tpl.close, this.closeMat, this.closeDepth, g.cap, true);
	}

	setSeason(season: Season): void {
		this.season = season;
		setTreeSeason(this.u, season);
		// bare trees draw only the cards on their twigs
		for (const g of this.groups) {
			const sp = SPECIES[g.tpl.species];
			const geo = g.leaves.geometry;
			const bare = season === "winter" && sp.deciduous;
			geo.setDrawRange(0, bare ? g.tpl.twigCards * 6 : Number.POSITIVE_INFINITY);
			g.leaves.material = bare ? this.twigMat : this.leafMat;
		}
		this.impDirty = true;
	}

	/** Re-bakes the impostors when needed (they follow the season). Call before rendering, with the renderer. */
	bake(renderer: THREE.WebGLRenderer): void {
		if (!this.impDirty) return;
		this.impDirty = false;
		const { wood, leaf } = impostorBaker(this.u, this.atlas);
		const scene = new THREE.Scene();
		const cam = new THREE.OrthographicCamera(-1, 1, 1, 0, -100, 100);
		const prevTarget = renderer.getRenderTarget();
		const prevClear = renderer.getClearColor(new THREE.Color());
		const prevAlpha = renderer.getClearAlpha();
		const prevAuto = renderer.autoClear;
		renderer.setRenderTarget(this.impRT);
		renderer.setClearColor(0x000000, 0);
		renderer.clear();
		renderer.autoClear = false;
		for (const g of this.groups) {
			if (g.lod !== 0) continue;
			const i = this.impTpl.get(g.tpl);
			if (i === undefined) continue;
			const c = this.impCells[i] as THREE.Vector4;
			cam.left = -c.z;
			cam.right = c.z;
			cam.top = c.w;
			cam.bottom = 0;
			cam.position.set(0, 0, 50);
			cam.lookAt(0, 0, 0);
			cam.updateProjectionMatrix();
			const vx = c.x * IMP_W;
			const vy = c.y * IMP_H;
			this.impRT.viewport.set(vx, vy, IMP_W, IMP_H);
			this.impRT.scissor.set(vx, vy, IMP_W, IMP_H);
			this.impRT.scissorTest = true;
			renderer.setRenderTarget(this.impRT);
			(leaf.uniforms.uSp as THREE.IUniform).value = g.si;
			(leaf.uniforms.uBareNow as THREE.IUniform).value = this.u.uBare.value[g.si] ?? 0;
			const wm = new THREE.Mesh(g.wood.geometry, wood);
			const lm = new THREE.Mesh(g.leaves.geometry, leaf);
			scene.add(wm, lm);
			renderer.render(scene, cam);
			scene.remove(wm, lm);
		}
		this.impRT.scissorTest = false;
		this.impRT.viewport.set(0, 0, this.impRT.width, this.impRT.height);
		renderer.setRenderTarget(prevTarget);
		renderer.setClearColor(prevClear, prevAlpha);
		renderer.autoClear = prevAuto;
		wood.dispose();
		leaf.dispose();
	}

	update(dt: number, camera: THREE.Camera, now: number): void {
		this.u.uTime.value = now;
		void dt;
		this.pv.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
		this.frustum.setFromProjectionMatrix(this.pv);
		const cp = camera.getWorldPosition(new THREE.Vector3());
		for (const g of this.groups) g.n = g.nClose = 0;
		// bare in winter, broadleaf trees draw their twig cards, also close by
		const closeOk = this.closeLeaves && this.season !== "winter";
		// (one template's single leaves made a frame, the first time a tree of it comes close)
		let makeOne = true;
		let ni = 0;
		const impM = this.imp.instanceMatrix.array as Float32Array;
		const impI = this.imp.geometry.getAttribute("aInst") as THREE.InstancedBufferAttribute;
		const impC = this.imp.geometry.getAttribute("aCell") as THREE.InstancedBufferAttribute;
		this.drawn.near = this.drawn.mid = this.drawn.imp = 0;
		for (const p of this.placed) {
			const dx = p.spec.x - cp.x;
			const dz = p.spec.z - cp.z;
			const dy = (p.cy - cp.y) * 0.5;
			const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
			this.sphere.center.set(p.spec.x, p.cy, p.spec.z);
			this.sphere.radius = p.rad;
			if (!this.frustum.intersectsSphere(this.sphere) && d > SHADOW_KEEP) continue;
			const lod = d < NEAR ? 0 : d < MID ? 1 : 2;
			if (lod === 2) {
				const g = this.byKey.get(`${p.si}/${p.variant}/0`);
				const cell = g ? this.impTpl.get(g.tpl) : undefined;
				if (cell === undefined) continue;
				impM.set(p.matrix, ni * 16);
				(impI.array as Float32Array).set([p.seed, p.si, 0, 0], ni * 4);
				(impC.array as Float32Array)[ni] = cell;
				ni++;
				this.drawn.imp++;
				continue;
			}
			const g = this.byKey.get(`${p.si}/${p.variant}/${lod}`);
			if (!g) continue;
			// right by the camera, the leaves one by one; the cards otherwise (the wood is the same)
			if (closeOk && d < CLOSE && !g.closeMade && makeOne) {
				makeOne = false;
				this.makeClose(g);
			}
			const close = closeOk && g.close !== null && d < CLOSE;
			const put = (mesh: THREE.InstancedMesh, k: number) => {
				(mesh.instanceMatrix.array as Float32Array).set(p.matrix, k * 16);
				const a = mesh.geometry.getAttribute("aInst") as THREE.InstancedBufferAttribute;
				(a.array as Float32Array).set([p.seed, p.si, 0, 0], k * 4);
			};
			put(g.wood, g.n);
			if (close && g.close) put(g.close, g.nClose++);
			else put(g.leaves, g.n - g.nClose);
			g.n++;
			if (lod === 0) this.drawn.near++;
			else this.drawn.mid++;
		}
		for (const g of this.groups) {
			const counts: [THREE.InstancedMesh | null, number][] = [
				[g.wood, g.n],
				[g.leaves, g.n - g.nClose],
				[g.close, g.nClose],
			];
			for (const [mesh, n] of counts) {
				if (!mesh) continue;
				mesh.count = n;
				mesh.visible = n > 0;
				if (n) {
					mesh.instanceMatrix.clearUpdateRanges();
					mesh.instanceMatrix.addUpdateRange(0, n * 16);
					mesh.instanceMatrix.needsUpdate = true;
					const a = mesh.geometry.getAttribute("aInst") as THREE.InstancedBufferAttribute;
					a.clearUpdateRanges();
					a.addUpdateRange(0, n * 4);
					a.needsUpdate = true;
				}
			}
		}
		this.imp.count = ni;
		this.imp.visible = ni > 0;
		if (ni) {
			this.imp.instanceMatrix.needsUpdate = true;
			impI.needsUpdate = true;
			impC.needsUpdate = true;
		}
	}

	/** Trees near a point (for falling leaves and petals): species and crown. */
	near(
		x: number,
		z: number,
		r: number,
	): { sp: Species; x: number; y: number; z: number; h: number; rad: number }[] {
		const out: { sp: Species; x: number; y: number; z: number; h: number; rad: number }[] = [];
		for (const p of this.placed) {
			const dx = p.spec.x - x;
			const dz = p.spec.z - z;
			if (dx * dx + dz * dz > r * r) continue;
			const tpl = this.byKey.get(`${p.si}/${p.variant}/0`)?.tpl;
			if (!tpl) continue;
			out.push({
				sp: p.spec.sp,
				x: p.spec.x,
				y: p.y,
				z: p.spec.z,
				h: tpl.height * p.spec.s,
				rad: tpl.radius * p.spec.s,
			});
		}
		return out;
	}

	/** Every placed tree's crown (for the ground cover). */
	crowns(): { sp: Species; x: number; y: number; z: number; rad: number; seed: number }[] {
		return this.placed.map((p) => {
			const tpl = this.byKey.get(`${p.si}/${p.variant}/0`)?.tpl;
			return {
				sp: p.spec.sp,
				x: p.spec.x,
				y: p.y,
				z: p.spec.z,
				rad: (tpl?.radius ?? 3) * p.spec.s,
				seed: p.seed,
			};
		});
	}

	get currentSeason(): Season {
		return this.season;
	}

	/** Triangles of what was drawn last update (main pass), and draw calls. */
	stats(): { draws: number; triangles: number; trees: number } {
		let draws = 0;
		let triangles = 0;
		for (const g of this.groups) {
			if (!g.n) continue;
			const leafTris = Math.min(g.leaves.geometry.drawRange.count, g.leaves.geometry.index?.count ?? 0) / 3;
			draws += 2;
			triangles += g.n * ((g.wood.geometry.index?.count ?? 0) / 3 + leafTris);
		}
		if (this.imp.count) {
			draws++;
			triangles += this.imp.count * 2;
		}
		return { draws, triangles, trees: this.placed.length };
	}

	dispose(): void {
		this.group.removeFromParent();
		for (const g of this.groups) {
			g.wood.geometry.dispose();
			g.leaves.geometry.dispose();
			g.close?.geometry.dispose();
			g.wood.dispose();
			g.leaves.dispose();
			g.close?.dispose();
		}
		this.imp.geometry.dispose();
		this.imp.dispose();
		for (const m of this.mats) m.dispose();
		this.atlas.dispose();
		this.barkTex.dispose();
		this.barkNrm.dispose();
		this.impRT.dispose();
	}
}

/** Where single leaf `single` lies in its square of the atlas's singles cell (where it is opaque). */
function leafRect(atlas: THREE.DataTexture, single: number): LeafRect | undefined {
	const img = atlas.image as { data?: Uint8Array; width?: number; height?: number };
	const W = img.width ?? 0;
	if (!img.data || !W || img.height !== W) return undefined;
	const cell = W / ATLAS_N;
	const sub = cell / 4;
	const ox = (CELL.singles % ATLAS_N) * cell + (single % 4) * sub;
	const oy = Math.floor(CELL.singles / ATLAS_N) * cell + Math.floor(single / 4) * sub;
	let [x0, y0, x1, y1] = [sub, sub, -1, -1];
	for (let y = 0; y < sub; y++)
		for (let x = 0; x < sub; x++)
			if ((img.data[((oy + y) * W + ox + x) * 4 + 3] as number) > 64) {
				x0 = Math.min(x0, x);
				y0 = Math.min(y0, y);
				x1 = Math.max(x1, x);
				y1 = Math.max(y1, y);
			}
	if (x1 < x0) return undefined;
	// a texel's margin round it
	return [
		Math.max(0, x0 - 1) / sub,
		Math.max(0, y0 - 1) / sub,
		Math.min(sub, x1 + 2) / sub,
		Math.min(sub, y1 + 2) / sub,
	];
}

function fract(x: number): number {
	return x - Math.floor(x);
}
