// Avatars shipped with the city (docs/prd.md 3.4.4). Prints one JSON object on stdout.
//
//   node tools/city-build/src/avatar-cli.ts slim <in.vrm> -o assets/avatars/shibu.vrm [--max 1024]

import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import sharp from "sharp";
import { slimVrm } from "./avatar.ts";

const { values, positionals } = parseArgs({
	allowPositionals: true,
	options: {
		out: { type: "string", short: "o" },
		max: { type: "string", default: "1024" },
	},
});

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
} else {
	console.error("usage: avatar-cli.ts slim <in.vrm> -o <out.vrm> [--max 1024]");
	process.exit(2);
}
