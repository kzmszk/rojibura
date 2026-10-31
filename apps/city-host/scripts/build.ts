// Building in free play (docs/prd.md 3.7), end to end. Needs the city running with `pnpm dev:free`.
//
//   node apps/city-host/scripts/build.ts [base] [--clear]
//
// Takes down what was built before, registers the example tea house if it is not registered yet (runs
// Blender through the model CLI), builds a few things with each kind of anchor, checks the refusals, that
// a walk through a wall is planned around it, and that a walk up onto a deck is accepted. Leaves the
// builds standing for screenshots unless --clear.

import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	applyBuilds,
	boxNav,
	type ModelNav,
	NavMesh,
	type NavMeshData,
	occupied,
	type PlacedModel,
	toWorld,
} from "@rojibura/nav";
import { type Build, type ClientToHost, type ModelInfo, modelUrl, type Vec2 } from "@rojibura/protocol";
import { BASE, Client, check, devHeaders, devLogin, WS_BASE } from "./lib.ts";

const CLEAR = process.argv.includes("--clear");
const ROOT = new URL("../../../", import.meta.url).pathname;

const health = (await (await fetch(`${BASE}/api/health`)).json()) as { freePlay?: boolean };
if (!health.freePlay) {
	console.error("FAIL the city is not in free play: start it with `pnpm dev:free`");
	process.exit(1);
}
const cookie = await devLogin("ビルダー");
const clearAll = () =>
	fetch(`${BASE}/api/dev/rooms/main/builds`, {
		method: "DELETE",
		headers: { ...devHeaders, Cookie: cookie },
	});
await clearAll();

// ---- a registered model ----
let models = (await (await fetch(`${BASE}/api/models`)).json()) as ModelInfo[];
let tea = models.find((m) => !m.builtin && m.name === "茶屋");
if (!tea) {
	const out = join(tmpdir(), "rj-tea_house.glb");
	const r = spawnSync(
		"node",
		[
			join(ROOT, "tools/city-build/src/model-cli.ts"),
			"make",
			join(ROOT, "tools/city-build/blender/examples/tea_house.py"),
			"-o",
			out,
			"--preview",
			"--upload",
			"--name",
			"茶屋",
			"--owner",
			"ビルダー",
			"--base",
			BASE,
		],
		{ encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
	);
	check(r.status === 0, "registered the tea house with the model CLI");
	models = (await (await fetch(`${BASE}/api/models`)).json()) as ModelInfo[];
	tea = models.find((m) => !m.builtin && m.name === "茶屋");
}
check(tea?.walkable, `the tea house is registered and walkable (${tea?.id})`);

// ---- building ----
const builder = new Client(`${WS_BASE}/ws/area/main?avatar=saki`, cookie);
await builder.opened;
const welcome = await builder.waitFor("WELCOME");
check(
	Array.isArray(welcome.builds) && welcome.builds.length === 0,
	"WELCOME lists the builds (none after clearing)",
);
const me = welcome.you;

let refs = 0;
async function build(msg: Omit<Extract<ClientToHost, { t: "BUILD" }>, "t" | "ref">): Promise<Build> {
	const ref = `s${++refs}`;
	builder.send({ t: "BUILD", ...msg, ref });
	const answer = await Promise.race([
		builder.waitFor("BUILT", (m) => m.ref === ref),
		builder.waitFor("NOTICE", (m) => m.ref === ref),
	]);
	if (answer.t === "NOTICE") throw new Error(`BUILD ${JSON.stringify(msg)} refused: ${answer.message}`);
	return answer.build;
}

const house = await build({ model: "house", at: { landmark: "library" }, color: "pink", label: "ハルの家" });
check(
	Math.hypot(house.pos[0] + 18, house.pos[1] - 14) < 12,
	`house next to the library at ${house.pos.join(", ")}`,
);
const tree = await build({ model: "tree", at: { avatar: me } });
check(true, `tree next to the builder at ${tree.pos.join(", ")}`);
const tower = await build({ model: "tower", at: { pos: [10, -30] }, label: "見張り塔" });
const wall = await build({
	model: "block",
	at: { pos: [0, -16] },
	size: [8, 2, 0.5],
	color: "#8d8d8d",
	label: "壁",
});
const deck = await build({ model: "deck", at: { pos: [-24, 32] }, label: "展望台" });
const teaHouse = await build({ model: tea?.id as string, at: { pos: [14, 33] }, rot: 200, label: "茶屋" });
const bridge = await build({ model: "bridge", at: { pos: [20, 2] } });
await build({ model: "bench", at: { landmark: "fountain", offset: [5, 3] } });
await build({ model: "lamp", at: { landmark: "fountain", offset: [-4.5, 6] } });
check(
	true,
	`built house, tree, tower ${tower.id}, wall, deck, tea house ${teaHouse.id}, bridge, bench, lamp`,
);

builder.send({ t: "BUILD", model: "house", at: { pos: house.pos }, ref: "overlap" });
const overlap = await builder.waitFor("NOTICE", (m) => m.ref === "overlap");
check(overlap.message === "ほかの建物と重なります", `overlap refused with its ref: ${overlap.message}`);
builder.send({ t: "BUILD", model: "block", at: { landmark: "cafe", offset: [0, 0] }, ref: "landmark" });
const onLandmark = await builder.waitFor("NOTICE", (m) => m.ref === "landmark");
check(
	onLandmark.message.includes("上には建てられません"),
	`building on a landmark refused: ${onLandmark.message}`,
);

// ---- walking around and onto builds ----
async function placedOf(b: Build): Promise<PlacedModel> {
	const nav =
		b.model === "block"
			? boxNav(...(b.size ?? [1, 1, 1]))
			: ((await (await fetch(`${BASE}${modelUrl(b.model, "nav.json")}`)).json()) as ModelNav);
	return { nav, pos: b.pos, y: b.y, rot: b.rot, scale: b.scale };
}
// everything built, oldest first, as the host applies it: the same walkable area the host has
const everything = builder.inbox
	.filter((m): m is Extract<typeof m, { t: "BUILT" }> => m.t === "BUILT")
	.map((m) => m.build);
const base = (await (await fetch(`${BASE}/test-city/navmesh.json`)).json()) as NavMeshData;
const mesh = NavMesh.fromJSON(applyBuilds(base, await Promise.all(everything.map(placedOf))));

const walkerCookie = await devLogin("あるく人");
const walker = new Client(`${WS_BASE}/ws/area/main?avatar=capsule`, walkerCookie);
await walker.opened;
const w = await walker.waitFor("WELCOME");
check(w.builds?.length === everything.length, `a newcomer's WELCOME has all ${everything.length} builds`);
const mine = w.avatars.find((a) => a.id === w.you)?.move;
if (mine?.kind !== "idle") throw new Error("the walker should start standing");
const start = mine.pos;

// straight south through the wall: the host plans it around
walker.send({ t: "MOVE_PATH", path: [start, [start[0], -24]], speed: 6, seq: 1 });
const around = await walker.waitFor("MOVED", (m) => m.id === w.you);
const path = around.move.kind === "path" ? around.move.path : [];
const [wallShape] = occupied(await placedOf(wall)) as [Vec2[]];
const insideWall = (p: Vec2) =>
	wallShape.every((a, i) => {
		const b = wallShape[(i + 1) % wallShape.length] as Vec2;
		return (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]) > 0;
	});
const samples: Vec2[] = [];
for (let i = 1; i < path.length; i++) {
	const a = path[i - 1] as Vec2;
	const b = path[i] as Vec2;
	for (let s = 0; s <= 50; s++)
		samples.push([a[0] + ((b[0] - a[0]) * s) / 50, a[1] + ((b[1] - a[1]) * s) / 50]);
}
check(
	path.length > 2 && !samples.some(insideWall) && Math.abs((path.at(-1) as Vec2)[1] + 24) < 0.01,
	`a walk through the wall is planned around it (${path.length} points)`,
);

// up the deck's stairs, planned here on the same walkable area the host has
await new Promise((r) => setTimeout(r, 6000)); // let the walker arrive
const here = path.at(-1) as Vec2;
const top = toWorld(await placedOf(deck), [0, -1.2]);
const up = mesh.findPath(here, top);
check(
	up !== null && mesh.heightAt(top) !== null && (mesh.heightAt(top) as number) > 1,
	`the deck top is walkable, ${mesh.heightAt(top)?.toFixed(2)} m up`,
);
walker.send({ t: "MOVE_PATH", path: (up as Vec2[]).slice(0, 24), speed: 6, seq: 3 });
const climbed = await walker.waitFor(
	"MOVED",
	(m) => m.id === w.you && m.move.kind === "path" && m.move.path.length > 2,
);
check(climbed.move.kind === "path", "a walk up onto the deck is accepted");
walker.send({ t: "UNBUILD", id: tree.id, ref: "down" });
await walker.waitFor("UNBUILT", (m) => m.ref === "down");
check(true, "anyone can take something down (free play)");

console.log(
	JSON.stringify({
		house: house.pos,
		tower: tower.pos,
		wall: wall.pos,
		deck: deck.pos,
		deckTop: top,
		teaHouse: teaHouse.pos,
		bridge: bridge.pos,
		walker: w.you,
	}),
);
if (CLEAR) {
	await clearAll();
	console.log("cleared");
}
builder.ws.close();
walker.ws.close();
process.exit(0);
