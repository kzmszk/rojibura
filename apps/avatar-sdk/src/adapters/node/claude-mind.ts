// A resident's mind as one long-lived Claude Code session (node adapter, development; docs/prd.md 3.5.2):
// the developer's own subscription through `claude -p`, never offered to other participants (part 5).
// Claude Code gets the city tools only, from a small MCP server in this process (resident-tools.ts): its own
// tools, settings, CLAUDE.md files and other MCP servers are off. One `claude` process stays up between turns
// (stream-json in and out) and the session is resumed after a restart, so the mind lives on.

import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import type { Mind, ToolResult } from "../../core/mind.ts";
import type { Logger } from "../../core/types.ts";
import { type ResidentTool, residentTools } from "./resident-tools.ts";

export const DEFAULT_CLAUDE_MIND_MODEL = "claude-haiku-5-5";
/** The MCP server's name: Claude Code calls its tools mcp__rojibura__<tool>. */
const SERVER = "rojibura";
/** A turn that takes longer than this is cut short. */
const TURN_MS = 180_000;

export interface ClaudeMindOptions {
	model?: string;
	system: string;
	/** Where the session ID is kept, and the working directory of `claude` (nothing else is read there). */
	sessionDir: string;
	/** Start a new session instead of resuming the last one. */
	fresh?: boolean;
	/** Carries out a tool call (Resident.act). */
	act: (tool: string, args: Record<string, unknown>) => Promise<ToolResult>;
	/** The life tools (docs/life.md 5.2): do, stop, diary, recall, read_day, reflect. */
	life?: boolean;
	/** The body tools (docs/prd.md 3.4.11). Claude sees the mirror's pictures. */
	body?: boolean;
	/** Claude Code's own WebSearch tool (the only built-in tool allowed). Results are untrusted text. */
	web?: boolean;
	logger: Logger;
	/** Path to the claude executable. */
	bin?: string;
}

type Json = Record<string, unknown>;

/** The resident's tools over MCP's streamable HTTP (JSON responses only), on 127.0.0.1 behind a token. */
export class ResidentToolServer {
	private server: Server | null = null;
	readonly token = randomBytes(24).toString("hex");
	url = "";

	private readonly tools: ResidentTool[];
	private readonly act: ClaudeMindOptions["act"];

	constructor(tools: ResidentTool[], act: ClaudeMindOptions["act"]) {
		this.tools = tools;
		this.act = act;
	}

	async start(): Promise<void> {
		const server = createServer((req, res) => void this.handle(req, res));
		await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
		this.server = server;
		this.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
	}

	stop(): void {
		this.server?.close();
		this.server = null;
	}

	private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
		if (req.headers.authorization !== `Bearer ${this.token}` || !req.url?.startsWith("/mcp")) {
			res.writeHead(403).end();
			return;
		}
		if (req.method !== "POST") {
			res.writeHead(req.method === "DELETE" ? 200 : 405).end();
			return;
		}
		let body = "";
		for await (const chunk of req) body += chunk;
		let msg: unknown;
		try {
			msg = JSON.parse(body);
		} catch {
			res.writeHead(400).end();
			return;
		}
		const batch = Array.isArray(msg) ? msg : [msg];
		const out = (await Promise.all(batch.map((m) => this.answer(m as Json)))).filter((r) => r !== null);
		if (out.length === 0) {
			res.writeHead(202).end();
			return;
		}
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify(Array.isArray(msg) ? out : out[0]));
	}

	/** One JSON-RPC message; null for a notification. */
	async answer(m: Json): Promise<Json | null> {
		if (m.id === undefined) return null;
		const ok = (result: unknown) => ({ jsonrpc: "2.0", id: m.id, result });
		const params = (m.params ?? {}) as Json;
		switch (m.method) {
			case "initialize":
				return ok({
					protocolVersion: (params.protocolVersion as string) ?? "2025-06-18",
					capabilities: { tools: {} },
					serverInfo: { name: SERVER, version: "1" },
				});
			case "ping":
				return ok({});
			case "tools/list":
				return ok({
					tools: this.tools.map((t) => ({
						name: t.name,
						description: t.description,
						inputSchema: JSON.parse(JSON.stringify(t.parameters)),
					})),
				});
			case "tools/call": {
				const name = String(params.name ?? "");
				if (!this.tools.some((t) => t.name === name))
					return ok({ content: [{ type: "text", text: `${name} というツールはない。` }], isError: true });
				try {
					const r = await this.act(name, (params.arguments ?? {}) as Record<string, unknown>);
					const text = typeof r === "string" ? r : r.text;
					const image =
						typeof r !== "string" && r.image
							? [{ type: "image", data: Buffer.from(r.image).toString("base64"), mimeType: "image/jpeg" }]
							: [];
					return ok({ content: [{ type: "text", text }, ...image] });
				} catch (e) {
					return ok({ content: [{ type: "text", text: (e as Error).message }], isError: true });
				}
			}
			default:
				return { jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "method not found" } };
		}
	}
}

/** What `claude` prints in stream-json, as far as the mind cares. */
interface StreamEvent {
	type: string;
	subtype?: string;
	session_id?: string;
	result?: string;
	is_error?: boolean;
	message?: { content?: { type: string; text?: string; name?: string }[] };
}

export async function createClaudeMind(opts: ClaudeMindOptions): Promise<Mind> {
	const model = opts.model ?? DEFAULT_CLAUDE_MIND_MODEL;
	const tools = residentTools(!!opts.body, !!opts.life);
	const server = new ResidentToolServer(tools, opts.act);
	await server.start();
	// the session holds everything the resident heard: only the owner may read it
	await mkdir(opts.sessionDir, { recursive: true, mode: 0o700 });
	const idFile = join(opts.sessionDir, "session-id");
	let sessionId = opts.fresh ? null : (await readFile(idFile, "utf8").catch(() => "")).trim() || null;
	let started = sessionId !== null;
	if (!sessionId) {
		sessionId = randomUUID();
		await writeFile(idFile, sessionId, { mode: 0o600 });
	}
	opts.logger.info(
		`claude session ${sessionId} (${started ? "resumed" : "new"}); tools: ${tools.map((t) => t.name).join(", ")}`,
	);

	let child: ChildProcess | null = null;
	let buffer = "";
	let turn: { texts: string[]; done: (r: { text: string; error?: string }) => void } | null = null;

	const spawnClaude = () => {
		const mcp = {
			mcpServers: {
				[SERVER]: { type: "http", url: server.url, headers: { Authorization: `Bearer ${server.token}` } },
			},
		};
		const args = [
			"-p",
			"--input-format",
			"stream-json",
			"--output-format",
			"stream-json",
			"--verbose",
			"--model",
			model,
			"--system-prompt",
			opts.system,
			// none of Claude Code's own tools (except WebSearch on request), settings (hooks, plugins, CLAUDE.md)
			// or other MCP servers
			"--tools",
			opts.web ? "WebSearch" : "",
			"--setting-sources",
			"",
			"--strict-mcp-config",
			"--mcp-config",
			JSON.stringify(mcp),
			"--allowedTools",
			opts.web ? `mcp__${SERVER},WebSearch` : `mcp__${SERVER}`,
			"--no-chrome",
			...(started ? ["--resume", sessionId as string] : ["--session-id", sessionId as string]),
		];
		// No --bare: it would ignore the subscription login. Run where there is nothing to read.
		const c = spawn(opts.bin ?? "claude", args, { cwd: opts.sessionDir, stdio: ["pipe", "pipe", "pipe"] });
		started = true;
		let err = "";
		c.stdout?.setEncoding("utf8");
		c.stdout?.on("data", (d: string) => {
			buffer += d;
			let nl = buffer.indexOf("\n");
			while (nl >= 0) {
				const line = buffer.slice(0, nl).trim();
				buffer = buffer.slice(nl + 1);
				nl = buffer.indexOf("\n");
				if (line) onEvent(line);
			}
		});
		c.stderr?.on("data", (d) => {
			err = (err + String(d)).slice(-2000);
		});
		c.on("close", (code) => {
			if (child === c) child = null;
			buffer = "";
			if (turn) {
				const t = turn;
				turn = null;
				t.done({ text: t.texts.join(""), error: `claude exited (${code}): ${err.slice(-300)}` });
			}
		});
		child = c;
	};

	const onEvent = (line: string) => {
		let e: StreamEvent;
		try {
			e = JSON.parse(line) as StreamEvent;
		} catch {
			return;
		}
		if (e.type === "assistant" && turn)
			for (const c of e.message?.content ?? []) if (c.type === "text" && c.text) turn.texts.push(c.text);
		if (e.type === "result" && turn) {
			const t = turn;
			turn = null;
			t.done(e.is_error ? { text: "", error: e.result ?? "claude error" } : { text: t.texts.join("") });
		}
	};

	return {
		name: `claude:${model}`,
		async prompt(text) {
			if (!child) spawnClaude();
			const c = child as ChildProcess | null;
			if (!c?.stdin) throw new Error("claude did not start");
			const r = await new Promise<{ text: string; error?: string }>((done) => {
				const timer = setTimeout(() => {
					opts.logger.warn("claude turn timed out");
					c.kill();
				}, TURN_MS);
				turn = {
					texts: [],
					done: (v) => {
						clearTimeout(timer);
						done(v);
					},
				};
				c.stdin?.write(`${JSON.stringify({ type: "user", message: { role: "user", content: text } })}\n`);
			});
			if (r.error) throw new Error(r.error);
			return { text: r.text.trim() };
		},
		abort() {
			// the session is saved as it goes: the next turn resumes it in a new process
			child?.kill();
		},
	};
}
