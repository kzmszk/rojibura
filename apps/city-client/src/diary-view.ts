// 📔 日記: the owner reads their AI's diary in the 🤖 panel (docs/life.md 8). It is kept where the AI runs (a PC's
// files; a rule-based AI has only today and its notes on the days before): the page asks the host, the host
// asks the AI here, and its answer comes back in parts (DIARY). Nothing of it is kept on the host or here.

import { type ClientToHost, DIARY_TTL_MS, type HostToClient } from "@rojibura/protocol";

type DiaryMsg = Extract<HostToClient, { t: "DIARY" }>;

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

/** "2026-11-03" as the owner reads it: "11月3日（火）", with 今日 or きのう. */
export function dayLabel(day: string, today: string): string {
	const d = new Date(`${day}T12:00:00+09:00`);
	const w = "日月火水木金土"[d.getUTCDay()];
	const base = `${Number(day.slice(5, 7))}月${Number(day.slice(8, 10))}日（${w}）`;
	const back = Math.round((Date.parse(`${today}T12:00:00+09:00`) - d.getTime()) / 86_400_000);
	return back === 0 ? `${base} 今日` : back === 1 ? `${base} きのう` : base;
}

/** Today's JST date, as the diary names its days. */
function jstToday(): string {
	return new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
}

/** A diary page (Markdown, as the SDK writes it) as elements: headings bold, the rest as written. */
export function diaryNodes(text: string): HTMLElement[] {
	const out: HTMLElement[] = [];
	for (const line of text
		.replace(/\n{3,}/g, "\n\n")
		.trim()
		.split("\n")) {
		const h = /^(#{1,3})\s+(.*)$/.exec(line);
		if (h) out.push(el("div", `rj-diary-h${h[1]?.length}`, h[2]));
		else if (line.trim()) out.push(el("div", "", line));
	}
	return out;
}

export class DiaryView {
	readonly el = el("details", "rj-diary");
	private readonly days = el("select", "");
	private readonly older = el("button", "rj-secondary", "‹ 前の日");
	private readonly newer = el("button", "rj-secondary", "次の日 ›");
	private readonly memory = el("button", "rj-secondary", "長期記憶");
	private readonly status = el("span", "rj-note");
	private readonly page = el("div", "rj-excerpt rj-diary-page");
	private send: ((m: ClientToHost) => void) | null = null;
	private aiId: string | null = null;
	/** The days it said have a diary, oldest first. */
	private known: string[] = [];
	/** The page being shown, "life" for the long-term memory. */
	private shown: string | null = null;
	/** The answer coming in. */
	private parts: string[] = [];
	private timer: ReturnType<typeof setTimeout> | null = null;

	constructor() {
		this.el.append(el("summary", "", "📔 日記"));
		const row = el("div", "rj-agent-row");
		for (const b of [this.older, this.newer, this.memory]) b.type = "button";
		row.append(this.older, this.days, this.newer, this.memory);
		this.page.hidden = true;
		this.el.append(
			el("span", "rj-note", "AIが書いた日記を読めます。AIがあなたと同じエリアにいるときだけ届きます。"),
			row,
			this.status,
			this.page,
		);
		this.el.ontoggle = () => {
			if (this.el.open) this.ask(this.shown === "life" ? "life" : (this.shown ?? undefined));
		};
		this.days.onchange = () => this.ask(this.days.value);
		this.older.onclick = () => this.step(-1);
		this.newer.onclick = () => this.step(1);
		this.memory.onclick = () => this.ask("life");
		this.renderNav();
	}

	/** How to ask the host (the page's connection), once there is one. */
	connect(send: (m: ClientToHost) => void): void {
		this.send = send;
	}

	/** The AI this panel is about (null: none). Its diary is asked for at once if open, else when opened. */
	setAi(id: string | null): void {
		if (id === this.aiId) return;
		this.aiId = id;
		this.known = [];
		this.shown = null;
		// what was on its way was the other AI's
		this.parts = [];
		this.done();
		this.page.replaceChildren();
		this.page.hidden = true;
		this.status.textContent = "";
		this.renderNav();
		if (this.el.open) this.ask();
	}

	/** A part of the answer (DIARY): shown once all of it is here. */
	receive(m: DiaryMsg): void {
		if (m.id !== this.aiId) return;
		if (m.part === 0) {
			this.parts = [];
			if (m.days) this.known = m.days;
		}
		if (m.part !== this.parts.length) return;
		this.parts.push(m.text);
		if (this.parts.length < m.parts) return;
		this.done();
		this.shown = m.day;
		const text = this.parts.join("");
		this.parts = [];
		const today = jstToday();
		if (m.day === null) this.status.textContent = "まだ日記がありません。";
		else if (m.day === "life")
			this.status.textContent = text.trim()
				? "長期記憶（夜のふり返りで書き直される）"
				: "まだ長期記憶がありません。";
		else
			this.status.textContent = `${dayLabel(m.day, today)}${text.trim() ? "" : "：この日の日記はありません。"}`;
		this.page.replaceChildren(...diaryNodes(text));
		this.page.hidden = !text.trim();
		this.page.scrollTop = 0;
		this.renderNav();
	}

	private ask(day?: string): void {
		if (!this.send || !this.aiId) return;
		this.send({ t: "DIARY_ASK", id: this.aiId, ...(day ? { day } : {}) });
		this.parts = [];
		this.status.textContent = "AIに日記を見せてもらっています…";
		this.done();
		this.timer = setTimeout(() => {
			this.timer = null;
			this.status.textContent = "日記が届きませんでした。AIが同じエリアにいるか確かめてください。";
		}, DIARY_TTL_MS);
	}

	private done(): void {
		if (this.timer !== null) clearTimeout(this.timer);
		this.timer = null;
	}

	/** One day older (-1) or newer (1) among the days with a diary. */
	private step(by: -1 | 1): void {
		const i = this.shown && this.shown !== "life" ? this.known.indexOf(this.shown) : this.known.length;
		const day = this.known[i + by];
		if (day) this.ask(day);
	}

	private renderNav(): void {
		const today = jstToday();
		this.days.replaceChildren(
			...[...this.known].reverse().map((d) => {
				const o = el("option", "", dayLabel(d, today));
				o.value = d;
				return o;
			}),
		);
		const day = this.shown && this.shown !== "life" ? this.shown : null;
		if (day && this.known.includes(day)) this.days.value = day;
		else this.days.selectedIndex = -1;
		this.days.hidden = this.known.length === 0;
		const i = day ? this.known.indexOf(day) : this.known.length;
		this.older.disabled = i <= 0;
		this.newer.disabled = day === null || i < 0 || i >= this.known.length - 1;
		this.memory.classList.toggle("on", this.shown === "life");
	}
}
