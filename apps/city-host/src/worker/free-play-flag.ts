// The FREE_PLAY binding (docs/prd.md 3.7), decided when cloudflare.config.ts runs. Kept apart from the
// Worker's own modules: the config and the Worker must not import the same file under cf dev.

/** "1" only for development (`pnpm dev:free`); staging and production are "0" whatever was asked for. */
export function freePlayFlag(mode: string | undefined, requested: string | undefined): "0" | "1" {
	return mode === "development" && requested === "1" ? "1" : "0";
}
