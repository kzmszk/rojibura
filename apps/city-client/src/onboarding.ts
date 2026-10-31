// Time to entry (#23, docs/prd.md Phase 2): the browser remembers when it first opened the site and reports
// how long ago that was once the person has logged in. The host records the other steps itself.

import { api } from "./api.ts";

const FIRST_VISIT = "rj.firstVisit";
const REPORTED = "rj.firstVisitReported";

function storage(): Storage | null {
	try {
		return localStorage;
	} catch {
		return null;
	}
}

/** Called on every page load, before login. */
export function rememberFirstVisit(): void {
	const s = storage();
	if (s && !s.getItem(FIRST_VISIT)) s.setItem(FIRST_VISIT, String(Date.now()));
}

/** Called once logged in: sends a duration, so a wrong clock in the browser does not matter. */
export function reportFirstVisit(): void {
	const s = storage();
	const first = Number(s?.getItem(FIRST_VISIT));
	if (!s || !first || s.getItem(REPORTED)) return;
	s.setItem(REPORTED, "1");
	void api("/api/onboarding", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ sinceFirstVisitMs: Math.max(0, Date.now() - first) }),
	});
}

interface Row {
	account_id: string;
	display_name: string;
	provider: string;
	first_visit_at: number | null;
	login_at: number;
	entered_at: number | null;
	avatar_at: number | null;
	ai_at: number | null;
}

const GOAL_MS = 5 * 60_000;

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

function since(start: number, at: number | null): HTMLElement {
	if (at === null) return el("td", "rj-dim", "—");
	const ms = at - start;
	const m = Math.floor(ms / 60_000);
	const s = Math.floor((ms % 60_000) / 1000);
	return el("td", ms <= GOAL_MS ? "rj-good" : "rj-bad", `${m}:${String(s).padStart(2, "0")}`);
}

/** The admin page's table: minutes from the first visit (or the login) to each step. */
export async function onboardingTable(): Promise<HTMLElement> {
	const box = el("div", "rj-report");
	box.append(
		el("b", "", "入場までの時間"),
		el("p", "rj-note", "初めて開いた時刻（なければログイン）から、それぞれまでの時間。5分以内なら緑。"),
	);
	const r = await api("/api/mod/onboarding");
	if (!r.ok) {
		box.append(el("p", "rj-note", "読み込めませんでした。"));
		return box;
	}
	const rows = (await r.json()) as Row[];
	const table = el("table", "rj-onboarding");
	const head = el("tr", "");
	for (const h of ["名前", "開いた日時", "ログイン", "入場", "自分のアバター", "自分のAI"])
		head.append(el("th", "", h));
	table.append(head);
	for (const row of rows) {
		const start = row.first_visit_at ?? row.login_at;
		const tr = el("tr", "");
		tr.append(
			el("td", "", `${row.display_name}${row.provider === "dev" ? "（開発）" : ""}`),
			el(
				"td",
				"",
				new Date(start).toLocaleString([], {
					month: "numeric",
					day: "numeric",
					hour: "2-digit",
					minute: "2-digit",
				}),
			),
			since(start, row.login_at),
			since(start, row.entered_at),
			since(start, row.avatar_at),
			since(start, row.ai_at),
		);
		table.append(tr);
	}
	if (rows.length === 0) box.append(el("p", "rj-note", "まだ記録がありません。"));
	else box.append(table);
	return box;
}
