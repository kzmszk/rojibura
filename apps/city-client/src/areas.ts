// Areas and portals (docs/prd.md 3.8): which area this page is in, where its files are, and the way out.

import type { AreaId, AreaInfo, AreasData, Portal, Vec2 } from "@rojibura/protocol";

export interface Area extends AreaInfo {
	id: AreaId;
	/** Base URL of the 3D files, ending in "/". */
	assetBase: string;
}

const withSlash = (s: string) => (s.endsWith("/") ? s : `${s}/`);

/**
 * The area named by `?area=` (the main one when absent or unknown). Development builds take `?assets=` to load
 * the 3D files from somewhere else, e.g. a local copy before it is deployed.
 */
export async function currentArea(
	params: URLSearchParams,
	dev: boolean,
): Promise<{ area: Area; all: AreasData }> {
	const all = (await (await fetch("/areas.json")).json()) as AreasData;
	const ids = Object.keys(all.areas);
	const asked = params.get("area") ?? "";
	const id = all.areas[asked] ? asked : (ids[0] as AreaId);
	const info = all.areas[id] as AreaInfo;
	const override = dev ? params.get("assets") : null;
	return { area: { ...info, id, assetBase: withSlash(override ?? info.assets ?? info.dir) }, all };
}

/**
 * Where you were in this area, kept by this tab: loaded again, it draws what is round you first. Only that: where you
 * really are is the host's to say.
 */
const placeKey = (area: AreaId) => `rj.place.${area}`;

export function keepPlace(area: AreaId, at: Vec2): void {
	try {
		sessionStorage.setItem(placeKey(area), JSON.stringify(at));
	} catch {
		// private mode: the 3D round where everyone arrives comes first, then
	}
}

export function keptPlace(area: AreaId): Vec2 | null {
	try {
		const v = JSON.parse(sessionStorage.getItem(placeKey(area)) ?? "null") as unknown;
		return Array.isArray(v) && v.length === 2 && v.every((n) => typeof n === "number") ? (v as Vec2) : null;
	} catch {
		return null;
	}
}

/** How much 3D detail to draw: the area's lighter files (`sceneLite`) on phones and tablets, or as chosen. */
export type Detail = "auto" | "full" | "lite";
export const DETAIL_KEY = "rj.detail";

/** The detail chosen in the settings (kept in this browser), "auto" when none. */
export function savedDetail(): Detail {
	try {
		const v = localStorage.getItem(DETAIL_KEY);
		return v === "full" || v === "lite" ? v : "auto";
	} catch {
		return "auto";
	}
}

/** A phone or a tablet: the main pointer is a finger. */
export function touchFirst(): boolean {
	return matchMedia("(pointer: coarse)").matches;
}

/** Files with bounds this near where you arrive (metres) are drawn before you enter. */
const NEAR_ENTRY = 40;

/**
 * The glb files to draw: `sceneLite` when the area has it and `?detail=lite` (or `full`), else the setting, asks
 * for it, or, left to "auto", on a device whose main pointer is a finger (a phone or a tablet). `files` are drawn
 * before entering: those near `at` (where you arrive) and the area's `first` ones without bounds; `later` once in,
 * the others without bounds first, then the far pieces nearest first.
 */
export function sceneFiles(
	area: AreaInfo,
	params: URLSearchParams,
	at: Vec2 | null = null,
): { files: string[]; later: string[]; lite: boolean } {
	let lite = false;
	if (area.sceneLite) {
		const asked = params.get("detail");
		const detail = asked === "full" || asked === "lite" ? asked : savedDetail();
		lite = detail === "auto" ? touchFirst() : detail === "lite";
	}
	const all = lite && area.sceneLite ? area.sceneLite : area.scene;
	const files: string[] = [];
	const unbounded: string[] = [];
	const far: { f: string; d: number }[] = [];
	let n = 0;
	all.forEach((f, i) => {
		const b = area.bounds?.[f] ?? area.bounds?.[area.scene[i] ?? ""];
		if (!b) {
			(n++ < (area.first ?? all.length) ? files : unbounded).push(f);
			return;
		}
		const d = at
			? Math.hypot(Math.max(b[0] - at[0], 0, at[0] - b[2]), Math.max(b[1] - at[1], 0, at[1] - b[3]))
			: 0;
		if (d <= NEAR_ENTRY) files.push(f);
		else far.push({ f, d });
	});
	far.sort((a, b) => a.d - b.d);
	return { files, later: [...unbounded, ...far.map((x) => x.f)], lite };
}

/** The page in the other area, arriving next to the portal back. */
export function travelUrl(portal: Portal, avatar: string): string {
	const q = new URLSearchParams({ area: portal.to, at: portal.at, avatar });
	return `/?${q}`;
}
