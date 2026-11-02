import { afterEach, describe, expect, test } from "vitest";
import { ResidentToolServer } from "./claude-mind.ts";
import { residentTools } from "./resident-tools.ts";

let server: ResidentToolServer | null = null;
afterEach(() => server?.stop());

describe("the resident's tools over MCP", () => {
	test("lists the tools, carries out calls (a picture as an image), and lets in only its own client", async () => {
		const calls: [string, Record<string, unknown>][] = [];
		server = new ResidentToolServer(residentTools(true), async (tool, args) => {
			calls.push([tool, args]);
			if (tool === "practice") return { text: "やってみた", image: new Uint8Array([1, 2, 3]) };
			if (tool === "learn") throw new Error("まだ何も練習していない。");
			return "言った。";
		});
		await server.start();
		const post = (body: unknown, token = server?.token) =>
			fetch(server?.url as string, {
				method: "POST",
				headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
		expect((await post({ jsonrpc: "2.0", id: 1, method: "tools/list" }, "nope")).status).toBe(403);
		const init = await (
			await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } })
		).json();
		expect(init.result).toMatchObject({ protocolVersion: "2025-06-18", capabilities: { tools: {} } });
		expect((await post({ jsonrpc: "2.0", method: "notifications/initialized" })).status).toBe(202);
		const list = await (await post({ jsonrpc: "2.0", id: 2, method: "tools/list" })).json();
		const names = list.result.tools.map((t: { name: string }) => t.name);
		expect(names).toEqual([
			"say",
			"walk_to",
			"gesture",
			"turn",
			"wait",
			"buy",
			"eat",
			"work",
			"move_body",
			"practice",
			"learn",
			"step",
			"remember",
		]);
		expect(list.result.tools[0].inputSchema).toMatchObject({ type: "object", required: ["text"] });
		const call = async (name: string, args: object) =>
			(
				await (
					await post({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name, arguments: args } })
				).json()
			).result;
		expect(await call("say", { text: "やあ" })).toEqual({ content: [{ type: "text", text: "言った。" }] });
		expect(await call("practice", { keys: "[]" })).toEqual({
			content: [
				{ type: "text", text: "やってみた" },
				{ type: "image", data: "AQID", mimeType: "image/jpeg" },
			],
		});
		expect(await call("learn", { name: "x" })).toEqual({
			content: [{ type: "text", text: "まだ何も練習していない。" }],
			isError: true,
		});
		expect((await call("Bash", { command: "ls" })).isError).toBe(true);
		expect(calls.map(([t]) => t)).toEqual(["say", "practice", "learn"]);
	});
});
