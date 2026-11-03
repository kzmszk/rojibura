// Metered eye adaptation for the rich look (look.ts), after the city demos' shared/exposure (VENEZIA, KYOTO): the
// frame itself, its scene-linear colour before exposure and tone mapping, is metered now and then on a small target,
// and the exposure is lifted where it is too dark (the church's side in shade, a narrow lane), never lowered. On a
// bright desktop monitor shade reads; on a phone it went nearly black. The readback is asynchronous and a few frames
// late, which is what an eye does anyway.

import * as THREE from "three";
import { FullScreenQuad, Pass } from "three/examples/jsm/postprocessing/Pass.js";

/** log2 luminance is stored in 8 bits over this range (a 0.08 stop step: plenty for a meter). */
const LO = -16;
const HI = 4;
/** 64 px × 4 bytes = 256 bytes a row: no row padding on readback. */
const W = 64;
const H = 36;

/**
 * The exposed log2 luminance a view is lifted to. はじまりの街: a sunlit street of houses meters about -3.4 (left as
 * it is); the church, its dark stone, about -5.2 on the sunny side and -6 in shade (lifted about two stops).
 */
const TARGET = -3.5;

export interface BoostOptions {
	/** The exposed log2 luminance to bring the frame up to. */
	target?: number;
	/** < 1 leaves a dark place darker than a bright one (it still reads as shade). */
	strength?: number;
	/** At most this much (a black screen stays black, not noise). */
	max?: number;
}

/** The boost (≥ 1) that brings the metered, exposed log2 luminance up toward `target`. */
export function exposureBoost(
	logLum: number | null,
	expo: number,
	{ target = TARGET, strength = 0.85, max = 5 }: BoostOptions = {},
): number {
	if (logLum === null || !(expo > 0)) return 1;
	const short = target - (logLum + Math.log2(expo));
	return short <= 0 ? 1 : Math.min(max, 2 ** (strength * short));
}

/** Eases a boost toward the wanted one in stops per second: brightening (eyes opening) slower than darkening. */
export function adapt(cur: number, want: number, dt: number, { up = 1.2, down = 2.5 } = {}): number {
	const a = Math.log2(cur);
	const b = Math.log2(want);
	const r = b > a ? up : down;
	return 2 ** (a + (b - a) * Math.min(1, dt * r));
}

/** Centre-weighted mean of the stored log2 luminance (the centre counts three times the corners). */
export function meanLog(px: ArrayLike<number>, w = W, h = H, stride = w * 4): number {
	let s = 0;
	let n = 0;
	for (let y = 0; y < h; y++)
		for (let x = 0; x < w; x++) {
			const dx = (x + 0.5) / w - 0.5;
			const dy = ((y + 0.5) / h - 0.5) * 0.75;
			const k = 1 + 2 * Math.exp(-(dx * dx + dy * dy) / 0.06);
			s += k * (LO + ((px[y * stride + x * 4] as number) / 255) * (HI - LO));
			n += k;
		}
	return s / n;
}

const FRAGMENT = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2 uCell;
varying vec2 vUv;
void main() {
	// four taps a cell, each to log2 luminance, averaged (a log mean: one bright spot does not set the exposure)
	float s = 0.0;
	for (int i = 0; i < 4; i++) {
		vec2 o = vec2(i == 0 || i == 2 ? -0.25 : 0.25, i < 2 ? -0.25 : 0.25);
		vec3 c = texture2D(tSrc, vUv + uCell * o).rgb;
		s += log2(max(dot(c, vec3(0.2126, 0.7152, 0.0722)), ${2 ** LO}));
	}
	float e = clamp((s * 0.25 - (${LO.toFixed(1)})) / ${(HI - LO).toFixed(1)}, 0.0, 1.0);
	gl_FragColor = vec4(e, e, e, 1.0);
}`;

/**
 * A pass that meters the frame (the composer's scene-linear buffer, before OutputPass) every `interval` seconds and
 * leaves the picture as it is. `logLum` is the last reading, or null before the first.
 */
export class MeterPass extends Pass {
	logLum: number | null = null;
	private readonly target = new THREE.WebGLRenderTarget(W, H, {
		type: THREE.UnsignedByteType,
		depthBuffer: false,
	});
	private readonly quad: FullScreenQuad;
	private readonly mat: THREE.ShaderMaterial;
	private readonly interval: number;
	private busy = false;
	private last = Number.NEGATIVE_INFINITY;

	constructor(interval = 0.15) {
		super();
		this.needsSwap = false;
		this.interval = interval;
		this.mat = new THREE.ShaderMaterial({
			uniforms: { tSrc: { value: null }, uCell: { value: new THREE.Vector2(1 / W, 1 / H) } },
			vertexShader: "varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }",
			fragmentShader: FRAGMENT,
			depthTest: false,
			depthWrite: false,
		});
		this.quad = new FullScreenQuad(this.mat);
	}

	override render(
		renderer: THREE.WebGLRenderer,
		_writeBuffer: THREE.WebGLRenderTarget,
		readBuffer: THREE.WebGLRenderTarget,
	): void {
		const now = performance.now() / 1000;
		if (this.busy || now - this.last < this.interval) return;
		this.last = now;
		(this.mat.uniforms.tSrc as THREE.IUniform).value = readBuffer.texture;
		const was = renderer.getRenderTarget();
		renderer.setRenderTarget(this.target);
		this.quad.render(renderer);
		renderer.setRenderTarget(was);
		this.busy = true;
		renderer
			.readRenderTargetPixelsAsync(this.target, 0, 0, W, H, new Uint8Array(W * H * 4))
			.then((px) => {
				this.logLum = meanLog(px);
			})
			.catch(() => {})
			.finally(() => {
				this.busy = false;
			});
	}

	override dispose(): void {
		this.target.dispose();
		this.mat.dispose();
		this.quad.dispose();
	}
}
