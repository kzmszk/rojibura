import { env } from "cloudflare:workers";

export { CityRoomDO } from "./room.ts";

export default {
	async fetch(request) {
		const url = new URL(request.url);
		if (url.pathname === "/api/health") {
			return Response.json({ ok: true, devAuth: env.DEV_AUTH === "1" });
		}
		const ws = url.pathname.match(/^\/ws\/area\/([a-z0-9-]{1,32})$/);
		if (ws?.[1]) {
			const stub = env.ROOM.getByName(ws[1]);
			return stub.fetch(request);
		}
		return new Response("Not found", { status: 404 });
	},
} satisfies ExportedHandler<Env>;
