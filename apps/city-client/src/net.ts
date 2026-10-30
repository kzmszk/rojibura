// Human client connection: WebSocket with heartbeat, reconnect and host-time estimation.

import {
	type ClientToHost,
	encode,
	HEARTBEAT_INTERVAL_MS,
	HEARTBEAT_PING,
	HEARTBEAT_PONG,
	type HostToClient,
	parseHostMessage,
} from "@rojibura/protocol";

export type ConnState = "connecting" | "open" | "closed";

export interface CityConnectionOptions {
	areaId: string;
	avatar: string;
	onMessage: (msg: HostToClient) => void;
	onState: (state: ConnState, detail?: string) => void;
}

const NO_RETRY = new Set([1008, 4000, 4001, 4003, 4010]);

export class CityConnection {
	private ws: WebSocket | null = null;
	private timer: ReturnType<typeof setInterval> | null = null;
	private retryMs = 1000;
	private stopped = false;
	/** hostTime = Date.now() + offset */
	private offset = 0;
	private readonly o: CityConnectionOptions;

	constructor(o: CityConnectionOptions) {
		this.o = o;
	}

	hostNow(): number {
		return Date.now() + this.offset;
	}

	start(): void {
		this.stopped = false;
		this.open();
	}

	stop(): void {
		this.stopped = true;
		this.ws?.close(1000);
	}

	send(msg: ClientToHost): void {
		if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(encode(msg));
	}

	private open(): void {
		const proto = location.protocol === "https:" ? "wss" : "ws";
		const ws = new WebSocket(
			`${proto}://${location.host}/ws/area/${this.o.areaId}?avatar=${encodeURIComponent(this.o.avatar)}`,
		);
		this.ws = ws;
		this.o.onState("connecting");
		ws.onmessage = (e) => {
			if (e.data === HEARTBEAT_PONG) return;
			const msg = parseHostMessage(String(e.data));
			if (!msg) return;
			if (msg.t === "WELCOME") {
				this.offset = msg.serverTime - Date.now();
				this.retryMs = 1000;
				this.o.onState("open");
				if (this.timer) clearInterval(this.timer);
				this.timer = setInterval(
					() => ws.readyState === WebSocket.OPEN && ws.send(HEARTBEAT_PING),
					HEARTBEAT_INTERVAL_MS,
				);
			}
			// keep the clock estimate fresh: host time can only be later than any event we received
			if ("at" in msg && typeof msg.at === "number" && msg.at > this.hostNow())
				this.offset = msg.at - Date.now();
			this.o.onMessage(msg);
		};
		ws.onclose = (e) => {
			if (this.timer) clearInterval(this.timer);
			if (this.ws !== ws) return;
			this.ws = null;
			if (this.stopped) return;
			if (NO_RETRY.has(e.code)) {
				this.o.onState("closed", e.reason || `closed (${e.code})`);
				return;
			}
			this.o.onState("connecting", "再接続しています…");
			setTimeout(() => !this.stopped && this.open(), this.retryMs);
			this.retryMs = Math.min(this.retryMs * 2, 30_000);
		};
	}
}
