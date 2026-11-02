// Shops (docs/prd.md 3.8.6): standing at a shop's counter offers "🛒 買う", which opens what it sells.

import { SHOP_REACH, type Shop, type ShopsData, type Vec2 } from "@rojibura/protocol";

export class ShopsUi {
	/** The button at the counter and the list it opens. */
	readonly el: HTMLElement;
	private shops: Shop[] = [];
	private readonly button: HTMLButtonElement;
	private readonly panel: HTMLElement;
	private here: Shop | null = null;
	private readonly onBuy: (shop: Shop, goods: string) => void;

	constructor(onBuy: (shop: Shop, goods: string) => void) {
		this.onBuy = onBuy;
		this.el = document.createElement("div");
		this.el.className = "rj-shop";
		this.button = document.createElement("button");
		this.button.type = "button";
		this.button.className = "rj-travel";
		this.button.hidden = true;
		this.button.onclick = () => this.toggle();
		this.panel = document.createElement("div");
		this.panel.className = "rj-shop-panel";
		this.panel.hidden = true;
		this.el.append(this.button, this.panel);
	}

	/** The area's shops (its dir has shops.json, or it has none). */
	async load(dir: string): Promise<void> {
		const r = await fetch(`${dir}/shops.json`).catch(() => null);
		const data = r?.ok ? ((await r.json().catch(() => null)) as ShopsData | null) : null;
		this.shops = data?.shops ?? [];
	}

	/** Where you stand now: at a counter, the button shows; walking away closes the list. */
	update(pos: Vec2 | null): void {
		const shop = pos
			? (this.shops.find(
					(s) => Math.hypot(s.counter[0] - pos[0], s.counter[1] - pos[1]) <= SHOP_REACH - 0.3,
				) ?? null)
			: null;
		if (shop === this.here) return;
		this.here = shop;
		this.button.hidden = !shop;
		this.panel.hidden = true;
		if (shop) this.button.textContent = `🛒 ${shop.name}で買う`;
	}

	private toggle(): void {
		const shop = this.here;
		if (!shop) return;
		if (!this.panel.hidden) {
			this.panel.hidden = true;
			return;
		}
		this.panel.replaceChildren();
		const title = document.createElement("div");
		title.className = "rj-shop-title";
		title.textContent = shop.name;
		this.panel.append(title);
		for (const g of shop.goods) {
			const row = document.createElement("button");
			row.type = "button";
			const dot = document.createElement("span");
			dot.className = "rj-shop-dot";
			dot.style.background = g.color;
			const name = document.createElement("span");
			name.textContent = g.name;
			const price = document.createElement("span");
			price.className = "rj-shop-price";
			price.textContent = `${g.price} ${shop.currency}`;
			row.append(dot, name, price);
			row.onclick = () => {
				this.panel.hidden = true;
				this.onBuy(shop, g.id);
			};
			this.panel.append(row);
		}
		this.panel.hidden = false;
	}
}
