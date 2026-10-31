// Calls to the host's API. Each response says what it cost of the free tier (X-RJ-Usage); the usage panel
// listens, so the player's own actions show up as they happen (docs/prd.md 2.5).

import type { Usage } from "@rojibura/protocol";

type Listener = (label: string, cost: Partial<Usage>) => void;
const listeners = new Set<Listener>();

export function onApiUsage(listener: Listener): void {
	listeners.add(listener);
}

export async function api(path: string, init?: RequestInit): Promise<Response> {
	const r = await fetch(path, init);
	const header = r.headers.get("X-RJ-Usage");
	if (header && listeners.size > 0) {
		const cost: Partial<Usage> = {};
		for (const part of header.split(",")) {
			const [k, v] = part.split("=");
			if (k && v) cost[k as keyof Usage] = Number(v);
		}
		const label = decodeURIComponent(r.headers.get("X-RJ-Usage-Label") ?? path);
		for (const l of listeners) l(`あなた：${label}`, cost);
	}
	return r;
}
