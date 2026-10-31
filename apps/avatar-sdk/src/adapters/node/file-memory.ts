// Per-agent memory in a JSON file: a few notes per counterpart (docs/prd.md 3.5.2).

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Memory } from "../../core/types.ts";

const NOTES_PER_COUNTERPART = 8;

export class FileMemory implements Memory {
	private data: Record<string, string[]> | null = null;
	private readonly path: string;

	constructor(path: string) {
		this.path = path;
	}

	private async load(): Promise<Record<string, string[]>> {
		if (this.data) return this.data;
		try {
			this.data = JSON.parse(await readFile(this.path, "utf8")) as Record<string, string[]>;
		} catch {
			this.data = {};
		}
		return this.data;
	}

	async recall(counterpartId: string): Promise<string[]> {
		return [...((await this.load())[counterpartId] ?? [])];
	}

	async all(): Promise<Record<string, string[]>> {
		return structuredClone(await this.load());
	}

	async remember(counterpartId: string, note: string): Promise<void> {
		const data = await this.load();
		const notes = data[counterpartId] ?? [];
		notes.push(`${new Date().toISOString().slice(0, 16).replace("T", " ")} ${note}`);
		data[counterpartId] = notes.slice(-NOTES_PER_COUNTERPART);
		await mkdir(dirname(this.path), { recursive: true });
		await writeFile(this.path, JSON.stringify(data, null, 1), { mode: 0o600 });
	}
}
