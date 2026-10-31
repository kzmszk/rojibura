// The build menu (free play, docs/prd.md 3.7): pick a model, its colour, size and name, then click the
// ground to place it (Q/E turn it); or switch to "消す" and click something built to take it down.

import { BUILD_COLORS, type ModelInfo, modelUrl } from "@rojibura/protocol";
import { api } from "./api.ts";

export type BuildTool = "place" | "remove";

/** What a click will build. */
export interface BuildChoice {
	model: string;
	walkable: boolean;
	color?: string;
	scale?: number;
	size?: [number, number, number];
	label?: string;
}

const COLOR_NAMES: Record<string, string> = {
	white: "白",
	black: "黒",
	gray: "灰",
	red: "赤",
	orange: "橙",
	yellow: "黄",
	green: "緑",
	blue: "青",
	purple: "紫",
	pink: "桃",
	brown: "茶",
	beige: "ベージュ",
};
const SCALES: [string, number][] = [
	["小", 0.75],
	["中", 1],
	["大", 1.5],
];

function el<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	cls = "",
	text?: string,
): HTMLElementTagNameMap[K] {
	const e = document.createElement(tag);
	if (cls) e.className = cls;
	if (text !== undefined) e.textContent = text;
	return e;
}

export class BuildPanel {
	readonly el = el("div", "rj-build");
	tool: BuildTool = "place";
	/** Degrees; Q and E turn it. */
	rot = 0;
	private models: ModelInfo[] = [];
	private model = "house";
	private color: string | undefined;
	private scale = 1;
	private readonly blockSize = [2, 2, 2];
	private readonly list = el("div", "rj-build-models");
	private readonly colors = el("div", "rj-build-colors");
	private readonly sizes = el("div", "rj-build-row");
	private readonly label = el("input");
	private readonly turnText = el("span", "rj-build-hint");
	private readonly toolButtons: Record<BuildTool, HTMLButtonElement>;
	private readonly changed: () => void;

	constructor(changed: () => void) {
		this.changed = changed;
		const head = el("div", "rj-build-head");
		const close = el("button", "rj-usage-close", "×");
		close.type = "button";
		close.onclick = () => this.hide();
		head.append(el("b", "", "🧱 建てる（自由モード）"), close);
		const tools = el("div", "rj-build-row");
		this.toolButtons = { place: el("button", "", "置く"), remove: el("button", "", "消す") };
		for (const [tool, b] of Object.entries(this.toolButtons) as [BuildTool, HTMLButtonElement][]) {
			b.type = "button";
			b.onclick = () => this.setTool(tool);
			tools.append(b);
		}
		this.label.placeholder = "名前（看板に出る、なくてもよい）";
		this.label.maxLength = 24;
		this.label.oninput = () => this.changed();
		this.el.append(
			head,
			tools,
			this.list,
			this.colors,
			this.sizes,
			this.label,
			this.turnText,
			el("span", "rj-build-hint", "クリックで置く／Q・E で回す／Esc で閉じる"),
		);
		this.renderColors();
		// set up without telling the page (it may not be ready yet)
		this.showTool("place");
		this.turnText.textContent = "向き：0°";
		this.el.hidden = true;
	}

	get open(): boolean {
		return !this.el.hidden;
	}

	async show(): Promise<void> {
		this.el.hidden = false;
		this.changed();
		try {
			this.models = (await (await api("/api/models")).json()) as ModelInfo[];
		} catch {
			this.models = [];
		}
		this.renderModels();
		this.renderSizes();
		this.changed();
	}

	hide(): void {
		this.el.hidden = true;
		this.changed();
	}

	toggle(): void {
		if (this.open) this.hide();
		else void this.show();
	}

	turn(deg: number): void {
		this.rot = (((this.rot + deg) % 360) + 360) % 360;
		this.turnText.textContent = `向き：${this.rot}°`;
		this.changed();
	}

	/** What a click builds now, or null while removing. */
	get current(): BuildChoice | null {
		if (this.tool !== "place") return null;
		const info = this.models.find((m) => m.id === this.model);
		const choice: BuildChoice = { model: this.model, walkable: info?.walkable ?? false };
		if (this.color) choice.color = this.color;
		if (this.model === "block") choice.size = [...this.blockSize] as [number, number, number];
		else if (!choice.walkable && this.scale !== 1) choice.scale = this.scale;
		const label = this.label.value.trim();
		if (label) choice.label = label;
		return choice;
	}

	private setTool(tool: BuildTool): void {
		this.showTool(tool);
		this.changed();
	}

	private showTool(tool: BuildTool): void {
		this.tool = tool;
		for (const [t, b] of Object.entries(this.toolButtons)) b.classList.toggle("on", t === tool);
		this.el.classList.toggle("removing", tool === "remove");
	}

	private renderModels(): void {
		this.list.replaceChildren();
		for (const m of this.models) {
			const b = el("button", "rj-build-model");
			b.type = "button";
			b.title = `${m.name}${m.walkable ? "（上を歩ける）" : ""}${m.byName ? `／${m.byName} さんのモデル` : ""}`;
			if (m.id === "block") b.append(el("span", "rj-build-block", "■"));
			else {
				const img = el("img");
				img.src = modelUrl(m.id, "png", true); // the menu is only in free play
				img.alt = "";
				img.onerror = () => img.replaceWith(el("span", "rj-build-block", "?"));
				b.append(img);
			}
			b.append(el("span", "", m.name));
			b.classList.toggle("on", m.id === this.model);
			b.onclick = () => {
				this.model = m.id;
				this.setTool("place");
				this.renderModels();
				this.renderSizes();
				this.changed();
			};
			this.list.append(b);
		}
	}

	private renderColors(): void {
		this.colors.replaceChildren();
		const swatch = (value: string | undefined, title: string, css: string) => {
			const b = el("button", "rj-swatch");
			b.type = "button";
			b.title = title;
			b.style.background = css;
			b.classList.toggle("on", this.color === value);
			b.onclick = () => {
				this.color = value;
				this.renderColors();
				this.changed();
			};
			this.colors.append(b);
		};
		swatch(undefined, "元の色", "linear-gradient(135deg, #fff 45%, #c44 50%, #fff 55%)");
		for (const [name, hex] of Object.entries(BUILD_COLORS)) swatch(hex, COLOR_NAMES[name] ?? name, hex);
	}

	private renderSizes(): void {
		this.sizes.replaceChildren();
		if (this.model === "block") {
			["幅", "高さ", "奥行き"].forEach((name, i) => {
				const input = el("input");
				input.type = "number";
				input.min = "0.2";
				input.max = i === 1 ? "50" : "30";
				input.step = "0.5";
				input.value = String(this.blockSize[i]);
				input.title = `${name}（m）`;
				input.oninput = () => {
					const v = Number(input.value);
					if (v >= 0.2 && v <= Number(input.max)) this.blockSize[i] = v;
					this.changed();
				};
				this.sizes.append(el("span", "rj-build-hint", name), input);
			});
			return;
		}
		if (this.models.find((m) => m.id === this.model)?.walkable) {
			this.sizes.append(el("span", "rj-build-hint", "上を歩けるモデルは大きさを変えられません"));
			return;
		}
		for (const [name, scale] of SCALES) {
			const b = el("button", "", name);
			b.type = "button";
			b.classList.toggle("on", this.scale === scale);
			b.onclick = () => {
				this.scale = scale;
				this.renderSizes();
				this.changed();
			};
			this.sizes.append(b);
		}
	}
}
