// Runs one AI agent from the command line (node adapter, T5 / development).
//   node apps/avatar-sdk/src/cli.ts --name ミナ --persona "好奇心旺盛でカフェ好き" [--owner kazu] [--llm claude-code|pi|echo]
//     [--avatar shino]   (the look, when it is registered: one of the host's /api/presets)
//   node apps/avatar-sdk/src/cli.ts --name ハル --mind pi [--model llama/<id>] [--llama-url URL] [--fresh]
//   node apps/avatar-sdk/src/cli.ts --base https://… --pair ABCD2345 --persona '…' [--mind pi]
//     (runs on this PC an AI registered in the city's 🤖 自分のAI, with the code shown there; docs/prd.md 3.5.1;
//     next time --base https://… --name <name>: the personality is kept with the identity)
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
	pairWithCode,
	privateKeyOf,
	registerWithDevLogin,
	saveIdentity,
} from "./adapters/node/identity.ts";
import { PiLLM } from "./adapters/node/pi.ts";
import { createPiMind, DEFAULT_LLAMA_URL } from "./adapters/node/pi-mind.ts";
import { Agent } from "./core/agent.ts";
import { loadCity } from "./core/city.ts";
import { AgentConnection, CLOSE_REPLACED } from "./core/connection.ts";
import { Resident, residentSystemPrompt } from "./core/resident.ts";
import type { LLM, Logger } from "./core/types.ts";

const { values: args } = parseArgs({
	options: {
		base: { type: "string", default: "http://localhost:5173" },
		area: { type: "string", default: "main" },
		owner: { type: "string", default: "kazu" },
		name: { type: "string", default: "ミナ" },
		avatar: { type: "string" },
		// kept with the identity, so later runs can leave it out
		persona: { type: "string" },
		// rules: the rule-based Agent asking an LLM per reply; pi: a resident living in one long pi session
		mind: { type: "string", default: "rules" },
		llm: { type: "string", default: "claude-code" },
		// default: claude-haiku-5-5 (--llm claude-code), openai-codex/gpt-6-luna (--llm pi),
		// llama/gemma-4-26B-A4B-it-qat-UD-Q4_K_XL (--mind pi)
		model: { type: "string" },
		"llama-url": { type: "string", default: DEFAULT_LLAMA_URL },
		fresh: { type: "boolean", default: false },
		identity: { type: "string" },
		// a one-time code from /agent: this PC runs that AI (its name and look come from the host)
		pair: { type: "string" },
		approve: { type: "boolean", default: false },
		// LLM calls (--mind rules, default 300) or turns (--mind pi, default 1500) per day
		"daily-limit": { type: "string" },
	},
});

const base = (args.base ?? "").replace(/\/$/, "");
const dir = join(homedir(), ".config", "rojibura", "agents");
const paired = args.pair ? await pairWithCode(base, args.pair) : null;
const name = paired?.name ?? args.name ?? "ミナ";
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

let identity = paired ?? (await loadIdentity(identityPath));
if (paired) {
	await saveIdentity(identityPath, paired);
	log.info(
		`paired with ${paired.agentId}; next time: --base ${base} --name ${name} (identity saved to ${identityPath})`,
	);
} else if (!identity || identity.baseUrl !== base) {
	identity = await registerWithDevLogin(base, args.owner ?? "kazu", name, args.avatar);
	await saveIdentity(identityPath, identity);
	log.info(`registered as ${identity.agentId} (identity saved to ${identityPath})`);
}
if (!identity) throw new Error("no identity");
if (args.persona !== undefined && args.persona !== identity.persona) {
	identity = { ...identity, persona: args.persona };
	await saveIdentity(identityPath, identity);
}
if (args.approve) {
	const r = await fetch(`${base}/api/dev/agents/${identity.agentId}/approve`, {
		method: "POST",
		headers: devHeaders(),
	});
	log.info(r.ok ? "approved (dev)" : `approve failed: ${r.status}`);
}

const persona = {
	name,
	personality: identity.persona ?? "好奇心旺盛で人懐っこい。街を散歩するのとカフェが好き。",
};
const city = await loadCity(base, args.area);
let handle: ((m: HostToClient) => void) | null = null;
const conn = new AgentConnection({
	baseUrl: base.replace(/^http/, "ws"),
	areaId: args.area ?? "main",
	agentId: identity.agentId,
	privateKey: await privateKeyOf(identity),
	logger: log,
	onMessage: (m) => handle?.(m),
	onClosed: (code) => {
		// the same AI came in from its owner's browser (or another PC): that one stays, this one stops
		if (code === CLOSE_REPLACED) {
			log.warn("この AI は別の場所（ブラウザなど）から入りました。PC 側は止めます");
			stop();
		}
	},
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
