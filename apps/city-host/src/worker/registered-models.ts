import type { ModelNav } from "@rojibura/nav";
import type { ModelId, ModelInfo } from "@rojibura/protocol";
import { checkModelNav, cleanModelName, glbJson, modelIdOf, paintColor } from "./models.ts";
import { BUILTIN_MODELS, PUBLISHED } from "./world.ts";

/** Registered models are stored in pieces: a DO SQLite value may be at most 2 MB. */
const MODEL_CHUNK = 1024 * 1024;
const PREVIEW_MAX_BYTES = 2 * 1024 * 1024;
const MODEL_FILE = /^\/models\/(m_[0-9a-f]{16})\.(glb|png|nav\.json)$/;

type Sql = <T extends Record<string, SqlStorageValue>>(query: string, ...params: unknown[]) => T[];

export class ModelRegistry {
	private readonly models = new Map<ModelId, { info: ModelInfo; nav: ModelNav }>();
	private readonly sql: Sql;
	constructor(sql: Sql) {
		this.sql = sql;
	}

	nav(id: ModelId): ModelNav | undefined {
		return this.models.get(id)?.nav;
	}

	load(): void {
		this.sql(
			"CREATE TABLE IF NOT EXISTS models (id TEXT PRIMARY KEY, info TEXT NOT NULL, nav TEXT NOT NULL, created INTEGER NOT NULL)",
		);
		this.sql(
			"CREATE TABLE IF NOT EXISTS model_files (id TEXT NOT NULL, kind TEXT NOT NULL, seq INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (id, kind, seq))",
		);
		for (const row of this.sql<{ id: string; info: string; nav: string }>(
			"SELECT id, info, nav FROM models ORDER BY created",
		))
			this.models.set(row.id, {
				info: JSON.parse(row.info) as ModelInfo,
				nav: JSON.parse(row.nav) as ModelNav,
			});
	}

	/** /models (list, register) and /models/<id>.glb|png|nav.json, from the gateway. */
	async request(request: Request, url: URL): Promise<Response> {
		if (url.pathname === "/models") {
			if (request.method === "POST") return this.registerModel(request);
			const published = Object.entries(PUBLISHED.models)
				.filter(([id]) => !this.models.has(id))
				.map(([, m]) => m.info);
			return Response.json([
				...BUILTIN_MODELS,
				...[...this.models.values()].map((m) => m.info),
				...published,
			]);
		}
		const file = url.pathname.match(MODEL_FILE);
		const model = file?.[1] ? this.models.get(file[1]) : undefined;
		// published but not registered here: its files are static assets
		if (file?.[1] && !model && PUBLISHED.models[file[1]])
			return new Response(null, { status: 302, headers: { Location: `/models/${file[1]}.${file[2]}` } });
		if (!file || !model) return Response.json({ error: "no such model" }, { status: 404 });
		const immutable = { "Cache-Control": "public, max-age=31536000, immutable" };
		if (file[2] === "nav.json") return Response.json(model.nav, { headers: immutable });
		const kind = file[2] as "glb" | "png";
		const chunks = this.sql<{ data: ArrayBuffer }>(
			"SELECT data FROM model_files WHERE id = ? AND kind = ? ORDER BY seq",
			model.info.id,
			kind,
		);
		if (chunks.length === 0) return Response.json({ error: "no such file" }, { status: 404 });
		const body = new Blob(chunks.map((c) => c.data));
		return new Response(body, {
			headers: { ...immutable, "Content-Type": kind === "glb" ? "model/gltf-binary" : "image/png" },
		});
	}

	/** POST /models (multipart: name, glb, nav, preview?), owner in X-RJ-Owner (set by the gateway). */
	private async registerModel(request: Request): Promise<Response> {
		const bad = (error: string) => Response.json({ error }, { status: 400 });
		const owner = JSON.parse(request.headers.get("X-RJ-Owner") ?? "null") as {
			id: string;
			name: string;
		} | null;
		if (!owner) return bad("no owner");
		const form = await request.formData();
		const name = cleanModelName(form.get("name"));
		if (!name) return bad("bad name (1-24 characters)");
		const file = form.get("glb");
		if (!(file instanceof File)) return bad("no glb");
		const glb = new Uint8Array(await file.arrayBuffer());
		const json = glbJson(glb);
		if (typeof json === "string") return bad(json);
		let rawNav: unknown;
		try {
			rawNav = JSON.parse(String(form.get("nav")));
		} catch {
			return bad("nav: not JSON");
		}
		const nav = checkModelNav(rawNav);
		if (typeof nav === "string") return bad(nav);
		const preview = form.get("preview");
		const png = preview instanceof File ? new Uint8Array(await preview.arrayBuffer()) : null;
		if (png && (png.byteLength > PREVIEW_MAX_BYTES || png[0] !== 0x89 || png[1] !== 0x50))
			return bad("preview: not a PNG (at most 2 MB)");
		const id = await modelIdOf(glb);
		const known = this.models.get(id);
		if (known) return Response.json(known.info);
		const info: ModelInfo = {
			id,
			name,
			builtin: false,
			walkable: nav.walk !== undefined,
			size: [0, 1, 2].map(
				(c) => Math.round(((nav.max[c] as number) - (nav.min[c] as number)) * 100) / 100,
			) as [number, number, number],
			byName: owner.name,
		};
		const color = paintColor(json);
		if (color) info.color = color;
		const store = (kind: string, bytes: Uint8Array) => {
			for (let seq = 0; seq * MODEL_CHUNK < bytes.byteLength; seq++)
				this.sql(
					"INSERT INTO model_files (id, kind, seq, data) VALUES (?, ?, ?, ?)",
					id,
					kind,
					seq,
					bytes.slice(seq * MODEL_CHUNK, (seq + 1) * MODEL_CHUNK).buffer,
				);
		};
		store("glb", glb);
		if (png) store("png", png);
		this.sql(
			"INSERT INTO models (id, info, nav, created) VALUES (?, ?, ?, ?)",
			id,
			JSON.stringify(info),
			JSON.stringify(nav),
			Date.now(),
		);
		this.models.set(id, { info, nav });
		return Response.json(info, { status: 201 });
	}
}
