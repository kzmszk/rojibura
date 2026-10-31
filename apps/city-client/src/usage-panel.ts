// The usage dashboard (docs/prd.md 2.5): how much of today's Cloudflare free tier is used, and what each
// action costs, live. Shown to admins, moderators and development builds; it can be closed.
//
// Two sources: the host's own live estimates for this area (pushed over the WebSocket) and Cloudflare's
// numbers for the whole account (the analytics API, a few minutes behind, if the host has a token).

import {
	emptyUsage,
	FREE_TIER,
	type HostToClient,
	USAGE_KEYS,
	USAGE_LABELS,
	type Usage,
	type UsageEvent,
	type UsageKey,
} from "@rojibura/protocol";
import { api } from "./api.ts";

const SHORT: Record<UsageKey, string> = {
	workerRequests: "Worker",
	doRequests: "DO",
	doGbSeconds: "GB-s",
	sqlRowsRead: "保存読",
	sqlRowsWritten: "保存書",
	d1RowsRead: "D1読",
	d1RowsWritten: "D1書",
	neurons: "AI",
};
const OFFICIAL_EVERY_MS = 5 * 60_000;
const MAX_EVENTS = 100;
const STORE_KEY = "rj.usage.open";

interface Official {
	configured: boolean;
	totals?: Usage;
	fetchedAt?: number;
	error?: string;
}

function el<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	cls: string,
	text?: string,
): HTMLElementTagNameMap[K] {
	const e = document.createElement(tag);
	e.className = cls;
	if (text !== undefined) e.textContent = text;
	return e;
}

/** Totals: whole numbers past 100, otherwise up to two decimals. */
function fmt(v: number): string {
	if (v > 0 && v < 0.01) return "<0.01";
	return v >= 100 ? Math.round(v).toLocaleString() : (Math.round(v * 100) / 100).toLocaleString();
}

const hms = (t: number) =>
	new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

export class UsagePanel {
	readonly el: HTMLElement;
	private readonly watch: (on: boolean) => void;
	private shown = false;
	private estimate: Usage = emptyUsage();
	private official: Official | null = null;
	private events: (UsageEvent & { mine?: boolean })[] = [];
	private officialTimer: ReturnType<typeof setInterval> | null = null;
	private readonly bars = el("div", "rj-usage-bars");
	private readonly list = el("div", "rj-usage-events");
	private readonly note = el("div", "rj-note");

	constructor(watch: (on: boolean) => void) {
		this.watch = watch;
		this.el = el("div", "rj-usage");
		const head = el("div", "rj-usage-head");
		const close = el("button", "rj-usage-close", "×");
		close.type = "button";
		close.title = "閉じる";
		close.onclick = () => this.hide();
		head.append(el("b", "", "無料枠の利用状況（今日・UTC 0時にリセット）"), close);
		this.el.append(head, this.bars, this.note, el("b", "rj-usage-sub", "最近の操作と消費"), this.list);
		this.render();
	}

	get isShown(): boolean {
		return this.shown;
	}

	/** Opens it again if it was open last time. */
	restore(): void {
		try {
			if (localStorage.getItem(STORE_KEY) === "1") this.show();
		} catch {
			// storage unavailable: start closed
		}
	}

	toggle(): void {
		if (this.shown) this.hide();
		else this.show();
	}

	show(): void {
		this.shown = true;
		this.el.classList.add("show");
		this.remember();
		this.watch(true);
		void this.loadOfficial();
		this.officialTimer = setInterval(() => void this.loadOfficial(), OFFICIAL_EVERY_MS);
	}

	hide(): void {
		this.shown = false;
		this.el.classList.remove("show");
		this.remember();
		this.watch(false);
		if (this.officialTimer) clearInterval(this.officialTimer);
		this.officialTimer = null;
	}

	/** The host's live numbers for this area. */
	onUsage(msg: Extract<HostToClient, { t: "USAGE" }>): void {
		this.estimate = msg.totals;
		for (const e of msg.events) this.addEvent(e);
		this.render();
	}

	/** What one of this browser's own API calls cost (from its response). */
	addOwn(label: string, cost: Partial<Usage>): void {
		this.addEvent({ at: Date.now(), label, cost }, true);
		this.render();
	}

	private addEvent(e: UsageEvent, mine = false): void {
		// the same action can come back from the room's meter after the gateway reports it
		const same = (x: UsageEvent & { mine?: boolean }) =>
			(x.at === e.at && x.label === e.label) ||
			(!mine && x.mine && x.label === `あなた：${e.label}` && Math.abs(x.at - e.at) < 5000);
		if (this.events.some(same)) return;
		this.events.unshift({ ...e, mine });
		this.events.sort((a, b) => b.at - a.at);
		this.events.length = Math.min(this.events.length, MAX_EVENTS);
	}

	private async loadOfficial(): Promise<void> {
		try {
			const r = await api("/api/usage/official");
			this.official = r.ok
				? ((await r.json()) as Official)
				: { configured: false, error: `HTTP ${r.status}` };
		} catch (e) {
			this.official = { configured: false, error: (e as Error).message };
		}
		this.render();
	}

	private remember(): void {
		try {
			localStorage.setItem(STORE_KEY, this.shown ? "1" : "0");
		} catch {
			// not remembered
		}
	}

	private render(): void {
		const off = this.official?.configured ? this.official.totals : undefined;
		this.bars.replaceChildren(
			...USAGE_KEYS.map((k) => {
				const limit = FREE_TIER[k];
				const used = off ? off[k] : this.estimate[k];
				const pct = (used / limit) * 100;
				const row = el("div", "rj-usage-row");
				const top = el("div", "rj-usage-top");
				top.append(
					el("span", "", USAGE_LABELS[k]),
					el(
						"span",
						"rj-usage-pct",
						`${fmt(used)} / ${limit.toLocaleString()}　${pct < 0.1 && used > 0 ? "<0.1" : pct.toFixed(1)}%`,
					),
				);
				const bar = el("div", "rj-usage-bar");
				const fill = el(
					"div",
					pct >= 80 ? "rj-usage-fill hot" : pct >= 50 ? "rj-usage-fill warm" : "rj-usage-fill",
				);
				fill.style.width = `${Math.min(100, Math.max(used > 0 ? 1 : 0, pct))}%`;
				bar.append(fill);
				row.append(top, bar);
				// with Cloudflare's numbers on the bar, this area's live estimate goes below it
				if (off) row.append(el("div", "rj-usage-nums", `この街の推定 ${fmt(this.estimate[k])}`));
				return row;
			}),
		);
		const o = this.official;
		this.note.textContent = !o
			? "公式の数字を読み込み中…"
			: o.configured && o.fetchedAt
				? `棒グラフは Cloudflare 公式のアカウント全体の値（${hms(o.fetchedAt)} 時点、数分遅れ）。${o.error ? `更新に失敗：${o.error}` : ""}`
				: "棒グラフはこの街の推定値。アカウント全体の公式の値を出すには、分析用の API トークンを登録する（README）。";
		this.list.replaceChildren(
			...(this.events.length === 0
				? [el("div", "rj-note", "まだ記録がありません。歩いたり話したりすると、ここに出ます。")]
				: this.events.map((e) => {
						const row = el("div", e.mine ? "rj-usage-event mine" : "rj-usage-event");
						row.append(el("span", "rj-usage-time", hms(e.at)), el("span", "rj-usage-label", e.label));
						const chips = el("span", "rj-usage-chips");
						for (const k of USAGE_KEYS) {
							const v = e.cost[k];
							if (v) chips.append(el("span", `rj-chip rj-chip-${k}`, `${SHORT[k]} ${fmt(v)}`));
						}
						row.append(chips);
						return row;
					})),
		);
	}
}
