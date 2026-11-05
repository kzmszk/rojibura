import type { AvatarId, AvatarKind } from "@rojibura/protocol";

export interface Pending {
	convId: string;
	kind: AvatarKind;
}

export interface Conversation {
	with: AvatarId;
	heard: string[];
}

const MAX_WAITING = 3;
const HEARD_KEPT = 6;

export class Conversations {
	private readonly pending = new Map<AvatarId, Pending>();
	private readonly convs = new Map<string, Conversation>();

	get hasWaiting(): boolean {
		return this.pending.size > 0;
	}

	get hasConversations(): boolean {
		return this.convs.size > 0;
	}

	canAccept(id: AvatarId): boolean {
		return this.pending.has(id) || this.pending.size < MAX_WAITING;
	}

	recordAddress(from: AvatarId, convId: string, text: string): boolean {
		const fresh = !this.convs.has(convId);
		const conv = this.convs.get(convId) ?? { with: from, heard: [] };
		this.convs.set(convId, conv);
		conv.heard.push(text);
		if (conv.heard.length > HEARD_KEPT) conv.heard.shift();
		return fresh;
	}

	wait(from: AvatarId, pending: Pending): void {
		this.pending.set(from, pending);
	}

	recordOwnSay(to: AvatarId, convId: string): void {
		if (!this.convs.has(convId)) this.convs.set(convId, { with: to, heard: [] });
	}

	end(convId: string): Conversation | undefined {
		const conv = this.convs.get(convId);
		if (!conv) return undefined;
		this.convs.delete(convId);
		if (this.pending.get(conv.with)?.convId === convId) this.pending.delete(conv.with);
		return conv;
	}

	*leave(id: AvatarId): IterableIterator<Conversation> {
		this.pending.delete(id);
		for (const [convId, conv] of this.convs) {
			if (conv.with === id) {
				const ended = this.end(convId);
				if (ended) yield ended;
			}
		}
	}

	snapshotWaiting(): Map<AvatarId, Pending> {
		return new Map(this.pending);
	}

	currentWaiting(waiting: Map<AvatarId, Pending>): [AvatarId, Pending][] {
		return [...waiting].filter(([id, pending]) => this.pending.get(id) === pending);
	}

	consume(id: AvatarId): void {
		this.pending.delete(id);
	}

	consumeIfCurrent(id: AvatarId, pending: Pending | undefined): void {
		if (this.pending.get(id) === pending) this.pending.delete(id);
	}

	isWaiting(id: AvatarId): boolean {
		return this.pending.has(id);
	}

	conversationWith(id: AvatarId): string | undefined {
		const pending = this.pending.get(id);
		if (pending) return pending.convId;
		for (const [convId, conv] of this.convs) if (conv.with === id) return convId;
		return undefined;
	}

	partner(convId: string): AvatarId | undefined {
		return this.convs.get(convId)?.with;
	}

	clearWaiting(): void {
		this.pending.clear();
	}

	clear(): void {
		this.pending.clear();
		this.convs.clear();
	}
}
