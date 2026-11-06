// 🤖 自分のAI: put your own AIs in the city from the city tab itself (T3, #24). No Cloudflare account or API key:
// they start on the host's trial LLM. Each runs in its own agent.worker.ts while this tab is open, or on your own
// PC once it is paired with a code from here (docs/prd.md 3.5.1). This panel lists them, shows the one selected and
// steers them; which one is selected and which ones are running have nothing to do with each other.

import {
	deleteBrowserIdentity,
	listBrowserIdentities,
	loadBrowserIdentity,
	migrateLegacyBrowserIdentity,
	registerBrowserAgent,
	saveBrowserIdentity,
} from "@rojibura/avatar-sdk/browser";
import type { ClientToHost, HostToClient } from "@rojibura/protocol";
import type { FromPage, FromWorker } from "./agent.worker.ts";
import {
	type AgentPresence,
	carryOverWanted,
	describeAi,
	keepSelected,
	type OwnedAgent,
	type Run,
	selectedAgent,
	setWanted,
	staysOutAfter,
	wantedAgents,
} from "./agent-roster.ts";
import { DiaryView } from "./diary-view.ts";
import { outfitsOf, type PresetInfo } from "./outfits.ts";

const PRESETS = [
	"のんびり屋の詩人。夜の街と噴水の音が好き。やわらかい口調。",
	"好奇心旺盛な学生。知らない人にもすぐ話しかける。元気な話し方。",
	"世話好きなカフェの店員。おすすめを聞かれるのが好き。ていねいな話し方。",
];

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

/** The personality, quoted for a POSIX shell. */
const quoted = (text: string) => `'${text.replace(/'/g, "'\\''")}'`;

/** One of the owner's AIs: what is known of it, and what this tab is doing with it. */
interface AiEntry {
	agent: OwnedAgent;
	presence: AgentPresence | null;
	/** This browser holds its key. */
	hasKey: boolean;
	/** Kept with the key, so known only where that is. */
	personality: string;
	run: Run;
	/** Why it is not running, in the owner's words. */
	reason: string | null;
	/** Its own worker, while it runs in this tab. */
	worker: Worker | null;
	/** What the host last said of its life (LIFE), while it is in this area. */
	life: string | null;
	/** Its log, kept apart from the others'. */
	log: HTMLElement;
	/** The last one-time code, while its command is shown. */
	pairCode: { code: string; expiresAt: number; issuedAt: number } | null;
}

export class AgentPanel {
	readonly el: HTMLElement;
	/** The logged-in owner, once the host has said. */
	private owner: string | null = null;
	private readonly entries = new Map<string, AiEntry>();
	private selected: string | null = null;
	/** Showing the form for a new AI instead of the selected one. */
	private adding = false;
	private agentLimit: number | null = null;
	private agentsAtOnce: number | null = null;
	private readonly onRunning: (running: number) => void;

	private readonly problem = el("div", "rj-agent-reason");
	private readonly summary = el("span", "rj-note");
	private readonly list = el("div", "rj-agent-list");
	private readonly add = el("button", "rj-secondary", "＋ 新しいAIを追加");
	private readonly reload = el("button", "rj-secondary", "↻ 最新の状況を見る");

	private readonly setup = el("form", "rj-agent-sec");
	private readonly name = el("input", "");
	private readonly look = el("select", "");
	private readonly newPersonality = el("textarea", "");
	private readonly trial = el("span", "rj-note", "頭脳：お試し（ホストのAI、1日60回まで、APIキー不要）。");
	private readonly go = el("button", "", "街に住まわせる");
	private readonly setupBack = el("button", "rj-secondary", "やめる");
	private readonly setupError = el("div", "rj-agent-reason");

	private readonly mine = el("div", "rj-agent-sec");
	private readonly state = el("b", "");
	private readonly reason = el("div", "rj-agent-reason");
	private readonly placeNote = el("span", "rj-note");
	private readonly remaining = el("span", "rj-note");
	private readonly start = el("button", "");
	private readonly stop = el("button", "rj-secondary", "街から帰す");
	private readonly personalityBox = el("details", "");
	private readonly personality = el("textarea", "");
	private readonly personalityNote = el(
		"span",
		"rj-note",
		"性格は、AIを動かす端末に保存されています。このブラウザには鍵がないので、ここでは見られません。",
	);
	/** Changing the AI's outfit (shown only if its character has more than one). */
	private readonly outfitBox = el("details", "");
	private readonly outfit = el("select", "");
	private readonly outfitNote = el("span", "rj-note", "次に街に入れたときから変わります。");
	private readonly pcState = el("div", "rj-note");
	private readonly pcCode = el("div", "rj-excerpt");
	private readonly unpair = el("button", "rj-secondary", "PCとのつながりを解く");
	private readonly pcMind = el("select", "");
	private readonly pcBody = el("input", "");
	private pc = pcChoice();
	private readonly logSlot = el("div", "");
	/** The AI's life (docs/life.md 8): meters, today's must-dos, what it is doing. */
	private readonly lifeBox = el("div", "rj-agent-life");
	/** What can be seen of it from here, when that is not everything. */
	private readonly lifeNote = el("span", "rj-note");
	/** Its diary, read where it runs (docs/life.md 8). */
	private readonly diaryView = new DiaryView();
	private readonly remove = el("button", "rj-secondary", "このAIを削除する");
	private readonly removeNote = el("span", "rj-note");

	/** Asking the host, one at a time: what comes in meanwhile asks once more when that is done. */
	private loading: Promise<void> = Promise.resolve();
	private loadAgain: Promise<void> | null = null;

	/** The area this page is in, and where it arrived (a tab's AI is where its owner's page is). */
	private readonly where: { area: string; at?: string };

	/** `onRunning`: how many AIs are running in this tab, for the HUD button. */
	constructor(where: { area: string; at?: string }, onRunning: (running: number) => void) {
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

		// ---- the list ----
		this.add.type = "button";
		this.add.onclick = () => {
			this.adding = true;
			this.setupError.textContent = "";
			this.render();
		};
		this.reload.type = "button";
		this.reload.onclick = () => void this.refresh();
		const listActions = el("div", "rj-agent-row");
		listActions.append(this.add, this.reload);

		// ---- a new AI ----
		this.name.maxLength = 24;
		this.name.required = true;
		this.name.placeholder = "AIの名前（例：ハル）";
		this.newPersonality.maxLength = 400;
		this.newPersonality.rows = 3;
		this.newPersonality.required = true;
		this.newPersonality.placeholder = "性格や話し方、好きなこと";
		// the look, chosen once when the AI is registered (docs/prd.md 3.4.4); VRMs move with the city's motions
		this.look.title = "見た目（登録したあと、服装だけ変えられます）";
		void fetch("/api/presets")
			.then((r) =>
				r.ok
					? (r.json() as Promise<{ id: string; name: string; outfit?: string; assets: { vrm: string } }[]>)
					: [],
			)
			.then((presets) => {
				for (const p of presets) {
					const o = el("option", "", p.outfit ? `${p.name}（${p.outfit}）` : p.name);
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
				this.newPersonality.value = p;
			};
			examples.append(b);
		}
		this.go.type = "submit";
		this.setupBack.type = "button";
		this.setupBack.onclick = () => {
			this.adding = false;
			this.render();
		};
		const setupActions = el("div", "rj-agent-row");
		setupActions.append(this.go, this.setupBack);
		this.setup.append(
			el("span", "rj-note", "名前と性格を決めると、AIがあなたと同じ街で暮らします。"),
			this.name,
			el("span", "rj-note", "見た目（服装はあとから変えられます）："),
			this.look,
			el("span", "rj-note", "性格の例："),
			examples,
			this.newPersonality,
			this.trial,
			this.setupError,
			setupActions,
		);
		this.setup.onsubmit = (e) => {
			e.preventDefault();
			void this.register();
		};

		// ---- the AI selected ----
		this.start.type = "button";
		this.start.onclick = () => {
			const entry = this.current;
			if (!entry) return;
			const { elsewhere } = this.view(entry);
			if (elsewhere && !confirm("PCなど、別の場所で動いているAIは止まります。このタブで動かしますか？"))
				return;
			this.begin(entry);
		};
		this.stop.type = "button";
		this.stop.onclick = () => {
			const entry = this.current;
			if (!entry || !this.owner) return;
			setWanted(this.owner, entry.agent.id, false);
			entry.worker?.postMessage({ cmd: "stop" } satisfies FromPage);
		};
		const actions = el("div", "rj-agent-row");
		actions.append(this.start, this.stop);
		this.personality.maxLength = 400;
		this.personality.rows = 3;
		this.personality.placeholder = "性格や話し方、好きなこと";
		this.personality.onchange = () => void this.savePersonality();
		this.personalityBox.append(
			el("summary", "", "性格"),
			el("span", "rj-note", "変えると、次に街に入れたときから変わります。"),
			this.personality,
		);
		this.outfitBox.hidden = true;
		this.outfitBox.append(el("summary", "", "服装を変える"), this.outfitNote, this.outfit);
		this.outfit.onchange = () => void this.setOutfit(this.outfit.value);
		this.remove.type = "button";
		this.remove.onclick = () => void this.deleteAi();
		const logBox = el("details", "");
		logBox.append(el("summary", "", "AIのようす（ログ）"), this.logSlot);
		this.lifeBox.hidden = true;
		this.mine.append(
			this.state,
			this.reason,
			this.placeNote,
			this.remaining,
			this.lifeBox,
			this.lifeNote,
			actions,
			this.diaryView.el,
			el(
				"span",
				"rj-note",
				"このタブで動かしたAIは、タブを開いているあいだ街にいます。次に街を開いたときも一緒に入ります。",
			),
			this.personalityBox,
			this.personalityNote,
			this.outfitBox,
			this.pcSection(),
			logBox,
			this.remove,
			this.removeNote,
		);

		this.el.append(head, this.problem, this.summary, this.list, listActions, this.setup, this.mine);
		this.setup.hidden = true;
		this.mine.hidden = true;
		void this.refresh().then(() => this.comeIn());
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
		const entry = this.entries.get(id);
		if (!entry || this.view(entry).running) return;
		// from the PC (paired just now with the code, which is spent) or another tab
		if (entry.presence) entry.presence = { ...entry.presence, area: this.where.area };
		this.render();
		void this.refresh();
	}

	/**
	 * What the host says of one of your AIs' life (LIFE), and what it is doing now: kept for each of them and shown
	 * for the one selected (from this tab or a PC alike).
	 */
	life(id: string, text: string | null): void {
		const entry = this.entries.get(id);
		if (!entry) return;
		entry.life = text;
		if (id === this.selected) this.renderLife(entry);
	}

	/** How the diary is asked for: this page's own connection to the host. */
	connect(send: (m: ClientToHost) => void): void {
		this.diaryView.connect(send);
	}

	/** A part of one of your AIs' diary (DIARY), for the AI selected. */
	diary(m: Extract<HostToClient, { t: "DIARY" }>): void {
		this.diaryView.receive(m);
	}

	/** Avatar `id` left this area: whether it is still in the city (in another area) is the host's to say. */
	gone(id: string): void {
		const entry = this.entries.get(id);
		if (!entry) return;
		entry.life = null;
		if (!this.view(entry).running) void this.refresh();
		else if (id === this.selected) this.render();
	}

	private get current(): AiEntry | undefined {
		return this.selected === null ? undefined : this.entries.get(this.selected);
	}

	private view(entry: AiEntry) {
		return describeAi(entry);
	}

	/** Asks the host again, after whatever is being asked now. */
	private refresh(): Promise<void> {
		this.loadAgain ??= this.loading.then(() => {
			this.loadAgain = null;
			this.loading = this.load();
			return this.loading;
		});
		return this.loadAgain;
	}

	/** The owner's AIs, from the host (the list), this browser (the keys) and the rooms (where they are). */
	private async load(): Promise<void> {
		const r = await fetch("/api/me").catch(() => null);
		if (r?.status === 401) {
			this.logOut("ログインすると、自分のAIを街に住まわせられます。");
			return;
		}
		if (!r?.ok) {
			this.problem.textContent = "AIの一覧を読み込めませんでした。";
			return;
		}
		const me = (await r.json()) as {
			id: string;
			agents: OwnedAgent[];
			agentLimit: number | null;
			agentsAtOnce: number | null;
		};
		// another account logged in meanwhile: nothing of the last one's stays
		if (this.owner !== me.id) this.logOut("");
		this.owner = me.id;
		this.agentLimit = me.agentLimit;
		this.agentsAtOnce = me.agentsAtOnce;
		this.problem.textContent = "";
		const ids = me.agents.map((a) => a.id);
		const moved = await migrateLegacyBrowserIdentity(me.id, ids);
		if (moved) carryOverWanted(me.id, moved.agentId);
		const keys = new Map((await listBrowserIdentities(me.id)).map((i) => [i.agentId, i]));
		await this.dropDeleted(
			me.id,
			[...keys.keys()].filter((id) => !ids.includes(id)),
		);
		const status = await fetch("/api/agents/status")
			.then((s) => (s.ok ? (s.json() as Promise<{ agents: AgentPresence[] }>) : null))
			.catch(() => null);
		if (!status) this.problem.textContent = "AIの居場所を確かめられませんでした。";
		for (const [id, entry] of this.entries)
			if (!ids.includes(id)) {
				entry.worker?.terminate();
				this.entries.delete(id);
			}
		for (const agent of me.agents) {
			const key = keys.get(agent.id);
			const presence = status?.agents.find((a) => a.id === agent.id) ?? null;
			const entry = this.entries.get(agent.id);
			if (entry) {
				entry.agent = agent;
				entry.hasKey = key !== undefined;
				if (status) entry.presence = presence;
				if (key && document.activeElement !== this.personality) entry.personality = key.personality;
				continue;
			}
			this.entries.set(agent.id, {
				agent,
				presence,
				hasKey: key !== undefined,
				personality: key?.personality ?? "",
				run: "idle",
				reason: null,
				worker: null,
				life: null,
				log: el("div", "rj-excerpt rj-agent-log"),
				pairCode: null,
			});
		}
		for (const entry of this.entries.values()) {
			const paired = entry.presence?.pairedAt;
			// paired with the code since it was shown: it is spent
			if (entry.pairCode && paired != null && paired >= entry.pairCode.issuedAt) entry.pairCode = null;
		}
		if (this.selected === null || !this.entries.has(this.selected)) {
			const kept = selectedAgent(me.id);
			this.select(kept && this.entries.has(kept) ? kept : (ids[0] ?? null));
		} else this.render();
	}

	/**
	 * Keys here of AIs the host did not list: deleted on another device, so they let nothing in any more. Or just
	 * registered, after the list was asked for: a key is kept only once the host has the AI, so asking again now
	 * tells the two apart.
	 */
	private async dropDeleted(ownerId: string, unlisted: string[]): Promise<void> {
		if (unlisted.length === 0) return;
		const r = await fetch("/api/me").catch(() => null);
		if (!r?.ok) return;
		const me = (await r.json()) as { id: string; agents: OwnedAgent[] };
		if (me.id !== ownerId) return;
		for (const id of unlisted)
			if (!me.agents.some((a) => a.id === id)) {
				await deleteBrowserIdentity(ownerId, id);
				setWanted(ownerId, id, false);
			}
	}

	/** Forgets what was shown of an owner; `message`: what to show instead. */
	private logOut(message: string): void {
		for (const entry of this.entries.values()) entry.worker?.terminate();
		this.entries.clear();
		this.owner = null;
		this.selected = null;
		this.problem.textContent = message;
		this.diaryView.setAi(null);
		this.render();
	}

	/** The AIs that come in with you, unless they are in the city already (on the PC, or in another tab). */
	private comeIn(): void {
		if (!this.owner) return;
		for (const id of wantedAgents(this.owner)) {
			const entry = this.entries.get(id);
			if (entry?.hasKey && entry.run === "idle" && this.view(entry).canStart && !this.view(entry).elsewhere)
				this.begin(entry);
		}
	}

	private select(id: string | null): void {
		this.selected = id;
		this.adding = false;
		const entry = this.current;
		if (entry && this.owner) keepSelected(this.owner, entry.agent.id);
		this.diaryView.setAi(id);
		this.personality.value = entry?.personality ?? "";
		this.outfitBox.hidden = true;
		this.outfitNote.textContent = "次に街に入れたときから変わります。";
		this.render();
		void this.loadOutfits();
	}

	/** Starts the AI in a worker of its own: the others are not touched. */
	private begin(entry: AiEntry): void {
		if (!this.owner || entry.worker || !this.view(entry).canStart) return;
		entry.run = "starting";
		entry.reason = null;
		const worker = new Worker(new URL("./agent.worker.ts", import.meta.url), { type: "module" });
		entry.worker = worker;
		worker.onmessage = (e: MessageEvent<FromWorker>) => {
			if (entry.worker === worker) this.onWorker(entry, e.data);
		};
		worker.onerror = () => {
			if (entry.worker === worker)
				this.onWorker(entry, { t: "state", state: "error", message: "AIを動かせませんでした" });
		};
		worker.postMessage({
			cmd: "start",
			ownerId: this.owner,
			agentId: entry.agent.id,
			...this.where,
		} satisfies FromPage);
		this.render();
	}

	/** A new AI: its key is kept here beside the others, and it comes in at once. */
	private async register(): Promise<void> {
		if (!this.owner) return;
		const personality = this.newPersonality.value.trim();
		if (!personality) {
			this.newPersonality.focus();
			return;
		}
		this.go.disabled = true;
		this.setupError.textContent = "";
		try {
			const id = await registerBrowserAgent(
				location.origin,
				this.owner,
				this.name.value.trim(),
				personality,
				this.look.value,
			);
			this.name.value = "";
			this.newPersonality.value = "";
			await this.refresh();
			this.select(id.agentId);
			const entry = this.entries.get(id.agentId);
			if (entry) {
				this.line(entry, `「${id.name}」を登録しました（${id.agentId}）`);
				this.begin(entry);
			}
		} catch (err) {
			this.setupError.textContent = (err as Error).message;
		} finally {
			this.go.disabled = false;
		}
	}

	private async savePersonality(): Promise<void> {
		const entry = this.current;
		const text = this.personality.value.trim();
		if (!entry?.hasKey || !this.owner || !text) return;
		entry.personality = text;
		const key = await loadBrowserIdentity(this.owner, entry.agent.id);
		if (key) await saveBrowserIdentity(this.owner, { ...key, personality: text });
		this.renderPc();
	}

	/** Removes the AI from the host, then from this browser. The others go on. */
	private async deleteAi(): Promise<void> {
		const entry = this.current;
		const owner = this.owner;
		if (!entry || !owner) return;
		const id = entry.agent.id;
		if (
			!confirm(
				`「${entry.agent.name}」を削除します。登録、PCとのつながり、生活の記録、財布、このブラウザの鍵と記憶が消え、元に戻せません。PCや別の端末で動いていても街から出ます。よろしいですか？`,
			)
		)
			return;
		const r = await fetch(`/api/agents/${id}`, { method: "DELETE" }).catch(() => null);
		if (!r?.ok) {
			const body = (await r?.json().catch(() => null)) as { error?: string } | null;
			entry.reason = `削除できませんでした${body?.error ? `：${body.error}` : "。"}`;
			this.render();
			return;
		}
		entry.worker?.terminate();
		this.entries.delete(id);
		await deleteBrowserIdentity(owner, id);
		setWanted(owner, id, false);
		this.selected = null;
		await this.refresh();
		this.announceRunning();
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
			const entry = this.current;
			if (!entry) return;
			const r = await fetch(`/api/agents/${entry.agent.id}/pair`, { method: "POST" });
			if (!r.ok) {
				this.pcState.textContent = "コードを出せませんでした。";
				return;
			}
			entry.pairCode = { ...((await r.json()) as { code: string; expiresAt: number }), issuedAt: Date.now() };
			this.renderPc();
		};
		this.unpair.onclick = async () => {
			const entry = this.current;
			if (!entry || !confirm("PCの鍵を消します。PCからは入れなくなります。よろしいですか？")) return;
			await fetch(`/api/agents/${entry.agent.id}/pc`, { method: "DELETE" });
			entry.pairCode = null;
			await this.refresh();
		};
		return box;
	}

	/** The commands to run on the PC for the AI selected, with the mind and body chosen. */
	private renderPc(): void {
		const entry = this.current;
		this.pcBody.disabled = this.pc.mind === "rules";
		const flags = pcFlags(this.pc);
		const base = `node apps/avatar-sdk/src/cli.ts --base ${location.origin}`;
		const code = entry?.pairCode;
		if (code) {
			// the personality is known only where the key is; without it the PC starts from its own default
			const persona = entry?.personality ? ` --persona ${quoted(entry.personality)}` : "";
			this.pcCode.replaceChildren(
				el(
					"div",
					"",
					`コード：${code.code}（${new Date(code.expiresAt).toLocaleTimeString()} まで、1回だけ使えます）`,
				),
				...this.command(`${base} --pair ${code.code}${persona}${flags}`),
			);
		}
		this.pcCode.hidden = !code;
		const pairedAt = entry?.presence?.paired ? (entry.presence.pairedAt ?? 0) : null;
		this.unpair.hidden = pairedAt === null;
		if (pairedAt !== null)
			this.pcState.replaceChildren(
				el(
					"div",
					"",
					`PCと結びついています（${new Date(pairedAt).toLocaleString()}から）。2回目からはコードなしで：`,
				),
				...this.command(`${base} --name ${quoted(entry?.agent.name ?? "")}${flags}`),
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

	/** Fills the outfit choice from the AI's current look (the host keeps it), for characters with several outfits. */
	private async loadOutfits(): Promise<void> {
		const id = this.selected;
		if (!id) return;
		const [look, all] = await Promise.all([
			fetch(`/api/agents/${id}/look`)
				.then((r) => (r.ok ? (r.json() as Promise<{ preset: string }>) : null))
				.catch(() => null),
			fetch("/api/presets")
				.then((r) => (r.ok ? (r.json() as Promise<PresetInfo[]>) : []))
				.catch(() => []),
		]);
		if (!look || id !== this.selected) return;
		const outfits = outfitsOf(all, look.preset);
		this.outfit.replaceChildren();
		for (const p of outfits) {
			const o = el("option", "", p.outfit ?? p.name);
			o.value = p.id;
			this.outfit.append(o);
		}
		this.outfit.value = look.preset;
		this.outfitBox.hidden = outfits.length < 2;
	}

	/** Changes the AI's outfit on the host: it wears it from its next entry on. */
	private async setOutfit(preset: string): Promise<void> {
		const entry = this.current;
		if (!entry) return;
		const r = await fetch(`/api/agents/${entry.agent.id}/look`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ preset }),
		}).catch(() => null);
		if (entry !== this.current) return;
		const inCity = this.view(entry).running || this.view(entry).elsewhere;
		this.outfitNote.textContent = r?.ok
			? inCity
				? "変えました。いま街にいる間はそのままで、次に街に入れたときから変わります。"
				: "変えました。次に街に入れたときから変わります。"
			: "変えられませんでした。";
		if (!r?.ok) void this.loadOutfits();
	}

	private announceRunning(): void {
		this.onRunning([...this.entries.values()].filter((e) => this.view(e).running).length);
	}

	private render(): void {
		this.renderList();
		const entries = [...this.entries.values()];
		const loggedIn = this.owner !== null;
		const full = this.agentLimit !== null && entries.length >= this.agentLimit;
		// no AI yet: the form is all there is
		const adding = loggedIn && !full && (this.adding || entries.length === 0);
		this.setup.hidden = !adding;
		this.setupBack.hidden = entries.length === 0;
		this.add.hidden = !loggedIn || adding;
		this.add.disabled = full;
		this.reload.hidden = !loggedIn;
		const entry = this.current;
		this.mine.hidden = adding || !entry;
		if (entry && !adding) this.renderSelected(entry);
		this.announceRunning();
	}

	private renderList(): void {
		const entries = [...this.entries.values()];
		const inCity = entries.filter((e) => this.view(e).running || this.view(e).elsewhere).length;
		const registered =
			this.agentLimit === null ? `${entries.length}体` : `${entries.length}/${this.agentLimit}体`;
		const atOnce = this.agentsAtOnce === null ? "" : `（1エリアに同時に${this.agentsAtOnce}体まで）`;
		const full = this.agentLimit !== null && entries.length >= this.agentLimit;
		this.summary.textContent = this.owner
			? `登録 ${registered}、街にいるのは ${inCity}体${atOnce}${full ? "。登録の上限です（削除すると空きます）" : ""}`
			: "";
		this.list.replaceChildren(
			...entries.map((entry) => {
				const v = this.view(entry);
				const row = el(
					"button",
					`rj-agent-item${entry.agent.id === this.selected && !this.adding ? " on" : ""}`,
				);
				row.type = "button";
				row.setAttribute("aria-pressed", String(entry.agent.id === this.selected));
				row.onclick = () => this.select(entry.agent.id);
				const head = el("span", "rj-agent-item-head");
				head.append(el("b", "", entry.agent.name), el("span", "rj-agent-item-trust", v.trust));
				const live = v.running || v.elsewhere;
				row.append(
					head,
					el("span", `rj-agent-item-state${live ? " live" : ""}`, v.state),
					el("span", "rj-agent-item-place", v.place),
				);
				return row;
			}),
		);
		this.list.hidden = entries.length === 0;
	}

	private renderSelected(entry: AiEntry): void {
		const v = this.view(entry);
		this.state.textContent = `${entry.agent.name}：${v.state}`;
		this.reason.textContent = entry.reason ?? (v.running ? "" : (v.blocked ?? ""));
		this.placeNote.textContent = `${v.trust}。${v.place}。`;
		this.start.hidden = !v.canStart;
		this.stop.hidden = !v.running;
		this.start.textContent = v.elsewhere ? "このタブで動かす" : "街に入れる";
		this.start.className = v.elsewhere ? "rj-secondary" : "";
		this.renderLife(entry);
		this.personalityBox.hidden = !entry.hasKey;
		this.personalityNote.hidden = entry.hasKey;
		if (document.activeElement !== this.personality) this.personality.value = entry.personality;
		this.logSlot.replaceChildren(entry.log);
		const banned = entry.presence?.banned === true;
		this.remove.hidden = banned;
		this.removeNote.textContent = banned ? "利用停止中のAIは削除できません。" : "";
		this.renderPc();
	}

	private renderLife(entry: AiEntry): void {
		const v = this.view(entry);
		// its life and diary come through this page's connection: only from the same area
		const otherArea = !!entry.presence?.area && entry.presence.area !== this.where.area;
		this.lifeBox.hidden = !entry.life;
		this.lifeBox.textContent = entry.life ?? "";
		this.lifeNote.textContent =
			entry.life || v.running || (v.elsewhere && !otherArea)
				? ""
				: otherArea
					? "別のエリアにいるので、生活の状態と日記はこのエリアに届きません。"
					: "生活の状態と日記は、AIが同じエリアにいるときだけ届きます。";
	}

	private onWorker(entry: AiEntry, m: FromWorker): void {
		switch (m.t) {
			case "state":
				if (m.state === "starting" || m.state === "running") {
					entry.run = m.state;
					// it comes in with you from now on: once it has got in, so one turned away takes no one's place next time
					if (m.state === "running" && this.owner) setWanted(this.owner, entry.agent.id, true);
				} else {
					// it is out: the worker is done
					entry.worker?.terminate();
					entry.worker = null;
					entry.run = m.state;
					entry.life = null;
					if (m.state === "stopped" && entry.presence) entry.presence = { ...entry.presence, area: null };
					// sent home, the PC (or another tab) came in, or the host sent it out: this tab does not bring it back
					if (
						this.owner &&
						(m.state === "stopped" ||
							m.state === "replaced" ||
							(m.state === "error" && staysOutAfter(m.code ?? 0)))
					)
						setWanted(this.owner, entry.agent.id, false);
					if (m.state === "error") {
						entry.reason = m.message;
						this.line(entry, `⚠ ${m.message}`);
					}
					if (m.state !== "stopped") void this.refresh();
				}
				this.render();
				break;
			case "remaining":
				// the trial calls are the owner's, shared by all their AIs
				this.remaining.textContent = `今日のお試し枠：残り ${m.remaining} 回${m.limit ? `（1日 ${m.limit} 回）` : ""}${m.remaining <= 0 ? "。使い切ったので、明日まで考えて話すことができません" : ""}`;
				break;
			case "log":
				this.line(entry, m.line, m.at);
				break;
		}
	}

	private line(entry: AiEntry, text: string, at = Date.now()): void {
		entry.log.prepend(el("div", "", `${new Date(at).toLocaleTimeString()} ${text}`));
		while (entry.log.childElementCount > 200) entry.log.lastElementChild?.remove();
	}
}
