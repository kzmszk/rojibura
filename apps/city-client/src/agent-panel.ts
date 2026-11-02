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
	private readonly log = el("div", "rj-excerpt rj-agent-log");

	/** `onRunning`: whether the AI is running in this tab, for the HUD button. */
	constructor(onRunning: (on: boolean) => void) {
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
		this.mine.append(
			this.state,
			this.remaining,
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
		this.send({ cmd: "start", name: this.name.value.trim(), personality, preset: this.look.value });
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
		box.append(
			el("summary", "", "自分のPCで動かす"),
			el(
				"span",
				"rj-note",
				"rojibura のリポジトリがあるPCで、出てきたコマンドを実行すると、このAIがPCから街に入ります（pi で動かすなら --mind pi を足します）。PCで動いているあいだ、このタブはAIを入れません。記憶はPCとブラウザで別々です。",
			),
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
			const { code, expiresAt } = (await r.json()) as { code: string; expiresAt: number };
			const command = `node apps/avatar-sdk/src/cli.ts --base ${location.origin} --pair ${code} --persona ${quoted(this.personality.value.trim())}`;
			this.pcCode.replaceChildren(
				el("div", "", `コード：${code}（${new Date(expiresAt).toLocaleTimeString()} まで、1回だけ使えます）`),
				...this.command(command),
			);
			this.pcCode.hidden = false;
		};
		this.unpair.onclick = async () => {
			if (!this.agentId || !confirm("PCの鍵を消します。PCからは入れなくなります。よろしいですか？")) return;
			await fetch(`/api/agents/${this.agentId}/pc`, { method: "DELETE" });
			this.pcCode.hidden = true;
			await this.refresh();
		};
		return box;
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
		if (s.paired) {
			const name = this.name.value;
			this.pcState.replaceChildren(
				el(
					"div",
					"",
					`PCと結びついています（${new Date(s.pairedAt ?? 0).toLocaleString()}から）。2回目からはコードなしで：`,
				),
				...this.command(`node apps/avatar-sdk/src/cli.ts --base ${location.origin} --name ${quoted(name)}`),
			);
		} else this.pcState.textContent = "まだPCと結びついていません。";
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
