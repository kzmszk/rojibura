import { readFileSync } from "node:fs";
import { type LandmarksData, NavMesh, type NavMeshData } from "@rojibura/nav";
import { expect, test } from "vitest";
import { bake, builtinNavs, type Published, unreachable } from "./bake.ts";
import { buildCity } from "./build.ts";
import { collectTriangles, localMatrix, parseGlb, transformPoint } from "./glb.ts";
import { extractLandmarks } from "./landmarks.ts";

const asset = (name: string) => new URL(`../../../assets/test-city/${name}`, import.meta.url);
const glbBytes = readFileSync(asset("test_city.glb"));

test("parseGlb rejects other files", () => {
	expect(() => parseGlb(new TextEncoder().encode("not a glb file at all"))).toThrow(/not a glb/);
});

test("node transforms", () => {
	// 90 degrees about +Y turns +X into -Z.
	const m = localMatrix({ rotation: [0, Math.SQRT1_2, 0, Math.SQRT1_2], translation: [1, 2, 3] });
	const [x, y, z] = transformPoint(m, 1, 0, 0);
	expect(x).toBeCloseTo(1, 9);
	expect(y).toBeCloseTo(2, 9);
	expect(z).toBeCloseTo(2, 9);
});

test("collects world-space triangles of the test city", () => {
	const { positions, indices } = collectTriangles(parseGlb(glbBytes));
	expect(indices.length % 3).toBe(0);
	const max = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY];
	const min = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
	for (let i = 0; i < positions.length; i++) {
		max[i % 3] = Math.max(max[i % 3] as number, positions[i] as number);
		min[i % 3] = Math.min(min[i % 3] as number, positions[i] as number);
	}
	expect(min.map((v) => Math.round(v * 100) / 100)).toEqual([-40, 0, -40]);
	expect(max.map((v) => Math.round(v * 100) / 100)).toEqual([40, 10, 40]); // block_a is 10 m tall
});

test("extracts landmarks and the spawn point (glTF Y up: Blender (x, y) is (x, -y) on XZ)", () => {
	const { landmarks, spawn } = extractLandmarks(parseGlb(glbBytes));
	expect(spawn).toEqual({ pos: [0, -8], y: 0 });
	expect(landmarks).toEqual([
		{ id: "cafe", name: "オープンカフェ", pos: [18, -9], y: 0 },
		{ id: "deck", name: "展望デッキ", pos: [22, 20], y: 1.2 },
		{ id: "fountain", name: "中央噴水", pos: [0, -5], y: 0 },
		{ id: "library", name: "図書館の入口", pos: [-18, 14], y: 0 },
		{ id: "park", name: "小さな公園", pos: [-3, 27], y: 0 },
		{ id: "station", name: "駅前", pos: [-20, -22], y: 0 },
	]);
});

test("the committed navmesh.base.json and landmarks.json are up to date (pnpm build:city)", async () => {
	const { navmesh, landmarks } = await buildCity(glbBytes);
	expect(navmesh).toEqual(JSON.parse(readFileSync(asset("navmesh.base.json"), "utf8")));
	expect(landmarks).toEqual(JSON.parse(readFileSync(asset("landmarks.json"), "utf8")));
});

test("navmesh.json is the base with the published builds baked in (pnpm builds:publish)", () => {
	const base = JSON.parse(readFileSync(asset("navmesh.base.json"), "utf8")) as NavMeshData;
	const published = JSON.parse(readFileSync(asset("builds.json"), "utf8")) as Published;
	const models = new URL("../../../assets/models", import.meta.url).pathname;
	const baked = bake(base, published, builtinNavs(models));
	expect(JSON.parse(readFileSync(asset("navmesh.json"), "utf8"))).toEqual(JSON.parse(JSON.stringify(baked)));
	const city = JSON.parse(readFileSync(asset("landmarks.json"), "utf8")) as LandmarksData;
	expect(unreachable(NavMesh.fromJSON(baked), city.spawn.pos, city.landmarks)).toEqual([]);
});
