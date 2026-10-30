import { expect, test } from "vitest";
import { PROTOCOL_VERSION } from "./index.ts";

test("protocol version", () => {
	expect(PROTOCOL_VERSION).toBe(2);
});
