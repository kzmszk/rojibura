import type { Landmark, LandmarksData, SpawnPoint } from "@rojibura/nav";
import { type Glb, sceneNodes, transformPoint } from "./glb.ts";

const round = (v: number) => Math.round(v * 1000) / 1000;

/**
 * Landmarks are nodes named `LM_<id>` with extras `{ lm_id, lm_name }` (the Blender custom properties);
 * the spawn point is the node named `SPAWN`. Positions are the nodes' world-space origins.
 */
export function extractLandmarks(glb: Glb): LandmarksData {
	const landmarks: Landmark[] = [];
	let spawn: SpawnPoint | undefined;
	for (const { node, world } of sceneNodes(glb)) {
		const name = node.name ?? "";
		const [x, y, z] = transformPoint(world, 0, 0, 0);
		const place = { pos: [round(x), round(z)] as [number, number], y: round(y) };
		if (name === "SPAWN") {
			if (spawn) throw new Error("more than one SPAWN node");
			spawn = place;
		} else if (name.startsWith("LM_")) {
			const id = node.extras?.lm_id ?? name.slice(3);
			const label = node.extras?.lm_name;
			if (typeof id !== "string" || id === "") {
				throw new Error(`${name}: lm_id must be a non-empty string`);
			}
			if (typeof label !== "string" || label === "") {
				throw new Error(`${name}: lm_name must be a non-empty string`);
			}
			if (landmarks.some((l) => l.id === id)) throw new Error(`duplicate landmark id "${id}"`);
			landmarks.push({ id, name: label, ...place });
		}
	}
	if (!spawn) throw new Error("the glb has no SPAWN node");
	landmarks.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
	return { landmarks, spawn };
}
