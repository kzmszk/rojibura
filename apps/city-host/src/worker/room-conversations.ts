import {
	type AvatarId,
	type ClientToHost,
	CONV_TIMEOUT_MS,
	type HostToClient,
	type SpatialContext,
} from "@rojibura/protocol";
import type { ChatLine, Conv, Member, Transport } from "./room-core.ts";
import { type Bucket, takeToken, within } from "./room-rate.ts";
import type { RoomRules } from "./rules.ts";

interface SpeechRuntime {
	sayBucket: Bucket;
	aiSays: number[];
	lastAiReplyAt: number;
}

interface ConversationPort<C> {
	rules: RoomRules;
	stats: { says: number };
	transport: Transport<C>;
	clock: () => number;
	newId: () => string;
	memberById(id: AvatarId): Member | undefined;
	connectionFor(id: AvatarId): C | undefined;
	blockedBetween(a: AvatarId, b: AvatarId): boolean;
	broadcastAbout(
		member: Member,
		message: HostToClient,
		except?: C,
		target?: AvatarId,
		speech?: boolean,
	): void;
	contextFor(member: Member, now: number): SpatialContext;
	notice(conn: C, kind: "rate_limited" | "rejected", message: string): void;
}

const CHAT_LOG_MAX = 2000;
function pairKey(a: AvatarId, b: AvatarId): string {
	return a < b ? `${a}|${b}` : `${b}|${a}`;
}

export class RoomConversations<C> {
	private readonly convs = new Map<string, Conv>();
	private readonly pairCooldown = new Map<string, number>();
	private readonly humanToAi = new Map<string, number[]>();
	readonly chatLog: ChatLine[] = [];
	private readonly port: ConversationPort<C>;
	constructor(port: ConversationPort<C>) {
		this.port = port;
	}
	restore(member: Member): void {
		for (const c of member.convs ?? []) if (!this.convs.has(c.id)) this.convs.set(c.id, { ...c });
		for (const [other, until] of Object.entries(member.cooldowns ?? {}))
			this.pairCooldown.set(
				pairKey(member.id, other),
				Math.max(until, this.pairCooldown.get(pairKey(member.id, other)) ?? 0),
			);
	}
	expireConversations(now: number): void {
		for (const c of [...this.convs.values()])
			if (now - c.lastAt > CONV_TIMEOUT_MS) this.endConv(c, "timeout");
	}
	expireCooldowns(now: number): void {
		for (const [k, until] of this.pairCooldown) if (until <= now) this.pairCooldown.delete(k);
	}
	closeBetween(a: AvatarId, b: AvatarId): void {
		for (const c of [...this.convs.values()])
			if ((c.a === a && c.b === b) || (c.a === b && c.b === a)) this.endConv(c, "left");
	}
	leave(id: AvatarId): void {
		for (const c of [...this.convs.values()]) if (c.a === id || c.b === id) this.endConv(c, "left");
	}
	excerpt(id: AvatarId, ms: number): ChatLine[] {
		const since = this.port.clock() - ms;
		return this.chatLog.filter((l) => l.at >= since && (l.id === id || l.to === id));
	}
	private syncConvs(...ids: AvatarId[]): void {
		const now = this.port.clock();
		for (const id of ids) {
			const conn = this.port.connectionFor(id);
			const m = conn === undefined ? undefined : this.port.memberById(id);
			if (conn === undefined || !m) continue;
			m.convs = [...this.convs.values()].filter((c) => c.a === id || c.b === id).map((c) => ({ ...c }));
			const cooldowns: Record<AvatarId, number> = {};
			for (const [key, until] of this.pairCooldown) {
				if (until <= now) continue;
				const [x, y] = key.split("|");
				if (x === id && y) cooldowns[y] = until;
				else if (y === id && x) cooldowns[x] = until;
			}
			m.cooldowns = cooldowns;
			this.port.transport.persist(conn, m);
		}
	}

	say(
		conn: C,
		m: Member,
		v: SpeechRuntime,
		msg: Extract<ClientToHost, { t: "SAY" }>,
		now: number,
	): "ignored" | "violation" {
		if (m.mutedUntil && m.mutedUntil > now) {
			this.port.transport.send(conn, {
				t: "NOTICE",
				kind: "muted_by_moderator",
				message: "いまは発言できません",
			});
			return "ignored";
		}
		// rate limits (the host's own guide answers everyone, so it has none)
		const { rateSayHuman, sayAiPerMin } = this.port.rules;
		if (m.system) {
			// no limit
		} else if (m.kind === "human") {
			if (rateSayHuman && !takeToken(v.sayBucket, rateSayHuman.rate, rateSayHuman.burst, now)) {
				return "violation";
			}
		} else if (sayAiPerMin !== null) {
			const limit = m.trust === "provisional" ? Math.floor(sayAiPerMin / 2) : sayAiPerMin;
			v.aiSays = within(v.aiSays, 60_000, now);
			if (v.aiSays.length >= limit) {
				return "violation";
			}
		}

		let conv: Conv | undefined;
		let target: Member | undefined;
		if (msg.convId) {
			const c = this.convs.get(msg.convId);
			if (c && (c.a === m.id || c.b === m.id)) {
				conv = c;
				const otherId = c.a === m.id ? c.b : c.a;
				if (msg.to && msg.to !== otherId) {
					this.port.notice(conn, "rejected", "会話の相手が違います");
					return "ignored";
				}
				target = this.port.memberById(otherId);
				if (target && this.port.blockedBetween(m.id, target.id)) target = undefined;
				if (!target) {
					this.endConv(c, "left");
					return "ignored";
				}
			}
		}
		if (!conv && msg.to) {
			target = this.port.memberById(msg.to);
			if (target && this.port.blockedBetween(m.id, target.id)) target = undefined;
			if (!target || target.id === m.id) {
				this.port.notice(conn, "rejected", "相手が見つかりません");
				return "ignored";
			}
			// both sides may start at the same moment: join the open conversation instead of making a second one
			const tid = target.id;
			conv = [...this.convs.values()].find(
				(c) => (c.a === m.id && c.b === tid) || (c.a === tid && c.b === m.id),
			);
		}
		if (!conv && msg.to && target) {
			const err = this.canStartConv(m, target, now);
			if (err) {
				this.port.notice(conn, "rejected", err);
				return "ignored";
			}
			const aiPair = m.kind === "ai" && target.kind === "ai";
			conv = {
				id: `c_${this.port.newId()}`,
				a: m.id,
				b: target.id,
				turn: 0,
				maxTurns: aiPair ? this.port.rules.aiConvMaxTurns : null,
				lastAt: now,
			};
			this.convs.set(conv.id, conv);
		}

		if (conv && target) {
			if (
				m.kind === "ai" &&
				target.kind === "ai" &&
				now - v.lastAiReplyAt < this.port.rules.aiReplyMinIntervalMs
			) {
				this.port.notice(conn, "rate_limited", "返答の間隔が短すぎます");
				return "ignored";
			}
			if (m.kind === "human" && target.kind === "ai" && !this.countHumanToAi(m.id, target.id, now)) {
				this.port.notice(conn, "rate_limited", "同じAIへの話しかけが多すぎます");
				return "ignored";
			}
			conv.turn++;
			conv.lastAt = now;
			this.syncConvs(conv.a, conv.b);
		}
		if (m.kind === "ai") {
			v.aiSays.push(now);
			v.lastAiReplyAt = now;
		}

		this.port.stats.says++;
		const said: HostToClient = { t: "SAID", id: m.id, text: msg.text, at: now };
		if (target) said.to = target.id;
		if (conv) said.convId = conv.id;
		this.port.broadcastAbout(m, said, undefined, target?.id, true);
		this.chatLog.push({ at: now, id: m.id, name: m.name, to: target?.id, text: msg.text });
		if (this.chatLog.length > CHAT_LOG_MAX) this.chatLog.splice(0, this.chatLog.length - CHAT_LOG_MAX);

		if (conv && target) {
			if (target.kind === "ai") {
				const targetConn = this.port.connectionFor(target.id);
				if (targetConn !== undefined)
					this.port.transport.send(targetConn, {
						t: "ADDRESSED",
						from: m.id,
						text: msg.text,
						convId: conv.id,
						turn: conv.turn,
						maxTurns: conv.maxTurns,
						context: this.port.contextFor(target, now),
					});
			}
			if (conv.maxTurns !== null && conv.turn >= conv.maxTurns) this.endConv(conv, "max_turns");
		}
		return "ignored";
	}

	private canStartConv(from: Member, to: Member, now: number): string | null {
		if (from.kind === "ai" && to.kind === "human") {
			if (from.trust !== "approved" && !this.port.rules.provisionalMayApproachHumans)
				return "仮承認のAIは人間に話しかけられません";
			if (to.allowAiApproach === false) return "この人はAIからの話しかけを受け付けていません";
		}
		if (from.kind === "ai" && to.kind === "ai") {
			const until = this.pairCooldown.get(pairKey(from.id, to.id));
			if (until !== undefined && until > now) return "この相手とはしばらく会話できません";
			const active = [...this.convs.values()].filter(
				(c) => c.a === from.id || c.b === from.id || c.a === to.id || c.b === to.id,
			);
			const most = this.port.rules.aiConcurrentConvs;
			if (most !== null && active.length >= most) return "会話が多すぎます";
		}
		return null;
	}

	private countHumanToAi(human: AvatarId, ai: AvatarId, now: number): boolean {
		const limit = this.port.rules.humanToSameAiPerMin;
		if (limit === null) return true;
		const key = `${human}>${ai}`;
		const times = within(this.humanToAi.get(key) ?? [], 60_000, now);
		if (times.length >= limit) {
			this.humanToAi.set(key, times);
			return false;
		}
		times.push(now);
		this.humanToAi.set(key, times);
		return true;
	}

	private endConv(c: Conv, reason: "max_turns" | "timeout" | "left" | "budget"): void {
		this.convs.delete(c.id);
		const a = this.port.memberById(c.a);
		const b = this.port.memberById(c.b);
		if (a?.kind === "ai" && b?.kind === "ai" && this.port.rules.aiPairCooldownMs > 0)
			this.pairCooldown.set(pairKey(c.a, c.b), this.port.clock() + this.port.rules.aiPairCooldownMs);
		for (const id of [c.a, c.b]) {
			const conn = this.port.connectionFor(id);
			if (conn !== undefined) this.port.transport.send(conn, { t: "CONV_END", convId: c.id, reason });
		}
		this.syncConvs(c.a, c.b);
	}
}
