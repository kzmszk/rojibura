import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig, type Plugin } from "vite";
import { checkAssets } from "../../tools/assets.ts";

/**
 * The areas' 3D files are not in git (tools/assets.ts). A deploy replaces every static asset, so a build without
 * them (a fresh clone) would take the city off the site: it stops instead. In development it only warns.
 */
function areaAssets(): Plugin {
	let build = false;
	return {
		name: "rojibura-area-assets",
		configResolved(config) {
			build = config.command === "build";
		},
		buildStart() {
			const problems = checkAssets();
			if (problems.length === 0) return;
			const message = `the areas' 3D files are not all here (node tools/assets.ts pull):\n  ${problems.join("\n  ")}`;
			if (build) this.error(message);
			else this.warn(message);
		},
	};
}

export default defineConfig({
	plugins: [areaAssets(), cloudflare()],
	// the areas (their navmesh, places and 3D) and preset avatars are served as static assets
	publicDir: "../../assets",
	// RJ_PORT: another port, e.g. for a second checkout (worktree) running at the same time
	server: { port: Number(process.env.RJ_PORT ?? 5173), strictPort: true },
});
