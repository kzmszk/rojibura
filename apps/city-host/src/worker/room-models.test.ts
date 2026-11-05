/// <reference types="node" />
import { DatabaseSync } from "node:sqlite";
import type { ModelNav } from "@rojibura/nav";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
	DurableObject: class {
		ctx: unknown;
		env: unknown;
		constructor(ctx: unknown, env: unknown) {
			this.ctx = ctx;
			this.env = env;
		}
	},
}));

import { modelIdOf } from "./models.ts";
import { CityRoomDO } from "./room.ts";
import { BUILTIN_MODELS, MAIN_AREA, PUBLISHED } from "./world.ts";

const databases: DatabaseSync[] = [];
function database() {
	const db = new DatabaseSync(":memory:");
	databases.push(db);
	return db;
}
afterEach(() => {
	for (const db of databases.splice(0)) db.close();
});
afterAll(() => vi.unstubAllGlobals());

beforeAll(() => {
	vi.stubGlobal("WebSocketRequestResponsePair", class {});
});

function room(db: DatabaseSync, free = true) {
	const state = {
		id: { name: MAIN_AREA },
		storage: {
			kv: { get: () => undefined, put: () => {} },
			sql: {
				exec: (sql: string, ...params: unknown[]) => {
					const stmt = db.prepare(sql);
					const args = params.map((p) => (p instanceof ArrayBuffer ? new Uint8Array(p) : p)) as never[];
					if (/^\s*(SELECT|PRAGMA)/i.test(sql)) {
						const rows = stmt
							.all(...args)
							.map((row) =>
								Object.fromEntries(
									Object.entries(row).map(([k, v]) => [k, v instanceof Uint8Array ? v.slice().buffer : v]),
								),
							);
						return { toArray: () => rows, rowsRead: rows.length, rowsWritten: 0 };
					}
					const result = stmt.run(...args);
					return { toArray: () => [], rowsRead: 0, rowsWritten: Number(result.changes) };
				},
			},
		},
		getWebSockets: () => [],
		setWebSocketAutoResponse: () => {},
		blockConcurrencyWhile: (fn: () => Promise<void>) => fn(),
	};
	return new CityRoomDO(
		state as unknown as DurableObjectState,
		{ FREE_PLAY: free ? "1" : "0", DEV_AUTH: "1", DB: {} } as Env,
	);
}
const nav: ModelNav = {
	version: 1,
	min: [0, 0, 0],
	max: [2, 1, 2],
	footprint: [
		[
			[0, 0],
			[2, 0],
			[0, 2],
		],
	],
};
function glb() {
	const json = new TextEncoder().encode(JSON.stringify({ asset: { version: "2.0" } }));
	const bytes = new Uint8Array(1024 * 1024 + 29);
	const view = new DataView(bytes.buffer);
	view.setUint32(0, 0x46546c67, true);
	view.setUint32(4, 2, true);
	view.setUint32(8, bytes.length, true);
	view.setUint32(12, json.length, true);
	view.setUint32(16, 0x4e4f534a, true);
	bytes.set(json, 20);
	bytes[bytes.length - 1] = 123;
	return bytes;
}
function upload(
	bytes: Uint8Array,
	options: { name?: string; nav?: string; owner?: boolean; preview?: Uint8Array } = {},
) {
	const form = new FormData();
	form.set("name", options.name ?? "House");
	form.set("nav", options.nav ?? JSON.stringify(nav));
	form.set("glb", new File([bytes], "model.glb"));
	if (options.preview) form.set("preview", new File([options.preview], "preview.png"));
	return new Request("https://room/models", {
		method: "POST",
		body: form,
		headers: options.owner === false ? {} : { "X-RJ-Owner": JSON.stringify({ id: "owner", name: "Owner" }) },
	});
}
const get = (path: string) => new Request(`https://room${path}`);

describe("room model HTTP interface", () => {
	test("registers, lists, serves chunks and reloads a model", async () => {
		const db = database();
		const first = room(db);
		const bytes = glb();
		const created = await first.fetch(upload(bytes));
		expect(created.status).toBe(201);
		const info = (await created.json()) as { id: string; name: string };
		expect(info).toMatchObject({ name: "House", byName: "Owner", size: [2, 1, 2] });
		const duplicate = await first.fetch(upload(bytes, { name: "Different" }));
		expect(duplicate.status).toBe(200);
		expect(await duplicate.json()).toEqual(info);
		const list = (await (await first.fetch(get("/models"))).json()) as { id: string }[];
		expect(list.slice(0, BUILTIN_MODELS.length)).toEqual(BUILTIN_MODELS);
		expect(list[BUILTIN_MODELS.length]).toEqual(info);
		expect(list.slice(BUILTIN_MODELS.length + 1)).toEqual(
			Object.values(PUBLISHED.models)
				.filter((m) => m.info.id !== info.id)
				.map((m) => m.info),
		);
		expect(db.prepare("SELECT seq FROM model_files WHERE id = ? ORDER BY seq").all(info.id)).toHaveLength(2);
		const file = await first.fetch(get(`/models/${info.id}.glb`));
		expect(file.headers.get("content-type")).toBe("model/gltf-binary");
		expect(file.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
		expect(new Uint8Array(await file.arrayBuffer())).toEqual(bytes);
		expect(await (await first.fetch(get(`/models/${info.id}.nav.json`))).json()).toEqual(nav);
		expect((await first.fetch(get(`/models/${info.id}.png`))).status).toBe(404);
		const restarted = room(db);
		expect(await (await restarted.fetch(get(`/models/${info.id}.nav.json`))).json()).toEqual(nav);
		expect(
			new Uint8Array(await (await restarted.fetch(get(`/models/${info.id}.glb`))).arrayBuffer()),
		).toEqual(bytes);
	});
	test("local registration overrides a published model", async () => {
		const bytes = glb();
		const id = await modelIdOf(bytes);
		PUBLISHED.models[id] = {
			info: { id, name: "Published", builtin: false, walkable: false, size: [1, 1, 1], byName: "Owner" },
			nav,
		};
		try {
			const host = room(database());
			expect((await host.fetch(get(`/models/${id}.glb`))).status).toBe(302);
			const created = await host.fetch(upload(bytes));
			const info = await created.json();
			const list = (await (await host.fetch(get("/models"))).json()) as { id: string }[];
			expect(list.filter((m) => m.id === id)).toEqual([info]);
			expect(new Uint8Array(await (await host.fetch(get(`/models/${id}.glb`))).arrayBuffer())).toEqual(bytes);
		} finally {
			delete PUBLISHED.models[id];
		}
	});
	test("stores and serves an optional PNG preview", async () => {
		const host = room(database());
		const png = new Uint8Array([0x89, 0x50, 1, 2, 3]);
		const created = await host.fetch(upload(glb(), { preview: png }));
		const info = (await created.json()) as { id: string };
		const res = await host.fetch(get(`/models/${info.id}.png`));
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("image/png");
		expect(new Uint8Array(await res.arrayBuffer())).toEqual(png);
	});
	test("rejects invalid requests and gates free play", async () => {
		const db = database();
		const host = room(db);
		for (const req of [
			upload(glb(), { owner: false }),
			upload(glb(), { name: "" }),
			upload(new Uint8Array([0])),
			upload(glb(), { nav: "{" }),
			upload(glb(), { preview: new Uint8Array([0]) }),
		])
			expect((await host.fetch(req)).status).toBe(400);
		expect((await host.fetch(get("/models/m_0000000000000000.glb"))).status).toBe(404);
		expect((await room(database(), false).fetch(get("/models"))).status).toBe(403);
	});
	test("redirects published model files", async () => {
		const id = "m_0123456789abcdef";
		PUBLISHED.models[id] = {
			info: { id, name: "Published", builtin: false, walkable: false, size: [1, 1, 1], byName: "Owner" },
			nav,
		};
		try {
			const host = room(database());
			const res = await host.fetch(get(`/models/${id}.glb`));
			expect(res.status).toBe(302);
			expect(res.headers.get("location")).toBe(`/models/${id}.glb`);
			expect(await (await host.fetch(get("/models"))).json()).toContainEqual(PUBLISHED.models[id]?.info);
		} finally {
			delete PUBLISHED.models[id];
		}
	});
});
