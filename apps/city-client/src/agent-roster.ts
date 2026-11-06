// What 🤖 自分のAI says of each of the owner's AIs, and which of them come in with the owner. Kept apart from the
// panel so what is offered as possible can be checked without a page.

/** An AI as GET /api/me lists it. */
export interface OwnedAgent {
	id: string;
	name: string;
	runtime: string;
	trust: "provisional" | "approved" | "suspended";
}

/** An AI as GET /api/agents/status tells of it. */
export interface AgentPresence {
	id: string;
	paired: boolean;
	pairedAt: number | null;
	/** The area it is in now, from wherever it runs. */
	area: string | null;
	/** Where it runs now: "pc", or the runtime it registered with. */
	runsOn: string | null;
	banned: boolean;
}

/** Where the AI is in this tab: idle until it is started here. */
export type Run = "idle" | "starting" | "running" | "stopped" | "replaced" | "error";

export interface AiFacts {
	agent: OwnedAgent;
	presence: AgentPresence | null;
	/** This browser holds its key. */
	hasKey: boolean;
	run: Run;
}

export interface AiView {
	/** What it is doing now, as the list shows it. */
	state: string;
	/** Running in this tab. */
	running: boolean;
	/** In the city from somewhere this tab cannot steer. */
	elsewhere: boolean;
	trust: string;
	/** Where it can run: what the host and this browser know. */
	place: string;
	/** Starting it here is possible; otherwise `blocked` says why. */
	canStart: boolean;
	blocked: string | null;
}

const TRUST: Record<OwnedAgent["trust"], string> = {
	approved: "承認済み",
	provisional: "仮承認",
	suspended: "利用停止",
};

function whereItRuns(runsOn: string | null): string {
	if (runsOn === "pc" || runsOn === "node") return "PC";
	if (runsOn === "browser") return "別のタブか別の端末のブラウザ";
	if (runsOn === "worker") return "クラウド";
	return "別の場所";
}

export function describeAi({ agent, presence, hasKey, run }: AiFacts): AiView {
	const running = run === "starting" || run === "running";
	const elsewhere = !running && !!presence?.area;
	const state =
		run === "starting"
			? "準備しています…"
			: run === "running"
				? "街にいます（このタブで動いています）"
				: elsewhere
					? `街にいます（${whereItRuns(presence?.runsOn ?? null)}で動いています）`
					: run === "error"
						? "うまくいきませんでした"
						: "街にいません";
	const onPc = presence?.paired === true || agent.runtime === "node";
	const place = hasKey
		? onPc
			? "このブラウザとPCで動かせます"
			: "このブラウザで動かせます"
		: onPc
			? "PCで動かすAIです（このブラウザに鍵はありません）"
			: agent.runtime === "worker"
				? "クラウドで動かすAIです（このブラウザに鍵はありません）"
				: "このブラウザに鍵がありません（登録した端末で動かせます）";
	const blocked =
		agent.trust === "suspended" || presence?.banned
			? "利用停止中のため、街に入れられません。"
			: !hasKey
				? "このブラウザには鍵がないので、ここからは動かせません。"
				: null;
	return {
		state,
		running,
		elsewhere,
		trust: TRUST[agent.trust],
		place,
		canStart: !running && blocked === null,
		blocked,
	};
}

/**
 * Why the host closed an AI's connection for good, for the owner to read. `notice`: what it said just before
 * (the reason an AI is turned away is sent that way).
 */
export function closeMessage(code: number, reason: string, notice: string | null): string {
	if (notice) return notice;
	if (code === 4010) return reason || "閉館しました";
	if (code === 4001) return "街に入れませんでした（定員や同時入場数の上限です）";
	if (code === 4003) return "街から退出させられました";
	if (code === 1008) return "このAIの鍵を確かめられませんでした";
	return `接続が閉じられました（${code}）`;
}

/** Closed like this, it should not come in again by itself next time (full or closed: it may next time). */
export const staysOutAfter = (code: number) => code === 4003 || code === 1008;

// ---- which AIs come in with the owner ----

/**
 * An AI getting in from here sets it; sending it home or the PC taking over clears it, so a tab never pushes out the AI
 * on the PC by itself. Per owner, so accounts on one browser stay apart.
 */
const wantedKey = (ownerId: string) => `rj.agent.on.${ownerId}`;
/** Earlier versions, with one AI: whether it comes in. */
const LEGACY_ON_KEY = "rj.agent.on";
const selectedKey = (ownerId: string) => `rj.agent.selected.${ownerId}`;

function stored(key: string): string | null {
	try {
		return localStorage.getItem(key);
	} catch {
		return null; // private mode
	}
}

function store(key: string, value: string): void {
	try {
		localStorage.setItem(key, value);
	} catch {
		// private mode: chosen again next time
	}
}

export function wantedAgents(ownerId: string): string[] {
	try {
		const v = JSON.parse(stored(wantedKey(ownerId)) ?? "[]") as unknown;
		return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
	} catch {
		return [];
	}
}

export function setWanted(ownerId: string, agentId: string, on: boolean): void {
	const rest = wantedAgents(ownerId).filter((id) => id !== agentId);
	store(wantedKey(ownerId), JSON.stringify(on ? [...rest, agentId] : rest));
}

/** The AI of earlier versions, just moved under its owner, comes in as it did. */
export function carryOverWanted(ownerId: string, agentId: string): void {
	if (stored(LEGACY_ON_KEY) === "1") setWanted(ownerId, agentId, true);
}

export const selectedAgent = (ownerId: string) => stored(selectedKey(ownerId));
export const keepSelected = (ownerId: string, agentId: string) => store(selectedKey(ownerId), agentId);
