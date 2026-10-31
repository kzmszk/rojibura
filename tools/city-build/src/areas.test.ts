// assets/areas.json against the files (docs/prd.md 3.8): each area's own files are where `dir` says, and its 3D
// files too unless they come from another origin.
import { existsSync, readFileSync } from "node:fs";
import { expect, test } from "vitest";

const assets = new URL("../../../assets/", import.meta.url);
const file = (dir: string, name: string) => new URL(`.${dir}/${name}`, assets);
/** What this needs of AreasData (@rojibura/protocol). */
interface Areas {
	areas: Record<string, { dir: string; scene: string[]; assets?: string; build?: boolean }>;
}
const areas = JSON.parse(readFileSync(new URL("areas.json", assets), "utf8")) as Areas;

test.each(Object.keys(areas.areas))("%s: files on the host and the scene", (id) => {
	const area = areas.areas[id];
	if (!area) throw new Error(`no ${id}`);
	for (const name of ["landmarks.json", "navmesh.json"]) expect(existsSync(file(area.dir, name))).toBe(true);
	if (area.build) expect(existsSync(file(area.dir, "navmesh.base.json"))).toBe(true);
	expect(area.scene.length).toBeGreaterThan(0);
	if (!area.assets) for (const s of area.scene) expect(existsSync(file(area.dir, s))).toBe(true);
	// another origin: https, a folder (the scene files are relative to it)
	else expect(area.assets).toMatch(/^https:\/\/[^/]+\/.*\/$/);
});
