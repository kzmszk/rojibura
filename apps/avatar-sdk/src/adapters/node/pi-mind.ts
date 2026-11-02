// A resident's mind as one long-lived pi session (node adapter, development; docs/prd.md 3.5.2 "pi 住人").
// The model is a local llama.cpp server ("llama/<model id>") or any model pi is logged in to.
// pi gets the four city tools only: no built-in tools, extensions, skills, AGENTS.md or user settings.

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
import { MOTIONS } from "@rojibura/protocol";
import { Type } from "typebox";
import type { Mind, ToolResult } from "../../core/resident.ts";
import type { Logger } from "../../core/types.ts";

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
	/** The body tools (docs/prd.md 3.4.11): move_body, practice, learn and step. */
	body?: boolean;
	/** The model takes images (llama-server started with its --mmproj): it sees itself in the mirror. */
	vision?: boolean;
	logger: Logger;
}

/**
 * A body script's keys as one JSON string (checked by the resident against the protocol): local models write
 * nested objects in tool arguments badly (Gemma 4's call format mangles their quotes), a string they write well.
 */
const KEYS = Type.String({
	description:
		'キーの配列を JSON で書いた文字列。例: [{"at":1,"look":"ahead"}]。書き方はシステムプロンプトの「体の動かし方」',
});

/** The tools for moving its own body (docs/prd.md 3.4.11). Rehearsing and learning do not end the turn. */
function bodyTools(
	tool: (
		name: string,
		description: string,
		parameters: Parameters<typeof defineTool>[0]["parameters"],
		terminate?: boolean,
	) => ToolDefinition,
): ToolDefinition[] {
	return [
		tool(
			"move_body",
			"街で体を動かす。覚えた動きなら move に名前、新しい動きなら keys。to は of: you の相手の id（省くとオーナー）。distance を入れると、その人からその距離（メートル）まで近づいてからする。",
			Type.Object({
				move: Type.Optional(Type.String()),
				keys: Type.Optional(KEYS),
				to: Type.Optional(Type.String()),
				distance: Type.Optional(Type.Number()),
			}),
		),
		tool(
			"practice",
			"鏡の前で体の動きを試す。自分の姿の画像と、手が狙った所から何cm離れたかが返る。引数は move_body と同じ。name に練習中の動きの名前を付けてもよい。show: true なら、試したあとそのまま街でもする（頼まれた動きはこれ）。false なら鏡の中だけで、だれにも見えない。",
			Type.Object({
				move: Type.Optional(Type.String()),
				keys: Type.Optional(KEYS),
				to: Type.Optional(Type.String()),
				distance: Type.Optional(Type.Number()),
				name: Type.Optional(Type.String()),
				show: Type.Optional(Type.Boolean()),
			}),
			false,
		),
		tool(
			"learn",
			"体の動きに名前をつけて覚える（keys を省くと、最後に practice したもの）。覚えた動きに note（言われたこと、気づいたこと）だけ書き足すこともできる。",
			Type.Object({
				name: Type.String({ description: "24文字まで" }),
				about: Type.Optional(Type.String({ description: "どんな動きか（60文字まで）" })),
				keys: Type.Optional(KEYS),
				note: Type.Optional(Type.String({ description: "80文字まで" })),
			}),
			false,
		),
		tool(
			"step",
			"オーナー（to）のそばで、立つ位置を変える。distance はその人から何メートルのところに立つか（0.3〜2.5）。",
			Type.Object({ to: Type.Optional(Type.String()), distance: Type.Number() }),
		),
	];
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

	// every action ends the turn, so a model cannot keep talking to itself; a failed call does not, so it can
	// retry; writing a note does not either, so the model can still answer after it
	const tool = (
		toolName: string,
		description: string,
		parameters: Parameters<typeof defineTool>[0]["parameters"],
		terminate = true,
	) =>
		defineTool({
			name: toolName,
			label: toolName,
			description,
			parameters,
			async execute(_id, params) {
				const r = await opts.act(toolName, params as Record<string, unknown>);
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
				return { content: [{ type: "text", text }, ...image], details: {}, terminate };
			},
		}) as ToolDefinition;
	const tools = [
		tool(
			"say",
			"声に出して話す。to は話す相手の id（近くのみんなに向けて話すなら省く）。",
			Type.Object({ text: Type.String({ maxLength: 200 }), to: Type.Optional(Type.String()) }),
			// with a body, "I'll do it" comes before rehearsing and doing it: saying does not end the turn (the
			// resident still lets it speak to each one once per turn)
			!opts.body,
		),
		tool(
			"walk_to",
			"ランドマークの id の場所か、人の id のそばへ歩く。",
			Type.Object({ target: Type.String() }),
		),
		tool(
			"gesture",
			"身ぶりをする。sit（座る）と lie（寝転がる）は、歩き出すまで続く。to は相手の id（任意）。",
			Type.Object({
				motion: Type.Union(MOTIONS.map((m) => Type.Literal(m))),
				to: Type.Optional(Type.String()),
			}),
		),
		tool("wait", "何もしないで、次の出来事を待つ。", Type.Object({})),
		...(opts.body ? bodyTools(tool) : []),
		tool(
			"remember",
			"覚えておきたいことを書き留める。about はその人の id で、次にその人と話すときに見られる。自分のこと（今日やりたいことなど）は about を self にする。self にはほかの人の話を書かない。",
			Type.Object({ about: Type.String(), note: Type.String({ maxLength: 160 }) }),
			false,
		),
	];

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
