// The stone's grain on glb materials that have no UVs (the Sagrada Família's exterior, docs/prd.md 3.8.7): a glTF
// material with extras { rjTriplanar: { size, contrast, macro, macroAmount } } carries a detail map (its base colour
// texture, 0.5 on average) and a normal map, which are projected from the three axes in world space every `size`
// metres and blended by the normal. The detail, its contrast raised by `contrast`, multiplies the vertex colours
// (the stone's colour and its baked shade) by twice its value; the same map `macro` times larger, by `macroAmount`,
// gives patches of weathering so that a tall wall is not one even colour.

import * as THREE from "three";
import { patch } from "./nature/glsl.ts";

interface Triplanar {
	size: number;
	contrast?: number;
	macro?: number;
	macroAmount?: number;
}

const VERTEX = /* glsl */ `
varying vec3 vRjWorld;
varying vec3 vRjNormal;
`;

const FRAGMENT = /* glsl */ `
varying vec3 vRjWorld;
varying vec3 vRjNormal;
uniform sampler2D rjDetail;
uniform sampler2D rjDetailNormal;
uniform float rjSize;
uniform float rjContrast;
uniform float rjMacro;
uniform float rjMacroAmount;
vec3 rjWeights(vec3 n) {
	vec3 w = pow(abs(n), vec3(4.0));
	return w / (w.x + w.y + w.z);
}
vec3 rjSample(vec3 p, vec3 w) {
	return texture2D(rjDetail, p.zy).rgb * w.x + texture2D(rjDetail, p.xz).rgb * w.y + texture2D(rjDetail, p.xy).rgb * w.z;
}
`;

/** Whether a glb material asks for it. */
export function wantsTriplanar(m: THREE.Material): boolean {
	return Boolean((m.userData as { rjTriplanar?: Triplanar }).rjTriplanar);
}

/** Moves the material's map and normal map into a projection from the three axes (in place). */
export function applyTriplanar(m: THREE.MeshStandardMaterial): void {
	const {
		size,
		contrast = 1,
		macro = 10,
		macroAmount = 0,
	} = (m.userData as { rjTriplanar: Triplanar }).rjTriplanar;
	const detail = m.map;
	const bumps = m.normalMap;
	if (!detail || !bumps) return;
	// the detail is data around 0.5, not a colour
	detail.colorSpace = THREE.NoColorSpace;
	for (const t of [detail, bumps]) {
		t.wrapS = t.wrapT = THREE.RepeatWrapping;
		t.anisotropy = 8;
		t.needsUpdate = true;
	}
	// three's own map and normal map would read UVs the geometry does not have
	m.map = null;
	m.normalMap = null;
	const uniforms = {
		rjDetail: { value: detail },
		rjDetailNormal: { value: bumps },
		rjSize: { value: size },
		rjContrast: { value: contrast },
		rjMacro: { value: macro },
		rjMacroAmount: { value: macroAmount },
	};
	m.onBeforeCompile = (shader) => {
		Object.assign(shader.uniforms, uniforms);
		let v = patch(shader.vertexShader, "#include <common>", `#include <common>\n${VERTEX}`);
		v = patch(
			v,
			"#include <project_vertex>",
			/* glsl */ `#include <project_vertex>
			{
				vec4 rjw = vec4(transformed, 1.0);
				#ifdef USE_INSTANCING
				rjw = instanceMatrix * rjw;
				#endif
				vRjWorld = (modelMatrix * rjw).xyz;
				vRjNormal = normalize(mat3(modelMatrix) * objectNormal);
			}`,
		);
		shader.vertexShader = v;
		let f = patch(shader.fragmentShader, "#include <common>", `#include <common>\n${FRAGMENT}`);
		// before the vertex colours (and before whatever is patched after them, such as the winter's snow)
		f = patch(
			f,
			"#include <color_fragment>",
			/* glsl */ `{
				vec3 rjW = rjWeights(normalize(vRjNormal));
				vec3 rjP = vRjWorld / rjSize;
				vec3 rjD = 0.5 + (rjSample(rjP, rjW) - 0.5) * rjContrast;
				vec3 rjM = mix(vec3(1.0), 2.0 * rjSample(rjP / rjMacro, rjW), rjMacroAmount);
				diffuseColor.rgb *= clamp(2.0 * rjD * rjM, 0.0, 2.0);
			}
			#include <color_fragment>`,
		);
		// the normal maps of the three projections, each turned onto its axis and blended (whiteout), in world space
		f = patch(
			f,
			"#include <normal_fragment_maps>",
			/* glsl */ `{
				vec3 rjN = normalize(vRjNormal) * faceDirection;
				vec3 rjW = rjWeights(rjN);
				vec3 rjP = vRjWorld / rjSize;
				vec3 tx = texture2D(rjDetailNormal, rjP.zy).xyz * 2.0 - 1.0;
				vec3 ty = texture2D(rjDetailNormal, rjP.xz).xyz * 2.0 - 1.0;
				vec3 tz = texture2D(rjDetailNormal, rjP.xy).xyz * 2.0 - 1.0;
				tx = vec3(tx.xy + rjN.zy, abs(tx.z) * rjN.x);
				ty = vec3(ty.xy + rjN.xz, abs(ty.z) * rjN.y);
				tz = vec3(tz.xy + rjN.xy, abs(tz.z) * rjN.z);
				vec3 rjWorldN = normalize(tx.zyx * rjW.x + ty.xzy * rjW.y + tz.xyz * rjW.z);
				normal = normalize((viewMatrix * vec4(rjWorldN, 0.0)).xyz);
			}
			#include <normal_fragment_maps>`,
		);
		shader.fragmentShader = f;
	};
	m.customProgramCacheKey = () => "rj-triplanar";
	m.needsUpdate = true;
}
