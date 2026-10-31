// Micro-benchmark of @rojibura/nav on a generated navmesh (issue #5). Not a test.
//
//   node packages/nav/bench/bench.ts [navmesh.json] [queries]
//
// Defaults to assets/test-city/navmesh.base.json and 1,000 findPath queries between random walkable points.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { NavMesh, type NavMeshData, pathLength, type Vec2, validatePath } from "../src/index.ts";

const file =
	process.argv[2] ?? fileURLToPath(new URL("../../../assets/test-city/navmesh.base.json", import.meta.url));
const queries = Number(process.argv[3] ?? 1000);
const text = readFileSync(file, "utf8");

/** Deterministic PRNG (mulberry32), so runs are comparable. */
function random(seed: number) {
	return () => {
		seed = (seed + 0x6d2b79f5) | 0;
		let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function stats(samples: number[]) {
	const s = [...samples].sort((a, b) => a - b);
	const at = (q: number) => s[Math.min(s.length - 1, Math.floor(q * s.length))] as number;
	const mean = s.reduce((a, b) => a + b, 0) / s.length;
	return { mean, median: at(0.5), p99: at(0.99), max: s[s.length - 1] as number };
}

const us = (ms: number) => `${(ms * 1000).toFixed(2)} µs`;
const line = (name: string, ms: number[]) => {
	const { mean, median, p99, max } = stats(ms);
	console.log(`${name.padEnd(34)} median ${us(median)}  p99 ${us(p99)}  max ${us(max)}  mean ${us(mean)}`);
};

// Loading: JSON.parse + fromJSON (what a Durable Object pays when it wakes up).
const loads: number[] = [];
let mesh = NavMesh.fromJSON(JSON.parse(text) as NavMeshData);
for (let i = 0; i < 50; i++) {
	const t0 = performance.now();
	mesh = NavMesh.fromJSON(JSON.parse(text) as NavMeshData);
	loads.push(performance.now() - t0);
}

// Bounds of the mesh, for sampling random points.
const data = JSON.parse(text) as NavMeshData;
let minX = Number.POSITIVE_INFINITY;
let minZ = Number.POSITIVE_INFINITY;
let maxX = Number.NEGATIVE_INFINITY;
let maxZ = Number.NEGATIVE_INFINITY;
for (let i = 0; i < data.vertices.length; i += 3) {
	minX = Math.min(minX, data.vertices[i] as number);
	maxX = Math.max(maxX, data.vertices[i] as number);
	minZ = Math.min(minZ, data.vertices[i + 2] as number);
	maxZ = Math.max(maxZ, data.vertices[i + 2] as number);
}
const rand = random(1);
const anyPoint = (): Vec2 => [minX + rand() * (maxX - minX), minZ + rand() * (maxZ - minZ)];
const walkablePoint = (): Vec2 => {
	for (;;) {
		const p = anyPoint();
		if (mesh.isWalkable(p)) return p;
	}
};
const pairs: [Vec2, Vec2][] = Array.from({ length: queries }, () => [walkablePoint(), walkablePoint()]);

// First query on a fresh instance (cold JIT), then warm up (steady state of a long-lived isolate).
const cold = NavMesh.fromJSON(data);
const t0 = performance.now();
cold.findPath(...(pairs[0] as [Vec2, Vec2]));
const coldMs = performance.now() - t0;
for (let i = 0; i < 5; i++) for (const [a, b] of pairs) mesh.findPath(a, b);

const findMs: number[] = [];
const paths: Vec2[][] = [];
let failed = 0;
for (const [a, b] of pairs) {
	const t = performance.now();
	const path = mesh.findPath(a, b);
	findMs.push(performance.now() - t);
	if (path) paths.push(path);
	else failed++;
}

// Point queries are too fast to time one by one: time batches of 100 and divide.
const BATCH = 100;
const batches = (fn: (p: Vec2) => unknown, points: () => Vec2) => {
	const out: number[] = [];
	for (let b = 0; b < 2000; b++) {
		const pts = Array.from({ length: BATCH }, points);
		const t = performance.now();
		for (const p of pts) fn(p);
		out.push((performance.now() - t) / BATCH);
	}
	return out;
};
const walkableMs = batches((p) => mesh.isWalkable(p), anyPoint);
const heightMs = batches((p) => mesh.heightAt(p), anyPoint);
const closestMs = batches((p) => mesh.closestPoint(p), anyPoint);
const prd = { maxPoints: 24, maxLength: 200 };
const validateMs: number[] = [];
for (const path of paths) {
	const t = performance.now();
	const result = validatePath(mesh, path, prd);
	validateMs.push(performance.now() - t);
	if (!result.ok && result.problem === "not_walkable") throw new Error("findPath produced an invalid path");
}

const points = paths.map((p) => p.length);
console.log(`navmesh: ${file}`);
console.log(
	`  ${mesh.polygonCount} polygons, ${data.vertices.length / 3} vertices, ` +
		`${(Buffer.byteLength(text) / 1024).toFixed(1)} KB JSON (${(gzipSync(text).length / 1024).toFixed(1)} KB gzip)`,
);
console.log(`node ${process.version}, ${queries} findPath queries between random walkable points`);
console.log(
	`  ${failed} unreachable; path points mean ${(points.reduce((a, b) => a + b, 0) / points.length).toFixed(1)}, ` +
		`max ${Math.max(...points)}; length mean ${(paths.reduce((a, p) => a + pathLength(p), 0) / paths.length).toFixed(1)} m`,
);
line("JSON.parse + NavMesh.fromJSON", loads);
console.log(`${"findPath, first call (cold)".padEnd(34)} ${us(coldMs)}`);
line("findPath", findMs);
line("validatePath (24 pts, 200 m)", validateMs);
line("isWalkable (per call)", walkableMs);
line("heightAt (per call)", heightMs);
line("closestPoint (per call)", closestMs);
