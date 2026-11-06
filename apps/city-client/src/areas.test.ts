import { beforeEach, describe, expect, test, vi } from "vitest";
import { keepPlace, keptPlace } from "./areas.ts";

describe("where you were, kept by this tab", () => {
	beforeEach(() => {
		const data = new Map<string, string>();
		vi.stubGlobal("sessionStorage", {
			getItem: (k: string) => data.get(k) ?? null,
			setItem: (k: string, v: string) => data.set(k, v),
		});
	});

	test("for each area by itself", () => {
		expect(keptPlace("main")).toBeNull();
		keepPlace("main", [182, -92]);
		expect(keptPlace("main")).toEqual([182, -92]);
		expect(keptPlace("venezia")).toBeNull();
	});

	test("what is not a place is nothing", () => {
		sessionStorage.setItem("rj.place.main", "oops");
		expect(keptPlace("main")).toBeNull();
		sessionStorage.setItem("rj.place.main", '["a","b"]');
		expect(keptPlace("main")).toBeNull();
	});

	test("private mode: nothing kept, and nothing goes wrong", () => {
		vi.stubGlobal("sessionStorage", {
			getItem: () => {
				throw new Error("denied");
			},
			setItem: () => {
				throw new Error("denied");
			},
		});
		expect(() => keepPlace("main", [1, 2])).not.toThrow();
		expect(keptPlace("main")).toBeNull();
	});
});
