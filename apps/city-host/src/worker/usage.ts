// The host measuring its own use of the free tier (docs/prd.md 2.5), so admins and developers can see what
// each action costs while it happens. These are estimates; Cloudflare's own numbers for the whole account
// come from the analytics API (official.ts).
//
// Costs are attributed with AsyncLocalStorage (compatibility flag nodejs_als): `track(label, fn)` opens a
// scope, and every cost recorded inside it, including after awaits, belongs to that action.

import { AsyncLocalStorage } from "node:async_hooks";
import { addUsage, emptyUsage, type Usage, type UsageEvent, usageDay } from "@rojibura/protocol";

/** Durable Objects are billed for 128 MB while active. */
const DO_GB = 0.125;
/** A handler without I/O still keeps the object active about this long (Phase 0, #3). */
const MIN_HANDLER_MS = 2;
const RECENT_EVENTS = 50;

interface Scope {
	label: string;
	cost: Partial<Usage>;
	/** Recorded already: later costs (async work it started) become their own event. */
	done: boolean;
}

const als = new AsyncLocalStorage<Scope>();

export interface SavedUsage {
	day: string;
	totals: Usage;
}

export class UsageMeter {
	day: string;
	totals: Usage;
	/** Recent actions, for someone who starts watching. */
	readonly recent: UsageEvent[] = [];
	/** Actions not yet pushed to watchers. */
	pending: UsageEvent[] = [];
	/**
	 * Actions in progress, oldest first. Duration is billed once however many actions overlap (docs: it is
	 * shared), so busy time goes to the oldest one: the action that keeps the object awake.
	 */
	private readonly running: Scope[] = [];
	private busySince = 0;
	private readonly clock: () => number;
	private readonly onEvent: () => void;

	constructor(opts: { saved?: SavedUsage; clock?: () => number; onEvent?: () => void } = {}) {
		this.clock = opts.clock ?? Date.now;
		this.onEvent = opts.onEvent ?? (() => {});
		const today = usageDay(this.clock());
		const saved = opts.saved?.day === today ? opts.saved : undefined;
		this.day = today;
		this.totals = saved ? { ...emptyUsage(), ...saved.totals } : emptyUsage();
	}

	/** Runs `fn` as one action; what it costs (including its own duration) becomes one event. */
	track<T>(label: string, fn: () => T, base: Partial<Usage> = {}): T {
		const scope: Scope = { label, cost: { ...base }, done: false };
		this.accrue();
		this.running.push(scope);
		const finish = () => {
			this.accrue();
			this.running.splice(this.running.indexOf(scope), 1);
			// a handler on its own still costs a little, even when the clock did not move
			if (!scope.cost.doGbSeconds && this.running.length === 0)
				scope.cost.doGbSeconds = (MIN_HANDLER_MS / 1000) * DO_GB;
			scope.done = true;
			this.record(scope.label, scope.cost);
		};
		const result = als.run(scope, fn);
		if (result instanceof Promise) {
			result.then(finish, finish);
		} else finish();
		return result;
	}

	/** Adds a cost to the current action (or to "その他" outside any). */
	add(cost: Partial<Usage>): void {
		const scope = als.getStore();
		if (!scope) this.record("その他", cost);
		else if (scope.done) this.record(`${scope.label}（続き）`, cost);
		else addUsage(scope.cost, cost);
	}

	/** Usage measured elsewhere (the gateway), added as its own events. */
	merge(events: UsageEvent[]): void {
		for (const e of events) this.record(e.label, e.cost, e.at);
	}

	/** Bills the busy time since the last change to the oldest running action. */
	private accrue(): void {
		const now = this.clock();
		const oldest = this.running[0];
		if (oldest) addUsage(oldest.cost, { doGbSeconds: ((now - this.busySince) / 1000) * DO_GB });
		this.busySince = now;
	}

	snapshot(): SavedUsage {
		this.rollDay();
		return { day: this.day, totals: { ...this.totals } };
	}

	private record(label: string, cost: Partial<Usage>, at = this.clock()): void {
		this.rollDay();
		const clean = Object.fromEntries(Object.entries(cost).filter(([, v]) => v)) as Partial<Usage>;
		if (Object.keys(clean).length === 0) return;
		addUsage(this.totals, clean);
		const event = { at, label, cost: clean };
		this.recent.push(event);
		if (this.recent.length > RECENT_EVENTS) this.recent.shift();
		this.pending.push(event);
		this.onEvent();
	}

	private rollDay(): void {
		const today = usageDay(this.clock());
		if (today === this.day) return;
		this.day = today;
		this.totals = emptyUsage();
	}
}

/** A D1 binding that reports rows read and written (from each result's meta) to `add`. */
export function meteredD1(db: D1Database, add: (cost: Partial<Usage>) => void): D1Database {
	const count = (meta: { rows_read?: number; rows_written?: number } | undefined) =>
		add({ d1RowsRead: meta?.rows_read ?? 0, d1RowsWritten: meta?.rows_written ?? 0 });
	const raw = new WeakMap<object, D1PreparedStatement>();
	const wrap = (stmt: D1PreparedStatement): D1PreparedStatement => {
		const w = {
			bind: (...values: unknown[]) => wrap(stmt.bind(...values)),
			all: async () => {
				const r = await stmt.all();
				count(r.meta);
				return r;
			},
			run: async () => {
				const r = await stmt.run();
				count(r.meta);
				return r;
			},
			// first() has no meta: read through all()
			first: async (column?: string) => {
				const r = await stmt.all<Record<string, unknown>>();
				count(r.meta);
				const row = r.results[0] ?? null;
				return column === undefined ? row : (row?.[column] ?? null);
			},
			raw: (options?: { columnNames?: boolean }) => stmt.raw(options as { columnNames: true }),
		} as unknown as D1PreparedStatement;
		raw.set(w, stmt);
		return w;
	};
	return {
		prepare: (query: string) => wrap(db.prepare(query)),
		batch: async (statements: D1PreparedStatement[]) => {
			const results = await db.batch(statements.map((s) => raw.get(s) ?? s));
			for (const r of results) count(r.meta);
			return results;
		},
		exec: (query: string) => db.exec(query),
		withSession: (...args: Parameters<D1Database["withSession"]>) => db.withSession(...args),
		dump: () => db.dump(),
	} as unknown as D1Database;
}
