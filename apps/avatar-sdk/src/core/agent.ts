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
import {
	decisionSchema,
	FALLBACK_REPLIES,
	openingPrompt,
	parseDecision,
	parseSummary,
	SUMMARY_SCHEMA,
	summaryPrompt,
	systemPrompt,
	userPrompt,
} from "./prompt.ts";
import type { Decision, Landmark, LLM, Logger, Memory, Navigator, Persona } from "./types.ts";
import { World } from "./world.ts";

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
	/** Summarize each finished conversation into memory with one more LLM call (default true). */
	summarize?: boolean;
	/** Wander interval range in ms (scaled by the budget level). */
	wanderMs?: [number, number];
	random?: () => number;
}

interface Pending {
	from: AvatarId;
	text: string;
	convId: string;
	context: SpatialContext;
	turn: number;
	maxTurns: number | null;
}

const WANDER_FACTOR: Record<BudgetLevel, number | null> = { 0: 1, 1: 3, 2: null, 3: null, 4: null };
const MAX_QUEUE = 3;
/** A conversation with no activity for this long is closed locally even without CONV_END. */
const CONV_STALE_MS = 90_000;

interface Conv {
	with: AvatarId;
	history: string[];
	lastAt: number;
}
/** How close another AI must be to start talking, and how long to wait before talking to them again. */
const TALK_RADIUS = 6;
const TALK_AGAIN_MS = 10 * 60_000;
const HISTORY = 6;

export class Agent {
	private readonly world = new World();
	private readonly convs = new Map<string, Conv>();
	private readonly queue: Pending[] = [];
	private busy = false;
	private resting = false;
	private llmCalls = { day: "", count: 0 };
	private wanderTimer: ReturnType<typeof setTimeout> | null = null;
	private readonly lastTalked = new Map<AvatarId, number>();
	/** AI conversations this agent decided to end; further turns are not answered. */
	private readonly ended = new Set<string>();
	private seq = 0;
	private readonly o: AgentOptions;
	private readonly random: () => number;

	constructor(opts: AgentOptions) {
		this.o = opts;
		this.random = opts.random ?? Math.random;
	}

	get id(): AvatarId | null {
		return this.world.me;
	}

	stop(): void {
		if (this.wanderTimer) clearTimeout(this.wanderTimer);
		this.wanderTimer = null;
	}

	/** Host time estimated from WELCOME.serverTime. */
	hostNow(): number {
		return this.world.hostNow();
	}

	positionOf(id: AvatarId): Vec2 | null {
		return this.world.positionOf(id);
	}

	handle(msg: HostToClient): void {
		if (this.world.apply(msg)) {
			if (msg.t === "WELCOME") {
				this.o.logger.info(`joined as ${msg.you}; ${msg.avatars.length} avatars here`);
				this.scheduleWander(3000);
			}
			return;
		}
		switch (msg.t) {
			case "OFFERED":
				// a handshake or a hug: the city's AIs say yes (docs/prd.md 3.4.6), and stay put for it
				this.o.send({ t: "ANSWER", to: msg.from, accept: true });
				this.scheduleWander(10_000);
				return;
			case "ADDRESSED":
				this.enqueue({
					from: msg.from,
					text: msg.text,
					convId: msg.convId,
					context: msg.context,
					turn: msg.turn,
					maxTurns: msg.maxTurns,
				});
				return;
			case "CONV_END": {
				const conv = this.convs.get(msg.convId);
				this.convs.delete(msg.convId);
				this.ended.delete(msg.convId);
				if (conv && this.o.summarize !== false) void this.summarize(conv);
				return;
			}
			case "SAID":
				// learn the conversation ID of a conversation this agent started
				if (msg.id === this.world.me && msg.to && msg.convId && !this.convs.has(msg.convId))
					this.convs.set(msg.convId, { with: msg.to, history: [`自分「${msg.text}」`], lastAt: Date.now() });
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
		if (this.resting || this.ended.has(p.convId)) return;
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
		const from = this.world.avatars.get(p.from);
		const fromName = from?.name ?? "だれか";
		const conv = this.convs.get(p.convId) ?? { with: p.from, history: [], lastAt: Date.now() };
		this.convs.set(p.convId, conv);
		conv.lastAt = Date.now();
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
		if (decision.endConversation && from?.kind === "ai") this.ended.add(p.convId);
		this.lastTalked.set(p.from, Date.now());
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
		const fromAvatar = this.world.avatars.get(p.from);
		const me = this.world.me ? this.positionOf(this.world.me) : null;
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
					turn: p.turn,
					maxTurns: p.maxTurns,
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
			const me = this.world.me ? this.positionOf(this.world.me) : null;
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

	private async initiate(to: AvatarState, distance: number, here: Vec2): Promise<void> {
		if (this.busy || !this.takeLlmCall()) return;
		this.busy = true;
		this.lastTalked.set(to.id, Date.now());
		this.o.send({ t: "STATUS", status: "busy" });
		try {
			const landmarks = this.world.landmarksNear(this.o.landmarks, here);
			const area = landmarks[0] && landmarks[0].distance <= 15 ? landmarks[0].name : "街なか";
			const raw = await this.o.llm.complete({
				system: systemPrompt(this.o.persona),
				user: openingPrompt({
					to: { name: to.name, kind: to.kind, distance: Math.round(distance * 10) / 10 },
					area,
					landmarks,
					memory: await this.o.memory.recall(to.id),
				}),
				schema: decisionSchema(landmarks.map((l) => l.id)),
			});
			const d = parseDecision(
				raw,
				landmarks.map((l) => l.id),
			);
			if (!d) return;
			this.o.send({ t: "SAY", text: d.reply, to: to.id });
			if (d.motion !== "none") this.o.send({ t: "ACTION", motion: d.motion, target: to.id });
			await this.o.memory.remember(to.id, `自分から「${d.reply}」と話しかけた`);
			this.o.logger.info(`-> ${to.name}: ${d.reply}`);
		} catch (e) {
			this.o.logger.warn(`opening failed: ${(e as Error).message}`);
		} finally {
			this.busy = false;
			this.o.send({ t: "STATUS", status: "active" });
			void this.drain();
		}
	}

	/** Turns a finished conversation into one memory note about the partner. */
	private async summarize(conv: Conv): Promise<void> {
		if (conv.history.length < 3 || !this.takeLlmCall()) return;
		const partner = this.world.avatars.get(conv.with)?.name ?? "相手";
		try {
			const summary = parseSummary(
				await this.o.llm.complete({
					system: systemPrompt(this.o.persona),
					user: summaryPrompt(partner, conv.history),
					schema: SUMMARY_SCHEMA,
				}),
			);
			if (summary) {
				await this.o.memory.remember(conv.with, `会話のまとめ: ${summary}`);
				this.o.logger.info(`summary with ${partner}: ${summary}`);
			}
		} catch (e) {
			this.o.logger.warn(`summary failed: ${(e as Error).message}`);
		}
	}

	walkTo(to: Vec2): boolean {
		const from = this.world.me ? this.positionOf(this.world.me) : null;
		if (!from) return false;
		const path = this.o.nav.findPath(from, to);
		if (!path || path.length < 2) return false;
		this.o.send({ t: "MOVE_PATH", path: path.slice(0, MAX_PATH_POINTS), speed: WALK_SPEED, seq: ++this.seq });
		return true;
	}

	private scheduleWander(delay?: number): void {
		if (this.wanderTimer) clearTimeout(this.wanderTimer);
		const factor = WANDER_FACTOR[this.world.budget];
		const [min, max] = this.o.wanderMs ?? [15_000, 60_000];
		const ms = delay ?? (min + this.random() * (max - min)) * (factor ?? 1);
		this.wanderTimer = setTimeout(() => this.wander(), ms);
	}

	private wander(): void {
		this.scheduleWander();
		// the host normally ends conversations; do not stay "in a conversation" forever if that message was lost
		for (const [id, c] of this.convs)
			if (Date.now() - c.lastAt > CONV_STALE_MS) {
				this.convs.delete(id);
				this.ended.delete(id);
				if (this.o.summarize !== false) void this.summarize(c);
			}
		if (WANDER_FACTOR[this.world.budget] === null || this.busy || this.resting || this.convs.size > 0) return;
		const me = this.world.me ? this.world.avatars.get(this.world.me) : undefined;
		if (!me || poseAt(me.move, this.hostNow()).moving) return;
		const here = poseAt(me.move, this.hostNow()).pos;

		// social: talk to an AI nearby, or go and find one (docs/prd.md 1.4, the core loop)
		const now = Date.now();
		const others = [...this.world.avatars.values()].filter(
			(a) =>
				a.id !== this.world.me &&
				a.kind === "ai" &&
				a.status === "active" &&
				now - (this.lastTalked.get(a.id) ?? 0) > TALK_AGAIN_MS,
		);
		const near = others
			.map((a) => ({ a, d: dist(poseAt(a.move, this.hostNow()).pos, here) }))
			.filter((x) => x.d <= TALK_RADIUS)
			.sort((x, y) => x.d - y.d)[0];
		if (near && this.world.budget === 0 && this.random() < 0.6) {
			void this.initiate(near.a, near.d, here);
			return;
		}
		// approved AIs may greet people who accept it, less often than other AIs (docs/prd.md 3.3)
		if (me.trust === "approved" && this.world.budget === 0) {
			const person = [...this.world.avatars.values()]
				.filter(
					(a) =>
						a.kind === "human" &&
						a.acceptsAi !== false &&
						now - (this.lastTalked.get(a.id) ?? 0) > TALK_AGAIN_MS * 2,
				)
				.map((a) => ({ a, d: dist(poseAt(a.move, this.hostNow()).pos, here) }))
				.filter((x) => x.d <= TALK_RADIUS)
				.sort((x, y) => x.d - y.d)[0];
			if (person && this.random() < 0.3) {
				void this.initiate(person.a, person.d, here);
				return;
			}
			// sometimes stroll over to someone who is fine with being greeted
			const far = [...this.world.avatars.values()]
				.filter(
					(a) =>
						a.kind === "human" &&
						a.acceptsAi !== false &&
						now - (this.lastTalked.get(a.id) ?? 0) > TALK_AGAIN_MS * 2,
				)
				.map((a) => ({ a, pos: poseAt(a.move, this.hostNow()).pos }))
				.filter((x) => dist(x.pos, here) > TALK_RADIUS && dist(x.pos, here) < 40)[0];
			if (far && this.random() < 0.25) {
				const d = dist(here, far.pos);
				this.o.logger.info(`walking over to ${far.a.name}`);
				this.walkTo([
					far.pos[0] + ((here[0] - far.pos[0]) / d) * 2.5,
					far.pos[1] + ((here[1] - far.pos[1]) / d) * 2.5,
				]);
				return;
			}
		}
		const friend = others[Math.floor(this.random() * others.length)];
		if (friend && this.random() < 0.35) {
			const there = poseAt(friend.move, this.hostNow()).pos;
			const d = dist(here, there);
			if (d > TALK_RADIUS) {
				this.walkTo([there[0] + ((here[0] - there[0]) / d) * 2, there[1] + ((here[1] - there[1]) / d) * 2]);
				return;
			}
		}

		const options = this.o.landmarks.filter((l) => dist(l.pos, here) > 6);
		const pick = options[Math.floor(this.random() * options.length)];
		if (!pick) return;
		const a = this.random() * Math.PI * 2;
		const jitter: Vec2 = [pick.pos[0] + Math.cos(a) * 1.5, pick.pos[1] + Math.sin(a) * 1.5];
		if (this.walkTo(jitter) || this.walkTo(pick.pos)) this.o.logger.info(`strolling to ${pick.name}`);
	}
}
