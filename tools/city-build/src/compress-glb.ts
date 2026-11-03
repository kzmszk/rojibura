// Makes a glb from Blender small for the browser: welds vertices, merges what shares a material, quantises and
// compresses with meshopt (three.js GLTFLoader + MeshoptDecoder, as scene.ts loads areas), and resizes textures.
//
//   node tools/city-build/src/compress-glb.ts <in.glb> <out.glb> [--tex 1024] [--only <prefix>] [--drop <prefix>]
//       [--cols 0,1]
//
// --only keeps the meshes whose names start with the prefix, --drop removes them: the winter snow of はじまりの街 is
// a file of its own, loaded only in winter. --cols keeps the meshes in those columns of Blender's chunks (the i of
// a name's _i_j ending, hajimari/geom.py): the walled town, where people arrive, is a file of its own, loaded
// before the rest. Mesh names are kept: the browser finds snow, water and the like by name.
// Normal maps are made half the size of the colour textures.
import { readFileSync, writeFileSync } from "node:fs";
import { type Document, NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS, EXTMeshoptCompression } from "@gltf-transform/extensions";
import { dedup, meshopt, prune, quantize, textureCompress, weld } from "@gltf-transform/functions";
import { MeshoptDecoder, MeshoptEncoder } from "meshoptimizer";
import sharp from "sharp";

async function main(args: string[]) {
	const [input, output] = args;
	if (!input || !output) {
		console.error(
			"usage: node tools/city-build/src/compress-glb.ts <in.glb> <out.glb> [--tex 1024] [--only <prefix>] [--drop <prefix>] [--cols 0,1]",
		);
		process.exit(2);
	}
	const opt = (name: string) => {
		const i = args.indexOf(name);
		return i >= 0 ? args[i + 1] : undefined;
	};
	const tex = Number(opt("--tex") ?? 1024);
	const only = opt("--only");
	const drop = opt("--drop");
	const cols = opt("--cols")?.split(",").map(Number);
	await MeshoptDecoder.ready;
	await MeshoptEncoder.ready;
	const io = new NodeIO()
		.registerExtensions(ALL_EXTENSIONS)
		.registerDependencies({ "meshopt.decoder": MeshoptDecoder, "meshopt.encoder": MeshoptEncoder });
	const doc = await io.readBinary(new Uint8Array(readFileSync(input)));
	const before = readFileSync(input).byteLength;
	if (only || drop || cols)
		keepNodes(
			doc,
			(name) =>
				(only ? name.startsWith(only) : true) &&
				!(drop && name.startsWith(drop)) &&
				(cols ? cols.includes(columnOf(name)) : true),
		);
	await doc.transform(
		dedup(),
		weld(),
		textureCompress({
			encoder: sharp,
			targetFormat: "webp",
			slots: /normal/,
			resize: [tex / 2, tex / 2],
			quality: 80,
		}),
		textureCompress({ encoder: sharp, targetFormat: "webp", resize: [tex, tex], quality: 82 }),
		prune(),
		quantize({ quantizePosition: 16, quantizeNormal: 10, quantizeTexcoord: 14, quantizeColor: 8 }),
		meshopt({ encoder: MeshoptEncoder, level: "high" }),
	);
	doc.createExtension(EXTMeshoptCompression).setRequired(true);
	const bytes = await io.writeBinary(doc);
	writeFileSync(output, bytes);
	console.log(
		`${input}: ${(before / 1e6).toFixed(1)} MB -> ${output}: ${(bytes.byteLength / 1e6).toFixed(1)} MB`,
	);
}

/** The chunk column of a Blender object named <name>_<i>_<j> (Blender may add .001 and the like); -1 if none. */
export function columnOf(name: string): number {
	const m = /_(-?\d+)_(-?\d+)(\.\d+)?$/.exec(name);
	return m ? Number(m[1]) : -1;
}

function keepNodes(doc: Document, keep: (name: string) => boolean) {
	for (const node of doc.getRoot().listNodes()) if (node.getMesh() && !keep(node.getName())) node.dispose();
}

if (import.meta.main) await main(process.argv.slice(2));
