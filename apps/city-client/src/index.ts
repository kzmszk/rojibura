// rojibura city client (docs/prd.md 3.4): login, the 3D city, click-to-move, chat.

import {
	applyBuilds,
	type KeepOut,
	keepingOut,
	NavMesh,
	type NavMeshData,
	validatePath,
} from "@rojibura/nav";
import {
	ACTIVITY_REACH,
	type ActivitiesData,
	type Activity,
	type AvatarId,
	activityOpen,
	BODY_CALL_REACH,
	type BodyKey,
	cityTime,
	clockText,
	type Doing,
	deltaText,
	dist,
	energyWord,
	FLY_ALT_MAX,
	FLY_ALT_MIN,
	FLY_REACH,
	FLY_RUN_SPEED,
	FLY_SPEED,
	type HostToClient,
	hoursText,
	ITEM_REACH,
	type ItemId,
	type LifeState,
	MAX_SAY_LENGTH,
	MEALS_PER_DAY,
	type Motion,
	OFFER_REACH,
	OFFER_TTL_MS,
	type Portal,
	type PublishedBuilds,
	pathLeg,
	poseAt,
	RUN_SPEED,
	SEAT_NEAR,
	SEAT_REACH,
	type Seat,
	type SeatsData,
	SKILL_NAMES,
	seatsOf,
	TOGETHER_MS,
	type Together,
	travelReason,
	type Vec2,
	WALK_SPEED,
} from "@rojibura/protocol";
import * as THREE from "three";
import { AgentPanel } from "./agent-panel.ts";
import { api, onApiUsage } from "./api.ts";
import { AreaNature, SEASON_LABEL } from "./area-nature.ts";
import { currentArea, DETAIL_KEY, savedDetail, sceneFiles, touchFirst, travelUrl } from "./areas.ts";
import { AvatarView, setSeats, TRAVEL } from "./avatars.ts";
import { BuildPanel } from "./build-ui.ts";
import { BuildsView, makeObject, modelsFromHost } from "./builds.ts";
import { VIEW_LABEL, VIEWS, type View, ViewController } from "./camera.ts";
import { ItemsView } from "./items.ts";
import { type MapPlace, MapView } from "./map.ts";
import { actionBar, Relations, showAdmin } from "./moderation.ts";
import { SEASONS, type Season } from "./nature/season.ts";
import { CityConnection, type ConnState } from "./net.ts";
import { rememberFirstVisit, reportFirstVisit } from "./onboarding.ts";
import { PORTAL_REACH, PortalsView } from "./portals.ts";
import { CityScene } from "./scene.ts";
import { SettingsPanel } from "./settings.ts";
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
	stepback: "🔙",
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
/** An AI this close to its owner attends to them (docs/prd.md 3.4.9). */
const ATTEND_M = 5;
/** A warp not answered in this long did not happen (ms). */
const WARP_WAIT_MS = 3_000;
/** After a line between an AI and its owner, it faces them and looks them in the eye this long. */
const TALK_FACE_MS = 20_000;
/** Beside its owner, not talking: how it stands changes this often; it turns this far to them, at most. */
const MOOD_MS = 8_000;
const TOWARD_OWNER = 0.35;

/** A number in [0, 1) from a string (FNV-1a): the same on every screen. */
function hash01(s: string): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
	return (h >>> 0) / 2 ** 32;
}

/**
 * An AI standing beside its owner, not talking (docs/prd.md 3.4.9): it faces the way they face, turned a little
 * to them; now and then it looks elsewhere for a while, or glances at them. From the time, so every screen
 * shows the same.
 */
function besideMood(ai: AvatarView, owner: AvatarView, hostNow: number): { facing: number; glance: boolean } {
	const slot = Math.floor(hostNow / MOOD_MS);
	const r = hash01(`${ai.state.id}:${slot}`);
	const g = hash01(`${slot}:${ai.state.id}`);
	const a = ai.root.position;
	const o = owner.root.position;
	const toward = Math.atan2(o.x - a.x, o.z - a.z);
	const off = Math.atan2(Math.sin(toward - owner.heading), Math.cos(toward - owner.heading));
	const look = r < 0.5 ? (r - 0.25) * 2.4 : 0;
	return {
		facing: owner.heading + Math.max(-TOWARD_OWNER, Math.min(TOWARD_OWNER, off)) + look,
		glance: g < 0.45 && hostNow % MOOD_MS < 2_500,
	};
}
/** A line in the chat log stays this long, then shows only while talking or pointing at the log. */
const LOG_FRESH_MS = 20_000;
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

/** What the map shows: the walkable area and a margin round it (x0, z0, x1, z1). */
function mapBounds(data: NavMeshData): [number, number, number, number] {
	let [x0, z0, x1, z1] = [Infinity, Infinity, -Infinity, -Infinity];
	const v = data.vertices;
	for (let i = 0; i < v.length; i += 3) {
		x0 = Math.min(x0, v[i] as number);
		x1 = Math.max(x1, v[i] as number);
		z0 = Math.min(z0, v[i + 2] as number);
		z1 = Math.max(z1, v[i + 2] as number);
	}
	const m = Math.max(x1 - x0, z1 - z0) * 0.03;
	return [x0 - m, z0 - m, x1 + m, z1 + m];
}

/** Walking on the navmesh, kept out of the rooms in `out()` (the other sex's changing room, docs/prd.md 3.8.6). */
function navigatorFor(mesh: NavMesh, out: () => KeepOut[]): Navigator {
	const queries = {
		isWalkable: (p: Vec2) => mesh.isWalkable(p),
		validatePath: (path: Vec2[]) => validatePath(mesh, path).ok,
		closestPoint: (p: Vec2) => mesh.closestPoint(p),
		findPath: (from: Vec2, to: Vec2) => mesh.findPath(from, to),
	};
	const walk = () => keepingOut(queries, out());
	return {
		findPath: (from, to) => {
			const w = walk();
			const start = w.closestPoint(from);
			const end = w.closestPoint(to);
			// clicking on a building: walk to the nearest walkable point if it is close
			if (Math.hypot(end[0] - to[0], end[1] - to[1]) > 3) return null;
			return w.findPath?.(start, end) ?? null;
		},
		isWalkable: (p) => walk().isWalkable(p),
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
	const select = el("select", "rj-select");
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
	scene.applyView(area.view, sceneFiles(area, params).lite);
	const loading = el("div", "rj-toast show", `${area.name}を読み込んでいます…`);
	root.append(loading);
	// what is needed to enter, fetched together: the walkable area, the 3D near where you arrive, the trees (their
	// leaves are drawn in a worker meanwhile) and the places with rules of their own (indoors, the onsen)
	// the area's places, and where you arrive: at the portal you came through, else where everyone arrives
	const landmarksFile = fetch(`${area.dir}/landmarks.json`)
		.then((r) =>
			r.ok
				? (r.json() as Promise<{
						landmarks: { id: string; name: string; pos: Vec2; major?: boolean }[];
						spawn?: { pos: Vec2 };
					}>)
				: null,
		)
		.catch(() => null);
	const arriving = area.bounds
		? ((area.portals ?? []).find((p) => p.id === params.get("at"))?.pos ??
			(await landmarksFile)?.spawn?.pos ??
			null)
		: null;
	const files = sceneFiles(area, params, arriving);
	const urlOf = (f: string) => new URL(f, new URL(area.assetBase, location.href)).href;
	const sceneUrls = files.files.map(urlOf);
	const zones = new Zones();
	const [base, prepared, cityRoots] = await Promise.all([
		loadNavMesh(area.dir, building),
		AreaNature.prepare(area),
		scene.loadCity(sceneUrls, (n) => {
			loading.textContent = `${area.name}を読み込んでいます…（${n}/${sceneUrls.length}）`;
		}),
		zones.load(area.dir),
	]);
	let mesh = NavMesh.fromJSON(base);
	// the changing room of the other sex is not walked into (your look's sex, once the host has said who you are)
	const keepOut = () => zones.keepOut(myId ? avatars.get(myId)?.state.assets.sex : undefined);
	let nav = navigatorFor(mesh, keepOut);
	scene.heightHint = (x, z) => mesh.heightAt([x, z]);
	// trees and seasons, where the area has them (docs/prd.md 3.8.6)
	const nature = await AreaNature.create(scene, area, cityRoots, params, prepared);
	loading.remove();
	const portals = new PortalsView(
		scene.scene,
		area.portals ?? [],
		(x, z) => mesh.heightAt([x, z]) ?? scene.heightAt(x, z),
	);
	// the map (docs/prd.md 3.4.14): the area from above, drawn the first time it opens; a place on it warps you there
	const cityMap = new MapView(
		area.name,
		mapBounds(base),
		() =>
			scene.renderMap(mapBounds(base), 1400, area.view?.mapCut, [
				...portals.objects,
				...[...avatars.values()].map((v) => v.root),
				items.group,
			]),
		(p) => warpTo(p),
		(p) => walkToPlace(p),
	);
	// the rest of the area's 3D (farther from where you arrive) loads now that you are in, one file after another
	void (async () => {
		for (const url of files.later.map(urlOf)) {
			const roots = await scene.loadCity([url]).catch((e: unknown) => {
				console.warn("could not load", url, e);
				return [];
			});
			nature?.addCity(roots);
			cityMap.stale();
		}
	})();
	// what can be done where (docs/life.md 3): the area's activities, and its places
	let activities: Activity[] = [];
	const places = new Map<string, Vec2>();
	const lifeFiles = Promise.all([
		fetch(`${area.dir}/activities.json`)
			.then((r) => (r.ok ? (r.json() as Promise<ActivitiesData>) : null))
			.catch(() => null),
		landmarksFile,
	]).then(([a, l]) => {
		activities = Array.isArray(a?.activities) ? a.activities : [];
		for (const x of l?.landmarks ?? []) places.set(x.id, [x.pos[0], x.pos[1]]);
		// the map's places: an area that marks no main places has every one as main
		const marked = l?.landmarks.some((x) => x.major) ?? false;
		cityMap.setPlaces([
			...(l?.landmarks ?? []).map((x) => ({
				id: x.id,
				name: x.name,
				pos: x.pos,
				major: !marked || !!x.major,
			})),
			...(area.portals ?? []).map((p) => ({ id: p.id, name: p.name, pos: p.pos, major: true, gate: true })),
		]);
	});
	const badgeOf = (d?: Doing | null) => {
		if (!d) return null;
		const a = activities.find((x) => x.id === d.activity);
		return { emoji: a?.emoji ?? "⏳", name: a?.name ?? d.activity };
	};
	/** An AI's life in a few lines, for its owner's panel. */
	const lifeText = (life: LifeState, doing?: Doing, coins?: number) => {
		const skills = Object.entries(life.skills)
			.filter(([, v]) => v > 0)
			.map(([k, v]) => `${SKILL_NAMES[k] ?? k} ${Math.round(v)}`)
			.join("・");
		const badge = badgeOf(doing);
		return [
			`暮らして${life.days}日目`,
			`エネルギー ${Math.round(life.energy)}（${energyWord(life.energy)}）・体力 ${Math.round(life.fitness)}・こころ ${Math.round(life.mood)}${coins !== undefined ? `・👛 ${coins} 銅貨` : ""}`,
			`今日：ごはん ${life.duties.meals}/${MEALS_PER_DAY}・仕事か勉強 ${life.duties.work ? "✓" : "まだ"}・運動 ${life.duties.exercise ? "✓" : "まだ"}`,
			...(skills ? [`腕前：${skills}`] : []),
			...(badge ? [`いま：${badge.emoji} ${badge.name}`] : []),
		].join("\n");
	};
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
			nav = navigatorFor(mesh, keepOut);
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
	// what is not used all the time is in the settings (docs/prd.md 3.4.12): the top keeps only ⚙️
	const settings = new SettingsPanel();
	const settingsButton = el("button", "rj-logout", "⚙️");
	settingsButton.type = "button";
	settingsButton.title = "設定";
	settingsButton.setAttribute("aria-label", "設定");
	settingsButton.onclick = () => settings.toggle();
	right.append(settingsButton);
	/** Opens a panel from the settings, in their place (they all sit at the top right). */
	const fromSettings = (open: () => void) => () => {
		settings.hide();
		open();
	};
	// where the camera looks from (docs/prd.md 3.4.8): chosen here, or V goes round the three
	const viewSelect = el("select", "rj-select");
	for (const v of VIEWS) {
		const o = el("option", "", VIEW_LABEL[v]);
		o.value = v;
		viewSelect.append(o);
	}
	viewSelect.title = "V キーでも切り替えられます";
	viewSelect.onchange = () => setView(viewSelect.value as View);
	settings.row("🎥 視点", viewSelect);
	settings.row("👤 見た目", avatarPicker(avatarParam));
	// your own AI (T3): it runs in this tab while it is open, unless it is on your PC (docs/prd.md 3.5.1)
	const myAi = el("button", "rj-secondary", "パネルを開く");
	myAi.type = "button";
	const agentPanel = new AgentPanel({ area: area.id, at: params.get("at") ?? undefined }, (running) => {
		myAi.textContent = running ? "このタブで街にいます" : "パネルを開く";
		myAi.classList.toggle("on", running);
	});
	myAi.onclick = fromSettings(() => agentPanel.show());
	if (openAi) agentPanel.show();
	settings.row("🤖 自分のAI", myAi);
	// the season you see (the date's, or one you choose): only you see it change (docs/prd.md 3.8.6)
	if (nature) {
		const seasonSelect = el("select", "");
		for (const season of SEASONS) {
			const o = el("option", "", SEASON_LABEL[season]);
			o.value = season;
			seasonSelect.append(o);
		}
		seasonSelect.value = nature.season;
		seasonSelect.title = "自分の画面だけ変わります";
		seasonSelect.onchange = () => void nature.setSeason(seasonSelect.value as Season);
		settings.row("🍁 季節", seasonSelect);
	}
	// lighter 3D for phones (docs/prd.md 3.8.1): only where the area has it; the page loads again to change it
	if (area.sceneLite) {
		const detailSelect = el("select", "");
		for (const [v, label] of [
			["auto", touchFirst() ? "自動（軽い）" : "自動（細かい）"],
			["full", "細かい"],
			["lite", "軽い（スマホ向け）"],
		] as const) {
			const o = el("option", "", label);
			o.value = v;
			detailSelect.append(o);
		}
		detailSelect.value = savedDetail();
		detailSelect.title = "変えると読み込み直します";
		detailSelect.onchange = () => {
			try {
				localStorage.setItem(DETAIL_KEY, detailSelect.value);
			} catch {
				// private mode: nothing to keep it in
			}
			const q = new URLSearchParams(location.search);
			q.delete("detail");
			location.search = q.toString();
		};
		settings.row("🖼️ 3Dの細かさ", detailSelect);
	}
	// your own AIs walk with you (docs/prd.md 3.4.9); shown while one of them is here
	const companionBox = el("input", "");
	companionBox.type = "checkbox";
	let companion = false;
	try {
		companion = localStorage.getItem("rj.companion") === "1";
	} catch {
		// private mode
	}
	companionBox.checked = companion;
	companionBox.onchange = () => {
		companion = companionBox.checked;
		// following your AI somewhere ends too (the host hears it from COMPANION)
		if (following?.lead) following = null;
		try {
			localStorage.setItem("rj.companion", companion ? "1" : "0");
		} catch {
			// private mode
		}
		conn.send({ t: "COMPANION", on: companion });
	};
	const companionLabel = el("label", "rj-settings-check");
	companionLabel.append(companionBox, document.createTextNode(" 自分のAIをそばにいさせる"));
	const companionRow = settings.row("", companionLabel);
	companionRow.hidden = true;
	const box = el("input", "");
	box.type = "checkbox";
	box.checked = me.allowAiApproach;
	box.onchange = () => void patchMe({ allowAiApproach: box.checked });
	const approach = el("label", "rj-settings-check");
	approach.append(box, document.createTextNode(" AIから話しかけられてもいい"));
	settings.row("", approach);
	// free-tier usage for admins, moderators and development builds (docs/prd.md 2.5)
	let usage: UsagePanel | null = null;
	if (devBuild || me.role === "moderator" || me.role === "admin") {
		const panel = new UsagePanel((on) => conn.send({ t: "WATCH_USAGE", on }));
		const toggle = el("button", "rj-secondary", "開く");
		toggle.type = "button";
		toggle.onclick = fromSettings(() => panel.show());
		settings.row("📊 利用状況", toggle);
		root.append(panel.el);
		onApiUsage((label, cost) => panel.addOwn(label, cost));
		usage = panel;
	}
	// the area's credits (licences of what is drawn): here, out of the way of the chat (docs/prd.md 3.8.1)
	if (area.credit) {
		const credit = el("div", "rj-settings-credit");
		credit.append(el("b", "", "📜 クレジット"), el("br", ""));
		// the list of sources is a page of the host
		for (const part of area.credit.split(/(\/areas\/[\w/.-]+\.html)/)) {
			if (/^\/areas\/.+\.html$/.test(part)) {
				const a = el("a", "", part);
				a.href = part;
				a.target = "_blank";
				a.rel = "noopener";
				credit.append(a);
			} else credit.append(document.createTextNode(part));
		}
		settings.row("", credit);
	}
	const links = el("div", "rj-settings-links");
	if (me.role === "moderator" || me.role === "admin") {
		const admin = el("a", "", "管理");
		admin.href = "/admin";
		links.append(admin);
	}
	const logout = el("a", "", "ログアウト");
	logout.href = "/auth/logout";
	links.append(logout);
	settings.row("", links);
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
	const mapButton = el("button", "rj-logout rj-gate", "🗺️ 地図");
	mapButton.type = "button";
	mapButton.title = "地図を開く（M）。主な場所へ瞬間移動できます";
	mapButton.onclick = () => cityMap.toggle();
	// floating in the air (docs/prd.md 3.4.13), where the area allows it: up and down while afloat
	const flyBar = el("div", "rj-fly");
	const flyButton = el("button", "rj-logout rj-gate", "🕊️ 浮かぶ");
	flyButton.type = "button";
	flyButton.title = "空に浮かぶ（U）。浮いている間はスペースで上へ、C で下へ";
	flyButton.onclick = () => toggleFly();
	const liftButtons = (["up", "down"] as const).map((way) => {
		const b = el("button", "rj-logout", way === "up" ? "⬆️" : "⬇️");
		b.type = "button";
		b.title = way === "up" ? "上へ（スペース）" : "下へ（C）";
		b.hidden = true;
		b.onpointerdown = () => lift.add(way);
		for (const ev of ["pointerup", "pointerleave", "pointercancel"] as const)
			b.addEventListener(ev, () => lift.delete(way));
		return b;
	});
	flyBar.append(flyButton, ...liftButtons);
	flyBar.hidden = !area.fly;
	const left = el("div", "rj-left");
	// your wallet (docs/prd.md 3.8.6): shown once the host tells it
	const purse = el("div", "rj-status rj-purse", "");
	purse.hidden = true;
	purse.title = "お店や宿で働くか、学校で勉強すると増える（1分で1銅貨）";
	left.append(status, purse, gateButton, mapButton, flyBar);
	hud.append(left, right);
	const chat = el("div", "rj-chat");
	// what was said fades after a while; it all comes back while talking or pointing at it (docs/prd.md 3.4.12)
	const log = el("div", "rj-log");
	log.tabIndex = -1;
	const form = el("form", "rj-say");
	// whom to talk to: anyone in the area, seen on screen or not
	const target = el("select", "rj-target");
	target.title = "話しかける相手（相手をクリックしても選べます）";
	const input = el("input", "");
	input.maxLength = MAX_SAY_LENGTH;
	input.placeholder = "Enter で話す（相手をクリックで話しかけ、WASD・矢印キーで歩く）";
	form.append(target, input);
	const motionBar = el("div", "rj-motions");
	// gestures and postures, and those done together with the person chosen (docs/prd.md 3.4.5, 3.4.6)
	const motionMenu = el("select", "rj-menu");
	motionMenu.title = "動作（1〜0 キーでも）";
	const motionTitle = el("option", "", "🙂 動作");
	motionTitle.value = "";
	motionTitle.disabled = true;
	motionTitle.hidden = true;
	motionMenu.append(motionTitle);
	for (const [motion, label, key] of ACTIONS) {
		const o = el(
			"option",
			"",
			`${MOTION_EMOJI[motion]} ${label}（${key}${motion === "jump" ? "、スペース" : ""}）`,
		);
		o.value = motion;
		motionMenu.append(o);
	}
	const togetherGroup = el("optgroup", "");
	togetherGroup.label = "選んだ相手と";
	for (const [kind, icon, label] of [
		["handshake", "🤝", "握手"],
		["hug", "🫂", "ハグ"],
	] as const) {
		const o = el("option", "", `${icon} ${label}を申し込む`);
		o.value = kind;
		togetherGroup.append(o);
	}
	motionMenu.append(togetherGroup);
	motionMenu.value = "";
	motionMenu.onchange = () => {
		const v = motionMenu.value;
		motionMenu.value = "";
		// the number keys and Space are moves again, not the menu's
		motionMenu.blur();
		if (v === "handshake" || v === "hug") offer(v);
		else if (v) act(v as Motion);
	};
	motionBar.append(motionMenu);
	// the thing in hand (3.4.7): a thing close by can be picked up with a button (or E), not only by clicking it
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
	// a bench, a sofa or a chair close by: sit on it (docs/prd.md 3.4.5), or get up from it
	const seatButton = el("button", "", "🪑 腰かける");
	seatButton.type = "button";
	seatButton.title = "近くのベンチや椅子に座る（R）";
	seatButton.hidden = true;
	seatButton.onclick = () => seatOrStand();
	motionBar.append(seatButton, pickButton, throwButton, dropButton, eatButton, ...jobButtons, stopJobButton);
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
	// at a place: what you can do there, and stopping what you are doing (docs/life.md 6)
	const actsBar = el("div", "rj-acts");
	actsBar.hidden = true;
	// at a shop's counter: what it sells (docs/prd.md 3.8.6)
	const shops = new ShopsUi((shop, goods) => conn.send({ t: "BUY", shop: shop.id, goods }));
	void shops.load(area.dir);
	// benches, sofas and chairs to sit on (docs/prd.md 3.4.5)
	let areaSeats: Seat[] = [];
	void fetch(`${area.dir}/seats.json`)
		.then((r) => (r.ok ? (r.json() as Promise<SeatsData>) : null))
		.catch(() => null)
		.then((d) => {
			areaSeats = seatsOf(d);
			setSeats(areaSeats);
		});
	root.append(hud, chat, toast, travel, actsBar, offerBox, agentPanel.el, settings.el, shops.el, cityMap.el);

	const avatars = new Map<AvatarId, AvatarView>();
	/** When an AI and its owner last spoke to each other (host time), by the AI. */
	const talkAt = new Map<AvatarId, number>();
	let myId: AvatarId | null = null;
	let talkTo: AvatarId | null = null;
	let seq = 0;

	const relations = new Relations(me.relations);
	let bar: ReturnType<typeof actionBar> | null = null;
	/** Everyone here but you, to choose whom to talk to; made again as people come and go. */
	const listTargets = () => {
		const everyone = el("option", "", "みんなへ");
		everyone.value = "";
		const others = [...avatars.values()]
			.filter((a) => a.state.id !== myId)
			.sort((a, b) => a.state.name.localeCompare(b.state.name, "ja"));
		target.replaceChildren(
			everyone,
			...others.map((a) => {
				const o = el("option", "", `→ ${a.state.name}${a.state.kind === "ai" ? "（AI）" : ""}`);
				o.value = a.state.id;
				return o;
			}),
		);
		target.value = talkTo ?? "";
	};
	const setTarget = (id: AvatarId | null) => {
		const a = id ? avatars.get(id) : undefined;
		talkTo = a ? a.state.id : null;
		listTargets();
		target.classList.toggle("on", !!a);
		bar?.show(a ? a.state.id : null, a?.state.name ?? "");
	};
	setTarget(null);
	target.onchange = () => {
		setTarget(target.value || null);
		input.focus();
	};

	const showToast = (text: string) => {
		toast.textContent = text;
		toast.classList.add("show");
		setTimeout(() => toast.classList.remove("show"), 4000);
	};
	/** The log shows only what is new unless you are talking or pointing at it. */
	const showLog = () => {
		const full = chat.matches(":focus-within") || log.matches(":hover");
		log.classList.toggle("full", full);
		log.hidden = !full && !log.querySelector(".rj-line:not(.old)");
		log.scrollTop = log.scrollHeight;
	};
	const addLog = (who: string, text: string, cls = "") => {
		const line = el("div", `rj-line ${cls}`);
		line.append(el("b", "", who), document.createTextNode(` ${text}`));
		log.append(line);
		while (log.childElementCount > 60) log.firstElementChild?.remove();
		setTimeout(() => {
			line.classList.add("old");
			showLog();
		}, LOG_FRESH_MS);
		showLog();
	};
	log.hidden = true;
	chat.addEventListener("focusin", showLog);
	// focus moves on after focusout: look once it has
	chat.addEventListener("focusout", () => setTimeout(showLog));
	log.addEventListener("pointerenter", showLog);
	log.addEventListener("pointerleave", showLog);
	let shownStatus: { state: ConnState; detail?: string } = { state: "connecting" };
	/** Host time, once connected. */
	let hostNow = () => Date.now();
	const updateStatus = (state: ConnState, detail?: string) => {
		shownStatus = { state, ...(detail ? { detail } : {}) };
		const label = { connecting: "接続中…", open: "接続済み", closed: "切断" }[state];
		// the city's own time (docs/life.md 1)
		const clock = clockText(cityTime(hostNow()).minutes);
		status.textContent = `${me.name} ｜ ${area.name} ｜ 🕰️ ${clock} ｜ ${detail ?? label} ｜ ${avatars.size}人`;
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
	motionBar.append(bar.el);

	const add = (s: AvatarView["state"]) => {
		if (relations.blocks.has(s.id)) return;
		avatars.get(s.id)?.dispose();
		const v = new AvatarView(s, s.id === myId);
		avatars.set(s.id, v);
		scene.scene.add(v.root);
		v.setDoing(badgeOf(s.doing));
	};
	// the activities arrive after the first people may have: their badges then
	void lifeFiles.then(() => {
		for (const v of avatars.values()) v.setDoing(badgeOf(v.state.doing));
	});
	const view = new ViewController(scene);
	/** The view chosen outside, while indoors switched it to the eyes. */
	let viewOutside: View | null = null;
	const setView = (v: View) => {
		viewOutside = null;
		view.set(v, myId ? (avatars.get(myId) ?? null) : null);
		viewSelect.value = v;
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
							if (!a.doing) delete v.state.doing;
							v.setDoing(badgeOf(a.doing));
							v.setStatus(a.status);
						} else {
							v?.dispose();
							avatars.delete(a.id);
							add(a);
						}
						// afloat or not, as the host has it
						avatars.get(a.id)?.setFly(a.fly ?? null);
						if (a.id === m.you) showFlying(a.fly ?? null);
						agentPanel.present(a.id);
					}
					listTargets();
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
					// a hug over, arms back down: one steps back a little (an AI hugged does too, by the host)
					if (m.kind === "hug" && (m.a === myId || m.b === myId)) {
						const spot = m.a === myId ? pa : pb;
						setTimeout(
							() => {
								const mine = myId ? avatars.get(myId) : undefined;
								if (!mine) return;
								const p = poseAt(mine.state.move, conn.hostNow());
								if (!p.moving && dist(p.pos, spot) < 0.2) act("stepback");
							},
							m.at + TOGETHER_MS.hug - conn.hostNow(),
						);
					}
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
					listTargets();
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
					else listTargets();
					break;
				}
				case "MOVED": {
					const v = avatars.get(m.id);
					// you, somewhere else at once (a warp, or landing): the camera goes with you
					if (v && m.id === myId && m.move.kind === "idle") {
						const at = poseAt(v.state.move, conn.hostNow()).pos;
						if (dist(at, m.move.pos) > 15) placed = false;
						if (warping) {
							showToast(`${warping.name}へ瞬間移動しました`);
							warping = null;
						}
					}
					v?.setMove(m.move);
					break;
				}
				case "FLEW": {
					// your own height is yours while afloat; only coming down is news
					if (m.id === myId && m.alt !== null && flyAlt !== null) break;
					avatars.get(m.id)?.setFly(m.alt);
					if (m.id === myId) showFlying(m.alt);
					break;
				}
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
					// an AI and its owner talking: it faces them (docs/prd.md 3.4.9)
					const heard = m.to ? avatars.get(m.to) : undefined;
					if (v?.state.kind === "ai" && (!m.to || m.to === v.state.ownerId))
						talkAt.set(v.state.id, conn.hostNow());
					if (heard?.state.kind === "ai" && heard.state.ownerId === m.id)
						talkAt.set(heard.state.id, conn.hostNow());
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
				// what people do at places (docs/life.md 3, 8)
				case "ACTING": {
					const v = avatars.get(m.id);
					if (!v) break;
					if (m.doing) v.state.doing = m.doing;
					else delete v.state.doing;
					v.setDoing(badgeOf(m.doing));
					shownActs = "";
					break;
				}
				case "ACT_DONE": {
					const a = activities.find((x) => x.id === m.activity);
					const change = m.delta ? deltaText(m.delta) : "";
					// an activity of the area, or (an AI's page) work done or something eaten
					showToast(
						a
							? `${a.emoji} ${a.name}を${m.share >= 0.999 ? "終えました" : "やめました"}${change ? `（${change}）` : ""}`
							: `${m.name ?? m.activity}${change ? `（${change}）` : ""}`,
					);
					break;
				}
				case "LIFE":
					agentPanel.life(m.id, lifeText(m.life, avatars.get(m.id)?.state.doing, m.coins));
					break;
				case "DIARY":
					agentPanel.diary(m);
					break;
				case "NOTICE":
					showToast(m.message);
					// a warp refused: the notice says why
					if (m.kind === "rejected") warping = null;
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
	hostNow = () => conn.hostNow();
	// the owner reads their AI's diary through this connection (docs/life.md 8)
	agentPanel.connect((m) => conn.send(m));
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
	// WASD: walk relative to the camera; sent as MOVE_VEL only when the direction changes (docs/prd.md 3.2.2).
	// "Forward" is where the camera looked when the keys held last changed: the view coming round behind the
	// avatar does not turn the way it walks (with A or D held it would walk round in jerky circles).
	const keys = new Set<string>();
	let softFocus = false;
	let sentVel: { dir: Vec2; speed: number; at: number } | null = null;
	let forward: { keys: string; f: THREE.Vector3 } | null = null;
	/** A key of two was let go: until then the way does not change yet (the other may follow at once). */
	let settleUntil = 0;
	const steer = (now: number, force = false) => {
		const mine = myId ? avatars.get(myId) : undefined;
		if (!mine || (now < settleUntil && !force)) return;
		const held = ["w", "a", "s", "d"].filter((k) => keys.has(k)).join("");
		// a key pressed or let go goes out at once (two pressed together make a diagonal straight away)
		const pressed = forward?.keys !== held;
		if (!forward || pressed || view.dragging) {
			const look = new THREE.Vector3();
			scene.camera.getWorldDirection(look);
			look.y = 0;
			forward = { keys: held, f: look.normalize() };
		}
		const f = forward.f.clone();
		const r = new THREE.Vector3(-f.z, 0, f.x);
		const fw = (keys.has("w") ? 1 : 0) - (keys.has("s") ? 1 : 0);
		const rt = (keys.has("d") ? 1 : 0) - (keys.has("a") ? 1 : 0);
		const v = f.multiplyScalar(fw).add(r.multiplyScalar(rt));
		const pos = poseAt(mine.state.move, conn.hostNow()).pos;
		const wanted = v.lengthSq() > 0;
		const dir: Vec2 = wanted ? [v.x / v.length(), v.z / v.length()] : [0, 0];
		const speed = wanted
			? flyAlt !== null
				? keys.has("shift")
					? FLY_RUN_SPEED
					: FLY_SPEED
				: keys.has("shift")
					? RUN_SPEED
					: WALK_SPEED
			: 0;
		// do not walk into walls or off the walkable area (afloat: not too far out from it)
		const moving = wanted && clearAhead(pos, dir, speed, 0.25);
		if (!moving && !sentVel) return;
		if (sentVel && !force) {
			const same =
				moving &&
				Math.abs(sentVel.speed - speed) < 0.01 &&
				sentVel.dir[0] * dir[0] + sentVel.dir[1] * dir[1] > 0.97;
			if (same || (moving && !pressed && now - sentVel.at < 150)) return;
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
		if (e.key === " ") lift.delete("up");
		if (e.key.toLowerCase() === "c") lift.delete("down");
		const k = movementKey(e);
		if (!k) return;
		keys.delete(k);
		// letting go of a diagonal's two keys is never quite at once: wait a moment before going the one way left
		if (["w", "a", "s", "d"].some((x) => keys.has(x))) {
			settleUntil = performance.now() + 80;
			setTimeout(() => steer(performance.now()), 90);
		} else {
			settleUntil = 0;
			steer(performance.now());
		}
	});
	addEventListener("blur", () => {
		keys.clear();
		steer(performance.now());
	});
	/** Typing in the chat or in the build menu: keys are text, not moves. */
	const typing = () =>
		document.activeElement instanceof HTMLInputElement ||
		document.activeElement instanceof HTMLTextAreaElement;
	// the chat box has the focus from a click on someone (to talk to them): until something is typed in it, the
	// keys that walk still walk (else the one you clicked, standing in front of you, kept you from walking)
	input.addEventListener("input", () => {
		softFocus = false;
	});
	input.addEventListener("blur", () => {
		softFocus = false;
	});
	addEventListener("keydown", (e) => {
		const k = movementKey(e);
		if (k && k !== "shift" && softFocus && document.activeElement === input && !input.value && !e.isComposing)
			input.blur();
		if (k && !typing()) {
			e.preventDefault();
			stopGoing();
			keys.add(k);
			settleUntil = 0;
			steer(performance.now());
			return;
		}
		if (e.key === "Enter" && !typing()) {
			input.focus();
			e.preventDefault();
		} else if (!typing() && flyAlt !== null && (e.key === " " || e.key.toLowerCase() === "c")) {
			// afloat, Space goes up and C down
			e.preventDefault();
			lift.add(e.key === " " ? "up" : "down");
		} else if (!typing() && !panel.open && e.key.toLowerCase() === "m") {
			cityMap.toggle();
		} else if (!typing() && !panel.open && e.key.toLowerCase() === "u" && area.fly) {
			toggleFly();
		} else if (!typing() && !panel.open && (e.key === " " || ACTIONS.some(([, , key]) => key === e.key))) {
			e.preventDefault();
			act(
				e.key === " " ? "jump" : (ACTIONS.find(([, , key]) => key === e.key) as (typeof ACTIONS)[number])[0],
			);
		} else if (!typing() && !panel.open && e.key.toLowerCase() === "v") {
			nextView();
		} else if (!typing() && !panel.open && e.key.toLowerCase() === "e") {
			pickNearest();
		} else if (!typing() && !panel.open && e.key.toLowerCase() === "r") {
			seatOrStand();
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
			cityMap.hide();
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
				softFocus = true;
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

	/** Walks along the navmesh to `to` (afloat: flies straight there). False if there is no way there. */
	function walkTo(to: Vec2, speed: number): boolean {
		const mine = myId ? avatars.get(myId) : undefined;
		if (!mine) return false;
		const from = poseAt(mine.state.move, conn.hostNow()).pos;
		if (flyAlt !== null) {
			if (!canBe(to)) return false;
			speed = speed > WALK_SPEED ? FLY_RUN_SPEED : FLY_SPEED;
		}
		const path = flyAlt !== null ? [from, to] : nav.findPath(from, to);
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
	// ---- sitting on a seat (🪑 腰かける, docs/prd.md 3.4.5) ----
	/** Stand this far in front of a seat to sit down on it. */
	const SEAT_FRONT = 0.5;
	/** The seat being walked to, to sit on once there. */
	let seatAfter: number | null = null;
	/** The seat you sit on now, if any. */
	function mySeat(): number | undefined {
		const move = myId ? avatars.get(myId)?.state.move : undefined;
		return move?.kind === "idle" && move.posture === "sit" ? move.seat : undefined;
	}
	/**
	 * The nearest free seat within SEAT_NEAR, facing your side of it (a bench with no back faces both ways), on
	 * about your level; null if none.
	 */
	function nearestSeat(): number | null {
		const mine = myId ? avatars.get(myId) : undefined;
		if (!mine) return null;
		const taken = new Set<number>();
		for (const v of avatars.values()) {
			const m = v.state.move;
			if (v !== mine && m.kind === "idle" && m.seat !== undefined) taken.add(m.seat);
		}
		const here = poseAt(mine.state.move, conn.hostNow()).pos;
		const y = mine.root.position.y;
		let best: { i: number; d: number } | null = null;
		areaSeats.forEach((s, i) => {
			if (taken.has(i) || Math.abs(s.y - y - 0.45) > 1) return;
			const dx = here[0] - s.pos[0];
			const dz = here[1] - s.pos[1];
			const d = Math.hypot(dx, dz);
			if (d > SEAT_NEAR || dx * s.face[0] + dz * s.face[1] < -0.05) return;
			if (!best || d < best.d) best = { i, d };
		});
		return (best as { i: number } | null)?.i ?? null;
	}
	/** Sits on the nearest free seat (walking up to it first), or gets up from the one you sit on. */
	function seatOrStand(): void {
		if (mySeat() !== undefined) {
			act("sit");
			return;
		}
		const i = nearestSeat();
		const seat = i === null ? undefined : areaSeats[i];
		const mine = myId ? avatars.get(myId) : undefined;
		if (i === null || !seat || !mine) {
			showToast("近くに座れる所がありません");
			return;
		}
		stopGoing();
		const front: Vec2 = [seat.pos[0] + seat.face[0] * SEAT_FRONT, seat.pos[1] + seat.face[1] * SEAT_FRONT];
		const here = poseAt(mine.state.move, conn.hostNow()).pos;
		if (dist(here, front) > 0.25 && walkTo(front, WALK_SPEED)) seatAfter = i;
		else sitOn(i);
	}
	function sitOn(i: number): void {
		const mine = myId ? avatars.get(myId) : undefined;
		const seat = areaSeats[i];
		if (!mine || !seat) return;
		const now = conn.hostNow();
		const { pos } = poseAt(mine.state.move, now);
		if (dist(pos, seat.pos) > SEAT_REACH) {
			showToast("そこには届きません");
			return;
		}
		mine.setMove({ kind: "idle", pos, at: now, posture: "sit", face: seat.face, seat: i });
		conn.send({ t: "ACTION", motion: "sit", seat: i });
	}
	function seatStep(): void {
		if (seatAfter === null) return;
		const mine = myId ? avatars.get(myId) : undefined;
		if (!mine) return;
		if (poseAt(mine.state.move, conn.hostNow()).moving) return;
		const i = seatAfter;
		seatAfter = null;
		sitOn(i);
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
	// ---- floating and warping (docs/prd.md 3.4.13, 3.4.14) ----
	/** Your height while afloat (world Y), or null on the ground. */
	let flyAlt: number | null = null;
	/** Going up or down while afloat (held keys or buttons). */
	const lift = new Set<"up" | "down">();
	let flySentAt = 0;
	let flySent: number | null = null;
	/** Somewhere you may be now: walkable, or afloat not too far out from it. */
	function canBe(p: Vec2): boolean {
		if (flyAlt === null) return nav.isWalkable(p);
		return dist(mesh.closestPoint(p), p) <= FLY_REACH - 1;
	}
	/**
	 * Somewhere you may be all along the next `s` seconds going `dir` at `speed`: a step at a time, so a narrow
	 * strip one may not walk on (a steep bank) is not stepped across.
	 */
	function clearAhead(pos: Vec2, dir: Vec2, speed: number, s: number): boolean {
		const d = speed * s;
		const n = Math.max(1, Math.ceil(d / (flyAlt === null ? 0.2 : 2)));
		for (let i = 1; i <= n; i++) {
			const t = (d * i) / n;
			if (!canBe([pos[0] + dir[0] * t, pos[1] + dir[1] * t])) return false;
		}
		return true;
	}
	function showFlying(alt: number | null): void {
		flyAlt = alt;
		flyButton.textContent = alt === null ? "🕊️ 浮かぶ" : "🛬 降りる";
		flyButton.classList.toggle("on", alt !== null);
		for (const b of liftButtons) b.hidden = alt === null;
		if (alt === null) lift.clear();
	}
	function toggleFly(): void {
		const mine = myId ? avatars.get(myId) : undefined;
		if (!mine || !area.fly) return;
		if (flyAlt !== null) {
			conn.send({ t: "FLY", alt: null });
			return;
		}
		stopGoing();
		const alt = Math.min(FLY_ALT_MAX, mine.root.position.y + 2.5);
		mine.setFly(alt);
		showFlying(alt);
		conn.send({ t: "FLY", alt });
		flySent = alt;
		flySentAt = performance.now();
	}
	/** Up or down while a key or button is held; others hear of it a few times a second. */
	function liftStep(mine: AvatarView | undefined, dt: number, t: number): void {
		if (!mine || flyAlt === null) return;
		if (lift.size > 0) {
			const under = scene.heightAt(mine.root.position.x, mine.root.position.z) ?? FLY_ALT_MIN;
			const way = (lift.has("up") ? 1 : 0) - (lift.has("down") ? 1 : 0);
			// up and down at 6 m/s, with Shift 15
			const rate = keys.has("shift") ? 15 : 6;
			flyAlt = Math.min(FLY_ALT_MAX, Math.max(FLY_ALT_MIN, under + 0.3, flyAlt + way * rate * dt));
			mine.setFly(flyAlt);
		}
		if (flySent !== flyAlt && t - flySentAt > 300) {
			conn.send({ t: "FLY", alt: Math.round(flyAlt * 100) / 100 });
			flySent = flyAlt;
			flySentAt = t;
		}
	}
	/** At a place of the area at once (from the map). */
	/** A warp asked for and not answered yet: said done only when the host has moved you (or says why not). */
	let warping: { name: string; at: number } | null = null;
	function warpTo(p: MapPlace): void {
		if (!conn.connected) {
			showToast("接続が切れています。つながってから、もう一度押してください");
			return;
		}
		stopGoing();
		conn.send({ t: "WARP", to: p.id });
		warping = { name: p.name, at: performance.now() };
	}
	/** No answer to a warp: say so (the connection may have dropped). */
	function warpStep(t: number): void {
		if (!warping || t - warping.at < WARP_WAIT_MS) return;
		showToast(
			conn.connected
				? `${warping.name}へ瞬間移動できませんでした`
				: "接続が切れていて、瞬間移動できませんでした。つながってから、もう一度押してください",
		);
		warping = null;
	}

	/** Stops following someone or going to a portal (the person moves on their own). */
	function stopGoing(): void {
		endFollow();
		going = null;
		seatAfter = null;
	}
	/** After your yes, your AI walks to a place and you follow behind it until it is there. */
	function trail(id: AvatarId, to: Vec2, place: string): void {
		const them = avatars.get(id);
		if (!them) return;
		going = null;
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

	// ---- going somewhere on foot: a portal (🚪 門へ), or a place on the map (🚶 歩いて行く) ----
	/** Run to a gate while farther than this, plan the next leg this often, and give up after this long. */
	const GATE_RUN_M = 10;
	const GATE_REPLAN_MS = 1000;
	const GATE_MAX_MS = 5 * 60_000;
	/** A place on the map is reached this close (a gate at PORTAL_REACH, where its button shows). */
	const PLACE_REACH_M = 3;
	const PLACE_MAX_MS = 15 * 60_000;
	/** `from`: where the last leg started, to notice when it took us nowhere. */
	let going: {
		to: Vec2;
		name: string;
		gate: boolean;
		run: boolean;
		until: number;
		plannedAt: number;
		from: Vec2 | null;
	} | null = null;
	/** Walks to `gate` (the nearest one if not given), in as many legs as the way needs. */
	function goToGate(gate?: Portal): void {
		const mine = myId ? avatars.get(myId) : undefined;
		const to = gate ?? (mine ? portals.nearest(poseAt(mine.state.move, conn.hostNow()).pos) : null);
		if (!to) return;
		stopGoing();
		going = {
			to: to.pos,
			name: to.name,
			gate: true,
			run: true,
			until: performance.now() + GATE_MAX_MS,
			plannedAt: 0,
			from: null,
		};
		showToast(`${to.name}へ向かいます`);
	}
	/**
	 * Walks to a place on the map (docs/prd.md 3.4.14) instead of warping: at a walk, so one can talk on the
	 * way (your AI walks beside you), looking about as one likes.
	 */
	function walkToPlace(p: MapPlace): void {
		const gate = p.gate ? portals.byId(p.id) : undefined;
		stopGoing();
		going = {
			to: gate?.pos ?? p.pos,
			name: p.name,
			gate: !!gate,
			run: false,
			until: performance.now() + PLACE_MAX_MS,
			plannedAt: 0,
			from: null,
		};
		showToast(`${p.name}へ歩いて向かいます`);
	}
	function goStep(t: number): void {
		if (!going) return;
		const mine = myId ? avatars.get(myId) : undefined;
		if (!mine || t > going.until) {
			going = null;
			return;
		}
		const pose = poseAt(mine.state.move, conn.hostNow());
		// still walking a leg
		if (pose.moving) return;
		const d = dist(pose.pos, going.to);
		// there (at a gate, the button to go through shows)
		if (d <= (going.gate ? PORTAL_REACH : PLACE_REACH_M)) {
			if (!going.gate && !going.run) showToast(`${going.name}に着きました`);
			going = null;
			return;
		}
		if (t - going.plannedAt < GATE_REPLAN_MS) return;
		// the last leg took us nowhere (no way there, or the host did not take it)
		if (going.from && dist(pose.pos, going.from) < 0.5) {
			showToast("そこへは行けません");
			going = null;
			return;
		}
		going.plannedAt = t;
		going.from = pose.pos;
		if (!walkTo(going.to, going.run && d > GATE_RUN_M ? RUN_SPEED : WALK_SPEED)) {
			showToast("そこへは行けません");
			going = null;
		}
	}

	// ---- loop ----
	let last = performance.now();
	let placed = false;
	/** __rj.look() stops the camera from following your avatar (for screenshots). */
	let followCamera = true;
	let shownGate: ReturnType<PortalsView["near"]> = null;
	/** What the activity buttons show now, to make them again only when that changes. */
	let shownActs = "";
	let shownClock = "";
	/** At a place: its activities (those closed now greyed, with their hours); doing one: a way to stop. */
	const actsStep = (mine: AvatarView | undefined, now: number) => {
		const pos = mine ? poseAt(mine.state.move, now).pos : null;
		const minutes = cityTime(now).minutes;
		const doing = mine?.state.doing;
		const here = pos
			? activities.filter((a) => {
					const p = places.get(a.place);
					return p && dist(p, pos) <= ACTIVITY_REACH;
				})
			: [];
		const key = doing
			? `doing ${doing.activity}`
			: here.map((a) => `${a.id}${activityOpen(a, minutes) ? "" : "-"}`).join(",");
		if (key === shownActs) return;
		shownActs = key;
		actsBar.replaceChildren();
		if (doing) {
			const badge = badgeOf(doing);
			const stop = el("button", "on", `⏹ ${badge?.emoji ?? ""} ${badge?.name ?? ""}をやめる`);
			stop.type = "button";
			stop.title = "歩き出しても終わります";
			stop.onclick = () => conn.send({ t: "ACT_STOP" });
			actsBar.append(stop);
		}
		for (const a of doing ? [] : here) {
			const b = el("button", "", `${a.emoji} ${a.name}`);
			b.type = "button";
			const open = activityOpen(a, minutes);
			b.disabled = !open;
			b.title = `街の${a.minutes}分${a.cost ? `、${a.cost}銅貨` : ""}。${hoursText(a)}${a.about ? `\n${a.about}` : ""}`;
			b.onclick = () => conn.send({ t: "ACT", activity: a.id });
			actsBar.append(b);
		}
		actsBar.hidden = actsBar.childElementCount === 0;
	};
	/** Avatars in their bath towel now, and those whose towel is ready (docs/prd.md 3.8.6). */
	const bathers = new WeakSet<AvatarView>();
	const readied = new WeakSet<AvatarView>();
	const frame = (t: number) => {
		const dt = Math.min(0.1, (t - last) / 1000);
		last = t;
		const now = conn.hostNow();
		for (const v of avatars.values()) {
			// an AI by its owner: talking, it faces them and looks them in the eye; else it stands beside them
			// facing their way, glancing at them now and then (docs/prd.md 3.4.9)
			const owner = v.state.kind === "ai" && v.state.ownerId ? avatars.get(v.state.ownerId) : undefined;
			const near = owner && owner.root.position.distanceTo(v.root.position) < ATTEND_M;
			const talking =
				near && (v.state.status === "busy" || now - (talkAt.get(v.state.id) ?? -TALK_FACE_MS) < TALK_FACE_MS);
			const mood = near && !talking ? besideMood(v, owner, now) : null;
			v.attend(near && (talking || mood?.glance) ? owner.eyePosition() : null);
			v.standFacing(mood ? mood.facing : null);
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
		const seated = mySeat() !== undefined;
		seatButton.hidden = !seated && (seatAfter !== null || nearestSeat() === null);
		seatButton.textContent = seated ? "🧍 立つ" : "🪑 腰かける";
		patButton.hidden = myAiToPat() === null;
		const withAi = [...avatars.values()].some((a) => a.state.kind === "ai" && a.state.ownerId === myId);
		companionRow.hidden = !withAi;
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
		seatStep();
		goStep(t);
		// stop at the edge of the walkable area instead of walking into walls
		if (mine?.state.move.kind === "vel") {
			const move = mine.state.move;
			if (!clearAhead(poseAt(move, now).pos, move.dir, move.speed, 0.15)) steer(t, true);
		}
		liftStep(mine, dt, t);
		warpStep(t);
		portals.update(mine ? poseAt(mine.state.move, now).pos : null);
		if (cityMap.open)
			cityMap.update(
				mine ? poseAt(mine.state.move, now).pos : null,
				mine?.heading ?? 0,
				[...avatars.values()]
					.filter((a) => a !== mine)
					.map((a) => ({ pos: poseAt(a.state.move, now).pos, ai: a.state.kind === "ai" })),
			);
		if (mine && !placed) {
			scene.jumpTo(mine.root.position);
			placed = true;
		}
		actsStep(mine, now);
		// the city's clock in the status line, each city minute
		const clock = clockText(cityTime(now).minutes);
		if (clock !== shownClock) {
			shownClock = clock;
			updateStatus(shownStatus.state, shownStatus.detail);
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
					// your AIs walking with you come along (docs/prd.md 3.8.2): the close says where to
					conn.stop(travelReason(gateHere.to, gateHere.at));
					location.href = travelUrl(gateHere, avatarParam);
				};
			}
		}
		// (walking somewhere in legs counts as walking all the way, also where one leg ends and the next begins)
		if (mine && followCamera) view.update(mine, poseAt(mine.state.move, now).moving || going !== null, dt);
		else scene.controls.update();
		scene.render();
		requestAnimationFrame(frame);
	};
	requestAnimationFrame(frame);
}
