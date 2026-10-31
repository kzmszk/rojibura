// Free play (docs/prd.md 3.7): the city on your own PC without the free-tier limits, with building.
// Only `pnpm dev:free` (cf dev with RJ_FREE_PLAY=1) turns it on (free-play-flag.ts); staging and production never do.

/** The env says free play, and it is a development build (DEV_AUTH is never on in production). */
export function freePlayOn(env: { FREE_PLAY?: string; DEV_AUTH?: string }): boolean {
	return env.FREE_PLAY === "1" && env.DEV_AUTH === "1";
}

/** While free play is on, the Worker answers only on this machine. */
export function isLocalHost(hostname: string): boolean {
	return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}
