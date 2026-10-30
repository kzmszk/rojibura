// The agent's mind: rule-based wandering plus LLM replies (docs/prd.md 3.5.2).
// Independent of the runtime; adapters provide the LLM, memory, navigation and the connection.

import {
	type AvatarId,
	type AvatarState,
	type BudgetLevel,
	type ClientToHost,
	dist,
	type HostToClient,
	MAX_PATH_POINTS,
	poseAt,
	type SpatialContext,
	type Vec2,
	WALK_SPEED,
} from "@rojibura/protocol";
import { decisionSchema, FALLBACK_REPLIES, parseDecision, systemPrompt, userPrompt } from "./prompt.ts";
import type { Decision, Landmark, LLM, Logger, Memory, Navigator, Persona } from "./types.ts";

export interface AgentOptions {
	persona: Persona;
	llm: LLM;
	memory: Memory;
	nav: Navigator;
	landmarks: Landmark[];
	logger: Logger;
	send: (msg: ClientToHost) => void;
	/** LLM calls per day before the agent rests (docs/prd.md 3.5.2). */
	dailyLlmLimit?: number;
	/** Wander interval range in ms (scaled by the budget level). */
	wanderMs?: [number, number];
	random?: () => number;
}

interface Pending {
	from: AvatarId;
	text: string;
	convId: string;
	context: SpatialContext;
}

const WANDER_FACTOR: Record<BudgetLevel, number | null> = { 0: 1, 1: 3, 2: null, 3: null, 4: null };
const MAX_QUEUE = 3;
const HISTORY = 6;

export class Agent {
	private me: AvatarId | null = null;
	private readonly avatars = new Map<AvatarId, AvatarState>();
	private offset = 0;
	private budget: BudgetLevel = 0;
	private readonly convs = new Map<string, { with: AvatarId; history: string[] }>();
	private readonly queue: Pending[] = [];
	private busy = false;
	private resting = false;
	private llmCalls = { day: "", count: 0 };
	private wanderTimer: ReturnType<typeof setTimeout> | null = null;
	private seq = 0;
	private readonly o: AgentOptions;
	private readonly random: () => number;

	constructor(opts: AgentOptions) {
		this.o = opts;
		this.random = opts.random ?? Math.random;
	}

	get id(): AvatarId | null {
		return this.me;
	}

	stop(): void {
		if (this.wanderTimer) clearTimeout(this.wanderTimer);
		this.wanderTimer = null;
	}

	/** Host time estimated from WELCOME.serverTime. */
	hostNow(): number {
		return Date.now() + this.offset;
	}

	positionOf(id: AvatarId): Vec2 | null {
		const a = this.avatars.get(id);
		return a ? poseAt(a.move, this.hostNow()).pos : null;
	}

	handle(msg: HostToClient): void {
		switch (msg.t) {
			case "WELCOME":
				this.me = msg.you;
				this.offset = msg.serverTime - Date.now();
				this.budget = msg.budget;
				this.avatars.clear();
				for (const a of msg.avatars) this.avatars.set(a.id, a);
				this.o.logger.info(`joined as ${msg.you}; ${msg.avatars.length} avatars here`);
				this.scheduleWander(3000);
				return;
			case "JOINED":
				this.avatars.set(msg.avatar.id, msg.avatar);
				return;
			case "LEFT":
				this.avatars.delete(msg.id);
				return;
			case "MOVED": {
				const a = this.avatars.get(msg.id);
				if (a) a.move = msg.move;
				return;
			}
			case "CORRECT": {
				const a = this.me ? this.avatars.get(this.me) : undefined;
				if (a) a.move = msg.move;
				return;
			}
			case "STATUS_CHANGED": {
				const a = this.avatars.get(msg.id);
				if (a) a.status = msg.status;
				return;
			}
			case "BUDGET":
				this.budget = msg.level;
				return;
			case "ADDRESSED":
				this.enqueue({ from: msg.from, text: msg.text, convId: msg.convId, context: msg.context });
				return;
			case "CONV_END":
				this.convs.delete(msg.convId);
				return;
			case "NOTICE":
				this.o.logger.warn(`notice ${msg.kind}: ${msg.message}`);
				return;
			default:
				return;
		}
	}

	// ---- conversation -------------------------------------------------------

	private enqueue(p: Pending): void {
		if (this.resting) return;
		if (this.queue.length >= MAX_QUEUE) {
			this.o.logger.warn("too many people talking at once; ignoring one");
			return;
		}
		this.queue.push(p);
		void this.drain();
	}

	private async drain(): Promise<void> {
		if (this.busy) return;
		this.busy = true;
		this.o.send({ t: "STATUS", status: "busy" });
		try {
			for (let p = this.queue.shift(); p; p = this.queue.shift()) await this.reply(p);
		} finally {
			this.busy = false;
			this.o.send({ t: "STATUS", status: this.resting ? "resting" : "active" });
		}
	}

	private async reply(p: Pending): Promise<void> {
		const from = this.avatars.get(p.from);
		const fromName = from?.name ?? "だれか";
		const conv = this.convs.get(p.convId) ?? { with: p.from, history: [] };
		this.convs.set(p.convId, conv);
		conv.history.push(`${fromName}「${p.text}」`);

		const landmarkIds = p.context.nearbyLandmarks.map((l) => l.id);
		const decision = (await this.decide(p, fromName, conv.history, landmarkIds)) ?? {
			reply: FALLBACK_REPLIES[Math.floor(this.random() * FALLBACK_REPLIES.length)] ?? "…",
			motion: "none",
			goTo: "stay",
			endConversation: false,
		};

		this.o.send({ t: "SAY", text: decision.reply, convId: p.convId });
		if (decision.motion !== "none") this.o.send({ t: "ACTION", motion: decision.motion, target: p.from });
		this.goTo(decision.goTo, p.from);
		conv.history.push(`自分「${decision.reply}」`);
		if (conv.history.length > HISTORY) conv.history.splice(0, conv.history.length - HISTORY);
		await this.o.memory.remember(p.from, `${fromName}「${p.text}」に「${decision.reply}」と答えた`);
		this.o.logger.info(`${fromName}: ${p.text} -> ${decision.reply} [${decision.motion}, ${decision.goTo}]`);
	}

	private async decide(
		p: Pending,
		fromName: string,
		history: string[],
		landmarkIds: string[],
	): Promise<Decision | null> {
		if (!this.takeLlmCall()) return null;
		const fromAvatar = this.avatars.get(p.from);
		const me = this.me ? this.positionOf(this.me) : null;
		const there = this.positionOf(p.from);
		try {
			const raw = await this.o.llm.complete({
				system: systemPrompt(this.o.persona),
				user: userPrompt({
					from: {
						id: p.from,
						name: fromName,
						kind: fromAvatar?.kind ?? "human",
						distance: me && there ? Math.round(dist(me, there) * 10) / 10 : null,
					},
					text: p.text,
					context: p.context,
					memory: await this.o.memory.recall(p.from),
					history: history.slice(0, -1),
				}),
				schema: decisionSchema(landmarkIds),
			});
			const d = parseDecision(raw, landmarkIds);
			if (!d) this.o.logger.warn(`LLM output rejected: ${JSON.stringify(raw)?.slice(0, 200)}`);
			return d;
		} catch (e) {
			this.o.logger.warn(`LLM failed: ${(e as Error).message}`);
			return null;
		}
	}

	private takeLlmCall(): boolean {
		const day = new Date().toISOString().slice(0, 10);
		if (this.llmCalls.day !== day) this.llmCalls = { day, count: 0 };
		const limit = this.o.dailyLlmLimit ?? 300;
		if (this.llmCalls.count >= limit) {
			if (!this.resting) this.o.logger.warn("daily LLM limit reached; resting");
			this.resting = true;
			return false;
		}
		this.llmCalls.count++;
		return true;
	}

	// ---- movement -------------------------------------------------------------

	private goTo(target: string, speaker: AvatarId): void {
		if (target === "stay") return;
		let to: Vec2 | null = null;
		if (target === "speaker") {
			const me = this.me ? this.positionOf(this.me) : null;
			const there = this.positionOf(speaker);
			if (me && there && dist(me, there) > 2) {
				// stop about 1.2 m before the speaker
				const d = dist(me, there);
				to = [there[0] + ((me[0] - there[0]) / d) * 1.2, there[1] + ((me[1] - there[1]) / d) * 1.2];
			}
		} else {
			to = this.o.landmarks.find((l) => l.id === target)?.pos ?? null;
		}
		if (to) this.walkTo(to);
	}

	walkTo(to: Vec2): boolean {
		const from = this.me ? this.positionOf(this.me) : null;
		if (!from) return false;
		const path = this.o.nav.findPath(from, to);
		if (!path || path.length < 2) return false;
		this.o.send({ t: "MOVE_PATH", path: path.slice(0, MAX_PATH_POINTS), speed: WALK_SPEED, seq: ++this.seq });
		return true;
	}

	private scheduleWander(delay?: number): void {
		if (this.wanderTimer) clearTimeout(this.wanderTimer);
		const factor = WANDER_FACTOR[this.budget];
		const [min, max] = this.o.wanderMs ?? [15_000, 60_000];
		const ms = delay ?? (min + this.random() * (max - min)) * (factor ?? 1);
		this.wanderTimer = setTimeout(() => this.wander(), ms);
	}

	private wander(): void {
		this.scheduleWander();
		if (WANDER_FACTOR[this.budget] === null || this.busy || this.resting || this.convs.size > 0) return;
		const me = this.me ? this.avatars.get(this.me) : undefined;
		if (!me || poseAt(me.move, this.hostNow()).moving) return;
		const here = poseAt(me.move, this.hostNow()).pos;
		const options = this.o.landmarks.filter((l) => dist(l.pos, here) > 6);
		const pick = options[Math.floor(this.random() * options.length)];
		if (!pick) return;
		const a = this.random() * Math.PI * 2;
		const jitter: Vec2 = [pick.pos[0] + Math.cos(a) * 1.5, pick.pos[1] + Math.sin(a) * 1.5];
		if (!this.walkTo(jitter)) this.walkTo(pick.pos);
	}
}
