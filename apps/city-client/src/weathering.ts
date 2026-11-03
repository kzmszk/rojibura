// Old Venetian walls (はじまりの街's houses, issue 42): the glb's wall_* materials (tools/city-build/blender/
// hajimari/houses.py) are aged in the shader by where each point is: broad patches where the plaster has faded
// unevenly, grime streaking down the walls, rising damp darkening the foot of every wall up to a ragged tide mark
// a metre or so up (the town's ground is at height 0), and, on plaster, patches where it has fallen off and the
// brick shows (assets/tex/town/brick.webp), ringed by the grey render coat, more of them low down.

import * as THREE from "three";
import { NOISE, patch } from "./nature/glsl.ts";

/** Whether a glb material is a wall to weather. */
export function wantsWeathering(m: THREE.Material): boolean {
	return m.name.startsWith("wall_");
}

let brick: THREE.Texture | null = null;

/** The brick under the plaster, loaded once. */
function brickTexture(): THREE.Texture {
	if (!brick) {
		brick = new THREE.TextureLoader().load("/tex/town/brick.webp");
		brick.colorSpace = THREE.SRGBColorSpace;
		brick.wrapS = brick.wrapT = THREE.RepeatWrapping;
		brick.anisotropy = 8;
	}
	return brick;
}

/** How much of the plaster has fallen off, by wall material (none where the wall is brick already). */
const PEEL: Record<string, number> = { wall_plaster: 1, wall_red: 0.8, wall_ochre: 0.9 };
/** How much of the texture's grain to soften (plaster is smooth; brick and the weathered red keep theirs). */
const SMOOTH: Record<string, number> = { wall_plaster: 0.6, wall_ochre: 0.5, wall_red: 0.2 };

/** Ages the material's colour (in place). */
export function applyWeathering(m: THREE.MeshStandardMaterial): void {
	const uniforms = {
		uBrick: { value: brickTexture() },
		uPeel: { value: PEEL[m.name] ?? 0 },
		uSmooth: { value: SMOOTH[m.name] ?? 0 },
	};
	m.onBeforeCompile = (shader) => {
		Object.assign(shader.uniforms, uniforms);
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
			`#include <common>\nvarying vec3 vRjWall;\nuniform sampler2D uBrick;\nuniform float uPeel;\nuniform float uSmooth;\n${NOISE}`,
		);
		// old lime plaster is smooth: the texture's grain is softened towards its own blur (a far mip level)
		f = patch(
			f,
			"#include <map_fragment>",
			/* glsl */ `#ifdef USE_MAP
			{
				vec4 rjTex = texture2D(map, vMapUv);
				vec4 rjFar = textureLod(map, vMapUv, 7.0);
				diffuseColor *= mix(rjTex, rjFar, uSmooth);
			}
			#endif`,
		);
		f = patch(
			f,
			"#include <color_fragment>",
			/* glsl */ `#include <color_fragment>
			{
				vec3 p = vRjWall;
				// along the wall, whichever way it faces
				float s = p.x + p.z;
				vec2 q = vec2(s, p.y);
				// faded and darkened patches: broad ones metres across, and smaller ones in them
				diffuseColor.rgb *= mix(0.84, 1.07, fbm2(q * 0.09)) * mix(0.93, 1.04, fbm2(q * 0.37 + 5.0));
				// grime run down the walls: thin and long
				float st = vnoise2(vec2(s * 2.3, p.y * 0.11));
				float st2 = vnoise2(vec2((p.x - p.z) * 4.7, p.y * 0.23 + 3.0));
				diffuseColor.rgb *= 1.0 - 0.1 * smoothstep(0.55, 0.95, st) - 0.05 * smoothstep(0.62, 1.0, st2);
				// rising damp up to a ragged edge, a little darker still at its tide mark
				float edge = 0.75 + 0.8 * fbm2(vec2(s * 0.55, 1.7));
				float damp = 1.0 - smoothstep(edge - 0.45, edge + 0.08, p.y);
				diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(0.64, 0.63, 0.57), damp * 0.85);
				diffuseColor.rgb *= 1.0 - 0.09 * exp(-pow((p.y - edge) * 8.0, 2.0));
				// plaster fallen off: brick in rounded patches, the pale grey render coat in a soft band round them;
				// more low down, and on some houses (a slow noise) than on others
				if (uPeel > 0.0) {
					float m = fbm2(q * 0.75) + 0.1 * fbm2(q * 3.1) + 0.16 * (1.0 - smoothstep(0.3, 3.5, p.y))
						+ 0.3 * (vnoise2(q * 0.045) - 0.5);
					float t = 0.84 - 0.05 * uPeel;
					float bare = smoothstep(t, t + 0.02, m);
					float coat = pow(smoothstep(t - 0.06, t, m), 0.8) * (1.0 - bare);
					vec3 grey = vec3(0.5, 0.49, 0.47) * (0.9 + 0.2 * vnoise2(q * 7.0));
					diffuseColor.rgb = mix(diffuseColor.rgb, grey, coat * 0.6);
					vec3 b = texture2D(uBrick, q * 0.5).rgb * (0.8 + 0.2 * smoothstep(t + 0.02, t + 0.08, m));
					diffuseColor.rgb = mix(diffuseColor.rgb, b * (1.0 - damp * 0.3), bare);
				}
			}`,
		);
		shader.fragmentShader = f;
	};
	m.customProgramCacheKey = () => "rj-weathered-wall";
	m.needsUpdate = true;
}
