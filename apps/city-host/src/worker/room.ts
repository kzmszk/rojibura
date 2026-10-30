// CityRoomDO: one area of the city (docs/prd.md 3.3). Owns the sockets, hibernation, heartbeats,
// agent challenge-response and alarms; the area logic lives in RoomCore.

import { DurableObject } from "cloudflare:workers";
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
import { CLOSING_NOTICE_MS, closingTime, isOpen } from "./hours.ts";
import { CLOSE_CLOSING, CLOSE_POLICY, type JoinInfo, type Member, RoomCore } from "./room-core.ts";
import { world } from "./world.ts";

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

export class CityRoomDO extends DurableObject<Env> {
	private readonly core: RoomCore<WebSocket>;
	private flushed = { inbound: 0, connects: 0, says: 0, rejectedMoves: 0 };
	private noticeSentFor = 0;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.core = new RoomCore<WebSocket>(
			{
				send: (ws, msg) => safeSend(ws, msg),
				close: (ws, code, reason) => safeClose(ws, code, reason),
				persist: (ws, member) => ws.serializeAttachment({ member } satisfies Attachment),
			},
			world,
			Date.now,
			() => randomToken(9),
		);
		ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(HEARTBEAT_PING, HEARTBEAT_PONG));
		for (const ws of ctx.getWebSockets()) {
			const att = ws.deserializeAttachment() as Attachment | null;
			if (att?.member) this.core.restore(ws, att.member);
		}
		ctx.blockConcurrencyWhile(async () => {
			ctx.storage.sql.exec(
				"CREATE TABLE IF NOT EXISTS stats (day TEXT PRIMARY KEY, inbound INTEGER NOT NULL DEFAULT 0, connects INTEGER NOT NULL DEFAULT 0, says INTEGER NOT NULL DEFAULT 0, rejected INTEGER NOT NULL DEFAULT 0)",
			);
		});
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === "/stats") return Response.json(this.statsSnapshot());
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
		this.core.sweep((ws) => this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime() ?? null);
		if (this.env.DEV_ALWAYS_OPEN !== "1" && this.core.size > 0) {
			const close = closingTime(now);
			if (!isOpen(now) || now >= close) {
				this.core.closeAll("closing", CLOSE_CLOSING, "閉館しました");
			} else if (now >= close - CLOSING_NOTICE_MS && this.noticeSentFor !== close) {
				this.noticeSentFor = close;
				for (const ws of this.core.members.keys())
					safeSend(ws, { t: "NOTICE", kind: "closing_soon", message: "まもなく閉館です（24:00）" });
			}
		}
		this.flushStats();
		await this.scheduleAlarm();
	}

	private async scheduleAlarm(): Promise<void> {
		if (this.ctx.getWebSockets().length === 0) return;
		const now = Date.now();
		let next = now + SWEEP_INTERVAL_MS;
		if (this.env.DEV_ALWAYS_OPEN !== "1" && isOpen(now)) {
			const close = closingTime(now);
			for (const t of [close - CLOSING_NOTICE_MS, close]) if (t > now && t < next) next = t;
		}
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
			live: this.core.stats,
			days,
		};
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
