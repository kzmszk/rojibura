// The exposure meter's arithmetic (exposure.ts), after the city demos' shared/exposure tests.
import { expect, test } from "vitest";
import { adapt, exposureBoost, meanLog } from "./exposure.ts";

const P = { target: -3.5, strength: 0.85, max: 5 };

test("a frame at or above the target keeps its exposure; no reading yet keeps it too", () => {
	expect(exposureBoost(-3.35, 1, P)).toBe(1); // a sunlit street of houses
	expect(exposureBoost(-3.5, 1, P)).toBe(1);
	expect(exposureBoost(null, 1, P)).toBe(1);
	expect(exposureBoost(-8, 0, P)).toBe(1);
});

test("a dark frame is lifted part of the way, in stops, after the exposure already given", () => {
	// the church's side in shade: -5.85 metered at exposure 0.95
	expect(exposureBoost(-5.85, 0.95, P)).toBeCloseTo(2 ** (0.85 * (-3.5 - (-5.85 + Math.log2(0.95)))));
	expect(exposureBoost(-5, 2, P)).toBeLessThan(exposureBoost(-5, 1, P));
});

test("the lift is capped", () => {
	expect(exposureBoost(-16, 1, P)).toBe(5);
});

test("adapt eases in stops, opening slower than closing, and arrives at once with a long step", () => {
	expect(adapt(1, 8, 0.5, { up: 1, down: 2 })).toBeCloseTo(2 ** 1.5);
	expect(adapt(8, 1, 0.25, { up: 1, down: 2 })).toBeCloseTo(2 ** 1.5);
	expect(adapt(1, 8, 10)).toBeCloseTo(8);
});

test("meanLog reads the 8-bit log2 luminance back (-16 … +4) and weights the centre", () => {
	const w = 8;
	const h = 4;
	const px = new Uint8Array(w * h * 4);
	expect(meanLog(px, w, h)).toBe(-16);
	for (let i = 0; i < px.length; i += 4) px[i] = 255;
	expect(meanLog(px, w, h)).toBeCloseTo(4);
	// a bright centre counts for more than bright corners
	const centre = new Uint8Array(w * h * 4);
	const corner = new Uint8Array(w * h * 4);
	centre[(2 * w + 4) * 4] = 255;
	corner[0] = 255;
	expect(meanLog(centre, w, h)).toBeGreaterThan(meanLog(corner, w, h));
});
