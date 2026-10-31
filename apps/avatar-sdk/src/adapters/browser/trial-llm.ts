// The trial LLM (#24): the host's Workers AI through /api/llm, so a browser AI can start without an API key.
// The host builds the system prompt and the output schema itself; this sends what kind of answer is wanted.

import type { LLM } from "../../core/types.ts";

export class TrialLimitError extends Error {}

export class HostTrialLLM implements LLM {
	readonly name = "trial:workers-ai";
	/** Calls left today, as the host last reported (null until the first answer). */
	remaining: number | null = null;
	private readonly baseUrl: string;
	private readonly agentId: string;
	private readonly personality: string;

	constructor(opts: { baseUrl: string; agentId: string; personality: string }) {
		this.baseUrl = opts.baseUrl;
		this.agentId = opts.agentId;
		this.personality = opts.personality;
	}

	async complete(req: { system: string; user: string; schema: object }): Promise<unknown> {
		const props = (req.schema as { properties?: Record<string, { enum?: string[] }> }).properties ?? {};
		const kind = "summary" in props ? "summary" : "decision";
		const r = await fetch(`${this.baseUrl}/api/llm`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				agentId: this.agentId,
				kind,
				personality: this.personality,
				user: req.user,
				landmarkIds: props.goTo?.enum?.filter((v) => v !== "stay" && v !== "speaker"),
			}),
		});
		const body = (await r.json().catch(() => ({}))) as {
			result?: unknown;
			remaining?: number;
			error?: string;
		};
		if (typeof body.remaining === "number") this.remaining = body.remaining;
		if (r.status === 429) throw new TrialLimitError("今日のお試し枠を使い切りました");
		if (!r.ok) throw new Error(body.error ?? `LLM ${r.status}`);
		return body.result;
	}
}

/** How many trial calls are left today for the logged-in owner. */
export async function trialRemaining(baseUrl: string): Promise<{ remaining: number; limit: number } | null> {
	const r = await fetch(`${baseUrl}/api/llm`);
	return r.ok ? ((await r.json()) as { remaining: number; limit: number }) : null;
}
