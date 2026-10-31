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
	agentId: string;
	privateKey: CryptoKey;
	logger: Logger;
	onMessage: (msg: HostToClient) => void;
	/** Called after every successful (re)join. */
	onWelcome?: () => void;
}

/** Close codes after which reconnecting makes no sense right away. */
const NO_RETRY = new Set([1008, 4001, 4003, 4010]);

export class AgentConnection {
	private ws: WebSocket | null = null;
	private heartbeat: ReturnType<typeof setInterval> | null = null;
	private stopped = false;
	private retryMs = 2000;
	private readonly opts: ConnectionOptions;

	constructor(opts: ConnectionOptions) {
		this.opts = opts;
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
		if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(encode(msg));
	}

	private open(): void {
		const { baseUrl, areaId, agentId, logger } = this.opts;
		const url = `${baseUrl}/ws/area/${areaId}?agent=${encodeURIComponent(agentId)}`;
		const ws = new WebSocket(url);
		this.ws = ws;
		// addEventListener rather than on* handlers: the Workers runtime only has the former
		ws.addEventListener("open", () => logger.info(`connected to ${areaId}`));
		ws.addEventListener("message", (e) => {
			if (e.data === HEARTBEAT_PONG) return;
			const msg = parseHostMessage(String(e.data));
			if (!msg) return;
			if (msg.t === "CHALLENGE") {
				void signAuth(this.opts.privateKey, authPayload(areaId, agentId, msg.nonce)).then((sig) =>
					this.send({ t: "AUTH", sig }),
				);
				return;
			}
			if (msg.t === "WELCOME") {
				this.retryMs = 2000;
				this.startHeartbeat();
				this.opts.onWelcome?.();
			}
			this.opts.onMessage(msg);
		});
		ws.addEventListener("close", (e) => {
			this.clearHeartbeat();
			if (this.ws !== ws) return;
			this.ws = null;
			if (this.stopped) return;
			if (NO_RETRY.has(e.code)) {
				logger.warn(`closed by host (${e.code} ${e.reason}); not reconnecting`);
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
