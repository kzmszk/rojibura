// The map (docs/prd.md 3.4.14): the area from straight above, where you are and which way you face, the main
// places and the gates; clicking one takes you there at once (WARP).

import type { Vec2 } from "@rojibura/protocol";

export interface MapPlace {
	id: string;
	name: string;
	pos: Vec2;
	/** Named on the map and listed to warp to; the others are dots, named when pointed at. */
	major: boolean;
	gate?: boolean;
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

export class MapView {
	readonly el = el("div", "rj-map");
	private readonly stage = el("div", "rj-map-stage");
	private readonly list = el("div", "rj-map-list");
	private readonly me = el("div", "rj-map-me", "▲");
	private readonly people = el("div", "rj-map-people");
	private readonly bounds: [number, number, number, number];
	private readonly draw: () => HTMLCanvasElement;
	private drawn = false;
	private readonly onWarp: (place: MapPlace) => void;

	/**
	 * `bounds`: what the map shows (x0, z0, x1, z1, metres); `draw` makes its picture (the first time it opens);
	 * `onWarp` takes you to a place.
	 */
	constructor(
		title: string,
		bounds: [number, number, number, number],
		draw: () => HTMLCanvasElement,
		onWarp: (place: MapPlace) => void,
	) {
		this.bounds = bounds;
		this.draw = draw;
		this.el.hidden = true;
		const close = el("button", "rj-settings-close", "×");
		close.type = "button";
		close.title = "閉じる（M）";
		close.onclick = () => this.hide();
		const head = el("div", "rj-settings-head");
		head.append(el("b", "", `🗺️ ${title}`), close);
		const body = el("div", "rj-map-body");
		this.stage.append(this.people, this.me);
		body.append(this.stage, this.list);
		this.el.append(head, body, el("div", "rj-map-note", "場所を押すと、そこへ瞬間移動します"));
		this.onWarp = onWarp;
	}

	/** The places to show (they may arrive after the map is made). */
	setPlaces(places: MapPlace[]): void {
		for (const m of this.stage.querySelectorAll(".rj-map-place")) m.remove();
		this.list.replaceChildren(el("div", "rj-map-head", "瞬間移動"));
		for (const p of places) {
			const [left, top] = this.at(p.pos);
			const mark = el("button", `rj-map-place${p.major ? " major" : ""}${p.gate ? " gate" : ""}`);
			mark.type = "button";
			mark.style.left = `${left}%`;
			mark.style.top = `${top}%`;
			mark.title = `${p.name}へ瞬間移動`;
			if (p.major) mark.append(el("span", "", p.name));
			mark.onclick = () => this.warp(p);
			this.stage.insertBefore(mark, this.people);
		}
		for (const p of [...places].filter((x) => x.major).sort((a, b) => Number(!!b.gate) - Number(!!a.gate))) {
			const b = el("button", "", `${p.gate ? "🚪" : "📍"} ${p.name}`);
			b.type = "button";
			b.onclick = () => this.warp(p);
			this.list.append(b);
		}
	}

	get open(): boolean {
		return !this.el.hidden;
	}

	show(): void {
		if (!this.drawn) {
			this.drawn = true;
			const picture = this.draw();
			picture.className = "rj-map-picture";
			this.stage.prepend(picture);
		}
		this.el.hidden = false;
		requestAnimationFrame(() => this.declutter());
	}

	/** Names that would overlap one shown before them are left out (the places first, then the gates). */
	private declutter(): void {
		const names = [...this.stage.querySelectorAll<HTMLElement>(".rj-map-place.major span")];
		names.sort(
			(a, b) =>
				Number(a.parentElement?.classList.contains("gate")) -
				Number(b.parentElement?.classList.contains("gate")),
		);
		const kept: DOMRect[] = [];
		for (const n of names) {
			n.style.visibility = "";
			const r = n.getBoundingClientRect();
			const hit = kept.some(
				(k) => r.left < k.right + 2 && r.right > k.left - 2 && r.top < k.bottom + 1 && r.bottom > k.top - 1,
			);
			if (hit) n.style.visibility = "hidden";
			else kept.push(r);
		}
	}

	hide(): void {
		this.el.hidden = true;
	}

	toggle(): void {
		if (this.open) this.hide();
		else this.show();
	}

	/** Where you are and which way you face (`heading`: the walking direction (sin, cos) in x, z); others too. */
	update(pos: Vec2 | null, heading: number, others: { pos: Vec2; ai: boolean }[]): void {
		if (!this.open) return;
		this.me.hidden = !pos;
		if (pos) {
			const [left, top] = this.at(pos);
			this.me.style.left = `${left}%`;
			this.me.style.top = `${top}%`;
			// ▲ points up the map (-z); turned clockwise to the heading
			this.me.style.transform = `translate(-50%, -50%) rotate(${Math.PI - heading}rad)`;
		}
		while (this.people.childElementCount > others.length) this.people.lastElementChild?.remove();
		while (this.people.childElementCount < others.length) this.people.append(el("i", ""));
		others.forEach((o, i) => {
			const dot = this.people.children[i] as HTMLElement;
			const [left, top] = this.at(o.pos);
			dot.style.left = `${left}%`;
			dot.style.top = `${top}%`;
			dot.className = o.ai ? "ai" : "";
		});
	}

	private warp(p: MapPlace): void {
		this.hide();
		this.onWarp(p);
	}

	/** A point as percentages of the map (left, top). */
	private at(p: Vec2): [number, number] {
		const [x0, z0, x1, z1] = this.bounds;
		return [((p[0] - x0) / (x1 - x0)) * 100, ((p[1] - z0) / (z1 - z0)) * 100];
	}
}
