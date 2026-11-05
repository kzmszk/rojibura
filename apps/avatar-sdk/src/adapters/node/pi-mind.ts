// A resident's mind as one long-lived pi session (node adapter, development; docs/prd.md 3.5.2 "pi 住人").
// The model is a local llama.cpp server ("llama/<model id>") or any model pi is logged in to.
// pi gets the city tools only (resident-tools.ts): no built-in tools, extensions, skills, AGENTS.md or user settings.

import { mkdir } from "node:fs/promises";
import {
	type AgentSessionEvent,
	createAgentSession,
	createExtensionRuntime,
	defineTool,
	ModelRuntime,
	type ResourceLoader,
	SessionManager,
	SettingsManager,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Mind, ToolResult } from "../../core/mind.ts";
import type { Logger } from "../../core/types.ts";
import { residentTools } from "./resident-tools.ts";

export const DEFAULT_PI_MIND_MODEL = "llama/gemma-4-26B-A4B-it-qat-UD-Q4_K_XL";
export const DEFAULT_LLAMA_URL = "http://127.0.0.1:8080/v1";
/** Match llama-server's -c. */
const LLAMA_CONTEXT = 32_768;

export interface PiMindOptions {
	/** "provider/id". "llama/<id>" is a model of the local llama.cpp server. */
	model?: string;
	llamaUrl?: string;
	system: string;
	/** Where the session is kept; the mind continues from it after a restart. */
	sessionDir: string;
	/** Start a new session instead of continuing the last one. */
	fresh?: boolean;
	/** Carries out a tool call (Resident.act). */
	act: (tool: string, args: Record<string, unknown>) => Promise<ToolResult>;
	/** The life tools (docs/life.md 5.2): do, stop, diary, recall, read_day, reflect. */
	life?: boolean;
	/** The body tools (docs/prd.md 3.4.11): move_body, practice, learn and step. */
	body?: boolean;
	/** The model takes images (llama-server started with its --mmproj): it sees itself in the mirror. */
	vision?: boolean;
	logger: Logger;
}

type AssistantMessage = {
	role: "assistant";
	content: { type: string; text?: string }[];
	stopReason?: string;
	errorMessage?: string;
};

export async function createPiMind(opts: PiMindOptions): Promise<Mind> {
	const name = opts.model ?? DEFAULT_PI_MIND_MODEL;
	const slash = name.indexOf("/");
	if (slash <= 0) throw new Error(`model must be provider/id: ${name}`);
	const provider = name.slice(0, slash);
	const id = name.slice(slash + 1);

	// pi's own login (~/.pi/agent/auth.json) for other providers; ~/.pi/agent/models.json is not read
	const runtime = await ModelRuntime.create({ modelsPath: null });
	if (provider === "llama")
		runtime.registerProvider("llama", {
			name: "llama.cpp",
			baseUrl: opts.llamaUrl ?? DEFAULT_LLAMA_URL,
			api: "openai-completions",
			apiKey: "local",
			models: [
				{
					id,
					name: id,
					input: opts.vision ? ["text", "image"] : ["text"],
					reasoning: false,
					contextWindow: LLAMA_CONTEXT,
					maxTokens: 1024,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					// thinking makes every turn several times slower and is not needed for small talk
					samplingParams: { chat_template_kwargs: { enable_thinking: false } },
					compat: {
						supportsStore: false,
						supportsDeveloperRole: false,
						supportsReasoningEffort: false,
						supportsUsageInStreaming: true,
						supportsStrictMode: false,
						maxTokensField: "max_tokens",
					},
				},
			],
		});
	const model = runtime.getModel(provider, id);
	if (!model) throw new Error(`unknown model ${name} (pi --list-models shows the logged-in ones)`);

	const tools = residentTools(!!opts.body, !!opts.life).map(
		(t) =>
			defineTool({
				name: t.name,
				label: t.name,
				description: t.description,
				parameters: t.parameters,
				async execute(_id, params) {
					const r = await opts.act(t.name, params as Record<string, unknown>);
					const text = typeof r === "string" ? r : r.text;
					const image =
						typeof r !== "string" && r.image
							? [
									{
										type: "image" as const,
										data: Buffer.from(r.image).toString("base64"),
										mimeType: "image/jpeg",
									},
								]
							: [];
					return { content: [{ type: "text", text }, ...image], details: {}, terminate: t.terminate };
				},
			}) as ToolDefinition,
	);

	opts.logger.info(`pi tools: ${tools.map((t) => t.name).join(", ")}${opts.vision ? " (sees images)" : ""}`);
	const resources: ResourceLoader = {
		getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
		getSkills: () => ({ skills: [], diagnostics: [] }),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: [] }),
		getSystemPrompt: () => opts.system,
		getSystemPromptSource: () => undefined,
		getAppendSystemPrompt: () => [],
		getAppendSystemPromptSources: () => [],
		extendResources: () => {},
		reload: async () => {},
	};

	const cwd = opts.sessionDir;
	// the session holds everything the resident heard: only the owner may read it
	await mkdir(cwd, { recursive: true, mode: 0o700 });
	const { session } = await createAgentSession({
		cwd,
		model,
		thinkingLevel: "off",
		modelRuntime: runtime,
		resourceLoader: resources,
		noTools: "all",
		tools: tools.map((t) => t.name),
		customTools: tools,
		sessionManager: opts.fresh ? SessionManager.create(cwd, cwd) : SessionManager.continueRecent(cwd, cwd),
		// about 24k tokens of life are kept as they are; older days are summarized
		settingsManager: SettingsManager.inMemory({
			compaction: { enabled: true, reserveTokens: 8192, keepRecentTokens: 8000 },
			retry: { enabled: true, maxRetries: 1 },
		}),
	});
	opts.logger.info(`pi session: ${session.messages.length} messages so far (${cwd})`);

	let replies: AssistantMessage[] = [];
	session.subscribe((e: AgentSessionEvent) => {
		if (e.type === "message_end" && (e.message as { role?: string }).role === "assistant")
			replies.push(e.message as AssistantMessage);
		else if (e.type === "compaction_end") opts.logger.info("pi session compacted");
	});

	return {
		name: `pi:${name}`,
		async prompt(text) {
			replies = [];
			await session.prompt(text);
			const last = replies.at(-1);
			if (last?.stopReason === "error") throw new Error(last.errorMessage ?? "pi error");
			const said = replies
				.flatMap((m) => m.content)
				.map((c) => (c.type === "text" ? (c.text ?? "") : ""))
				.join("")
				.trim();
			return { text: said };
		},
		abort() {
			void session.abort();
		},
	};
}
