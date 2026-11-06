// Shared limits (docs/prd.md 3.2.3, 3.3). Change them here only.

export const MAX_PATH_POINTS = 24;
export const MAX_PATH_LENGTH = 200; // m
/** On the ground; afloat one may go up to FLY_RUN_SPEED (docs/prd.md 3.4.13). */
export const MAX_SPEED = 6.0; // m/s
export const WALK_SPEED = 1.4; // m/s
export const RUN_SPEED = 4.0; // m/s
/** Allowed gap between a move's start and the host's estimate of the current position. */
export const POSITION_TOLERANCE = 2.0; // m
/** Floating (docs/prd.md 3.4.13): how high (world Y), how far out from where one can walk, how fast. */
export const FLY_ALT_MIN = -10; // m
export const FLY_ALT_MAX = 150; // m
export const FLY_REACH = 30; // m
export const FLY_SPEED = 10.0; // m/s
/** Afloat with Shift. */
export const FLY_RUN_SPEED = 20.0; // m/s
/** Warping to a place (docs/prd.md 3.4.14): at most once in this long. */
export const WARP_INTERVAL_MS = 2_000;
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

// ---- building in free play (docs/prd.md 3.7) ----

/**
 * Models every city has: Blender models in assets/models (tools/city-build makes them), except "block",
 * a box of any size. Registered models have IDs "m_" + 16 hex digits.
 */
export const BUILTIN_MODELS = ["block", "house", "tower", "tree", "bench", "lamp", "deck", "bridge"] as const;
/** Colour names a BUILD may use instead of "#rrggbb" (handy for AIs). */
export const BUILD_COLORS: Readonly<Record<string, string>> = {
	white: "#f2efe8",
	black: "#2e2e2e",
	gray: "#8d8d8d",
	red: "#c8473d",
	orange: "#e08b3e",
	yellow: "#e9c84c",
	green: "#5e9b52",
	blue: "#4b7bbb",
	purple: "#8b62b2",
	pink: "#e79ab6",
	brown: "#8b5d3d",
	beige: "#dbc8a6",
};
/** Width and depth of a block (m). */
export const BLOCK_SIZE_MIN = 0.2;
export const BLOCK_SIZE_MAX = 30;
export const BLOCK_HEIGHT_MAX = 50;
/** Uniform scale of a model. Models people can walk on are always 1 (steps and slopes would change). */
export const BUILD_SCALE_MIN = 0.25;
export const BUILD_SCALE_MAX = 4;
export const BUILD_LABEL_MAX = 24;
/** An offset from the anchor may be at most this far (m). */
export const BUILD_OFFSET_MAX = 50;

// sitting on a seat (docs/prd.md 3.4.5): one stands at most this far from the seat to sit on it (m); the button
// to sit shows within SEAT_NEAR
export const SEAT_REACH = 1.2;
export const SEAT_NEAR = 3;

// doing things together (docs/prd.md 3.4.6)
export const OFFER_REACH = 3; // m: how close someone must be to be asked
export const OFFER_TTL_MS = 15_000;
/** How far apart two avatars stand (centre to centre) for each thing done together, in metres. */
export const TOGETHER_GAP = { handshake: 0.65, hug: 0.4 } as const;
/** How long each lasts once it starts (the clip's length), in ms: nobody moves the two meanwhile. */
export const TOGETHER_MS = { handshake: 2200, hug: 4500 } as const;
/** After a hug both step back this far (the "stepback" motion, m), and take this long over it (s). */
export const STEP_BACK = 0.3;
export const STEP_BACK_S = 1.1;

// an AI taking its owner somewhere (docs/prd.md 3.4.10)
export const LEAD_REACH = 12; // m: how close the owner must be
export const LEAD_MIN_DISTANCE = 5; // m: somewhere farther than this
export const LEAD_INTERVAL_MS = 60_000; // one ask per AI this often
export const LEAD_PLACE_MAX = 24;
export const LEAD_TEXT_MAX = 60;

// the owner reading their AI's diary (docs/life.md 8): it is read where the AI runs, and the host passes it on
export const DIARY_PART_MAX = 1500; // characters of one DIARY message
export const DIARY_PARTS_MAX = 10; // DIARY messages to one ask; a longer day is sent from its end
export const DIARY_DAYS_MAX = 60; // the latest days with a diary, listed with it
export const DIARY_ASK_MS = 1000; // one ask per owner this often
export const DIARY_TTL_MS = 15_000; // the AI's answer comes within this

// small things (docs/prd.md 3.4.7)
export const ITEM_REACH = 1.6; // m: how close a thing must be to pick it up
export const THROW_RANGE = 6; // m
export const THROW_MS = 900; // time in the air
export const THROW_RELEASE_MS = 350; // from the throw to the hand letting go (the throwing motion)

// shops (docs/prd.md 3.8.6)
export const SHOP_REACH = 3; // m from the counter
export const MAX_GOODS = 30; // bought things lying about in an area; the oldest one not in a hand goes first
export const START_COINS = 100; // in a new wallet
export const EARN_MS = 60_000; // working or studying earns one coin this often

// an AI moving its own body (docs/prd.md 3.4.11)
export const BODY_KEYS_MAX = 16;
export const BODY_SECONDS_MAX = 8; // the last key
/** How far a spot may be moved from its part (m): on yourself, and on the one the script is for. */
export const BODY_OFFSET_MAX = 0.7;
export const BODY_OFFSET_YOU_MAX = 0.15;
/**
 * How close the one touched must be (m, centre to centre) when the script starts: nearer than an AI stands by
 * its owner (a metre), so it steps up first.
 */
export const BODY_REACH = 0.9;
/** Touching your own AI from this far at most (m): the host brings it up to you, this far from you (m). */
export const BODY_CALL_REACH = 4;
export const BODY_CALLED_TO = 0.45;
/** How close the one looked at must be (m). */
export const BODY_LOOK_REACH = 15;
/** One script per avatar this often at most. */
export const BODY_INTERVAL_MS = 1000;
/** Walking with its owner, an AI may stand where it likes this close to them (m). */
export const COMPANION_FREE = 2.5;
/** ...walking at most this far at a time (m). */
export const COMPANION_FREE_STEP = 5;
/** People walking together keep this far apart, centre to centre (m), so their bodies do not overlap. */
export const COMPANY_GAP = 0.6;
