// rojibura city client (docs/prd.md 3.4): login, the 3D city, click-to-move, chat.

import {
	type AvatarId,
	type HostToClient,
	MAX_PATH_POINTS,
	MAX_SAY_LENGTH,
	type Motion,
	poseAt,
	RUN_SPEED,
	type Vec2,
	WALK_SPEED,
} from "@rojibura/protocol";
import * as THREE from "three";
import { AvatarView } from "./avatars.ts";
import { CityConnection, type ConnState } from "./net.ts";
import { CityScene } from "./scene.ts";
import { STYLES } from "./styles.ts";

export interface Navigator {
	findPath(from: Vec2, to: Vec2): Vec2[] | null;
}

const CITY = "/test-city";
const MOTION_EMOJI: Record<Motion, string> = { wave: "👋", nod: "🙂", bow: "🙇", jump: "⤴️", sit: "🪑" };

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

async function loadNavigator(): Promise<Navigator> {
	// TODO(#12): use NavMesh from @rojibura/nav with /test-city/navmesh.json
	return { findPath: (from, to) => [from, to] };
}

export async function mountApp(root: HTMLElement): Promise<void> {
	const style = document.createElement("style");
	style.textContent = STYLES;
	document.head.appendChild(style);
	root.classList.add("rj-root");

	const [meRes, health] = await Promise.all([
		fetch("/api/me"),
		fetch("/api/health").then((r) => r.json() as Promise<{ dev: boolean }>),
	]);
	if (meRes.status === 401) {
		showLogin(root, health.dev);
		return;
	}
	const me = (await meRes.json()) as { id: string; name: string };
	await startCity(root, me);
}

function showLogin(root: HTMLElement, dev: boolean): void {
	const box = el("form", "rj-login");
	box.append(el("h1", "", "rojibura"), el("p", "", "人間とAIが暮らす街"));
	if (!dev) {
		box.append(el("p", "rj-note", "ログインは準備中です（Google ログインは近日対応）。"));
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
		["capsule", "カプセル"],
	]) {
		const o = el("option", "", label);
		o.value = v ?? "";
		avatar.append(o);
	}
	const go = el("button", "", "街に入る");
	go.type = "submit";
	box.append(name, avatar, go, el("p", "rj-note", "開発用のダミーログインです（cf dev のときだけ有効）。"));
	box.onsubmit = (e) => {
		e.preventDefault();
		const redirect = `/?avatar=${encodeURIComponent(avatar.value)}`;
		location.href = `/auth/dev/login?name=${encodeURIComponent(name.value)}&redirect=${encodeURIComponent(redirect)}`;
	};
	root.append(box);
	name.focus();
}

async function startCity(root: HTMLElement, me: { id: string; name: string }): Promise<void> {
	const scene = new CityScene(root);
	const nav = await loadNavigator();
	await scene.loadCity(`${CITY}/test_city.glb`);

	// ---- HUD ----
	const hud = el("div", "rj-hud");
	const status = el("div", "rj-status", "接続中…");
	const logout = el("a", "rj-logout", "ログアウト");
	logout.href = "/auth/logout";
	hud.append(status, logout);
	const chat = el("div", "rj-chat");
	const log = el("div", "rj-log");
	const form = el("form", "rj-say");
	const target = el("button", "rj-target");
	target.type = "button";
	const input = el("input", "");
	input.maxLength = MAX_SAY_LENGTH;
	input.placeholder = "Enter で話す（相手をクリックすると話しかけ）";
	form.append(target, input);
	chat.append(log, form);
	const toast = el("div", "rj-toast");
	root.append(hud, chat, toast);

	const avatars = new Map<AvatarId, AvatarView>();
	let myId: AvatarId | null = null;
	let talkTo: AvatarId | null = null;
	let seq = 0;

	const setTarget = (id: AvatarId | null) => {
		talkTo = id;
		const a = id ? avatars.get(id) : undefined;
		target.textContent = a ? `→ ${a.state.name}` : "みんなへ";
		target.classList.toggle("on", !!a);
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
		status.textContent = `${me.name} ｜ ${detail ?? label} ｜ ${avatars.size}人`;
	};

	const add = (s: AvatarView["state"]) => {
		avatars.get(s.id)?.dispose();
		const v = new AvatarView(s, s.id === myId);
		avatars.set(s.id, v);
		scene.scene.add(v.root);
	};

	const conn = new CityConnection({
		areaId: "main",
		avatar: new URLSearchParams(location.search).get("avatar") ?? "saki",
		onState: (s, d) => {
			updateStatus(s, d);
			if (s === "closed" && d) showToast(d);
		},
		onMessage: (m: HostToClient) => {
			switch (m.t) {
				case "WELCOME":
					myId = m.you;
					for (const v of avatars.values()) v.dispose();
					avatars.clear();
					for (const a of m.avatars) add(a);
					break;
				case "JOINED":
					add(m.avatar);
					addLog("", `${m.avatar.name} が来ました`, "sys");
					break;
				case "LEFT": {
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
				case "ACTED":
					avatars.get(m.id)?.say(MOTION_EMOJI[m.motion], conn.hostNow());
					break;
				case "SAID": {
					const v = avatars.get(m.id);
					v?.say(m.text, conn.hostNow());
					const to = m.to ? avatars.get(m.to)?.state.name : undefined;
					addLog(`${v?.state.name ?? "?"}${to ? ` → ${to}` : ""}`, m.text, m.id === myId ? "mine" : "");
					break;
				}
				case "STATUS_CHANGED":
					avatars.get(m.id)?.setStatus(m.status);
					break;
				case "NOTICE":
					showToast(m.message);
					break;
				default:
					break;
			}
			updateStatus("open");
		},
	});
	conn.start();
	if (location.hostname === "localhost") Object.assign(globalThis, { __rj: { avatars, scene, conn } });

	// ---- input ----
	form.onsubmit = (e) => {
		e.preventDefault();
		const text = input.value.trim();
		if (!text) return;
		conn.send(talkTo ? { t: "SAY", text, to: talkTo } : { t: "SAY", text });
		input.value = "";
	};
	addEventListener("keydown", (e) => {
		if (e.key === "Enter" && document.activeElement !== input) {
			input.focus();
			e.preventDefault();
		} else if (e.key === "Escape") {
			setTarget(null);
			input.blur();
		}
	});

	const canvas = scene.renderer.domElement;
	let down: { x: number; y: number } | null = null;
	canvas.addEventListener("pointerdown", (e) => {
		down = { x: e.clientX, y: e.clientY };
	});
	canvas.addEventListener("pointerup", (e) => {
		if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) return;
		down = null;
		const rect = canvas.getBoundingClientRect();
		const ndc = new THREE.Vector2(
			((e.clientX - rect.left) / rect.width) * 2 - 1,
			-((e.clientY - rect.top) / rect.height) * 2 + 1,
		);
		// avatars first: clicking someone selects them as the one to talk to
		const ray = new THREE.Raycaster();
		ray.setFromCamera(ndc, scene.camera);
		const hit = ray.intersectObjects(
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
		const p = scene.pickGround(ndc);
		const mine = myId ? avatars.get(myId) : undefined;
		if (!p || !mine) return;
		const from = poseAt(mine.state.move, conn.hostNow()).pos;
		const path = nav.findPath(from, [p.x, p.z]);
		if (!path || path.length < 2) return showToast("そこへは行けません");
		const speed = e.shiftKey ? RUN_SPEED : WALK_SPEED;
		const trimmed = path.slice(0, MAX_PATH_POINTS);
		// move right away; the host's MOVED (or CORRECT) replaces this
		mine.setMove({ kind: "path", path: trimmed, speed, at: conn.hostNow() });
		conn.send({ t: "MOVE_PATH", path: trimmed, speed, seq: ++seq });
	});

	// ---- loop ----
	let last = performance.now();
	let placed = false;
	const frame = (t: number) => {
		const dt = Math.min(0.1, (t - last) / 1000);
		last = t;
		const now = conn.hostNow();
		for (const v of avatars.values()) v.update(now, dt, scene);
		const mine = myId ? avatars.get(myId) : undefined;
		if (mine && !placed) {
			scene.jumpTo(mine.root.position);
			placed = true;
		}
		if (mine) scene.follow(mine.root.position, dt);
		else scene.controls.update();
		scene.render();
		requestAnimationFrame(frame);
	};
	requestAnimationFrame(frame);
}
