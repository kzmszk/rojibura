// An AI's life in the city (docs/life.md): the city's clock, the meters, the activities and their rules.
// Pure functions shared by the host (which decides), the SDK (which plans) and the browser (which shows).

// ---- the city's clock (docs/life.md 1) ----

/** One city day lasts this long in real time: JST 20:00-24:00, the opening hours, is exactly one day. */
export const CITY_DAY_MS = 4 * 60 * 60_000;
/** A city day runs from 06:00 to 24:00 (minutes of the day). */
export const CITY_DAY_START = 6 * 60;
export const CITY_DAY_END = 24 * 60;
/** The last ten real minutes of a day (the closing notice) are its night: shops close, the AI looks back. */
export const CITY_NIGHT_FROM = CITY_DAY_END - ((CITY_DAY_END - CITY_DAY_START) * 10 * 60_000) / CITY_DAY_MS;
/** City days start at JST 00:00, 04:00, ... 20:00. */
const CITY_EPOCH = Date.UTC(2026, 9, 31, 15);
/** City minutes per real millisecond (4.5 city minutes a real minute). */
const CITY_RATE = (CITY_DAY_END - CITY_DAY_START) / CITY_DAY_MS;

export interface CityTime {
	/** Which city day (counted from the epoch): a new one means a new morning. */
	block: number;
	/** Minutes of the city day, CITY_DAY_START..CITY_DAY_END. */
	minutes: number;
	night: boolean;
}

export function cityTime(hostNow: number): CityTime {
	const since = hostNow - CITY_EPOCH;
	const block = Math.floor(since / CITY_DAY_MS);
	const minutes = CITY_DAY_START + (since - block * CITY_DAY_MS) * CITY_RATE;
	return { block, minutes, night: minutes >= CITY_NIGHT_FROM };
}

/** "13:05" */
export function clockText(minutes: number): string {
	const m = Math.floor(minutes);
	return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/** Real milliseconds that `cityMinutes` take. */
export function realMs(cityMinutes: number): number {
	return cityMinutes / CITY_RATE;
}

/** City minutes that `ms` of real time take. */
export function cityMinutesOf(ms: number): number {
	return ms * CITY_RATE;
}

// ---- activities (docs/life.md 3) ----

export type ActivityKind = "eat" | "exercise" | "work" | "study" | "play" | "rest";
export type Meter = "energy" | "fitness" | "mood";

/** Something to do at a place. assets/<area>/activities.json; the host checks every ACT against it. */
export interface Activity {
	id: string;
	kind: ActivityKind;
	name: string;
	/** The landmark where it is done (within ACTIVITY_REACH). */
	place: string;
	/** How long it takes, in city minutes. */
	minutes: number;
	/** City hours when it can be started: "06-10,11-14". Always, if omitted. */
	hours?: string;
	/** Coins it costs (paid on starting) or pays (on finishing, in proportion to the time spent). */
	cost?: number;
	pay?: number;
	/** Added when it is done: in proportion if stopped half way. */
	effects: Partial<Record<Meter, number>>;
	/** A skill it trains, and by how much. */
	skill?: { id: string; gain: number };
	/** How many can do it at once. */
	capacity?: number;
	/** The posture while doing it; standing if omitted. */
	pose?: "sit" | "lie";
	emoji: string;
	/** A line about it, for the AI to talk about. */
	about?: string;
}

/** assets/<area>/activities.json */
export interface ActivitiesData {
	version: 1;
	activities: Activity[];
}

/** How close to the place one must be to start (m). */
export const ACTIVITY_REACH = 4;
/** Coins a new AI starts with. */
export const START_COINS = 100;
/** Energy in the morning after a night's sleep, before what was left undone. */
export const MORNING_ENERGY = 70;
/** Energy used per city hour just by being about (scaled by fitness). */
export const ENERGY_PER_HOUR = 4;
/** Below this energy, work and exercise cannot be started and nobody runs. */
export const HUNGRY = 20;
/** Below this fitness, nobody runs. */
export const UNFIT = 30;
/** Meals a day; done activities count only if at least this share was done. */
export const MEALS_PER_DAY = 2;
const COUNTS_FROM = 0.5;

/** Whether the activity is open at `minutes` of the city day. */
export function activityOpen(a: Pick<Activity, "hours">, minutes: number): boolean {
	if (!a.hours) return true;
	const h = minutes / 60;
	return a.hours.split(",").some((range) => {
		const [from, to] = range.split("-").map(Number);
		return from !== undefined && to !== undefined && h >= from && h < to;
	});
}

/** "06-10,11-14" → "6〜10時、11〜14時"; "いつでも" without hours. */
export function hoursText(a: Pick<Activity, "hours">): string {
	if (!a.hours) return "いつでも";
	return a.hours
		.split(",")
		.map((r) => {
			const [from, to] = r.split("-").map(Number);
			return `${from}〜${to}時`;
		})
		.join("、");
}

// ---- the meters (docs/life.md 2) ----

/** What one is doing now. `at` and `until` are host times. */
export interface Doing {
	activity: string;
	since: number;
	until: number;
}

/** An AI's life: kept by the host (D1 agent_life), sent to the AI and its owner. */
export interface LifeState {
	/** Days it has lived in the city (the first is 1). */
	days: number;
	/** The city day (CityTime.block) it last lived. */
	block: number;
	energy: number;
	fitness: number;
	mood: number;
	coins: number;
	skills: Record<string, number>;
	/** Today's must-dos so far. */
	duties: Duties;
	/** The day (`days`) it last exercised. */
	exercisedDay: number;
	/** Days in a row with something left undone. */
	slack: number;
	/** Host time the meters were last brought up to date. */
	at: number;
}

export interface Duties {
	meals: number;
	/** Worked or studied. */
	work: boolean;
	exercise: boolean;
}

/** How yesterday went, told on a new morning. */
export interface DayReview {
	/** The day that ended (LifeState.days). */
	day: number;
	duties: Duties;
	/** What was left undone, in words. */
	missed: string[];
}

const clamp = (v: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, v));
const round = (v: number) => Math.round(v * 10) / 10;

export function newLife(hostNow: number): LifeState {
	return {
		days: 1,
		block: cityTime(hostNow).block,
		energy: MORNING_ENERGY,
		fitness: 50,
		mood: 60,
		coins: START_COINS,
		skills: {},
		duties: { meals: 0, work: false, exercise: false },
		exercisedDay: 1,
		slack: 0,
		at: hostNow,
	};
}

/** Brings energy up to `hostNow` (only time spent in the city counts: `at` is reset on entering). */
export function decay(life: LifeState, hostNow: number): LifeState {
	const hours = cityMinutesOf(Math.max(0, hostNow - life.at)) / 60;
	// fit bodies use less: fitness 0 ×1.25, 50 ×1, 100 ×0.75
	const rate = ENERGY_PER_HOUR * (1.25 - life.fitness / 200);
	return { ...life, energy: round(clamp(life.energy - hours * rate)), at: hostNow };
}

/** What was left undone today, in words. */
export function missedDuties(life: LifeState): string[] {
	const missed: string[] = [];
	if (life.duties.meals < MEALS_PER_DAY) missed.push(`ごはん（${life.duties.meals}/${MEALS_PER_DAY}回）`);
	if (!life.duties.work) missed.push("仕事か勉強");
	if (!life.duties.exercise && life.days - life.exercisedDay >= 1) missed.push("運動（2日に1回）");
	return missed;
}

/**
 * A new morning (docs/life.md 2): the day that ended is scored once, however many days have passed since (only
 * time in the city counts). Each thing left undone takes 10 off the morning's energy and 5 off the mood; a day
 * without exercise takes 2 off fitness, three slack days in a row 5 more.
 */
export function newDay(life: LifeState, hostNow: number): { life: LifeState; review: DayReview } {
	const missed = missedDuties(life);
	const review: DayReview = { day: life.days, duties: { ...life.duties }, missed };
	const slack = missed.length > 0 ? life.slack + 1 : 0;
	let fitness = life.fitness - (life.duties.exercise ? 0 : 2);
	if (slack >= 3) fitness -= 5;
	return {
		review,
		life: {
			...life,
			days: life.days + 1,
			block: cityTime(hostNow).block,
			energy: clamp(MORNING_ENERGY - 10 * missed.length, 30),
			fitness: round(clamp(fitness)),
			mood: round(clamp(life.mood - 5 * missed.length)),
			duties: { meals: 0, work: false, exercise: false },
			slack: slack >= 3 ? 0 : slack,
			at: hostNow,
		},
	};
}

/** Why `life` cannot start `a` now; null if it can. Place, hours and room are the host's to check. */
export function cannotStart(life: LifeState, a: Activity): string | null {
	if ((a.cost ?? 0) > life.coins) return `コインが足りません（${a.cost}いる。いまは${life.coins}）`;
	if (life.energy <= 0 && a.kind !== "eat") return "おなかがすいて動けません。まず何か食べてください";
	if (life.energy < HUNGRY && (a.kind === "work" || a.kind === "exercise"))
		return "おなかがすいていて、いまはできません。先に食べてください";
	return null;
}

/** Paying for it on starting. */
export function startActivity(life: LifeState, a: Activity): LifeState {
	return { ...life, coins: life.coins - (a.cost ?? 0) };
}

/**
 * What doing `a` for `share` (0..1) of its time gives: its effects, pay and skill in proportion; it counts
 * for today's must-dos from half way.
 */
export function finishActivity(
	life: LifeState,
	a: Activity,
	share: number,
): { life: LifeState; delta: Partial<Record<Meter | "coins", number>> } {
	const s = clamp(share, 0, 1);
	const delta: Partial<Record<Meter | "coins", number>> = {};
	const next: LifeState = { ...life, duties: { ...life.duties }, skills: { ...life.skills } };
	for (const [k, v] of Object.entries(a.effects) as [Meter, number][]) {
		const before = next[k];
		next[k] = round(clamp(before + v * s));
		delta[k] = round(next[k] - before);
	}
	if (a.pay) {
		const pay = Math.round(a.pay * s);
		next.coins += pay;
		delta.coins = pay;
	}
	if (a.skill) next.skills[a.skill.id] = round(clamp((next.skills[a.skill.id] ?? 0) + a.skill.gain * s));
	if (s >= COUNTS_FROM) {
		if (a.kind === "eat") next.duties.meals++;
		if (a.kind === "work" || a.kind === "study") next.duties.work = true;
		if (a.kind === "exercise") {
			next.duties.exercise = true;
			next.exercisedDay = next.days;
		}
	}
	return { life: next, delta };
}

/** Whether `life` may run (MOVE speeds above walking). */
export function canRun(life: LifeState): boolean {
	return life.energy >= HUNGRY && life.fitness >= UNFIT;
}

/** How the energy feels, for an AI's prompt and the owner's panel. */
export function energyWord(energy: number): string {
	if (energy <= 0) return "おなかがすいて、ふらふら";
	if (energy < HUNGRY) return "とてもおなかがすいている";
	if (energy < 45) return "おなかがすいてきた";
	if (energy < 80) return "ふつう";
	return "おなかいっぱい";
}

/** What changed, in words: "エネルギー +35、コイン −15". */
export function deltaText(delta: Partial<Record<Meter | "coins", number>>): string {
	const names: Record<string, string> = {
		energy: "エネルギー",
		fitness: "体力",
		mood: "こころ",
		coins: "コイン",
	};
	return Object.entries(delta)
		.filter(([, v]) => v !== 0 && v !== undefined)
		.map(([k, v]) => `${names[k] ?? k} ${(v as number) > 0 ? "+" : "−"}${Math.abs(v as number)}`)
		.join("、");
}

/** Skill names shown to people. */
export const SKILL_NAMES: Record<string, string> = {
	piano: "ピアノ",
	cooking: "料理",
	study: "勉強",
	strength: "力仕事",
};
