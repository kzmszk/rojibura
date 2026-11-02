// The trees of the town: crown shapes, branching, bark and leaves, and their colours through the seasons.
// Crown parameters after the Kyoto demo's generator (~/work/demos/kyoto/tools/gen/treegen.py), autumn colours
// after its palettes (photographs of maples, ginkgo and zelkova in autumn), all in linear RGB.

import type { Season } from "./season.ts";

export type Species =
	| "sakura"
	| "momiji"
	| "kaede"
	| "ichou"
	| "keyaki"
	| "nara"
	| "platanus"
	| "bodaiju"
	| "shirakaba"
	| "matsu"
	| "sugi";

/** Crown outlines: radius at a height (treegen envelope). */
export type Crown = "dome" | "round" | "spread" | "oval" | "vase" | "cone" | "pine";

/** Leaf atlas cells (4 x 4, see atlas.ts). */
export const CELL = {
	momiji: 0,
	kaede: 1,
	ichou: 2,
	keyaki: 3,
	nara: 4,
	platanus: 5,
	bodaiju: 6,
	shirakaba: 7,
	sakura: 8,
	blossom: 9,
	pine: 10,
	cedar: 11,
	twigs: 12,
	litter: 13,
	singles: 14,
	petals: 15,
} as const;

/** Single leaves in the singles cell (a 4 x 4 grid), for falling leaves and petals. */
export const SINGLE = {
	momiji: 0,
	kaede: 1,
	ichou: 2,
	keyaki: 3,
	nara: 4,
	platanus: 5,
	bodaiju: 6,
	shirakaba: 7,
	sakura: 8,
	petal: 9,
	petal2: 10,
	momiji2: 11,
} as const;

/** Bark atlas cells (4 x 2, assets/tex/nature/bark.jpg, made by dev/nature-tex.py). */
export const BARK = {
	sakura: 0,
	pine: 1,
	cedar: 2,
	smooth: 3,
	birch: 4,
	plane: 5,
	furrowed: 6,
	keyaki: 7,
} as const;
/** Size of one bark cell on the tree (metres around, metres along). */
export const BARK_SIZE: [number, number][] = [
	[0.8, 0.8],
	[1.0, 1.0],
	[0.5, 1.0],
	[0.6, 0.6],
	[0.7, 0.7],
	[1.0, 1.0],
	[0.6, 1.2],
	[0.7, 0.7],
];

type RGB = [number, number, number];

/**
 * Leaf colour in a season: a ramp of six stops walked by a stage P per leaf. P = base + a per-tree offset
 * (spread) + the leaf's place in the crown (outer: sunlit outside and top go first) + leaf by leaf (leaf);
 * a share of trees (greenFrac) lag behind at greenAt.
 */
export interface Ramp {
	stops: [RGB, RGB, RGB, RGB, RGB, RGB];
	base: number;
	spread: number;
	outer: number;
	leaf: number;
	greenFrac: number;
	greenAt: number;
}

export interface SpeciesDef {
	name: Species;
	deciduous: boolean;
	/** Height range of a typical adult (metres, s = 1). */
	height: [number, number];
	crown: Crown;
	/** Crown radius, centre height, half height and the clear trunk below it, as fractions of the height. */
	R: number;
	zc: number;
	zr: number;
	zs: number;
	/** Main branches and their elevation (degrees). */
	n1: [number, number];
	el1: [number, number];
	/** Branching depth: 2 for conifers, 3 to 4 for broadleaves (fine twigs in winter). */
	levels: number;
	/** Children per branch at depth 1 and deeper. */
	kids: [number, number];
	/** Leaf card size (metres) and count (full detail). */
	card: [number, number];
	cards: number;
	/** Trunk radius at the base as a fraction of the height. */
	r0: number;
	/** Upward (+) or downward (-) bend of branches per step. */
	bend: number;
	leafCell: number;
	single: number;
	bark: number;
	/** Bark colour multiplier (linear). */
	barkTint: RGB;
	/** Fallen leaves in autumn: patches per square metre of crown. */
	litter: number;
	ramps: Record<Season, Ramp>;
}

const green = (a: RGB, b: RGB): Ramp => ({
	stops: [a, a, b, b, b, b],
	base: 0.3,
	spread: 0.4,
	outer: 0.3,
	leaf: 0.3,
	greenFrac: 0,
	greenAt: 0,
});
// spring: fresh light green (shinryoku), a little yellower outside
const FRESH: Ramp = {
	stops: [
		[0.1, 0.24, 0.03],
		[0.16, 0.34, 0.04],
		[0.24, 0.45, 0.05],
		[0.34, 0.54, 0.07],
		[0.42, 0.6, 0.09],
		[0.5, 0.64, 0.12],
	],
	base: 0.55,
	spread: 0.35,
	outer: 0.35,
	leaf: 0.3,
	greenFrac: 0,
	greenAt: 0,
};
const freshDark = (k: number): Ramp => ({
	...FRESH,
	stops: FRESH.stops.map((c) => [c[0] * k, c[1] * k, c[2] * k]) as Ramp["stops"],
});
const BARE: Ramp = green([0.06, 0.05, 0.04], [0.06, 0.05, 0.04]);

// maples: each tree at its own stage of green -> yellow-green -> amber -> orange -> scarlet -> crimson
const MAPLE: Ramp = {
	stops: [
		[0.1, 0.17, 0.03],
		[0.42, 0.4, 0.04],
		[0.74, 0.42, 0.03],
		[0.8, 0.2, 0.02],
		[0.62, 0.045, 0.015],
		[0.4, 0.012, 0.012],
	],
	base: 0.72,
	spread: 0.5,
	outer: 0.35,
	leaf: 0.3,
	greenFrac: 0.12,
	greenAt: 0.12,
};

export const SPECIES: Record<Species, SpeciesDef> = {
	sakura: {
		name: "sakura",
		deciduous: true,
		height: [7, 9.5],
		crown: "spread",
		R: 0.72,
		zc: 0.6,
		zr: 0.38,
		zs: 0.22,
		n1: [4, 6],
		el1: [18, 42],
		levels: 4,
		kids: [3, 3],
		card: [0.8, 1.1],
		cards: 720,
		r0: 0.024,
		bend: -0.01,
		leafCell: CELL.sakura,
		single: SINGLE.sakura,
		bark: BARK.sakura,
		barkTint: [0.62, 0.52, 0.52],
		litter: 0.7,
		ramps: {
			// blossom (the blossom cell): white with a blush, pinker at the buds and on some trees
			spring: {
				stops: [
					[1.0, 0.8, 0.86],
					[0.99, 0.74, 0.82],
					[0.98, 0.66, 0.77],
					[0.96, 0.58, 0.71],
					[0.93, 0.5, 0.65],
					[0.9, 0.43, 0.58],
				],
				base: 0.35,
				spread: 0.45,
				outer: -0.2,
				leaf: 0.5,
				greenFrac: 0,
				greenAt: 0,
			},
			// cherry leaves turn early: orange, red and yellow mottled
			autumn: {
				stops: [
					[0.16, 0.2, 0.04],
					[0.6, 0.44, 0.05],
					[0.74, 0.27, 0.04],
					[0.64, 0.12, 0.03],
					[0.46, 0.07, 0.03],
					[0.3, 0.045, 0.025],
				],
				base: 0.55,
				spread: 0.35,
				outer: 0.3,
				leaf: 0.6,
				greenFrac: 0.05,
				greenAt: 0.2,
			},
			winter: BARE,
		},
	},
	momiji: {
		name: "momiji",
		deciduous: true,
		height: [5, 8],
		crown: "dome",
		R: 0.62,
		zc: 0.58,
		zr: 0.42,
		zs: 0.16,
		n1: [5, 7],
		el1: [25, 55],
		levels: 4,
		kids: [3, 3],
		card: [0.65, 0.9],
		cards: 760,
		r0: 0.017,
		bend: 0,
		leafCell: CELL.momiji,
		single: SINGLE.momiji,
		bark: BARK.smooth,
		barkTint: [0.75, 0.72, 0.7],
		litter: 2.2,
		ramps: { spring: FRESH, autumn: MAPLE, winter: BARE },
	},
	kaede: {
		name: "kaede",
		deciduous: true,
		height: [8, 12],
		crown: "round",
		R: 0.5,
		zc: 0.6,
		zr: 0.4,
		zs: 0.2,
		n1: [5, 8],
		el1: [30, 55],
		levels: 4,
		kids: [3, 3],
		card: [0.8, 1.1],
		cards: 820,
		r0: 0.017,
		bend: 0,
		leafCell: CELL.kaede,
		single: SINGLE.kaede,
		bark: BARK.smooth,
		barkTint: [0.8, 0.85, 0.85],
		litter: 1.6,
		ramps: {
			spring: FRESH,
			// itaya / hauchiwa maples: yellow to orange, some with a red flush
			autumn: {
				stops: [
					[0.12, 0.2, 0.04],
					[0.45, 0.45, 0.05],
					[0.82, 0.56, 0.04],
					[0.88, 0.42, 0.03],
					[0.8, 0.26, 0.025],
					[0.66, 0.12, 0.02],
				],
				base: 0.55,
				spread: 0.45,
				outer: 0.3,
				leaf: 0.25,
				greenFrac: 0.08,
				greenAt: 0.18,
			},
			winter: BARE,
		},
	},
	ichou: {
		name: "ichou",
		deciduous: true,
		height: [12, 17],
		crown: "oval",
		R: 0.27,
		zc: 0.55,
		zr: 0.48,
		zs: 0.12,
		n1: [10, 14],
		el1: [40, 62],
		levels: 3,
		kids: [3, 3],
		card: [0.95, 1.3],
		cards: 950,
		r0: 0.018,
		bend: 0.03,
		leafCell: CELL.ichou,
		single: SINGLE.ichou,
		bark: BARK.furrowed,
		barkTint: [1.0, 0.95, 0.9],
		litter: 2.4,
		ramps: {
			spring: FRESH,
			// one bright gold, hardly any variation inside a tree, a few trees still yellow-green
			autumn: {
				stops: [
					[0.18, 0.28, 0.04],
					[0.55, 0.56, 0.05],
					[0.86, 0.66, 0.04],
					[0.92, 0.62, 0.03],
					[0.9, 0.56, 0.025],
					[0.86, 0.5, 0.02],
				],
				base: 0.66,
				spread: 0.22,
				outer: 0.1,
				leaf: 0.08,
				greenFrac: 0.06,
				greenAt: 0.3,
			},
			winter: BARE,
		},
	},
	keyaki: {
		name: "keyaki",
		deciduous: true,
		height: [13, 18],
		crown: "vase",
		R: 0.46,
		zc: 0.62,
		zr: 0.4,
		zs: 0.2,
		n1: [6, 9],
		el1: [52, 72],
		levels: 4,
		kids: [3, 3],
		card: [1.0, 1.4],
		cards: 1000,
		r0: 0.017,
		bend: 0.02,
		leafCell: CELL.keyaki,
		single: SINGLE.keyaki,
		bark: BARK.keyaki,
		barkTint: [1, 1, 1],
		litter: 1.2,
		ramps: {
			spring: freshDark(0.92),
			// rusty orange-brown, some trees yellower, some still dull green
			autumn: {
				stops: [
					[0.12, 0.17, 0.04],
					[0.42, 0.34, 0.06],
					[0.58, 0.28, 0.06],
					[0.5, 0.18, 0.05],
					[0.36, 0.12, 0.04],
					[0.26, 0.1, 0.04],
				],
				base: 0.58,
				spread: 0.4,
				outer: 0.3,
				leaf: 0.25,
				greenFrac: 0.1,
				greenAt: 0.15,
			},
			winter: BARE,
		},
	},
	nara: {
		name: "nara",
		deciduous: true,
		height: [10, 14],
		crown: "round",
		R: 0.46,
		zc: 0.6,
		zr: 0.4,
		zs: 0.24,
		n1: [5, 8],
		el1: [28, 55],
		levels: 4,
		kids: [3, 3],
		card: [1.0, 1.3],
		cards: 900,
		r0: 0.021,
		bend: -0.01,
		leafCell: CELL.nara,
		single: SINGLE.nara,
		bark: BARK.furrowed,
		barkTint: [0.95, 0.92, 0.88],
		litter: 1.3,
		ramps: {
			spring: freshDark(0.95),
			// oaks: brown-yellow, late, leathery
			autumn: {
				stops: [
					[0.14, 0.19, 0.05],
					[0.4, 0.36, 0.08],
					[0.52, 0.36, 0.09],
					[0.46, 0.27, 0.08],
					[0.34, 0.18, 0.06],
					[0.24, 0.13, 0.05],
				],
				base: 0.55,
				spread: 0.4,
				outer: 0.3,
				leaf: 0.3,
				greenFrac: 0.15,
				greenAt: 0.2,
			},
			winter: BARE,
		},
	},
	platanus: {
		name: "platanus",
		deciduous: true,
		height: [14, 19],
		crown: "round",
		R: 0.42,
		zc: 0.6,
		zr: 0.4,
		zs: 0.24,
		n1: [5, 7],
		el1: [35, 60],
		levels: 4,
		kids: [3, 3],
		card: [1.1, 1.5],
		cards: 900,
		r0: 0.022,
		bend: 0,
		leafCell: CELL.platanus,
		single: SINGLE.platanus,
		bark: BARK.plane,
		barkTint: [1, 1, 1],
		litter: 1.0,
		ramps: {
			spring: freshDark(0.9),
			// plane trees: dull yellow to tan-brown
			autumn: {
				stops: [
					[0.16, 0.22, 0.05],
					[0.44, 0.42, 0.09],
					[0.58, 0.44, 0.11],
					[0.5, 0.33, 0.1],
					[0.38, 0.24, 0.08],
					[0.28, 0.18, 0.07],
				],
				base: 0.5,
				spread: 0.4,
				outer: 0.35,
				leaf: 0.3,
				greenFrac: 0.1,
				greenAt: 0.2,
			},
			winter: BARE,
		},
	},
	bodaiju: {
		name: "bodaiju",
		deciduous: true,
		height: [12, 17],
		crown: "oval",
		R: 0.36,
		zc: 0.58,
		zr: 0.44,
		zs: 0.16,
		n1: [8, 12],
		el1: [35, 60],
		levels: 4,
		kids: [3, 2],
		card: [1.0, 1.3],
		cards: 950,
		r0: 0.018,
		bend: 0,
		leafCell: CELL.bodaiju,
		single: SINGLE.bodaiju,
		bark: BARK.furrowed,
		barkTint: [0.85, 0.85, 0.85],
		litter: 1.1,
		ramps: {
			spring: FRESH,
			// lindens: clear yellow, a little brown at the end
			autumn: {
				stops: [
					[0.18, 0.28, 0.05],
					[0.5, 0.52, 0.07],
					[0.76, 0.6, 0.07],
					[0.72, 0.5, 0.07],
					[0.56, 0.38, 0.07],
					[0.4, 0.27, 0.06],
				],
				base: 0.45,
				spread: 0.4,
				outer: 0.3,
				leaf: 0.2,
				greenFrac: 0.12,
				greenAt: 0.25,
			},
			winter: BARE,
		},
	},
	shirakaba: {
		name: "shirakaba",
		deciduous: true,
		height: [10, 14],
		crown: "oval",
		R: 0.24,
		zc: 0.6,
		zr: 0.42,
		zs: 0.25,
		n1: [8, 12],
		el1: [42, 68],
		levels: 4,
		kids: [3, 2],
		card: [0.7, 1.0],
		cards: 700,
		r0: 0.012,
		bend: -0.02,
		leafCell: CELL.shirakaba,
		single: SINGLE.shirakaba,
		bark: BARK.birch,
		barkTint: [1, 1, 1],
		litter: 0.9,
		ramps: {
			spring: {
				...FRESH,
				base: 0.7,
			},
			// birches: bright butter yellow
			autumn: {
				stops: [
					[0.2, 0.3, 0.05],
					[0.62, 0.6, 0.06],
					[0.86, 0.66, 0.05],
					[0.84, 0.58, 0.04],
					[0.7, 0.44, 0.04],
					[0.5, 0.3, 0.04],
				],
				base: 0.5,
				spread: 0.35,
				outer: 0.3,
				leaf: 0.25,
				greenFrac: 0.08,
				greenAt: 0.2,
			},
			winter: BARE,
		},
	},
	matsu: {
		name: "matsu",
		deciduous: false,
		height: [8, 12],
		crown: "pine",
		R: 0.42,
		zc: 0.68,
		zr: 0.32,
		zs: 0.38,
		n1: [6, 9],
		el1: [-5, 30],
		levels: 3,
		kids: [3, 2],
		card: [0.9, 1.3],
		cards: 520,
		r0: 0.024,
		bend: 0.015,
		leafCell: CELL.pine,
		single: SINGLE.momiji,
		bark: BARK.pine,
		barkTint: [0.95, 0.9, 0.9],
		litter: 0,
		ramps: {
			spring: green([0.07, 0.14, 0.045], [0.11, 0.19, 0.06]),
			autumn: green([0.065, 0.13, 0.04], [0.1, 0.17, 0.055]),
			winter: green([0.06, 0.11, 0.04], [0.085, 0.14, 0.05]),
		},
	},
	sugi: {
		name: "sugi",
		deciduous: false,
		height: [18, 26],
		crown: "cone",
		R: 0.17,
		zc: 0.6,
		zr: 0.45,
		zs: 0.28,
		n1: [24, 32],
		el1: [-15, 12],
		levels: 2,
		kids: [3, 3],
		card: [1.3, 1.9],
		cards: 1300,
		r0: 0.015,
		bend: -0.05,
		leafCell: CELL.cedar,
		single: SINGLE.momiji,
		bark: BARK.cedar,
		barkTint: [1, 1, 1],
		litter: 0,
		ramps: {
			spring: green([0.07, 0.13, 0.04], [0.11, 0.18, 0.055]),
			autumn: green([0.07, 0.12, 0.04], [0.1, 0.15, 0.05]),
			// cedars bronze a little in the cold
			winter: green([0.1, 0.1, 0.045], [0.14, 0.13, 0.06]),
		},
	},
};

export const SPECIES_NAMES = Object.keys(SPECIES) as Species[];
export const speciesIndex = (sp: Species): number => SPECIES_NAMES.indexOf(sp);
