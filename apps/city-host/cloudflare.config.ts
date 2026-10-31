import { bindings, defineConfig, exports } from "cf/config";
import * as entrypoint from "./src/worker/index.ts" with { type: "cf-worker" };

// docs/prd.md 2.1: one Worker serves the client (static assets), the API and the WebSocket gateway.
// Modes (docs/prd.md part 5): development (`cf dev`), staging (`cf deploy --mode staging`, a separate
// Worker and D1 for remote checks) and production (`cf deploy`).
export default defineConfig(({ mode }) => {
	const dev = mode === "development";
	const staging = mode === "staging";
	const name = staging ? "rojibura-staging" : "rojibura";
	return {
		worker: {
			name,
			compatibilityDate: "2026-10-23",
			entrypoint,
			workersDev: true,
			previewUrls: false,
			assets: {
				notFoundHandling: "single-page-application",
				runWorkerFirst: ["/api/*", "/ws/*", "/auth/*"],
			},
			exports: {
				CityRoomDO: exports.durableObject({ storage: "sqlite" }),
			},
			env: {
				ROOM: bindings.durableObject({ worker: name, exportName: "CityRoomDO" }),
				DB: bindings.d1({ name }),
				SESSION_SECRET: bindings.secret(),
				// Google OAuth client (docs/prd.md 2.2.3). Login is disabled until both are set.
				GOOGLE_CLIENT_ID: bindings.secret(),
				GOOGLE_CLIENT_SECRET: bindings.secret(),
				// Development switches (docs/prd.md part 5). Never on in production builds.
				// Outside localhost the dev endpoints also require DEV_TOKEN (staging sets it).
				DEV_AUTH: bindings.text(dev || staging ? "1" : "0"),
				DEV_ALWAYS_OPEN: bindings.text(dev || staging ? "1" : "0"),
				DEV_TOKEN: bindings.secret(),
			},
		},
	};
});
