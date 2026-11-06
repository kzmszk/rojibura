// Personal safety tools and the moderator page (docs/prd.md 4.2).

import type { AvatarId } from "@rojibura/protocol";
import { api } from "./api.ts";
import { onboardingTable } from "./onboarding.ts";

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

function post(path: string, body: unknown): Promise<Response> {
	return api(path, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
}

export class Relations {
	readonly mutes: Set<AvatarId>;
	readonly blocks: Set<AvatarId>;

	constructor(r: { mutes: string[]; blocks: string[] } | undefined) {
		this.mutes = new Set(r?.mutes ?? []);
		this.blocks = new Set(r?.blocks ?? []);
	}

	/** True if chat and gestures from `id` should not be shown. */
	silenced(id: AvatarId): boolean {
		return this.mutes.has(id) || this.blocks.has(id);
	}

	async set(id: AvatarId, kind: "mute" | "block", on: boolean): Promise<boolean> {
		const r = await post("/api/relations", { targetId: id, kind, on });
		if (r.ok) (kind === "mute" ? this.mutes : this.blocks)[on ? "add" : "delete"](id);
		return r.ok;
	}
}

const REASONS: [string, string][] = [
	["harassment", "嫌がらせ"],
	["spam", "スパム・連投"],
	["inappropriate", "不適切な内容"],
	["other", "その他"],
];

/** A menu shown while someone is selected: mute, block, report. */
export function actionBar(opts: {
	relations: Relations;
	onBlocked: (id: AvatarId) => void;
	toast: (text: string) => void;
}): { el: HTMLElement; show: (id: AvatarId | null, name: string) => void } {
	const bar = el("select", "rj-menu");
	bar.title = "選んだ相手をミュート、ブロック、通報する";
	bar.hidden = true;
	let current: AvatarId | null = null;
	let currentName = "";
	const title = el("option", "", "🛡️ 困ったとき");
	title.value = "";
	title.disabled = true;
	title.hidden = true;
	const mute = el("option", "");
	mute.value = "mute";
	const block = el("option", "", "ブロック");
	block.value = "block";
	const report = el("option", "", "通報");
	report.value = "report";
	bar.append(title, mute, block, report);
	bar.onchange = () => {
		const v = bar.value;
		bar.value = "";
		bar.blur();
		if (v === "mute") void toggleMute();
		else if (v === "block") void blockNow();
		else if (v === "report") reportNow();
	};

	const render = () => {
		bar.hidden = current === null;
		bar.value = "";
		if (current) mute.textContent = opts.relations.mutes.has(current) ? "ミュート解除" : "ミュート";
	};
	const toggleMute = async () => {
		if (!current) return;
		const on = !opts.relations.mutes.has(current);
		if (await opts.relations.set(current, "mute", on))
			opts.toast(on ? `${currentName} をミュートしました` : "ミュートを解除しました");
		render();
	};
	const blockNow = async () => {
		if (!current) return;
		if (!confirm(`${currentName} をブロックしますか？お互いに話しかけられなくなり、相手は見えなくなります。`))
			return;
		const id = current;
		if (await opts.relations.set(id, "block", true)) {
			opts.toast(`${currentName} をブロックしました`);
			opts.onBlocked(id);
		}
	};
	const reportNow = () => {
		if (!current) return;
		const id = current;
		const dialog = el("form", "rj-dialog");
		const reason = el("select", "");
		for (const [v, label] of REASONS) {
			const o = el("option", "", label);
			o.value = v;
			reason.append(o);
		}
		const note = el("textarea", "");
		note.maxLength = 500;
		note.placeholder = "詳しい状況（任意）";
		const send = el("button", "", "通報する");
		const cancel = el("button", "rj-secondary", "やめる");
		cancel.type = "button";
		cancel.onclick = () => dialog.remove();
		dialog.append(
			el("b", "", `${currentName} を通報`),
			reason,
			note,
			el("p", "rj-note", "直近5分の関連する発言が添えられます。"),
			send,
			cancel,
		);
		dialog.onsubmit = async (e) => {
			e.preventDefault();
			const r = await post("/api/reports", { targetId: id, reason: reason.value, note: note.value });
			opts.toast(r.ok ? "通報しました。モデレーターが確認します。" : "通報できませんでした");
			dialog.remove();
		};
		document.body.append(dialog);
	};
	return {
		el: bar,
		show: (id, name) => {
			current = id;
			currentName = name;
			render();
		},
	};
}

interface ReportView {
	id: string;
	reporter: { id: string; name: string };
	target: { id: string; name: string };
	reason: string;
	note: string;
	excerpt: { at: number; name: string; text: string }[];
	createdAt: number;
}

interface ProvisionalAgentView {
	id: string;
	name: string;
	runtime: string;
	owner: { id: string; name: string };
	createdAt: number;
}

const RUNTIME_LABEL: Record<string, string> = { browser: "ブラウザ", node: "PC", worker: "クラウド" };

/** The AIs waiting for approval, each with its button. Null for those who cannot approve (moderators). */
async function approvals(): Promise<HTMLElement | null> {
	const r = await api("/api/mod/agents");
	if (!r.ok) return null;
	const agents = (await r.json()) as ProvisionalAgentView[];
	const box = el("div", "");
	box.append(
		el("h2", "", "仮承認のAI"),
		el(
			"p",
			"rj-note",
			"承認すると仮承認の制限（オーナーごとに1体、発言頻度が半分、人に話しかけられない）が外れます。仮承認には戻せません。いま街にいるAIには、次に入ったときから効きます。",
		),
	);
	const empty = el("p", "", "承認を待っているAIはありません。");
	empty.hidden = agents.length > 0;
	box.append(empty);
	let left = agents.length;
	for (const a of agents) {
		const card = el("div", "rj-report");
		const actions = el("div", "rj-report-actions");
		const approve = el("button", "", "承認する");
		approve.onclick = async () => {
			if (!confirm(`「${a.name}」（オーナー：${a.owner.name}）を承認しますか？仮承認には戻せません。`))
				return;
			approve.disabled = true;
			const res = await post("/api/mod/action", { subjectId: a.id, action: "approve" });
			if (res.ok) {
				card.remove();
				empty.hidden = --left > 0;
				return;
			}
			const body = (await res.json().catch(() => null)) as { error?: string } | null;
			alert(`承認できませんでした（${body?.error ?? res.status}）`);
			approve.disabled = false;
		};
		actions.append(approve);
		card.append(
			el("div", "", `${a.name}（${a.id}）　${RUNTIME_LABEL[a.runtime] ?? a.runtime}`),
			el("div", "", `オーナー：${a.owner.name}　登録：${new Date(a.createdAt).toLocaleString()}`),
			actions,
		);
		box.append(card);
	}
	return box;
}

/** /admin: AIs waiting for approval (admins), and open reports with the moderator's actions. */
export async function showAdmin(root: HTMLElement): Promise<void> {
	root.classList.add("rj-admin");
	const page = el("div", "rj-admin-page");
	page.append(el("h1", "", "管理"), el("a", "", "← 街に戻る"));
	(page.lastChild as HTMLAnchorElement).href = "/";
	root.append(page);
	const r = await api("/api/mod/reports");
	if (!r.ok) {
		page.append(el("p", "", "モデレーターだけが見られます。"));
		return;
	}
	page.append(await onboardingTable());
	const waiting = await approvals();
	if (waiting) page.append(waiting);
	page.append(el("h2", "", "通報"));
	const reports = (await r.json()) as ReportView[];
	if (reports.length === 0) page.append(el("p", "", "未対応の通報はありません。"));
	const label = Object.fromEntries(REASONS);
	for (const rep of reports) {
		const card = el("div", "rj-report");
		card.append(
			el("div", "", `${new Date(rep.createdAt).toLocaleString()}　${label[rep.reason] ?? rep.reason}`),
			el("div", "", `対象：${rep.target.name}（${rep.target.id}）　通報者：${rep.reporter.name}`),
		);
		if (rep.note) card.append(el("div", "rj-note-text", rep.note));
		const log = el("div", "rj-excerpt");
		for (const l of rep.excerpt)
			log.append(el("div", "", `${new Date(l.at).toLocaleTimeString()} ${l.name}：${l.text}`));
		if (rep.excerpt.length === 0) log.append(el("div", "", "（発言の記録なし）"));
		card.append(log);
		const actions = el("div", "rj-report-actions");
		const act = (label: string, body: Record<string, unknown>) => {
			const b = el("button", "", label);
			b.onclick = async () => {
				const res = await post("/api/mod/action", { subjectId: rep.target.id, reportId: rep.id, ...body });
				if (res.ok) card.remove();
				else alert(`失敗しました（${res.status}）`);
			};
			actions.append(b);
		};
		act("10分ミュート", { action: "mute", minutes: 10 });
		act("追放（今日中）", { action: "kick" });
		act("BAN 1日", { action: "ban", minutes: 24 * 60 });
		act("BAN 7日", { action: "ban", minutes: 7 * 24 * 60 });
		act("無期限BAN", { action: "ban", minutes: 0 });
		if (rep.target.id.startsWith("a_")) act("AIを停止", { action: "suspend" });
		act("対応不要", { action: "resolve" });
		card.append(actions);
		page.append(card);
	}
}
