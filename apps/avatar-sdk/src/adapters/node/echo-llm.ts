// A deterministic stand-in LLM for tests and offline runs.

import type { LLM } from "../../core/types.ts";

export class EchoLLM implements LLM {
	readonly name = "echo";

	async complete(req: { user: string }): Promise<unknown> {
		const said = req.user.match(/相手の発言: 「(.*)」/)?.[1] ?? "";
		return { reply: `「${said}」ですね。`, motion: "nod", goTo: "stay", endConversation: false };
	}
}
