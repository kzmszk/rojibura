import { bindings, defineConfig, exports } from "cf/config";
import * as entrypoint from "./src/worker/index.ts" with { type: "cf-worker" };

// docs/prd.md 2.1: one Worker serves the client (static assets), the API and the WebSocket gateway.
export default defineConfig(({ mode }) => {
	const dev = mode === "development";
	return {
		worker: {
			name: "rojibura",
			compatibilityDate: "2026-10-23",
			entrypoint,
			assets: {
				notFoundHandling: "single-page-application",
				runWorkerFirst: ["/api/*", "/ws/*", "/auth/*"],
			},
			exports: {
				CityRoomDO: exports.durableObject({ storage: "sqlite" }),
			},
			env: {
				ROOM: bindings.durableObject({ worker: "rojibura", exportName: "CityRoomDO" }),
				// Development switches (docs/prd.md part 5). Never on in production builds.
				DEV_AUTH: bindings.text(dev ? "1" : "0"),
				DEV_ALWAYS_OPEN: bindings.text(dev ? "1" : "0"),
			},
		},
	};
});
