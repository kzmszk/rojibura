import { beforeEach, describe, expect, test, vi } from "vitest";
import {
	type AgentPresence,
	type AiFacts,
	carryOverWanted,
	closeMessage,
	describeAi,
	setWanted,
	staysOutAfter,
	wantedAgents,
} from "./agent-roster.ts";

const presence = (p: Partial<AgentPresence> = {}): AgentPresence => ({
	id: "a_1",
	paired: false,
	pairedAt: null,
	area: null,
	runsOn: null,
	banned: false,
	...p,
});
const facts = (f: Partial<AiFacts> = {}): AiFacts => ({
	agent: { id: "a_1", name: "ハル", runtime: "browser", trust: "approved" },
	presence: presence(),
	hasKey: true,
	run: "idle",
	...f,
});

describe("what the panel says of an AI", () => {
	test("with its key here and nowhere in the city, it can be started", () => {
		expect(describeAi(facts())).toMatchObject({
			state: "街にいません",
			canStart: true,
			blocked: null,
			running: false,
			elsewhere: false,
		});
	});

	test("running in this tab is told apart from running elsewhere, whatever the host says", () => {
		const here = describeAi(
			facts({ run: "running", presence: presence({ area: "main", runsOn: "browser" }) }),
		);
		expect(here).toMatchObject({ running: true, elsewhere: false, canStart: false });
		expect(here.state).toContain("このタブ");
	});

	test("on the PC: shown as such, and taking it over is offered only with the key here", () => {
		const onPc = presence({ area: "main", runsOn: "pc", paired: true });
		const withKey = describeAi(facts({ presence: onPc }));
		expect(withKey.state).toContain("PCで動いています");
		expect(withKey).toMatchObject({ elsewhere: true, canStart: true });
		const noKey = describeAi(facts({ presence: onPc, hasKey: false }));
		expect(noKey.state).toContain("PCで動いています");
		expect(noKey.canStart).toBe(false);
		expect(noKey.place).toContain("PCで動かす");
	});

	test("listed without a key: it cannot be started from here, and the panel says why", () => {
		const view = describeAi(facts({ hasKey: false }));
		expect(view.canStart).toBe(false);
		expect(view.blocked).toContain("鍵がない");
		expect(view.place).toContain("登録した端末");
	});

	test("suspended or banned: not offered, even with the key", () => {
		const suspended = facts({ agent: { id: "a_1", name: "ハル", runtime: "browser", trust: "suspended" } });
		expect(describeAi(suspended)).toMatchObject({ canStart: false, trust: "利用停止" });
		expect(describeAi(facts({ presence: presence({ banned: true }) })).canStart).toBe(false);
	});
});

describe("why the host closed it", () => {
	test("the host's own words come first", () => {
		expect(closeMessage(4001, "full", "仮承認のAIはオーナーごとに1体までです")).toBe(
			"仮承認のAIはオーナーごとに1体までです",
		);
		expect(closeMessage(4001, "full", null)).toContain("上限");
		expect(closeMessage(4010, "閉館しました", null)).toBe("閉館しました");
	});

	test("full or closed, it may come in next time; kicked or refused, not by itself", () => {
		expect(staysOutAfter(4001)).toBe(false);
		expect(staysOutAfter(4010)).toBe(false);
		expect(staysOutAfter(4003)).toBe(true);
		expect(staysOutAfter(1008)).toBe(true);
	});
});

describe("which AIs come in with the owner", () => {
	beforeEach(() => {
		const kept = new Map<string, string>();
		vi.stubGlobal("localStorage", {
			getItem: (k: string) => kept.get(k) ?? null,
			setItem: (k: string, v: string) => void kept.set(k, v),
		});
	});

	test("each AI on its own, each owner on their own", () => {
		setWanted("h_a", "a_1", true);
		setWanted("h_a", "a_2", true);
		setWanted("h_b", "a_3", true);
		setWanted("h_a", "a_1", false);
		expect(wantedAgents("h_a")).toEqual(["a_2"]);
		expect(wantedAgents("h_b")).toEqual(["a_3"]);
	});

	test("the AI of earlier versions keeps coming in only if it did", () => {
		carryOverWanted("h_a", "a_old");
		expect(wantedAgents("h_a")).toEqual([]);
		localStorage.setItem("rj.agent.on", "1");
		carryOverWanted("h_a", "a_old");
		expect(wantedAgents("h_a")).toEqual(["a_old"]);
	});
});
