import { describe, expect, test } from "vitest";
import { freePlayFlag } from "./free-play-flag.ts";
import { freePlayOn, isLocalHost } from "./modes.ts";

describe("free play is only ever on in development", () => {
	test("the FREE_PLAY binding: production and staging are off whatever is asked for", () => {
		expect(freePlayFlag("production", "1")).toBe("0");
		expect(freePlayFlag("staging", "1")).toBe("0");
		expect(freePlayFlag(undefined, "1")).toBe("0");
		expect(freePlayFlag("development", undefined)).toBe("0");
		expect(freePlayFlag("development", "0")).toBe("0");
		expect(freePlayFlag("development", "1")).toBe("1");
	});

	test("at run time it also needs a development build", () => {
		expect(freePlayOn({ FREE_PLAY: "1", DEV_AUTH: "1" })).toBe(true);
		expect(freePlayOn({ FREE_PLAY: "1", DEV_AUTH: "0" })).toBe(false);
		expect(freePlayOn({ FREE_PLAY: "0", DEV_AUTH: "1" })).toBe(false);
		expect(freePlayOn({})).toBe(false);
	});

	test("it answers only on this machine", () => {
		for (const h of ["localhost", "127.0.0.1", "[::1]"]) expect(isLocalHost(h)).toBe(true);
		for (const h of ["rojibura.kazumasa.workers.dev", "192.168.1.5", "localhost.evil.example"])
			expect(isLocalHost(h)).toBe(false);
	});
});
