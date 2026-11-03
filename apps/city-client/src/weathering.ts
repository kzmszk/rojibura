// Old Venetian walls (はじまりの街's houses, issue 42): the glb's wall_* materials (tools/city-build/blender/
// hajimari/houses.py) are aged in the shader by where each point is: broad patches where the plaster has faded
// unevenly, grime streaking down the walls, and rising damp darkening the foot of every wall up to a ragged tide
// mark a metre or so up (the town's ground is at height 0).

import type * as THREE from "three";
import { NOISE, patch } from "./nature/glsl.ts";

/** Whether a glb material is a wall to weather. */
export function wantsWeathering(m: THREE.Material): boolean {
	return m.name.startsWith("wall_");
}

/** Ages the material's colour (in place). */
export function applyWeathering(m: THREE.MeshStandardMaterial): void {
	m.onBeforeCompile = (shader) => {
		let v = patch(shader.vertexShader, "#include <common>", "#include <common>\nvarying vec3 vRjWall;");
		v = patch(
			v,
			"#include <project_vertex>",
			/* glsl */ `#include <project_vertex>
			{
				vec4 rjw = vec4(transformed, 1.0);
				#ifdef USE_INSTANCING
				rjw = instanceMatrix * rjw;
				#endif
				vRjWall = (modelMatrix * rjw).xyz;
			}`,
		);
		shader.vertexShader = v;
		let f = patch(
			shader.fragmentShader,
			"#include <common>",
			`#include <common>\nvarying vec3 vRjWall;\n${NOISE}`,
		);
		f = patch(
			f,
			"#include <color_fragment>",
			/* glsl */ `#include <color_fragment>
			{
				vec3 p = vRjWall;
				// along the wall, whichever way it faces
				float s = p.x + p.z;
				// faded patches, a few metres across
				diffuseColor.rgb *= mix(0.82, 1.08, fbm2(vec2(s, p.y) * 0.21));
				// grime run down from sills and cornices: thin and long
				float st = vnoise2(vec2(s * 2.3, p.y * 0.11));
				float st2 = vnoise2(vec2((p.x - p.z) * 4.7, p.y * 0.23 + 3.0));
				diffuseColor.rgb *= 1.0 - 0.13 * smoothstep(0.55, 0.95, st) - 0.07 * smoothstep(0.62, 1.0, st2);
				// rising damp up to a ragged edge, a little darker still at its tide mark
				float edge = 0.75 + 0.8 * fbm2(vec2(s * 0.55, 1.7));
				float damp = 1.0 - smoothstep(edge - 0.45, edge + 0.08, p.y);
				diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(0.64, 0.63, 0.57), damp * 0.85);
				diffuseColor.rgb *= 1.0 - 0.09 * exp(-pow((p.y - edge) * 8.0, 2.0));
			}`,
		);
		shader.fragmentShader = f;
	};
	m.customProgramCacheKey = () => "rj-weathered-wall";
	m.needsUpdate = true;
}
