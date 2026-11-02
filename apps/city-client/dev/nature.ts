// A harness for the town's nature (src/nature): a lawn with a gentle hill, a path, a pond, a hot spring,
// a few houses and trees of every species, with buttons for the seasons and the views.
// Query: ?season=spring|autumn|winter  &view=eye|third|above|summit|grove  &n=1000 (more trees)  &shot=1 (no UI)
// &t=seconds (a fixed time, for screenshots).

import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { Nature, type Season, SPECIES_NAMES, type Species, type TreeSpec } from "../src/nature/index.ts";
import { Rng } from "../src/nature/rng.ts";

const q = new URLSearchParams(location.search);
if (q.get("shot")) document.body.classList.add("shot");

// ---- the land: flat in the west, a hill in the east (like the park's mountain), a hollow for the pond
const HILL: [number, number] = [150, -50];
const POND: [number, number] = [20, 55];
const ONSEN: [number, number] = [-70, 95];
const ONSEN_Y = 0.4;
function heightAt(x: number, z: number): number | null {
	if (Math.abs(x) > 240 || Math.abs(z) > 160) return null;
	const dh = (x - HILL[0]) ** 2 / (2 * 62 ** 2) + (z - HILL[1]) ** 2 / (2 * 55 ** 2);
	let h = 45 * Math.exp(-dh) + 0.8 * Math.sin(x * 0.031) * Math.cos(z * 0.043);
	const dp = Math.hypot(x - POND[0], z - POND[1]);
	h -= 1.4 * (1 - smooth(14, 22, dp));
	// the hot spring sits on a level terrace
	const k = 1 - smooth(9, 16, Math.hypot(x - ONSEN[0], z - ONSEN[1]));
	return h * (1 - k) + ONSEN_Y * k;
}
function smooth(a: number, b: number, x: number): number {
	const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
	return t * t * (3 - 2 * t);
}
const H = (x: number, z: number): number => heightAt(x, z) ?? 0;

// the path: from the town in the west, past the pond, up the hill to its top
const PATH: [number, number][] = [
	[-230, 10],
	[-150, 12],
	[-80, 20],
	[-30, 30],
	[0, 32],
	[40, 25],
	[80, 5],
	[105, -15],
	[118, -35],
	[132, -45],
	[148, -50],
];
const PATH_W = 3.2;
function distToPath(x: number, z: number): number {
	let best = 1e9;
	for (let i = 0; i < PATH.length - 1; i++) {
		const [ax, az] = PATH[i] as [number, number];
		const [bx, bz] = PATH[i + 1] as [number, number];
		const dx = bx - ax;
		const dz = bz - az;
		const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz)));
		best = Math.min(best, Math.hypot(x - ax - dx * t, z - az - dz * t));
	}
	return best;
}

// ---- renderer, camera, lights (as scene.ts does)
const root = document.getElementById("app") as HTMLElement;
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.outputColorSpace = THREE.SRGBColorSpace;
root.appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0xbfd6e8, 60, 400);
const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 1500);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
const hemi = new THREE.HemisphereLight(0xeaf2ff, 0x6b6250, 1.6);
const sun = new THREE.DirectionalLight(0xfff1dc, 2.4);
const SUN_OFFSET = new THREE.Vector3(30, 50, 20);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.bias = -0.0005;
sun.shadow.normalBias = 0.04;
{
	const s = sun.shadow.camera;
	s.left = s.bottom = -50;
	s.right = s.top = 50;
	s.far = 200;
}
scene.add(hemi, sun, sun.target);

// ---- the "city": named like the glb's materials
const city = new THREE.Group();
const mat = (name: string, color: number, rough = 0.9): THREE.MeshStandardMaterial => {
	const m = new THREE.MeshStandardMaterial({ color, roughness: rough });
	m.name = name;
	return m;
};
function terrain(
	name: string,
	lift: (x: number, z: number) => number,
	keep: (x: number, z: number) => boolean,
	m: THREE.Material,
): THREE.Mesh {
	const g = new THREE.PlaneGeometry(480, 320, 240, 160).rotateX(-Math.PI / 2);
	const p = g.getAttribute("position") as THREE.BufferAttribute;
	for (let i = 0; i < p.count; i++) p.setY(i, H(p.getX(i), p.getZ(i)) + lift(p.getX(i), p.getZ(i)));
	const idx = g.getIndex() as THREE.BufferAttribute;
	const kept: number[] = [];
	for (let i = 0; i < idx.count; i += 3) {
		const a = idx.getX(i);
		const b = idx.getX(i + 1);
		const c = idx.getX(i + 2);
		const cx = (p.getX(a) + p.getX(b) + p.getX(c)) / 3;
		const cz = (p.getZ(a) + p.getZ(b) + p.getZ(c)) / 3;
		if (keep(cx, cz)) kept.push(a, b, c);
	}
	g.setIndex(kept);
	g.computeVertexNormals();
	const mesh = new THREE.Mesh(g, m);
	mesh.name = name;
	mesh.receiveShadow = true;
	return mesh;
}
const inPond = (x: number, z: number) => Math.hypot(x - POND[0], z - POND[1]) < 16;
city.add(
	terrain(
		"lawn",
		() => 0,
		() => true,
		mat("grass_lawn", 0x5f8a3c),
	),
);
// 20 cm of snow over the lawn, sloping down at the path's edges and under the water
const snowDepth = (x: number, z: number): number => {
	const dp = distToPath(x, z) - PATH_W / 2;
	const dw = Math.min(
		Math.hypot(x - POND[0], z - POND[1]) - 16,
		Math.max(Math.abs(x - ONSEN[0]) - 7.8, Math.abs(z - ONSEN[1]) - 5.8),
	);
	return -0.3 + 0.5 * smooth(-0.2, 1.4, Math.min(dp, dw));
};
city.add(terrain("snow_soft_lawn", snowDepth, () => true, mat("snow", 0xffffff)));
function strip(name: string, lift: number, width: number, m: THREE.Material): THREE.Mesh {
	const pos: number[] = [];
	const idx: number[] = [];
	const pts: [number, number][] = [];
	for (let i = 0; i < PATH.length - 1; i++) {
		const [ax, az] = PATH[i] as [number, number];
		const [bx, bz] = PATH[i + 1] as [number, number];
		const n = Math.ceil(Math.hypot(bx - ax, bz - az) / 1.5);
		for (let k = 0; k < n; k++) pts.push([ax + ((bx - ax) * k) / n, az + ((bz - az) * k) / n]);
	}
	pts.push(PATH[PATH.length - 1] as [number, number]);
	pts.forEach(([x, z], i) => {
		const [nx, nz] = pts[Math.min(pts.length - 1, i + 1)] as [number, number];
		const [px, pz] = pts[Math.max(0, i - 1)] as [number, number];
		const dx = nx - px;
		const dz = nz - pz;
		const l = Math.hypot(dx, dz) || 1;
		const sx = (-dz / l) * width * 0.5;
		const sz = (dx / l) * width * 0.5;
		pos.push(x + sx, H(x + sx, z + sz) + lift, z + sz, x - sx, H(x - sx, z - sz) + lift, z - sz);
		if (i) idx.push(i * 2 - 2, i * 2 - 1, i * 2, i * 2 - 1, i * 2 + 1, i * 2);
	});
	// face up, whichever way the strip turned
	for (let t = 0; t < idx.length; t += 3) {
		const [a, b, c] = [idx[t] as number, idx[t + 1] as number, idx[t + 2] as number];
		const P = (i: number): number => pos[i] ?? 0;
		const ux = P(b * 3) - P(a * 3);
		const uz = P(b * 3 + 2) - P(a * 3 + 2);
		const vx = P(c * 3) - P(a * 3);
		const vz = P(c * 3 + 2) - P(a * 3 + 2);
		if (uz * vx - ux * vz < 0) [idx[t + 1], idx[t + 2]] = [c, b];
	}
	const g = new THREE.BufferGeometry();
	g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
	g.setIndex(idx);
	g.computeVertexNormals();
	const mesh = new THREE.Mesh(g, m);
	mesh.name = name;
	mesh.receiveShadow = true;
	return mesh;
}
city.add(strip("path", 0.04, PATH_W, mat("stone_path", 0x8a8378)));
city.add(strip("snow_trod_path", 0.09, PATH_W + 0.2, mat("snow_trod", 0xdddddd)));
{
	const pond = new THREE.Mesh(
		new THREE.CircleGeometry(16, 64).rotateX(-Math.PI / 2),
		mat("water_pond", 0x335566, 0.1),
	);
	pond.position.set(POND[0], H(POND[0], POND[1]) + 1.15, POND[1]);
	pond.name = "pond";
	city.add(pond);
	const y = H(ONSEN[0], ONSEN[1]);
	const onsen = new THREE.Mesh(
		new THREE.PlaneGeometry(14, 10).rotateX(-Math.PI / 2),
		mat("water_onsen", 0x88ccbb, 0.2),
	);
	onsen.position.set(ONSEN[0], y + 0.05, ONSEN[1]);
	onsen.name = "onsen";
	city.add(onsen);
	const stone = mat("stone_rim", 0x6d6a66);
	for (const [w, d, x, z] of [
		[15, 0.8, 0, -5.4],
		[15, 0.8, 0, 5.4],
		[0.8, 11.6, -7.4, 0],
		[0.8, 11.6, 7.4, 0],
	] as [number, number, number, number][]) {
		const b = new THREE.Mesh(new THREE.BoxGeometry(w, 0.5, d), stone);
		b.position.set(ONSEN[0] + x, y + 0.15, ONSEN[1] + z);
		b.castShadow = b.receiveShadow = true;
		city.add(b);
	}
}
// houses in the town: plaster walls, timber, tiled roofs
const plaster = mat("plaster_wall", 0xd9d0bd);
const roof = mat("roof_tile", 0x7a3d2c, 0.75);
const timber = mat("timber", 0x4a3424);
const rng = new Rng(5);
for (let i = 0; i < 26; i++) {
	const x = -225 + (i % 7) * 15 + rng.range(-2, 2);
	const z = -120 + Math.floor(i / 7) * 32 + rng.range(-3, 3);
	if (distToPath(x, z) < 12) continue;
	const w = rng.range(7, 10);
	const d = rng.range(8, 11);
	const h = rng.range(6, 10);
	const y = H(x, z);
	const body = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), plaster);
	body.position.set(x, y + h / 2, z);
	const rh = w * 0.45;
	const shape = new THREE.Shape([
		new THREE.Vector2(-w / 2 - 0.5, 0),
		new THREE.Vector2(w / 2 + 0.5, 0),
		new THREE.Vector2(0, rh),
	]);
	const rg = new THREE.ExtrudeGeometry(shape, { depth: d + 1, bevelEnabled: false }).translate(
		0,
		0,
		-(d + 1) / 2,
	);
	const rf = new THREE.Mesh(rg, roof);
	rf.position.set(x, y + h, z);
	const beam = new THREE.Mesh(new THREE.BoxGeometry(w + 0.1, 0.3, d + 0.1), timber);
	beam.position.set(x, y + h * 0.55, z);
	for (const m of [body, rf, beam]) {
		m.castShadow = m.receiveShadow = true;
		city.add(m);
	}
}
// benches by the path
const wood = mat("wood_bench", 0x6b4a30);
for (let i = 0; i < 10; i++) {
	const t = 0.25 + i * 0.05;
	const k = Math.floor(t * (PATH.length - 1));
	const [ax, az] = PATH[k] as [number, number];
	const x = ax + 4;
	const z = az + 3.2;
	const b = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.1, 0.5), wood);
	b.position.set(x, H(x, z) + 0.45, z);
	b.castShadow = b.receiveShadow = true;
	city.add(b);
}
scene.add(city);

// ---- trees: groves of each kind, an avenue, cherries by the pond, cedars on the hill, pines by the hot spring
const trees: TreeSpec[] = [];
const tr = new Rng(11);
const ok = (x: number, z: number): boolean =>
	Math.hypot(x - 148, z + 49) > 14 &&
	Math.abs(x) < 236 &&
	Math.abs(z) < 156 &&
	distToPath(x, z) > PATH_W &&
	!inPond(x, z) &&
	Math.hypot(x - ONSEN[0], z - ONSEN[1]) > 10;
const put = (sp: Species, x: number, z: number, s = tr.range(0.85, 1.15)): void => {
	if (ok(x, z)) trees.push({ sp, x, z, s, r: tr.range(0, Math.PI * 2) });
};
const grove = (sp: Species, cx: number, cz: number, n: number, rad: number): void => {
	for (let i = 0; i < n; i++) {
		const a = tr.range(0, Math.PI * 2);
		const d = Math.sqrt(tr.next()) * rad;
		put(sp, cx + Math.cos(a) * d, cz + Math.sin(a) * d);
	}
};
// a ginkgo avenue along the path near the park's entrance, plane trees along it in the town
for (let x = -110; x < -20; x += 9)
	for (const s of [-1, 1]) put("ichou", x, 22 + ((x + 110) / 90) * 10 + s * 4.5);
for (let x = -225; x < -125; x += 10) for (const s of [-1, 1]) put("platanus", x, 11 + s * 5);
// cherries around the pond
for (let a = 0; a < Math.PI * 2; a += 0.33)
	put("sakura", POND[0] + Math.cos(a) * 21, POND[1] + Math.sin(a) * 21);
grove("sakura", -20, 75, 10, 14);
grove("momiji", 30, 0, 14, 14);
grove("momiji", 60, 40, 10, 10);
grove("kaede", -10, -30, 8, 10);
grove("keyaki", -60, -60, 8, 18);
grove("nara", 80, -70, 12, 18);
grove("bodaiju", -120, -40, 6, 12);
grove("shirakaba", 0, 105, 12, 10);
grove("matsu", ONSEN[0], ONSEN[1], 7, 16);
for (let i = 0; i < 26; i++) {
	// cedars on the far (east and south) side of the hill, the lookout open toward the park
	const a = tr.range(-1.2, 1.6);
	const d = tr.range(14, 34);
	put("sugi", HILL[0] + Math.cos(a) * d, HILL[1] + Math.sin(a) * d);
}
grove("nara", 120, 10, 12, 16);
grove("momiji", 110, -30, 10, 12);
// the woods: a mix over the rest
const n = Number(q.get("n") ?? 0);
while (trees.length < n) {
	const x = tr.range(-100, 236);
	const z = tr.range(-150, 150);
	const near = Math.hypot(x - HILL[0], z - HILL[1]) < 70;
	put(
		near ? tr.pick(["sugi", "nara", "momiji", "kaede", "matsu"] as Species[]) : tr.pick(SPECIES_NAMES),
		x,
		z,
	);
}

let season = (q.get("season") as Season | null) ?? "autumn";
const nature = new Nature(scene, { trees, heightAt, season, texBase: "/tex/nature/" });
nature.applyToCity(city);

function applyView(): void {
	const v = nature.view();
	scene.background = new THREE.Color(v.sky);
	const fog = scene.fog as THREE.Fog;
	fog.color.set(v.sky);
	[fog.near, fog.far] = v.fog;
	sun.color.set(v.sunColor);
	sun.intensity = v.sunIntensity;
	hemi.color.set(v.hemiSky);
	hemi.groundColor.set(v.hemiGround);
	hemi.intensity = v.hemiIntensity;
}
function setSeason(s: Season): void {
	season = s;
	nature.setSeason(s);
	applyView();
}
applyView();

// ---- views
const VIEWS: Record<string, () => void> = {
	// on foot on the path, between the maple groves, toward the hill
	eye: () => look([42, 24], 1.6, [100, -8], 4),
	// third person: behind and above an avatar walking the ginkgo avenue
	third: () => look([-68, 25], 3.2, [-58, 26.5], 1.4),
	above: () => look([-120, 60], 110, [40, -10], 0),
	// from the hill's top, west over the park and the town
	// from a lookout on the hill's top (the hill is round: on foot its own shoulder hides the park)
	summit: () => look([148, -49], 9, [0, 30], 0),
	grove: () => look([20, 18], 1.6, [34, 0], 2.5),
	close: () => look([22, 6], 1.6, [30, 0], 3.5),
	onsen: () => look([ONSEN[0] + 12, ONSEN[1] - 9], 2.0, [ONSEN[0], ONSEN[1]], 0),
	pond: () => look([POND[0] - 30, POND[1] - 18], 1.7, [POND[0], POND[1]], 0),
	town: () => look([-150, 14], 1.7, [-215, 10], 4),
};
function look(from: [number, number], up: number, at: [number, number], atUp: number): void {
	camera.position.set(from[0], H(from[0], from[1]) + up, from[1]);
	controls.target.set(at[0], H(at[0], at[1]) + atUp, at[1]);
	controls.update();
}
(VIEWS[q.get("view") ?? "eye"] ?? (VIEWS.eye as () => void))();

// ---- UI
const ui = document.getElementById("ui") as HTMLElement;
for (const s of ["spring", "autumn", "winter"] as Season[]) {
	const b = document.createElement("button");
	b.textContent = s;
	b.onclick = () => setSeason(s);
	ui.appendChild(b);
}
for (const v of Object.keys(VIEWS)) {
	const b = document.createElement("button");
	b.textContent = v;
	b.onclick = () => VIEWS[v]?.();
	ui.appendChild(b);
}
const statsEl = document.getElementById("stats") as HTMLElement;

function resize(): void {
	renderer.setSize(innerWidth, innerHeight);
	camera.aspect = innerWidth / innerHeight;
	camera.updateProjectionMatrix();
}
resize();
addEventListener("resize", resize);

const fixedT = q.get("t");
let last = performance.now();
let frames = 0;
let acc = 0;
let fps = 0;
let updMs = 0;
let renderMs = 0;
function frame(t: number): void {
	const dt = Math.min(0.1, (t - last) / 1000);
	last = t;
	controls.update();
	const now = fixedT ? Number(fixedT) * 1000 + t * 0.001 : t;
	const t0 = performance.now();
	nature.update(dt, camera, now);
	const t1 = performance.now();
	// the sun's shadow follows what the camera looks at
	const tg = controls.target;
	sun.target.position.set(tg.x, tg.y, tg.z);
	sun.position.copy(tg).add(SUN_OFFSET);
	renderer.info.autoReset = false;
	renderer.info.reset();
	renderer.render(scene, camera);
	updMs = updMs * 0.95 + (t1 - t0) * 0.05;
	renderMs = renderMs * 0.95 + (performance.now() - t1) * 0.05;
	frames++;
	acc += dt;
	if (acc > 0.5) {
		fps = frames / acc;
		frames = 0;
		acc = 0;
		const s = nature.stats();
		statsEl.textContent =
			`${season}  ${fps.toFixed(0)} fps  update ${updMs.toFixed(2)} ms  render ${renderMs.toFixed(2)} ms\n` +
			`draw calls ${renderer.info.render.calls}  tris ${(renderer.info.render.triangles / 1e6).toFixed(2)} M\n` +
			`trees ${s.trees}: near ${s.near} mid ${s.mid} imp ${s.impostors}\n` +
			`tree draws ${s.treeDraws}  tree tris ${(s.treeTriangles / 1e6).toFixed(2)} M\n` +
			`cover ${s.coverPatches} in ${s.coverDraws}  falling ${s.falling}`;
	}
	requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// for driving from a script (screenshots, measurements)
Object.assign(window, {
	__nature: {
		nature,
		renderer,
		camera,
		controls,
		setSeason,
		view: (v: string) => VIEWS[v]?.(),
		info: () => ({ ...renderer.info.render, stats: nature.stats(), fps, updMs, renderMs }),
	},
});
