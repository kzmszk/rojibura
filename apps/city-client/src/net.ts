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
import { api } from "./api.ts";

export type ConnState = "connecting" | "open" | "closed";

export interface CityConnectionOptions {
	areaId: string;
	/** Arriving through a portal: the landmark or portal to appear at (docs/prd.md 3.8). */
	at?: string;
	avatar: string;
	onMessage: (msg: HostToClient) => void;
	onState: (state: ConnState, detail?: string) => void;
}

const NO_RETRY = new Set([1008, 4000, 4001, 4003, 4010]);
/** Host closed the area for the night. */
const CLOSE_CLOSING = 4010;

/** GET /api/entry: whether this person may enter now. */
type Entry =
	| { ok: true }
	| { ok: false; reason: "closed"; nextOpening: number }
	| { ok: false; reason: "login" | "banned" };

const hhmm = (t: number) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

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
		void this.enter();
	}

	stop(): void {
		this.stopped = true;
		this.ws?.close(1000);
	}

	send(msg: ClientToHost): void {
		if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(encode(msg));
	}

	/**
	 * Asks the host whether we may enter, then connects, waits for the opening time, or gives up.
	 * A failed WebSocket handshake carries no reason, so this is asked before every (re)connect.
	 */
	private async enter(): Promise<void> {
		let entry: Entry = { ok: true };
		try {
			entry = (await (await api("/api/entry")).json()) as Entry;
		} catch {
			// host unreachable: let the socket attempt fail and retry with backoff
		}
		if (this.stopped) return;
		if (entry.ok) {
			this.open();
			return;
		}
		if (entry.reason === "closed") {
			this.o.onState("closed", `閉館中です（${hhmm(entry.nextOpening)} に開館。時間になると自動で入ります）`);
			// spread the crowd at the opening over a few seconds
			const wait = Math.max(1000, entry.nextOpening - Date.now() + Math.random() * 10_000);
			setTimeout(() => !this.stopped && void this.enter(), wait);
			return;
		}
		this.o.onState("closed", entry.reason === "banned" ? "現在は入場できません" : "ログインが必要です");
	}

	private open(): void {
		const proto = location.protocol === "https:" ? "wss" : "ws";
		const q = new URLSearchParams({ avatar: this.o.avatar, ...(this.o.at ? { at: this.o.at } : {}) });
		const ws = new WebSocket(`${proto}://${location.host}/ws/area/${this.o.areaId}?${q}`);
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
				// after closing time, wait for the next opening
				if (e.code === CLOSE_CLOSING) setTimeout(() => !this.stopped && void this.enter(), 5000);
				return;
			}
			this.o.onState("connecting", "再接続しています…");
			setTimeout(() => !this.stopped && void this.enter(), this.retryMs);
			this.retryMs = Math.min(this.retryMs * 2, 30_000);
		};
	}
}
