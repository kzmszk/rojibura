// Protocol client for an agent: connect, answer the challenge, heartbeat, reconnect (docs/prd.md 3.2.1).

import {
	authPayload,
	type ClientToHost,
	encode,
	HEARTBEAT_INTERVAL_MS,
	HEARTBEAT_PING,
	HEARTBEAT_PONG,
	type HostToClient,
	parseHostMessage,
	signAuth,
} from "@rojibura/protocol";
import type { Logger } from "./types.ts";

export interface ConnectionOptions {
	/** e.g. "ws://localhost:5173" */
	baseUrl: string;
	areaId: string;
	/** Arriving through a portal: the landmark or portal of the area to appear at (first connection only). */
	at?: string;
	agentId: string;
	privateKey: CryptoKey;
	logger: Logger;
	onMessage: (msg: HostToClient) => void;
	/** Called after every successful (re)join. */
	onWelcome?: () => void;
	/** Called when the host closes the connection for good (no reconnecting), with its code. */
	onClosed?: (code: number, reason: string) => void;
}

/** The same AI came in from somewhere else (its owner's PC, or the browser again): that one stays. */
export const CLOSE_REPLACED = 4000;
/**
 * Close codes after which reconnecting makes no sense right away. Replaced: coming back in would push the
 * other one out, and the two would take turns.
 */
const NO_RETRY = new Set([1008, CLOSE_REPLACED, 4001, 4003, 4010]);
/**
 * What it says while the connection is down is held and sent when it is back as it was (WELCOME `resumed`,
 * docs/prd.md 3.3), so a reply thought up meanwhile still reaches the one it talks with. Moves are not: the
 * host has it where it was.
 */
const HELD_WHILE_DOWN = new Set<ClientToHost["t"]>(["SAY", "ANSWER"]);
const HELD_MAX = 10;

export class AgentConnection {
	private ws: WebSocket | null = null;
	private heartbeat: ReturnType<typeof setInterval> | null = null;
	private stopped = false;
	private retryMs = 2000;
	/** Welcomed on the current socket (before that, only AUTH may be sent). */
	private ready = false;
	private held: ClientToHost[] = [];
	private readonly opts: ConnectionOptions;
	private area: string;
	private at: string | undefined;

	constructor(opts: ConnectionOptions) {
		this.opts = opts;
		this.area = opts.areaId;
		this.at = opts.at;
	}

	/** The area it is in now. */
	get areaId(): string {
		return this.area;
	}

	/**
	 * Goes to another area (following its owner through a portal, docs/prd.md 3.8.2): leaves this one and
	 * comes in there, at `at`.
	 */
	moveTo(areaId: string, at?: string): void {
		this.area = areaId;
		this.at = at;
		this.retryMs = 2000;
		const old = this.ws;
		this.clearHeartbeat();
		this.ready = false;
		this.held = [];
		this.ws = null;
		old?.close(1000, "travel");
		if (!this.stopped) this.open();
	}

	start(): void {
		this.stopped = false;
		this.open();
	}

	stop(): void {
		this.stopped = true;
		this.clearHeartbeat();
		this.ws?.close(1000, "bye");
		this.ws = null;
	}

	send(msg: ClientToHost): void {
		if (this.ready && this.ws?.readyState === WebSocket.OPEN) this.ws.send(encode(msg));
		else if (!this.stopped && HELD_WHILE_DOWN.has(msg.t) && this.held.length < HELD_MAX) this.held.push(msg);
	}

	private open(): void {
		const { baseUrl, agentId, logger } = this.opts;
		const areaId = this.area;
		const at = this.at ? `&at=${encodeURIComponent(this.at)}` : "";
		const url = `${baseUrl}/ws/area/${areaId}?agent=${encodeURIComponent(agentId)}${at}`;
		const ws = new WebSocket(url);
		this.ws = ws;
		this.ready = false;
		// addEventListener rather than on* handlers: the Workers runtime only has the former
		ws.addEventListener("open", () => logger.info(`connected to ${areaId}`));
		ws.addEventListener("message", (e) => {
			if (e.data === HEARTBEAT_PONG) return;
			const msg = parseHostMessage(String(e.data));
			if (!msg) return;
			if (msg.t === "CHALLENGE") {
				void signAuth(this.opts.privateKey, authPayload(areaId, agentId, msg.nonce)).then(
					(sig) => ws.readyState === WebSocket.OPEN && ws.send(encode({ t: "AUTH", sig })),
				);
				return;
			}
			if (msg.t === "WELCOME") {
				this.retryMs = 2000;
				// in: a dropped connection later comes back where it was, not at the portal
				this.at = undefined;
				this.ready = true;
				this.startHeartbeat();
				this.opts.onWelcome?.();
			}
			this.opts.onMessage(msg);
			if (msg.t === "WELCOME") {
				// back where it was: what it said meanwhile goes now; a fresh start leaves it unsaid
				const held = this.held;
				this.held = [];
				if (msg.resumed) for (const m of held) this.send(m);
			}
		});
		ws.addEventListener("close", (e) => {
			this.clearHeartbeat();
			if (this.ws !== ws) return;
			this.ready = false;
			this.ws = null;
			if (this.stopped) return;
			if (NO_RETRY.has(e.code)) {
				logger.warn(`closed by host (${e.code} ${e.reason}); not reconnecting`);
				this.opts.onClosed?.(e.code, e.reason);
				return;
			}
			logger.warn(`disconnected (${e.code}); reconnecting in ${this.retryMs / 1000}s`);
			setTimeout(() => !this.stopped && this.open(), this.retryMs);
			this.retryMs = Math.min(this.retryMs * 2, 60_000);
		});
		ws.addEventListener("error", () => {
			// close follows
		});
	}

	private startHeartbeat(): void {
		this.clearHeartbeat();
		this.heartbeat = setInterval(() => {
			if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(HEARTBEAT_PING);
		}, HEARTBEAT_INTERVAL_MS);
	}

	private clearHeartbeat(): void {
		if (this.heartbeat) clearInterval(this.heartbeat);
		this.heartbeat = null;
	}
}
