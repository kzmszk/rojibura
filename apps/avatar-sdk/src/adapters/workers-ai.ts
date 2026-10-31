// Workers AI (T4, docs/prd.md 3.5): the LLM for AIs that run on the participant's own Cloudflare account.
// Takes the `AI` binding, or anything with the same run() (scripts use the REST API through it).

import type { LLM } from "../core/types.ts";

export interface AiRunner {
	run(model: string, input: Record<string, unknown>): Promise<unknown>;
}

export interface WorkersAiUsage {
	prompt_tokens: number;
	completion_tokens: number;
	/** Billed neurons (most models report them; the free tier is 10,000 a day). */
	neurons?: number;
}

/**
 * Per-model request options. Short replies need no reasoning: with it on, reasoning models spend the
 * whole token budget thinking (issue #7).
 */
const MODEL_OPTIONS: Record<string, Record<string, unknown>> = {
	"@cf/qwen/qwen3-30b-a3b-fp8": { chat_template_kwargs: { enable_thinking: false } },
	"@cf/google/gemma-4-26b-a4b-it": { chat_template_kwargs: { enable_thinking: false } },
	"@cf/zai-org/glm-4.7-flash": { chat_template_kwargs: { enable_thinking: false } },
	"@cf/openai/gpt-oss-20b": { reasoning: { effort: "low" } },
};

/**
 * Default model (issue #7): always valid JSON, keeps the persona's tone and turns down injected
 * instructions, about 6 neurons a reply. "@cf/qwen/qwen3-30b-a3b-fp8" is the cheaper choice (about 4).
 */
export const DEFAULT_WORKERS_AI_MODEL = "@cf/google/gemma-4-26b-a4b-it";

export class WorkersAiLLM implements LLM {
	readonly name: string;
	/** Token usage of the last call, for budget meters and measurements. */
	lastUsage: WorkersAiUsage | null = null;
	private readonly ai: AiRunner;
	private readonly model: string;
	private readonly maxTokens: number;

	constructor(ai: AiRunner, model = DEFAULT_WORKERS_AI_MODEL, maxTokens = 512) {
		this.ai = ai;
		this.model = model;
		this.maxTokens = maxTokens;
		this.name = `workers-ai:${model}`;
	}

	async complete(req: { system: string; user: string; schema: object }): Promise<unknown> {
		const out = (await this.ai.run(this.model, {
			messages: [
				{ role: "system", content: req.system },
				{ role: "user", content: req.user },
			],
			response_format: { type: "json_schema", json_schema: req.schema },
			max_tokens: this.maxTokens,
			...MODEL_OPTIONS[this.model],
		})) as {
			response?: unknown;
			choices?: { message?: { content?: unknown; reasoning_content?: unknown } }[];
			usage?: WorkersAiUsage;
		};
		this.lastUsage = out?.usage ?? null;
		// older models answer { response }, OpenAI-compatible ones { choices: [{ message }] };
		// Qwen3 with thinking off puts the answer in reasoning_content
		const message = out?.choices?.[0]?.message;
		const value = out?.response ?? message?.content ?? message?.reasoning_content;
		return typeof value === "string" ? parseJsonLoosely(value) : value;
	}
}

/** Parses JSON that may be wrapped in a code fence or follow a reasoning block. Null if there is none. */
export function parseJsonLoosely(text: string): unknown {
	const body = text.slice(text.lastIndexOf("</think>") + 1);
	const from = body.indexOf("{");
	const to = body.lastIndexOf("}");
	if (from < 0 || to < from) return null;
	try {
		return JSON.parse(body.slice(from, to + 1));
	} catch {
		return null;
	}
}
