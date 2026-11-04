// What you and your AI have now, always on screen (#53): your purse and what you hold; your AI's meters, purse,
// what it holds and today's must-dos (docs/life.md 2, 8). People have no meters, so only the AI's are shown.

import {
	type AvatarId,
	decay,
	energyWord,
	exerciseDue,
	type Item,
	type LifeState,
	MEALS_PER_DAY,
	WORK_MINUTES,
} from "@rojibura/protocol";

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

/** What a thing in someone's hand is called. */
export function itemName(item: Item | undefined): string {
	if (!item) return "なし";
	if (item.goods) return item.goods.name;
	return item.kind === "ball" ? "ボール" : "箱";
}

/** Today's must-dos in a line: "ごはん 1/2・仕事 30/60分・運動 ✓". */
export function dutiesText(life: LifeState): string {
	const d = life.duties;
	const work = d.work ? "✓" : `${Math.min(WORK_MINUTES, Math.round(d.worked ?? 0))}/${WORK_MINUTES}分`;
	const exercise = d.exercise ? "✓" : exerciseDue(life) ? "まだ" : "きのう済み";
	return `ごはん ${d.meals}/${MEALS_PER_DAY}・仕事か勉強 ${work}・運動 ${exercise}`;
}

interface AiShown {
	life: LifeState;
	coins?: number;
	doing?: { emoji: string; name: string } | null;
}

/** A meter as a short bar and its number. */
function meter(label: string, value: number, title: string): HTMLElement {
	const v = Math.round(Math.max(0, Math.min(100, value)));
	const box = el("span", "rj-meter");
	box.title = title;
	const bar = el("span", "rj-meter-bar");
	const fill = el("span", "rj-meter-fill");
	fill.style.width = `${v}%`;
	if (v < 20) fill.classList.add("low");
	bar.append(fill);
	box.append(el("span", "rj-meter-label", label), bar, el("span", "rj-meter-value", String(v)));
	return box;
}

export class StatusHud {
	readonly el = el("div", "rj-status rj-life-hud");
	private coins: number | undefined;
	private readonly ais = new Map<AvatarId, AiShown>();

	/**
	 * `name`: yours. `held`: what someone holds now (the items in the area). `now`: host time, so an AI's
	 * meters go down between the host's updates as they do on the host. Nothing is drawn until the host says
	 * what is in your purse or how your AI is.
	 */
	private readonly name: string;
	private readonly held: (id: AvatarId) => Item | undefined;
	private readonly now: () => number;
	private readonly myId: () => AvatarId | null;
	private readonly nameOf: (id: AvatarId) => string | undefined;

	constructor(
		name: string,
		held: (id: AvatarId) => Item | undefined,
		now: () => number,
		myId: () => AvatarId | null,
		nameOf: (id: AvatarId) => string | undefined,
	) {
		this.nameOf = nameOf;
		this.name = name;
		this.held = held;
		this.now = now;
		this.myId = myId;
		this.el.hidden = true;
		// the meters go down as time passes
		setInterval(() => {
			if (this.ais.size > 0) this.render();
		}, 10_000);
	}

	/** Your purse (WALLET); `earned` flashes it. */
	wallet(coins: number, earned: boolean): void {
		this.coins = coins;
		this.render();
		if (!earned) return;
		this.el.classList.remove("earned");
		void this.el.offsetWidth;
		this.el.classList.add("earned");
	}

	/** One of your AIs here (LIFE). */
	ai(id: AvatarId, shown: AiShown): void {
		this.ais.set(id, shown);
		this.render();
	}

	/** What one of your AIs is doing now (ACTING). */
	doing(id: AvatarId, badge: AiShown["doing"]): void {
		const a = this.ais.get(id);
		if (!a) return;
		a.doing = badge;
		this.render();
	}

	/** Only these are here (WELCOME): any other AI of yours is not. */
	only(here: Set<AvatarId>): void {
		for (const id of [...this.ais.keys()]) if (!here.has(id)) this.ais.delete(id);
		this.render();
	}

	/** One of your AIs left this area. */
	gone(id: AvatarId): void {
		if (this.ais.delete(id)) this.render();
	}

	/** Draws it again (something changed hands, say). */
	render(): void {
		if (this.coins === undefined && this.ais.size === 0) return;
		const me = this.myId();
		this.el.hidden = false;
		const rows: HTMLElement[] = [];
		const mine = el("div", "rj-life-row");
		mine.append(
			el("b", "rj-life-name", this.name || "あなた"),
			el("span", "", `👛 ${this.coins ?? "?"} 銅貨`),
			el("span", "", `✋ ${itemName(me ? this.held(me) : undefined)}`),
		);
		mine.title = "お店や宿で働くか、学校で勉強すると、お金が増える（1分で1銅貨）";
		rows.push(mine);
		const now = this.now();
		for (const [id, a] of this.ais) {
			const life = decay(a.life, now);
			const head = el("div", "rj-life-row");
			head.append(
				el("b", "rj-life-name", `🤖 ${this.nameOf(id) ?? "自分のAI"}`),
				el("span", "", `👛 ${a.coins ?? "?"} 銅貨`),
				el("span", "", `✋ ${itemName(this.held(id))}`),
				...(a.doing ? [el("span", "", `${a.doing.emoji} ${a.doing.name}`)] : []),
			);
			const meters = el("div", "rj-life-row");
			meters.append(
				meter("エネルギー", life.energy, `エネルギー（${energyWord(life.energy)}）。買って食べると増える`),
				meter("体力", life.fitness, "体力。運動すると増える"),
				meter("こころ", life.mood, "こころ。遊ぶ、話す、オーナーのそばにいると増える"),
			);
			const duties = el("div", "rj-life-row rj-life-duties", `今日：${dutiesText(life)}`);
			rows.push(head, meters, duties);
		}
		this.el.replaceChildren(...rows);
	}
}
