import type { AvatarId, HostToClient, Motion } from "@rojibura/protocol";
import type { Attention } from "./attention.ts";
import type { AvatarView } from "./avatars.ts";
import type { BodyParts } from "./body.ts";
import type { Relations } from "./moderation.ts";

export const MOTION_EMOJI: Record<Motion, string> = {
	wave: "👋",
	nod: "🙂",
	bow: "🙇",
	jump: "⤴️",
	sit: "🪑",
	lie: "🛌",
	handstand: "🤸",
	roll: "⤵️",
	backroll: "↩️",
	backflip: "🔄",
	stepback: "🔙",
};

type ExpressionMessage = Extract<HostToClient, { t: "ACTED" | "BODIED" | "SAID" }>;
type ExpressionView = Pick<AvatarView, "state" | "act" | "moveBody" | "say"> & {
	root: Pick<AvatarView["root"], "position">;
} & BodyParts;
type ExpressionDependencies = {
	avatars: ReadonlyMap<AvatarId, ExpressionView>;
	relations: Pick<Relations, "silenced">;
	attention: Pick<Attention, "said">;
	hostNow: () => number;
	myId: AvatarId | null;
	addLog: (who: string, text: string, cls?: string) => void;
};

export function showExpression(
	m: ExpressionMessage,
	{ avatars, relations, attention, hostNow, myId, addLog }: ExpressionDependencies,
): void {
	if (relations.silenced(m.id)) return;
	switch (m.t) {
		case "ACTED": {
			const v = avatars.get(m.id);
			const towards = m.target ? avatars.get(m.target)?.root.position : undefined;
			// shown with the body; an avatar that cannot (a capsule, or walking) shows the emoji
			if (v && !v.act(m.motion, hostNow(), towards)) v.say(MOTION_EMOJI[m.motion], hostNow());
			break;
		}
		case "BODIED": {
			const v = avatars.get(m.id);
			const partner = m.to ? (avatars.get(m.to) ?? null) : null;
			// a model without bones to move shows a hand over its head
			if (v && !v.moveBody(m.keys, m.at, partner, m.to)) v.say("🤲", hostNow());
			break;
		}
		case "SAID": {
			const v = avatars.get(m.id);
			v?.say(m.text, hostNow());
			// an AI and its owner talking: it faces them (docs/prd.md 3.4.9)
			const heard = m.to ? avatars.get(m.to) : undefined;
			if (v?.state.kind === "ai" && (!m.to || m.to === v.state.ownerId))
				attention.said(v.state.id, hostNow());
			if (heard?.state.kind === "ai" && heard.state.ownerId === m.id)
				attention.said(heard.state.id, hostNow());
			// said to everyone: their own AIs close by listen, each of them (docs/prd.md 3.4.12)
			if (!m.to && v?.state.kind === "human")
				for (const a of avatars.values())
					if (a.state.kind === "ai" && a.state.ownerId === m.id) attention.said(a.state.id, hostNow());
			const to = m.to ? avatars.get(m.to)?.state.name : undefined;
			addLog(`${v?.state.name ?? "?"}${to ? ` → ${to}` : ""}`, m.text, m.id === myId ? "mine" : "");
			break;
		}
	}
}
