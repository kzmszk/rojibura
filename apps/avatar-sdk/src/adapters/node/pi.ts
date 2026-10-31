// Development LLM through the pi coding agent (`pi -p`): any provider the developer has logged pi into,
// e.g. their ChatGPT subscription (openai-codex). Same rule as the Claude Code provider (docs/prd.md part 5):
// the developer's own machine, for development and testing only; never offered to other participants.

import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import type { LLM } from "../../core/types.ts";
import { parseJsonLoosely } from "../workers-ai.ts";

export interface PiOptions {
	/** "provider/id", as `pi --list-models` shows it. */
	model?: string;
	timeoutMs?: number;
	/** Path to the pi executable. */
	bin?: string;
}

export class PiLLM implements LLM {
	readonly name: string;
	private readonly opts: Required<PiOptions>;

	constructor(opts: PiOptions = {}) {
		this.opts = { model: "openai-codex/gpt-6-luna", timeoutMs: 60_000, bin: "pi", ...opts };
		this.name = `pi:${this.opts.model}`;
	}

	complete(req: { system: string; user: string; schema: object }): Promise<unknown> {
		// pi has no JSON Schema option: the schema goes into the system prompt and the SDK validates the answer.
		// Tools, extensions, skills and context files are off, the session is not saved, and short replies
		// need no reasoning (issue #7).
		const system = `${req.system}\n\n出力は次の JSON Schema に合う JSON オブジェクト1つだけ。前後に文章やコードフェンスを付けない。\n${JSON.stringify(req.schema)}`;
		const args = [
			"-p",
			"--mode",
			"json",
			"--model",
			this.opts.model,
			"--thinking",
			"off",
			"--no-tools",
			"--no-session",
			"--no-extensions",
			"--no-mcp",
			"--no-skills",
			"--no-prompt-templates",
			"--no-context-files",
			"--no-themes",
			"--system-prompt",
			system,
		];
		return new Promise((resolve, reject) => {
			// run outside the repository so no project files are picked up
			const child = spawn(this.opts.bin, args, { cwd: tmpdir(), stdio: ["pipe", "pipe", "pipe"] });
			let out = "";
			let err = "";
			const timer = setTimeout(() => {
				child.kill("SIGTERM");
				reject(new Error("pi timed out"));
			}, this.opts.timeoutMs);
			child.stdout.on("data", (d) => {
				out += d;
			});
			child.stderr.on("data", (d) => {
				err += d;
			});
			child.on("error", (e) => {
				clearTimeout(timer);
				reject(e);
			});
			child.on("close", () => {
				clearTimeout(timer);
				try {
					resolve(parsePiOutput(out));
				} catch (e) {
					reject(err ? new Error(`${(e as Error).message}: ${err.slice(0, 300)}`) : e);
				}
			});
			child.stdin.end(req.user);
		});
	}
}

/**
 * The answer in pi's `--mode json` event stream: the JSON in the last assistant message (null if it holds
 * none). Throws when pi reports an error or never answered.
 */
export function parsePiOutput(out: string): unknown {
	for (const line of out.split("\n").reverse()) {
		let event: { type?: string; message?: PiMessage } | null;
		try {
			event = JSON.parse(line);
		} catch {
			continue;
		}
		const m = event?.message;
		if (event?.type !== "message_end" || m?.role !== "assistant") continue;
		if (m.stopReason === "error") throw new Error(m.errorMessage ?? "pi error");
		const text = (m.content ?? []).map((c) => (c.type === "text" ? (c.text ?? "") : "")).join("");
		return parseJsonLoosely(text);
	}
	throw new Error(`unexpected pi output: ${out.slice(0, 300)}`);
}

interface PiMessage {
	role?: string;
	content?: { type: string; text?: string }[];
	stopReason?: string;
	errorMessage?: string;
}
