// Publishes what was built in free play (docs/prd.md 3.7.8), so a deploy shows it to everyone:
//   * assets/test-city/builds.json    every build in the local city, and the registered models they use
//   * assets/models/m_*.glb|nav.json|png   those models' files (static assets)
//   * assets/test-city/navmesh.json    navmesh.base.json with the builds baked in
//
//   node tools/city-build/src/publish.ts [--base http://localhost:5173]     (pnpm builds:publish)
//
// Reads the city running with `pnpm dev:free`. It writes files only; commit them and `cf deploy`.

import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { type LandmarksData, type ModelNav, NavMesh, type NavMeshData } from "@rojibura/nav";
import { type BakedBuild, bake, builtinNavs, type Published, unreachable } from "./bake.ts";

const ROOT = resolve(new URL(".", import.meta.url).pathname, "../../..");
const CITY = join(ROOT, "assets/test-city");
const MODELS = join(ROOT, "assets/models");

const { values } = parseArgs({
	options: { base: { type: "string", default: process.env.RJ_BASE ?? "http://localhost:5173" } },
});
const base = values.base as string;
const kb = (n: number) => `${(n / 1024).toFixed(0)} KB`;

async function get(path: string): Promise<Response> {
	const r = await fetch(`${base}${path}`);
	if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text().catch(() => "")}`);
	return r;
}

const health = (await (await get("/api/health")).json()) as { freePlay?: boolean };
if (!health.freePlay) throw new Error("the city is not in free play: start it with `pnpm dev:free`");
const { builds } = (await (await get("/api/dev/rooms/main/builds")).json()) as { builds: BakedBuild[] };
builds.sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1));

// the registered models they use, copied next to the built-in ones
const used = [...new Set(builds.map((b) => b.model).filter((m) => m.startsWith("m_")))];
const infos = (await (await get("/api/models")).json()) as { id: string }[];
const models: Record<string, { info: unknown; nav: ModelNav }> = {};
let total = 0;
for (const id of used) {
	const info = infos.find((m) => m.id === id);
	if (!info) throw new Error(`model ${id} is not registered`);
	const nav = (await (await get(`/api/models/${id}.nav.json`)).json()) as ModelNav;
	models[id] = { info, nav };
	const glb = new Uint8Array(await (await get(`/api/models/${id}.glb`)).arrayBuffer());
	writeFileSync(join(MODELS, `${id}.glb`), glb);
	writeFileSync(join(MODELS, `${id}.nav.json`), `${JSON.stringify(nav)}\n`);
	const png = await fetch(`${base}/api/models/${id}.png`);
	if (png.ok) writeFileSync(join(MODELS, `${id}.png`), new Uint8Array(await png.arrayBuffer()));
	total += glb.byteLength;
	console.error(`model ${id} (${(info as { name?: string }).name ?? ""}): ${kb(glb.byteLength)}`);
}
// registered models no longer used are no longer published
for (const f of readdirSync(MODELS))
	if (/^m_[0-9a-f]{16}\./.test(f) && !used.includes(f.split(".")[0] as string)) {
		rmSync(join(MODELS, f));
		console.error(`removed ${f} (no longer used)`);
	}

const published: Published = { version: 1, builds, models };
const baseMesh = JSON.parse(readFileSync(join(CITY, "navmesh.base.json"), "utf8")) as NavMeshData;
const baked = bake(baseMesh, published, builtinNavs(MODELS));
const city = JSON.parse(readFileSync(join(CITY, "landmarks.json"), "utf8")) as LandmarksData;
const lost = unreachable(NavMesh.fromJSON(baked), city.spawn.pos, city.landmarks);
if (lost.length > 0) throw new Error(`with these builds, the spawn point cannot reach: ${lost.join(", ")}`);

// one build per line keeps the file readable and its diffs small
const json = [
	"{",
	'\t"version": 1,',
	`\t"builds": [${builds.length ? "\n" : ""}${builds.map((b) => `\t\t${JSON.stringify(b)}`).join(",\n")}${builds.length ? "\n\t" : ""}],`,
	`\t"models": ${JSON.stringify(models)}`,
	"}\n",
].join("\n");
writeFileSync(join(CITY, "builds.json"), json);
writeFileSync(join(CITY, "navmesh.json"), `${JSON.stringify(baked)}\n`);
console.log(
	JSON.stringify(
		{
			builds: builds.length,
			models: used,
			modelBytes: total,
			navmeshPolygons: baked.polygons.length,
			files: [
				"assets/test-city/builds.json",
				"assets/test-city/navmesh.json",
				...used.map((id) => `assets/models/${id}.*`),
			],
			next: "commit these files, then deploy (cd apps/city-host && npx cf deploy)",
		},
		null,
		2,
	),
);
