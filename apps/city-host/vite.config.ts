import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite";

export default defineConfig({
	plugins: [cloudflare()],
	// test city, navmesh and preset avatars are served as static assets
	publicDir: "../../assets",
	server: { port: 5173, strictPort: true },
});
