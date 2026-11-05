import { api } from "./api.ts";
import { el } from "./dom.ts";

export interface Me {
	id: string;
	name: string;
	role: string;
	allowAiApproach: boolean;
	relations?: { mutes: string[]; blocks: string[] };
}

export function patchMe(body: { name?: string; allowAiApproach?: boolean }): Promise<Response> {
	return api("/api/me", {
		method: "PATCH",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
}

/** First Google login: Google gives no name (scope is openid only), so the person picks one. */
export function showWelcome(root: HTMLElement, me: Me, redirect: string): void {
	const box = el("form", "rj-login");
	const name = el("input", "");
	name.value = me.name;
	name.maxLength = 24;
	name.required = true;
	const go = el("button", "", "この名前で入る");
	go.type = "submit";
	box.append(el("h1", "", "ようこそ"), el("p", "", "街で表示される名前を決めてください。"), name, go);
	box.onsubmit = async (e) => {
		e.preventDefault();
		const r = await patchMe({ name: name.value });
		if (r.ok) location.replace(redirect.startsWith("/") ? redirect : "/");
	};
	root.append(box);
	name.select();
}

export function showLogin(root: HTMLElement, health: { dev: boolean; google: boolean }): void {
	const box = el("form", "rj-login");
	box.append(el("h1", "", "rojibura"), el("p", "", "人間とAIが暮らす街"));
	if (health.google) {
		const google = el("a", "rj-google", "Google でログイン");
		// come back to the page they opened (the city, or /agent: the city with your AI's panel open)
		google.href = `/auth/google/login?redirect=${encodeURIComponent(location.pathname)}`;
		box.append(google);
	}
	if (!health.dev) {
		if (!health.google) box.append(el("p", "rj-note", "ログインは準備中です。"));
		root.append(box);
		return;
	}
	const name = el("input", "");
	name.placeholder = "表示名（開発用ログイン）";
	name.maxLength = 24;
	name.required = true;
	const avatar = el("select", "");
	for (const [v, label] of [
		["saki", "サキ"],
		["shibu", "シブ"],
		["shino", "シノ"],
		["fumiriya", "フミリヤ"],
		["rei", "レイ"],
		["capsule", "カプセル"],
	]) {
		const o = el("option", "", label);
		o.value = v ?? "";
		avatar.append(o);
	}
	const go = el("button", "", "街に入る");
	go.type = "submit";
	box.append(
		name,
		avatar,
		go,
		el("p", "rj-note", "開発用のダミーログインです（cf dev とステージングだけ）。"),
	);
	box.onsubmit = (e) => {
		e.preventDefault();
		const redirect =
			location.pathname === "/agent" ? "/agent" : `/?avatar=${encodeURIComponent(avatar.value)}`;
		location.href = `/auth/dev/login?name=${encodeURIComponent(name.value)}&redirect=${encodeURIComponent(redirect)}`;
	};
	root.append(box);
	name.focus();
}
