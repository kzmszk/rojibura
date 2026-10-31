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

/** The page in the other area, arriving next to the portal back. */
export function travelUrl(portal: Portal, avatar: string): string {
	const q = new URLSearchParams({ area: portal.to, at: portal.at, avatar });
	return `/?${q}`;
}
