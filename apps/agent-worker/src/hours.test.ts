import { expect, test } from "vitest";
import { fetchCityHours, wakeTime } from "./hours.ts";

test("asks the city whether it is open and when it opens next", async () => {
	let url = "";
	const fetcher = (async (input: URL | RequestInfo) => {
		url = String(input);
		return Response.json({ ok: true, open: false, nextOpening: 1234, hours: "20-24" });
	}) as typeof fetch;

	await expect(fetchCityHours("https://city.test/", fetcher)).resolves.toEqual({
		open: false,
		nextOpening: 1234,
	});
	expect(url).toBe("https://city.test/api/health");
});

test("an unhealthy city is an error, not a closed one", async () => {
	const fetcher = (async () => new Response("no", { status: 503 })) as unknown as typeof fetch;
	await expect(fetchCityHours("https://city.test", fetcher)).rejects.toThrow("city health 503");
});

test("wakes just after the opening, spread out, and never right away", () => {
	expect(wakeTime(100_000, 0, 30_000, 0)).toBe(100_000);
	expect(wakeTime(100_000, 0, 30_000, 0.5)).toBe(115_000);
	// the opening has already passed by its clock: not a tight loop
	expect(wakeTime(1000, 5000, 30_000, 0)).toBe(35_000);
});
