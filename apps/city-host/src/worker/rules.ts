// What the area enforces. Production keeps the city inside the free tier (docs/prd.md 2.4, 3.3);
// free play (docs/prd.md 3.7) lifts those limits on your own PC and allows building.

import {
	AGENTS_PER_OWNER_CONCURRENT,
	AI_CONV_MAX_TURNS,
	AI_PAIR_COOLDOWN_MS,
	AI_REPLY_MIN_INTERVAL_MS,
	CAPACITY_AI,
	CAPACITY_PROVISIONAL_AI,
	CAPACITY_TOTAL,
	HUMAN_TO_SAME_AI_PER_MIN,
	RATE_MOVE,
	RATE_SAY_AI_PER_MIN,
	RATE_SAY_HUMAN,
} from "@rojibura/protocol";

type Bucket = { rate: number; burst: number };

/** `null` means no limit. */
export interface RoomRules {
	capacityTotal: number | null;
	capacityAi: number | null;
	capacityProvisionalAi: number | null;
	/** Provisional AIs of one owner at once. */
	provisionalPerOwner: number | null;
	/** AIs of one owner at once, unless the account says otherwise (accounts.agent_concurrency). */
	agentsPerOwner: number | null;
	/** Moves and gestures; exceeding them repeatedly closes the connection. */
	rateMove: Bucket | null;
	rateSayHuman: Bucket | null;
	/** Approved AIs; provisional ones get half. */
	sayAiPerMin: number | null;
	humanToSameAiPerMin: number | null;
	aiConvMaxTurns: number | null;
	aiPairCooldownMs: number;
	/** Open conversations an AI pair may have between them when a new one starts. */
	aiConcurrentConvs: number | null;
	/** Kept in free play too: with no turn limit it stops two AIs from talking in a tight loop. */
	aiReplyMinIntervalMs: number;
	provisionalMayApproachHumans: boolean;
	/** Building (docs/prd.md 3.7). null: BUILD and UNBUILD are refused. */
	build: { maxPerArea: number } | null;
}

export const PRODUCTION_RULES: RoomRules = {
	capacityTotal: CAPACITY_TOTAL,
	capacityAi: CAPACITY_AI,
	capacityProvisionalAi: CAPACITY_PROVISIONAL_AI,
	provisionalPerOwner: 1,
	agentsPerOwner: AGENTS_PER_OWNER_CONCURRENT,
	rateMove: RATE_MOVE,
	rateSayHuman: RATE_SAY_HUMAN,
	sayAiPerMin: RATE_SAY_AI_PER_MIN,
	humanToSameAiPerMin: HUMAN_TO_SAME_AI_PER_MIN,
	aiConvMaxTurns: AI_CONV_MAX_TURNS,
	aiPairCooldownMs: AI_PAIR_COOLDOWN_MS,
	aiConcurrentConvs: 2,
	aiReplyMinIntervalMs: AI_REPLY_MIN_INTERVAL_MS,
	provisionalMayApproachHumans: false,
	build: null,
};

export const FREE_PLAY_RULES: RoomRules = {
	capacityTotal: null,
	capacityAi: null,
	capacityProvisionalAi: null,
	provisionalPerOwner: null,
	agentsPerOwner: null,
	rateMove: null,
	rateSayHuman: null,
	sayAiPerMin: null,
	humanToSameAiPerMin: null,
	aiConvMaxTurns: null,
	aiPairCooldownMs: 0,
	aiConcurrentConvs: null,
	aiReplyMinIntervalMs: AI_REPLY_MIN_INTERVAL_MS,
	provisionalMayApproachHumans: true,
	build: { maxPerArea: 500 },
};
