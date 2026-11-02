import { describe, expect, test } from "vitest";
import {
	type Activity,
	activityOpen,
	CITY_DAY_MS,
	cannotStart,
	canRun,
	cityTime,
	clockText,
	decay,
	deltaText,
	finishActivity,
	MORNING_ENERGY,
	newDay,
	newLife,
	realMs,
} from "./life.ts";

/** JST 20:00 on 2026-11-02, the opening. */
const OPENING = Date.UTC(2026, 10, 2, 11);
const meal: Activity = {
	id: "meal",
	kind: "eat",
	name: "食事",
	place: "cafe",
	minutes: 30,
	hours: "06-10,11-14",
	cost: 15,
	effects: { energy: 35 },
	emoji: "🍽️",
};
const work: Activity = {
	id: "work",
	kind: "work",
	name: "仕事",
	place: "cafe",
	minutes: 120,
	pay: 40,
	effects: { energy: -10 },
	skill: { id: "cooking", gain: 4 },
	emoji: "🍳",
};

describe("the city's clock", () => {
	test("the opening hours are one city day, from 06:00 to midnight", () => {
		const open = cityTime(OPENING);
		expect(open.minutes).toBe(360);
		expect(open.night).toBe(false);
		// ten real minutes before closing is the night
		const late = cityTime(OPENING + CITY_DAY_MS - 10 * 60_000);
		expect(clockText(late.minutes)).toBe("23:15");
		expect(late.night).toBe(true);
		expect(cityTime(OPENING + CITY_DAY_MS - 11 * 60_000).night).toBe(false);
		// the next block starts a new day
		const next = cityTime(OPENING + CITY_DAY_MS);
		expect(next.block).toBe(open.block + 1);
		expect(next.minutes).toBe(360);
	});

	test("a city hour is 13⅓ real minutes", () => {
		expect(realMs(60)).toBeCloseTo((60 / 4.5) * 60_000);
		expect(clockText(cityTime(OPENING + realMs(90)).minutes)).toBe("07:30");
	});

	test("opening hours of an activity", () => {
		expect(activityOpen(meal, 7 * 60)).toBe(true);
		expect(activityOpen(meal, 10 * 60)).toBe(false);
		expect(activityOpen(meal, 13 * 60 + 59)).toBe(true);
		expect(activityOpen(work, 23 * 60)).toBe(true);
	});
});

describe("the meters", () => {
	test("energy goes down with time in the city, less for a fit body", () => {
		const life = newLife(OPENING);
		const after = decay(life, OPENING + realMs(600));
		expect(after.energy).toBe(MORNING_ENERGY - 40);
		const fit = decay({ ...life, fitness: 100 }, OPENING + realMs(600));
		expect(fit.energy).toBe(MORNING_ENERGY - 30);
		expect(decay(life, OPENING + realMs(60 * 30)).energy).toBe(0);
	});

	test("an activity done gives its effects and counts for the day; half done, half", () => {
		const life = { ...newLife(OPENING), energy: 40 };
		const done = finishActivity(life, meal, 1);
		expect(done.life.energy).toBe(75);
		expect(done.life.duties.meals).toBe(1);
		expect(done.delta).toEqual({ energy: 35 });
		// full is full: the delta says what it really gave
		expect(finishActivity({ ...life, energy: 90 }, meal, 1).delta).toEqual({ energy: 10 });
		const half = finishActivity(life, work, 0.5);
		expect(half.life.coins).toBe(life.coins + 20);
		expect(half.life.skills.cooking).toBe(2);
		expect(half.life.duties.work).toBe(true);
		const little = finishActivity(life, work, 0.2);
		expect(little.life.duties.work).toBe(false);
		expect(deltaText(half.delta)).toBe("エネルギー −5、コイン +20");
	});

	test("what stops one from starting", () => {
		const life = newLife(OPENING);
		expect(cannotStart({ ...life, coins: 10 }, meal)).toMatch(/コイン/);
		expect(cannotStart({ ...life, energy: 10 }, work)).toMatch(/食べて/);
		expect(cannotStart({ ...life, energy: 0 }, meal)).toBeNull();
		expect(canRun({ ...life, energy: 10 })).toBe(false);
		expect(canRun({ ...life, fitness: 20 })).toBe(false);
		expect(canRun(life)).toBe(true);
	});

	test("a new morning scores the day: what was left undone costs energy and mood", () => {
		const life = { ...newLife(OPENING), days: 3, exercisedDay: 1 };
		const lazy = newDay(life, OPENING + CITY_DAY_MS);
		expect(lazy.review.missed).toEqual(["ごはん（0/2回）", "仕事か勉強", "運動（2日に1回）"]);
		expect(lazy.life.days).toBe(4);
		expect(lazy.life.energy).toBe(MORNING_ENERGY - 30);
		expect(lazy.life.mood).toBe(life.mood - 15);
		expect(lazy.life.fitness).toBe(life.fitness - 2);
		expect(lazy.life.duties).toEqual({ meals: 0, work: false, exercise: false });
		const good = newDay(
			{ ...life, duties: { meals: 2, work: true, exercise: true }, exercisedDay: 3 },
			OPENING + CITY_DAY_MS,
		);
		expect(good.review.missed).toEqual([]);
		expect(good.life.energy).toBe(MORNING_ENERGY);
		expect(good.life.slack).toBe(0);
	});

	test("three slack days in a row cost fitness", () => {
		let life = { ...newLife(OPENING), duties: { meals: 2, work: false, exercise: true } };
		for (let i = 0; i < 2; i++) life = { ...newDay(life, OPENING).life, duties: life.duties };
		const third = newDay(life, OPENING).life;
		expect(third.fitness).toBe(life.fitness - 5);
		expect(third.slack).toBe(0);
	});
});
