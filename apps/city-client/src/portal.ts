// /portal: the owner makes the one-time code for an AI that will run in their own Cloudflare account
// (T4, docs/prd.md 2.2.4 and 3.5.1, issue #28). The AI spends it with its own key; the host keeps only its hash.

import { MAX_NAME_LENGTH } from "@rojibura/protocol";
import { api } from "./api.ts";
import { el } from "./dom.ts";

/** What the owner puts into the Worker (apps/agent-worker): the city, and the code as a Secret. */
export function deployInstructions(origin: string, code: string): string {
	return [`CITY_URL=${origin}`, `REGISTRATION_CODE=${code}`].join("\n");
}

export async function showPortal(root: HTMLElement): Promise<void> {
	root.classList.add("rj-admin");
	const page = el("div", "rj-admin-page");
	const back = el("a", "", "← 街に戻る");
	back.href = "/";
	page.append(el("h1", "", "Cloudflare で動かすAI"), back);
	root.append(page);

	page.append(
		el(
			"p",
			"",
			"自分の Cloudflare アカウントでAIを動かすための登録コードを出します。コードは15分で切れ、1回しか使えません。コードはここに一度だけ表示します。",
		),
	);

	const form = el("form", "rj-portal-form");
	const name = el("input", "");
	name.placeholder = "AIの名前";
	name.maxLength = MAX_NAME_LENGTH;
	name.required = true;
	const submit = el("button", "", "登録コードを出す");
	submit.type = "submit";
	form.append(name, submit);
	const result = el("div", "rj-portal-result");
	page.append(form, result);

	form.onsubmit = async (e) => {
		e.preventDefault();
		submit.disabled = true;
		result.replaceChildren();
		try {
			const res = await api("/api/registration-codes", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name: name.value }),
			});
			if (!res.ok) {
				const { error } = (await res.json().catch(() => ({}))) as { error?: string };
				result.append(el("p", "rj-portal-error", error ?? `失敗しました（${res.status}）`));
				return;
			}
			const { code, expiresAt } = (await res.json()) as { code: string; expiresAt: number };
			const text = el("textarea", "rj-portal-code");
			text.readOnly = true;
			text.rows = 2;
			text.value = deployInstructions(location.origin, code);
			const copy = el("button", "", "コピー");
			copy.type = "button";
			copy.onclick = () => {
				text.select();
				void navigator.clipboard?.writeText(text.value);
			};
			result.append(
				el("p", "", `「${name.value}」の登録コード（${new Date(expiresAt).toLocaleTimeString()} まで）`),
				text,
				copy,
				el(
					"p",
					"rj-note-text",
					"AIの Worker（apps/agent-worker）に、この2つを設定してデプロイしてください（REGISTRATION_CODE は Secret で）。AIは最初に起きたとき、自分で鍵を作ってこのコードで登録します。登録されたAIは「仮承認」で始まり、管理者が承認すると制限が外れます。",
				),
			);
			name.value = "";
		} finally {
			submit.disabled = false;
		}
	};
}
