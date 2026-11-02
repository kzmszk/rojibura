import { describe, expect, it } from "vitest";
import { seasonFor } from "./season.ts";
import { SPECIES_NAMES } from "./species.ts";
import { makeTree, triangles, VARIANTS } from "./treegen.ts";

describe("seasonFor", () => {
	it("goes by the month in Japan", () => {
		expect(seasonFor(new Date("2026-01-15T12:00:00+09:00"))).toBe("winter");
		expect(seasonFor(new Date("2026-02-28T23:59:00+09:00"))).toBe("winter");
		// 1 March 00:30 in Tokyo is still February in UTC
		expect(seasonFor(new Date("2026-03-01T00:30:00+09:00"))).toBe("spring");
		expect(seasonFor(new Date("2026-07-31T12:00:00+09:00"))).toBe("spring");
		expect(seasonFor(new Date("2026-08-01T12:00:00+09:00"))).toBe("autumn");
		expect(seasonFor(new Date("2026-11-30T23:00:00+09:00"))).toBe("autumn");
		// 16:00 UTC on 30 November is 1 December in Tokyo
		expect(seasonFor(new Date("2026-11-30T16:00:00Z"))).toBe("winter");
	});
});

describe("tree templates", () => {
	it("are deterministic", () => {
		const a = makeTree("momiji", 1, 0);
		const b = makeTree("momiji", 1, 0);
		expect(a.height).toBe(b.height);
		expect(Array.from(a.leaves.position.slice(0, 30))).toEqual(Array.from(b.leaves.position.slice(0, 30)));
	});

	it("have wood, cards on twigs and a sane size for every species", () => {
		for (const sp of SPECIES_NAMES) {
			for (let v = 0; v < VARIANTS; v++) {
				const near = makeTree(sp, v, 0);
				const far = makeTree(sp, v, 1);
				expect(near.wood.index.length).toBeGreaterThan(0);
				expect(near.leaves.index.length / 6).toBeGreaterThan(100);
				expect(near.twigCards).toBeGreaterThan(20);
				expect(near.twigCards * 6).toBeLessThanOrEqual(near.leaves.index.length);
				expect(near.height).toBeGreaterThan(4);
				expect(near.height).toBeLessThan(32);
				expect(near.radius).toBeGreaterThan(1);
				expect(triangles(far)).toBeLessThan(triangles(near) / 3);
				// indices stay inside the vertex arrays
				expect(near.wood.index.every((i) => i < near.wood.position.length / 3)).toBe(true);
				expect(near.leaves.index.every((i) => i < near.leaves.position.length / 3)).toBe(true);
			}
		}
	});
});
