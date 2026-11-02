// Runs one AI agent from the command line (node adapter, T5 / development).
//   node apps/avatar-sdk/src/cli.ts --name ミナ --persona "好奇心旺盛でカフェ好き" [--owner kazu] [--llm claude-code|pi|echo]
//     [--avatar shino]   (the look, when it is registered: one of the host's /api/presets)
//   node apps/avatar-sdk/src/cli.ts --name ハル --mind pi [--model llama/<id>] [--llama-url URL] [--fresh]
//     [--no-body] [--vision]   (it moves its own body, rehearsing in a mirror, unless --no-body; --vision: and
//     sees the pictures)
//   node apps/avatar-sdk/src/cli.ts --name ハル --mind claude [--model claude-haiku-5-5] [--fresh] [--no-body]
//     (the same resident with Claude Code as its mind: your subscription, for your own testing only)
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
import { createClaudeMind } from "./adapters/node/claude-mind.ts";
import { EchoLLM } from "./adapters/node/echo-llm.ts";
import { FileJournal } from "./adapters/node/file-journal.ts";
import { FileMemory } from "./adapters/node/file-memory.ts";
import {
	devHeaders,
	loadIdentity,
	pairWithCode,
	privateKeyOf,
	registerWithDevLogin,
	saveIdentity,
} from "./adapters/node/identity.ts";
import { ChromeMirror } from "./adapters/node/mirror.ts";
import { FileMoveBook, shortPath } from "./adapters/node/move-book.ts";
import { PiLLM } from "./adapters/node/pi.ts";
import { createPiMind, DEFAULT_LLAMA_URL } from "./adapters/node/pi-mind.ts";
import { Agent } from "./core/agent.ts";
import { loadCity } from "./core/city.ts";
import { AgentConnection, CLOSE_REPLACED } from "./core/connection.ts";
import { Resident, residentSystemPrompt } from "./core/resident.ts";
import type { LLM, Logger } from "./core/types.ts";

const { values: args } = parseArgs({
	allowNegative: true,
	options: {
		base: { type: "string", default: "http://localhost:5173" },
		area: { type: "string", default: "main" },
		owner: { type: "string", default: "kazu" },
		name: { type: "string", default: "ミナ" },
		avatar: { type: "string" },
		// kept with the identity, so later runs can leave it out
		persona: { type: "string" },
		// rules: the rule-based Agent asking an LLM per reply; pi / claude: a resident living in one long pi or
		// Claude Code session
		mind: { type: "string", default: "rules" },
		llm: { type: "string", default: "claude-code" },
		// default: claude-haiku-5-5 (--llm claude-code), openai-codex/gpt-6-luna (--llm pi),
		// llama/gemma-4-26B-A4B-it-qat-UD-Q4_K_XL (--mind pi), claude-haiku-5-5 (--mind claude)
		model: { type: "string" },
		"llama-url": { type: "string", default: DEFAULT_LLAMA_URL },
		fresh: { type: "boolean", default: false },
		// --mind pi / claude: moves its own body, rehearsing in a mirror (headless Chrome) on this PC
		// (docs/prd.md 3.4.11); on unless --no-body
		body: { type: "boolean" },
		// ...and sees the mirror's pictures (llama-server started with the model's --mmproj)
		vision: { type: "boolean", default: false },
		identity: { type: "string" },
		// a one-time code from /agent: this PC runs that AI (its name and look come from the host)
		pair: { type: "string" },
		approve: { type: "boolean", default: false },
		// LLM calls (--mind rules, default 300) or turns (--mind pi / claude, default 1500) per day
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
// a host still starting answers without its files: wait for them rather than live in a city without places
let city = await loadCity(base, args.area);
for (let i = 0; i < 15 && city.landmarks.length === 0 && !city.hasNavmesh; i++) {
	if (i === 0) log.warn("街の場所とナビメッシュを読めません。少し待って読み直します");
	await new Promise((r) => setTimeout(r, 2000));
	city = await loadCity(base, args.area);
}
let handle: ((m: HostToClient) => void) | null = null;
/** Takes on another area's places and walkable ground (following the owner, docs/prd.md 3.8.2). */
let enter: (next: Awaited<ReturnType<typeof loadCity>>) => void = () => {};
/** Its owner went through a portal while it walked with them: it comes along, arriving where they did. */
const follow = async (m: Extract<HostToClient, { t: "FOLLOW" }>) => {
	log.info(`following the owner to ${m.to} (${m.at})`);
	const next = await loadCity(base, m.to);
	enter(next);
	conn.moveTo(m.to, m.at);
};
const conn = new AgentConnection({
	baseUrl: base.replace(/^http/, "ws"),
	areaId: args.area ?? "main",
	agentId: identity.agentId,
	privateKey: await privateKeyOf(identity),
	logger: log,
	onMessage: (m) => (m.t === "FOLLOW" ? void follow(m) : handle?.(m)),
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
if (args.mind === "pi" || args.mind === "claude") {
	const claude = args.mind === "claude";
	let resident: Resident | null = null;
	const body = (args.body ?? true) || args.vision;
	const moves = body
		? new FileMoveBook(
				join(dir, `${encodeURIComponent(name)}.moves.json`),
				join(dir, `${encodeURIComponent(name)}.album`),
				name,
			)
		: undefined;
	if (moves) log.info(`わざ帳: ${shortPath(moves.page, homedir())}`);
	const act = (tool: string, params: Record<string, unknown>) =>
		resident ? resident.act(tool, params) : Promise.resolve("まだ街にいない。");
	// it lives in the city where there is something to do: a diary in <name>.life (docs/life.md 5)
	const life = city.activities.length > 0;
	const journal = life ? new FileJournal(join(dir, `${encodeURIComponent(name)}.life`)) : undefined;
	if (journal) log.info(`日記: ${shortPath(journal.dir, homedir())}`);
	const system = residentSystemPrompt(persona, city.landmarks, body, city.shops, city.activities);
	const mind = claude
		? await createClaudeMind({
				model: args.model,
				system,
				body,
				sessionDir: join(dir, `${encodeURIComponent(name)}.claude`),
				fresh: args.fresh,
				act,
				life,
				logger: log,
			})
		: await createPiMind({
				model: args.model,
				llamaUrl: args["llama-url"],
				system,
				body,
				vision: args.vision,
				sessionDir: join(dir, `${encodeURIComponent(name)}.pi`),
				fresh: args.fresh,
				act,
				life,
				logger: log,
			});
	resident = new Resident({
		persona,
		mind,
		// the same notes file as --mind rules, so a name keeps what it knows about people across minds
		memory: new FileMemory(join(dir, `${encodeURIComponent(name)}.memory.json`)),
		nav: city.nav,
		landmarks: city.landmarks,
		...(journal ? { journal, activities: city.activities } : {}),
		shops: city.shops,
		jobZones: city.jobZones,
		logger: log,
		send,
		dailyTurnLimit: dailyLimit,
		// every turn of a Claude Code mind is a call on the subscription: turns of its own come less often
		...(claude ? { tickMs: [120_000, 300_000], quietTickMs: [300_000, 900_000] } : {}),
		// Claude sees images
		...(moves ? { moves, mirror: new ChromeMirror({ base, logger: log }), sees: claude || args.vision } : {}),
	});
	handle = (m) => resident?.handle(m);
	enter = (next) => resident?.setCity(next.nav, next.landmarks, next.name, next.activities);
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
		activities: city.activities,
		logger: log,
		send,
		dailyLlmLimit: dailyLimit,
	});
	handle = (m) => agent.handle(m);
	enter = (next) => agent.setCity(next.nav, next.landmarks, next.activities);
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
