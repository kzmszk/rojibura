import { expect, test } from "vitest";
import { distance } from "./index.ts";

test("distance", () => {
	expect(distance([0, 0], [3, 4])).toBe(5);
});
