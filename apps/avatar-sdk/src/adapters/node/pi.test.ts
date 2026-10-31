import { describe, expect, test } from "vitest";
import { parsePiOutput } from "./pi.ts";

const user = { role: "user", content: [{ type: "text", text: "こんばんは" }] };
const answer = (content: { type: string; text?: string }[], extra: object = {}) => ({
	role: "assistant",
	content,
	provider: "openai-codex",
	model: "gpt-6-luna",
	stopReason: "stop",
	...extra,
});
const stream = (assistant: object) =>
	[
		{ type: "session", version: 3, id: "s1" },
		{ type: "agent_start" },
		{ type: "message_end", message: user },
		{ type: "message_end", message: assistant },
		{ type: "turn_end", message: assistant },
		{ type: "agent_end", messages: [user, assistant] },
	]
		.map((e) => JSON.stringify(e))
		.join("\n");

describe("parsePiOutput", () => {
	test("returns the JSON in the assistant's answer", () => {
		const out = stream(answer([{ type: "text", text: '{"reply":"こんばんは。","motion":"nod"}' }]));
		expect(parsePiOutput(out)).toEqual({ reply: "こんばんは。", motion: "nod" });
	});

	test("reads JSON wrapped in a code fence after a thinking block", () => {
		const out = stream(
			answer([{ type: "thinking" }, { type: "text", text: '```json\n{"summary":"初対面。"}\n```' }]),
		);
		expect(parsePiOutput(out)).toEqual({ summary: "初対面。" });
	});

	test("returns null when the answer holds no JSON", () => {
		expect(parsePiOutput(stream(answer([{ type: "text", text: "こんばんは。" }])))).toBeNull();
	});

	test("throws the provider's error", () => {
		const out = stream(answer([], { stopReason: "error", errorMessage: "Codex error: model not supported" }));
		expect(() => parsePiOutput(out)).toThrow("Codex error: model not supported");
	});

	test("throws when pi never answered", () => {
		expect(() => parsePiOutput("")).toThrow("unexpected pi output");
		expect(() => parsePiOutput('null\n{"type":"agent_start"}\nnot json')).toThrow("unexpected pi output");
	});
});
