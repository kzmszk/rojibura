// CityRoomDO: one area of the city (docs/prd.md 3.3). Owns the sockets, hibernation, heartbeats,
// agent challenge-response and alarms; the area logic lives in RoomCore.

import { DurableObject } from "cloudflare:workers";
import { type LLM, WorkersAiLLM } from "@rojibura/avatar-sdk";
import {
	AUTH_TIMEOUT_MS,
	authPayload,
	type Build,
	type ClientToHost,
	encode,
	HEARTBEAT_PING,
	HEARTBEAT_PONG,
	type HostToClient,
	type Item,
	type ModelId,
	parseClientMessage,
	parseTravelReason,
	randomToken,
	verifyAuth,
} from "@rojibura/protocol";
import { addToWallet, relationsOf, saveLife, walletOf } from "./db.ts";
import { GUIDE_NAME, Guide, type GuideSaved } from "./guide.ts";
import { GuideMemory, type Kv } from "./guide-memory.ts";
import { CLOSING_NOTICE_MS, closingTime, describeHours, type Hours, isOpen, parseHours } from "./hours.ts";
import { freePlayOn } from "./modes.ts";
import { ModelRegistry } from "./registered-models.ts";
import { CLOSE_CLOSING, CLOSE_POLICY, RoomCore } from "./room-core.ts";
import type { ChatLine, JoinInfo, Member, World } from "./room-types.ts";
import { FREE_PLAY_RULES, PRODUCTION_RULES } from "./rules.ts";
import { meteredD1, type SavedUsage, UsageMeter } from "./usage.ts";
import { freePlayWorld, MAIN_AREA, PUBLISHED, worldOf } from "./world.ts";

/** The guide's connection: the room routes its messages to the Guide instead of a socket. */
const GUIDE_CONN = { guide: true } as const;
type Conn = WebSocket | typeof GUIDE_CONN;
const isGuide = (c: Conn): c is typeof GUIDE_CONN => c === GUIDE_CONN;

/** What the gateway sends with the upgrade request (trusted: the DO is only reachable through it). */
export interface JoinRequest {
	areaId: string;
	info: JoinInfo;
	/** Arriving through a portal: the landmark or portal of this area to appear at (docs/prd.md 3.8). */
	arrive?: string;
	/** Agents only: registered public key to verify the challenge with. */
	publicKey?: string;
	/** Agents paired with their owner's PC: its key, which lets them in too (docs/prd.md 3.5.1). */
	pcKey?: string;
}

interface Attachment {
	member?: Member;
	pending?: {
		info: JoinInfo;
		publicKey: string;
		pcKey?: string;
		nonce: string;
		areaId: string;
		at: number;
		arrive?: string;
	};
}

const SWEEP_INTERVAL_MS = 60_000;
/** Usage is pushed to watchers at most this often. */
const USAGE_PUSH_MS = 1000;
/** An incoming WebSocket message is billed as 1/20 of a request. */
const WS_MESSAGE = 1 / 20;

const MESSAGE_LABELS: Record<ClientToHost["t"], string> = {
	AUTH: "AIの認証",
	MOVE_PATH: "移動",
	MOVE_VEL: "移動（キー）",
	ACTION: "動作",
	SAY: "発言",
	STATUS: "状態の変更",
	INTEREST: "購読範囲の変更",
	WATCH_USAGE: "利用状況の表示",
	BUILD: "建築",
	UNBUILD: "建物を消す",
	OFFER: "握手・ハグの申し込み",
	ANSWER: "握手・ハグ・誘いの返事",
	PICK: "物を拾う",
	THROW: "物を投げる",
	DROP: "物を置く",
	BUY: "お店で買う",
	USE: "食べる・飲む",
	JOB: "働く・勉強する",
	COMPANION: "自分のAIを連れて歩く",
	LEAD: "AIがオーナーを連れて行く",
	BODY: "AIが体を動かす",
	ACT: "活動を始める",
	ACT_STOP: "活動をやめる",
	DIARY_ASK: "AIの日記を読む",
	DIARY: "AIが日記を見せる",
	FLY: "空に浮かぶ",
	WARP: "瞬間移動",
};
const CHAT_KEEP_MS = 24 * 60 * 60 * 1000;

/** Internal requests from the gateway (moderation and relations, docs/prd.md 4.2). */
export type RoomCommand =
	| { op: "relation"; accountId: string; targetId: string; kind: "mute" | "block"; on: boolean }
	/** `message`: what the one leaving is told, when it is not the moderators' doing. */
	| { op: "kick"; id: string; message?: string }
	| { op: "mute"; id: string; until: number }
	| { op: "excerpt"; id: string; minutes: number }
	/** Free play, development: take down everything built. */
	| { op: "clear_builds"; by: string }
	/** Free play, development: everything built (`pnpm builds:publish` reads it). */
	| { op: "list_builds" };

export class CityRoomDO extends DurableObject<Env> {
	private readonly core: RoomCore<Conn>;
	private readonly guide: Guide<Conn>;
	private readonly guideMemory: GuideMemory;
	private flushed = { inbound: 0, connects: 0, says: 0, rejectedMoves: 0 };
	/** When the alarm last wrote the stats, the chat and the usage (ms). */
	private wroteAt = 0;
	private noticeSentFor = 0;
	private chatFlushedAt = 0;
	private readonly hours: Hours;
	/** When this instance was created: a later value than the last activity means it hibernated. */
	private readonly startedAt = Date.now();
	/** What this area spends of the free tier (docs/prd.md 2.5). */
	private readonly meter: UsageMeter;
	private readonly db: D1Database;
	private pushTimer: ReturnType<typeof setTimeout> | null = null;
	/** Free play (docs/prd.md 3.7): building, registered models, and no free-tier limits. */
	private readonly freePlay: boolean;
	private readonly models = new ModelRegistry((query, ...params) => this.sql(query, ...params));

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		const freePlay = freePlayOn(env);
		this.freePlay = freePlay;
		// which area this is: the gateway gets it by name (/ws/area/<id>, docs/prd.md 3.8)
		const areaId = ctx.id.name ?? MAIN_AREA;
		const registered = (id: ModelId) => this.models.nav(id);
		const world =
			(freePlay ? freePlayWorld(areaId, registered) : worldOf(areaId)) ?? (worldOf(MAIN_AREA) as World);
		this.hours = freePlay ? "always" : parseHours(env.OPEN_HOURS);
		this.meter = new UsageMeter({
			saved: ctx.storage.kv.get<SavedUsage>("usage"),
			onEvent: () => this.schedulePush(),
		});
		this.db = meteredD1(env.DB, (c) => this.meter.add(c));
		// storage the guide uses: key-value calls are billed as rows read and written
		const kv: Kv = {
			get: <T>(k: string) => {
				this.meter.add({ sqlRowsRead: 1 });
				return ctx.storage.kv.get<T>(k);
			},
			put: (k, v) => {
				this.meter.add({ sqlRowsWritten: 1 });
				ctx.storage.kv.put(k, v);
			},
		};
		this.core = new RoomCore<Conn>(
			{
				send: (c, msg) => (isGuide(c) ? this.guide.onMessage(msg) : safeSend(c, msg)),
				close: (c, code, reason) => {
					if (isGuide(c)) return;
					// the room let it go itself (replaced, kicked, timed out, full): it has left already, so its
					// close is no departure, and it is not restored as a member if the room wakes before it is gone
					forget(c);
					safeClose(c, code, reason);
				},
				persist: (c, member) => (isGuide(c) ? this.guide.persist(member) : persistMember(c, member)),
			},
			world,
			Date.now,
			() => randomToken(9),
			{
				// the small things are saved whenever one changes, so they stay put while the room sleeps
				items: { save: (items) => kv.put("items", items) },
				// an AI's life goes to D1, so it carries over between areas (docs/life.md 7.1)
				life: {
					save: (id, life) =>
						void this.meter.track("暮らしの記録", () =>
							saveLife(this.db, id, life).catch((e) => console.warn(`life ${id}: ${(e as Error).message}`)),
						),
				},
				// each change of a wallet is added to it in D1 as it happens (docs/prd.md 3.8.6)
				wallets: {
					add: (id, delta) =>
						this.ctx.waitUntil(
							addToWallet(this.db, id, delta).catch((e) => console.error(`wallet ${id} ${delta}: ${e}`)),
						),
				},
				...(freePlay
					? {
							rules: FREE_PLAY_RULES,
							store: {
								save: (b) =>
									this.sql("INSERT OR REPLACE INTO builds (id, data) VALUES (?, ?)", b.id, JSON.stringify(b)),
								remove: (id) => this.sql("DELETE FROM builds WHERE id = ?", id),
							},
						}
					: { rules: PRODUCTION_RULES }),
			},
		);
		this.guideMemory = new GuideMemory(kv, GUIDE_NAME);
		this.guide = new Guide<Conn>({
			core: this.core,
			conn: GUIDE_CONN,
			world,
			// the walkable area with whatever has been built (free play)
			findPath: (from, to) => {
				const w = this.core.terrain;
				return w.findPath?.(w.closestPoint(from), w.closestPoint(to)) ?? null;
			},
			llm: env.AI ? this.meteredLlm(new WorkersAiLLM(env.AI)) : null,
			load: () => kv.get<GuideSaved>("guide"),
			save: (s) => kv.put("guide", s),
			memory: this.guideMemory,
			hoursText: describeHours(this.hours),
			track: (label, fn) => this.meter.track(label, fn),
			// the wait before the welcome keeps the room awake too, so it is part of the action
			defer: (fn, ms) =>
				void this.meter.track("シルベのあいさつ", () => new Promise((r) => setTimeout(() => r(fn()), ms))),
		});
		ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(HEARTBEAT_PING, HEARTBEAT_PONG));
		const restored: string[] = [];
		for (const ws of ctx.getWebSockets()) {
			const att = ws.deserializeAttachment() as Attachment | null;
			if (att?.member) {
				this.core.restore(ws, att.member);
				restored.push(att.member.id);
			}
		}
		this.core.loadItems(kv.get<Item[]>("items"));
		// woke from hibernation with people present: put the guide back where it was
		if (this.core.size > 0) this.guide.ensurePresent();
		ctx.blockConcurrencyWhile(async () => {
			ctx.storage.sql.exec(
				"CREATE TABLE IF NOT EXISTS stats (day TEXT PRIMARY KEY, inbound INTEGER NOT NULL DEFAULT 0, connects INTEGER NOT NULL DEFAULT 0, says INTEGER NOT NULL DEFAULT 0, rejected INTEGER NOT NULL DEFAULT 0)",
			);
			// chat for reports, written in batches (one row per flush keeps rows written low)
			ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS chat (at INTEGER NOT NULL, lines TEXT NOT NULL)");
			// mutes and blocks live only in memory; reload them after waking from hibernation
			for (const id of restored) await this.loadRelations(id);
			// free play, where building is possible: production never creates or reads these
			if (freePlay && world.build) this.loadBuilding();
		});
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === "/usage" && request.method === "POST") {
			// what the gateway measured (index.ts): its own events, plus this request
			const events = (await request.json()) as Parameters<UsageMeter["merge"]>[0];
			this.meter.merge(events);
			return this.meter.track("ゲートウェイの報告", () => new Response(null, { status: 204 }), {
				doRequests: 1,
			});
		}
		const join = JSON.parse(request.headers.get("X-RJ-Join") ?? "null") as JoinRequest | null;
		const label =
			url.pathname === "/stats"
				? "統計の参照"
				: url.pathname === "/command"
					? "モデレーション・関係の変更"
					: url.pathname === "/present"
						? "AIがいるかの確認"
						: url.pathname.startsWith("/models")
							? request.method === "POST"
								? "モデルの登録"
								: "モデルの取得"
							: `${join?.info.name ?? "?"}：入場`;
		return this.meter.track(label, () => this.handleFetch(request, url, join), { doRequests: 1 });
	}

	private async handleFetch(request: Request, url: URL, join: JoinRequest | null): Promise<Response> {
		if (url.pathname === "/stats") {
			// development: what the guide remembers about one person (?person=h_...)
			const person = url.searchParams.get("person");
			return Response.json(person ? (this.guideMemory.get(person) ?? null) : this.statsSnapshot());
		}
		if (url.pathname === "/command" && request.method === "POST")
			return Response.json(await this.command((await request.json()) as RoomCommand));
		// which of these AIs are in this area now, and where each runs (its owner's tab or PC, docs/prd.md 3.5.1)
		if (url.pathname === "/present") {
			const present: Record<string, string | null> = {};
			for (const id of (url.searchParams.get("ids") ?? "").split(","))
				if (this.core.has(id)) present[id] = this.core.memberById(id)?.runsOn ?? null;
			return Response.json({ present });
		}
		if (url.pathname === "/models" || url.pathname.startsWith("/models/"))
			return this.freePlay
				? this.models.request(request, url)
				: Response.json({ error: "building is only in free play" }, { status: 403 });
		if (request.headers.get("Upgrade") !== "websocket")
			return new Response("Expected WebSocket", { status: 426 });
		if (!join) return new Response("Bad join", { status: 400 });

		const pair = new WebSocketPair();
		const server = pair[1];
		this.ctx.acceptWebSocket(server, [join.info.kind]);
		if (join.info.kind === "ai") {
			if (!join.publicKey) return new Response("No key", { status: 400 });
			const nonce = randomToken(18);
			server.serializeAttachment({
				pending: {
					info: join.info,
					publicKey: join.publicKey,
					...(join.pcKey ? { pcKey: join.pcKey } : {}),
					nonce,
					areaId: join.areaId,
					at: Date.now(),
					...(join.arrive ? { arrive: join.arrive } : {}),
				},
			} satisfies Attachment);
			safeSend(server, { t: "CHALLENGE", nonce });
		} else {
			await this.loadRelations(join.info.id);
			await this.loadWallet(join.info);
			this.guide.ensurePresent();
			this.core.join(server, join.info, join.arrive);
		}
		await this.scheduleAlarm();
		return new Response(null, { status: 101, webSocket: pair[0] });
	}

	async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
		const att = ws.deserializeAttachment() as Attachment | null;
		const parsed = parseClientMessage(message);
		const who = att?.member?.name ?? att?.pending?.info.name ?? "?";
		const what = parsed.ok ? MESSAGE_LABELS[parsed.msg.t] : "不正なメッセージ";
		return this.meter.track(`${who}：${what}`, () => this.handleMessage(ws, att, parsed), {
			doRequests: WS_MESSAGE,
		});
	}

	private async handleMessage(
		ws: WebSocket,
		att: Attachment | null,
		parsed: ReturnType<typeof parseClientMessage>,
	): Promise<void> {
		if (att?.pending) {
			const p = att.pending;
			const payload = authPayload(p.areaId, p.info.id, p.nonce);
			// the key it was registered with (the browser's), or its owner's PC's
			const sig =
				parsed.ok && parsed.msg.t === "AUTH" && Date.now() - p.at <= AUTH_TIMEOUT_MS ? parsed.msg.sig : null;
			const byOwnKey = sig !== null && (await verifyAuth(p.publicKey, payload, sig));
			const byPc =
				!byOwnKey && sig !== null && p.pcKey !== undefined && (await verifyAuth(p.pcKey, payload, sig));
			if (!byOwnKey && !byPc) {
				safeClose(ws, CLOSE_POLICY, "authentication failed");
				return;
			}
			if (byPc) p.info.runsOn = "pc";
			// the nonce is consumed: the attachment is replaced by the member state
			await this.loadRelations(p.info.id);
			await this.loadWallet(p.info);
			this.guide.ensurePresent();
			this.core.join(ws, p.info, p.arrive);
			return;
		}
		if (!parsed.ok) {
			this.core.touch(ws);
			safeSend(ws, { t: "NOTICE", kind: "rejected", message: parsed.error });
			return;
		}
		this.core.handle(ws, parsed.msg);
		// an AI walking to a seat sits down when it gets there: wake up for that
		if (this.core.wakeAt !== undefined) await this.scheduleAlarm();
		// someone started watching: give them today's totals and the recent actions at once
		if (parsed.msg.t === "WATCH_USAGE" && this.core.memberFor(ws)?.watchUsage)
			safeSend(ws, { t: "USAGE", ...this.meter.snapshot(), events: [...this.meter.recent] });
	}

	async webSocketClose(ws: WebSocket, code: number, reason = ""): Promise<void> {
		const member = attachmentOf(ws)?.member;
		// through a portal: the AIs walking with them come along (docs/prd.md 3.8.2)
		const travel = parseTravelReason(reason);
		const who = this.core.memberFor(ws) ?? member;
		if (travel && who) this.core.travel(who, travel.to, travel.at);
		const name = this.core.memberFor(ws)?.name ?? member?.name ?? "?";
		const dropped = DROPPED.has(code);
		this.meter.track(`${name}：${dropped ? "接続切れ" : "退出"}`, () => this.depart(ws, member, dropped), {
			doRequests: WS_MESSAGE,
		});
	}

	async webSocketError(ws: WebSocket): Promise<void> {
		this.depart(ws, attachmentOf(ws)?.member, true);
	}

	/**
	 * The socket is gone. Waking for its close, the room did not restore it (disconnected sockets are not in
	 * getWebSockets()), so who it was comes from its attachment; otherwise the others never hear LEFT.
	 * Dropped without a word, they stay a little in case they come straight back (docs/prd.md 3.3); the
	 * timer for letting them go also keeps the room awake until then, so they are not forgotten asleep.
	 */
	private depart(ws: WebSocket, member: Member | undefined, dropped: boolean): void {
		if (dropped) {
			const until = this.core.dropped(ws, member);
			if (until !== null)
				setTimeout(
					() => this.meter.track("接続が切れたまま", () => this.core.expireAway()),
					until - Date.now() + 100,
				);
			return;
		}
		if (member) this.core.departed(ws, member, "quit");
		else this.core.leave(ws, "quit");
	}

	async alarm(): Promise<void> {
		return this.meter.track("定期処理（Alarm）", () => this.sweepAlarm(), { doRequests: 1 });
	}

	private async sweepAlarm(): Promise<void> {
		const now = Date.now();
		// unauthenticated agents that never answered
		for (const ws of this.ctx.getWebSockets("ai")) {
			const att = ws.deserializeAttachment() as Attachment | null;
			if (att?.pending && now - att.pending.at > AUTH_TIMEOUT_MS) safeClose(ws, CLOSE_POLICY, "auth timeout");
		}
		this.guide.tick();
		this.core.sweep((c) =>
			isGuide(c) ? now : (this.ctx.getWebSocketAutoResponseTimestamp(c)?.getTime() ?? null),
		);
		if (this.core.size > 0) {
			const close = closingTime(now, this.hours);
			if (!isOpen(now, this.hours)) {
				this.core.closeAll("closing", CLOSE_CLOSING, "閉館しました");
			} else if (close !== null && now >= close - CLOSING_NOTICE_MS && this.noticeSentFor !== close) {
				this.noticeSentFor = close;
				const minutes = Math.max(1, Math.round((close - now) / 60_000));
				for (const c of this.core.connections())
					if (!isGuide(c))
						safeSend(c, {
							t: "NOTICE",
							kind: "closing_soon",
							message: `まもなく閉館です（あと${minutes}分）`,
						});
			}
		}
		// woken early (an AI's next step, or closing time): what is written is still written once a minute
		if (now - this.wroteAt >= SWEEP_INTERVAL_MS || this.core.size === 0) {
			this.wroteAt = now;
			this.flushStats();
			this.flushChat();
			// today's usage survives eviction (one row a minute while people are here)
			this.meter.add({ sqlRowsWritten: 1 });
			this.ctx.storage.kv.put("usage", this.meter.snapshot());
		}
		await this.scheduleAlarm();
	}

	/** An LLM whose Workers AI neurons go to the usage meter. */
	private meteredLlm(llm: WorkersAiLLM): LLM {
		return {
			name: llm.name,
			complete: async (req) => {
				const r = await llm.complete(req);
				this.meter.add({ neurons: llm.lastUsage?.neurons ?? 0 });
				return r;
			},
		};
	}

	/** Pushes new usage events to watchers, at most once a second (only while someone watches). */
	private schedulePush(): void {
		if (this.pushTimer) return;
		if (![...this.core.memberValues()].some((m) => m.watchUsage)) {
			this.meter.pending = [];
			return;
		}
		this.pushTimer = setTimeout(() => {
			this.pushTimer = null;
			const events = this.meter.pending;
			this.meter.pending = [];
			const msg: HostToClient = { t: "USAGE", ...this.meter.snapshot(), events };
			for (const [c, m] of this.core.memberEntries()) if (m.watchUsage && !isGuide(c)) safeSend(c, msg);
		}, USAGE_PUSH_MS);
	}

	/** SQL on the room's storage, with rows read and written going to the usage meter. */
	private sql<T extends Record<string, SqlStorageValue>>(query: string, ...params: unknown[]): T[] {
		const cursor = this.ctx.storage.sql.exec<T>(query, ...params);
		const rows = cursor.toArray();
		this.meter.add({ sqlRowsRead: cursor.rowsRead, sqlRowsWritten: cursor.rowsWritten });
		return rows;
	}

	/** The coins in their wallet (D1), or none if D1 cannot be read (they cannot buy or earn then). */
	private async loadWallet(info: JoinInfo): Promise<void> {
		try {
			info.coins = await walletOf(this.db, info.id);
		} catch {
			delete info.coins;
		}
	}

	private async loadRelations(id: string): Promise<void> {
		try {
			this.core.setRelations(id, await relationsOf(this.db, id));
		} catch {
			// D1 unavailable: join without personal filters rather than failing
		}
	}

	private async command(c: RoomCommand): Promise<unknown> {
		switch (c.op) {
			case "relation":
				this.core.updateRelation(c.accountId, c.targetId, c.kind, c.on);
				return { ok: true };
			case "kick":
				return { ok: this.core.kick(c.id, "kicked", c.message) };
			case "mute":
				return { ok: this.core.muteFor(c.id, c.until) };
			case "excerpt":
				return { lines: this.excerpt(c.id, c.minutes * 60_000) };
			case "clear_builds":
				return { removed: this.freePlay ? this.core.clearBuilds(c.by) : 0 };
			case "list_builds":
				return { builds: this.freePlay ? this.core.buildList : [] };
		}
	}

	// ---- building in free play (docs/prd.md 3.7) ----

	/** Creates the building tables and loads registered models and builds. */
	private loadBuilding(): void {
		const fresh =
			this.sql<{ n: number }>(
				"SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'builds'",
			)[0]?.n === 0;
		this.sql("CREATE TABLE IF NOT EXISTS builds (id TEXT PRIMARY KEY, data TEXT NOT NULL)");
		// a new local city starts from what was published (docs/prd.md 3.7.8)
		if (fresh)
			for (const b of PUBLISHED.builds)
				this.sql("INSERT INTO builds (id, data) VALUES (?, ?)", b.id, JSON.stringify(b));
		this.models.load();
		this.core.loadBuilds(
			this.sql<{ data: string }>("SELECT data FROM builds").map((r) => JSON.parse(r.data) as Build),
		);
	}

	/** Chat lines by or to `id` in the last `ms`: unflushed lines from memory plus the stored batches. */
	private excerpt(id: string, ms: number): ChatLine[] {
		this.flushChat();
		const since = Date.now() - ms;
		const lines: ChatLine[] = [];
		for (const row of this.sql<{ lines: string }>(
			"SELECT lines FROM chat WHERE at >= ? ORDER BY at",
			since - SWEEP_INTERVAL_MS,
		)) {
			for (const l of JSON.parse(row.lines) as ChatLine[])
				if (l.at >= since && (l.id === id || l.to === id)) lines.push(l);
		}
		return lines.slice(-50);
	}

	private flushChat(): void {
		const fresh = this.core.chatLog.filter((l) => l.at > this.chatFlushedAt);
		if (fresh.length > 0) {
			this.sql("INSERT INTO chat (at, lines) VALUES (?, ?)", Date.now(), JSON.stringify(fresh));
			this.chatFlushedAt = fresh[fresh.length - 1]?.at ?? this.chatFlushedAt;
		}
		this.sql("DELETE FROM chat WHERE at < ?", Date.now() - CHAT_KEEP_MS);
	}

	private async scheduleAlarm(): Promise<void> {
		if (this.ctx.getWebSockets().length === 0) return;
		const now = Date.now();
		let next = now + SWEEP_INTERVAL_MS;
		const close = closingTime(now, this.hours);
		if (close !== null) for (const t of [close - CLOSING_NOTICE_MS, close]) if (t > now && t < next) next = t;
		const wake = this.core.wakeAt;
		if (wake !== undefined && wake > now && wake < next) next = wake;
		const current = await this.ctx.storage.getAlarm();
		if (current === null || current > next || current < now) await this.ctx.storage.setAlarm(next);
	}

	/** Writes counter deltas once per sweep (one row per day keeps rows written low, docs/prd.md 3.3). */
	private flushStats(): void {
		const s = this.core.stats;
		const d = {
			inbound: s.inbound - this.flushed.inbound,
			connects: s.connects - this.flushed.connects,
			says: s.says - this.flushed.says,
			rejected: s.rejectedMoves - this.flushed.rejectedMoves,
		};
		if (d.inbound + d.connects + d.says + d.rejected === 0) return;
		this.sql(
			`INSERT INTO stats (day, inbound, connects, says, rejected) VALUES (?, ?, ?, ?, ?)
			 ON CONFLICT (day) DO UPDATE SET inbound = inbound + excluded.inbound, connects = connects + excluded.connects,
			 says = says + excluded.says, rejected = rejected + excluded.rejected`,
			new Date().toISOString().slice(0, 10),
			d.inbound,
			d.connects,
			d.says,
			d.rejected,
		);
		this.flushed = { ...s };
	}

	private statsSnapshot() {
		this.flushStats();
		const days = this.sql("SELECT * FROM stats ORDER BY day DESC LIMIT 7");
		return {
			members: this.core.size,
			sockets: this.ctx.getWebSockets().length,
			instanceStartedAt: this.startedAt,
			guide: { llmCallsToday: this.guide.llmCallsToday },
			live: this.core.stats,
			days,
		};
	}
}

/**
 * Attachments are limited to 2 KB. If a member's state does not fit, drop the AI-pair cooldowns
 * first (the host keeps them in memory while awake), then the conversations.
 */
function persistMember(ws: WebSocket, member: Member): void {
	const attempts: Member[] = [member, { ...member, cooldowns: {} }, { ...member, cooldowns: {}, convs: [] }];
	for (const m of attempts) {
		try {
			ws.serializeAttachment({ member: m } satisfies Attachment);
			return;
		} catch {
			// too large: try a smaller form
		}
	}
}

function safeSend(ws: WebSocket, msg: HostToClient): void {
	try {
		ws.send(encode(msg));
	} catch {
		// socket already closing
	}
}

/**
 * Close codes of a connection that dropped rather than ended (docs/prd.md 3.3): no close frame (1006), or
 * the server side failing or restarting. A tab closed (1001) or a client stopping (1000, 1005) has left.
 */
const DROPPED = new Set([1006, 1011, 1012, 1013, 1014]);

function attachmentOf(ws: WebSocket): Attachment | null {
	try {
		return ws.deserializeAttachment() as Attachment | null;
	} catch {
		return null;
	}
}

function forget(ws: WebSocket): void {
	try {
		ws.serializeAttachment({} satisfies Attachment);
	} catch {
		// already gone
	}
}

function safeClose(ws: WebSocket, code: number, reason: string): void {
	try {
		ws.close(code, reason);
	} catch {
		// already closed
	}
}
