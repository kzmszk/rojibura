// Dev harness for bathing (AvatarView.setBathing): the preset avatars side by side, dressed or in a swimsuit,
// standing, walking, sitting, lying or in a gesture, seen from any side. Query options:
//   who=fumiriya,shibu,…  bath=0|1|skin (skin: clothes off, swimsuit hidden)  pose=stand|walk|run|sit|lie|<gesture>
//   t=seconds into the motion  yaw=degrees the avatars are turned (0 faces the camera)
//   suit=one-piece,bikini,…  (per avatar, in `who` order: the swimsuit, to compare looks of the same model
//   side by side)
//   cam=full|close|low|top  toggles=n (bathing switched on and off n times first)
// When the picture is ready, document.body.dataset.done is set (for a headless screenshot).

import type { MoveState } from "@rojibura/protocol";
import * as THREE from "three";
import { AvatarView } from "../src/avatars.ts";

const q = new URLSearchParams(location.search);
const who = (q.get("who") ?? "fumiriya,shibu,shino,rei,saki").split(",");
const bath = q.get("bath") ?? "1";
const pose = q.get("pose") ?? "stand";
const t = Number(q.get("t") ?? 2.5);
const yaw = (Number(q.get("yaw") ?? 0) * Math.PI) / 180;
const cam = q.get("cam") ?? "full";
const toggles = Number(q.get("toggles") ?? 0);
const suits = (q.get("suit") ?? "").split(",");
const GAP = pose === "lie" ? 1.0 : 0.85;

const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(1);
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0xdfe7ee);
scene.add(new THREE.HemisphereLight(0xeaf2ff, 0x6b6250, 1.8));
const sun = new THREE.DirectionalLight(0xfff1dc, 2.0);
sun.position.set(3, 6, 4);
scene.add(sun);
const floor = new THREE.Mesh(
	new THREE.PlaneGeometry(40, 40).rotateX(-Math.PI / 2),
	new THREE.MeshLambertMaterial({ color: 0xb9b2a4 }),
);
scene.add(floor);

const url = (name: string) => `/assets/avatars/${name}.${name === "saki" ? "glb" : "vrm"}`;
const slot = (i: number): [number, number] => [(i - (who.length - 1) / 2) * GAP, 0];
const dir: [number, number] = [Math.sin(yaw), Math.cos(yaw)];

function moveOf(i: number): MoveState {
	const pos = slot(i);
	if (pose === "walk" || pose === "run")
		return { kind: "vel", pos, dir, speed: pose === "run" ? 4 : 1.3, at: 0 };
	if (pose === "sit" || pose === "lie") return { kind: "idle", pos, at: 0, posture: pose, face: dir };
	return { kind: "idle", pos, at: 0, face: dir };
}

const views = who.map(
	(name, i) =>
		new AvatarView(
			{
				id: name,
				kind: "ai",
				name,
				status: "active",
				assets: {
					thumb: "",
					lod: url(name),
					vrm: url(name),
					...(name === "fumiriya" || name === "rei" ? { sex: "m" as const } : {}),
				},
				move: moveOf(i),
			},
			false,
		),
);
for (const v of views) scene.add(v.root);
await Promise.all(views.map((v) => v.ready));
views.forEach((v, i) => {
	const suit = suits[i];
	v.setBathStyle({
		...(suit === "one-piece" || suit === "bikini" || suit === "trunks" ? { suit } : {}),
	});
});
for (const v of views) {
	const t0 = performance.now();
	for (let k = 0; k < toggles; k++) {
		v.setBathing(k % 2 === 0);
		await new Promise((r) => setTimeout(r, 1500));
	}
	v.setBathing(bath !== "0");
	console.log(`${v.state.name}: bathing set in ${Math.round(performance.now() - t0)} ms`);
}
// a model that bathes as another one (swimsuit.ts, bathBodyUrl) is swapped when it has loaded
await new Promise((r) => setTimeout(r, 2500));
// skin: the swimsuit hidden (the new skin shown), to see what is under it
if (bath === "skin")
	for (const v of views)
		v.root.traverse((o) => {
			if (o.name === "rj-suit") o.visible = false;
		});
// no fidgets (the first comes some 8 s in) and the same picture every time (after loading and bathing:
// three.js makes its uuids with Math.random)
Math.random = () => 0.999;

const heightAt = () => 0;
const dt = 1 / 30;
let now = 0;
const steps = Math.round(t / dt);
const performed = pose !== "stand" && pose !== "walk" && pose !== "run" && pose !== "sit" && pose !== "lie";
for (let s = 0; s <= steps; s++) {
	now += dt * 1000;
	views.forEach((v, i) => {
		if (s === 0) {
			v.root.position.set(slot(i)[0], 0, slot(i)[1]);
			v.turnTowards(new THREE.Vector3(slot(i)[0] + dir[0], 0, dir[1]));
			if (performed) v.perform(pose as never, now);
			if (pose === "sit" || pose === "lie") v.act(pose, now);
		}
		v.update(now, dt, { heightAt });
		// walking in place: each stays in its slot
		const [x, z] = slot(i);
		v.root.position.set(x, 0, z);
	});
}
scene.updateMatrixWorld(true);

const width = who.length * GAP;
const camera = new THREE.PerspectiveCamera(cam === "close" ? 22 : 30, innerWidth / innerHeight, 0.05, 50);
const lookY = pose === "lie" ? 0.3 : pose === "sit" ? 0.6 : cam === "close" ? 1.05 : 0.85;
if (cam === "top") {
	camera.position.set(0, 4.5, 2.2);
	camera.lookAt(0, 0.2, 0);
} else {
	const dist = cam === "close" ? Math.max(2.4, width * 1.9) : Math.max(3.2, width * 1.25);
	const y = cam === "low" ? 0.45 : lookY + 0.25;
	camera.position.set(0, y, dist);
	camera.lookAt(0, lookY, 0);
}
renderer.render(scene, camera);
// tex=map|shade: the first avatar's skin texture as painted for the bath, instead of the scene
const tex = q.get("tex");
if (tex) {
	let canvas: HTMLCanvasElement | null = null;
	views[0]?.root.traverse((o) => {
		const m = [(o as THREE.Mesh).material ?? []].flat()[0] as
			| Record<string, { image?: unknown } | undefined>
			| undefined;
		const t = m?.[tex === "shade" ? "shadeMultiplyTexture" : "map"];
		if (!canvas && o.name !== "rj-suit" && t?.image instanceof HTMLCanvasElement) canvas = t.image;
	});
	if (canvas) {
		renderer.domElement.remove();
		(canvas as HTMLCanvasElement).style.cssText = "height:100%;background:#0f0";
		document.body.appendChild(canvas);
	}
}
document.body.dataset.done = "1";
(window as unknown as { rj: unknown }).rj = { views, scene, camera, renderer };
