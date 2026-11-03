// Areas and portals (docs/prd.md 3.8): which area this page is in, where its files are, and the way out.

import type { AreaId, AreaInfo, AreasData, Portal } from "@rojibura/protocol";

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

/**
 * The glb files to draw: `sceneLite` when the area has it and `?detail=lite` (or `full`), else the setting, asks
 * for it, or, left to "auto", on a device whose main pointer is a finger (a phone or a tablet). `files` are drawn
 * before entering, `later` once in (the area's `first`).
 */
export function sceneFiles(
	area: AreaInfo,
	params: URLSearchParams,
): { files: string[]; later: string[]; lite: boolean } {
	const split = (files: string[]) => {
		const n = area.first ?? files.length;
		return { files: files.slice(0, n), later: files.slice(n) };
	};
	if (!area.sceneLite) return { ...split(area.scene), lite: false };
	const asked = params.get("detail");
	const detail = asked === "full" || asked === "lite" ? asked : savedDetail();
	const lite = detail === "auto" ? touchFirst() : detail === "lite";
	return { ...split(lite ? area.sceneLite : area.scene), lite };
}

/** The page in the other area, arriving next to the portal back. */
export function travelUrl(portal: Portal, avatar: string): string {
	const q = new URLSearchParams({ area: portal.to, at: portal.at, avatar });
	return `/?${q}`;
}
