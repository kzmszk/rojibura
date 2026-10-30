import { DurableObject } from "cloudflare:workers";

/** One area of the city (docs/prd.md 3.3). Placeholder until issues #15-#17. */
export class CityRoomDO extends DurableObject<Env> {
	async fetch(request: Request): Promise<Response> {
		if (request.headers.get("Upgrade") !== "websocket") {
			return new Response("Expected WebSocket", { status: 426 });
		}
		const pair = new WebSocketPair();
		this.ctx.acceptWebSocket(pair[1]);
		return new Response(null, { status: 101, webSocket: pair[0] });
	}

	async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
		ws.send(typeof message === "string" ? `echo:${message}` : message);
	}
}
