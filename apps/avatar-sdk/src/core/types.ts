// Interfaces between the runtime-independent core and the runtime adapters (docs/prd.md 3.5.1).

import type { Motion, Vec2 } from "@rojibura/protocol";

export interface Persona {
	name: string;
	/** Free text written by the owner: personality, way of talking, interests. */
	personality: string;
}

/** One structured completion. Implementations: Claude Code CLI (dev), Workers AI, browser APIs... */
export interface LLM {
	readonly name: string;
	complete(req: { system: string; user: string; schema: object }): Promise<unknown>;
}

export interface Memory {
	/** Short notes about a counterpart, newest last. */
	recall(counterpartId: string): Promise<string[]>;
	remember(counterpartId: string, note: string): Promise<void>;
}

export interface Navigator {
	/** Walkable XZ polyline from `from` to `to` (both included), or null. */
	findPath(from: Vec2, to: Vec2): Vec2[] | null;
}

export interface Landmark {
	id: string;
	name: string;
	pos: Vec2;
}

/** What the LLM decides for one reply (validated by the SDK, docs/prd.md 3.5.2). */
export interface Decision {
	reply: string;
	motion: Motion | "none";
	/** Landmark ID, "speaker" (go next to the one who spoke) or "stay". */
	goTo: string;
	endConversation: boolean;
}

export interface Logger {
	info(msg: string): void;
	warn(msg: string): void;
}
