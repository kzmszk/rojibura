// rojibura city client (docs/prd.md 3.4): login, the 3D city, click-to-move, chat.

import { NavMesh, type NavMeshData } from "@rojibura/nav";
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
import { actionBar, Relations, showAdmin } from "./moderation.ts";
import { CityConnection, type ConnState } from "./net.ts";
import { CityScene } from "./scene.ts";
import { STYLES } from "./styles.ts";

export interface Navigator {
	findPath(from: Vec2, to: Vec2): Vec2[] | null;
	isWalkable(p: Vec2): boolean;
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
	const mesh = NavMesh.fromJSON((await (await fetch(`${CITY}/navmesh.json`)).json()) as NavMeshData);
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

	const [meRes, health] = await Promise.all([
		fetch("/api/me"),
		fetch("/api/health").then((r) => r.json() as Promise<{ dev: boolean; google: boolean }>),
	]);
	if (meRes.status === 401) {
		showLogin(root, health);
		return;
	}
	const me = (await meRes.json()) as Me;
	if (location.pathname === "/admin") {
		await showAdmin(root);
		return;
	}
	const params = new URLSearchParams(location.search);
	if (params.get("welcome") === "1") {
		showWelcome(root, me, params.get("redirect") ?? "/");
		return;
	}
	await startCity(root, me, health.dev);
}

interface Me {
	id: string;
	name: string;
	role: string;
	allowAiApproach: boolean;
	relations?: { mutes: string[]; blocks: string[] };
}

function patchMe(body: { name?: string; allowAiApproach?: boolean }): Promise<Response> {
	return fetch("/api/me", {
		method: "PATCH",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
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
		google.href = `/auth/google/login?redirect=${encodeURIComponent("/")}`;
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
		const redirect = `/?avatar=${encodeURIComponent(avatar.value)}`;
		location.href = `/auth/dev/login?name=${encodeURIComponent(name.value)}&redirect=${encodeURIComponent(redirect)}`;
	};
	root.append(box);
	name.focus();
}

async function startCity(root: HTMLElement, me: Me, devBuild: boolean): Promise<void> {
	const scene = new CityScene(root);
	const nav = await loadNavigator();
	await scene.loadCity(`${CITY}/test_city.glb`);

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
		const admin = el("a", "rj-logout", "通報の確認");
		admin.href = "/admin";
		right.append(admin);
	}
	right.append(approach, logout);
	hud.append(status, right);
	const chat = el("div", "rj-chat");
	const log = el("div", "rj-log");
	const form = el("form", "rj-say");
	const target = el("button", "rj-target");
	target.type = "button";
	const input = el("input", "");
	input.maxLength = MAX_SAY_LENGTH;
	input.placeholder = "Enter で話す（相手をクリックで話しかけ、WASD で歩く）";
	form.append(target, input);
	chat.append(log, form);
	const toast = el("div", "rj-toast");
	root.append(hud, chat, toast);

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
		status.textContent = `${me.name} ｜ ${detail ?? label} ｜ ${avatars.size}人`;
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

	const add = (s: AvatarView["state"]) => {
		if (relations.blocks.has(s.id)) return;
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
					if (!relations.silenced(m.id)) avatars.get(m.id)?.say(MOTION_EMOJI[m.motion], conn.hostNow());
					break;
				case "SAID": {
					if (relations.silenced(m.id)) break;
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
	// debug hook for tools/snap.ts on development builds (cf dev and staging)
	if (devBuild) Object.assign(globalThis, { __rj: { avatars, scene, conn, setTarget } });

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
	const movementKey = (e: KeyboardEvent) => {
		const k = e.key.toLowerCase();
		return ["w", "a", "s", "d", "shift"].includes(k) ? k : null;
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
	addEventListener("keydown", (e) => {
		const k = movementKey(e);
		if (k && document.activeElement !== input) {
			keys.add(k);
			steer(performance.now());
			return;
		}
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
		if (keys.size > 0) steer(t);
		// stop at the edge of the walkable area instead of walking into walls
		if (mine?.state.move.kind === "vel") {
			const ahead = poseAt(mine.state.move, now + 150).pos;
			if (!nav.isWalkable(ahead)) steer(t, true);
		}
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
