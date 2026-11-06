// T4 prototype (docs/prd.md 3.5, issue #9): the SDK's Agent running in a Durable Object.
// While the city is open the DO keeps an outbound WebSocket to it; an alarm every 30 s restarts the agent if
// the object was evicted, and records whether it stayed in memory (for the cost check). While it is closed the
// connection is gone and the one alarm left is set for the next opening (docs/prd.md 3.5.1).

import { DurableObject, env } from "cloudflare:workers";
import {
	Agent,
	AgentConnection,
	CLOSE_CLOSING,
	type Logger,
	loadCity,
	type Memory,
	WorkersAiLLM,
} from "@rojibura/avatar-sdk";
import { importPrivateKey } from "@rojibura/protocol";
import { fetchCityHours, wakeTime } from "./hours.ts";
import { type Identity, registerWithCode } from "./register.ts";

const WATCH_MS = 30_000;
const LOG_LINES = 50;
const NOTES_PER_COUNTERPART = 8;

/** Notes per counterpart in the DO's storage. */
class StorageMemory implements Memory {
	private readonly storage: DurableObjectStorage;

	constructor(storage: DurableObjectStorage) {
		this.storage = storage;
	}

	async recall(counterpartId: string): Promise<string[]> {
		return (await this.storage.get<string[]>(`mem:${counterpartId}`)) ?? [];
	}

	async remember(counterpartId: string, note: string): Promise<void> {
		const notes = await this.recall(counterpartId);
		notes.push(`${new Date().toISOString().slice(0, 16).replace("T", " ")} ${note}`);
		await this.storage.put(`mem:${counterpartId}`, notes.slice(-NOTES_PER_COUNTERPART));
	}
}

export class AgentDO extends DurableObject<Env> {
	private readonly startedAt = Date.now();
	private readonly logs: string[] = [];
	private conn: AgentConnection | null = null;
	private agent: Agent | null = null;
	private llm: WorkersAiLLM | null = null;
	private llmCalls = 0;
	private neurons = 0;
	private identityReady: Promise<Identity> | null = null;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		ctx.blockConcurrencyWhile(async () => {
			ctx.storage.sql.exec(
				"CREATE TABLE IF NOT EXISTS watch (at INTEGER NOT NULL, instance INTEGER NOT NULL, connected INTEGER NOT NULL)",
			);
		});
	}

	private readonly log: Logger = {
		info: (m) => this.write(m),
		warn: (m) => this.write(`WARN ${m}`),
	};

	private write(m: string): void {
		const line = `${new Date().toISOString().slice(11, 19)} ${m}`;
		console.log(line);
		this.logs.push(line);
		if (this.logs.length > LOG_LINES) this.logs.shift();
	}

	async start(): Promise<void> {
		await this.ctx.storage.put("running", true);
		// the code lasts only 15 minutes: it registers now, even while the city is closed
		await this.identity();
		await this.ctx.storage.setAlarm(await this.wake());
	}

	async stop(): Promise<void> {
		await this.ctx.storage.put("running", false);
		await this.ctx.storage.deleteAlarm();
		this.leave();
	}

	private leave(): void {
		this.agent?.stop();
		this.conn?.stop();
		this.agent = null;
		this.conn = null;
	}

	async status(): Promise<unknown> {
		const watch = this.ctx.storage.sql
			.exec<{ instance: number; n: number; first: number; last: number; up: number }>(
				"SELECT instance, COUNT(*) AS n, MIN(at) AS first, MAX(at) AS last, SUM(connected) AS up FROM watch GROUP BY instance ORDER BY first",
			)
			.toArray();
		const alarm = await this.ctx.storage.getAlarm();
		return {
			running: (await this.ctx.storage.get<boolean>("running")) ?? false,
			connected: this.conn?.online ?? false,
			nextAlarm: alarm === null ? null : new Date(alarm).toISOString(),
			instanceStartedAt: new Date(this.startedAt).toISOString(),
			// one row per in-memory lifetime of this object: few rows = it stayed in memory
			instances: watch.map((w) => ({
				startedAt: new Date(w.instance).toISOString(),
				watchTicks: w.n,
				connectedTicks: w.up,
				lastTick: new Date(w.last).toISOString(),
			})),
			llm: { model: this.llm?.name, calls: this.llmCalls, neurons: Math.round(this.neurons * 10) / 10 },
			logs: this.logs,
		};
	}

	async alarm(): Promise<void> {
		if (!(await this.ctx.storage.get<boolean>("running"))) return;
		const next = await this.wake();
		this.ctx.storage.sql.exec(
			"INSERT INTO watch (at, instance, connected) VALUES (?, ?, ?)",
			Date.now(),
			this.startedAt,
			this.conn?.online ? 1 : 0,
		);
		await this.ctx.storage.setAlarm(next);
	}

	/**
	 * Goes in if the city is open, leaves if it is closed. Returns when to look again. Never throws: a city that
	 * is down for a moment must not cost it the alarm, which is all that would wake it.
	 */
	private async wake(): Promise<number> {
		const now = Date.now();
		if (this.conn?.online) return now + WATCH_MS;
		try {
			const hours = await fetchCityHours(this.env.CITY_URL);
			if (!hours.open) {
				this.leave();
				const at = wakeTime(hours.nextOpening, now, WATCH_MS);
				this.write(`city closed; sleeping until ${new Date(at).toISOString()}`);
				return at;
			}
			await this.boot();
		} catch (e) {
			this.write(`WARN ${e instanceof Error ? e.message : String(e)}`);
		}
		return now + WATCH_MS;
	}

	/**
	 * Who this AI is: what it kept from registering, else the ID and key the owner put in by hand, else a new
	 * registration with the owner's one-time code (docs/prd.md 2.2.4). Kept at once, so a code is never spent twice.
	 */
	private identity(): Promise<Identity> {
		this.identityReady ??= (async () => {
			const kept = await this.ctx.storage.get<Identity>("identity");
			if (kept) return kept;
			const env = this.env;
			if (env.AGENT_ID && env.AGENT_KEY) return { agentId: env.AGENT_ID, privateKey: env.AGENT_KEY };
			if (!env.REGISTRATION_CODE)
				throw new Error("no identity: set REGISTRATION_CODE (from /portal), or AGENT_ID and AGENT_KEY");
			const made = await registerWithCode(env.CITY_URL, env.REGISTRATION_CODE);
			await this.ctx.storage.put("identity", made);
			this.write(`registered as ${made.agentId}`);
			return made;
		})().catch((e) => {
			// try again at the next alarm (the code may have been put in meanwhile)
			this.identityReady = null;
			throw e;
		});
		return this.identityReady;
	}

	private async boot(): Promise<void> {
		if (this.conn) return;
		const env = this.env;
		const identity = await this.identity();
		const city = await loadCity(env.CITY_URL);
		const llm = new WorkersAiLLM(env.AI);
		this.llm = llm;
		// count calls and neurons for the budget check
		const complete = llm.complete.bind(llm);
		llm.complete = async (req) => {
			const r = await complete(req);
			this.llmCalls++;
			this.neurons += llm.lastUsage?.neurons ?? 0;
			return r;
		};
		this.conn = new AgentConnection({
			baseUrl: env.CITY_URL.replace(/^http/, "ws"),
			areaId: env.AREA,
			agentId: identity.agentId,
			privateKey: await importPrivateKey(identity.privateKey),
			logger: this.log,
			onMessage: (m) => this.agent?.handle(m),
			onClosed: (code) => {
				if (code !== CLOSE_CLOSING) return;
				// the alarm asks the city now, and sets itself for the next opening
				this.leave();
				void this.ctx.storage.setAlarm(Date.now());
			},
		});
		this.agent = new Agent({
			persona: { name: identity.name ?? env.AGENT_NAME, personality: env.PERSONA },
			llm,
			memory: new StorageMemory(this.ctx.storage),
			nav: city.nav,
			landmarks: city.landmarks,
			activities: city.activities,
			shops: city.shops,
			foods: city.foods,
			jobZones: city.jobZones,
			logger: this.log,
			send: (m) => this.conn?.send(m),
			dailyLlmLimit: 300,
		});
		this.write(`booted (${city.landmarks.length} landmarks, ${llm.name})`);
		this.conn.start();
	}
}

export default {
	async fetch(request) {
		const url = new URL(request.url);
		const a = new TextEncoder().encode(request.headers.get("Authorization") ?? "");
		const b = new TextEncoder().encode(`Bearer ${env.CONTROL_TOKEN}`);
		if (!env.CONTROL_TOKEN || a.byteLength !== b.byteLength || !crypto.subtle.timingSafeEqual(a, b))
			return new Response("unauthorized", { status: 401 });
		const stub = env.AGENT.getByName("default") as DurableObjectStub<AgentDO>;
		if (url.pathname === "/start" && request.method === "POST") {
			await stub.start();
			return Response.json(await stub.status());
		}
		if (url.pathname === "/stop" && request.method === "POST") {
			await stub.stop();
			return Response.json({ ok: true });
		}
		if (url.pathname === "/status") return Response.json(await stub.status());
		return new Response("not found", { status: 404 });
	},
} satisfies ExportedHandler<Env>;
