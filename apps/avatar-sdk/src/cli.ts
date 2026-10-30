// Runs one AI agent from the command line (node adapter, T5 / development).
//   node apps/avatar-sdk/src/cli.ts --name ミナ --persona "好奇心旺盛でカフェ好き" [--owner kazu] [--llm claude-code|echo]
// See README "AIを動かす".

import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { ClaudeCodeLLM } from "./adapters/node/claude-code.ts";
import { EchoLLM } from "./adapters/node/echo-llm.ts";
import { FileMemory } from "./adapters/node/file-memory.ts";
import { loadIdentity, privateKeyOf, registerWithDevLogin, saveIdentity } from "./adapters/node/identity.ts";
import { Agent } from "./core/agent.ts";
import { loadCity } from "./core/city.ts";
import { AgentConnection } from "./core/connection.ts";
import type { LLM, Logger } from "./core/types.ts";

const { values: args } = parseArgs({
	options: {
		base: { type: "string", default: "http://localhost:5173" },
		area: { type: "string", default: "main" },
		owner: { type: "string", default: "kazu" },
		name: { type: "string", default: "ミナ" },
		persona: { type: "string", default: "好奇心旺盛で人懐っこい。街を散歩するのとカフェが好き。" },
		llm: { type: "string", default: "claude-code" },
		model: { type: "string", default: "claude-haiku-5-5" },
		identity: { type: "string" },
		approve: { type: "boolean", default: false },
		"daily-limit": { type: "string", default: "300" },
	},
});

const base = (args.base ?? "").replace(/\/$/, "");
const name = args.name ?? "ミナ";
const dir = join(homedir(), ".config", "rojibura", "agents");
const identityPath = args.identity ?? join(dir, `${encodeURIComponent(name)}.json`);
const log: Logger = {
	info: (m) => console.log(`[${new Date().toLocaleTimeString()}] ${name}: ${m}`),
	warn: (m) => console.warn(`[${new Date().toLocaleTimeString()}] ${name}: ${m}`),
};

let identity = await loadIdentity(identityPath);
if (!identity || identity.baseUrl !== base) {
	identity = await registerWithDevLogin(base, args.owner ?? "kazu", name);
	await saveIdentity(identityPath, identity);
	log.info(`registered as ${identity.agentId} (identity saved to ${identityPath})`);
}
if (args.approve) {
	const r = await fetch(`${base}/api/dev/agents/${identity.agentId}/approve`, { method: "POST" });
	log.info(r.ok ? "approved (dev)" : `approve failed: ${r.status}`);
}

const llm: LLM = args.llm === "echo" ? new EchoLLM() : new ClaudeCodeLLM({ model: args.model });
const city = await loadCity(base);
log.info(
	`LLM ${llm.name}; ${city.landmarks.length} landmarks; navmesh ${city.hasNavmesh ? "yes" : "no (straight lines)"}`,
);

let agent: Agent | null = null;
const conn = new AgentConnection({
	baseUrl: base.replace(/^http/, "ws"),
	areaId: args.area ?? "main",
	agentId: identity.agentId,
	privateKey: await privateKeyOf(identity),
	logger: log,
	onMessage: (m) => agent?.handle(m),
});
agent = new Agent({
	persona: { name, personality: args.persona ?? "" },
	llm,
	memory: new FileMemory(join(dir, `${encodeURIComponent(name)}.memory.json`)),
	nav: city.nav,
	landmarks: city.landmarks,
	logger: log,
	send: (m) => conn.send(m),
	dailyLlmLimit: Number(args["daily-limit"]),
});
conn.start();

const stop = () => {
	agent?.stop();
	conn.stop();
	setTimeout(() => process.exit(0), 200);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
