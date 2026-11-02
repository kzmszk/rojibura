// Small seeded random numbers, so the trees and the ground cover come out the same on every machine.

export class Rng {
	private s: number;

	constructor(seed: number) {
		this.s = seed >>> 0 || 0x9e3779b9;
	}

	/** Uniform in [0, 1) (mulberry32). */
	next(): number {
		this.s = (this.s + 0x6d2b79f5) >>> 0;
		let t = this.s;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	}

	range(a: number, b: number): number {
		return a + (b - a) * this.next();
	}

	/** An integer in [a, b] (both included). */
	int(a: number, b: number): number {
		return a + Math.floor(this.next() * (b - a + 1));
	}

	/** Normal with mean 0 and deviation `sd` (Box-Muller). */
	normal(sd = 1): number {
		const u = 1 - this.next();
		return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * this.next()) * sd;
	}

	pick<T>(items: readonly T[]): T {
		return items[Math.floor(this.next() * items.length)] as T;
	}
}

/** A hash of numbers to [0, 1), for per-place randomness without state. */
export function hash01(...v: number[]): number {
	let h = 2166136261;
	for (const x of v) {
		h = Math.imul(h ^ Math.round(x * 1000), 16777619);
		h ^= h >>> 13;
	}
	h = Math.imul(h ^ (h >>> 16), 2246822507);
	h = Math.imul(h ^ (h >>> 13), 3266489909);
	return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
