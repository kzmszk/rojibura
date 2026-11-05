import type { Activity, Doing, LifeState } from "@rojibura/protocol";
import { expect, test } from "vitest";
import { activityBadge, showLifeMessage } from "./city-life.ts";

const doing: Doing = { activity: "run", since: 1, until: 2 };
const activity: Activity = {
	id: "run",
	kind: "exercise",
	name: "走る",
	emoji: "🏃",
	place: "park",
	minutes: 5,
	effects: {},
};
const life: LifeState = {
	days: 2,
	block: 0,
	energy: 90,
	fitness: 31,
	mood: 52,
	skills: { work: 1.4 },
	duties: { meals: 1, work: true, exercise: false },
	exercisedDay: 0,
	slack: 0,
	at: 0,
};

function setup() {
	const events: unknown[] = [];
	const state: { doing?: Doing } = {};
	const view = {
		state,
		setDoing: (badge: unknown) => events.push(["avatar", badge, state.doing]),
		setJob: (job: unknown) => events.push(["job", job]),
	};
	const deps = {
		avatars: new Map([["me", view]]),
		activities: [activity],
		myId: "me",
		statusHud: {
			doing: (id: string, badge: unknown) => events.push(["hud doing", id, badge]),
			ai: (id: string, data: unknown) => events.push(["hud ai", id, data]),
		},
		agentPanel: { life: (id: string, text: string) => events.push(["panel", id, text]) },
		showToast: (text: string) => events.push(["toast", text]),
		invalidateActivities: () => events.push(["invalidate"]),
	};
	return { events, state, deps };
}

test("self job still announces when the avatar is absent", () => {
	const { events, deps } = setup();
	deps.avatars.clear();
	showLifeMessage({ t: "JOBBED", id: "me", job: "work" }, deps);
	expect(events).toEqual([["toast", "働きはじめました（1分で1銅貨）。歩いて出ると終わります"]]);
});

test("acting changes state before avatar, HUD, and invalidation, but ignores missing avatars", () => {
	const { events, state, deps } = setup();
	const badge = { emoji: "🏃", name: "走る", exercise: true };
	showLifeMessage({ t: "ACTING", id: "missing", doing }, deps);
	expect(events).toEqual([]);
	showLifeMessage({ t: "ACTING", id: "me", doing }, deps);
	showLifeMessage({ t: "ACTING", id: "me", doing: null }, deps);
	expect(events).toEqual([
		["avatar", badge, doing],
		["hud doing", "me", badge],
		["invalidate"],
		["avatar", null, undefined],
		["hud doing", "me", null],
		["invalidate"],
	]);
	expect(state).not.toHaveProperty("doing");
});

test("completion uses the threshold and formats unknown activities and deltas", () => {
	const { events, deps } = setup();
	showLifeMessage({ t: "ACT_DONE", activity: "run", share: 0.999, delta: { energy: -2 } }, deps);
	showLifeMessage({ t: "ACT_DONE", activity: "run", share: 0.9989 }, deps);
	showLifeMessage({ t: "ACT_DONE", activity: "other", name: "お茶", share: 1, delta: { coins: 3 } }, deps);
	showLifeMessage({ t: "ACT_DONE", activity: "unknown", share: 1 }, deps);
	expect(events).toEqual([
		["toast", "🏃 走るを終えました（エネルギー −2）"],
		["toast", "🏃 走るをやめました"],
		["toast", "お茶（銅貨 +3）"],
		["toast", "unknown"],
	]);
});

test("life updates the panel before HUD and distinguishes zero coins from absent coins", () => {
	const { events, state, deps } = setup();
	state.doing = doing;
	showLifeMessage({ t: "LIFE", id: "me", life, coins: 0 }, deps);
	showLifeMessage({ t: "LIFE", id: "me", life }, deps);
	const text = "暮らして2日目\nエネルギー 90（おなかいっぱい）・体力 31・こころ 52";
	const end = "\n今日：ごはん 1/2・仕事か勉強 ✓・運動 まだ\n腕前：仕事 1\nいま：🏃 走る";
	const badge = { emoji: "🏃", name: "走る", exercise: true };
	expect(events).toEqual([
		["panel", "me", `${text}・👛 0 銅貨${end}`],
		["hud ai", "me", { life, coins: 0, doing: badge }],
		["panel", "me", text + end],
		["hud ai", "me", { life, doing: badge }],
	]);
});

test("current activities determine both shared badges and message output", () => {
	const { events, deps } = setup();
	deps.activities = [];
	expect(activityBadge(doing, deps.activities)).toEqual({ emoji: "⏳", name: "run", exercise: false });
	showLifeMessage({ t: "ACTING", id: "me", doing }, deps);
	deps.activities = [activity];
	expect(activityBadge(doing, deps.activities)).toEqual({ emoji: "🏃", name: "走る", exercise: true });
	showLifeMessage({ t: "ACTING", id: "me", doing }, deps);
	expect(events[0]).toEqual(["avatar", { emoji: "⏳", name: "run", exercise: false }, doing]);
	expect(events[3]).toEqual(["avatar", { emoji: "🏃", name: "走る", exercise: true }, doing]);
});
