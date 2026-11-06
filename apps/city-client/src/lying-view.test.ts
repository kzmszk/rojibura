import * as THREE from "three";
import { describe, expect, test } from "vitest";
import { LIE_TURN, lyingSight, sightBetween, steadyUp } from "./lying-view.ts";

const near = (a: THREE.Vector3, b: [number, number, number]) => {
	expect(a.x).toBeCloseTo(b[0], 5);
	expect(a.y).toBeCloseTo(b[1], 5);
	expect(a.z).toBeCloseTo(b[2], 5);
};

/** The right of the view of a camera looking `look` with `up` at the top. */
const viewRight = (look: THREE.Vector3, up: THREE.Vector3) => look.clone().cross(up).normalize();

describe("lying on your back", () => {
	test("the eyes look straight up, the top of the head at the top of the view (not along the body)", () => {
		// feet towards +z, so the head towards -z
		const { look, up } = lyingSight(0);
		near(look, [0, 1, 0]);
		near(up, [0, 0, -1]);
	});

	test("left and right on the view are the body's left and right, so a drag to the right looks right", () => {
		const { look, up } = lyingSight(0);
		// (facing +z, the right hand is on -x)
		near(viewRight(look, up), [-1, 0, 0]);
		near(lyingSight(0, LIE_TURN).look, [-1, 0, 0]);
		near(lyingSight(0, -LIE_TURN).look, [1, 0, 0]);
		// with the top of the head still at the top of the view
		near(lyingSight(0, LIE_TURN).up, [0, 0, -1]);
	});

	test("it goes with the way the body lies", () => {
		const { look, up } = lyingSight(Math.PI / 2);
		near(look, [0, 1, 0]);
		near(up, [-1, 0, 0]);
		near(lyingSight(Math.PI / 2, LIE_TURN).look, [0, 0, 1]);
	});

	test("nodding goes past the top of the head, or towards the feet; the view stays upright", () => {
		const past = lyingSight(0, 0, 0.5);
		expect(past.look.y).toBeCloseTo(Math.cos(0.5));
		expect(past.look.z).toBeCloseTo(-Math.sin(0.5));
		expect(past.look.dot(past.up)).toBeCloseTo(0);
		const feet = lyingSight(0, 0, -0.5);
		expect(feet.look.z).toBeCloseTo(Math.sin(0.5));
		expect(feet.look.dot(feet.up)).toBeCloseTo(0);
		expect(lyingSight(0, 0.7, 0.4).look.length()).toBeCloseTo(1);
	});
});

describe("on the way down and up again", () => {
	const standing = new THREE.Vector3(0, -0.12, 1).normalize();

	test("from how it looks standing to how it looks lying", () => {
		const lying = lyingSight(0);
		const up = sightBetween(standing, lying, 0);
		expect(up.look).toBe(standing);
		near(up.up, [0, 1, 0]);
		const down = sightBetween(standing, lying, 1);
		near(down.look, [0, 1, 0]);
		near(down.up, [0, 0, -1]);
	});

	test("however it looked, a camera can always tell the top of its view", () => {
		for (const yaw of [0, 1, 2, Math.PI, 4, 5])
			for (const pitch of [-1.2, -0.12, 0, 1.2])
				for (let a = 0; a <= 1; a += 0.05) {
					const from = new THREE.Vector3(
						Math.sin(yaw) * Math.cos(pitch),
						Math.sin(pitch),
						Math.cos(yaw) * Math.cos(pitch),
					);
					const { look, up } = sightBetween(from, lyingSight(0), a);
					expect(look.clone().cross(up).lengthSq()).toBeGreaterThan(1e-4);
				}
	});

	test("an up along the way it looks is replaced", () => {
		const look = new THREE.Vector3(0, 0, 1);
		expect(steadyUp(look, new THREE.Vector3(0, 0, -1)).y).toBe(1);
		const skyward = new THREE.Vector3(0, 1, 0);
		expect(steadyUp(skyward, new THREE.Vector3(0, 1, 0)).z).toBe(1);
		const fine = new THREE.Vector3(0, 1, 0);
		expect(steadyUp(look, fine)).toBe(fine);
	});
});
