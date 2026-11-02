// rojibura city client (docs/prd.md 3.4): login, the 3D city, click-to-move, chat.

import { applyBuilds, NavMesh, type NavMeshData, validatePath } from "@rojibura/nav";
import {
	type AvatarId,
	BODY_CALL_REACH,
	type BodyKey,
	dist,
	type HostToClient,
	ITEM_REACH,
	type ItemId,
	MAX_SAY_LENGTH,
	type Motion,
	OFFER_REACH,
	OFFER_TTL_MS,
	type Portal,
	type PublishedBuilds,
	pathLeg,
	poseAt,
	RUN_SPEED,
	type Together,
	type Vec2,
	WALK_SPEED,
} from "@rojibura/protocol";
import * as THREE from "three";
import { AgentPanel } from "./agent-panel.ts";
import { api, onApiUsage } from "./api.ts";
import { AreaNature, SEASON_LABEL } from "./area-nature.ts";
import { currentArea, travelUrl } from "./areas.ts";
import { AvatarView, TRAVEL } from "./avatars.ts";
import { BuildPanel } from "./build-ui.ts";
import { BuildsView, makeObject, modelsFromHost } from "./builds.ts";
import { VIEW_LABEL, VIEWS, type View, ViewController } from "./camera.ts";
import { ItemsView } from "./items.ts";
import { actionBar, Relations, showAdmin } from "./moderation.ts";
import { CityConnection, type ConnState } from "./net.ts";
import { rememberFirstVisit, reportFirstVisit } from "./onboarding.ts";
import { PORTAL_REACH, PortalsView } from "./portals.ts";
import { CityScene } from "./scene.ts";
import { ShopsUi } from "./shops.ts";
import { STYLES } from "./styles.ts";
import { UsagePanel } from "./usage-panel.ts";
import { Zones } from "./zones.ts";

export { mountMirror } from "./mirror.ts";

export interface Navigator {
	findPath(from: Vec2, to: Vec2): Vec2[] | null;
	isWalkable(p: Vec2): boolean;
}

const MOTION_EMOJI: Record<Motion, string> = {
	wave: "👋",
	nod: "🙂",
	bow: "🙇",
	jump: "⤴️",
	sit: "🪑",
	lie: "🛌",
	handstand: "🤸",
	roll: "⤵️",
	backroll: "↩️",
	backflip: "🔄",
};
const TOGETHER_LABEL: Record<Together, string> = { handshake: "握手", hug: "ハグ" };
/** Patting your AI's head (🤚, H): the palm comes down on top and moves gently from side to side. */
const PAT: BodyKey[] = [
	{
		at: 0.7,
		right: { part: "head", of: "you", palm: "down" },
		look: { part: "face", of: "you" },
		smile: true,
	},
	{ at: 1.2, right: { part: "head", of: "you", wiggle: { dir: "side", size: 0.04, hz: 1.2 } } },
	{ at: 3.2, right: { part: "head", of: "you", wiggle: { dir: "side", size: 0.04, hz: 1.2 } } },
];
/** An AI this close to its owner looks at them (docs/prd.md 3.4.9). */
const ATTEND_M = 5;
/** The action bar (docs/prd.md 3.4.5): motion, label, key. Space also jumps. */
const ACTIONS: [Motion, string, string][] = [
	["wave", "手を振る", "1"],
	["nod", "うなずく", "2"],
	["bow", "おじぎ", "3"],
	["jump", "ジャンプ", "4"],
	["sit", "座る", "5"],
	["lie", "寝転がる", "6"],
	["handstand", "逆立ち", "7"],
	["roll", "前転", "8"],
	["backroll", "後転", "9"],
	["backflip", "バク転", "0"],
];

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

/**
 * The area's navmesh: with the published builds baked in, or where free play builds the city alone (the
 * area's own builds, which include the published ones, are applied on top).
 */
async function loadNavMesh(dir: string, building: boolean): Promise<NavMeshData> {
	return (await (
		await fetch(`${dir}/${building ? "navmesh.base.json" : "navmesh.json"}`)
	).json()) as NavMeshData;
}

function navigatorFor(mesh: NavMesh): Navigator {
	return {
		findPath: (from, to) => {
			const start = mesh.closestPoint(from);
			const end = mesh.closestPoint(to);
			// clicking on a building: walk to the nearest walkable point if it is close
			if (Math.hypot(end[0] - to[0], end[1] - to[1]) > 3) return null;
			return mesh.findPath(start, end);
		},
		isWalkable: (p) => mesh.isWalkable(p),
	};
}

export async function mountApp(root: HTMLElement): Promise<void> {
	const style = document.createElement("style");
	style.textContent = STYLES;
	document.head.appendChild(style);
	root.classList.add("rj-root");
	rememberFirstVisit();

	const [meRes, health] = await Promise.all([
		api("/api/me"),
		api("/api/health").then(
			(r) => r.json() as Promise<{ dev: boolean; google: boolean; freePlay?: boolean }>,
		),
	]);
	if (meRes.status === 401) {
		showLogin(root, health);
		return;
	}
	const me = (await meRes.json()) as Me;
	reportFirstVisit();
	if (location.pathname === "/admin") {
		await showAdmin(root);
		return;
	}
	const params = new URLSearchParams(location.search);
	if (params.get("welcome") === "1") {
		showWelcome(root, me, params.get("redirect") ?? "/");
		return;
	}
	// /agent (the old page for your AI, and where logins come back to): the city with its panel open
	const openAi = location.pathname === "/agent";
	if (openAi) history.replaceState(null, "", `/${location.search}`);
	await startCity(root, me, health.dev, health.freePlay === true, openAi);
}

interface Me {
	id: string;
	name: string;
	role: string;
	allowAiApproach: boolean;
	relations?: { mutes: string[]; blocks: string[] };
}

function patchMe(body: { name?: string; allowAiApproach?: boolean }): Promise<Response> {
	return api("/api/me", {
		method: "PATCH",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
}

const AVATAR = "rj.avatar";

/** The preset avatar picked last time (an unknown one is Saki on the host). */
function savedAvatar(): string | null {
	try {
		return localStorage.getItem(AVATAR);
	} catch {
		return null;
	}
}

function saveAvatar(id: string): void {
	try {
		localStorage.setItem(AVATAR, id);
	} catch {
		// private mode: the choice lasts as long as the URL
	}
}

/** Picks a preset avatar (T1). The host takes it when connecting, so picking one enters the area again. */
function avatarPicker(current: string): HTMLSelectElement {
	const select = el("select", "rj-logout rj-avatar");
	select.title = "見た目を選ぶ（選ぶと入り直します）";
	void api("/api/presets")
		.then((r) => (r.ok ? (r.json() as Promise<{ id: string; name: string }[]>) : []))
		.then((presets) => {
			for (const p of presets) {
				const o = el("option", "", `👤 ${p.name}`);
				o.value = p.id;
				select.append(o);
			}
			select.value = current;
		});
	select.onchange = () => {
		saveAvatar(select.value);
		const url = new URL(location.href);
		url.searchParams.set("avatar", select.value);
		url.searchParams.delete("at");
		location.href = url.toString();
	};
	return select;
}

/** First Google login: Google gives no name (scope is openid only), so the person picks one. */
function showWelcome(root: HTMLElement, me: Me, redirect: string): void {
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

function showLogin(root: HTMLElement, health: { dev: boolean; google: boolean }): void {
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

async function startCity(
	root: HTMLElement,
	me: Me,
	devBuild: boolean,
	freePlay: boolean,
	openAi: boolean,
): Promise<void> {
	const params = new URLSearchParams(location.search);
	const avatarParam = params.get("avatar") ?? savedAvatar() ?? "saki";
	saveAvatar(avatarParam);
	// the area this page is in (docs/prd.md 3.8): ?area=, and ?at= when arriving through a portal
	const { area, all: areas } = await currentArea(params, devBuild);
	/** Free play builds only in areas that allow it (the main one). */
	const building = freePlay && area.build === true;
	const scene = new CityScene(root);
	scene.applyView(area.view);
	const loading = el("div", "rj-toast show", `${area.name}を読み込んでいます…`);
	root.append(loading);
	const base = await loadNavMesh(area.dir, building);
	let mesh = NavMesh.fromJSON(base);
	let nav = navigatorFor(mesh);
	scene.heightHint = (x, z) => mesh.heightAt([x, z]);
	const sceneUrls = area.scene.map((f) => new URL(f, new URL(area.assetBase, location.href)).href);
	const cityRoots = await scene.loadCity(sceneUrls, (n) => {
		loading.textContent = `${area.name}を読み込んでいます…（${n}/${sceneUrls.length}）`;
	});
	// trees and seasons, where the area has them (docs/prd.md 3.8.6)
	const nature = await AreaNature.create(scene, area, cityRoots, params);
	// places with rules of their own: indoors, the onsen
	const zones = new Zones();
	await zones.load(area.dir);
	loading.remove();
	const portals = new PortalsView(
		scene.scene,
		area.portals ?? [],
		(x, z) => mesh.heightAt([x, z]) ?? scene.heightAt(x, z),
	);
	// free play (docs/prd.md 3.7): what has been built, and the walkable area with it
	let navVersion = 0;
	modelsFromHost(building);
	const builds = new BuildsView(scene, () => {
		// outside free play the builds are published ones, already in navmesh.json
		if (!building) return;
		const v = ++navVersion;
		void builds.placed().then((placed) => {
			if (v !== navVersion) return;
			mesh = NavMesh.fromJSON(placed.length > 0 ? applyBuilds(base, placed) : base);
			nav = navigatorFor(mesh);
		});
	});
	// published builds are part of the city everyone sees (docs/prd.md 3.7.8)
	if (!freePlay && area.build)
		void fetch(`${area.dir}/builds.json`)
			.then((r) => (r.ok ? (r.json() as Promise<PublishedBuilds>) : null))
			.then((p) => p && builds.set(p.builds))
			.catch(() => {});

	// ---- HUD ----
	const hud = el("div", "rj-hud");
	const status = el("div", "rj-status", "接続中…");
	const right = el("div", "rj-right");
	const approach = el("label", "rj-check");
	const box = el("input", "");
	box.type = "checkbox";
	box.checked = me.allowAiApproach;
	box.onchange = () => void patchMe({ allowAiApproach: box.checked });
	approach.append(box, document.createTextNode(" AIから話しかけられてもいい"));
	const logout = el("a", "rj-logout", "ログアウト");
	logout.href = "/auth/logout";
	if (me.role === "moderator" || me.role === "admin") {
		const admin = el("a", "rj-logout", "管理");
		admin.href = "/admin";
		right.append(admin);
	}
	// your own AI (T3): it runs in this tab while it is open, unless it is on your PC (docs/prd.md 3.5.1)
	const myAi = el("button", "rj-logout", "🤖 自分のAI");
	myAi.type = "button";
	const agentPanel = new AgentPanel((running) => {
		myAi.classList.toggle("on", running);
		myAi.title = running ? "自分のAIがこのタブで街にいます" : "";
	});
	myAi.onclick = () => agentPanel.toggle();
	if (openAi) agentPanel.show();
	// where the camera looks from (docs/prd.md 3.4.8): the button or V goes round the three
	const viewButton = el("button", "rj-logout", "");
	viewButton.type = "button";
	viewButton.title = "視点を切り替える（V）";
	viewButton.onclick = () => nextView();
	// the season you see (the date's, or one you choose): only you see it change
	const seasonButton = el("button", "rj-logout", nature ? SEASON_LABEL[nature.season] : "");
	seasonButton.type = "button";
	seasonButton.title = "季節を切り替える（自分の画面だけ）";
	seasonButton.hidden = !nature;
	seasonButton.onclick = () => {
		if (nature) seasonButton.textContent = SEASON_LABEL[nature.next()];
	};
	// your own AIs walk with you (docs/prd.md 3.4.9); shown while one of them is here
	const companionButton = el("button", "rj-logout", "");
	companionButton.type = "button";
	companionButton.hidden = true;
	let companion = false;
	try {
		companion = localStorage.getItem("rj.companion") === "1";
	} catch {
		// private mode
	}
	const showCompanion = () => {
		companionButton.textContent = companion ? "🤖 そばにいる" : "🤖 自由に歩く";
		companionButton.title = companion
			? "自分のAIがそばを歩いています（押すと自由に歩かせる）"
			: "自分のAIは自由に歩いています（押すとそばにいさせる）";
		companionButton.classList.toggle("on", companion);
	};
	showCompanion();
	companionButton.onclick = () => {
		companion = !companion;
		// following your AI somewhere ends too (the host hears it from COMPANION)
		if (following?.lead) following = null;
		try {
			localStorage.setItem("rj.companion", companion ? "1" : "0");
		} catch {
			// private mode
		}
		conn.send({ t: "COMPANION", on: companion });
		showCompanion();
	};
	right.append(companionButton, seasonButton, viewButton, avatarPicker(avatarParam), myAi, approach, logout);
	const panel = new BuildPanel(() => void updateGhost());
	if (freePlay) {
		const badge = el("span", "rj-free", "🧪 自由モード");
		badge.title = "ローカルで、無料枠の制限なしに遊んでいます（pnpm dev:free）";
		right.prepend(badge);
	}
	if (building) {
		const buildButton = el("button", "rj-logout", "🧱 建てる");
		buildButton.type = "button";
		buildButton.onclick = () => panel.toggle();
		right.prepend(buildButton);
		root.append(panel.el);
	}
	// the way to a portal from anywhere in the area (docs/prd.md 3.8): it may be far off and out of sight
	const gates = area.portals ?? [];
	const onlyGate = gates.length === 1 ? gates[0] : undefined;
	const gateButton = el("button", "rj-logout rj-gate", "🚪 門へ");
	gateButton.type = "button";
	gateButton.title = `${onlyGate ? onlyGate.name : "いちばん近い門"}まで歩いていきます（遠いときは走ります）`;
	gateButton.hidden = gates.length === 0;
	gateButton.onclick = () => goToGate();
	const left = el("div", "rj-left");
	// your wallet (docs/prd.md 3.8.6): shown once the host tells it
	const purse = el("div", "rj-status rj-purse", "");
	purse.hidden = true;
	purse.title = "お店や宿で働くか、学校で勉強すると増える（1分で1銅貨）";
	left.append(status, purse, gateButton);
	hud.append(left, right);
	// free-tier usage for admins, moderators and development builds (docs/prd.md 2.5)
	let usage: UsagePanel | null = null;
	if (devBuild || me.role === "moderator" || me.role === "admin") {
		const panel = new UsagePanel((on) => conn.send({ t: "WATCH_USAGE", on }));
		const toggle = el("button", "rj-logout", "📊 利用状況");
		toggle.type = "button";
		toggle.onclick = () => panel.toggle();
		right.prepend(toggle);
		root.append(panel.el);
		onApiUsage((label, cost) => panel.addOwn(label, cost));
		usage = panel;
	}
	const chat = el("div", "rj-chat");
	const log = el("div", "rj-log");
	const form = el("form", "rj-say");
	const target = el("button", "rj-target");
	target.type = "button";
	const input = el("input", "");
	input.maxLength = MAX_SAY_LENGTH;
	input.placeholder = "Enter で話す（相手をクリックで話しかけ、WASD・矢印キーで歩く）";
	form.append(target, input);
	const motionBar = el("div", "rj-motions");
	for (const [motion, label, key] of ACTIONS) {
		const b = el("button", "", MOTION_EMOJI[motion]);
		b.type = "button";
		b.title = `${label}（${key}${motion === "jump" ? "、スペース" : ""}）`;
		b.setAttribute("aria-label", label);
		b.onclick = () => act(motion);
		motionBar.append(b);
	}
	// done together with the person chosen (docs/prd.md 3.4.6), and the thing in hand (3.4.7)
	for (const [kind, icon, label] of [
		["handshake", "🤝", "握手"],
		["hug", "🫂", "ハグ"],
	] as const) {
		const b = el("button", "", icon);
		b.type = "button";
		b.title = `${label}を申し込む（相手をクリックして選んでから）`;
		b.setAttribute("aria-label", label);
		b.onclick = () => offer(kind);
		motionBar.append(b);
	}
	// a thing close by can be picked up with a button (or E), not only by clicking it
	const pickButton = el("button", "", "✋");
	pickButton.type = "button";
	pickButton.title = "近くの物を拾う（E）";
	pickButton.hidden = true;
	pickButton.onclick = () => pickNearest();
	const throwButton = el("button", "rj-held", "🥏");
	throwButton.type = "button";
	throwButton.title = "投げる（T）";
	throwButton.onclick = () => throwHeld();
	const dropButton = el("button", "rj-held", "🫳");
	dropButton.type = "button";
	dropButton.title = "置く（G）";
	dropButton.onclick = () => conn.send({ t: "DROP" });
	// something bought to eat or drink (docs/prd.md 3.8.6)
	const eatButton = el("button", "rj-held", "😋");
	eatButton.type = "button";
	eatButton.title = "食べる・飲む";
	eatButton.onclick = () => conn.send({ t: "USE" });
	// working or studying where you stand earns coins (docs/prd.md 3.8.6)
	const jobButtons = (["work", "study"] as const).map((kind) => {
		const b = el("button", "", kind === "work" ? "💼" : "📖");
		b.type = "button";
		b.title = kind === "work" ? "ここで働く（1分で1銅貨）" : "ここで勉強する（1分で1銅貨）";
		b.hidden = true;
		b.onclick = () => conn.send({ t: "JOB", kind });
		return b;
	});
	const stopJobButton = el("button", "rj-held", "⏹");
	stopJobButton.type = "button";
	stopJobButton.hidden = true;
	stopJobButton.onclick = () => conn.send({ t: "JOB", kind: null });
	motionBar.append(pickButton, throwButton, dropButton, eatButton, ...jobButtons, stopJobButton);
	// your own AI close by: pat its head (docs/prd.md 3.4.11)
	const patButton = el("button", "", "🤚");
	patButton.type = "button";
	patButton.title = "自分のAIの頭をなでる（H）";
	patButton.setAttribute("aria-label", "自分のAIの頭をなでる");
	patButton.hidden = true;
	patButton.onclick = () => patMine();
	motionBar.append(patButton);
	/** Asked to do something together: yes or no, for OFFER_TTL_MS. */
	const offerBox = el("div", "rj-offer");
	offerBox.hidden = true;
	chat.append(log, motionBar, form);
	const toast = el("div", "rj-toast");
	// standing at a portal: the way to the other area (docs/prd.md 3.8)
	const travel = el("button", "rj-travel");
	travel.type = "button";
	travel.hidden = true;
	// at a shop's counter: what it sells (docs/prd.md 3.8.6)
	const shops = new ShopsUi((shop, goods) => conn.send({ t: "BUY", shop: shop.id, goods }));
	void shops.load(area.dir);
	root.append(hud, chat, toast, travel, offerBox, agentPanel.el, shops.el);
	if (area.credit) root.append(el("div", "rj-credit", area.credit));

	const avatars = new Map<AvatarId, AvatarView>();
	let myId: AvatarId | null = null;
	let talkTo: AvatarId | null = null;
	let seq = 0;

	const relations = new Relations(me.relations);
	let bar: ReturnType<typeof actionBar> | null = null;
	const setTarget = (id: AvatarId | null) => {
		talkTo = id;
		const a = id ? avatars.get(id) : undefined;
		target.textContent = a ? `→ ${a.state.name}` : "みんなへ";
		target.classList.toggle("on", !!a);
		bar?.show(a ? a.state.id : null, a?.state.name ?? "");
	};
	setTarget(null);
	target.onclick = () => setTarget(null);

	const showToast = (text: string) => {
		toast.textContent = text;
		toast.classList.add("show");
		setTimeout(() => toast.classList.remove("show"), 4000);
	};
	const addLog = (who: string, text: string, cls = "") => {
		const line = el("div", `rj-line ${cls}`);
		line.append(el("b", "", who), document.createTextNode(` ${text}`));
		log.append(line);
		while (log.childElementCount > 60) log.firstElementChild?.remove();
		log.scrollTop = log.scrollHeight;
	};
	const updateStatus = (state: ConnState, detail?: string) => {
		const label = { connecting: "接続中…", open: "接続済み", closed: "切断" }[state];
		status.textContent = `${me.name} ｜ ${area.name} ｜ ${detail ?? label} ｜ ${avatars.size}人`;
	};

	bar = actionBar({
		relations,
		toast: (t) => showToast(t),
		onBlocked: (id) => {
			avatars.get(id)?.dispose();
			avatars.delete(id);
			setTarget(null);
		},
	});
	chat.insertBefore(bar.el, form);
	// walk up to the selected person, following them if they move (also the F key)
	const followButton = el("button", "", "🚶 そばへ行く");
	followButton.type = "button";
	followButton.title = "選んだ相手のそばまで歩いていきます（F キー）";
	followButton.onclick = () => talkTo && startFollow(talkTo);
	bar.el.prepend(followButton);

	const add = (s: AvatarView["state"]) => {
		if (relations.blocks.has(s.id)) return;
		avatars.get(s.id)?.dispose();
		const v = new AvatarView(s, s.id === myId);
		avatars.set(s.id, v);
		scene.scene.add(v.root);
	};
	const view = new ViewController(scene);
	/** The view chosen outside, while indoors switched it to the eyes. */
	let viewOutside: View | null = null;
	const setView = (v: View) => {
		viewOutside = null;
		view.set(v, myId ? (avatars.get(myId) ?? null) : null);
		viewButton.textContent = `🎥 ${VIEW_LABEL[v]}`;
		try {
			localStorage.setItem("rj.view", v);
		} catch {
			// private mode: the view lasts as long as the page
		}
	};
	const nextView = () => setView(VIEWS[(VIEWS.indexOf(view.view) + 1) % VIEWS.length] as View);
	let savedView: string | null = null;
	try {
		savedView = localStorage.getItem("rj.view");
	} catch {
		// private mode
	}
	setView(VIEWS.includes(savedView as View) ? (savedView as View) : "orbit");
	const items = new ItemsView(scene, (id) => avatars.get(id)?.handPosition() ?? null);
	scene.scene.add(items.group);
	/** The throw and put-down buttons show while holding something. */
	const showHeld = () => {
		const held = myId ? items.heldBy(myId) : undefined;
		throwButton.hidden = !held;
		dropButton.hidden = !held;
		eatButton.hidden = !held?.goods?.food;
		if (held?.goods) eatButton.title = `${held.goods.name}を食べる・飲む`;
	};
	showHeld();

	const conn = new CityConnection({
		areaId: area.id,
		...(params.get("at") ? { at: params.get("at") as string } : {}),
		avatar: avatarParam,
		onState: (s, d) => {
			updateStatus(s, d);
			if (s === "closed" && d) showToast(d);
		},
		onMessage: (m: HostToClient) => {
			switch (m.t) {
				case "WELCOME": {
					myId = m.you;
					// (re)subscribe after every (re)connect
					if (usage?.isShown) conn.send({ t: "WATCH_USAGE", on: true });
					// a reconnect: those still here keep their figures (nothing reloads); who left or looks
					// different now is taken away or built again
					const here = new Set(m.avatars.map((a) => a.id));
					for (const [id, v] of avatars)
						if (!here.has(id)) {
							v.dispose();
							avatars.delete(id);
						}
					for (const a of m.avatars) {
						const v = avatars.get(a.id);
						const same =
							v &&
							!relations.blocks.has(a.id) &&
							v.state.name === a.name &&
							JSON.stringify(v.state.assets) === JSON.stringify(a.assets);
						if (v && same) {
							Object.assign(v.state, a);
							v.setStatus(a.status);
						} else {
							v?.dispose();
							avatars.delete(a.id);
							add(a);
						}
						agentPanel.present(a.id);
					}
					if (m.builds) builds.set(m.builds);
					items.reset(m.items ?? []);
					showHeld();
					// back where we were after a dropped connection (docs/prd.md 3.3): the host kept everything
					if (m.resumed) break;
					// the host forgets on a new connection; tell it again (a walk behind your AI is over then)
					if (following?.lead) following = null;
					if (companion) conn.send({ t: "COMPANION", on: true });
					break;
				}
				case "ITEM": {
					const change = items.set(m.item, conn.hostNow());
					// picking up faces the thing; throwing goes the way the avatar faces already
					const towards =
						change?.did === "pick" ? new THREE.Vector3(m.item.pos[0], 0, m.item.pos[1]) : undefined;
					if (change) avatars.get(change.who)?.perform(change.did, conn.hostNow(), towards);
					// just bought: it appears in the buyer's hand
					if (m.item.goods && m.item.holder === myId && !change)
						showToast(`${m.item.goods.name}を買いました`);
					showHeld();
					break;
				}
				case "ITEM_GONE": {
					const was = m.by ? items.heldBy(m.by) : undefined;
					items.remove(m.id);
					if (m.by && was?.goods) {
						avatars.get(m.by)?.say(`（${was.goods.name}をいただきます）`, conn.hostNow());
					}
					showHeld();
					break;
				}
				case "OFFERED":
					showOffer(m.from, m.kind);
					break;
				case "LEAD_OFFERED":
					showLead(m.from, m.place, m.text);
					break;
				case "LEADING":
					trail(m.by, m.to, m.place);
					break;
				case "ANSWERED":
					if (!m.accept)
						showToast(
							`${avatars.get(m.by)?.state.name ?? "相手"}さんは、いまは${TOGETHER_LABEL[m.kind]}しないようです`,
						);
					break;
				case "TOGETHER": {
					const a = avatars.get(m.a);
					const b = avatars.get(m.b);
					if (!a || !b) break;
					const pa = poseAt(a.state.move, m.at).pos;
					const pb = poseAt(b.state.move, m.at).pos;
					a.together(m.kind, new THREE.Vector3(pb[0], 0, pb[1]), m.at);
					b.together(m.kind, new THREE.Vector3(pa[0], 0, pa[1]), m.at);
					addLog("", `${a.state.name} と ${b.state.name} が${TOGETHER_LABEL[m.kind]}しました`, "sys");
					break;
				}
				case "BUILT":
					builds.add(m.build);
					addLog("", `${m.build.byName} が${m.build.label ? `「${m.build.label}」を` : ""}建てました`, "sys");
					break;
				case "UNBUILT":
					builds.remove(m.id);
					addLog("", `${avatars.get(m.by)?.state.name ?? "だれか"} が建物を片付けました`, "sys");
					break;
				case "JOINED":
					add(m.avatar);
					addLog("", `${m.avatar.name} が来ました`, "sys");
					agentPanel.present(m.avatar.id);
					break;
				case "LEFT": {
					agentPanel.gone(m.id);
					const v = avatars.get(m.id);
					if (v) addLog("", `${v.state.name} が帰りました`, "sys");
					v?.dispose();
					avatars.delete(m.id);
					if (talkTo === m.id) setTarget(null);
					break;
				}
				case "MOVED":
					avatars.get(m.id)?.setMove(m.move);
					break;
				case "CORRECT":
					if (myId) avatars.get(myId)?.setMove(m.move);
					break;
				case "ACTED": {
					if (relations.silenced(m.id)) break;
					const v = avatars.get(m.id);
					const towards = m.target ? avatars.get(m.target)?.root.position : undefined;
					// shown with the body; an avatar that cannot (a capsule, or walking) shows the emoji
					if (v && !v.act(m.motion, conn.hostNow(), towards)) v.say(MOTION_EMOJI[m.motion], conn.hostNow());
					break;
				}
				case "BODIED": {
					if (relations.silenced(m.id)) break;
					const v = avatars.get(m.id);
					const partner = m.to ? (avatars.get(m.to) ?? null) : null;
					// a model without bones to move shows a hand over its head
					if (v && !v.moveBody(m.keys, m.at, partner, m.to)) v.say("🤲", conn.hostNow());
					break;
				}
				case "SAID": {
					if (relations.silenced(m.id)) break;
					const v = avatars.get(m.id);
					v?.say(m.text, conn.hostNow());
					const to = m.to ? avatars.get(m.to)?.state.name : undefined;
					addLog(`${v?.state.name ?? "?"}${to ? ` → ${to}` : ""}`, m.text, m.id === myId ? "mine" : "");
					break;
				}
				case "WALLET": {
					purse.hidden = false;
					purse.textContent = `👛 ${m.coins} 銅貨`;
					if (m.change && m.change > 0) {
						purse.classList.remove("earned");
						void purse.offsetWidth;
						purse.classList.add("earned");
					}
					break;
				}
				case "JOBBED":
					avatars.get(m.id)?.setJob(m.job);
					if (m.id === myId)
						showToast(
							m.job === "work"
								? "働きはじめました（1分で1銅貨）。歩いて出ると終わります"
								: m.job === "study"
									? "勉強をはじめました（1分で1銅貨）。歩いて出ると終わります"
									: "おつかれさまでした",
						);
					break;
				case "STATUS_CHANGED":
					avatars.get(m.id)?.setStatus(m.status);
					break;
				case "NOTICE":
					showToast(m.message);
					break;
				case "USAGE":
					usage?.onUsage(m);
					break;
				default:
					break;
			}
			updateStatus("open");
		},
	});
	conn.start();
	usage?.restore();
	// debug hook for tools/snap.ts on development builds (cf dev and staging)
	if (devBuild)
		Object.assign(globalThis, {
			__rj: {
				avatars,
				scene,
				conn,
				setTarget,
				startFollow: (id: string) => startFollow(id),
				builds,
				panel,
				walkTo: (x: number, z: number, speed = WALK_SPEED) => walkTo([x, z], speed),
				items,
				pickUp: (id: string) => pickUp(id),
				offer: (kind: Together) => offer(kind),
				throwHeld: () => throwHeld(),
				area,
				nature,
				mesh: () => mesh,
				me: () => (myId ? avatars.get(myId) : undefined),
				/** Stops following your avatar and looks at (x, z) from `dist` away. */
				look: (x: number, z: number, dist = 16, height = 10) => {
					followCamera = false;
					scene.controls.target.set(x, 1, z);
					scene.camera.position.set(x + dist * 0.55, height, z + dist * 0.85);
					scene.controls.update();
				},
			},
		});

	// ---- input ----
	form.onsubmit = (e) => {
		e.preventDefault();
		const text = input.value.trim();
		if (!text) return;
		conn.send(talkTo ? { t: "SAY", text, to: talkTo } : { t: "SAY", text });
		input.value = "";
	};
	// WASD: walk relative to the camera; sent as MOVE_VEL only when the direction changes (docs/prd.md 3.2.2)
	const keys = new Set<string>();
	let sentVel: { dir: Vec2; speed: number; at: number } | null = null;
	const steer = (now: number, force = false) => {
		const mine = myId ? avatars.get(myId) : undefined;
		if (!mine) return;
		const f = new THREE.Vector3();
		scene.camera.getWorldDirection(f);
		f.y = 0;
		f.normalize();
		const r = new THREE.Vector3(-f.z, 0, f.x);
		const fw = (keys.has("w") ? 1 : 0) - (keys.has("s") ? 1 : 0);
		const rt = (keys.has("d") ? 1 : 0) - (keys.has("a") ? 1 : 0);
		const v = f.multiplyScalar(fw).add(r.multiplyScalar(rt));
		const pos = poseAt(mine.state.move, conn.hostNow()).pos;
		const wanted = v.lengthSq() > 0;
		const dir: Vec2 = wanted ? [v.x / v.length(), v.z / v.length()] : [0, 0];
		const speed = wanted ? (keys.has("shift") ? RUN_SPEED : WALK_SPEED) : 0;
		// do not walk into walls or off the walkable area
		const moving = wanted && nav.isWalkable([pos[0] + dir[0] * speed * 0.2, pos[1] + dir[1] * speed * 0.2]);
		if (!moving && !sentVel) return;
		if (sentVel && !force) {
			const same =
				moving &&
				Math.abs(sentVel.speed - speed) < 0.01 &&
				sentVel.dir[0] * dir[0] + sentVel.dir[1] * dir[1] > 0.97;
			if (same || (moving && now - sentVel.at < 250)) return;
		}
		const move = moving
			? ({ kind: "vel", pos, dir, speed, at: conn.hostNow() } as const)
			: ({ kind: "idle", pos, at: conn.hostNow() } as const);
		mine.setMove(move);
		conn.send({ t: "MOVE_VEL", pos, dir, speed, seq: ++seq });
		sentVel = moving ? { dir, speed, at: now } : null;
	};
	// arrow keys walk like WASD
	const ARROWS: Record<string, string> = { arrowup: "w", arrowdown: "s", arrowleft: "a", arrowright: "d" };
	const movementKey = (e: KeyboardEvent) => {
		const k = e.key.toLowerCase();
		const m = ARROWS[k] ?? k;
		return ["w", "a", "s", "d", "shift"].includes(m) ? m : null;
	};
	addEventListener("keyup", (e) => {
		const k = movementKey(e);
		if (!k) return;
		keys.delete(k);
		steer(performance.now());
	});
	addEventListener("blur", () => {
		keys.clear();
		steer(performance.now());
	});
	/** Typing in the chat or in the build menu: keys are text, not moves. */
	const typing = () =>
		document.activeElement instanceof HTMLInputElement ||
		document.activeElement instanceof HTMLTextAreaElement;
	addEventListener("keydown", (e) => {
		const k = movementKey(e);
		if (k && !typing()) {
			e.preventDefault();
			stopGoing();
			keys.add(k);
			steer(performance.now());
			return;
		}
		if (e.key === "Enter" && !typing()) {
			input.focus();
			e.preventDefault();
		} else if (!typing() && !panel.open && (e.key === " " || ACTIONS.some(([, , key]) => key === e.key))) {
			e.preventDefault();
			act(
				e.key === " " ? "jump" : (ACTIONS.find(([, , key]) => key === e.key) as (typeof ACTIONS)[number])[0],
			);
		} else if (!typing() && !panel.open && e.key.toLowerCase() === "v") {
			nextView();
		} else if (!typing() && !panel.open && e.key.toLowerCase() === "e") {
			pickNearest();
		} else if (!typing() && !panel.open && e.key.toLowerCase() === "h") {
			patMine();
		} else if (!typing() && !panel.open && e.key.toLowerCase() === "t") {
			throwHeld();
		} else if (!typing() && !panel.open && e.key.toLowerCase() === "g") {
			if (myId && items.heldBy(myId)) conn.send({ t: "DROP" });
		} else if (e.key.toLowerCase() === "f" && !typing() && talkTo) {
			startFollow(talkTo);
		} else if (panel.open && !typing() && (e.key.toLowerCase() === "q" || e.key.toLowerCase() === "e")) {
			panel.turn(e.key.toLowerCase() === "q" ? -15 : 15);
		} else if (e.key === "Escape") {
			if (panel.open) panel.hide();
			stopGoing();
			setTarget(null);
			input.blur();
		}
	});

	const canvas = scene.renderer.domElement;
	let down: { x: number; y: number } | null = null;
	const ndcOf = (e: PointerEvent) => {
		const rect = canvas.getBoundingClientRect();
		return new THREE.Vector2(
			((e.clientX - rect.left) / rect.width) * 2 - 1,
			-((e.clientY - rect.top) / rect.height) * 2 + 1,
		);
	};

	// ---- building (free play) ----
	/** A see-through copy of what a click would build, following the pointer. */
	let ghost: THREE.Object3D | null = null;
	let ghostKey = "";
	let ghostAt: Vec2 | null = null;
	let buildRef = 0;
	const placeGhost = () => {
		if (!ghost) return;
		ghost.visible = ghostAt !== null && panel.open;
		if (!ghostAt) return;
		ghost.position.set(
			ghostAt[0],
			mesh.heightAt(ghostAt) ?? scene.heightAt(ghostAt[0], ghostAt[1]) ?? 0,
			ghostAt[1],
		);
		ghost.rotation.y = (panel.rot * Math.PI) / 180;
	};
	async function updateGhost(): Promise<void> {
		const c = panel.open ? panel.current : null;
		const key = c ? JSON.stringify([c.model, c.color, c.scale, c.size]) : "";
		if (key !== ghostKey) {
			if (ghost) scene.scene.remove(ghost);
			ghost = null;
			ghostKey = key;
			if (c) {
				const made = await makeObject(
					{ model: c.model, pos: [0, 0], y: 0, rot: 0, scale: c.scale ?? 1, size: c.size, color: c.color },
					true,
				);
				if (made && ghostKey === key) {
					ghost = made;
					scene.scene.add(made);
				}
			}
		}
		placeGhost();
	}
	canvas.addEventListener("pointermove", (e) => {
		if (!panel.open || panel.tool !== "place") return;
		const p = scene.pickGround(ndcOf(e));
		ghostAt = p ? [p.x, p.z] : null;
		placeGhost();
	});
	/** A click while the build menu is open: build there, or take down what was clicked. */
	function buildClick(ndc: THREE.Vector2): void {
		if (panel.tool === "remove") {
			const ray = new THREE.Raycaster();
			ray.setFromCamera(ndc, scene.camera);
			const hit = ray.intersectObjects(builds.objects, true).find((h) => h.object.visible);
			const id = builds.buildOf(hit?.object ?? null);
			if (id) conn.send({ t: "UNBUILD", id, ref: `ui${++buildRef}` });
			else showToast("消すものをクリックしてください");
			return;
		}
		const c = panel.current;
		const p = scene.pickGround(ndc);
		if (!c || !p) return;
		const round = (v: number) => Math.round(v * 100) / 100;
		conn.send({
			t: "BUILD",
			model: c.model,
			at: { pos: [round(p.x), round(p.z)] },
			rot: panel.rot,
			...(c.color ? { color: c.color } : {}),
			...(c.scale ? { scale: c.scale } : {}),
			...(c.size ? { size: c.size } : {}),
			...(c.label ? { label: c.label } : {}),
			ref: `ui${++buildRef}`,
		});
	}
	canvas.addEventListener("pointerdown", (e) => {
		down = { x: e.clientX, y: e.clientY };
	});
	canvas.addEventListener("pointerup", (e) => {
		// a finger wobbles a little more than a mouse
		if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > (e.pointerType === "touch" ? 12 : 5))
			return;
		down = null;
		const ndc = ndcOf(e);
		if (panel.open) {
			buildClick(ndc);
			return;
		}
		const ray = new THREE.Raycaster();
		ray.setFromCamera(ndc, scene.camera);
		// a small thing: pick it up, walking up to it first if it is not at hand
		const thing = items.itemAt(ray.intersectObjects(items.meshes, true)[0]?.object ?? new THREE.Object3D());
		if (thing && !thing.holder) {
			pickUp(thing.id);
			return;
		}
		// avatars first: clicking someone selects them as the one to talk to. Their reach (avatars.ts) is on
		// layer 0, their VRM meshes may be on the first-person layers (camera.ts): look on every layer
		const reach = new THREE.Raycaster();
		reach.setFromCamera(ndc, scene.camera);
		reach.layers.enableAll();
		const hit = reach.intersectObjects(
			[...avatars.values()].filter((v) => v.state.id !== myId).map((v) => v.root),
			true,
		)[0];
		if (hit) {
			let o: THREE.Object3D | null = hit.object;
			while (o && !o.userData.avatarId) o = o.parent;
			if (o) {
				setTarget(o.userData.avatarId as string);
				input.focus();
				return;
			}
		}
		// a click on a portal walks up to it
		const gate = portals.portalOf(ray.intersectObjects(portals.objects, true)[0]?.object ?? null);
		if (gate) {
			goToGate(gate);
			return;
		}
		// a click on something built walks up to it
		const p = scene.pickGround(ndc, builds.objects);
		if (!p) return;
		stopGoing();
		if (!walkTo([p.x, p.z], e.shiftKey ? RUN_SPEED : WALK_SPEED)) showToast("そこへは行けません");
	});

	/** Walks along the navmesh to `to`. False if there is no way there. */
	function walkTo(to: Vec2, speed: number): boolean {
		const mine = myId ? avatars.get(myId) : undefined;
		if (!mine) return false;
		const from = poseAt(mine.state.move, conn.hostNow()).pos;
		const path = nav.findPath(from, to);
		if (!path || path.length < 2) return false;
		// as much of the way as the host takes at once (a longer way stops short)
		const leg = pathLeg(path);
		// move right away; the host's MOVED (or CORRECT) replaces this
		mine.setMove({ kind: "path", path: leg, speed, at: conn.hostNow() });
		conn.send({ t: "MOVE_PATH", path: leg, speed, seq: ++seq });
		return true;
	}

	// ---- following someone (そばへ行く) ----
	/** Stop this close to them, plan again this often while they move, and give up after this long. */
	const FOLLOW_STOP_M = 2;
	const FOLLOW_REPLAN_MS = 1000;
	const FOLLOW_MAX_MS = 60_000;
	/** Behind your AI to a place (docs/prd.md 3.4.10): this far behind it, for at most this long. */
	const LEAD_BEHIND_M = 1.5;
	const LEAD_FOLLOW_MAX_MS = 5 * 60_000;
	let following: {
		id: AvatarId;
		until: number;
		plannedAt: number;
		/** Following your AI to a place it asked you along to. */
		lead?: { to: Vec2; place: string };
	} | null = null;
	function startFollow(id: AvatarId): void {
		const them = avatars.get(id);
		if (!them || id === myId) return;
		stopGoing();
		following = { id, until: performance.now() + FOLLOW_MAX_MS, plannedAt: 0 };
		showToast(`${them.state.name} のそばへ向かいます`);
	}
	/**
	 * A gesture or a posture (docs/prd.md 3.4.5), for the person talked to if any. Walking on a click's path
	 * stops first, so the body can show it; pressing the posture you are in stands up.
	 */
	function act(motion: Motion): void {
		const mine = myId ? avatars.get(myId) : undefined;
		if (!mine) return;
		const now = conn.hostNow();
		const move = mine.state.move;
		const { pos, moving } = poseAt(move, now);
		if (move.kind === "idle" && move.posture === motion) {
			mine.setMove({ kind: "idle", pos, at: now });
			conn.send({ t: "MOVE_VEL", pos, dir: [0, 0], speed: 0, seq: ++seq });
			return;
		}
		stopGoing();
		const steering = ["w", "a", "s", "d"].some((k) => keys.has(k));
		if (moving && !steering) {
			mine.setMove({ kind: "idle", pos, at: now });
			conn.send({ t: "MOVE_VEL", pos, dir: [0, 0], speed: 0, seq: ++seq });
		}
		// a roll goes somewhere: along the heading, as a path that takes as long as the roll (if it is clear)
		const travel = TRAVEL.get(motion);
		const duration = mine.durationOf(motion);
		if (travel && duration && !steering) {
			const h = mine.heading;
			const to: Vec2 = [pos[0] + Math.sin(h) * travel, pos[1] + Math.cos(h) * travel];
			if (validatePath(mesh, [pos, to]).ok) {
				const speed = Math.abs(travel) / duration;
				mine.setMove({ kind: "path", path: [pos, to], speed, at: now });
				conn.send({ t: "MOVE_PATH", path: [pos, to], speed, seq: ++seq });
			}
		}
		conn.send(talkTo ? { t: "ACTION", motion, target: talkTo } : { t: "ACTION", motion });
	}
	/** Asks the person chosen to do something together (docs/prd.md 3.4.6). */
	function offer(kind: Together): void {
		const mine = myId ? avatars.get(myId) : undefined;
		const them = talkTo ? avatars.get(talkTo) : undefined;
		if (!mine || !them || !talkTo) {
			showToast(`${TOGETHER_LABEL[kind]}する相手をクリックして選んでください`);
			return;
		}
		const now = conn.hostNow();
		if (dist(poseAt(mine.state.move, now).pos, poseAt(them.state.move, now).pos) > OFFER_REACH) {
			showToast(`${them.state.name}さんのそばに行ってから申し込んでください（F キーでそばへ）`);
			return;
		}
		conn.send({ t: "OFFER", kind, to: talkTo });
		showToast(`${them.state.name}さんに${TOGETHER_LABEL[kind]}を申し込みました`);
	}
	let offerTimer: ReturnType<typeof setTimeout> | undefined;
	/** Someone asks: yes or no, gone after OFFER_TTL_MS (no answer is a no). */
	function showOffer(from: AvatarId, kind: Together): void {
		const name = avatars.get(from)?.state.name ?? "だれか";
		ask(from, `${name}さんが${TOGETHER_LABEL[kind]}を申し込んでいます`, "受ける", "断る");
	}
	/** Your AI would like you to come along somewhere (docs/prd.md 3.4.10); its line is for you only. */
	function showLead(from: AvatarId, place: string, text: string | undefined): void {
		const ai = avatars.get(from);
		const name = ai?.state.name ?? "AI";
		if (text) {
			ai?.say(text, conn.hostNow());
			addLog(`${name} → あなた`, text);
		}
		ask(from, `${name}が${place}へ行きたがっています`, "ついていく", "やめとく");
	}
	/** The yes-or-no box: the answer goes to `from` (ANSWER). */
	function ask(from: AvatarId, question: string, yes: string, no: string): void {
		offerBox.replaceChildren(el("span", "", question));
		const reply = (accept: boolean) => {
			conn.send({ t: "ANSWER", to: from, accept });
			offerBox.hidden = true;
			clearTimeout(offerTimer);
		};
		for (const [label, accept] of [
			[yes, true],
			[no, false],
		] as const) {
			const b = el("button", accept ? "" : "rj-secondary", label);
			b.type = "button";
			b.onclick = () => reply(accept);
			offerBox.append(b);
		}
		offerBox.hidden = false;
		clearTimeout(offerTimer);
		offerTimer = setTimeout(() => (offerBox.hidden = true), OFFER_TTL_MS);
	}
	/** Picks up a thing (docs/prd.md 3.4.7): at once if it is at hand, otherwise after walking up to it. */
	let pickAfter: ItemId | null = null;
	/** Bend down this close to it (the host allows ITEM_REACH), so the hand meets the thing. */
	const PICK_FROM = 0.6;
	function pickUp(id: ItemId): void {
		const mine = myId ? avatars.get(myId) : undefined;
		const thing = items.meshes.find((o) => o.userData.itemId === id);
		if (!mine || !thing) return;
		if (myId && items.heldBy(myId)) {
			showToast("もう何か持っています（G で置く、T で投げる）");
			return;
		}
		stopGoing();
		const here = poseAt(mine.state.move, conn.hostNow()).pos;
		if (Math.hypot(thing.position.x - here[0], thing.position.z - here[1]) <= PICK_FROM) {
			pickNow(id);
			return;
		}
		if (walkTo([thing.position.x, thing.position.z], WALK_SPEED)) pickAfter = id;
		else showToast("そこへは行けません");
	}
	function pickStep(): void {
		const mine = myId ? avatars.get(myId) : undefined;
		const thing = pickAfter ? items.meshes.find((o) => o.userData.itemId === pickAfter) : undefined;
		if (!mine || !thing || !pickAfter) return;
		const { pos, moving } = poseAt(mine.state.move, conn.hostNow());
		const d = Math.hypot(thing.position.x - pos[0], thing.position.z - pos[1]);
		if (d <= PICK_FROM || !moving) {
			if (d <= ITEM_REACH) pickNow(pickAfter);
			pickAfter = null;
		}
	}
	/**
	 * With your AI by you, a click's walk that has come to its end says so (keys do on letting go): the host
	 * then brings the AI up close (docs/prd.md 3.4.9). Following someone, the next leg is on its way.
	 */
	function stopStep(): void {
		const mine = myId ? avatars.get(myId) : undefined;
		if (!mine || following || mine.state.move.kind !== "path") return;
		const now = conn.hostNow();
		const { pos, moving } = poseAt(mine.state.move, now);
		if (moving) return;
		mine.setMove({ kind: "idle", pos, at: now });
		conn.send({ t: "MOVE_VEL", pos, dir: [0, 0], speed: 0, seq: ++seq });
	}
	/** Stops where it is (the body cannot bend down while walking), then picks up. */
	function pickNow(id: ItemId): void {
		const mine = myId ? avatars.get(myId) : undefined;
		if (!mine) return;
		const now = conn.hostNow();
		const { pos, moving } = poseAt(mine.state.move, now);
		if (moving) {
			mine.setMove({ kind: "idle", pos, at: now });
			conn.send({ t: "MOVE_VEL", pos, dir: [0, 0], speed: 0, seq: ++seq });
		}
		conn.send({ t: "PICK", item: id });
	}
	/** Within this distance a thing can be picked up with the button or E (walking up to it first). */
	const PICK_NEAR = 4;
	/** The closest thing lying on the ground within PICK_NEAR, if not holding anything. */
	function nearestThing(): ItemId | null {
		const mine = myId ? avatars.get(myId) : undefined;
		if (!mine || !myId || items.heldBy(myId)) return null;
		const p = mine.root.position;
		let best: { id: ItemId; d: number } | null = null;
		for (const o of items.meshes) {
			const item = items.itemAt(o);
			if (!item || item.holder) continue;
			const d = Math.hypot(o.position.x - p.x, o.position.z - p.z);
			if (d <= PICK_NEAR && (!best || d < best.d)) best = { id: item.id, d };
		}
		return best?.id ?? null;
	}
	function pickNearest(): void {
		const id = nearestThing();
		if (id) pickUp(id);
	}
	/**
	 * Your own AI to pat: the one chosen, if it is yours, else the closest of yours within BODY_CALL_REACH
	 * (the host brings it up to you).
	 */
	function myAiToPat(): AvatarView | null {
		const mine = myId ? avatars.get(myId) : undefined;
		if (!mine) return null;
		const ours = [...avatars.values()].filter((a) => a.state.kind === "ai" && a.state.ownerId === myId);
		const near = (a: AvatarView) => a.root.position.distanceTo(mine.root.position);
		const chosen = ours.find((a) => a.state.id === talkTo);
		if (chosen && near(chosen) <= BODY_CALL_REACH) return chosen;
		return ours.filter((a) => near(a) <= BODY_CALL_REACH).sort((a, b) => near(a) - near(b))[0] ?? null;
	}
	/** Stops where it is, and pats your AI's head: the hand on top, gently from side to side. */
	function patMine(): void {
		const ai = myAiToPat();
		const mine = myId ? avatars.get(myId) : undefined;
		if (!ai || !mine) {
			showToast("自分のAIのそばで押してください");
			return;
		}
		stopGoing();
		const now = conn.hostNow();
		const { pos, moving } = poseAt(mine.state.move, now);
		if (moving) {
			mine.setMove({ kind: "idle", pos, at: now });
			conn.send({ t: "MOVE_VEL", pos, dir: [0, 0], speed: 0, seq: ++seq });
		}
		conn.send({ t: "BODY", keys: PAT, to: ai.state.id });
	}
	/** Throws what is in hand the way the avatar faces. */
	function throwHeld(): void {
		const mine = myId ? avatars.get(myId) : undefined;
		if (!mine || !myId || !items.heldBy(myId)) return;
		const h = mine.heading;
		conn.send({ t: "THROW", dir: [Math.sin(h), Math.cos(h)] });
	}
	/** Stops following someone or going to a portal (the person moves on their own). */
	function stopGoing(): void {
		endFollow();
		toGate = null;
	}
	/** After your yes, your AI walks to a place and you follow behind it until it is there. */
	function trail(id: AvatarId, to: Vec2, place: string): void {
		const them = avatars.get(id);
		if (!them) return;
		toGate = null;
		following = { id, until: performance.now() + LEAD_FOLLOW_MAX_MS, plannedAt: 0, lead: { to, place } };
		showToast(`${them.state.name}について${place}へ向かいます`);
	}
	/** Stops following; behind your AI to a place, it walks beside you again (the host hears COMPANION). */
	function endFollow(): void {
		if (following?.lead && companion) conn.send({ t: "COMPANION", on: true });
		following = null;
	}
	function followStep(t: number): void {
		if (!following) return;
		const mine = myId ? avatars.get(myId) : undefined;
		const them = avatars.get(following.id);
		if (!mine || !them || t > following.until) {
			if (!them) showToast("相手を見失いました");
			endFollow();
			return;
		}
		const now = conn.hostNow();
		const here = poseAt(mine.state.move, now).pos;
		const there = poseAt(them.state.move, now).pos;
		const d = Math.hypot(there[0] - here[0], there[1] - here[1]);
		const lead = following.lead;
		if (lead) {
			// your AI stopped where it was going, with you just behind: there
			const { moving } = poseAt(them.state.move, now);
			if (!moving && dist(there, lead.to) < 1.5 && d <= FOLLOW_STOP_M + 0.5) {
				showToast(`${lead.place}に着きました`);
				addLog("", `${them.state.name}と${lead.place}に着きました`, "sys");
				endFollow();
				return;
			}
			if (t - following.plannedAt < FOLLOW_REPLAN_MS) return;
			// a little short of where it will be in a moment, so you walk on with it rather than stop and go
			const soon = poseAt(them.state.move, now + FOLLOW_REPLAN_MS).pos;
			const ds = Math.hypot(soon[0] - here[0], soon[1] - here[1]);
			if (ds < LEAD_BEHIND_M + 0.3) return;
			following.plannedAt = t;
			const k = LEAD_BEHIND_M / ds;
			const goal: Vec2 = [soon[0] + (here[0] - soon[0]) * k, soon[1] + (here[1] - soon[1]) * k];
			// a way not found now may be found at the next try
			const speed = d > 5 ? RUN_SPEED : WALK_SPEED;
			if (!walkTo(goal, speed)) walkTo(soon, speed);
			return;
		}
		if (d <= FOLLOW_STOP_M) {
			showToast(`${them.state.name} のそばに着きました`);
			following = null;
			return;
		}
		if (t - following.plannedAt < FOLLOW_REPLAN_MS) return;
		following.plannedAt = t;
		// aim a little short of them, on our side; run while far, so a walking AI can be caught up with
		const k = Math.min(1, (FOLLOW_STOP_M * 0.75) / d);
		const goal: Vec2 = [there[0] + (here[0] - there[0]) * k, there[1] + (here[1] - there[1]) * k];
		if (!walkTo(goal, d > 4 ? RUN_SPEED : WALK_SPEED) && !walkTo(there, d > 4 ? RUN_SPEED : WALK_SPEED)) {
			showToast("そこへは行けません");
			following = null;
		}
	}

	// ---- going to a portal (🚪 門へ) ----
	/** Run while farther than this, plan the next leg this often, and give up after this long. */
	const GATE_RUN_M = 10;
	const GATE_REPLAN_MS = 1000;
	const GATE_MAX_MS = 5 * 60_000;
	/** `from`: where the last leg started, to notice when it took us nowhere. */
	let toGate: { gate: Portal; until: number; plannedAt: number; from: Vec2 | null } | null = null;
	/** Walks to `gate` (the nearest one if not given), in as many legs as the way needs. */
	function goToGate(gate?: Portal): void {
		const mine = myId ? avatars.get(myId) : undefined;
		const to = gate ?? (mine ? portals.nearest(poseAt(mine.state.move, conn.hostNow()).pos) : null);
		if (!to) return;
		stopGoing();
		toGate = { gate: to, until: performance.now() + GATE_MAX_MS, plannedAt: 0, from: null };
		showToast(`${to.name}へ向かいます`);
	}
	function gateStep(t: number): void {
		if (!toGate) return;
		const mine = myId ? avatars.get(myId) : undefined;
		if (!mine || t > toGate.until) {
			toGate = null;
			return;
		}
		const pose = poseAt(mine.state.move, conn.hostNow());
		// still walking a leg
		if (pose.moving) return;
		const d = dist(pose.pos, toGate.gate.pos);
		// there: the button to go through shows
		if (d <= PORTAL_REACH) {
			toGate = null;
			return;
		}
		if (t - toGate.plannedAt < GATE_REPLAN_MS) return;
		// the last leg took us nowhere (no way there, or the host did not take it)
		if (toGate.from && dist(pose.pos, toGate.from) < 0.5) {
			showToast("そこへは行けません");
			toGate = null;
			return;
		}
		toGate.plannedAt = t;
		toGate.from = pose.pos;
		if (!walkTo(toGate.gate.pos, d > GATE_RUN_M ? RUN_SPEED : WALK_SPEED)) {
			showToast("そこへは行けません");
			toGate = null;
		}
	}

	// ---- loop ----
	let last = performance.now();
	let placed = false;
	/** __rj.look() stops the camera from following your avatar (for screenshots). */
	let followCamera = true;
	let shownGate: ReturnType<PortalsView["near"]> = null;
	/** Avatars in their bath towel now, and those whose towel is ready (docs/prd.md 3.8.6). */
	const bathers = new WeakSet<AvatarView>();
	const readied = new WeakSet<AvatarView>();
	const frame = (t: number) => {
		const dt = Math.min(0.1, (t - last) / 1000);
		last = t;
		const now = conn.hostNow();
		for (const v of avatars.values()) {
			// an AI looks at its owner close by, so the owner sees its face (docs/prd.md 3.4.9)
			const owner = v.state.kind === "ai" && v.state.ownerId ? avatars.get(v.state.ownerId) : undefined;
			const near = owner && owner.root.position.distanceTo(v.root.position) < ATTEND_M;
			v.attend(near ? owner.eyePosition() : null);
			v.update(now, dt, scene);
			// at the onsen everyone has taken their clothes off and wears a bath towel; the towel is made
			// before they get there (the first one of a model takes a moment)
			const at = poseAt(v.state.move, now).pos;
			const bathing = zones.at(at, "bath") !== null;
			if (bathing !== bathers.has(v)) {
				v.setBathing(bathing);
				if (bathing) bathers.add(v);
				else bathers.delete(v);
			} else if (!bathing && !readied.has(v) && zones.near(at, "bath", 25)) {
				readied.add(v);
				v.prepareBath();
			}
		}
		items.update(now);
		pickButton.hidden = nearestThing() === null;
		patButton.hidden = myAiToPat() === null;
		const withAi = [...avatars.values()].some((a) => a.state.kind === "ai" && a.state.ownerId === myId);
		companionButton.hidden = !withAi;
		const mine = myId ? avatars.get(myId) : undefined;
		// indoors the camera looks from your eyes (from behind it would be above the ceiling)
		const indoors = mine ? zones.at(poseAt(mine.state.move, now).pos, "indoor") !== null : false;
		if (indoors && !viewOutside && view.view !== "eyes") {
			viewOutside = view.view;
			view.set("eyes", mine ?? null);
		} else if (!indoors && viewOutside) {
			view.set(viewOutside, mine ?? null);
			viewOutside = null;
		}
		// working or studying: where you stand offers it, and while at it, the way to stop
		const job = mine?.state.job;
		stopJobButton.hidden = !job;
		stopJobButton.title = job === "work" ? "働くのをやめる" : "勉強をやめる";
		for (const [i, kind] of (["work", "study"] as const).entries()) {
			const b = jobButtons[i] as HTMLButtonElement;
			b.hidden = !!job || !mine || zones.at(poseAt(mine.state.move, now).pos, kind) === null;
		}
		nature?.update(dt, now);
		if (keys.size > 0) steer(t);
		followStep(t);
		if (companion && withAi) stopStep();
		pickStep();
		gateStep(t);
		// stop at the edge of the walkable area instead of walking into walls
		if (mine?.state.move.kind === "vel") {
			const ahead = poseAt(mine.state.move, now + 150).pos;
			if (!nav.isWalkable(ahead)) steer(t, true);
		}
		if (mine && !placed) {
			scene.jumpTo(mine.root.position);
			placed = true;
		}
		shops.update(mine ? poseAt(mine.state.move, now).pos : null);
		// at a portal: offer the way through
		const gateHere = mine ? portals.near(poseAt(mine.state.move, now).pos) : null;
		if (gateHere !== shownGate) {
			shownGate = gateHere;
			travel.hidden = !gateHere;
			gateButton.hidden = gates.length === 0 || !!gateHere;
			if (gateHere) {
				travel.textContent = `🚪 ${areas.areas[gateHere.to]?.name ?? gateHere.name}へ行く`;
				travel.onclick = () => {
					conn.stop();
					location.href = travelUrl(gateHere, avatarParam);
				};
			}
		}
		if (mine && followCamera) view.update(mine, poseAt(mine.state.move, now).moving, dt);
		else scene.controls.update();
		scene.render();
		requestAnimationFrame(frame);
	};
	requestAnimationFrame(frame);
}
