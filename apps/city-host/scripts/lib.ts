// Helpers shared by the end-to-end scripts (smoke.ts, moderation.ts).

import { type ClientToHost, encode, type HostToClient, parseHostMessage } from "@rojibura/protocol";

export const BASE = process.argv[2] ?? "http://localhost:5173";
export const WS_BASE = BASE.replace(/^http/, "ws");

export function check(cond: unknown, label: string): void {
	if (!cond) {
		console.error(`FAIL ${label}`);
		process.exit(1);
	}
	console.log(`ok   ${label}`);
}

export async function devLogin(name: string): Promise<string> {
	const r = await fetch(`${BASE}/auth/dev/login?name=${encodeURIComponent(name)}`, { redirect: "manual" });
	const cookie = r.headers.get("set-cookie")?.split(";")[0];
	if (!cookie) throw new Error(`login failed for ${name}: ${r.status}`);
	return cookie;
}

export class Client {
	readonly inbox: HostToClient[] = [];
	private waiters: { pred: (m: HostToClient) => boolean; resolve: (m: HostToClient) => void }[] = [];
	readonly ws: WebSocket;
	readonly opened: Promise<void>;

	constructor(url: string, cookie?: string) {
		// undici's WebSocket accepts extra headers (non-standard)
		this.ws = new WebSocket(
			url,
			cookie ? ({ headers: { Cookie: cookie } } as unknown as string[]) : undefined,
		);
		this.opened = new Promise((resolve, reject) => {
			this.ws.onopen = () => resolve();
			this.ws.onerror = (e) => reject(new Error(`ws error ${String((e as ErrorEvent).message ?? "")}`));
		});
		this.ws.onmessage = (e) => {
			if (e.data === "pong") return;
			const m = parseHostMessage(String(e.data));
			if (!m) return;
			this.inbox.push(m);
			for (const w of [...this.waiters])
				if (w.pred(m)) {
					this.waiters.splice(this.waiters.indexOf(w), 1);
					w.resolve(m);
				}
		};
	}

	send(msg: ClientToHost): void {
		this.ws.send(encode(msg));
	}

	waitFor<T extends HostToClient["t"]>(
		t: T,
		pred: (m: Extract<HostToClient, { t: T }>) => boolean = () => true,
		ms = 5000,
	): Promise<Extract<HostToClient, { t: T }>> {
		const found = this.inbox.find((m) => m.t === t && pred(m as Extract<HostToClient, { t: T }>));
		if (found) return Promise.resolve(found as Extract<HostToClient, { t: T }>);
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error(`timeout waiting for ${t}`)), ms);
			this.waiters.push({
				pred: (m) => m.t === t && pred(m as Extract<HostToClient, { t: T }>),
				resolve: (m) => {
					clearTimeout(timer);
					resolve(m as Extract<HostToClient, { t: T }>);
				},
			});
		});
	}
}
