import { describe, expect, test } from "vitest";
import { meteredD1, UsageMeter } from "./usage.ts";

function clock(start = Date.UTC(2026, 9, 31, 12)) {
	let now = start;
	return { now: () => now, advance: (ms: number) => (now += ms) };
}

describe("usage meter", () => {
	test("an action's costs, including after awaits, become one event", async () => {
		const c = clock();
		const meter = new UsageMeter({ clock: c.now });
		await meter.track(
			"つばさ：発言",
			async () => {
				meter.add({ sqlRowsWritten: 1 });
				await Promise.resolve();
				c.advance(30);
				meter.add({ d1RowsRead: 2 });
			},
			{ doRequests: 0.05 },
		);
		expect(meter.recent).toHaveLength(1);
		expect(meter.recent[0]).toMatchObject({
			label: "つばさ：発言",
			cost: { doRequests: 0.05, sqlRowsWritten: 1, d1RowsRead: 2 },
		});
		// 30 ms of a 128 MB object
		expect(meter.recent[0]?.cost.doGbSeconds).toBeCloseTo(0.03 * 0.125);
		expect(meter.totals.sqlRowsWritten).toBe(1);
	});

	test("overlapping actions are billed for the time once", async () => {
		const c = clock();
		const meter = new UsageMeter({ clock: c.now });
		let release = () => {};
		const slow = meter.track("シルベの返事", () => new Promise<void>((r) => (release = r)));
		c.advance(1000);
		meter.track("移動", () => {}); // during the slow one: no extra time
		c.advance(1000);
		release();
		await slow;
		expect(meter.totals.doGbSeconds).toBeCloseTo(2 * 0.125);
	});

	test("costs after an action ended become a follow-up event; outside any action, その他", async () => {
		const meter = new UsageMeter({ clock: clock().now });
		let later = () => {};
		meter.track("発言", () => {
			later = () => meter.add({ neurons: 6 });
		});
		// still inside the action's async context, but it has been recorded
		await meter.track("発言2", async () => later());
		meter.add({ sqlRowsRead: 1 });
		expect(meter.recent.map((e) => e.label)).toContain("発言2");
		expect(meter.totals.neurons).toBe(6);
		expect(meter.recent.at(-1)).toMatchObject({ label: "その他", cost: { sqlRowsRead: 1 } });
	});

	test("totals start over on a new UTC day and survive a restart the same day", () => {
		const c = clock(Date.UTC(2026, 9, 31, 23, 59));
		const meter = new UsageMeter({ clock: c.now });
		meter.track("発言", () => meter.add({ sqlRowsWritten: 3 }));
		const saved = meter.snapshot();
		expect(new UsageMeter({ saved, clock: c.now }).totals.sqlRowsWritten).toBe(3);
		c.advance(2 * 60_000); // past 00:00 UTC
		expect(new UsageMeter({ saved, clock: c.now }).totals.sqlRowsWritten).toBe(0);
		meter.track("移動", () => {});
		expect(meter.totals.sqlRowsWritten).toBe(0);
		expect(meter.day).toBe("2026-11-01");
	});
});

describe("metered D1", () => {
	test("counts rows from each result's meta, also for first() and batch()", async () => {
		const meta = { rows_read: 3, rows_written: 1 };
		const stmt = {
			bind: () => stmt,
			all: async () => ({ results: [{ id: "x", n: 1 }], meta }),
			run: async () => ({ results: [], meta }),
			raw: async () => [],
		};
		const fake = {
			prepare: () => stmt,
			batch: async (s: unknown[]) => s.map(() => ({ results: [], meta })),
		} as unknown as D1Database;
		let read = 0;
		let written = 0;
		const db = meteredD1(fake, (c) => {
			read += c.d1RowsRead ?? 0;
			written += c.d1RowsWritten ?? 0;
		});
		expect(await db.prepare("SELECT").bind(1).first("n")).toBe(1);
		await db.prepare("UPDATE").run();
		await db.batch([db.prepare("A"), db.prepare("B")]);
		expect([read, written]).toEqual([12, 4]);
	});
});
