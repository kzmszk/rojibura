import { bindings, defineConfig, exports } from "cf/config";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };

// T4 prototype (docs/prd.md 3.5, issue #9): a resident AI in a Durable Object on the participant's own
// account, with Workers AI as its LLM. One Worker runs one AI.
export default defineConfig(() => ({
	worker: {
		name: "rojibura-agent",
		compatibilityDate: "2026-10-23",
		entrypoint,
		workersDev: true,
		previewUrls: false,
		exports: {
			AgentDO: exports.durableObject({ storage: "sqlite" }),
		},
		env: {
			AGENT: bindings.durableObject({ worker: "rojibura-agent", exportName: "AgentDO" }),
			AI: bindings.ai(),
			/** City to join, e.g. https://rojibura-staging.kazumasa.workers.dev */
			CITY_URL: bindings.text("https://rojibura-staging.kazumasa.workers.dev"),
			AREA: bindings.text("main"),
			AGENT_NAME: bindings.text("ミナト"),
			PERSONA: bindings.text("港町育ちで世話好き。話し方は気さくで、少しだけ江戸っ子っぽい。"),
			/** Registered agent ID and its Ed25519 private key (from the owner portal or dev registration). */
			AGENT_ID: bindings.secret(),
			AGENT_KEY: bindings.secret(),
			/** Bearer token for /start, /stop and /status. */
			CONTROL_TOKEN: bindings.secret(),
		},
	},
}));
