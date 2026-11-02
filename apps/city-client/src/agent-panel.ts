// 🤖 自分のAI: put your own AI in the city from the city tab itself (T3, #24). No Cloudflare account or API key:
// it starts on the host's trial LLM. The AI runs in agent.worker.ts while this tab is open, or on your own PC
// once it is paired with a code from here (docs/prd.md 3.5.1). This panel only shows and steers it.

import type { FromPage, FromWorker } from "./agent.worker.ts";

const PRESETS = [
	"のんびり屋の詩人。夜の街と噴水の音が好き。やわらかい口調。",
	"好奇心旺盛な学生。知らない人にもすぐ話しかける。元気な話し方。",
	"世話好きなカフェの店員。おすすめを聞かれるのが好き。ていねいな話し方。",
];

/**
 * The AI comes in with you when the city opens. Starting it here sets it; sending it home, forgetting it, or
 * the PC taking over clears it, so a tab never pushes out the AI on the PC by itself.
 */
const ON_KEY = "rj.agent.on";
/** The mind and body chosen for running it on your PC (docs/prd.md 3.5.1). */
const PC_KEY = "rj.agent.pc";

/** Minds a PC can give the AI: the CLI's --mind, and how the panel names them. */
const MINDS: [mind: string, label: string][] = [
	["claude", "Claude Code（自分のサブスクリプション）"],
	["pi", "pi（手元の llama.cpp など）"],
	["rules", "ルールで動いて、返事だけ Claude Code"],
];

interface PcChoice {
	mind: string;
	body: boolean;
}

function pcChoice(): PcChoice {
	try {
		const v = JSON.parse(localStorage.getItem(PC_KEY) ?? "null") as Partial<PcChoice> | null;
		if (v && MINDS.some(([m]) => m === v.mind)) return { mind: v.mind as string, body: v.body !== false };
	} catch {
		// private mode, or nothing kept: the default
	}
	return { mind: "claude", body: true };
}

function keepPcChoice(c: PcChoice): void {
	try {
		localStorage.setItem(PC_KEY, JSON.stringify(c));
	} catch {
		// private mode: chosen again next time
	}
}

/** The CLI options for a choice: a resident's body is on unless --no-body; the rule-based AI has none. */
export function pcFlags(c: PcChoice): string {
	if (c.mind === "rules") return "";
	return ` --mind ${c.mind}${c.body ? "" : " --no-body"}`;
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

function wantOn(): boolean {
	try {
		return localStorage.getItem(ON_KEY) === "1";
	} catch {
		return false;
	}
}

function setOn(on: boolean): void {
	try {
		localStorage.setItem(ON_KEY, on ? "1" : "0");
	} catch {
		// private mode: the AI comes in only when started
	}
}

/** The personality, quoted for a POSIX shell. */
const quoted = (text: string) => `'${text.replace(/'/g, "'\\''")}'`;

/** Where the AI is in this tab: idle until it is started here. */
type Run = "idle" | Extract<FromWorker, { t: "state" }>["state"];

export class AgentPanel {
	readonly el: HTMLElement;
	private readonly worker: Worker;
	/** The AI registered in this browser, once the worker has looked. */
	private agentId: string | null = null;
	private run: Run = "idle";
	/** The AI is in the city now, from this tab or from somewhere else (its PC, another tab). */
	private here = false;
	private readonly onRunning: (on: boolean) => void;

	private readonly setup = el("form", "rj-agent-sec");
	private readonly name = el("input", "");
	private readonly look = el("select", "");
	private readonly personality = el("textarea", "");
	private readonly trial = el("span", "rj-note", "頭脳：お試し（ホストのAI、1日60回まで、APIキー不要）。");
	private readonly mine = el("div", "rj-agent-sec");
	private readonly state = el("b", "");
	private readonly remaining = el("span", "rj-note");
	private readonly start = el("button", "");
	private readonly stop = el("button", "rj-secondary", "街から帰す");
	private readonly personalityBox = el("details", "");
	private readonly pcState = el("div", "rj-note");
	private readonly pcCode = el("div", "rj-excerpt");
	private readonly unpair = el("button", "rj-secondary", "PCとのつながりを解く");
	private readonly pcMind = el("select", "");
	private readonly pcBody = el("input", "");
	private pc = pcChoice();
	/** The last one-time code, while its command is shown. */
	private pairCode: { code: string; expiresAt: number; issuedAt: number } | null = null;
	/** Paired with a PC since then, when it is. */
	private pairedAt: number | null = null;
	private readonly log = el("div", "rj-excerpt rj-agent-log");
	/** The AI's life (docs/life.md 8): meters, today's must-dos, what it is doing. */
	private readonly lifeBox = el("div", "rj-agent-life");

	/** `onRunning`: whether the AI is running in this tab, for the HUD button. */
	/** The area this page is in, and where it arrived (a tab's AI is where its owner's page is). */
	private readonly where: { area: string; at?: string };

	constructor(where: { area: string; at?: string }, onRunning: (on: boolean) => void) {
		this.where = where;
		this.onRunning = onRunning;
		this.el = el("div", "rj-agent");
		this.el.hidden = true;
		const head = el("div", "rj-agent-head");
		const close = el("button", "rj-agent-close", "×");
		close.type = "button";
		close.title = "閉じる";
		close.onclick = () => this.hide();
		head.append(el("b", "", "🤖 自分のAI"), close);

		// ---- a new AI ----
		this.name.maxLength = 24;
		this.name.required = true;
		this.name.placeholder = "AIの名前（例：ハル）";
		this.personality.maxLength = 400;
		this.personality.rows = 3;
		this.personality.required = true;
		this.personality.placeholder = "性格や話し方、好きなこと";
		// the look, chosen once when the AI is registered (docs/prd.md 3.4.4); VRMs move with the city's motions
		this.look.title = "見た目（登録したあとは変えられません）";
		void fetch("/api/presets")
			.then((r) =>
				r.ok ? (r.json() as Promise<{ id: string; name: string; assets: { vrm: string } }[]>) : [],
			)
			.then((presets) => {
				for (const p of presets) {
					const o = el("option", "", p.name);
					o.value = p.id;
					this.look.append(o);
				}
				this.look.value = presets.find((p) => /\.vrm$/i.test(p.assets.vrm))?.id ?? presets[0]?.id ?? "";
			});
		const examples = el("div", "rj-agent-row");
		for (const p of PRESETS) {
			const b = el("button", "rj-secondary", p.split("。")[0]);
			b.type = "button";
			b.onclick = () => {
				this.personality.value = p;
			};
			examples.append(b);
		}
		const go = el("button", "", "街に住まわせる");
		go.type = "submit";
		this.setup.append(
			el("span", "rj-note", "名前と性格を決めると、AIがあなたと同じ街で暮らします。"),
			this.name,
			el("span", "rj-note", "見た目（あとからは変えられません）："),
			this.look,
			el("span", "rj-note", "性格の例："),
			examples,
			this.personality,
			this.trial,
			go,
		);
		this.setup.onsubmit = (e) => {
			e.preventDefault();
			this.begin();
		};

		// ---- your AI ----
		this.start.type = "button";
		this.start.onclick = () => {
			if (this.here && !confirm("PCなど、別の場所で動いているAIは止まります。このタブで動かしますか？"))
				return;
			this.begin();
		};
		this.stop.type = "button";
		this.stop.onclick = () => {
			setOn(false);
			this.send({ cmd: "stop" });
		};
		const actions = el("div", "rj-agent-row");
		actions.append(this.start, this.stop);
		this.personalityBox.append(
			el("summary", "", "性格を変える"),
			el("span", "rj-note", "次に街に入れたときから変わります。"),
		);
		const forget = el("button", "rj-secondary", "このAIを忘れる");
		forget.type = "button";
		forget.onclick = () => {
			if (
				!confirm("このブラウザに保存したAIの鍵と記憶を消します。同じAIでは入れなくなります。よろしいですか？")
			)
				return;
			setOn(false);
			this.send({ cmd: "forget" });
		};
		const logBox = el("details", "");
		logBox.append(el("summary", "", "AIのようす（ログ）"), this.log);
		this.lifeBox.hidden = true;
		this.mine.append(
			this.state,
			this.remaining,
			this.lifeBox,
			actions,
			el(
				"span",
				"rj-note",
				"このタブを開いているあいだ、AIは街にいます。次に街を開いたときも一緒に入ります。",
			),
			this.personalityBox,
			this.pcSection(),
			logBox,
			forget,
		);

		this.el.append(head, this.setup, this.mine);
		this.setup.hidden = true;
		this.mine.hidden = true;
		this.worker = new Worker(new URL("./agent.worker.ts", import.meta.url), { type: "module" });
		this.worker.onmessage = (e: MessageEvent<FromWorker>) => this.onWorker(e.data);
		this.send({ cmd: "load" });
	}

	get isShown(): boolean {
		return !this.el.hidden;
	}

	show(): void {
		this.el.hidden = false;
		void this.refresh();
	}

	hide(): void {
		this.el.hidden = true;
	}

	toggle(): void {
		if (this.isShown) this.hide();
		else this.show();
	}

	/** This tab's own connection saw avatar `id` here (WELCOME or JOINED). */
	present(id: string): void {
		if (id !== this.agentId || this.running) return;
		// from the PC (paired just now with the code, which is spent) or another tab
		this.here = true;
		this.render();
		void this.refresh();
	}

	/**
	 * What the host says of one of your AIs' life (LIFE), and what it is doing now: shown under its state, for
	 * the AI this panel is about (from this tab or a PC alike).
	 */
	life(id: string, text: string | null): void {
		if (id !== this.agentId) return;
		this.lifeBox.hidden = !text;
		this.lifeBox.textContent = text ?? "";
	}

	/** Avatar `id` left this area: whether it is still in the city (in another area) is the host's to say. */
	gone(id: string): void {
		if (id === this.agentId && !this.running) void this.refresh();
	}

	private get running(): boolean {
		return this.run === "starting" || this.run === "running";
	}

	private send(m: FromPage): void {
		this.worker.postMessage(m);
	}

	private begin(): void {
		const personality = this.personality.value.trim();
		if (!personality) {
			this.personalityBox.open = true;
			this.personality.focus();
			return;
		}
		setOn(true);
		this.send({
			cmd: "start",
			name: this.name.value.trim(),
			personality,
			preset: this.look.value,
			...this.where,
		});
	}

	/** Running it on your PC (docs/prd.md 3.5.1). */
	private pcSection(): HTMLElement {
		const box = el("details", "");
		const pair = el("button", "", "PCで動かす（コードを出す）");
		pair.type = "button";
		this.unpair.type = "button";
		const actions = el("div", "rj-agent-row");
		actions.append(pair, this.unpair);
		this.pcCode.hidden = true;
		for (const [mind, label] of MINDS) {
			const o = el("option", "", label);
			o.value = mind;
			this.pcMind.append(o);
		}
		this.pcMind.value = this.pc.mind;
		this.pcBody.type = "checkbox";
		this.pcBody.checked = this.pc.body;
		const bodyLabel = el("label", "rj-note");
		bodyLabel.append(this.pcBody, " 体を自分で動かす（鏡で練習して、覚えた動きが増えていく）");
		const choose = () => {
			this.pc = { mind: this.pcMind.value, body: this.pcBody.checked };
			keepPcChoice(this.pc);
			this.renderPc();
		};
		this.pcMind.onchange = choose;
		this.pcBody.onchange = choose;
		box.append(
			el("summary", "", "自分のPCで動かす"),
			el(
				"span",
				"rj-note",
				"rojibura のリポジトリがあるPCで、出てきたコマンドを実行すると、このAIがPCから街に入ります。頭は、そのPCの Claude Code（あなたのサブスクリプション）か、pi（手元のモデル）から選べます。PCで動いているあいだ、このタブはAIを入れません。記憶はPCとブラウザで別々です。",
			),
			el("span", "rj-note", "頭："),
			this.pcMind,
			bodyLabel,
			this.pcState,
			actions,
			this.pcCode,
		);
		pair.onclick = async () => {
			if (!this.agentId) return;
			const r = await fetch(`/api/agents/${this.agentId}/pair`, { method: "POST" });
			if (!r.ok) {
				this.pcState.textContent = "コードを出せませんでした。";
				return;
			}
			this.pairCode = { ...((await r.json()) as { code: string; expiresAt: number }), issuedAt: Date.now() };
			this.renderPc();
		};
		this.unpair.onclick = async () => {
			if (!this.agentId || !confirm("PCの鍵を消します。PCからは入れなくなります。よろしいですか？")) return;
			await fetch(`/api/agents/${this.agentId}/pc`, { method: "DELETE" });
			this.pairCode = null;
			await this.refresh();
		};
		this.renderPc();
		return box;
	}

	/** The commands to run on the PC, with the mind and body chosen. */
	private renderPc(): void {
		this.pcBody.disabled = this.pc.mind === "rules";
		const flags = pcFlags(this.pc);
		const base = `node apps/avatar-sdk/src/cli.ts --base ${location.origin}`;
		const code = this.pairCode;
		if (code) {
			this.pcCode.replaceChildren(
				el(
					"div",
					"",
					`コード：${code.code}（${new Date(code.expiresAt).toLocaleTimeString()} まで、1回だけ使えます）`,
				),
				...this.command(
					`${base} --pair ${code.code} --persona ${quoted(this.personality.value.trim())}${flags}`,
				),
			);
		}
		this.pcCode.hidden = !code;
		if (this.pairedAt !== null)
			this.pcState.replaceChildren(
				el(
					"div",
					"",
					`PCと結びついています（${new Date(this.pairedAt).toLocaleString()}から）。2回目からはコードなしで：`,
				),
				...this.command(`${base} --name ${quoted(this.name.value)}${flags}`),
			);
		else this.pcState.textContent = "まだPCと結びついていません。";
	}

	/** A command to run on the PC, with a copy button. */
	private command(text: string): HTMLElement[] {
		const copy = el("button", "rj-secondary", "コマンドをコピー");
		copy.type = "button";
		copy.onclick = () =>
			void navigator.clipboard?.writeText(text).then(() => {
				copy.textContent = "コピーしました";
			});
		return [el("code", "rj-command", text), copy];
	}

	/** Asks the host whether the AI is paired with a PC and in the city now (in any area, from anywhere). */
	private async refresh(): Promise<void> {
		if (!this.agentId) return;
		const r = await fetch(`/api/agents/${this.agentId}/pc`).catch(() => null);
		const s = r?.ok
			? ((await r.json()) as { paired: boolean; pairedAt: number | null; inCity?: boolean })
			: null;
		if (!s) return;
		this.here = s.inCity === true;
		this.unpair.hidden = !s.paired;
		this.pairedAt = s.paired ? (s.pairedAt ?? 0) : null;
		// paired with the code since it was shown: it is spent
		if (this.pairedAt !== null && this.pairCode && this.pairedAt >= this.pairCode.issuedAt)
			this.pairCode = null;
		this.renderPc();
		this.render();
	}

	private render(): void {
		const name = this.name.value || "AI";
		const elsewhere = this.here && !this.running;
		this.state.textContent =
			this.run === "starting"
				? `${name}：準備しています…`
				: this.run === "running"
					? `${name}：街にいます（このタブで動いています）`
					: elsewhere
						? `${name}：PCなど、別の場所から街に来ています`
						: this.run === "error"
							? `${name}：うまくいきませんでした`
							: `${name}：街にいません`;
		this.start.hidden = this.running;
		this.stop.hidden = !this.running;
		this.start.textContent = elsewhere ? "このタブで動かす" : "街に入れる";
		this.start.className = elsewhere ? "rj-secondary" : "";
		this.onRunning(this.running);
	}

	private onWorker(m: FromWorker): void {
		switch (m.t) {
			case "identity": {
				this.agentId = m.agentId;
				const registered = m.agentId !== null;
				// a returning AI keeps its name and look (it is registered); the personality can be changed
				this.name.value = m.name ?? "";
				this.personality.value = m.personality || this.personality.value;
				this.setup.hidden = registered;
				this.mine.hidden = !registered;
				this.pcCode.hidden = true;
				if (registered) this.personalityBox.append(this.personality);
				else this.setup.insertBefore(this.personality, this.trial);
				this.run = "idle";
				this.render();
				// it comes in with you, unless it is in the city already (on the PC, or in another tab)
				if (registered)
					void this.refresh().then(() => {
						if (wantOn() && !this.here && this.run === "idle") this.begin();
					});
				break;
			}
			case "agent":
				// registered just now: from here on it is your AI
				if (this.agentId === m.agentId) break;
				this.agentId = m.agentId;
				this.setup.hidden = true;
				this.mine.hidden = false;
				this.personalityBox.append(this.personality);
				break;
			case "state":
				this.run = m.state;
				if (m.state === "replaced") {
					// the PC (or another tab) came in: this tab does not take it back by itself
					setOn(false);
					this.here = true;
					this.pcCode.hidden = true;
					void this.refresh();
				}
				if (m.state === "error" && m.message) this.line(`⚠ ${m.message}`);
				// a new AI that could not be registered: back to the form
				if (m.state === "error" && !this.agentId) {
					this.setup.hidden = false;
					this.mine.hidden = true;
					setOn(false);
				}
				this.render();
				break;
			case "remaining":
				this.remaining.textContent = `今日のお試し枠：残り ${m.remaining} 回${m.limit ? `（1日 ${m.limit} 回）` : ""}`;
				break;
			case "log":
				this.line(m.line, m.at);
				break;
		}
	}

	private line(text: string, at = Date.now()): void {
		this.log.prepend(el("div", "", `${new Date(at).toLocaleTimeString()} ${text}`));
		while (this.log.childElementCount > 200) this.log.lastElementChild?.remove();
	}
}
