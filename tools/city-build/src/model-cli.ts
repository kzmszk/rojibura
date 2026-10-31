// Models for building in the city (docs/prd.md 3.7): run a Blender script, check the glb, register it.
// Prints one JSON object on stdout (for scripts and AI tools); progress and Blender's log go to stderr.
//
//   node tools/city-build/src/model-cli.ts make <script.py> [-o out.glb] [--preview] [--upload --name 茶屋]
//   node tools/city-build/src/model-cli.ts check <model.glb>
//   node tools/city-build/src/model-cli.ts upload <model.glb> --name 茶屋 [--owner you] [--base http://localhost:5173]
//   node tools/city-build/src/model-cli.ts builtins     # assets/models from blender/models/*.py (pnpm build:models)
//
// Blender is `blender` on the PATH (or $BLENDER). The script imports tools/city-build/blender/rj.py.
// Uploading needs the city running in free play (`pnpm dev:free`); it logs in with the dev login.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { checkModel, type ModelCheck } from "./model.ts";

const HERE = dirname(new URL(import.meta.url).pathname);
const BLENDER_DIR = resolve(HERE, "../blender");
const ROOT = resolve(HERE, "../../..");

const { values, positionals } = parseArgs({
	allowPositionals: true,
	options: {
		out: { type: "string", short: "o" },
		preview: { type: "boolean", default: false },
		upload: { type: "boolean", default: false },
		name: { type: "string" },
		owner: { type: "string", default: userInfo().username },
		base: { type: "string", default: process.env.RJ_BASE ?? "http://localhost:5173" },
		verbose: { type: "boolean", short: "v", default: false },
	},
});

const log = (...a: unknown[]) => console.error(...a);
const withExt = (glb: string, ext: string) => glb.replace(/\.glb$/i, "") + ext;

/** Runs a model script in Blender (headless) and returns the glb's path. */
function make(script: string, out: string, preview: boolean): string {
	const blender = process.env.BLENDER ?? "blender";
	const args = [
		"-b",
		"--factory-startup",
		"--python-exit-code",
		"1",
		"--python-expr",
		`import sys; sys.dont_write_bytecode = True; sys.path.insert(0, ${JSON.stringify(BLENDER_DIR)})`,
		"--python",
		script,
		"--",
		"--out",
		out,
		...(preview ? ["--preview", withExt(out, ".png")] : []),
	];
	log(`blender: ${script} -> ${out}`);
	const r = spawnSync(blender, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
	const output = `${r.stdout ?? ""}${r.stderr ?? ""}`;
	if (values.verbose) log(output);
	if (r.error) throw new Error(`could not run Blender (${blender}): ${r.error.message}`);
	if (r.status !== 0 || !existsSync(out)) {
		log(output.split("\n").slice(-40).join("\n"));
		throw new Error(`the Blender script failed (exit ${r.status})`);
	}
	return out;
}

/** Checks a glb and writes <name>.nav.json next to it. */
async function check(glb: string): Promise<ModelCheck & { glb: string; navFile: string }> {
	const result = await checkModel(readFileSync(glb));
	const navFile = withExt(glb, ".nav.json");
	writeFileSync(navFile, `${JSON.stringify(result.nav)}\n`);
	log(
		`checked: ${result.size.join(" x ")} m, ${result.triangles} triangles, ` +
			(result.walkable ? `walkable (${result.nav.walk?.polygons.length} polygons)` : "an obstacle"),
	);
	return { ...result, glb, navFile };
}

async function devLogin(base: string, name: string): Promise<string> {
	const token = process.env.RJ_DEV_TOKEN;
	const r = await fetch(`${base}/auth/dev/login?name=${encodeURIComponent(name)}`, {
		redirect: "manual",
		headers: token ? { "X-RJ-Dev-Token": token } : {},
	});
	const cookie = r.headers.get("set-cookie")?.split(";")[0];
	if (!cookie) throw new Error(`dev login failed (${r.status}): is the city running with pnpm dev:free?`);
	return cookie;
}

/** Registers a checked model with the city (free play only). */
async function upload(glb: string, name: string): Promise<unknown> {
	const navFile = withExt(glb, ".nav.json");
	if (!existsSync(navFile)) await check(glb);
	const base = values.base as string;
	const cookie = await devLogin(base, values.owner as string);
	const form = new FormData();
	form.set("name", name);
	form.set("glb", new Blob([readFileSync(glb)], { type: "model/gltf-binary" }), basename(glb));
	form.set("nav", readFileSync(navFile, "utf8"));
	const png = withExt(glb, ".png");
	if (existsSync(png))
		form.set("preview", new Blob([readFileSync(png)], { type: "image/png" }), basename(png));
	const r = await fetch(`${base}/api/models`, { method: "POST", body: form, headers: { Cookie: cookie } });
	const body = await r.text();
	if (!r.ok) throw new Error(`upload failed (${r.status}): ${body}`);
	log(`registered: ${body}`);
	return JSON.parse(body);
}

/** The model's name: the docstring of its script starts with it ("""家 — a small house ..."""). */
function scriptTitle(script: string): string {
	const m = readFileSync(script, "utf8").match(/^"""\s*([^\s—-][^—\n]*?)\s+—/);
	return m?.[1]?.trim() ?? basename(script, ".py");
}

/** Builds assets/models: every blender/models/<id>.py, plus index.json for the build menu. */
async function builtins(): Promise<unknown> {
	const outDir = join(ROOT, "assets/models");
	mkdirSync(outDir, { recursive: true });
	const index: unknown[] = [
		{ id: "block", name: "ブロック", builtin: true, walkable: false, size: [1, 1, 1], color: "#dbc8a6" },
	];
	const dir = join(BLENDER_DIR, "models");
	for (const file of readdirSync(dir)
		.filter((f) => f.endsWith(".py"))
		.sort()) {
		const id = basename(file, ".py");
		const glb = make(join(dir, file), join(outDir, `${id}.glb`), true);
		const r = await check(glb);
		index.push({
			id,
			name: scriptTitle(join(dir, file)),
			builtin: true,
			walkable: r.walkable,
			size: r.size,
			color: r.color,
		});
	}
	writeFileSync(
		join(outDir, "index.json"),
		`[\n${index.map((m) => `\t${JSON.stringify(m)}`).join(",\n")}\n]\n`,
	);
	return index;
}

async function main(): Promise<unknown> {
	const [command, target] = positionals;
	switch (command) {
		case "make": {
			if (!target) throw new Error("make <script.py>");
			const out = resolve(values.out ?? withExt(target.replace(/\.py$/, ".glb"), ".glb"));
			make(resolve(target), out, values.preview as boolean);
			const r = await check(out);
			const result = {
				glb: r.glb,
				nav: r.navFile,
				preview: values.preview ? withExt(out, ".png") : undefined,
				walkable: r.walkable,
				size: r.size,
				triangles: r.triangles,
				color: r.color,
			};
			if (!values.upload) return result;
			return { ...result, model: await upload(out, values.name ?? basename(target, ".py")) };
		}
		case "check": {
			if (!target) throw new Error("check <model.glb>");
			const r = await check(resolve(target));
			return {
				glb: r.glb,
				nav: r.navFile,
				walkable: r.walkable,
				size: r.size,
				triangles: r.triangles,
				color: r.color,
			};
		}
		case "upload":
			if (!target) throw new Error("upload <model.glb> --name <name>");
			return { model: await upload(resolve(target), values.name ?? basename(target, ".glb")) };
		case "builtins":
			return { models: await builtins() };
		default:
			throw new Error(
				"usage: model-cli.ts make|check|upload|builtins (see the top of tools/city-build/src/model-cli.ts)",
			);
	}
}

try {
	console.log(JSON.stringify(await main(), null, 2));
} catch (e) {
	console.log(JSON.stringify({ error: (e as Error).message }));
	process.exit(1);
}
