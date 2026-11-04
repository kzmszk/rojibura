import { type LandmarksData, NavMesh } from "@rojibura/nav";
import { expect, test } from "vitest";
import { assertReachable, formatLandmarks } from "./landmarks.ts";

const city: LandmarksData = {
	spawn: { pos: [0, 0], y: 1 },
	landmarks: [{ id: "far", name: "Far", pos: [100, 100], y: 2 }],
};

test("formats landmark JSON one entry per line", () => {
	expect(formatLandmarks(city)).toBe(
		'{\n\t"landmarks": [\n\t\t{"id":"far","name":"Far","pos":[100,100],"y":2}\n\t],\n\t"spawn": {"pos":[0,0],"y":1}\n}\n',
	);
	expect(JSON.parse(formatLandmarks({ ...city, landmarks: [] }))).toEqual({ ...city, landmarks: [] });
});

test("reports landmarks unreachable from the spawn", () => {
	const mesh = NavMesh.fromJSON({
		version: 1,
		vertices: [-1, 0, -1, 1, 0, -1, 1, 0, 1, -1, 0, 1],
		polygons: [{ verts: [0, 1, 2, 3], neighbors: [-1, -1, -1, -1] }],
	});
	expect(() => assertReachable(mesh, city)).toThrow("landmarks not reachable from SPAWN: far [100, 100]");
	expect(() => assertReachable(mesh, { ...city, landmarks: [] })).not.toThrow();
});
