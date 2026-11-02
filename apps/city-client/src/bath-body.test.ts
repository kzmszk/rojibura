import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { type Cloud, isSkin, maskOf, paintSkin, surfaceOf, toneOf, weightsFor } from "./bath-body.ts";

describe("surfaceOf", () => {
	it("makes a closed surface facing out where the shape is 0", () => {
		const r = 0.1;
		const f = (p: THREE.Vector3) => p.length() - r;
		const box = new THREE.Box3(new THREE.Vector3(-0.15, -0.15, -0.15), new THREE.Vector3(0.15, 0.15, 0.15));
		const { pos, nrm, index } = surfaceOf(f, box, 0.01);
		expect(index.length).toBeGreaterThan(300);
		const p = new THREE.Vector3();
		const n = new THREE.Vector3();
		for (let i = 0; i < pos.length / 3; i++) {
			p.fromArray(pos, i * 3);
			expect(Math.abs(p.length() - r)).toBeLessThan(0.006);
			expect(n.fromArray(nrm, i * 3).dot(p.normalize())).toBeGreaterThan(0.9);
		}
		// every triangle faces away from the middle
		const a = new THREE.Vector3();
		const b = new THREE.Vector3();
		const c = new THREE.Vector3();
		for (let t = 0; t < index.length; t += 3) {
			a.fromArray(pos, (index[t] as number) * 3);
			b.fromArray(pos, (index[t + 1] as number) * 3);
			c.fromArray(pos, (index[t + 2] as number) * 3);
			const face = b.clone().sub(a).cross(c.clone().sub(a));
			expect(face.dot(a)).toBeGreaterThan(0);
		}
		// closed: each edge is shared by two triangles
		const edges = new Map<string, number>();
		for (let t = 0; t < index.length; t += 3)
			for (let e = 0; e < 3; e++) {
				const u = index[t + e] as number;
				const v = index[t + ((e + 1) % 3)] as number;
				const k = u < v ? `${u}_${v}` : `${v}_${u}`;
				edges.set(k, (edges.get(k) ?? 0) + 1);
			}
		expect([...edges.values()].every((x) => x === 2)).toBe(true);
	});
});

describe("weightsFor", () => {
	it("takes the bones of the vertices nearby, smoothed along the mesh, summing to 1", () => {
		// two vertices: one moved by bone 3 at x = 0, one by bone 5 at x = 1
		const cloud: Cloud = {
			count: 2,
			pos: new Float32Array([0, 0, 0, 1, 0, 0]),
			nrm: new Float32Array(6),
			joints: new Uint16Array([3, 0, 0, 0, 5, 0, 0, 0]),
			weights: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0]),
			main: new Uint16Array([3, 5]),
		};
		const pos = new Float32Array([0.05, 0, 0, 0.5, 0, 0, 0.95, 0, 0]);
		const { joints, weights } = weightsFor(pos, [0, 1, 2], cloud, 1, 0);
		expect(joints[0]).toBe(3);
		expect(weights[0]).toBeCloseTo(1);
		expect(joints[8]).toBe(5);
		for (let i = 0; i < 3; i++) {
			const sum =
				(weights[i * 4] ?? 0) +
				(weights[i * 4 + 1] ?? 0) +
				(weights[i * 4 + 2] ?? 0) +
				(weights[i * 4 + 3] ?? 0);
			expect(sum).toBeCloseTo(1);
		}
		// smoothed, the middle one is moved by both
		const smooth = weightsFor(pos, [0, 1, 2], cloud, 1, 2);
		const middle = new Set([smooth.joints[4], smooth.joints[5]]);
		expect(middle.has(3) && middle.has(5)).toBe(true);
	});
});

describe("painting skin over clothes", () => {
	const skinRgb: [number, number, number] = [240, 200, 180];
	const tone = toneOf(Array.from({ length: 30 }, () => skinRgb).flat());

	it("knows skin from cloth", () => {
		expect(tone).not.toBeNull();
		if (!tone) return;
		expect(isSkin(tone, ...skinRgb)).toBe(true);
		// in its shade
		expect(isSkin(tone, 200, 150, 130)).toBe(true);
		expect(isSkin(tone, 40, 40, 40)).toBe(false);
		expect(isSkin(tone, 60, 90, 200)).toBe(false);
		expect(isSkin(tone, 250, 250, 250)).toBe(false);
	});

	it("paints only what is not skin, only where asked", () => {
		const w = 16;
		const h = 16;
		const px = new Uint8ClampedArray(w * h * 4);
		const skin = new Uint8Array(w * h);
		for (let i = 0; i < w * h; i++) {
			const x = i % w;
			// the left half skin, the right half a dark sock
			const c = x < 8 ? skinRgb : ([30, 30, 30] as const);
			px.set([...c, 255], i * 4);
			skin[i] = x < 8 ? 1 : 0;
		}
		// asked: the top half
		const where = new Uint8Array(w * h);
		for (let i = 0; i < (w * h) / 2; i++) where[i] = 1;
		const out = paintSkin(px, w, h, skin, where, skinRgb, 1);
		const at = (x: number, y: number) => Array.from(out.slice((y * w + x) * 4, (y * w + x) * 4 + 3));
		// the sock in the top half is skin now, the one in the bottom half is not
		at(12, 2).forEach((v, c) => {
			expect(Math.abs(v - (skinRgb[c] as number))).toBeLessThan(12);
		});
		expect(at(12, 12)).toEqual([30, 30, 30]);
		// skin away from the sock is left as it was
		expect(at(1, 2)).toEqual(skinRgb);
	});

	it("masks the pixels a triangle touches", () => {
		const mask = maskOf([0.1, 0.1, 0.5, 0.1, 0.1, 0.5], 10, 10);
		expect(mask[2 * 10 + 2]).toBe(1);
		expect(mask[8 * 10 + 8]).toBe(0);
		// wrapped: a triangle past 1 lands at its place in 0..1
		const wrapped = maskOf([1.1, 0.1, 1.5, 0.1, 1.1, 0.5], 10, 10);
		expect(wrapped[2 * 10 + 2]).toBe(1);
	});
});
