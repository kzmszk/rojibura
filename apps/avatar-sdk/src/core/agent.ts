// The agent's mind: rule-based wandering plus LLM replies (docs/prd.md 3.5.2).
// Independent of the runtime; adapters provide the LLM, memory, navigation and the connection.

import {
	ACTIVITY_REACH,
	type Activity,
	type AvatarId,
	type AvatarState,
	activityOpen,
	type BudgetLevel,
	type ClientToHost,
	cannotStart,
	cityTime,
	clockText,
	dist,
	energyWord,
	type Food,
	type HostToClient,
	HUNGRY,
	insidePolygon,
	type JobKind,
	type JobZone,
	LEAD_MIN_DISTANCE,
	LEAD_PLACE_MAX,
	LEAD_TEXT_MAX,
	pathLeg,
	poseAt,
	SHOP_REACH,
	type Shop,
	type SpatialContext,
	type Vec2,
	WALK_SPEED,
} from "@rojibura/protocol";
import { type DiaryPage, diaryMessages, jstDate } from "./journal.ts";
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
import { Stroll } from "./stroll.ts";
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
	/** What can be done in the area (docs/life.md 3): with it, it eats, works and plays by what it needs. */
	activities?: Activity[];
	/** The area's shops, what their food does, and where one works or studies (docs/prd.md 3.8.6). */
	shops?: Shop[];
	foods?: Record<string, Food>;
	jobZones?: JobZone[];
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
/**
 * Walking with its owner (docs/prd.md 3.4.10): ask them along to a place this far off, at most this often,
 * less often after a no, and now and then rather than at every chance.
 */
const LEAD_FAR = 15;
const LEAD_AGAIN_MS = 3 * 60_000;
const LEAD_AFTER_NO_MS = 6 * 60_000;
const LEAD_CHANCE = 0.35;
/** The memory key of its notes on itself: one line per day lived (docs/life.md 5.3). */
const SELF = "self";
/** Days before today shown with its replies. */
const DAYS_SHOWN = 2;
/** Fewer coins than this, and it works more. */
const POOR = 30;

/** Where it is walking to (`to`, a leg at a time: `legs` so far), and what for. */
type Errand = (
	| { kind: "act"; id: string }
	| { kind: "buy"; shop: string; goods: string }
	| { kind: "job"; job: JobKind; zone: string }
) & { to?: Vec2; legs?: number };
/** Legs of a long way before it gives up (one leg is up to MAX_PATH_LENGTH m). */
const MAX_LEGS = 8;

/** The area's life, for an agent that moved to another area. */
export type AreaLife = Pick<AgentOptions, "activities" | "shops" | "foods" | "jobZones">;
const LEAD_LINES = [
	"{place}に行ってみたいな。いっしょに来る？",
	"ねえ、{place}のほうに行ってみない？",
	"{place}まで歩こうよ。",
];

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
	/** When it last asked its owner along, and when they last said no (Date.now). */
	private leadAskedAt = 0;
	private leadNoAt = 0;
	private seq = 0;
	/** What it did today ("07:30 原っぱで体操"), and where it is walking to. */
	private doneToday: string[] = [];
	private going: Errand | null = null;
	private readonly o: AgentOptions;

	/** In another area now (following its owner, docs/prd.md 3.8.2): its places and walkable ground. */
	setCity(nav: Navigator, landmarks: Landmark[], life: AreaLife = {}): void {
		this.o.nav = nav;
		this.o.landmarks = landmarks;
		this.o.activities = life.activities ?? [];
		this.o.shops = life.shops ?? [];
		this.o.foods = life.foods ?? {};
		this.o.jobZones = life.jobZones ?? [];
		this.going = null;
	}
	private readonly random: () => number;

	/** Standing about with its owner: a step now and then (docs/prd.md 3.4.9). */
	private readonly stroll: Stroll;

	constructor(opts: AgentOptions) {
		this.o = opts;
		this.random = opts.random ?? Math.random;
		this.stroll = new Stroll({
			world: this.world,
			nav: () => this.o.nav,
			send: (m) => this.o.send(m),
			seq: () => ++this.seq,
			busy: () => this.busy || this.convs.size > 0 || this.going !== null,
			random: this.random,
		});
	}

	get id(): AvatarId | null {
		return this.world.me;
	}

	stop(): void {
		if (this.wanderTimer) clearTimeout(this.wanderTimer);
		this.wanderTimer = null;
		this.stroll.stop();
	}

	/** Host time estimated from WELCOME.serverTime. */
	hostNow(): number {
		return this.world.hostNow();
	}

	positionOf(id: AvatarId): Vec2 | null {
		return this.world.positionOf(id);
	}

	handle(msg: HostToClient): void {
		const applied = this.world.apply(msg);
		// walking with its owner the host moves it: an errand it was on is over
		if (msg.t === "COMPANY" && msg.on) this.going = null;
		this.stroll.sync();
		if (applied) {
			if (msg.t === "WELCOME") {
				this.o.logger.info(
					`${msg.resumed ? "back" : "joined"} as ${msg.you}; ${msg.avatars.length} avatars here`,
				);
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
			case "LEAD_ANSWERED": {
				const owner = this.world.avatars.get(msg.by)?.name ?? "オーナー";
				if (!msg.accept) {
					this.leadNoAt = Date.now();
					this.o.logger.info(`${owner} would rather not go to ${msg.place}`);
					return;
				}
				this.o.logger.info(`taking ${owner} to ${msg.place}`);
				void this.o.memory.remember(msg.by, `いっしょに${msg.place}へ行った`);
				// nothing else to do on the way
				this.scheduleWander(Math.max(0, (msg.at ?? this.hostNow()) - this.hostNow()) + 20_000);
				return;
			}
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
				// refused (closed, full, too far...): it thinks again; a reply sent too soon is nothing to do with it
				if (msg.kind === "rejected") this.going = null;
				return;
			case "ITEM": {
				// what it bought to eat: it eats it
				const g = msg.item.goods;
				if (g?.food && msg.item.holder === this.world.me && this.world.life)
					setTimeout(() => this.o.send({ t: "USE" }), 1500);
				return;
			}
			case "ACT_DONE": {
				const a = this.o.activities?.find((x) => x.id === msg.activity);
				if (msg.share >= 0.5)
					this.doneToday.push(
						`${clockText(cityTime(this.hostNow()).minutes)} ${a?.name ?? msg.name ?? msg.activity}`,
					);
				this.o.logger.info(`done ${msg.activity} (${Math.round(msg.share * 100)}%)`);
				this.scheduleWander(3000);
				return;
			}
			case "DAY":
				// the day that ended becomes one line of its notes on itself, kept across runs
				if (this.doneToday.length > 0)
					void this.o.memory.remember(SELF, `${msg.review.day}日目: ${this.doneToday.join("、")}`);
				this.doneToday = [];
				return;
			case "DIARY_ASK":
				void this.showDiary(msg.from, msg.day);
				return;
			default:
				return;
		}
	}

	/**
	 * Its owner reads its diary (docs/life.md 8). It keeps no diary of its own: today is what it did, and its
	 * notes on the days before stand for the long-term memory.
	 */
	private async showDiary(owner: AvatarId, day: string | undefined): Promise<void> {
		const today = jstDate();
		const page: DiaryPage = { day: day ?? today, text: "", days: [today] };
		if (day === "life") page.text = (await this.o.memory.recall(SELF).catch(() => [])).join("\n");
		else if (page.day === today) page.text = this.doneToday.map((d) => `- ${d}`).join("\n");
		for (const m of diaryMessages(owner, page)) this.o.send(m);
	}

	/** Its own day in words, for its replies: the time, how it feels, today and the days before. */
	private async today(): Promise<string[] | undefined> {
		const life = this.world.lifeNow();
		if (!life) return undefined;
		const before = (await this.o.memory.recall(SELF).catch(() => [])).slice(-DAYS_SHOWN);
		return [
			`街の時刻: ${clockText(cityTime(this.hostNow()).minutes)}（暮らして${life.days}日目）。自分の調子: ${energyWord(life.energy)}${this.world.coins !== null ? `、財布 ${this.world.coins}銅貨` : ""}`,
			`今日したこと: ${this.doneToday.join("、") || "まだ特になし"}`,
			...(before.length > 0 ? [`前の日にしたこと: ${before.join(" / ")}`] : []),
		];
	}

	/**
	 * Its life (docs/life.md 5.3), by what it needs most: food from a shop when hungry or at mealtimes, work or
	 * study once a day (and when short of coins), exercise every other day, now and then something to enjoy.
	 * Walks there first. True if it is busy with that.
	 */
	private live(here: Vec2): boolean {
		const life = this.world.lifeNow();
		if (!life) return false;
		const t = cityTime(this.hostNow());
		const coins = this.world.coins;
		// arrived where it was going
		const going = this.going;
		this.going = null;
		if (going && this.arrive(going, here)) return true;
		// a long way: on with the next leg
		if (
			going?.to &&
			(going.legs ?? 0) < MAX_LEGS &&
			dist(here, going.to) > 1.5 &&
			this.goFor(going, going.to, "on")
		)
			return true;
		// working or studying: on until the day's work is done and the wallet is fine, or it gets hungry
		const job = this.world.self?.job;
		if (job) {
			const enough = life.duties.work && (coins === null || coins >= POOR);
			if (!enough && life.energy >= HUNGRY + 5 && !t.night) return true;
			this.o.send({ t: "JOB", kind: null });
			this.o.logger.info(`stops ${job === "work" ? "working" : "studying"}`);
			return true;
		}
		if (t.night) return false;
		const want = this.wantsFood();
		if (want && this.goEat(here, want.anything)) return true;
		if (
			life.energy >= 30 &&
			(!life.duties.work || (coins !== null && coins < POOR)) &&
			t.minutes >= 8 * 60 &&
			this.goWork(here)
		)
			return true;
		const acts = (this.o.activities ?? []).filter(
			(a) =>
				activityOpen(a, t.minutes) &&
				!cannotStart(life, a) &&
				(coins === null || (a.cost ?? 0) <= coins) &&
				this.placeOf(a),
		);
		const one = (...kinds: Activity["kind"][]) => {
			const can = acts.filter((a) => kinds.includes(a.kind));
			return can[Math.floor(this.random() * can.length)];
		};
		let a: Activity | undefined;
		if (!life.duties.exercise && life.days - life.exercisedDay >= 1 && life.energy >= 35) a = one("exercise");
		if (!a && this.random() < 0.25) a = one("play", "rest");
		return a ? this.goDo(a, here) : false;
	}

	private placeOf(a: Activity): Landmark | undefined {
		return this.o.landmarks.find((l) => l.id === a.place);
	}

	/** There: does what it went for. False if it is not there after all. */
	private arrive(e: Errand, here: Vec2): boolean {
		if (e.kind === "act") {
			const a = this.o.activities?.find((x) => x.id === e.id);
			const place = a ? this.placeOf(a) : undefined;
			if (!a || !place || dist(here, place.pos) > ACTIVITY_REACH - 0.5) return false;
			this.o.send({ t: "ACT", activity: a.id });
			this.o.logger.info(`doing ${a.id}`);
			return true;
		}
		if (e.kind === "buy") {
			const shop = this.o.shops?.find((s) => s.id === e.shop);
			if (!shop || dist(here, shop.counter) > SHOP_REACH - 0.5) return false;
			this.o.send({ t: "BUY", shop: shop.id, goods: e.goods });
			this.o.logger.info(`buying ${e.goods} at ${shop.name}`);
			return true;
		}
		const zone = this.o.jobZones?.find((z) => z.id === e.zone);
		if (!zone || !insidePolygon(here, zone.poly)) return false;
		this.o.send({ t: "JOB", kind: e.job });
		this.o.logger.info(`${e.job === "work" ? "working" : "studying"} at ${zone.name}`);
		return true;
	}

	/** Walks to `to` for an errand, and looks again about when it is there. */
	private goFor(e: Errand, to: Vec2, what: string): boolean {
		const from = this.world.me ? this.positionOf(this.world.me) : null;
		if (!this.walkTo(to)) return false;
		this.going = { ...e, to, legs: (e.legs ?? 0) + 1 };
		this.o.logger.info(`going ${what}`);
		const eta = from ? (dist(from, to) / WALK_SPEED) * 1000 : 10_000;
		this.scheduleWander(eta * 1.4 + 2000);
		return true;
	}

	private goDo(a: Activity, here: Vec2): boolean {
		const place = this.placeOf(a);
		if (!place) return false;
		const e: Errand = { kind: "act", id: a.id };
		if (dist(here, place.pos) <= ACTIVITY_REACH - 0.5) return this.arrive(e, here);
		const angle = this.random() * Math.PI * 2;
		const near: Vec2 = [place.pos[0] + Math.cos(angle) * 1.2, place.pos[1] + Math.sin(angle) * 1.2];
		const what = `to ${place.name} for ${a.name}`;
		return this.goFor(e, near, what) || this.goFor(e, place.pos, what);
	}

	/** Whether it would eat now: hungry, or a mealtime it has not eaten at. */
	private wantsFood(): { anything: boolean } | null {
		const life = this.world.lifeNow();
		const t = cityTime(this.hostNow());
		if (!life || t.night) return null;
		const mealtime =
			(life.duties.meals < 1 && t.minutes >= 7 * 60) || (life.duties.meals < 2 && t.minutes >= 18 * 60);
		return life.energy < 45 || (mealtime && life.energy < 90) ? { anything: life.energy < HUNGRY } : null;
	}

	/** Food it can pay for: the meals, or anything when very hungry. */
	private foodChoice(anything: boolean): { s: Shop; g: Shop["goods"][number] }[] {
		const coins = this.world.coins;
		const food = (this.o.shops ?? []).flatMap((s) =>
			s.goods
				.filter((g) => g.food && (coins === null || g.price <= coins))
				.map((g) => ({ s, g, meal: this.o.foods?.[g.id]?.meal === true })),
		);
		const meals = food.filter((f) => f.meal);
		return meals.length > 0 ? meals : anything ? food : [];
	}

	/** To a shop for something to eat it can pay for: a meal, or anything when very hungry. */
	private goEat(here: Vec2, anything: boolean): boolean {
		const choice = this.foodChoice(anything);
		const pick = choice[Math.floor(this.random() * choice.length)];
		if (!pick) return false;
		const e: Errand = { kind: "buy", shop: pick.s.id, goods: pick.g.id };
		if (dist(here, pick.s.counter) <= SHOP_REACH - 0.5) return this.arrive(e, here);
		return this.goFor(e, pick.s.counter, `to ${pick.s.name} for ${pick.g.name}`);
	}

	/**
	 * Walking with its owner, hungry: at a shop's counter it buys (and eats once it is in its hand); otherwise
	 * it asks them along to the nearest shop with food (LEAD), and buys when it has taken them there.
	 */
	private eatAlong(here: Vec2): boolean {
		const want = this.wantsFood();
		if (!want) return false;
		const choice = this.foodChoice(want.anything);
		const at = choice.filter((f) => dist(here, f.s.counter) <= SHOP_REACH - 0.5);
		const pick = at[Math.floor(this.random() * at.length)];
		if (pick) return this.arrive({ kind: "buy", shop: pick.s.id, goods: pick.g.id }, here);
		const near = choice
			.map((f) => ({ ...f, d: dist(here, f.s.counter) }))
			.filter((f) => f.d >= LEAD_MIN_DISTANCE)
			.sort((a, b) => a.d - b.d)[0];
		if (!near) return false;
		return this.lead(
			{ id: near.s.id, name: near.s.name, pos: near.s.counter },
			`おなかがすいた。${near.s.name}に寄ってもいい？`,
		);
	}

	/** To a place to work or study (the middle of it). */
	private goWork(here: Vec2): boolean {
		const zones = this.o.jobZones ?? [];
		const zone = zones[Math.floor(this.random() * zones.length)];
		if (!zone) return false;
		const e: Errand = { kind: "job", job: zone.kind, zone: zone.id };
		if (insidePolygon(here, zone.poly)) return this.arrive(e, here);
		const n = zone.poly.length;
		const mid: Vec2 = [
			zone.poly.reduce((s, p) => s + p[0], 0) / n,
			zone.poly.reduce((s, p) => s + p[1], 0) / n,
		];
		return this.goFor(e, mid, `to ${zone.name} to ${zone.kind}`);
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
					today: await this.today(),
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
		// walking with its owner the host moves it: a place is something to ask the owner along to
		if (this.world.company) {
			const place = this.o.landmarks.find((l) => l.id === target);
			if (place) this.lead(place, false);
			return;
		}
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
					today: await this.today(),
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

	/**
	 * Asks the owner it walks with to come along to `place` (docs/prd.md 3.4.10), with a line of its own
	 * (`say`: true for one of LEAD_LINES, or the line; after a reply that already said it, none). Not again
	 * soon, and not soon after a no. True if it asked.
	 */
	private lead(place: Landmark, say: boolean | string): boolean {
		const now = Date.now();
		if (now - this.leadAskedAt < LEAD_AGAIN_MS || now - this.leadNoAt < LEAD_AFTER_NO_MS) return false;
		this.leadAskedAt = now;
		const name = [...place.name].slice(0, LEAD_PLACE_MAX).join("");
		const line =
			typeof say === "string"
				? say
				: (LEAD_LINES[Math.floor(this.random() * LEAD_LINES.length)] ?? "{place}に行きたいな。").replace(
						"{place}",
						name,
					);
		this.o.send({
			t: "LEAD",
			to: place.pos,
			place: name,
			...(say ? { text: [...line].slice(0, LEAD_TEXT_MAX).join("") } : {}),
		});
		this.o.logger.info(`asking the owner along to ${place.name}`);
		return true;
	}

	walkTo(to: Vec2): boolean {
		const from = this.world.me ? this.positionOf(this.world.me) : null;
		if (!from) return false;
		const path = this.o.nav.findPath(from, to);
		if (!path || path.length < 2) return false;
		// as far as one MOVE_PATH goes: a long way is walked a leg at a time (live)
		this.o.send({ t: "MOVE_PATH", path: pathLeg(path), speed: WALK_SPEED, seq: ++this.seq });
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
		// busy with something: it carries on (talking still happens when spoken to)
		if (me.doing && !this.world.company) return;
		if (!this.world.company && this.live(here)) return;

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
		// walking with its owner: no strolling off alone, but it eats, and now and then it would like to go somewhere
		if (this.world.company) {
			if (this.eatAlong(here)) return;
			const options = this.o.landmarks.filter((l) => dist(l.pos, here) > LEAD_FAR);
			const pick = options[Math.floor(this.random() * options.length)];
			if (pick && this.random() < LEAD_CHANCE) this.lead(pick, true);
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
