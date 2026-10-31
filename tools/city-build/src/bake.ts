// Published builds baked into the city's navmesh (docs/prd.md 3.7.8): navmesh.json is navmesh.base.json
// (the city glb alone) with assets/test-city/builds.json applied, so the host, browsers and AI runtimes
// that read navmesh.json walk around published builds without knowing about them.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	applyBuilds,
	boxNav,
	type ModelNav,
	type NavMesh,
	type NavMeshData,
	type PlacedModel,
} from "@rojibura/nav";

/** The parts of a build the navmesh depends on (a Build from @rojibura/protocol). */
export interface BakedBuild {
	id: string;
	model: string;
	pos: [number, number];
	y: number;
	rot: number;
	scale: number;
	size?: [number, number, number];
	at: number;
}

/** assets/test-city/builds.json (PublishedBuilds in @rojibura/protocol). */
export interface Published {
	version: 1;
	builds: BakedBuild[];
	models: Record<string, { nav: ModelNav }>;
}

export const EMPTY: Published = { version: 1, builds: [], models: {} };

/** Built-in models' nav data, read from assets/models/<id>.nav.json. */
export function builtinNavs(modelsDir: string): (id: string) => ModelNav | undefined {
	return (id) => {
		const file = join(modelsDir, `${id}.nav.json`);
		return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as ModelNav) : undefined;
	};
}

/** The builds as the navmesh sees them, oldest first (as the host applies them). Throws on unknown models. */
export function placedOf(published: Published, builtin: (id: string) => ModelNav | undefined): PlacedModel[] {
	return [...published.builds]
		.sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1))
		.map((b) => {
			const nav =
				b.model === "block"
					? boxNav(...(b.size ?? [1, 1, 1]))
					: (published.models[b.model]?.nav ?? builtin(b.model));
			if (!nav) throw new Error(`build ${b.id}: no nav data for model ${b.model}`);
			return { nav, pos: b.pos, y: b.y, rot: b.rot, scale: b.scale };
		});
}

/** navmesh.json: the base with the published builds on it (the base itself when nothing is published). */
export function bake(
	base: NavMeshData,
	published: Published,
	builtin: (id: string) => ModelNav | undefined,
): NavMeshData {
	return published.builds.length > 0 ? applyBuilds(base, placedOf(published, builtin)) : base;
}

/** Landmarks (and the spawn point) people cannot reach from the spawn point on `mesh`. */
export function unreachable(
	mesh: NavMesh,
	spawn: [number, number],
	landmarks: { id: string; pos: [number, number] }[],
): string[] {
	const from = mesh.closestPoint(spawn);
	if (!mesh.isWalkable(spawn)) return ["spawn"];
	return landmarks.filter((l) => !mesh.findPath(from, mesh.closestPoint(l.pos))).map((l) => l.id);
}
