// Shared limits (docs/prd.md 3.2.3, 3.3). Change them here only.

export const MAX_PATH_POINTS = 24;
export const MAX_PATH_LENGTH = 200; // m
export const MAX_SPEED = 6.0; // m/s
export const WALK_SPEED = 1.4; // m/s
export const RUN_SPEED = 4.0; // m/s
/** Allowed gap between a move's start and the host's estimate of the current position. */
export const POSITION_TOLERANCE = 2.0; // m
export const MAX_SAY_LENGTH = 200;
export const MAX_NAME_LENGTH = 24;
export const MAX_MESSAGE_BYTES = 4096;

export const INTEREST_RADIUS_MIN = 5; // m
export const INTEREST_RADIUS_MAX = 30; // m
export const INTEREST_RADIUS_DEFAULT = 20; // m

/** Clients send the text "ping" this often; the host auto-responds "pong" without waking (3.2.1). */
export const HEARTBEAT_INTERVAL_MS = 20_000;
/** A connection with no ping or message for this long is removed (reason "timeout"). */
export const PRESENCE_TIMEOUT_MS = 60_000;
export const AUTH_TIMEOUT_MS = 30_000;
export const HEARTBEAT_PING = "ping";
export const HEARTBEAT_PONG = "pong";

export const CAPACITY_TOTAL = 100;
export const CAPACITY_AI = 70;
export const CAPACITY_PROVISIONAL_AI = 10;
export const AGENTS_PER_OWNER_CONCURRENT = 2;

/** Token buckets: sustained rate per second and burst. */
export const RATE_MOVE = { rate: 4, burst: 8 } as const;
export const RATE_SAY_HUMAN = { rate: 1, burst: 3 } as const;
export const RATE_SAY_AI_PER_MIN = 10;
export const HUMAN_TO_SAME_AI_PER_MIN = 6;
/** Violations within a minute before the connection is closed with 1008. */
export const RATE_VIOLATIONS_BEFORE_CLOSE = 3;

export const CONV_TIMEOUT_MS = 60_000;
export const AI_CONV_MAX_TURNS = 8;
export const AI_PAIR_COOLDOWN_MS = 10 * 60_000;
export const AI_REPLY_MIN_INTERVAL_MS = 3_000;

/** Spatial context: how far the host looks for nearby avatars and landmarks. */
export const CONTEXT_AVATAR_RADIUS = 15; // m
export const CONTEXT_LANDMARK_RADIUS = 40; // m
export const CONTEXT_MAX_ITEMS = 8;
