// Development LLM: the developer's own Claude Code subscription through `claude -p`
// (docs/prd.md part 5). For local development and testing only; never offered to other participants.

import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import type { LLM } from "../../core/types.ts";

export interface ClaudeCodeOptions {
	model?: string;
	timeoutMs?: number;
	/** Path to the claude executable. */
	bin?: string;
}

export class ClaudeCodeLLM implements LLM {
	readonly name: string;
	private readonly opts: Required<ClaudeCodeOptions>;

	constructor(opts: ClaudeCodeOptions = {}) {
		this.opts = { model: "claude-haiku-5-5", timeoutMs: 60_000, bin: "claude", ...opts };
		this.name = `claude-code:${this.opts.model}`;
	}

	complete(req: { system: string; user: string; schema: object }): Promise<unknown> {
		// No --bare: it would ignore the subscription login. Tools are disabled and the session is not saved.
		const args = [
			"-p",
			"--model",
			this.opts.model,
			"--tools",
			"",
			"--no-session-persistence",
			"--output-format",
			"json",
			"--system-prompt",
			req.system,
			"--json-schema",
			JSON.stringify(req.schema),
		];
		return new Promise((resolve, reject) => {
			// run outside the repository so no project instructions are picked up
			const child = spawn(this.opts.bin, args, { cwd: tmpdir(), stdio: ["pipe", "pipe", "pipe"] });
			let out = "";
			let err = "";
			const timer = setTimeout(() => {
				child.kill("SIGTERM");
				reject(new Error("claude timed out"));
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
					const start = out.indexOf("{");
					const result = JSON.parse(out.slice(start, out.lastIndexOf("}") + 1)) as {
						is_error?: boolean;
						result?: string;
						structured_output?: unknown;
					};
					if (result.is_error) return reject(new Error(result.result ?? "claude error"));
					resolve(result.structured_output ?? JSON.parse(result.result ?? "null"));
				} catch {
					reject(new Error(`unexpected claude output: ${(out || err).slice(0, 300)}`));
				}
			});
			child.stdin.end(req.user);
		});
	}
}
