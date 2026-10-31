// Notes about each counterpart, kept in the browser (IndexedDB).

import type { Memory } from "../../core/types.ts";
import { idbGet, idbPut } from "./idb.ts";

const NOTES_PER_COUNTERPART = 8;

export class IdbMemory implements Memory {
	private readonly agentId: string;

	constructor(agentId: string) {
		this.agentId = agentId;
	}

	async recall(counterpartId: string): Promise<string[]> {
		return (await idbGet<string[]>("memory", `${this.agentId}|${counterpartId}`)) ?? [];
	}

	async remember(counterpartId: string, note: string): Promise<void> {
		const notes = await this.recall(counterpartId);
		notes.push(`${new Date().toISOString().slice(0, 16).replace("T", " ")} ${note}`);
		await idbPut("memory", `${this.agentId}|${counterpartId}`, notes.slice(-NOTES_PER_COUNTERPART));
	}
}
