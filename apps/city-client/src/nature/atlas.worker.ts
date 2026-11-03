// Draws the leaf atlas off the page's thread (atlas.ts leafAtlas()) and sends back its pixels.

import { type AtlasLevels, leafAtlasLevels } from "./atlas.ts";

const scope = self as unknown as { postMessage(m: AtlasLevels | null, transfer?: Transferable[]): void };

try {
	const levels = leafAtlasLevels();
	scope.postMessage(
		levels,
		levels.map((l) => l.data.buffer as ArrayBuffer),
	);
} catch {
	scope.postMessage(null);
}
