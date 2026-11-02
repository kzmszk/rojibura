// The town's three seasons, and which one a date falls in.

export type Season = "spring" | "autumn" | "winter";

export const SEASONS: readonly Season[] = ["spring", "autumn", "winter"];

/**
 * The season for a date, by the month in Japan (JST, UTC+9, no daylight saving): December to February is
 * winter, March to July spring (blossom, then fresh green), August to November autumn.
 */
export function seasonFor(date: Date): Season {
	const month = new Date(date.getTime() + 9 * 3600_000).getUTCMonth() + 1;
	if (month === 12 || month <= 2) return "winter";
	if (month <= 7) return "spring";
	return "autumn";
}

/** Light and air that suit the season, for the scene to apply (Nature.view). */
export interface SeasonView {
	/** Sky (background) and fog colour, CSS. */
	sky: string;
	/** Fog near and far (metres). */
	fog: [number, number];
	sunColor: number;
	sunIntensity: number;
	hemiSky: number;
	hemiGround: number;
	hemiIntensity: number;
}

export const VIEWS: Record<Season, SeasonView> = {
	// a soft hazy spring day
	spring: {
		sky: "#c4dbee",
		fog: [90, 620],
		sunColor: 0xfff3e2,
		sunIntensity: 2.5,
		hemiSky: 0xe6f0ff,
		hemiGround: 0x6f6a52,
		hemiIntensity: 1.5,
	},
	// a clear, crisp autumn afternoon: a lower, warmer sun
	autumn: {
		sky: "#a9c8e4",
		fog: [110, 700],
		sunColor: 0xffe2bc,
		sunIntensity: 2.7,
		hemiSky: 0xdfe9f8,
		hemiGround: 0x6e5a40,
		hemiIntensity: 1.35,
	},
	// a pale winter day after snowfall: weak sun, much light from the sky and from the snow
	winter: {
		sky: "#d3dbe4",
		fog: [70, 520],
		sunColor: 0xfff4ea,
		sunIntensity: 1.7,
		hemiSky: 0xe2eaf5,
		hemiGround: 0xc2c8d2,
		hemiIntensity: 1.55,
	},
};
