// The diary as files on the PC (docs/life.md 5): <name>.life/life.md, journal/<YYYY-MM-DD>.md, meta.json.
// Plain Markdown, so the owner can open and read it.

import { appendFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type Journal, jstDate, LIFE_MAX } from "../../core/journal.ts";

const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.md$/;

export class FileJournal implements Journal {
	readonly dir: string;
	private meta: Record<string, string> | null = null;

	constructor(dir: string) {
		this.dir = dir;
	}

	private dayPath(day: string): string {
		if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error(`bad day ${day}`);
		return join(this.dir, "journal", `${day}.md`);
	}

	async append(text: string, day = jstDate()): Promise<void> {
		await mkdir(join(this.dir, "journal"), { recursive: true, mode: 0o700 });
		await appendFile(this.dayPath(day), `${text.trimEnd()}\n\n`, { mode: 0o600 });
	}

	async read(day: string): Promise<string | null> {
		try {
			return await readFile(this.dayPath(day), "utf8");
		} catch {
			return null;
		}
	}

	async days(): Promise<string[]> {
		try {
			return (await readdir(join(this.dir, "journal")))
				.map((f) => DAY_FILE.exec(f)?.[1])
				.filter((d): d is string => !!d)
				.sort();
		} catch {
			return [];
		}
	}

	async readLife(): Promise<string> {
		try {
			return await readFile(join(this.dir, "life.md"), "utf8");
		} catch {
			return "";
		}
	}

	async writeLife(text: string): Promise<void> {
		await mkdir(this.dir, { recursive: true, mode: 0o700 });
		await writeFile(join(this.dir, "life.md"), `${[...text].slice(0, LIFE_MAX).join("").trim()}\n`, {
			mode: 0o600,
		});
	}

	private async loadMeta(): Promise<Record<string, string>> {
		if (this.meta) return this.meta;
		try {
			this.meta = JSON.parse(await readFile(join(this.dir, "meta.json"), "utf8")) as Record<string, string>;
		} catch {
			this.meta = {};
		}
		return this.meta;
	}

	async getMeta(key: string): Promise<string | null> {
		return (await this.loadMeta())[key] ?? null;
	}

	async setMeta(key: string, value: string): Promise<void> {
		const meta = await this.loadMeta();
		meta[key] = value;
		await mkdir(this.dir, { recursive: true, mode: 0o700 });
		await writeFile(join(this.dir, "meta.json"), JSON.stringify(meta, null, 1), { mode: 0o600 });
	}
}
