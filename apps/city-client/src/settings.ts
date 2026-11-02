// The settings (⚙️, docs/prd.md 3.4.12): what is not used all the time, out of the way of the city.

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

export class SettingsPanel {
	readonly el = el("div", "rj-settings");
	private readonly body = el("div", "rj-settings-body");

	constructor() {
		this.el.hidden = true;
		const close = el("button", "rj-settings-close", "×");
		close.type = "button";
		close.title = "閉じる";
		close.onclick = () => this.hide();
		const head = el("div", "rj-settings-head");
		head.append(el("b", "", "⚙️ 設定"), close);
		this.el.append(head, this.body);
	}

	get open(): boolean {
		return !this.el.hidden;
	}

	show(): void {
		this.el.hidden = false;
	}

	hide(): void {
		this.el.hidden = true;
	}

	toggle(): void {
		this.el.hidden = !this.el.hidden;
	}

	/** A line of the panel: a label and its controls (no label: the controls take the whole line). */
	row(label: string, ...controls: HTMLElement[]): HTMLElement {
		const row = el("div", "rj-settings-row");
		if (label) row.append(el("span", "rj-settings-label", label));
		row.append(...controls);
		this.body.append(row);
		return row;
	}
}
