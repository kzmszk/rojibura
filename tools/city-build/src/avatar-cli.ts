// Avatars shipped with the city (docs/prd.md 3.4.4). Prints one JSON object on stdout.
//
//   node tools/city-build/src/avatar-cli.ts slim <in.vrm> -o assets/avatars/shibu.vrm [--max 1024]
//   node tools/city-build/src/avatar-cli.ts motions        # assets/avatars/motions.glb from saki.glb (pnpm build:motions)

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import sharp from "sharp";
import { extractMotions, SAKI_BONES, slimVrm } from "./avatar.ts";

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), "../../..");

const { values, positionals } = parseArgs({
	allowPositionals: true,
	options: {
		out: { type: "string", short: "o" },
		max: { type: "string", default: "1024" },
	},
});

/** The clips the city plays (apps/city-client/src/avatars.ts). */
const CLIPS = ["stand", "walk", "run", "sit"];

const [command, input] = positionals;
if (command === "slim" && input && values.out) {
	const { glb, report } = await slimVrm(
		readFileSync(input),
		async (data, maxSide) =>
			sharp(data)
				.resize({ width: maxSide, height: maxSide, fit: "inside", withoutEnlargement: true })
				.webp({ quality: 90, alphaQuality: 100, effort: 6, exact: true })
				.toBuffer(),
		{ maxTexture: Number(values.max), maxThumbnail: 256 },
	);
	writeFileSync(values.out, glb);
	console.log(JSON.stringify({ out: values.out, ...report }));
} else if (command === "motions") {
	const from = input ?? resolve(ROOT, "assets/avatars/saki.glb");
	const out = values.out ?? resolve(ROOT, "assets/avatars/motions.glb");
	const glb = extractMotions(readFileSync(from), SAKI_BONES, CLIPS);
	writeFileSync(out, glb);
	console.log(JSON.stringify({ out, bytes: glb.byteLength, clips: CLIPS }));
} else {
	console.error(
		"usage: avatar-cli.ts slim <in.vrm> -o <out.vrm> [--max 1024] | motions [saki.glb] [-o motions.glb]",
	);
	process.exit(2);
}
