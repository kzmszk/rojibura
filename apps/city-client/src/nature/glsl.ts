// Shader snippets shared by the nature materials (injected into three's standard material with onBeforeCompile).

import type * as THREE from "three";

/** Hash and value noise (2D and 3D), and fbm. Guarded: two patches of one material may both bring it. */
export const NOISE = /* glsl */ `
#ifndef RJ_NOISE
#define RJ_NOISE
float nHash2(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float nHash3(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float vnoise2(vec2 p) {
	vec2 i = floor(p); vec2 f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
	return mix(mix(nHash2(i), nHash2(i + vec2(1.0, 0.0)), u.x), mix(nHash2(i + vec2(0.0, 1.0)), nHash2(i + vec2(1.0, 1.0)), u.x), u.y);
}
float vnoise3(vec3 p) {
	vec3 i = floor(p); vec3 f = fract(p); vec3 u = f * f * (3.0 - 2.0 * f);
	return mix(
		mix(mix(nHash3(i), nHash3(i + vec3(1, 0, 0)), u.x), mix(nHash3(i + vec3(0, 1, 0)), nHash3(i + vec3(1, 1, 0)), u.x), u.y),
		mix(mix(nHash3(i + vec3(0, 0, 1)), nHash3(i + vec3(1, 0, 1)), u.x), mix(nHash3(i + vec3(0, 1, 1)), nHash3(i + vec3(1, 1, 1)), u.x), u.y),
		u.z);
}
float fbm2(vec2 p) { float a = 0.5, s = 0.0; for (int i = 0; i < 4; i++) { s += a * vnoise2(p); p = p * 2.03 + 17.1; a *= 0.5; } return s; }
#endif
`;

/** A tangent frame from screen derivatives (for normal maps on custom uvs). */
export const COTANGENT = /* glsl */ `
mat3 cotangentFrame(vec3 N, vec3 p, vec2 uv) {
	vec3 dp1 = dFdx(p); vec3 dp2 = dFdy(p); vec2 duv1 = dFdx(uv); vec2 duv2 = dFdy(uv);
	vec3 dp2perp = cross(dp2, N); vec3 dp1perp = cross(N, dp1);
	vec3 T = dp2perp * duv1.x + dp1perp * duv2.x;
	vec3 B = dp2perp * duv1.y + dp1perp * duv2.y;
	float invmax = inversesqrt(max(dot(T, T), dot(B, B)) + 1e-12);
	return mat3(T * invmax, B * invmax, N);
}
`;

export type Uniforms = Record<string, THREE.IUniform>;

/** Patches a chunk include (or any text) of a shader, failing loudly when three's chunks change. */
export function patch(src: string, find: string, replace: string): string {
	if (!src.includes(find)) throw new Error(`nature: shader chunk not found: ${find}`);
	return src.replace(find, replace);
}
