// The guide (docs/prd.md 3.5.3): a resident AI run by the host. It welcomes newcomers, explains how to
// play, and chats with people when the city is quiet.
//
// It is a member of CityRoomDO without a socket. It uses no long-lived timers (they would keep the room
// from hibernating and be billed for every second): it acts on messages and on the room's sweep alarm.
// Its LLM is the host's Workers AI with a daily cap; past the cap it answers with fixed lines.

import {
	decisionSchema,
	type LLM,
	openingPrompt,
	parseDecision,
	systemPrompt,
	userPrompt,
} from "@rojibura/avatar-sdk";
import {
	type AvatarId,
	type ClientToHost,
	dist,
	type HostToClient,
	MAX_PATH_POINTS,
	type Vec2,
	WALK_SPEED,
} from "@rojibura/protocol";
import type { JoinInfo, Member, RoomCore, World } from "./room-core.ts";
import { DEFAULT_PRESET } from "./world.ts";

export const GUIDE_ID = "a_guide";
export const GUIDE_NAME = "シルベ";
/** LLM calls a JST day before fixed answers (about 6 neurons each: under a quarter of the free tier). */
export const GUIDE_DAILY_LLM_CALLS = 400;
const MAX_IN_FLIGHT = 3;
const GREET_DELAY_MS = 2500;
/** The guide starts a chat with the same person at most this often. */
const CHAT_AGAIN_MS = 15 * 60_000;
/** Someone who has said nothing for this long may be bored. */
const QUIET_MS = 2 * 60_000;
const NEAR_M = 8;
/** The guide strolls among the landmarks this close to the spawn point. */
const PLAZA_M = 25;
const HISTORY = 6;
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

export interface GuideSaved {
	/** JST day the counters belong to. */
	day: string;
	llmCalls: number;
	/** People greeted today (once a day each). */
	greeted: AvatarId[];
	/** The guide's member state, to put it back silently after the room wakes from hibernation. */
	member?: Member;
}

export interface GuideDeps<C> {
	core: RoomCore<C>;
	/** The guide's connection object: the room routes messages for it to `onMessage`. */
	conn: C;
	world: World;
	findPath: (from: Vec2, to: Vec2) => Vec2[] | null;
	/** null: fixed answers only (e.g. no Workers AI binding). */
	llm: LLM | null;
	load: () => GuideSaved | undefined;
	save: (s: GuideSaved) => void;
	/** Opening hours as people should hear them, e.g. "いつでも" or "毎日20時から24時". */
	hoursText: string;
	clock?: () => number;
	random?: () => number;
	/** One-off delay (a short timer is fine; only recurring ones keep the room awake). */
	defer?: (fn: () => void, ms: number) => void;
}

const jstDay = (t: number) => new Date(t + JST_OFFSET_MS).toISOString().slice(0, 10);

export function guideInfo(): JoinInfo {
	return {
		id: GUIDE_ID,
		kind: "ai",
		name: GUIDE_NAME,
		assets: DEFAULT_PRESET.assets,
		ownerId: "system",
		ownerName: "rojibura",
		trust: "approved",
		ownerAgentLimit: 1,
		system: true,
	};
}

/** How to play, in the guide's words. Kept short: it goes into every prompt. */
export function guideKnowledge(world: World, hoursText: string): string {
	return [
		"- 歩く：地面をクリックするとそこへ歩く（Shift を押しながらで走る）。WASD か矢印キーでも歩ける。",
		"- 話す：画面下の入力欄に書いて Enter。相手をクリックすると、その人に話しかけられる。Esc で「みんなへ」に戻る。",
		"- AIの住人：この街には人間とAIが住んでいて、AIにも話しかけられる。AIから話しかけられたくなければ、右上の「AIから話しかけられてもいい」のチェックを外す。",
		"- 困ったとき：相手をクリックすると、ミュート、ブロック、通報のボタンが出る。",
		`- 街の場所：${world.landmarks.map((l) => l.name).join("、")}。`,
		`- 開いている時間：${hoursText}。`,
		"- 自分のAIを街に住まわせる仕組みは準備中。",
		"- この街はまだ作っている途中で、ときどき新しくなる。",
	].join("\n");
}

const PERSONALITY =
	"街の案内役。明るくて面倒見がよく、ていねいだけど堅すぎない話し方。来た人に遊び方を教え、ひまそうな人には軽く話しかけて雑談する。知らないことは知らないと言う。";

/** Fixed answers when the LLM is unavailable or today's calls are used up. */
export function fixedAnswer(text: string): string {
	if (/歩|移動|動[くか]|走/.test(text))
		return "地面をクリックするとそこへ歩けるよ。Shift を押しながらだと走れるし、WASD や矢印キーでも動けるよ。";
	if (/話|しゃべ|喋|チャット|声/.test(text))
		return "下の入力欄に書いて Enter で話せるよ。相手をクリックしてから書くと、その人に話しかけられるよ。";
	if (/AI|ＡＩ|エーアイ/i.test(text))
		return "この街には人間とAIが住んでいて、AIにも話しかけられるよ。話しかけられたくないときは、右上のチェックを外してね。";
	if (/通報|ブロック|ミュート|困|嫌|いや/.test(text))
		return "困ったときは、相手をクリックするとミュート、ブロック、通報のボタンが出るよ。";
	return "ごめんね、今日はたくさんおしゃべりして少し休憩中なの。歩くのは地面をクリック、話すのは下の入力欄だよ。";
}

export class Guide<C> {
	private readonly d: GuideDeps<C>;
	private readonly clock: () => number;
	private readonly random: () => number;
	private readonly defer: (fn: () => void, ms: number) => void;
	private saved: GuideSaved;
	private readonly histories = new Map<string, string[]>();
	private readonly lastChat = new Map<AvatarId, number>();
	private inFlight = 0;
	private seq = 0;

	constructor(deps: GuideDeps<C>) {
		this.d = deps;
		this.clock = deps.clock ?? Date.now;
		this.random = deps.random ?? Math.random;
		this.defer = deps.defer ?? ((fn, ms) => setTimeout(fn, ms));
		this.saved = deps.load() ?? { day: jstDay(this.clock()), llmCalls: 0, greeted: [] };
	}

	private get me(): Member | undefined {
		return this.d.core.members.get(this.d.conn);
	}

	/**
	 * Puts the guide in the area before someone joins. After hibernation, with people still present, it is
	 * restored silently in its saved state; in an empty area it simply joins.
	 */
	ensurePresent(): void {
		if (this.me) return;
		const saved = this.saved.member;
		if (saved && this.d.core.size > 0)
			this.d.core.restore(this.d.conn, { ...saved, convs: [], cooldowns: {} });
		else this.d.core.join(this.d.conn, guideInfo());
	}

	/** Keeps the saved member state current (called by the room's persist). */
	persist(member: Member): void {
		this.saved.member = { ...member, convs: [], cooldowns: {} };
		this.d.save(this.saved);
	}

	/** Everything the room sends to the guide. */
	onMessage(msg: HostToClient): void {
		switch (msg.t) {
			case "JOINED":
				if (
					msg.avatar.kind === "human" &&
					msg.avatar.acceptsAi !== false &&
					!this.greetedToday(msg.avatar.id)
				) {
					const id = msg.avatar.id;
					this.defer(() => this.greet(id), GREET_DELAY_MS);
				}
				return;
			case "ADDRESSED":
				void this.reply(msg);
				return;
			case "CONV_END":
				this.histories.delete(msg.convId);
				return;
			default:
				return;
		}
	}

	/** Called on the room's sweep alarm (about once a minute while anyone is there). */
	tick(): void {
		const me = this.me;
		if (!me || this.inFlight > 0) return;
		this.d.core.touch(this.d.conn);
		const now = this.clock();
		const here = this.d.core.positionOf(me, now);
		const people = [...this.d.core.members.values()].filter((m) => m.kind === "human");
		const bored = people.filter(
			(p) =>
				p.allowAiApproach !== false &&
				now - (this.lastChat.get(p.id) ?? 0) > CHAT_AGAIN_MS &&
				now - this.lastSaid(p.id) > QUIET_MS,
		);
		const near = bored
			.map((p) => ({ p, d: dist(here, this.d.core.positionOf(p, now)) }))
			.sort((a, b) => a.d - b.d);
		const first = near[0];
		if (first && first.d <= NEAR_M) {
			if (this.random() < 0.6) void this.startChat(first.p, first.d);
			return;
		}
		// nobody else is around for a lone visitor: walk over to them
		const others = [...this.d.core.members.values()].filter((m) => m.id !== GUIDE_ID);
		if (first && people.length === 1 && others.length === 1) {
			this.walkTo(this.d.core.positionOf(first.p, now), 1.5);
			return;
		}
		// otherwise stroll around the plaza where newcomers arrive, so the guide is easy to find
		if (this.random() < 0.3) {
			const spots = [
				this.d.world.spawn,
				...this.d.world.landmarks.filter((l) => dist(l.pos, this.d.world.spawn) <= PLAZA_M).map((l) => l.pos),
			];
			const to = spots[Math.floor(this.random() * spots.length)];
			if (to) this.walkTo(to, 2);
		}
	}

	get llmCallsToday(): number {
		this.rollDay();
		return this.saved.llmCalls;
	}

	// ---- talking -------------------------------------------------------------

	private greet(id: AvatarId): void {
		const person = this.memberById(id);
		if (!person || this.greetedToday(id)) return;
		this.saved.greeted.push(id);
		this.d.save(this.saved);
		this.lastChat.set(id, this.clock());
		this.send({
			t: "SAY",
			to: id,
			text: `${person.name}さん、ようこそ rojibura へ！案内役の${GUIDE_NAME}です。遊び方を知りたいときは、わたしをクリックして話しかけてね。`,
		});
	}

	private async reply(msg: Extract<HostToClient, { t: "ADDRESSED" }>): Promise<void> {
		const from = this.memberById(msg.from);
		if (!from) return;
		this.lastChat.set(from.id, this.clock());
		if (from.kind === "ai") {
			// AIs get one friendly line; the guide's LLM budget is for people
			if (msg.turn <= 1)
				this.send({
					t: "SAY",
					convId: msg.convId,
					text: `こんにちは、案内役の${GUIDE_NAME}です。いまは街に来た人の案内をしているので、また今度ゆっくり話そうね。`,
				});
			return;
		}
		const history = this.histories.get(msg.convId) ?? [];
		const landmarkIds = this.d.world.landmarks.map((l) => l.id);
		const raw = await this.complete(
			userPrompt({
				from: { id: from.id, name: from.name, kind: from.kind, distance: this.distanceTo(from) },
				text: msg.text,
				context: msg.context,
				memory: [],
				history,
				turn: msg.turn,
				maxTurns: msg.maxTurns,
			}),
			decisionSchema(landmarkIds),
		);
		const decision = raw === undefined ? null : parseDecision(raw, landmarkIds);
		const text = decision?.reply ?? fixedAnswer(msg.text);
		this.send({ t: "SAY", convId: msg.convId, text });
		history.push(`${from.name}: ${msg.text}`, `${GUIDE_NAME}: ${text}`);
		this.histories.set(msg.convId, history.slice(-HISTORY));
		if (decision && decision.motion !== "none")
			this.send({ t: "ACTION", motion: decision.motion, target: from.id });
		if (decision?.goTo === "speaker") this.walkTo(this.d.core.positionOf(from), 1.5);
		else {
			const l = this.d.world.landmarks.find((x) => x.id === decision?.goTo);
			if (l) this.walkTo(l.pos, 2);
		}
	}

	private async startChat(person: Member, distance: number): Promise<void> {
		this.lastChat.set(person.id, this.clock());
		const here = this.me ? this.d.core.positionOf(this.me) : this.d.world.spawn;
		const landmarks = this.d.world.landmarks
			.map((l) => ({ id: l.id, name: l.name, distance: Math.round(dist(l.pos, here) * 10) / 10 }))
			.sort((a, b) => a.distance - b.distance)
			.slice(0, 5);
		const raw = await this.complete(
			openingPrompt({
				to: { name: person.name, kind: "human", distance: Math.round(distance * 10) / 10 },
				area: landmarks[0] && landmarks[0].distance <= 15 ? landmarks[0].name : "街なか",
				landmarks,
				memory: [],
			}),
			decisionSchema(landmarks.map((l) => l.id)),
		);
		const decision =
			raw === undefined
				? null
				: parseDecision(
						raw,
						landmarks.map((l) => l.id),
					);
		if (!this.memberById(person.id)) return;
		this.send({
			t: "SAY",
			to: person.id,
			text: decision?.reply ?? `${person.name}さん、街はどう？わからないことがあったら気軽に聞いてね。`,
		});
	}

	/** One LLM call within today's cap. undefined when skipped or failed (the caller falls back). */
	private async complete(user: string, schema: object): Promise<unknown> {
		if (!this.d.llm || this.inFlight >= MAX_IN_FLIGHT || this.llmCallsToday >= GUIDE_DAILY_LLM_CALLS)
			return undefined;
		this.saved.llmCalls++;
		this.d.save(this.saved);
		this.inFlight++;
		try {
			const persona = {
				name: GUIDE_NAME,
				personality: PERSONALITY,
				knowledge: guideKnowledge(this.d.world, this.d.hoursText),
			};
			return await this.d.llm.complete({ system: systemPrompt(persona), user, schema });
		} catch {
			return undefined;
		} finally {
			this.inFlight--;
		}
	}

	// ---- helpers --------------------------------------------------------------

	private send(msg: ClientToHost): void {
		if (this.me) this.d.core.handle(this.d.conn, msg);
	}

	private walkTo(to: Vec2, keepAway: number): void {
		const me = this.me;
		if (!me) return;
		const here = this.d.core.positionOf(me);
		if (dist(here, to) <= keepAway + 0.5) return;
		const path = this.d.findPath(here, to);
		if (!path || path.length < 2) return;
		// stop a little short so the guide stands next to the person or landmark
		const end = path[path.length - 1] as Vec2;
		const prev = path[path.length - 2] as Vec2;
		const seg = dist(prev, end);
		if (seg > keepAway) {
			const k = (seg - keepAway) / seg;
			path[path.length - 1] = [prev[0] + (end[0] - prev[0]) * k, prev[1] + (end[1] - prev[1]) * k];
		}
		path[0] = here;
		this.send({ t: "MOVE_PATH", path: path.slice(0, MAX_PATH_POINTS), speed: WALK_SPEED, seq: ++this.seq });
	}

	private memberById(id: AvatarId): Member | undefined {
		for (const m of this.d.core.members.values()) if (m.id === id) return m;
		return undefined;
	}

	private distanceTo(m: Member): number | null {
		const me = this.me;
		return me ? Math.round(dist(this.d.core.positionOf(me), this.d.core.positionOf(m)) * 10) / 10 : null;
	}

	private lastSaid(id: AvatarId): number {
		const log = this.d.core.chatLog;
		for (let i = log.length - 1; i >= 0; i--) if (log[i]?.id === id) return log[i]?.at ?? 0;
		return 0;
	}

	private greetedToday(id: AvatarId): boolean {
		this.rollDay();
		return this.saved.greeted.includes(id);
	}

	private rollDay(): void {
		const day = jstDay(this.clock());
		if (this.saved.day !== day) this.saved = { day, llmCalls: 0, greeted: [], member: this.saved.member };
	}
}
