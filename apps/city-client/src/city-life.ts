import {
	type Activity,
	type AvatarId,
	type Doing,
	deltaText,
	energyWord,
	type HostToClient,
	type LifeState,
	MEALS_PER_DAY,
	SKILL_NAMES,
} from "@rojibura/protocol";
import type { AgentPanel } from "./agent-panel.ts";
import type { AvatarView } from "./avatars.ts";
import type { StatusHud } from "./status-hud.ts";

type LifeMessage = Extract<HostToClient, { t: "JOBBED" | "ACTING" | "ACT_DONE" | "LIFE" }>;
type LifeView = Pick<AvatarView, "setDoing" | "setJob"> & { state: Pick<AvatarView["state"], "doing"> };
type LifeDependencies = {
	avatars: ReadonlyMap<AvatarId, LifeView>;
	activities: readonly Activity[];
	myId: AvatarId | null;
	statusHud: Pick<StatusHud, "doing" | "ai">;
	agentPanel: Pick<AgentPanel, "life">;
	showToast: (text: string) => void;
	invalidateActivities: () => void;
};

export function activityBadge(doing: Doing | null | undefined, activities: readonly Activity[]) {
	if (!doing) return null;
	const a = activities.find((x) => x.id === doing.activity);
	return { emoji: a?.emoji ?? "⏳", name: a?.name ?? doing.activity, exercise: a?.kind === "exercise" };
}

function lifeText(
	life: LifeState,
	doing: Doing | undefined,
	coins: number | undefined,
	activities: readonly Activity[],
) {
	const skills = Object.entries(life.skills)
		.filter(([, v]) => v > 0)
		.map(([k, v]) => `${SKILL_NAMES[k] ?? k} ${Math.round(v)}`)
		.join("・");
	const badge = activityBadge(doing, activities);
	return [
		`暮らして${life.days}日目`,
		`エネルギー ${Math.round(life.energy)}（${energyWord(life.energy)}）・体力 ${Math.round(life.fitness)}・こころ ${Math.round(life.mood)}${coins !== undefined ? `・👛 ${coins} 銅貨` : ""}`,
		`今日：ごはん ${life.duties.meals}/${MEALS_PER_DAY}・仕事か勉強 ${life.duties.work ? "✓" : "まだ"}・運動 ${life.duties.exercise ? "✓" : "まだ"}`,
		...(skills ? [`腕前：${skills}`] : []),
		...(badge ? [`いま：${badge.emoji} ${badge.name}`] : []),
	].join("\n");
}

export function showLifeMessage(
	m: LifeMessage,
	{ avatars, activities, myId, statusHud, agentPanel, showToast, invalidateActivities }: LifeDependencies,
): void {
	switch (m.t) {
		case "JOBBED":
			avatars.get(m.id)?.setJob(m.job);
			if (m.id === myId)
				showToast(
					m.job === "work"
						? "働きはじめました（1分で1銅貨）。歩いて出ると終わります"
						: m.job === "study"
							? "勉強をはじめました（1分で1銅貨）。歩いて出ると終わります"
							: "おつかれさまでした",
				);
			break;
		case "ACTING": {
			const v = avatars.get(m.id);
			if (!v) break;
			if (m.doing) v.state.doing = m.doing;
			else delete v.state.doing;
			v.setDoing(activityBadge(m.doing, activities));
			statusHud.doing(m.id, activityBadge(m.doing, activities));
			invalidateActivities();
			break;
		}
		case "ACT_DONE": {
			const a = activities.find((x) => x.id === m.activity);
			const change = m.delta ? deltaText(m.delta) : "";
			showToast(
				a
					? `${a.emoji} ${a.name}を${m.share >= 0.999 ? "終えました" : "やめました"}${change ? `（${change}）` : ""}`
					: `${m.name ?? m.activity}${change ? `（${change}）` : ""}`,
			);
			break;
		}
		case "LIFE": {
			const doing = avatars.get(m.id)?.state.doing;
			agentPanel.life(m.id, lifeText(m.life, doing, m.coins, activities));
			statusHud.ai(m.id, {
				life: m.life,
				...(m.coins !== undefined ? { coins: m.coins } : {}),
				doing: activityBadge(doing, activities),
			});
			break;
		}
	}
}
