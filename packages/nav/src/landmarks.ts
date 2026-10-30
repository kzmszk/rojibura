import type { Vec2 } from "./vec.ts";

/** A named place the AI can walk to (an `LM_<id>` node in the city glb). */
export interface Landmark {
	id: string;
	name: string;
	pos: Vec2;
	/** Height of the marker (glTF Y, metres). */
	y: number;
}

/** Where new avatars appear (the `SPAWN` node). */
export interface SpawnPoint {
	pos: Vec2;
	y: number;
}

/** landmarks.json, written by tools/city-build. */
export interface LandmarksData {
	landmarks: Landmark[];
	spawn: SpawnPoint;
}
