// Serves a folder with CORS, so a development build can load an area's 3D files from it before they are deployed
// (docs/prd.md 3.8.1: `?assets=`).
//
//   node tools/serve-cors.ts <dir> [port]       e.g. node tools/serve-cors.ts ~/work/demos/venice/public 8418
import { createReadStream, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";

const TYPES: Record<string, string> = {
	".glb": "model/gltf-binary",
	".json": "application/json",
	".png": "image/png",
	".ktx2": "image/ktx2",
};

const [dir, port = "8418"] = process.argv.slice(2);
if (!dir) {
	console.error("usage: node tools/serve-cors.ts <dir> [port]");
	process.exit(2);
}
const root = resolve(dir);
createServer((req, res) => {
	const path = normalize(join(root, decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname)));
	res.setHeader("Access-Control-Allow-Origin", "*");
	const file = path.startsWith(root) ? statSync(path, { throwIfNoEntry: false }) : undefined;
	if (!file?.isFile()) {
		res.writeHead(404).end();
		return;
	}
	res.writeHead(200, {
		"Content-Type": TYPES[extname(path)] ?? "application/octet-stream",
		"Content-Length": file.size,
	});
	createReadStream(path).pipe(res);
}).listen(Number(port), "127.0.0.1", () => console.log(`${root} on http://127.0.0.1:${port}/`));
