// Runs a browser AI (T3, #24) in a dedicated worker, so its timers keep running while the tab is in the
// background. The page (agent-page.ts) only shows what happens here.

import { Agent, AgentConnection, type LLM, type Logger, loadCity } from "@rojibura/avatar-sdk";
import {
	type BrowserIdentity,
	forgetBrowserIdentity,
	HostTrialLLM,
	IdbMemory,
	loadBrowserIdentity,
	registerBrowserAgent,
	saveBrowserIdentity,
	trialRemaining,
} from "@rojibura/avatar-sdk/browser";

export type FromPage =
	| { cmd: "load" }
	/** `preset`: the look of a new AI (kept once it is registered). */
	| { cmd: "start"; name: string; personality: string; preset?: string }
	| { cmd: "stop" }
	| { cmd: "forget" };

export type FromWorker =
	| { t: "identity"; name: string | null; personality: string }
	| { t: "state"; state: "starting" | "running" | "stopped" | "error"; message?: string }
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

async function start(name: string, personality: string, preset?: string): Promise<void> {
	stop();
	post({ t: "state", state: "starting" });
	let id: BrowserIdentity | undefined = await loadBrowserIdentity();
	if (!id) {
		id = await registerBrowserAgent(base, name, personality, preset);
		log.info(`「${id.name}」を登録しました（${id.agentId}）`);
	} else if (id.personality !== personality) {
		id = { ...id, personality };
		await saveBrowserIdentity(id);
	}
	const city = await loadCity(base);
	const quota = await trialRemaining(base);
	if (quota) post({ t: "remaining", remaining: quota.remaining, limit: quota.limit });
	const trial = new HostTrialLLM({ baseUrl: base, agentId: id.agentId, personality });
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
	const identity = id;
	conn = new AgentConnection({
		baseUrl: base.replace(/^http/, "ws"),
		areaId: "main",
		agentId: identity.agentId,
		privateKey: identity.privateKey,
		logger: log,
		onMessage: (m) => agent?.handle(m),
		onWelcome: () => post({ t: "state", state: "running" }),
	});
	agent = new Agent({
		persona: { name: identity.name, personality },
		llm,
		memory: new IdbMemory(identity.agentId),
		nav: city.nav,
		landmarks: city.landmarks,
		logger: log,
		send: (m) => conn?.send(m),
		dailyLlmLimit: quota?.remaining ?? 0,
	});
	conn.start();
}

scope.onmessage = async (e) => {
	const m = e.data;
	try {
		if (m.cmd === "load") {
			const id = await loadBrowserIdentity();
			post({ t: "identity", name: id?.name ?? null, personality: id?.personality ?? "" });
		} else if (m.cmd === "start") {
			await start(m.name, m.personality, m.preset);
		} else if (m.cmd === "stop") {
			stop();
			post({ t: "state", state: "stopped" });
		} else if (m.cmd === "forget") {
			stop();
			await forgetBrowserIdentity();
			post({ t: "identity", name: null, personality: "" });
			post({ t: "state", state: "stopped" });
		}
	} catch (err) {
		post({ t: "state", state: "error", message: (err as Error).message });
	}
};
