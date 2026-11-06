// Runs a browser AI (T3, #24) in a dedicated worker, so its timers keep running while the tab is in the
// background. The city tab's panel (agent-panel.ts) only shows and steers what happens here.

import {
	Agent,
	AgentConnection,
	CLOSE_REPLACED,
	type LLM,
	type Logger,
	loadCity,
} from "@rojibura/avatar-sdk";
import { HostTrialLLM, IdbMemory, loadBrowserIdentity, trialRemaining } from "@rojibura/avatar-sdk/browser";
import { closeMessage } from "./agent-roster.ts";

export type FromPage =
	/** `area`, `at`: where the page is, and the portal it came through (docs/prd.md 3.8.2). */
	{ cmd: "start"; ownerId: string; agentId: string; area: string; at?: string } | { cmd: "stop" };

export type FromWorker =
	/** replaced: the same AI came in from its owner's PC (docs/prd.md 3.5.1), and this tab's stepped out. */
	| { t: "state"; state: "starting" | "running" | "stopped" | "replaced" }
	/** It is not running. `code`: the host closed its connection, for good. */
	| { t: "state"; state: "error"; message: string; code?: number }
	| { t: "log"; at: number; line: string }
	| { t: "remaining"; remaining: number; limit?: number };

const scope = self as unknown as {
	postMessage(m: FromWorker): void;
	onmessage: ((e: MessageEvent<FromPage>) => void) | null;
	location: { origin: string };
};
const post = (m: FromWorker) => scope.postMessage(m);
const base = scope.location.origin;
const log: Logger = {
	info: (line) => post({ t: "log", at: Date.now(), line }),
	warn: (line) => post({ t: "log", at: Date.now(), line: `⚠ ${line}` }),
};

let agent: Agent | null = null;
let conn: AgentConnection | null = null;

function stop(): void {
	agent?.stop();
	conn?.stop();
	agent = null;
	conn = null;
}

/** This worker runs one AI, the one it is told to start, until the page lets it go. */
async function start(ownerId: string, agentId: string, area: string, at?: string): Promise<void> {
	post({ t: "state", state: "starting" });
	const identity = await loadBrowserIdentity(ownerId, agentId);
	if (!identity) throw new Error("このブラウザにこのAIの鍵がありません");
	const { personality } = identity;
	const city = await loadCity(base, area);
	const quota = await trialRemaining(base);
	if (quota) post({ t: "remaining", remaining: quota.remaining, limit: quota.limit });
	const trial = new HostTrialLLM({ baseUrl: base, agentId: identity.agentId, personality });
	const llm: LLM = {
		name: trial.name,
		complete: async (req) => {
			try {
				return await trial.complete(req);
			} finally {
				if (trial.remaining !== null) post({ t: "remaining", remaining: trial.remaining });
			}
		},
	};
	/** What the host last refused: the reason, when it closes the connection right after. */
	let refused: string | null = null;
	conn = new AgentConnection({
		baseUrl: base.replace(/^http/, "ws"),
		areaId: area,
		...(at ? { at } : {}),
		agentId: identity.agentId,
		privateKey: identity.privateKey,
		logger: log,
		onMessage: (m) => {
			if (m.t === "NOTICE" && m.kind === "rejected") refused = m.message;
			agent?.handle(m);
		},
		onWelcome: () => post({ t: "state", state: "running" }),
		onClosed: (code, reason) => {
			stop();
			if (code === CLOSE_REPLACED) post({ t: "state", state: "replaced" });
			else post({ t: "state", state: "error", message: closeMessage(code, reason, refused), code });
		},
	});
	agent = new Agent({
		persona: { name: identity.name, personality },
		llm,
		memory: new IdbMemory(identity.agentId),
		nav: city.nav,
		landmarks: city.landmarks,
		// it eats, works and plays by what it needs (docs/life.md 5.3)
		activities: city.activities,
		shops: city.shops,
		foods: city.foods,
		jobZones: city.jobZones,
		logger: log,
		send: (m) => conn?.send(m),
		dailyLlmLimit: quota?.remaining ?? 0,
	});
	conn.start();
}

scope.onmessage = async (e) => {
	const m = e.data;
	try {
		if (m.cmd === "start") {
			await start(m.ownerId, m.agentId, m.area, m.at);
		} else if (m.cmd === "stop") {
			stop();
			post({ t: "state", state: "stopped" });
		}
	} catch (err) {
		stop();
		post({ t: "state", state: "error", message: (err as Error).message });
	}
};
