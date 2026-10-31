// Runs one AI agent from the command line (node adapter, T5 / development).
//   node apps/avatar-sdk/src/cli.ts --name ミナ --persona "好奇心旺盛でカフェ好き" [--owner kazu] [--llm claude-code|pi|echo]
//   node apps/avatar-sdk/src/cli.ts --name ハル --mind pi [--model llama/<id>] [--llama-url URL] [--fresh]
// See README "AIを動かす".

import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { ClientToHost, HostToClient } from "@rojibura/protocol";
import { ClaudeCodeLLM } from "./adapters/node/claude-code.ts";
import { EchoLLM } from "./adapters/node/echo-llm.ts";
import { FileMemory } from "./adapters/node/file-memory.ts";
import {
	devHeaders,
	loadIdentity,
	privateKeyOf,
	registerWithDevLogin,
	saveIdentity,
} from "./adapters/node/identity.ts";
import { PiLLM } from "./adapters/node/pi.ts";
import { createPiMind, DEFAULT_LLAMA_URL } from "./adapters/node/pi-mind.ts";
import { Agent } from "./core/agent.ts";
import { loadCity } from "./core/city.ts";
import { AgentConnection } from "./core/connection.ts";
import { Resident, residentSystemPrompt } from "./core/resident.ts";
import type { LLM, Logger } from "./core/types.ts";

const { values: args } = parseArgs({
	options: {
		base: { type: "string", default: "http://localhost:5173" },
		area: { type: "string", default: "main" },
		owner: { type: "string", default: "kazu" },
		name: { type: "string", default: "ミナ" },
		persona: { type: "string", default: "好奇心旺盛で人懐っこい。街を散歩するのとカフェが好き。" },
		// rules: the rule-based Agent asking an LLM per reply; pi: a resident living in one long pi session
		mind: { type: "string", default: "rules" },
		llm: { type: "string", default: "claude-code" },
		// default: claude-haiku-5-5 (--llm claude-code), openai-codex/gpt-6-luna (--llm pi),
		// llama/gemma-4-26B-A4B-it-qat-UD-Q4_K_XL (--mind pi)
		model: { type: "string" },
		"llama-url": { type: "string", default: DEFAULT_LLAMA_URL },
		fresh: { type: "boolean", default: false },
		identity: { type: "string" },
		approve: { type: "boolean", default: false },
		// LLM calls (--mind rules, default 300) or turns (--mind pi, default 1500) per day
		"daily-limit": { type: "string" },
	},
});

const base = (args.base ?? "").replace(/\/$/, "");
const name = args.name ?? "ミナ";
const dir = join(homedir(), ".config", "rojibura", "agents");
const identityPath = args.identity ?? join(dir, `${encodeURIComponent(name)}.json`);
// the owner's log of what the agent did and said (docs/prd.md 3.5.2: kept by the runtime, not the host)
const logPath = join(dir, `${encodeURIComponent(name)}.log`);
await mkdir(dir, { recursive: true, mode: 0o700 });
const write = (level: string, m: string) => {
	const line = `[${new Date().toLocaleString()}] ${name}: ${m}`;
	(level === "warn" ? console.warn : console.log)(line);
	void appendFile(logPath, `${line}\n`, { mode: 0o600 }).catch(() => {});
};
const log: Logger = { info: (m) => write("info", m), warn: (m) => write("warn", m) };

let identity = await loadIdentity(identityPath);
if (!identity || identity.baseUrl !== base) {
	identity = await registerWithDevLogin(base, args.owner ?? "kazu", name);
	await saveIdentity(identityPath, identity);
	log.info(`registered as ${identity.agentId} (identity saved to ${identityPath})`);
}
if (args.approve) {
	const r = await fetch(`${base}/api/dev/agents/${identity.agentId}/approve`, {
		method: "POST",
		headers: devHeaders(),
	});
	log.info(r.ok ? "approved (dev)" : `approve failed: ${r.status}`);
}

const persona = { name, personality: args.persona ?? "" };
const city = await loadCity(base);
let handle: ((m: HostToClient) => void) | null = null;
const conn = new AgentConnection({
	baseUrl: base.replace(/^http/, "ws"),
	areaId: args.area ?? "main",
	agentId: identity.agentId,
	privateKey: await privateKeyOf(identity),
	logger: log,
	onMessage: (m) => handle?.(m),
});
const send = (m: ClientToHost) => conn.send(m);
const dailyLimit = args["daily-limit"] ? Number(args["daily-limit"]) : undefined;

let stopMind: () => void;
if (args.mind === "pi") {
	let resident: Resident | null = null;
	const mind = await createPiMind({
		model: args.model,
		llamaUrl: args["llama-url"],
		system: residentSystemPrompt(persona, city.landmarks),
		sessionDir: join(dir, `${encodeURIComponent(name)}.pi`),
		fresh: args.fresh,
		act: (tool, params) => (resident ? resident.act(tool, params) : Promise.resolve("まだ街にいない。")),
		logger: log,
	});
	resident = new Resident({
		persona,
		mind,
		// the same notes file as --mind rules, so a name keeps what it knows about people across minds
		memory: new FileMemory(join(dir, `${encodeURIComponent(name)}.memory.json`)),
		nav: city.nav,
		landmarks: city.landmarks,
		logger: log,
		send,
		dailyTurnLimit: dailyLimit,
	});
	handle = (m) => resident?.handle(m);
	stopMind = () => resident?.stop();
	log.info(
		`mind ${mind.name}; ${city.landmarks.length} landmarks; navmesh ${city.hasNavmesh ? "yes" : "no"}`,
	);
} else {
	const model = args.model ? { model: args.model } : {};
	const llm: LLM =
		args.llm === "echo" ? new EchoLLM() : args.llm === "pi" ? new PiLLM(model) : new ClaudeCodeLLM(model);
	const agent = new Agent({
		persona,
		llm,
		memory: new FileMemory(join(dir, `${encodeURIComponent(name)}.memory.json`)),
		nav: city.nav,
		landmarks: city.landmarks,
		logger: log,
		send,
		dailyLlmLimit: dailyLimit,
	});
	handle = (m) => agent.handle(m);
	stopMind = () => agent.stop();
	log.info(
		`LLM ${llm.name}; ${city.landmarks.length} landmarks; navmesh ${city.hasNavmesh ? "yes" : "no (straight lines)"}`,
	);
}
conn.start();

const stop = () => {
	stopMind();
	conn.stop();
	setTimeout(() => process.exit(0), 200);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
