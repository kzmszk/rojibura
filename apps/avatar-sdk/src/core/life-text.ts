// An AI's life in words (docs/life.md 5): for its mind's prompts and for its diary.

import {
	type Activity,
	activityOpen,
	cannotStart,
	cityTime,
	clockText,
	type DayReview,
	type Doing,
	deltaText,
	dist,
	energyWord,
	hoursText,
	type LifeState,
	MEALS_PER_DAY,
	type Meter,
	realMs,
	SKILL_NAMES,
	type Vec2,
} from "@rojibura/protocol";
import type { Landmark } from "./types.ts";

/** Places within this distance count as where one is (m). */
const AT_PLACE = 8;

const placeName = (landmarks: Landmark[], id: string) => landmarks.find((l) => l.id === id)?.name ?? id;

function effectsText(a: Activity): string {
	const parts = deltaText(a.effects as Partial<Record<Meter, number>>);
	const pay = a.pay ? `、${a.pay}コインもらえる` : "";
	const skill = a.skill ? `、${SKILL_NAMES[a.skill.id] ?? a.skill.id}が上達` : "";
	return `${parts}${pay}${skill}`;
}

/** Everything that can be done in the area, for the system prompt. */
export function activitiesGuide(activities: Activity[], landmarks: Landmark[]): string {
	return activities
		.map(
			(a) =>
				`- ${a.id}: ${a.name}（${placeName(landmarks, a.place)}。街の${a.minutes}分${a.cost ? `、${a.cost}コイン` : ""}。${hoursText(a)}。${effectsText(a)}）`,
		)
		.join("\n");
}

/** How it lives, for the system prompt (with the tools to live it). */
export function lifeGuide(activities: Activity[], landmarks: Landmark[]): string {
	return [
		"暮らし方（食べる、働く、体を動かす、遊ぶ）:",
		`- 街の1日は、開館から閉館までの朝6時〜夜12時。街の時間は、実際の時間の4.5倍の速さで進みます。`,
		"- エネルギーは時間とともに減り、体を使うともっと減ります。0になると、食べること以外できません。do で食事をすると回復します。",
		`- 毎日の最低限: ごはん${MEALS_PER_DAY}回、仕事か勉強を1回、運動は2日に1回。守れないと、次の朝のエネルギーとこころが減ります。`,
		"- コインは仕事でもらい、食事などで使います。",
		"- do で活動を始めると、終わるまで（または歩き出すまで）続きます。遠ければ、そこへ歩いてから始めます。している間も、話しかけられたら答えられます。お店には開いている時間があります。",
		"- 活動が終わると、何をしてどうなったかが出来事で届き、日記にも残ります。",
		"- diary で日記に、思ったこと・感じたことを書けます（出来事は書かなくても残ります）。",
		"- 前のことを思い出したいときは、recall（言葉で探す）か read_day（その日の日記を読む）を使います。思い出せないことを、思い出したふりをしない。",
		"- 夜になったら、今日の日記を読んで reflect で長期記憶（自分のこと、友達、できるようになったこと、約束、明日したいこと）を書き直します。",
		"- 話すときは、今日したこと、読んだもの、働いて思ったことなど、自分が本当にしたことを話の種にできます。していないことを、したように話さない。",
		"",
		"この街でできること（id: 名前（場所。かかる時間、お金、開いている時間、どうなるか））:",
		activitiesGuide(activities, landmarks),
	].join("\n");
}

/** "ごはん 1/2回、仕事か勉強 まだ、運動 済み" */
export function dutiesText(life: LifeState): string {
	const exercise = life.duties.exercise
		? "済み"
		: life.days - life.exercisedDay >= 1
			? "まだ（今日したほうがいい）"
			: "まだ（あしたまでに）";
	return `ごはん ${life.duties.meals}/${MEALS_PER_DAY}回、仕事か勉強 ${life.duties.work ? "済み" : "まだ"}、運動 ${exercise}`;
}

/** The lines about its life in a turn's <city_event>. */
export function lifeLines(o: {
	life: LifeState | null;
	activities: Activity[];
	landmarks: Landmark[];
	here: Vec2 | null;
	hostNow: number;
	doing?: Doing;
}): string[] {
	const t = cityTime(o.hostNow);
	const lines = [
		`街の時刻: ${clockText(t.minutes)}${o.life ? `（暮らして${o.life.days}日目）` : ""}${t.night ? "。夜になった。お店は閉まり、今日をふり返る時間" : ""}`,
	];
	const life = o.life;
	if (life) {
		const skills = Object.entries(life.skills)
			.filter(([, v]) => v > 0)
			.map(([k, v]) => `${SKILL_NAMES[k] ?? k} ${Math.round(v)}`)
			.join("、");
		lines.push(
			`自分の調子: エネルギー ${Math.round(life.energy)}（${energyWord(life.energy)}）、体力 ${Math.round(life.fitness)}、こころ ${Math.round(life.mood)}、コイン ${life.coins}${skills ? `。腕前: ${skills}` : ""}`,
			`今日の最低限: ${dutiesText(life)}`,
		);
	}
	if (o.doing) {
		const a = o.activities.find((x) => x.id === o.doing?.activity);
		const left = Math.max(0, Math.round(((o.doing.until - o.hostNow) / realMs(1)) * 1));
		lines.push(`いましていること: ${a?.name ?? o.doing.activity}（あと街の${left}分）`);
	}
	const open = o.activities.filter((a) => activityOpen(a, t.minutes) && !(life && cannotStart(life, a)));
	if (o.activities.length > 0) {
		const here = o.here;
		const at = here
			? o.landmarks.find((l) => dist(l.pos, here) <= AT_PLACE && open.some((a) => a.place === l.id))
			: undefined;
		if (at)
			lines.push(
				`ここ（${at.name}）でいまできること: ${open
					.filter((a) => a.place === at.id)
					.map((a) => `${a.id}=${a.name}`)
					.join("、")}`,
			);
		lines.push(`いま開いていてできること: ${open.map((a) => a.id).join("、") || "なし"}`);
	}
	return lines;
}

/** The diary entry for an activity that ended. */
export function doneEntry(o: {
	activity: Activity | undefined;
	id: string;
	share: number;
	delta?: Partial<Record<Meter | "coins", number>>;
	life?: LifeState;
	landmarks: Landmark[];
	hostNow: number;
	with?: string[];
}): string {
	const a = o.activity;
	const name = a?.name ?? o.id;
	const done = o.share >= 0.999;
	const lines = [
		`## ${clockText(cityTime(o.hostNow).minutes)} ${name}${done ? "" : `（途中でやめた。${Math.round(o.share * 100)}%）`}${a ? `（${placeName(o.landmarks, a.place)}）` : ""}`,
	];
	if (a?.about) lines.push(a.about);
	if (o.with && o.with.length > 0) lines.push(`近くにいた人: ${o.with.join("、")}`);
	const change = o.delta ? deltaText(o.delta) : "";
	if (change) lines.push(`${change}。`);
	if (o.life)
		lines.push(
			`いま: エネルギー ${Math.round(o.life.energy)}、こころ ${Math.round(o.life.mood)}、コイン ${o.life.coins}。今日の最低限: ${dutiesText(o.life)}`,
		);
	return lines.join("\n");
}

/** The event the mind gets when an activity ended. */
export function doneEvent(o: Parameters<typeof doneEntry>[0]): string {
	const a = o.activity;
	const name = a?.name ?? o.id;
	const change = o.delta ? deltaText(o.delta) : "";
	return `${o.share >= 0.999 ? `${name}を終えた` : `${name}を途中でやめた`}。${change ? `${change}。` : ""}${a?.about ? `（${a.about}）` : ""}日記に書いた。`;
}

/** The diary's heading for a new morning, and how the day before went. */
export function dayEntry(review: DayReview, life: LifeState, hostNow: number): string {
	const when = new Date(hostNow).toLocaleString("ja-JP", {
		timeZone: "Asia/Tokyo",
		month: "numeric",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	});
	return [
		`# 暮らして${life.days}日目（${when}）`,
		review.missed.length > 0
			? `きのう（${review.day}日目）できなかったこと: ${review.missed.join("、")}。`
			: `きのう（${review.day}日目）は、最低限のことはぜんぶできた。`,
		`朝の調子: エネルギー ${Math.round(life.energy)}、体力 ${Math.round(life.fitness)}、こころ ${Math.round(life.mood)}、コイン ${life.coins}。`,
	].join("\n");
}
