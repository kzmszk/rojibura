// CityRoomDO: one area of the city (docs/prd.md 3.3). Owns the sockets, hibernation, heartbeats,
// agent challenge-response and alarms; the area logic lives in RoomCore.

import { DurableObject } from "cloudflare:workers";
import { WorkersAiLLM } from "@rojibura/avatar-sdk";
import {
	AUTH_TIMEOUT_MS,
	authPayload,
	encode,
	HEARTBEAT_PING,
	HEARTBEAT_PONG,
	type HostToClient,
	parseClientMessage,
	randomToken,
	verifyAuth,
} from "@rojibura/protocol";
import { relationsOf } from "./db.ts";
import { Guide, type GuideSaved } from "./guide.ts";
import { CLOSING_NOTICE_MS, closingTime, describeHours, type Hours, isOpen, parseHours } from "./hours.ts";
import {
	type ChatLine,
	CLOSE_CLOSING,
	CLOSE_POLICY,
	type JoinInfo,
	type Member,
	RoomCore,
} from "./room-core.ts";
import { navmesh, world } from "./world.ts";

/** The guide's connection: the room routes its messages to the Guide instead of a socket. */
const GUIDE_CONN = { guide: true } as const;
type Conn = WebSocket | typeof GUIDE_CONN;
const isGuide = (c: Conn): c is typeof GUIDE_CONN => c === GUIDE_CONN;

/** What the gateway sends with the upgrade request (trusted: the DO is only reachable through it). */
export interface JoinRequest {
	areaId: string;
	info: JoinInfo;
	/** Agents only: registered public key to verify the challenge with. */
	publicKey?: string;
}

interface Attachment {
	member?: Member;
	pending?: { info: JoinInfo; publicKey: string; nonce: string; areaId: string; at: number };
}

const SWEEP_INTERVAL_MS = 60_000;
const CHAT_KEEP_MS = 24 * 60 * 60 * 1000;

/** Internal requests from the gateway (moderation and relations, docs/prd.md 4.2). */
export type RoomCommand =
	| { op: "relation"; accountId: string; targetId: string; kind: "mute" | "block"; on: boolean }
	| { op: "kick"; id: string }
	| { op: "mute"; id: string; until: number }
	| { op: "excerpt"; id: string; minutes: number };

export class CityRoomDO extends DurableObject<Env> {
	private readonly core: RoomCore<Conn>;
	private readonly guide: Guide<Conn>;
	private flushed = { inbound: 0, connects: 0, says: 0, rejectedMoves: 0 };
	private noticeSentFor = 0;
	private chatFlushedAt = 0;
	private readonly hours: Hours;
	/** When this instance was created: a later value than the last activity means it hibernated. */
	private readonly startedAt = Date.now();

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.hours = parseHours(env.OPEN_HOURS);
		this.core = new RoomCore<Conn>(
			{
				send: (c, msg) => (isGuide(c) ? this.guide.onMessage(msg) : safeSend(c, msg)),
				close: (c, code, reason) => !isGuide(c) && safeClose(c, code, reason),
				persist: (c, member) => (isGuide(c) ? this.guide.persist(member) : persistMember(c, member)),
			},
			world,
			Date.now,
			() => randomToken(9),
		);
		this.guide = new Guide<Conn>({
			core: this.core,
			conn: GUIDE_CONN,
			world,
			findPath: (from, to) => navmesh.findPath(navmesh.closestPoint(from), navmesh.closestPoint(to)),
			llm: env.AI ? new WorkersAiLLM(env.AI) : null,
			load: () => ctx.storage.kv.get<GuideSaved>("guide"),
			save: (s) => ctx.storage.kv.put("guide", s),
			hoursText: describeHours(this.hours),
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
		});
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === "/stats") return Response.json(this.statsSnapshot());
		if (url.pathname === "/command" && request.method === "POST")
			return Response.json(await this.command((await request.json()) as RoomCommand));
		if (request.headers.get("Upgrade") !== "websocket")
			return new Response("Expected WebSocket", { status: 426 });
		const join = JSON.parse(request.headers.get("X-RJ-Join") ?? "null") as JoinRequest | null;
		if (!join) return new Response("Bad join", { status: 400 });

		const pair = new WebSocketPair();
		const server = pair[1];
		this.ctx.acceptWebSocket(server, [join.info.kind]);
		if (join.info.kind === "ai") {
			if (!join.publicKey) return new Response("No key", { status: 400 });
			const nonce = randomToken(18);
			server.serializeAttachment({
				pending: { info: join.info, publicKey: join.publicKey, nonce, areaId: join.areaId, at: Date.now() },
			} satisfies Attachment);
			safeSend(server, { t: "CHALLENGE", nonce });
		} else {
			await this.loadRelations(join.info.id);
			this.guide.ensurePresent();
			this.core.join(server, join.info);
		}
		await this.scheduleAlarm();
		return new Response(null, { status: 101, webSocket: pair[0] });
	}

	async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
		const att = ws.deserializeAttachment() as Attachment | null;
		const parsed = parseClientMessage(message);
		if (att?.pending) {
			const p = att.pending;
			const ok =
				parsed.ok &&
				parsed.msg.t === "AUTH" &&
				Date.now() - p.at <= AUTH_TIMEOUT_MS &&
				(await verifyAuth(p.publicKey, authPayload(p.areaId, p.info.id, p.nonce), parsed.msg.sig));
			if (!ok) {
				safeClose(ws, CLOSE_POLICY, "authentication failed");
				return;
			}
			// the nonce is consumed: the attachment is replaced by the member state
			await this.loadRelations(p.info.id);
			this.guide.ensurePresent();
			this.core.join(ws, p.info);
			return;
		}
		if (!parsed.ok) {
			this.core.touch(ws);
			safeSend(ws, { t: "NOTICE", kind: "rejected", message: parsed.error });
			return;
		}
		this.core.handle(ws, parsed.msg);
	}

	async webSocketClose(ws: WebSocket): Promise<void> {
		this.core.leave(ws, "quit");
	}

	async webSocketError(ws: WebSocket): Promise<void> {
		this.core.leave(ws, "quit");
	}

	async alarm(): Promise<void> {
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
				for (const c of this.core.members.keys())
					if (!isGuide(c))
						safeSend(c, {
							t: "NOTICE",
							kind: "closing_soon",
							message: `まもなく閉館です（あと${minutes}分）`,
						});
			}
		}
		this.flushStats();
		this.flushChat();
		await this.scheduleAlarm();
	}

	private async loadRelations(id: string): Promise<void> {
		try {
			this.core.setRelations(id, await relationsOf(this.env.DB, id));
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
				return { ok: this.core.kick(c.id) };
			case "mute":
				return { ok: this.core.muteFor(c.id, c.until) };
			case "excerpt":
				return { lines: this.excerpt(c.id, c.minutes * 60_000) };
		}
	}

	/** Chat lines by or to `id` in the last `ms`: unflushed lines from memory plus the stored batches. */
	private excerpt(id: string, ms: number): ChatLine[] {
		this.flushChat();
		const since = Date.now() - ms;
		const lines: ChatLine[] = [];
		for (const row of this.ctx.storage.sql.exec<{ lines: string }>(
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
			this.ctx.storage.sql.exec(
				"INSERT INTO chat (at, lines) VALUES (?, ?)",
				Date.now(),
				JSON.stringify(fresh),
			);
			this.chatFlushedAt = fresh[fresh.length - 1]?.at ?? this.chatFlushedAt;
		}
		this.ctx.storage.sql.exec("DELETE FROM chat WHERE at < ?", Date.now() - CHAT_KEEP_MS);
	}

	private async scheduleAlarm(): Promise<void> {
		if (this.ctx.getWebSockets().length === 0) return;
		const now = Date.now();
		let next = now + SWEEP_INTERVAL_MS;
		const close = closingTime(now, this.hours);
		if (close !== null) for (const t of [close - CLOSING_NOTICE_MS, close]) if (t > now && t < next) next = t;
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
		this.ctx.storage.sql.exec(
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
		const days = this.ctx.storage.sql.exec("SELECT * FROM stats ORDER BY day DESC LIMIT 7").toArray();
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

function safeClose(ws: WebSocket, code: number, reason: string): void {
	try {
		ws.close(code, reason);
	} catch {
		// already closed
	}
}
