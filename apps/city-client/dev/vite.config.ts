// The nature harness (nature.html): apps/city-host/node_modules/.bin/vite --config apps/city-client/dev/vite.config.ts
// Serves the repo's assets/ like the host does (textures under /tex/nature/).
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));

export default {
	root: here,
	publicDir: `${here}../../../assets`,
	server: { port: Number(process.env.RJ_PORT ?? 5182), strictPort: true, host: "127.0.0.1" },
};
