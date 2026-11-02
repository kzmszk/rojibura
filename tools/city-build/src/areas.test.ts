// assets/areas.json against the files (docs/prd.md 3.8): each area's own files are where `dir` says, and its 3D
// files are recorded in assets/areas/files.json (they are deployed but not in git) unless they come from another
// origin.
import { existsSync, readFileSync } from "node:fs";
import { expect, test } from "vitest";
import type { AssetsManifest } from "../../assets.ts";

const assets = new URL("../../../assets/", import.meta.url);
const file = (dir: string, name: string) => new URL(`.${dir}/${name}`, assets);
/** What this needs of AreasData (@rojibura/protocol). */
interface Areas {
	areas: Record<
		string,
		{ dir: string; scene: string[]; winter?: string[]; assets?: string; build?: boolean }
	>;
}
const areas = JSON.parse(readFileSync(new URL("areas.json", assets), "utf8")) as Areas;
const recorded = JSON.parse(readFileSync(new URL("areas/files.json", assets), "utf8")) as AssetsManifest;

test.each(Object.keys(areas.areas))("%s: files on the host and the scene", (id) => {
	const area = areas.areas[id];
	if (!area) throw new Error(`no ${id}`);
	for (const name of ["landmarks.json", "navmesh.json"]) expect(existsSync(file(area.dir, name))).toBe(true);
	if (area.build) expect(existsSync(file(area.dir, "navmesh.base.json"))).toBe(true);
	expect(area.scene.length).toBeGreaterThan(0);
	if (!area.assets)
		for (const s of [...area.scene, ...(area.winter ?? [])])
			expect(recorded.files[`${area.dir.slice(1)}/${s}`], `${area.dir}/${s} in files.json`).toBeDefined();
	// another origin: https, a folder (the scene files are relative to it)
	else expect(area.assets).toMatch(/^https:\/\/[^/]+\/.*\/$/);
});

test("every recorded 3D file is in the areas folder and is a glb", () => {
	for (const path of Object.keys(recorded.files)) expect(path).toMatch(/^areas\/[a-z0-9_-]+\/.+\.glb$/);
});
