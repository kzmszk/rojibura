import { beforeEach, describe, expect, test, vi } from "vitest";

const stores = vi.hoisted(() => ({ agents: new Map<string, unknown>(), memory: new Map<string, unknown>() }));

vi.mock("./idb.ts", () => {
	type S = keyof typeof stores;
	const keysWith = (s: S, prefix: string) => [...stores[s].keys()].filter((k) => k.startsWith(prefix));
	return {
		idbGet: async (s: S, k: string) => stores[s].get(k),
		idbPut: async (s: S, k: string, v: unknown) => void stores[s].set(k, v),
		idbDelete: async (s: S, k: string) => void stores[s].delete(k),
		idbList: async (s: S, prefix: string) => keysWith(s, prefix).map((k) => stores[s].get(k)),
		idbDeletePrefix: async (s: S, prefix: string) => {
			for (const k of keysWith(s, prefix)) stores[s].delete(k);
		},
	};
});

import {
	type BrowserIdentity,
	deleteBrowserIdentity,
	listBrowserIdentities,
	loadBrowserIdentity,
	migrateLegacyBrowserIdentity,
	saveBrowserIdentity,
} from "./identity.ts";

const ai = (agentId: string, personality = "穏やか"): BrowserIdentity => ({
	agentId,
	name: agentId,
	personality,
	privateKey: {} as CryptoKey,
});

beforeEach(() => {
	stores.agents.clear();
	stores.memory.clear();
});

describe("browser identities", () => {
	test("each owner and each AI has its own place: a new one overwrites nothing", async () => {
		await saveBrowserIdentity("h_a", ai("a_1"));
		await saveBrowserIdentity("h_a", ai("a_2"));
		await saveBrowserIdentity("h_b", ai("a_3"));
		expect((await listBrowserIdentities("h_a")).map((i) => i.agentId).sort()).toEqual(["a_1", "a_2"]);
		expect((await listBrowserIdentities("h_b")).map((i) => i.agentId)).toEqual(["a_3"]);
		expect(await loadBrowserIdentity("h_b", "a_1")).toBeUndefined();
	});

	test("the AI of earlier versions moves in under its owner, once, and the original stays", async () => {
		stores.agents.set("default", ai("a_old"));
		expect(await migrateLegacyBrowserIdentity("h_a", ["a_old", "a_new"])).toMatchObject({ agentId: "a_old" });
		expect(await loadBrowserIdentity("h_a", "a_old")).toMatchObject({ personality: "穏やか" });
		expect(stores.agents.has("default")).toBe(true);
		// what the owner changed since is not overwritten
		await saveBrowserIdentity("h_a", ai("a_old", "元気"));
		expect(await migrateLegacyBrowserIdentity("h_a", ["a_old"])).toBeNull();
		expect(await loadBrowserIdentity("h_a", "a_old")).toMatchObject({ personality: "元気" });
	});

	test("another account does not get the AI of earlier versions", async () => {
		stores.agents.set("default", ai("a_old"));
		expect(await migrateLegacyBrowserIdentity("h_b", ["a_other"])).toBeNull();
		expect(await listBrowserIdentities("h_b")).toEqual([]);
		expect(stores.agents.has("default")).toBe(true);
	});

	test("deleting removes its key, its notes and the old copy, and only those", async () => {
		stores.agents.set("default", ai("a_1"));
		await saveBrowserIdentity("h_a", ai("a_1"));
		await saveBrowserIdentity("h_a", ai("a_2"));
		stores.memory.set("a_1|h_x", ["会った"]);
		stores.memory.set("a_2|h_x", ["話した"]);
		await deleteBrowserIdentity("h_a", "a_1");
		expect(await loadBrowserIdentity("h_a", "a_1")).toBeUndefined();
		expect(stores.agents.has("default")).toBe(false);
		expect([...stores.memory.keys()]).toEqual(["a_2|h_x"]);
		expect(await loadBrowserIdentity("h_a", "a_2")).toBeDefined();
		// nothing brings it back
		expect(await migrateLegacyBrowserIdentity("h_a", ["a_1"])).toBeNull();
	});
});
