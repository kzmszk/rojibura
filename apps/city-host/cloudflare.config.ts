import { bindings, defineConfig, exports } from "cf/config";
import { freePlayFlag } from "./src/worker/free-play-flag.ts";
import * as entrypoint from "./src/worker/index.ts" with { type: "cf-worker" };

/** `pnpm dev:free` sets RJ_FREE_PLAY=1 (the config runs in Node; the Worker's types have no `process`). */
const requestedFreePlay = (globalThis as { process?: { env: Record<string, string | undefined> } }).process
	?.env.RJ_FREE_PLAY;

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
			// AsyncLocalStorage, for attributing free-tier usage to actions (usage.ts)
			compatibilityFlags: ["nodejs_als"],
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
				// the guide's LLM (docs/prd.md 3.5.3), within the Workers AI free tier
				AI: bindings.ai(),
				SESSION_SECRET: bindings.secret(),
				// Google OAuth client (docs/prd.md 2.2.3). Login is disabled until both are set.
				GOOGLE_CLIENT_ID: bindings.secret(),
				GOOGLE_CLIENT_SECRET: bindings.secret(),
				// Opening hours in JST (docs/prd.md 2.4): "always", "20-24", "12-13,20-24"...
				// Always open while in development; set production to "20-24" when the city opens to the public.
				OPEN_HOURS: bindings.text("always"),
				// Development switch (docs/prd.md part 5). Never on in production builds.
				// Outside localhost the dev endpoints also require DEV_TOKEN (staging sets it).
				DEV_AUTH: bindings.text(dev || staging ? "1" : "0"),
				DEV_TOKEN: bindings.secret(),
				// Free play (docs/prd.md 3.7): no free-tier limits, and building. Only `pnpm dev:free`
				// (development mode); "0" in staging and production whatever RJ_FREE_PLAY says.
				FREE_PLAY: bindings.text(freePlayFlag(mode, requestedFreePlay)),
				// Optional, set with `cf workers secrets update` and not declared here so deploys work without
				// them: CF_ANALYTICS_TOKEN (Account Analytics: Read) and CF_ACCOUNT_ID, for Cloudflare's own
				// usage numbers on the dashboard (official.ts). Without them it shows the host's estimates.
			},
		},
	};
});
