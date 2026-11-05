/** What a tool call gives back to the mind: words, and a picture (JPEG) for a mind that can see. */
export type ToolResult = string | { text: string; image?: Uint8Array };

/** A long-lived mind. While `prompt` runs, the tools it calls go to `Resident.act`. */
export interface Mind {
	readonly name: string;
	/** Hands one batch of city events to the mind; resolves with its plain text once its turn is over. */
	prompt(text: string): Promise<{ text: string }>;
	/** Ends the current turn early. */
	abort(): void;
}
