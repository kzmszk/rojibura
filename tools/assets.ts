// The areas' 3D files (assets/areas/**/*.glb) are deployed with the host but not kept in git (docs/prd.md 3.8.1):
// assets/areas/files.json records each one's size and SHA-256, so a fresh clone can fetch them back from the
// deployed site and a build can refuse to deploy without them (a deploy replaces every static asset).
//
//   node tools/assets.ts record              write files.json from the files here (after making new ones)
//   node tools/assets.ts check               every file in files.json is here and matches (exit 1 if not)
//   node tools/assets.ts pull [--from URL]   fetch what is missing or different (default: files.json's source)
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

export interface AssetsManifest {
	version: 1;
	/** Where the deployed files are (the production site). */
	source: string;
	/** By path under assets/ ("areas/venezia/3d/2026-11-01/t_16_7.glb"). */
	files: Record<string, { size: number; sha256: string }>;
}

const ROOT = join(import.meta.dirname, "..");
const ASSETS = join(ROOT, "assets");
export const MANIFEST = join(ASSETS, "areas", "files.json");
const DEFAULT_SOURCE = "https://rojibura.kazumasa.workers.dev";

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function glbsUnder(dir: string): string[] {
	const out: string[] = [];
	for (const name of readdirSync(dir)) {
		const p = join(dir, name);
		if (statSync(p).isDirectory()) out.push(...glbsUnder(p));
		else if (name.endsWith(".glb")) out.push(p);
	}
	return out;
}

export function readManifest(file = MANIFEST): AssetsManifest {
	return JSON.parse(readFileSync(file, "utf8")) as AssetsManifest;
}

/** What is wrong with the files here against files.json: missing or different ones (empty if all is well). */
export function checkAssets(assets = ASSETS, manifest = readManifest()): string[] {
	const problems: string[] = [];
	for (const [path, want] of Object.entries(manifest.files)) {
		const p = join(assets, path);
		if (!existsSync(p)) {
			problems.push(`${path}: missing`);
			continue;
		}
		const bytes = readFileSync(p);
		if (bytes.byteLength !== want.size || sha256(bytes) !== want.sha256) problems.push(`${path}: different`);
	}
	return problems;
}

function record(): void {
	const before = existsSync(MANIFEST) ? readManifest() : null;
	const files: AssetsManifest["files"] = {};
	for (const p of glbsUnder(join(ASSETS, "areas")).sort()) {
		const bytes = readFileSync(p);
		files[relative(ASSETS, p).split("\\").join("/")] = { size: bytes.byteLength, sha256: sha256(bytes) };
	}
	const manifest: AssetsManifest = { version: 1, source: before?.source ?? DEFAULT_SOURCE, files };
	const lines = Object.entries(files).map(([k, v]) => `\t\t${JSON.stringify(k)}: ${JSON.stringify(v)}`);
	writeFileSync(
		MANIFEST,
		`{\n\t"version": 1,\n\t"source": ${JSON.stringify(manifest.source)},\n\t"files": {\n${lines.join(",\n")}\n\t}\n}\n`,
	);
	const mb = Object.values(files).reduce((s, f) => s + f.size, 0) / 1e6;
	console.log(`files.json: ${lines.length} files, ${mb.toFixed(1)} MB`);
}

async function pull(from: string): Promise<void> {
	const manifest = readManifest();
	const base = from.replace(/\/$/, "");
	let fetched = 0;
	for (const [path, want] of Object.entries(manifest.files)) {
		const p = join(ASSETS, path);
		if (existsSync(p)) {
			const bytes = readFileSync(p);
			if (bytes.byteLength === want.size && sha256(bytes) === want.sha256) continue;
		}
		const r = await fetch(`${base}/${path}`);
		if (!r.ok) throw new Error(`${path}: ${r.status} from ${base}`);
		const bytes = new Uint8Array(await r.arrayBuffer());
		if (bytes.byteLength !== want.size || sha256(bytes) !== want.sha256)
			throw new Error(`${path}: what ${base} has is not the version in files.json`);
		mkdirSync(dirname(p), { recursive: true });
		writeFileSync(p, bytes);
		fetched++;
		console.log(`${path} (${(bytes.byteLength / 1e6).toFixed(1)} MB)`);
	}
	console.log(fetched ? `fetched ${fetched} files from ${base}` : "all files are here");
}

async function main(args: string[]) {
	const [cmd] = args;
	if (cmd === "record") record();
	else if (cmd === "check") {
		const problems = checkAssets();
		if (problems.length > 0) {
			console.error(
				`${problems.join("\n")}\n(node tools/assets.ts pull fetches them from the deployed site)`,
			);
			process.exit(1);
		}
		console.log(`all ${Object.keys(readManifest().files).length} files are here`);
	} else if (cmd === "pull") {
		const i = args.indexOf("--from");
		await pull(i >= 0 ? (args[i + 1] as string) : readManifest().source);
	} else {
		console.error("usage: node tools/assets.ts record | check | pull [--from URL]");
		process.exit(2);
	}
}

if (import.meta.main) await main(process.argv.slice(2));
