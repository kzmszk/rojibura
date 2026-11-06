import type { ClientToHost, HostToClient, Item, MoveState, Vec2 } from "@rojibura/protocol";
import {
	AI_CONV_MAX_TURNS,
	COMPANY_GAP,
	dist,
	PRESENCE_TIMEOUT_MS,
	polylineLength,
	poseAt,
} from "@rojibura/protocol";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { AWAY_GRACE_MS, RoomCore } from "./room-core.ts";
import type { JoinInfo, Member, Walkable, WalletStore, World } from "./room-types.ts";

// 40 x 40 m square with a 10 x 10 m building in the middle (x, z in [-5, 5]).
const inBuilding = (p: Vec2) => Math.abs(p[0]) < 5 && Math.abs(p[1]) < 5;
const inBounds = (p: Vec2) => Math.abs(p[0]) <= 20 && Math.abs(p[1]) <= 20;
const walk: Walkable = {
	isWalkable: (p) => inBounds(p) && !inBuilding(p),
	validatePath: (path) =>
		path.every((p, i) => {
			const prev = path[i - 1];
			const mid: Vec2 | null = prev ? [(prev[0] + p[0]) / 2, (prev[1] + p[1]) / 2] : null;
			return walk.isWalkable(p) && (!mid || walk.isWalkable(mid));
		}),
	closestPoint: (p) => [Math.max(-20, Math.min(20, p[0])), Math.max(-20, Math.min(20, p[1]))],
};

type Conn = { name: string; inbox: HostToClient[]; closed?: number };

function setup(
	extra: Partial<World> = {},
	saved?: (items: Item[]) => void,
	wallets?: WalletStore,
	persisted?: (conn: Conn, member: Member) => void,
	sent?: (conn: Conn, message: HostToClient) => void,
) {
	let now = 1_000_000;
	let n = 0;
	const clock = { now: () => now, advance: (ms: number) => (now += ms) };
	const room = new RoomCore<Conn>(
		{
			send: (c, m) => {
				c.inbox.push(m);
				sent?.(c, m);
			},
			close: (c, code) => {
				c.closed = code;
			},
			persist: (c, m) => persisted?.(c, m),
		},
		{
			walk,
			landmarks: [{ id: "cafe", name: "カフェ", pos: [10, 10] }],
			spawn: [-10, -10],
			areaName: "テスト街",
			...extra,
		},
		clock.now,
		() => String(++n),
		{ ...(saved ? { items: { save: saved } } : {}), ...(wallets ? { wallets } : {}) },
	);
	return { room, clock };
}

const assets = { thumb: "", lod: "/a.glb", vrm: "/a.glb" };
const human = (id: string, extra: Partial<JoinInfo> = {}): JoinInfo => ({
	id: `h_${id}`,
	kind: "human",
	name: id,
	assets,
	ownerId: `h_${id}`,
	...extra,
});
const ai = (id: string, owner: string, extra: Partial<JoinInfo> = {}): JoinInfo => ({
	id: `a_${id}`,
	kind: "ai",
	name: id,
	assets,
	ownerId: `h_${owner}`,
	trust: "approved",
	...extra,
});
const conn = (name: string): Conn => ({ name, inbox: [] });
const last = (c: Conn) => c.inbox[c.inbox.length - 1];
const types = (c: Conn) => c.inbox.map((m) => m.t);

let ctx: ReturnType<typeof setup>;
beforeEach(() => {
	ctx = setup();
});

describe("membership", () => {
	test("join sends WELCOME and JOINED to the others", () => {
		const a = conn("a");
		const b = conn("b");
		ctx.room.join(a, human("alice"));
		ctx.room.join(b, human("bob"));
		expect(a.inbox[0]?.t).toBe("WELCOME");
		expect(last(a)).toMatchObject({ t: "JOINED", avatar: { id: "h_bob" } });
		const welcome = b.inbox[0];
		expect(welcome?.t === "WELCOME" && welcome.avatars.map((x) => x.id).sort()).toEqual(["h_alice", "h_bob"]);
	});

	test("owner may have 2 agents at once and 1 provisional", () => {
		ctx.room.join(conn("1"), ai("x1", "kazu"));
		ctx.room.join(conn("2"), ai("x2", "kazu"));
		const third = conn("3");
		expect(ctx.room.join(third, ai("x3", "kazu"))).toBe(false);
		expect(third.closed).toBe(4001);
		ctx.room.join(conn("4"), ai("p1", "other", { trust: "provisional" }));
		expect(ctx.room.join(conn("5"), ai("p2", "other", { trust: "provisional" }))).toBe(false);
	});

	test("a resumed member moves to the end of the welcome roster", () => {
		const a = conn("a");
		ctx.room.join(a, human("alice"));
		ctx.room.join(conn("b"), human("bob"));
		ctx.room.dropped(a);
		const back = conn("back");
		ctx.room.join(back, human("alice"));
		const welcome = back.inbox[0];
		expect(welcome?.t === "WELCOME" && welcome.avatars.map((x) => x.id)).toEqual(["h_bob", "h_alice"]);
	});

	test("away members still occupy admission slots", () => {
		const first = conn("first");
		ctx.room.join(first, ai("one", "owner", { trust: "provisional" }));
		ctx.room.dropped(first);
		const second = conn("second");
		expect(ctx.room.join(second, ai("two", "owner", { trust: "provisional" }))).toBe(false);
		expect(second.closed).toBe(4001);
	});

	test("a second connection with the same ID replaces the first", () => {
		const first = conn("first");
		const second = conn("second");
		ctx.room.join(first, human("alice"));
		ctx.room.join(second, human("alice"));
		expect(first.closed).toBe(4000);
		expect(ctx.room.size).toBe(1);
		expect(ctx.room.has("h_alice")).toBe(true);
		ctx.room.leave(second);
		expect(ctx.room.has("h_alice")).toBe(false);
	});

	test("an old restored connection cannot remove its replacement", () => {
		const old = conn("old");
		const replacement = conn("replacement");
		ctx.room.join(old, human("alice"));
		const saved = structuredClone(ctx.room.memberFor(old));
		if (!saved) throw new Error("not joined");
		const woke = setup().room;
		woke.restore(old, saved);
		woke.restore(replacement, saved);
		woke.leave(old);
		expect(woke.has("h_alice")).toBe(true);
		woke.leave(replacement);
		expect(woke.has("h_alice")).toBe(false);
	});

	test("someone whose socket closed while the room slept leaves when it wakes, unless they came back in", () => {
		const a = conn("a");
		const b = conn("b");
		ctx.room.join(a, human("alice"));
		ctx.room.join(b, human("bob"));
		const alice = structuredClone(ctx.room.memberFor(a));
		const bob = structuredClone(ctx.room.memberFor(b));
		if (!alice || !bob) throw new Error("not joined");
		// woken for alice's close: only bob's socket is still there to restore
		const woke = setup().room;
		woke.restore(b, bob);
		woke.departed(a, alice);
		expect(last(b)).toEqual({ t: "LEFT", id: "h_alice", reason: "quit" });
		expect(woke.has("h_alice")).toBe(false);
		// alice is back on another socket: the old one closing does not take her out
		const again = setup().room;
		const a2 = conn("a2");
		again.restore(b, bob);
		again.restore(a2, alice);
		const seen = b.inbox.length;
		again.departed(a, alice);
		expect(b.inbox.length).toBe(seen);
		expect(again.has("h_alice")).toBe(true);
		again.leave(a2);
		expect(last(b)).toEqual({ t: "LEFT", id: "h_alice", reason: "quit" });
	});

	test("sweep removes members without heartbeat", () => {
		const a = conn("a");
		const b = conn("b");
		ctx.room.join(a, human("alice"));
		ctx.room.join(b, human("bob"));
		ctx.clock.advance(PRESENCE_TIMEOUT_MS + 1000);
		ctx.room.sweep((c) => (c === b ? ctx.clock.now() : null));
		expect(a.closed).toBe(4008);
		expect(last(b)).toEqual({ t: "LEFT", id: "h_alice", reason: "timeout" });
	});
});

describe("movement", () => {
	function joinAt(c: Conn, info: JoinInfo) {
		ctx.room.join(c, info);
		const w = c.inbox[0];
		if (w?.t !== "WELCOME") throw new Error("no welcome");
		const me = w.avatars.find((x) => x.id === info.id);
		if (me?.move.kind !== "idle") throw new Error("not idle");
		return me.move.pos;
	}

	test("valid path is broadcast starting from the host's position", () => {
		const a = conn("a");
		const b = conn("b");
		const pos = joinAt(a, human("alice"));
		ctx.room.join(b, human("bob"));
		ctx.room.handle(a, { t: "MOVE_PATH", path: [pos, [-10, 10]], speed: 1.4, seq: 1 });
		expect(last(b)).toMatchObject({
			t: "MOVED",
			id: "h_alice",
			move: { kind: "path", path: [pos, [-10, 10]] },
		});
	});

	test("path through the building or from far away is corrected", () => {
		const a = conn("a");
		const pos = joinAt(a, human("alice"));
		ctx.room.handle(a, { t: "MOVE_PATH", path: [pos, [10, 10]], speed: 1.4, seq: 1 }); // crosses the building
		expect(last(a)?.t).toBe("CORRECT");
		ctx.room.handle(a, {
			t: "MOVE_PATH",
			path: [
				[15, 15],
				[16, 16],
			],
			speed: 1.4,
			seq: 2,
		});
		expect(last(a)?.t).toBe("CORRECT");
		expect(ctx.room.stats.rejectedMoves).toBe(2);
	});

	test("men keep out of the women's changing room, women out of the men's (docs/prd.md 3.8.6)", () => {
		// two rooms to the north: the women's at x -12..-8, the men's at x 8..12 (z 12..16)
		const women: Vec2[] = [
			[-12, 12],
			[-8, 12],
			[-8, 16],
			[-12, 16],
		];
		const men: Vec2[] = [
			[8, 12],
			[12, 12],
			[12, 16],
			[8, 16],
		];
		ctx = setup({ keepOut: { m: [{ poly: women }], f: [{ poly: men }] } });
		const a = conn("a");
		const b = conn("b");
		const pos = joinAt(a, human("taro", { assets: { ...assets, sex: "m" } }));
		ctx.room.handle(a, { t: "MOVE_PATH", path: [pos, [-10, 14]], speed: 1.4, seq: 1 });
		expect(last(a)?.t).toBe("CORRECT");
		ctx.room.handle(a, { t: "MOVE_PATH", path: [pos, [-10, 8], [10, 14]], speed: 1.4, seq: 2 });
		expect(last(a)?.t).not.toBe("CORRECT");
		const p2 = joinAt(b, human("hanako", { assets: { ...assets, sex: "f" } }));
		ctx.room.handle(b, { t: "MOVE_PATH", path: [p2, [-10, 14]], speed: 1.4, seq: 1 });
		expect(last(b)?.t).not.toBe("CORRECT");
		// no sex given: either
		const c = conn("c");
		const p3 = joinAt(c, human("capsule"));
		ctx.room.handle(c, { t: "MOVE_PATH", path: [p3, [-10, 14]], speed: 1.4, seq: 1 });
		expect(last(c)?.t).not.toBe("CORRECT");
	});

	test("too many moves get rate limited and finally disconnected", () => {
		const a = conn("a");
		const pos = joinAt(a, human("alice"));
		for (let i = 0; i < 20; i++) ctx.room.handle(a, { t: "MOVE_VEL", pos, dir: [0, 0], speed: 0, seq: i });
		expect(types(a)).toContain("NOTICE");
		expect(a.closed).toBe(1008);
	});

	test("AIs only hear about avatars inside their interest radius", () => {
		const bot = conn("bot");
		const a = conn("a");
		joinAt(bot, ai("bot", "kazu"));
		const pos = joinAt(a, human("alice"));
		ctx.room.handle(bot, { t: "INTEREST", radius: 5 });
		bot.inbox.length = 0;
		// alice walks far away along the west edge, then acts there
		ctx.room.handle(a, { t: "MOVE_PATH", path: [pos, [-18, -18]], speed: 4, seq: 1 });
		ctx.clock.advance(60_000);
		ctx.room.handle(a, { t: "ACTION", motion: "wave" });
		expect(types(bot)).not.toContain("ACTED");
	});

	test("sitting and lying stop the avatar and last until it moves, also for those who come later", () => {
		const a = conn("a");
		const b = conn("b");
		const pos = joinAt(a, human("alice"));
		ctx.room.join(b, human("bob"));
		ctx.room.handle(a, { t: "MOVE_PATH", path: [pos, [-10, 10]], speed: 1.4, seq: 1 });
		ctx.clock.advance(2000);
		ctx.room.handle(a, { t: "ACTION", motion: "lie" });
		expect(b.inbox.slice(-2)).toMatchObject([
			{ t: "MOVED", id: "h_alice", move: { kind: "idle", posture: "lie" } },
			{ t: "ACTED", id: "h_alice", motion: "lie" },
		]);
		const lying = b.inbox[b.inbox.length - 2] as Extract<HostToClient, { t: "MOVED" }>;
		expect(lying.move.kind === "idle" && lying.move.pos[1]).toBeCloseTo(pos[1] + 2.8, 1);
		const c = conn("c");
		ctx.room.join(c, human("carol"));
		const w = c.inbox[0] as Extract<HostToClient, { t: "WELCOME" }>;
		expect(w.avatars.find((x) => x.id === "h_alice")?.move).toMatchObject({ kind: "idle", posture: "lie" });
		// moving again stands up
		ctx.room.handle(a, {
			t: "MOVE_VEL",
			pos: lying.move.kind === "idle" ? lying.move.pos : pos,
			dir: [1, 0],
			speed: 1.4,
			seq: 2,
		});
		expect(last(b)).toMatchObject({ t: "MOVED", move: { kind: "vel" } });
		expect(last(b)).not.toHaveProperty("move.posture");
		// a gesture is not a pose
		ctx.room.handle(a, { t: "ACTION", motion: "wave" });
		expect(last(b)).toMatchObject({ t: "ACTED", motion: "wave" });
		expect(b.inbox.at(-2)).toMatchObject({ t: "MOVED", move: { kind: "vel" } });
	});

	test("AIs hear about arrivals and departures anywhere in the area", () => {
		const bot = conn("bot");
		const a = conn("a");
		const b = conn("b");
		joinAt(bot, ai("bot", "kazu"));
		const pos = joinAt(a, human("alice"));
		ctx.room.handle(bot, { t: "INTEREST", radius: 5 });
		ctx.room.handle(a, { t: "MOVE_PATH", path: [pos, [-18, -18]], speed: 4, seq: 1 });
		ctx.clock.advance(60_000);
		bot.inbox.length = 0;
		ctx.room.join(b, human("bob"));
		expect(bot.inbox).toContainEqual(expect.objectContaining({ t: "JOINED" }));
		ctx.room.leave(a, "quit");
		expect(last(bot)).toMatchObject({ t: "LEFT", id: "h_alice" });
	});
});

describe("a dropped connection", () => {
	/** alice talking with her AI mina (who stands at [3, -10]), bob watching. */
	function talking() {
		const h = conn("h");
		const bot = conn("bot");
		const other = conn("other");
		place(h, human("alice"), [0, -10]);
		place(bot, ai("mina", "alice"), [3, -10]);
		place(other, human("bob"), [-3, -10]);
		ctx.room.handle(h, { t: "SAY", text: "こんばんは", to: "a_mina" });
		const addressed = bot.inbox.find((m) => m.t === "ADDRESSED");
		if (addressed?.t !== "ADDRESSED") throw new Error("not addressed");
		return { h, bot, other, convId: addressed.convId };
	}

	test("back within moments, it carries on where it was: no one hears it leave, the talk goes on", () => {
		const { h, bot, other, convId } = talking();
		other.inbox.length = 0;
		expect(ctx.room.dropped(bot)).toBe(ctx.clock.now() + AWAY_GRACE_MS);
		// meanwhile she says something more: kept for it
		ctx.room.handle(h, { t: "SAY", text: "聞こえる？", convId });
		ctx.clock.advance(3000);
		const back = conn("back");
		ctx.room.join(back, ai("mina", "alice"));
		expect(bot.closed).toBeUndefined();
		const welcome = back.inbox[0];
		expect(welcome).toMatchObject({ t: "WELCOME", you: "a_mina", resumed: true });
		const me = welcome?.t === "WELCOME" ? welcome.avatars.find((a) => a.id === "a_mina") : undefined;
		expect(me?.move).toMatchObject({ kind: "idle", pos: [3, -10] });
		expect(back.inbox.slice(1)).toContainEqual(
			expect.objectContaining({ t: "ADDRESSED", from: "h_alice", text: "聞こえる？", convId }),
		);
		// the others saw no LEFT or JOINED
		expect(types(other).filter((t) => t === "LEFT" || t === "JOINED")).toEqual([]);
		// its reply on the new connection is in the same conversation
		ctx.room.handle(back, { t: "SAY", text: "聞こえるよ", convId });
		expect(last(h)).toMatchObject({ t: "SAID", id: "a_mina", to: "h_alice", convId });
		expect(ctx.room.size).toBe(3);
	});

	test("away messages are replayed in order after welcome and wallet, up to 50", () => {
		const listener = conn("listener");
		const speaker = conn("speaker");
		const watcher = conn("watcher");
		place(listener, human("alice", { coins: 100 }), [0, -10]);
		place(speaker, ai("guide", "host", { system: true }), [3, -10]);
		place(watcher, human("bob"), [4, -10]);
		listener.inbox.length = 0;
		watcher.inbox.length = 0;
		ctx.room.dropped(listener);
		for (let i = 0; i < 52; i++) ctx.room.handle(speaker, { t: "SAY", text: `message ${i}` });
		ctx.room.handle(speaker, { t: "MOVE_VEL", pos: [3, -10], dir: [0, 0], speed: 0, seq: 1 });
		expect(watcher.inbox).toContainEqual(expect.objectContaining({ t: "MOVED", id: "a_guide" }));
		expect(listener.inbox).toEqual([]);

		const back = conn("back");
		ctx.room.join(back, human("alice", { coins: 1 }));
		expect(back.inbox.slice(0, 2)).toMatchObject([
			{ t: "WELCOME", resumed: true },
			{ t: "WALLET", coins: 100 },
		]);
		expect(back.inbox.slice(2).map((m) => (m.t === "SAID" ? m.text : m.t))).toEqual(
			Array.from({ length: 50 }, (_, i) => `message ${i}`),
		);
	});

	test("conversation updates are not persisted to the disconnected socket", () => {
		const persisted: Conn[] = [];
		ctx = setup({}, undefined, undefined, (c) => persisted.push(c));
		const { h, bot, convId } = talking();
		persisted.length = 0;
		ctx.room.dropped(bot);
		ctx.room.handle(h, { t: "SAY", text: "聞こえる？", convId });
		expect(persisted).toContain(h);
		expect(persisted).not.toContain(bot);
		const back = conn("back");
		ctx.room.join(back, ai("mina", "alice"));
		expect(persisted).toContain(back);
	});

	test("a late drop from the old connection cannot remove the one that resumed", () => {
		const { bot, other } = talking();
		const saved = structuredClone(ctx.room.memberFor(bot));
		if (!saved) throw new Error("not joined");
		ctx.room.dropped(bot);
		const back = conn("back");
		ctx.room.join(back, ai("mina", "alice"));
		other.inbox.length = 0;
		expect(ctx.room.dropped(bot, saved)).toBeNull();
		ctx.clock.advance(AWAY_GRACE_MS + 1);
		ctx.room.expireAway();
		expect(ctx.room.has("a_mina")).toBe(true);
		expect(types(other)).not.toContain("LEFT");
		ctx.room.handle(back, { t: "SAY", text: "まだここにいるよ" });
		expect(other.inbox).toContainEqual(
			expect.objectContaining({ t: "SAID", id: "a_mina", text: "まだここにいるよ" }),
		);
	});

	test("reconnection retains the previous connection's movement rate limit", () => {
		const first = conn("first");
		place(first, human("alice"), [-10, -10]);
		for (let i = 0; i < 8; i++)
			ctx.room.handle(first, { t: "MOVE_VEL", pos: [-10, -10], dir: [0, 0], speed: 0, seq: i });
		expect(first.inbox.filter((m) => m.t === "NOTICE")).toEqual([]);
		ctx.room.dropped(first);
		const back = conn("back");
		ctx.room.join(back, human("alice"));
		ctx.room.handle(back, { t: "MOVE_VEL", pos: [-10, -10], dir: [0, 0], speed: 0, seq: 8 });
		expect(back.inbox).toContainEqual(expect.objectContaining({ t: "NOTICE", kind: "rate_limited" }));
	});

	test("a connection still resumes after the deadline until expiration is processed", () => {
		const first = conn("first");
		place(first, human("alice"), [-10, -10]);
		ctx.room.dropped(first);
		ctx.clock.advance(AWAY_GRACE_MS + 1);
		const back = conn("back");
		ctx.room.join(back, human("alice"));
		expect(back.inbox[0]).toMatchObject({ t: "WELCOME", resumed: true });
		ctx.room.expireAway();
		expect(ctx.room.has("h_alice")).toBe(true);
	});

	test("simultaneous expirations leave in drop order", () => {
		const observer = conn("observer");
		const a = conn("a");
		const b = conn("b");
		ctx.room.join(observer, human("observer"));
		ctx.room.join(a, human("a"));
		ctx.room.join(b, human("b"));
		observer.inbox.length = 0;
		ctx.room.dropped(b);
		ctx.room.dropped(a);
		ctx.clock.advance(AWAY_GRACE_MS);
		ctx.room.expireAway();
		expect(observer.inbox.filter((message) => message.t === "LEFT")).toEqual([
			{ t: "LEFT", id: "h_b", reason: "timeout" },
			{ t: "LEFT", id: "h_a", reason: "timeout" },
		]);
	});

	test("not back in time, it leaves then; until then it waits, heartbeat or not", () => {
		const { bot, other } = talking();
		ctx.room.dropped(bot);
		ctx.clock.advance(AWAY_GRACE_MS - 1);
		ctx.room.sweep(() => null);
		expect(ctx.room.has("a_mina")).toBe(true);
		ctx.clock.advance(1);
		ctx.room.expireAway();
		expect(last(other)).toEqual({ t: "LEFT", id: "a_mina", reason: "timeout" });
		expect(ctx.room.has("a_mina")).toBe(false);
		// coming in later is a new arrival
		const later = conn("later");
		ctx.room.join(later, ai("mina", "alice"));
		expect(later.inbox[0]).not.toHaveProperty("resumed");
		expect(last(other)).toMatchObject({ t: "JOINED", avatar: { id: "a_mina" } });
	});

	test("dropped while the room slept: it waits from what it last saved; a second word changes nothing", () => {
		const { bot, other } = talking();
		const saved = structuredClone(ctx.room.memberFor(bot));
		const bob = structuredClone(ctx.room.memberFor(other));
		if (!saved || !bob) throw new Error("not joined");
		const woke = setup().room;
		woke.restore(other, bob);
		expect(woke.dropped(bot, saved)).not.toBeNull();
		expect(woke.dropped(bot, saved)).toBeNull();
		const back = conn("back");
		woke.join(back, ai("mina", "alice"));
		expect(back.inbox[0]).toMatchObject({ t: "WELCOME", resumed: true });
		expect(woke.size).toBe(2);
	});

	test("a new connection while the old one still seems open takes over where it was", () => {
		const first = conn("first");
		const other = conn("other");
		place(first, human("alice"), [7, 7]);
		place(other, human("bob"), [-3, -10]);
		const second = conn("second");
		ctx.room.join(second, human("alice"));
		expect(first.closed).toBe(4000);
		expect(other.inbox).toEqual([]);
		const w = second.inbox[0];
		expect(w?.t === "WELCOME" && w.avatars.find((a) => a.id === "h_alice")?.move).toMatchObject({
			pos: [7, 7],
		});
	});
});

describe("conversation", () => {
	test("human talks to AI: SAID for everyone, ADDRESSED with context for the AI", () => {
		const h = conn("h");
		const bot = conn("bot");
		const other = conn("other");
		ctx.room.join(h, human("alice"));
		ctx.room.join(bot, ai("mina", "kazu"));
		ctx.room.join(other, human("bob"));
		ctx.room.handle(h, { t: "SAY", text: "こんばんは", to: "a_mina" });
		expect(last(other)).toMatchObject({ t: "SAID", id: "h_alice", to: "a_mina", text: "こんばんは" });
		const addressed = bot.inbox.find((m) => m.t === "ADDRESSED");
		expect(addressed).toMatchObject({ from: "h_alice", turn: 1, maxTurns: null });
		if (addressed?.t !== "ADDRESSED") throw new Error();
		expect(addressed.context.nearbyAvatars.map((x) => x.id)).toContain("h_alice");
		expect(addressed.context.nearbyLandmarks[0]?.id).toBe("cafe");
		// AI replies in the same conversation
		ctx.room.handle(bot, { t: "SAY", text: "こんばんは！", convId: addressed.convId });
		expect(last(h)).toMatchObject({ t: "SAID", id: "a_mina", to: "h_alice", convId: addressed.convId });
	});

	test("AI-AI conversation ends at the turn limit and the pair cools down", () => {
		const x = conn("x");
		const y = conn("y");
		ctx.room.join(x, ai("x", "o1"));
		ctx.room.join(y, ai("y", "o2"));
		ctx.room.handle(x, { t: "SAY", text: "やあ", to: "a_y" });
		const first = y.inbox.find((m) => m.t === "ADDRESSED");
		if (first?.t !== "ADDRESSED") throw new Error();
		expect(first.maxTurns).toBe(AI_CONV_MAX_TURNS);
		let speaker = y;
		for (let turn = 2; turn <= AI_CONV_MAX_TURNS; turn++) {
			ctx.clock.advance(4000);
			ctx.room.handle(speaker, { t: "SAY", text: `turn ${turn}`, convId: first.convId });
			speaker = speaker === y ? x : y;
		}
		expect(types(x)).toContain("CONV_END");
		ctx.clock.advance(4000);
		ctx.room.handle(x, { t: "SAY", text: "もう一回", to: "a_y" });
		expect(last(x)).toMatchObject({ t: "NOTICE", kind: "rejected" });
	});

	test("two AIs starting at the same time share one conversation", () => {
		const x = conn("x");
		const y = conn("y");
		ctx.room.join(x, ai("x", "o1"));
		ctx.room.join(y, ai("y", "o2"));
		ctx.room.handle(x, { t: "SAY", text: "やあ", to: "a_y" });
		ctx.clock.advance(4000);
		ctx.room.handle(y, { t: "SAY", text: "こんにちは", to: "a_x" });
		const ids = new Set([...x.inbox, ...y.inbox].flatMap((m) => (m.t === "ADDRESSED" ? [m.convId] : [])));
		expect(ids.size).toBe(1);
		const second = x.inbox.find((m) => m.t === "ADDRESSED");
		expect(second).toMatchObject({ turn: 2 });
	});

	test("provisional AI cannot start talking to a human but can reply", () => {
		const h = conn("h");
		const bot = conn("bot");
		ctx.room.join(h, human("alice"));
		ctx.room.join(bot, ai("p", "kazu", { trust: "provisional" }));
		ctx.room.handle(bot, { t: "SAY", text: "こんにちは", to: "h_alice" });
		expect(last(bot)).toMatchObject({ t: "NOTICE", kind: "rejected" });
		ctx.room.handle(h, { t: "SAY", text: "やあ", to: "a_p" });
		const addressed = bot.inbox.find((m) => m.t === "ADDRESSED");
		if (addressed?.t !== "ADDRESSED") throw new Error();
		ctx.room.handle(bot, { t: "SAY", text: "どうも", convId: addressed.convId });
		expect(last(h)).toMatchObject({ t: "SAID", id: "a_p" });
	});

	test("a human may address the same AI at most 6 times a minute", () => {
		const h = conn("h");
		const bot = conn("bot");
		ctx.room.join(h, human("alice"));
		ctx.room.join(bot, ai("mina", "kazu"));
		for (let i = 0; i < 7; i++) {
			ctx.clock.advance(1100);
			ctx.room.handle(h, { t: "SAY", text: `hi ${i}`, to: "a_mina" });
		}
		expect(bot.inbox.filter((m) => m.t === "ADDRESSED")).toHaveLength(6);
		expect(last(h)).toMatchObject({ t: "NOTICE", kind: "rate_limited" });
	});
});

describe("moderation", () => {
	test("muted speakers are not heard; blocks stop addressing and hide from AI context", () => {
		const a = conn("a");
		const b = conn("b");
		const bot = conn("bot");
		ctx.room.join(a, human("alice"));
		ctx.room.join(b, human("bob"));
		ctx.room.join(bot, ai("mina", "kazu"));
		ctx.room.setRelations("h_alice", { mutes: ["h_bob"], blocks: ["a_mina"], blockedBy: [] });
		ctx.room.setRelations("a_mina", { mutes: [], blocks: [], blockedBy: ["h_alice"] });
		a.inbox.length = 0;
		ctx.room.handle(b, { t: "SAY", text: "聞こえる？" });
		expect(a.inbox.some((m) => m.t === "SAID")).toBe(false);
		// the blocked AI cannot address alice, and alice does not show up in its context
		ctx.room.handle(bot, { t: "SAY", text: "こんにちは", to: "h_alice" });
		expect(last(bot)).toMatchObject({ t: "NOTICE", kind: "rejected" });
		ctx.room.handle(b, { t: "SAY", text: "ミナ、だれがいる？", to: "a_mina" });
		const addressed = bot.inbox.find((m) => m.t === "ADDRESSED");
		if (addressed?.t !== "ADDRESSED") throw new Error();
		expect(addressed.context.nearbyAvatars.map((x) => x.id)).not.toContain("h_alice");
		// unmute through updateRelation
		ctx.room.updateRelation("h_alice", "h_bob", "mute", false);
		ctx.clock.advance(1100);
		ctx.room.handle(b, { t: "SAY", text: "今度は？" });
		expect(last(a)).toMatchObject({ t: "SAID", text: "今度は？" });
	});

	test("moderator mute, kick and the chat excerpt", () => {
		const a = conn("a");
		const b = conn("b");
		ctx.room.join(a, human("alice"));
		ctx.room.join(b, human("bob"));
		ctx.room.handle(b, { t: "SAY", text: "ひどい発言" });
		ctx.clock.advance(1000);
		ctx.room.handle(a, { t: "SAY", text: "やめて", to: "h_bob" });
		expect(ctx.room.excerpt("h_bob", 5 * 60_000).map((l) => l.text)).toEqual(["ひどい発言", "やめて"]);
		expect(ctx.room.muteFor("h_bob", ctx.clock.now() + 60_000)).toBe(true);
		ctx.clock.advance(1100);
		ctx.room.handle(b, { t: "SAY", text: "まだ言う" });
		expect(last(b)).toMatchObject({ t: "NOTICE", kind: "muted_by_moderator" });
		expect(ctx.room.kick("h_bob")).toBe(true);
		expect(b.closed).toBe(4003);
		expect(last(a)).toEqual({ t: "LEFT", id: "h_bob", reason: "kicked" });
	});
});

test("conversations survive hibernation through the persisted member state", () => {
	const store = new Map<string, unknown>();
	const make = () => {
		const now = 5_000_000;
		return new RoomCore<Conn>(
			{
				send: (c, m) => c.inbox.push(m),
				close: () => {},
				persist: (c, m) => store.set(c.name, structuredClone(m)),
			},
			{ walk, landmarks: [], spawn: [-10, -10], areaName: "テスト街" },
			() => now,
			() => "x",
		);
	};
	const before = make();
	const h = conn("h");
	const bot = conn("bot");
	before.join(h, human("alice"));
	before.join(bot, ai("mina", "kazu"));
	before.handle(h, { t: "SAY", text: "やあ", to: "a_mina" });
	// the Durable Object hibernates and wakes up with a fresh RoomCore
	const after = make();
	after.restore(h, store.get("h") as never);
	after.restore(bot, store.get("bot") as never);
	bot.inbox.length = 0;
	after.leave(h);
	expect(bot.inbox.find((m) => m.t === "CONV_END")).toMatchObject({ reason: "left" });
});

/** Joins `info` and puts them at `pos` (a key move from wherever they spawned would be refused if far). */
function place(c: Conn, info: JoinInfo, pos: Vec2) {
	ctx.room.join(c, info);
	const me = ctx.room.memberFor(c);
	if (!me) throw new Error("not joined");
	me.move = { kind: "idle", pos, at: ctx.clock.now() };
	c.inbox.length = 0;
}

describe("doing things together", () => {
	test("an offer, a yes: both step to their places facing each other and start together", () => {
		const a = conn("a");
		const b = conn("b");
		place(a, human("alice"), [-10, -10]);
		place(b, human("bob"), [-8, -10]);
		ctx.room.handle(a, { t: "OFFER", kind: "handshake", to: "h_bob" });
		expect(b.inbox).toEqual([{ t: "OFFERED", from: "h_alice", kind: "handshake" }]);
		ctx.room.handle(b, { t: "ANSWER", to: "h_alice", accept: true });
		expect(a.inbox).toContainEqual({ t: "ANSWERED", by: "h_bob", kind: "handshake", accept: true });
		const moved = b.inbox.filter((m) => m.t === "MOVED");
		expect(moved).toHaveLength(2);
		const ends = moved.map((m) => (m.t === "MOVED" && m.move.kind === "path" ? m.move.path[1] : null));
		// centred where they were, 0.65 m apart
		expect(ends[0]?.[0]).toBeCloseTo(-9.325, 3);
		expect(ends[1]?.[0]).toBeCloseTo(-8.675, 3);
		const together = b.inbox.find((m) => m.t === "TOGETHER");
		// the longer walk is 0.675 m at 1.4 m/s, then a little margin
		expect(together).toMatchObject({ kind: "handshake", a: "h_alice", b: "h_bob" });
		expect(together?.t === "TOGETHER" && together.at - ctx.clock.now()).toBeCloseTo(
			(0.675 / 1.4) * 1000 + 200,
			0,
		);
		expect(a.inbox.some((m) => m.t === "TOGETHER")).toBe(true);
	});

	test("the host's guide says yes at once", () => {
		const a = conn("a");
		const g = conn("guide");
		place(a, human("alice"), [-10, -10]);
		place(g, ai("guide", "system", { system: true }), [-9, -10]);
		ctx.room.handle(a, { t: "OFFER", kind: "hug", to: "a_guide" });
		expect(g.inbox.some((m) => m.t === "OFFERED")).toBe(false);
		expect(a.inbox).toContainEqual({ t: "ANSWERED", by: "a_guide", kind: "hug", accept: true });
		expect(a.inbox.some((m) => m.t === "TOGETHER")).toBe(true);
	});

	test("a hug with your AI beside you: it stays in your arms, then steps back with you", () => {
		const a = conn("a");
		const bot = conn("bot");
		place(a, human("alice"), [-10, -10]);
		place(bot, ai("bot", "alice"), [-11, -10]);
		ctx.room.handle(a, { t: "COMPANION", on: true });
		ctx.clock.advance(2000);
		const ai0 = ctx.room.memberFor(bot);
		if (ai0) ai0.move = { kind: "idle", pos: [-11, -10], at: ctx.clock.now() };
		ctx.room.handle(a, { t: "OFFER", kind: "hug", to: "a_bot" });
		ctx.room.handle(bot, { t: "ANSWER", to: "h_alice", accept: true });
		const together = a.inbox.find((m) => m.t === "TOGETHER");
		if (together?.t !== "TOGETHER") throw new Error("no hug");
		// her page says she has arrived: the AI is not taken to her side, and does not walk off by itself
		ctx.clock.advance(together.at - ctx.clock.now());
		a.inbox.length = 0;
		const spot = (m: Conn) => ctx.room.memberFor(m)?.move;
		const hers = spot(a);
		const here = hers?.kind === "path" ? (hers.path.at(-1) as Vec2) : [-10, -10];
		ctx.room.handle(a, { t: "MOVE_VEL", pos: here as Vec2, dir: [0, 0], speed: 0, seq: 1 });
		expect(a.inbox.some((m) => m.t === "MOVED" && m.id === "a_bot")).toBe(false);
		bot.inbox.length = 0;
		ctx.room.handle(bot, {
			t: "MOVE_PATH",
			path: [
				[-10.2, -10],
				[-12, -10],
			],
			speed: 1.4,
			seq: 1,
		});
		expect(bot.inbox.map((m) => m.t)).toEqual(["CORRECT"]);
		// over: she steps back, and the AI steps back from her
		ctx.clock.advance(4500);
		a.inbox.length = 0;
		ctx.room.handle(a, { t: "ACTION", motion: "stepback" });
		const back = a.inbox.find((m) => m.t === "MOVED" && m.id === "a_bot");
		expect(back).toMatchObject({ move: { kind: "path", speed: expect.closeTo(0.3 / 1.1, 3) } });
		const path = back?.t === "MOVED" && back.move.kind === "path" ? back.move.path : [];
		expect(path[1]?.[0] ?? 0).toBeCloseTo((path[0]?.[0] ?? 0) - 0.3, 3);
		expect(a.inbox).toContainEqual(expect.objectContaining({ t: "ACTED", id: "a_bot", motion: "stepback" }));
	});

	test("a no, a late yes, someone too far or blocked: nothing happens together", () => {
		const a = conn("a");
		const b = conn("b");
		place(a, human("alice"), [-10, -10]);
		place(b, human("bob"), [-8, -10]);
		ctx.room.handle(a, { t: "OFFER", kind: "hug", to: "h_bob" });
		ctx.room.handle(b, { t: "ANSWER", to: "h_alice", accept: false });
		expect(a.inbox).toContainEqual({ t: "ANSWERED", by: "h_bob", kind: "hug", accept: false });
		ctx.room.handle(a, { t: "OFFER", kind: "hug", to: "h_bob" });
		ctx.clock.advance(16_000);
		a.inbox.length = 0;
		ctx.room.handle(b, { t: "ANSWER", to: "h_alice", accept: true });
		expect(a.inbox).toEqual([]);
		const far = conn("far");
		place(far, human("carol"), [-10, 10]);
		ctx.room.handle(a, { t: "OFFER", kind: "hug", to: "h_carol" });
		expect(last(a)).toMatchObject({ t: "NOTICE", kind: "rejected" });
		ctx.room.setRelations("h_alice", { mutes: [], blocks: ["h_bob"], blockedBy: [] });
		ctx.room.handle(b, { t: "OFFER", kind: "hug", to: "h_alice" });
		expect(last(b)).toMatchObject({ t: "NOTICE", kind: "rejected" });
		expect(a.inbox.some((m) => m.t === "OFFERED")).toBe(false);
	});
});

describe("sitting on a seat", () => {
	const seats = [
		{ pos: [-10, -9.4] as Vec2, y: 0.46, face: [0, -1] as Vec2 },
		{ pos: [-30, -30] as Vec2, y: 0.46, face: [0, -1] as Vec2 },
	];
	beforeEach(() => {
		ctx = setup({ seats });
	});

	test("on one close by and free; not one far off, nor one someone sits on", () => {
		const a = conn("a");
		const b = conn("b");
		place(a, human("alice"), [-10, -10]);
		place(b, human("bob"), [-10.3, -10]);
		ctx.room.handle(a, { t: "ACTION", motion: "sit", seat: 0 });
		expect(ctx.room.memberFor(a)?.move).toMatchObject({
			kind: "idle",
			posture: "sit",
			seat: 0,
			face: [0, -1],
		});
		ctx.room.handle(b, { t: "ACTION", motion: "sit", seat: 0 });
		expect(last(b)).toMatchObject({ t: "NOTICE", kind: "rejected" });
		ctx.room.handle(b, { t: "ACTION", motion: "sit", seat: 1 });
		expect(last(b)).toMatchObject({ t: "NOTICE", kind: "rejected" });
		// without asking for one a person sits on the ground
		ctx.room.handle(b, { t: "ACTION", motion: "sit" });
		const move = ctx.room.memberFor(b)?.move;
		expect(move?.kind === "idle" && move.seat).toBeUndefined();
		// she walks on: the seat is free again
		ctx.room.handle(a, {
			t: "MOVE_PATH",
			path: [
				[-10, -10],
				[-12, -10],
			],
			speed: 1.4,
			seq: 1,
		});
		ctx.room.handle(b, { t: "ACTION", motion: "sit", seat: 0 });
		expect(ctx.room.memberFor(b)?.move).toMatchObject({ seat: 0 });
	});

	test("an AI walking with its owner sits on the seat next to theirs when they sit", () => {
		ctx = setup({
			seats: [
				{ pos: [-10, -9.4] as Vec2, y: 0.46, face: [0, -1] as Vec2 },
				{ pos: [-9, -9.4] as Vec2, y: 0.46, face: [0, -1] as Vec2 },
			],
		});
		const a = conn("a");
		const bot = conn("bot");
		place(a, human("alice"), [-10, -10]);
		place(bot, ai("bot", "alice"), [-11, -10]);
		ctx.room.handle(a, { t: "COMPANION", on: true });
		ctx.room.handle(a, { t: "ACTION", motion: "sit", seat: 0 });
		// it walks to the seat first, and sits when it gets there (the sweep's alarm)
		expect(ctx.room.memberFor(bot)?.move.kind).toBe("path");
		const at = ctx.room.wakeAt as number;
		expect(at).toBeGreaterThan(0);
		ctx.room.sweep(() => ctx.clock.now());
		expect(ctx.room.memberFor(bot)?.move.kind).toBe("path");
		ctx.clock.advance(at - ctx.clock.now() + 10);
		ctx.room.sweep(() => ctx.clock.now());
		expect(ctx.room.memberFor(bot)?.move).toMatchObject({ posture: "sit", seat: 1 });
		expect(ctx.room.wakeAt).toBeUndefined();
	});

	test("an AI sitting down next to a free seat sits on it", () => {
		const bot = conn("bot");
		place(bot, ai("bot", "alice"), [-10, -10]);
		ctx.room.handle(bot, { t: "ACTION", motion: "sit" });
		expect(ctx.room.memberFor(bot)?.move).toMatchObject({ posture: "sit", seat: 0 });
	});
});

describe("small things", () => {
	const ball: Vec2 = [-9, -10];
	let saves: Item[][];
	beforeEach(() => {
		saves = [];
		ctx = setup({ items: [{ kind: "ball", pos: ball }] }, (items) => saves.push(structuredClone(items)));
		ctx.room.loadItems(undefined);
	});
	const theBall = () => ctx.room.itemList[0] as Item;

	test("pick up close by, throw ahead: it flies, lands, and cannot be picked up meanwhile", () => {
		const a = conn("a");
		const b = conn("b");
		place(a, human("alice"), [-10, -10]);
		place(b, human("bob"), [-12, -10]);
		ctx.room.handle(b, { t: "PICK", item: theBall().id });
		expect(last(b)).toMatchObject({ t: "NOTICE", kind: "rejected" });
		ctx.room.handle(a, { t: "PICK", item: theBall().id });
		expect(last(b)).toMatchObject({ t: "ITEM", item: { holder: "h_alice" } });
		ctx.room.handle(a, { t: "THROW", dir: [0, 1] });
		const thrown = last(b);
		expect(thrown).toMatchObject({
			t: "ITEM",
			item: { pos: [-10, -4], flight: { from: [-10, -10], dur: 900 } },
		});
		expect(thrown).not.toHaveProperty("item.holder");
		place(b, human("bob"), [-10, -4.5]);
		ctx.room.handle(b, { t: "PICK", item: theBall().id });
		expect(last(b)).toMatchObject({ t: "NOTICE", message: "まだ飛んでいます" });
		ctx.clock.advance(1300);
		ctx.room.handle(b, { t: "PICK", item: theBall().id });
		expect(theBall().holder).toBe("h_bob");
		expect(saves.length).toBeGreaterThanOrEqual(3);
	});

	test("thrown, picked up again, put down, left behind, seen by newcomers", () => {
		const a = conn("a");
		place(a, human("alice"), [-9.5, -10]);
		ctx.room.handle(a, { t: "PICK", item: theBall().id });
		ctx.room.handle(a, { t: "THROW", dir: [1, 0] });
		expect(theBall().pos).toEqual([-3.5, -10]);
		ctx.clock.advance(2000);
		const me = ctx.room.memberFor(a);
		if (me) me.move = { kind: "idle", pos: [-4, -10], at: ctx.clock.now() };
		ctx.room.handle(a, { t: "PICK", item: theBall().id });
		ctx.room.handle(a, { t: "DROP" });
		expect(theBall()).toMatchObject({ pos: [-4, -10] });
		expect(theBall().holder).toBeUndefined();
		ctx.room.handle(a, { t: "PICK", item: theBall().id });
		ctx.room.leave(a);
		expect(theBall().holder).toBeUndefined();
		const c = conn("c");
		ctx.room.join(c, human("carol"));
		const w = c.inbox[0] as Extract<HostToClient, { t: "WELCOME" }>;
		expect(w.items?.[0]?.id).toBe(theBall().id);
	});

	test("things held by someone who is gone lie where they were", () => {
		ctx.room.loadItems([{ id: "i_x", kind: "box", pos: [1, 1], holder: "h_gone" }]);
		expect(ctx.room.itemList).toEqual([{ id: "i_x", kind: "box", pos: [1, 1] }]);
	});
});

describe("shops", () => {
	const shop = {
		id: "seven",
		name: "セブンイレブン",
		currency: "銅貨",
		counter: [10, 10] as Vec2,
		goods: [
			{ id: "onigiri", name: "おにぎり", price: 3, color: "#ffffff", food: true },
			{ id: "novel", name: "小説", price: 8, color: "#2a6f97" },
		],
	};
	let saved: [string, number][];
	beforeEach(() => {
		saved = [];
		ctx = setup({ shops: [shop] }, undefined, { add: (id, d) => saved.push([id, d]) });
		ctx.room.loadItems(undefined);
	});
	const rich = (id: string) => human(id, { coins: 1000 });

	test("bought at the counter it is in your hand for everyone to see; food is eaten and gone", () => {
		const a = conn("a");
		const b = conn("b");
		place(a, rich("alice"), [9, 10]);
		place(b, rich("bob"), [12, 12]);
		ctx.room.handle(a, { t: "BUY", shop: "seven", goods: "onigiri" });
		expect(last(b)).toMatchObject({
			t: "ITEM",
			item: { kind: "goods", holder: "h_alice", goods: { id: "onigiri", name: "おにぎり", food: true } },
		});
		// one thing in hand at a time
		ctx.room.handle(a, { t: "BUY", shop: "seven", goods: "novel" });
		expect(last(a)).toMatchObject({ t: "NOTICE", kind: "rejected" });
		const id = (ctx.room.itemList[0] as Item).id;
		ctx.room.handle(a, { t: "USE" });
		expect(last(b)).toEqual({ t: "ITEM_GONE", id, by: "h_alice" });
		expect(ctx.room.itemList).toEqual([]);
		// a book is not eaten; it can be put down like anything else
		ctx.room.handle(a, { t: "BUY", shop: "seven", goods: "novel" });
		ctx.room.handle(a, { t: "USE" });
		expect(last(a)).toMatchObject({ t: "NOTICE", message: "それは食べられません" });
		ctx.room.handle(a, { t: "DROP" });
		expect(ctx.room.itemList[0]).toMatchObject({ kind: "goods", pos: [9, 10] });
	});

	test("far from the counter, or what the shop does not sell: nothing is bought", () => {
		const a = conn("a");
		place(a, rich("alice"), [-10, -10]);
		ctx.room.handle(a, { t: "BUY", shop: "seven", goods: "onigiri" });
		expect(last(a)).toMatchObject({ t: "NOTICE", message: "お店のカウンターまで行ってください" });
		place(a, rich("alice"), [10, 11]);
		ctx.room.handle(a, { t: "BUY", shop: "seven", goods: "umbrella" });
		ctx.room.handle(a, { t: "BUY", shop: "books", goods: "onigiri" });
		expect(ctx.room.itemList).toEqual([]);
	});

	test("bought things lying about are tidied away beyond MAX_GOODS, oldest first", () => {
		const a = conn("a");
		const b = conn("b");
		place(a, rich("alice"), [10, 11]);
		place(b, rich("bob"), [12, 12]);
		for (let i = 0; i < 31; i++) {
			ctx.clock.advance(2000);
			ctx.room.handle(a, { t: "BUY", shop: "seven", goods: "novel" });
			ctx.room.handle(a, { t: "DROP" });
		}
		const gone = b.inbox.filter((m) => m.t === "ITEM_GONE");
		expect(gone).toHaveLength(1);
		expect(ctx.room.itemList).toHaveLength(30);
	});
});

describe("wallets, work and study", () => {
	const shop = {
		id: "bakery",
		name: "パン屋",
		currency: "銅貨",
		counter: [10, 10] as Vec2,
		goods: [{ id: "baguette", name: "バゲット", price: 3, color: "#d4a056", food: true }],
	};
	const sq = (x0: number, z0: number, x1: number, z1: number): Vec2[] => [
		[x0, z0],
		[x1, z0],
		[x1, z1],
		[x0, z1],
	];
	const jobZones = [
		{ id: "work_bakery", kind: "work" as const, name: "パン屋", poly: sq(8, 8, 14, 14) },
		{ id: "study_library", kind: "study" as const, name: "図書館", poly: sq(-14, 8, -8, 14) },
	];
	let saved: [string, number][];
	beforeEach(() => {
		saved = [];
		ctx = setup({ shops: [shop], jobZones }, undefined, { add: (id, d) => saved.push([id, d]) });
		ctx.room.loadItems(undefined);
	});
	const wallet = (c: Conn) => c.inbox.filter((m) => m.t === "WALLET").at(-1);

	test("expiry pays and persists before announcing departure, only once", () => {
		const events: string[] = [];
		ctx = setup(
			{ jobZones },
			undefined,
			{ add: (id, delta) => events.push(`wallet:${id}:${delta}`) },
			(c) => events.push(`persist:${c.name}`),
			(c, m) => events.push(`send:${c.name}:${m.t}`),
		);
		const a = conn("a");
		const b = conn("b");
		place(a, human("alice", { coins: 100 }), [11, 11]);
		place(b, human("bob"), [-10, -10]);
		ctx.room.handle(a, { t: "JOB", kind: "work" });
		ctx.room.dropped(a);
		ctx.clock.advance(60_000);
		events.length = 0;
		ctx.room.expireAway();
		ctx.room.leave(a);
		ctx.room.expireAway();
		expect(events).toEqual(["wallet:h_alice:1", "persist:a", "send:a:WALLET", "send:b:LEFT"]);
	});

	test("away members remain eligible for job payments during a sweep", () => {
		const a = conn("a");
		place(a, human("alice", { coins: 100 }), [11, 11]);
		ctx.room.handle(a, { t: "JOB", kind: "work" });
		ctx.clock.advance(60_000);
		ctx.room.dropped(a);
		ctx.room.sweep(() => ctx.clock.now());
		expect(ctx.room.has("h_alice")).toBe(true);
		expect(saved).toEqual([["h_alice", 1]]);
	});

	test("the wallet is told on joining; buying takes the price, and too little buys nothing", () => {
		const a = conn("a");
		ctx.room.join(a, human("alice", { coins: 5 }));
		expect(wallet(a)).toEqual({ t: "WALLET", coins: 5 });
		const me = ctx.room.memberFor(a);
		if (me) me.move = { kind: "idle", pos: [10, 11], at: ctx.clock.now() };
		ctx.room.handle(a, { t: "BUY", shop: "bakery", goods: "baguette" });
		expect(wallet(a)).toEqual({ t: "WALLET", coins: 2, change: -3, why: "buy" });
		expect(saved).toEqual([["h_alice", -3]]);
		ctx.room.handle(a, { t: "USE" });
		ctx.room.handle(a, { t: "BUY", shop: "bakery", goods: "baguette" });
		expect(last(a)).toMatchObject({ t: "NOTICE", kind: "rejected" });
		expect((last(a) as { message: string }).message).toContain("1枚足りません");
		expect(ctx.room.itemList).toEqual([]);
		// someone with no wallet (D1 could not be read) cannot buy
		const b = conn("b");
		place(b, human("bob"), [10, 11]);
		ctx.room.handle(b, { t: "BUY", shop: "bakery", goods: "baguette" });
		expect(last(b)).toMatchObject({ t: "NOTICE", message: "お財布が見つかりません（入り直してください）" });
	});

	test("working earns a coin a minute while there; walking out ends it and pays what was earned", () => {
		const a = conn("a");
		const b = conn("b");
		place(a, human("alice", { coins: 100 }), [11, 11]);
		place(b, human("bob", { coins: 100 }), [-10, -10]);
		ctx.room.handle(a, { t: "JOB", kind: "study" });
		expect(last(a)).toMatchObject({ t: "NOTICE", kind: "rejected" });
		ctx.room.handle(a, { t: "JOB", kind: "work" });
		expect(last(b)).toEqual({ t: "JOBBED", id: "h_alice", job: "work" });
		const c = conn("c");
		ctx.room.join(c, human("carol"));
		const w = c.inbox[0] as Extract<HostToClient, { t: "WELCOME" }>;
		expect(w.avatars.find((s) => s.id === "h_alice")?.job).toBe("work");
		// paid as the room sweeps (every minute), one coin per full minute
		ctx.clock.advance(150_000);
		ctx.room.sweep(() => ctx.clock.now());
		expect(wallet(a)).toEqual({ t: "WALLET", coins: 102, change: 2, why: "work" });
		ctx.clock.advance(40_000);
		// walking out of the shop: what was earned since is paid, and the work ends
		ctx.room.handle(a, {
			t: "MOVE_PATH",
			path: [
				[11, 11],
				[11, 6],
			],
			speed: 1.4,
			seq: 1,
		});
		expect(wallet(a)).toEqual({ t: "WALLET", coins: 103, change: 1, why: "work" });
		expect(last(b)).toEqual({ t: "JOBBED", id: "h_alice", job: null });
		expect(saved).toEqual([
			["h_alice", 2],
			["h_alice", 1],
		]);
	});

	test("studying at the library earns the same; leaving the area pays up", () => {
		const a = conn("a");
		place(a, ai("hal", "kazu", { coins: 100 }), [-11, 11]);
		ctx.room.handle(a, { t: "JOB", kind: "study" });
		const m = ctx.room.memberFor(a);
		expect(m && ctx.room.contextFor(m)).toMatchObject({ coins: 100, job: "study", canJob: ["study"] });
		ctx.clock.advance(61_000);
		ctx.room.leave(a);
		expect(saved).toEqual([["a_hal", 1]]);
	});
});

describe("walking with your AIs", () => {
	test("they come to your side, walk along beside you to the right of where you go, and do not wander", () => {
		const a = conn("a");
		const bot = conn("bot");
		place(a, human("alice"), [-10, -10]);
		place(bot, ai("bot", "alice"), [-14, -12]);
		const w = (() => {
			const c = conn("c");
			ctx.room.join(c, human("carol"));
			return c.inbox[0] as Extract<HostToClient, { t: "WELCOME" }>;
		})();
		expect(w.avatars.find((x) => x.id === "a_bot")?.ownerId).toBe("h_alice");
		ctx.room.handle(a, { t: "COMPANION", on: true });
		// standing, facing +z (nothing walked yet): at her right (-x), a little forward
		const first = last(a);
		expect(first).toMatchObject({ t: "MOVED", id: "a_bot", move: { kind: "path" } });
		const end = (m: HostToClient | undefined) =>
			m?.t === "MOVED" && m.move.kind === "path" ? m.move.path.at(-1) : null;
		const near = end(first) ?? [0, 0];
		expect(near[0]).toBeCloseTo(-10.8, 3);
		expect(near[1]).toBeCloseTo(-9.85, 3);
		// alice walks 10 m along +z; the AI goes along, ending beside her on the right, and takes as long
		ctx.room.handle(a, {
			t: "MOVE_PATH",
			path: [
				[-10, -10],
				[-10, 0],
			],
			speed: 1.4,
			seq: 1,
		});
		const along = last(a);
		expect(end(along)?.[0]).toBeCloseTo(-10.9, 3);
		expect(end(along)?.[1]).toBeCloseTo(0.3, 3);
		// she is there and says she stopped: it comes to her side
		ctx.clock.advance((10 / 1.4) * 1000 + 100);
		ctx.room.handle(a, { t: "MOVE_VEL", pos: [-10, 0], dir: [0, 0], speed: 0, seq: 2 });
		const close = last(a);
		expect(end(close)?.[0]).toBeCloseTo(-10.8, 3);
		expect(end(close)?.[1]).toBeCloseTo(0.15, 3);
		// its own steps are not taken meanwhile
		bot.inbox.length = 0;
		ctx.room.handle(bot, {
			t: "MOVE_PATH",
			path: [
				[-10.8, -8],
				[10, 10],
			],
			speed: 1.4,
			seq: 1,
		});
		expect(bot.inbox.map((m) => m.t)).toEqual(["CORRECT"]);
		// company off: it walks on its own again
		ctx.room.handle(a, { t: "COMPANION", on: false });
		ctx.clock.advance(20_000);
		const at = ctx.room.positionOf(ctx.room.memberFor(bot) as never);
		ctx.room.handle(bot, { t: "MOVE_PATH", path: [at, [-15, 15]], speed: 1.4, seq: 2 });
		expect(last(a)).toMatchObject({ t: "MOVED", id: "a_bot", move: { kind: "path" } });
	});

	const moveOf = (c: Conn) => (ctx.room.memberFor(c) as Member).move;
	const posOf = (c: Conn, t = ctx.clock.now()) => poseAt(moveOf(c), t).pos;
	/** How close two come to each other in the next `ms`, as they are moving now (from `skip` ms on). */
	function leastApart(a: Conn, b: Conn, ms: number, skip = 0): number {
		const t0 = ctx.clock.now();
		let least = Number.POSITIVE_INFINITY;
		for (let t = skip; t <= ms; t += 100) least = Math.min(least, dist(posOf(a, t0 + t), posOf(b, t0 + t)));
		return least;
	}
	/** Sideways (x) from `b`, of `a`, when both walk along z. */
	const sideways = (a: Conn, b: Conn, t = ctx.clock.now()) => Math.abs(posOf(a, t)[0] - posOf(b, t)[0]);
	function company(...at: Vec2[]) {
		const a = conn("a");
		place(a, human("alice"), [-10, -10]);
		const bots = at.map((pos, i) => {
			const bot = conn(`bot${i}`);
			place(bot, ai(`bot${i}`, "alice", { ownerAgentLimit: 5 }), pos);
			return bot;
		});
		return { a, bots };
	}

	test("three AIs each have a place of their own, walking and standing, and nobody overlaps", () => {
		const { a, bots } = company([-11, -10], [-9, -10], [-11, -11]);
		ctx.room.handle(a, { t: "COMPANION", on: true });
		const pairs: [Conn, Conn][] = [
			[a, bots[0] as Conn],
			[a, bots[1] as Conn],
			[a, bots[2] as Conn],
			[bots[0] as Conn, bots[1] as Conn],
			[bots[0] as Conn, bots[2] as Conn],
			[bots[1] as Conn, bots[2] as Conn],
		];
		ctx.clock.advance(5000);
		for (const [x, y] of pairs) expect(dist(posOf(x), posOf(y))).toBeGreaterThanOrEqual(COMPANY_GAP);
		const here = posOf(a);
		ctx.room.handle(a, { t: "MOVE_PATH", path: [here, [here[0], 15]], speed: 1.4, seq: 1 });
		for (const [x, y] of pairs) expect(leastApart(x, y, 17_000)).toBeGreaterThanOrEqual(COMPANY_GAP);
		ctx.clock.advance(18_000);
		ctx.room.handle(a, { t: "MOVE_VEL", pos: posOf(a), dir: [0, 0], speed: 0, seq: 2 });
		for (const [x, y] of pairs) expect(leastApart(x, y, 3000)).toBeGreaterThanOrEqual(COMPANY_GAP);
	});

	test("walking towards where the AI stands, it gets out to the side at once, not in line with its owner", () => {
		// the AI stands straight ahead of alice, on the way she is about to walk
		const { a, bots } = company([-10, -8.5]);
		const bot = bots[0] as Conn;
		ctx.room.handle(a, { t: "COMPANION", on: true });
		ctx.clock.advance(4000);
		(ctx.room.memberFor(bot) as Member).move = { kind: "idle", pos: [-10, -8.5], at: ctx.clock.now() };
		ctx.room.handle(a, {
			t: "MOVE_PATH",
			path: [
				[-10, -10],
				[-10, 15],
			],
			speed: 1.4,
			seq: 1,
		});
		expect(leastApart(a, bot, 17_000)).toBeGreaterThanOrEqual(COMPANY_GAP);
		const t0 = ctx.clock.now();
		// out at its side within two seconds, and there the whole way
		for (const t of [2000, 5000, 9000, 15_000]) expect(sideways(bot, a, t0 + t)).toBeGreaterThan(0.75);
	});

	test("the same with keys", () => {
		const { a, bots } = company([-10, -8.5]);
		const bot = bots[0] as Conn;
		ctx.room.handle(a, { t: "COMPANION", on: true });
		ctx.clock.advance(4000);
		(ctx.room.memberFor(bot) as Member).move = { kind: "idle", pos: [-10, -8.5], at: ctx.clock.now() };
		ctx.room.handle(a, { t: "MOVE_VEL", pos: [-10, -10], dir: [0, 1], speed: 1.4, seq: 1 });
		const t0 = ctx.clock.now();
		expect(leastApart(a, bot, 6000)).toBeGreaterThanOrEqual(COMPANY_GAP);
		expect(sideways(bot, a, t0 + 2000)).toBeGreaterThan(0.75);
	});

	test("the owner turning back: the AI keeps to the side it is on and does not cross through them", () => {
		const { a, bots } = company([-11, -10]);
		const bot = bots[0] as Conn;
		ctx.room.handle(a, { t: "COMPANION", on: true });
		ctx.clock.advance(3000);
		ctx.room.handle(a, { t: "MOVE_VEL", pos: [-10, -10], dir: [0, 1], speed: 1.4, seq: 1 });
		ctx.clock.advance(4000);
		// back the way she came
		ctx.room.handle(a, { t: "MOVE_VEL", pos: posOf(a), dir: [0, -1], speed: 1.4, seq: 2 });
		expect(leastApart(a, bot, 3000)).toBeGreaterThanOrEqual(COMPANY_GAP);
		const t0 = ctx.clock.now();
		// (it was on her right, -x; going back, that is her left)
		expect(posOf(bot, t0 + 2500)[0]).toBeLessThan(posOf(a, t0 + 2500)[0] - 0.5);
	});

	test("with a wall on its side it walks on the other side; in a passage too narrow it comes behind", () => {
		// a passage along z: wide at first (x in [-3, 3]), then only 0.4 m wide further on (z > 0)
		const passage: Walkable = {
			isWalkable: (p) => Math.abs(p[1]) <= 20 && (p[1] <= 0 ? Math.abs(p[0]) <= 3 : Math.abs(p[0]) <= 0.2),
			validatePath: (path) =>
				path.every((p, i) => {
					if (!passage.isWalkable(p)) return false;
					const prev = path[i - 1];
					if (!prev) return true;
					for (let f = 0.1; f < 1; f += 0.1)
						if (!passage.isWalkable([prev[0] + (p[0] - prev[0]) * f, prev[1] + (p[1] - prev[1]) * f]))
							return false;
					return true;
				}),
			closestPoint: (p) => [Math.max(-0.2, Math.min(0.2, p[0])), p[1]],
		};
		ctx = setup({ walk: passage, spawn: [0, -15] });
		const a = conn("a");
		const bot = conn("bot");
		place(a, human("alice"), [2.5, -15]);
		place(bot, ai("bot", "alice"), [1.5, -15]);
		ctx.room.handle(a, { t: "COMPANION", on: true });
		ctx.clock.advance(3000);
		// along the wall on her left (+x): it is on her left... so it has to be on her right
		const start = posOf(a);
		ctx.room.handle(a, { t: "MOVE_PATH", path: [start, [2.5, -5]], speed: 1.4, seq: 1 });
		const t0 = ctx.clock.now();
		expect(posOf(bot, t0 + 5000)[0]).toBeLessThan(2);
		expect(leastApart(a, bot, 7000)).toBeGreaterThanOrEqual(COMPANY_GAP);
		ctx.clock.advance(8000);
		// now into the narrow part
		ctx.room.handle(a, { t: "MOVE_VEL", pos: posOf(a), dir: [0, 0], speed: 0, seq: 2 });
		ctx.clock.advance(3000);
		ctx.room.handle(a, {
			t: "MOVE_PATH",
			path: [posOf(a), [0, -1], [0, 15]],
			speed: 1.4,
			seq: 3,
		});
		const t1 = ctx.clock.now();
		const walked = polylineLength(
			moveOf(a).kind === "path" ? (moveOf(a) as Extract<MoveState, { kind: "path" }>).path : [],
		);
		const ends = (walked / 1.4) * 1000;
		// it does not overlap her anywhere, and in the passage it is behind her
		expect(leastApart(a, bot, ends, 500)).toBeGreaterThanOrEqual(COMPANY_GAP);
		expect(posOf(bot, t1 + ends - 500)[1]).toBeLessThan(posOf(a, t1 + ends - 500)[1]);
	});

	test("walking on with keys the AI keeps walking beside them, however long the keys stay as they are", () => {
		const { a, bots } = company([-11, -10]);
		const bot = bots[0] as Conn;
		ctx.room.handle(a, { t: "COMPANION", on: true });
		ctx.clock.advance(3000);
		ctx.room.handle(a, { t: "MOVE_VEL", pos: [-10, -10], dir: [0, 1], speed: 1.4, seq: 1 });
		// (the way ahead is clear for 25 m: it is told how to go on from there before it stops)
		let now = ctx.clock.now();
		const end = now + 17_000;
		while (now < end) {
			const wake = ctx.room.wakeAt as number;
			expect(wake).toBeGreaterThan(now);
			const next = Math.min(wake, end);
			ctx.clock.advance(next - now);
			ctx.room.sweep(() => ctx.clock.now());
			now = next;
			expect(dist(posOf(a), posOf(bot))).toBeLessThan(1.5);
		}
		expect(dist(posOf(a), posOf(bot))).toBeGreaterThanOrEqual(COMPANY_GAP);
		// stopped: nothing more to wake up for
		ctx.room.handle(a, { t: "MOVE_VEL", pos: posOf(a), dir: [0, 0], speed: 0, seq: 2 });
		expect(ctx.room.wakeAt).toBeUndefined();
	});

	test("a step of its own is refused if another of the owner's AIs is right there", () => {
		const { a, bots } = company([-11, -10], [-9, -10]);
		ctx.room.handle(a, { t: "COMPANION", on: true });
		ctx.clock.advance(6000);
		const [one, two] = bots as [Conn, Conn];
		two.inbox.length = 0;
		ctx.room.handle(two, { t: "MOVE_PATH", path: [posOf(two), posOf(one)], speed: 1, seq: 1 });
		expect(two.inbox.map((m) => m.t)).toEqual(["CORRECT"]);
	});
});

describe("an AI taking its owner somewhere", () => {
	const lead: Extract<ClientToHost, { t: "LEAD" }> = {
		t: "LEAD",
		to: [-10, 12],
		place: "公園",
		text: "公園に行ってみない？",
	};
	function together() {
		const a = conn("a");
		const bot = conn("bot");
		place(a, human("alice"), [-10, -10]);
		place(bot, ai("bot", "alice"), [-12, -10]);
		return { a, bot };
	}

	test("it asks while walking with its owner; on a yes it leads there and walks beside them again after", () => {
		const { a, bot } = together();
		ctx.room.handle(bot, lead);
		expect(last(bot)).toMatchObject({ t: "NOTICE", kind: "rejected" });
		ctx.room.handle(a, { t: "COMPANION", on: true });
		expect(bot.inbox).toContainEqual({ t: "COMPANY", owner: "h_alice", on: true });
		ctx.clock.advance(3000);
		a.inbox.length = 0;
		ctx.room.handle(bot, lead);
		expect(last(a)).toEqual({
			t: "LEAD_OFFERED",
			from: "a_bot",
			to: [-10, 12],
			place: "公園",
			text: lead.text,
		});
		// one ask a minute
		ctx.room.handle(bot, lead);
		expect(last(bot)).toMatchObject({ t: "NOTICE", kind: "rejected" });
		a.inbox.length = 0;
		bot.inbox.length = 0;
		ctx.room.handle(a, { t: "ANSWER", to: "a_bot", accept: true });
		expect(bot.inbox[0]).toMatchObject({ t: "LEAD_ANSWERED", by: "h_alice", accept: true, place: "公園" });
		expect(a.inbox.map((m) => m.t)).toEqual(["MOVED", "LEADING"]);
		expect(a.inbox[0]).toMatchObject({ id: "a_bot", move: { kind: "path", path: expect.any(Array) } });
		const moved = a.inbox[0] as Extract<HostToClient, { t: "MOVED" }>;
		expect(moved.move.kind === "path" && moved.move.path.at(-1)).toEqual([-10, 12]);
		expect(a.inbox[1]).toEqual({ t: "LEADING", by: "a_bot", to: [-10, 12], place: "公園" });
		// alice follows behind: it keeps going its own way, not to her side
		ctx.clock.advance(2000);
		a.inbox.length = 0;
		const here = ctx.room.positionOf(ctx.room.memberFor(a) as never);
		ctx.room.handle(a, { t: "MOVE_PATH", path: [here, [-10, -6]], speed: 1.4, seq: 1 });
		expect(a.inbox.filter((m) => m.t === "MOVED" && m.id === "a_bot")).toEqual([]);
		// there: her page says so, and it comes to her side again
		ctx.room.handle(a, { t: "COMPANION", on: true });
		expect(last(a)).toMatchObject({ t: "MOVED", id: "a_bot", move: { kind: "path" } });
	});

	test("a no, a late answer, or someone else's answer leaves it beside its owner", () => {
		const { a, bot } = together();
		const c = conn("c");
		place(c, human("carol"), [-8, -10]);
		ctx.room.handle(a, { t: "COMPANION", on: true });
		ctx.room.handle(bot, lead);
		bot.inbox.length = 0;
		ctx.room.handle(c, { t: "ANSWER", to: "a_bot", accept: true });
		expect(bot.inbox).toEqual([]);
		ctx.room.handle(a, { t: "ANSWER", to: "a_bot", accept: false });
		expect(bot.inbox).toEqual([{ t: "LEAD_ANSWERED", by: "h_alice", accept: false, place: "公園" }]);
		ctx.clock.advance(61_000);
		ctx.room.handle(bot, lead);
		ctx.clock.advance(16_000);
		bot.inbox.length = 0;
		a.inbox.length = 0;
		ctx.room.handle(a, { t: "ANSWER", to: "a_bot", accept: true });
		expect(bot.inbox).toEqual([]);
		expect(a.inbox).toEqual([]);
	});

	test("somewhere right here, or with the owner far off, is not asked; the owner leaving ends the company", () => {
		const { a, bot } = together();
		ctx.room.handle(a, { t: "COMPANION", on: true });
		ctx.room.handle(bot, { ...lead, to: [-11, -8] });
		expect(last(bot)).toMatchObject({ t: "NOTICE", kind: "rejected", message: "そこはすぐそばです" });
		bot.inbox.length = 0;
		ctx.room.leave(a);
		expect(bot.inbox).toContainEqual({ t: "COMPANY", owner: "h_alice", on: false });
	});
});

describe("an AI moving its own body", () => {
	const pat: Extract<ClientToHost, { t: "BODY" }> = {
		t: "BODY",
		to: "h_alice",
		keys: [{ at: 1, right: { part: "head", of: "you" } }],
	};

	test("with its owner standing still it steps about close by, and pats their head when near", () => {
		const a = conn("a");
		const bot = conn("bot");
		place(a, human("alice"), [-10, -10]);
		place(bot, ai("bot", "alice"), [-12, -10]);
		ctx.room.handle(a, { t: "COMPANION", on: true });
		ctx.clock.advance(3000);
		// it steps 2 m off: too far to touch
		ctx.room.handle(bot, {
			t: "MOVE_PATH",
			path: [ctx.room.positionOf(ctx.room.memberFor(bot) as never), [-12, -10]],
			speed: 1.4,
			seq: 1,
		});
		ctx.clock.advance(3000);
		ctx.room.handle(bot, pat);
		expect(last(bot)).toMatchObject({ t: "NOTICE", kind: "rejected" });
		// it steps up to 40 cm in front of her by itself
		const here = ctx.room.positionOf(ctx.room.memberFor(bot) as never);
		bot.inbox.length = 0;
		ctx.room.handle(bot, { t: "MOVE_PATH", path: [here, [-10, -9.6]], speed: 1.4, seq: 2 });
		expect(bot.inbox.map((m) => m.t)).toEqual(["MOVED"]);
		ctx.clock.advance(2000);
		a.inbox.length = 0;
		ctx.room.handle(bot, pat);
		expect(last(a)).toEqual({
			t: "BODIED",
			id: "a_bot",
			keys: pat.keys,
			to: "h_alice",
			at: ctx.clock.now() + 100,
		});
		// not more than one a second
		bot.inbox.length = 0;
		ctx.room.handle(bot, pat);
		expect(last(bot)).toMatchObject({ t: "NOTICE", kind: "rejected" });
		// it may not wander off more than a few metres from her
		ctx.clock.advance(1000);
		bot.inbox.length = 0;
		ctx.room.handle(bot, {
			t: "MOVE_PATH",
			path: [
				[-10, -9.6],
				[-10, -6],
			],
			speed: 1.4,
			seq: 2,
		});
		expect(bot.inbox.map((m) => m.t)).toEqual(["CORRECT"]);
	});

	test("a hand touches only its own owner, and only some parts; looking at anyone close is fine", () => {
		const a = conn("a");
		const c = conn("c");
		const bot = conn("bot");
		place(a, human("alice"), [-10, -10]);
		place(c, human("carol"), [-10.5, -10]);
		place(bot, ai("bot", "alice"), [-10, -10.4]);
		ctx.room.handle(bot, { ...pat, to: "h_carol" });
		expect(last(bot)).toMatchObject({ t: "NOTICE", message: "手で触れられるのは自分のオーナーだけです" });
		ctx.clock.advance(1000);
		ctx.room.handle(bot, { t: "BODY", to: "h_alice", keys: [{ at: 1, left: { part: "face", of: "you" } }] });
		expect(last(bot)).toMatchObject({ t: "NOTICE", message: "face には触れられません" });
		ctx.clock.advance(1000);
		ctx.room.handle(bot, { t: "BODY", keys: [{ at: 1, look: { part: "face", of: "you" } }] });
		expect(last(bot)).toMatchObject({ t: "NOTICE", kind: "rejected" });
		ctx.clock.advance(1000);
		c.inbox.length = 0;
		const wave: Extract<ClientToHost, { t: "BODY" }> = {
			t: "BODY",
			to: "h_carol",
			keys: [
				{
					at: 0.5,
					look: { part: "face", of: "you" },
					right: { part: "front", off: [0.2, 0.5, 0], wiggle: { dir: "side", size: 0.1, hz: 2 } },
				},
			],
		};
		ctx.room.handle(bot, wave);
		expect(last(c)).toMatchObject({ t: "BODIED", id: "a_bot", to: "h_carol" });
	});

	test("an owner pats their own AI: it is brought up to them first; nobody else's AI, and not from far", () => {
		const a = conn("a");
		const c = conn("c");
		const bot = conn("bot");
		place(a, human("alice"), [-10, -10]);
		place(c, human("carol"), [-8, -10]);
		place(bot, ai("bot", "alice"), [-12, -10]);
		const pat: Extract<ClientToHost, { t: "BODY" }> = {
			t: "BODY",
			to: "a_bot",
			keys: [{ at: 1, right: { part: "head", of: "you", wiggle: { dir: "side", size: 0.04, hz: 1 } } }],
		};
		ctx.room.handle(c, pat);
		expect(last(c)).toMatchObject({ t: "NOTICE", message: "手で触れられるのは自分のAIだけです" });
		bot.inbox.length = 0;
		ctx.room.handle(a, pat);
		// two metres off: it walks up to 45 cm in front of her, and the pat starts once it is there
		const moved = bot.inbox.find((m) => m.t === "MOVED") as Extract<HostToClient, { t: "MOVED" }>;
		expect(moved.move).toMatchObject({
			kind: "path",
			path: [
				[-12, -10],
				[-10.45, -10],
			],
		});
		const bodied = bot.inbox.find((m) => m.t === "BODIED");
		expect(bodied).toMatchObject({
			id: "h_alice",
			to: "a_bot",
			at: ctx.clock.now() + (1.55 / 1.4) * 1000 + 200,
		});
		ctx.clock.advance(5000);
		// it wandered off four metres and more: too far to call
		const botMember = ctx.room.memberFor(bot);
		if (botMember) botMember.move = { kind: "idle", pos: [-16, -10], at: ctx.clock.now() };
		ctx.room.handle(a, pat);
		expect(last(a)).toMatchObject({ t: "NOTICE", message: "自分のAIのそばへ行ってください" });
	});

	test("standing, it turns a way of its own and keeps to it, even by its owner; sitting down keeps it too", () => {
		const a = conn("a");
		const bot = conn("bot");
		place(a, human("alice"), [-10, -10]);
		place(bot, ai("bot", "alice"), [-12, -10]);
		ctx.room.handle(a, { t: "COMPANION", on: true });
		ctx.clock.advance(3000);
		const here = ctx.room.positionOf(ctx.room.memberFor(bot) as never);
		a.inbox.length = 0;
		ctx.room.handle(bot, { t: "MOVE_VEL", pos: here, dir: [0, -1], speed: 0, seq: 1 });
		expect(last(a)).toMatchObject({ t: "MOVED", id: "a_bot", move: { kind: "idle", face: [0, -1] } });
		ctx.room.handle(bot, { t: "ACTION", motion: "sit" });
		expect(ctx.room.memberFor(bot)?.move).toMatchObject({ kind: "idle", posture: "sit", face: [0, -1] });
		// a turn is not a walk: one from somewhere else is not taken
		bot.inbox.length = 0;
		ctx.room.handle(bot, { t: "MOVE_VEL", pos: [here[0] + 1, here[1]], dir: [1, 0], speed: 0, seq: 2 });
		expect(types(bot)).toEqual(["CORRECT"]);
	});
});

describe("going through a portal", () => {
	test("your AIs walking with you are told to come along; not when they are on their own, nor others' AIs", () => {
		// (the room calls this when a page's connection closes with travelReason)
		const a = conn("a");
		const c = conn("c");
		const bot = conn("bot");
		const other = conn("other");
		place(a, human("alice"), [-10, -10]);
		place(c, human("carol"), [-8, -10]);
		place(bot, ai("bot", "alice"), [-12, -10]);
		place(other, ai("other", "carol"), [-9, -10]);
		ctx.room.travel(ctx.room.memberFor(a) as never, "venezia", "gate_main");
		expect(bot.inbox.filter((m) => m.t === "FOLLOW")).toEqual([]);
		ctx.room.handle(a, { t: "COMPANION", on: true });
		ctx.room.travel(ctx.room.memberFor(a) as never, "venezia", "gate_main");
		expect(bot.inbox.filter((m) => m.t === "FOLLOW")).toEqual([
			{ t: "FOLLOW", owner: "h_alice", to: "venezia", at: "gate_main" },
		]);
		expect(other.inbox.filter((m) => m.t === "FOLLOW")).toEqual([]);
	});
});

describe("floating and warping (docs/prd.md 3.4.13, 3.4.14)", () => {
	test("afloat a human moves straight over the building, and comes down on the ground nearest below", () => {
		ctx = setup({ fly: true });
		const a = conn("a");
		const b = conn("b");
		ctx.room.join(a, human("alice"));
		ctx.room.join(b, human("bob"));
		const welcome = b.inbox[0];
		const start = welcome?.t === "WELCOME" ? welcome.avatars.find((x) => x.id === "h_alice") : undefined;
		if (start?.move.kind !== "idle") throw new Error("not standing");
		const here = start.move.pos;
		ctx.room.handle(a, { t: "FLY", alt: 12 });
		expect(last(b)).toEqual({ t: "FLEW", id: "h_alice", alt: 12 });
		// into the building: fine afloat
		ctx.room.handle(a, { t: "MOVE_PATH", path: [here, [0, 0]], speed: 4, seq: 1 });
		expect(last(b)).toMatchObject({ t: "MOVED", id: "h_alice", move: { kind: "path" } });
		ctx.clock.advance(20_000);
		// down: not inside the building but on the ground nearest it
		ctx.room.handle(a, { t: "FLY", alt: null });
		expect(b.inbox.some((m) => m.t === "FLEW" && m.alt === null)).toBe(true);
		const moved = last(b);
		if (moved?.t !== "MOVED" || moved.move.kind !== "idle") throw new Error("no landing");
		expect(walk.isWalkable(moved.move.pos)).toBe(true);
		// on foot again the building blocks
		ctx.room.handle(a, { t: "MOVE_PATH", path: [moved.move.pos, [0, 0]], speed: 4, seq: 2 });
		expect(last(a)?.t).toBe("CORRECT");
	});

	test("not where the area does not allow it, and never for AIs", () => {
		const a = conn("a");
		ctx.room.join(a, human("alice"));
		ctx.room.handle(a, { t: "FLY", alt: 10 });
		expect(last(a)).toMatchObject({ t: "NOTICE", kind: "rejected" });
		ctx = setup({ fly: true });
		const x = conn("x");
		ctx.room.join(x, ai("x", "kazu"));
		ctx.room.handle(x, { t: "FLY", alt: 10 });
		expect(last(x)).toMatchObject({ t: "NOTICE", kind: "rejected" });
	});

	test("a warp puts you by a landmark at once, not too often", () => {
		const a = conn("a");
		const b = conn("b");
		ctx.room.join(a, human("alice"));
		ctx.room.join(b, human("bob"));
		const outwardRounding = vi.spyOn(Math, "random").mockReturnValueOnce(0.095).mockReturnValueOnce(0.999);
		try {
			ctx.room.handle(a, { t: "WARP", to: "cafe" });
		} finally {
			outwardRounding.mockRestore();
		}
		const moved = last(b);
		expect(moved?.t).toBe("MOVED");
		if (moved?.t !== "MOVED" || moved.move.kind !== "idle") throw new Error("no move");
		const maxWarpRadius = 3;
		const maxCoordinateRoundingError = 0.05;
		expect(Math.hypot(moved.move.pos[0] - 10, moved.move.pos[1] - 10)).toBeLessThanOrEqual(
			maxWarpRadius + Math.hypot(maxCoordinateRoundingError, maxCoordinateRoundingError),
		);
		ctx.room.handle(a, { t: "WARP", to: "cafe" });
		expect(last(a)).toMatchObject({ t: "NOTICE", kind: "rejected" });
		ctx.room.handle(a, { t: "WARP", to: "nowhere" });
		expect(last(a)).toMatchObject({ t: "NOTICE", kind: "rejected" });
	});
	test("the AIs walking with you come along at once", () => {
		const a = conn("a");
		const bot = conn("bot");
		place(a, human("alice"), [-10, -10]);
		place(bot, ai("bot", "alice"), [-14, -12]);
		ctx.room.handle(a, { t: "COMPANION", on: true });
		ctx.clock.advance(10_000);
		ctx.room.handle(a, { t: "WARP", to: "cafe" });
		const there = ctx.room.positionOf(ctx.room.memberFor(a) as never);
		const it = ctx.room.positionOf(ctx.room.memberFor(bot) as never);
		expect(Math.hypot(it[0] - there[0], it[1] - there[1])).toBeLessThan(1.2);
	});

	test("afloat one goes faster; on the ground no faster than a run", () => {
		ctx = setup({ fly: true });
		const a = conn("a");
		place(a, human("alice"), [-10, -10]);
		ctx.room.handle(a, { t: "MOVE_VEL", pos: [-10, -10], dir: [0, 1], speed: 15, seq: 1 });
		expect(last(a)).toMatchObject({ t: "MOVED", move: { kind: "vel", speed: 6 } });
		ctx.room.handle(a, { t: "FLY", alt: 10 });
		const here = ctx.room.positionOf(ctx.room.memberFor(a) as never);
		ctx.room.handle(a, { t: "MOVE_VEL", pos: here, dir: [0, 1], speed: 15, seq: 2 });
		expect(last(a)).toMatchObject({ t: "MOVED", move: { kind: "vel", speed: 15 } });
	});
});

describe("a move never cuts through a wall", () => {
	// the host thinks alice is just off the building's corner; her page thinks she is round it
	const here: Vec2 = [-5.3, 4.2];
	const there: Vec2 = [-4.2, 5.3];

	test("a path from where her page thinks she is: the way from where she is goes through, so no", () => {
		const a = conn("a");
		place(a, human("alice"), here);
		ctx.room.handle(a, {
			t: "MOVE_PATH",
			path: [there, [3, 5.3]],
			speed: 1.4,
			seq: 1,
		});
		expect(last(a)?.t).toBe("CORRECT");
	});

	test("walking with keys from there: no", () => {
		const a = conn("a");
		place(a, human("alice"), here);
		ctx.room.handle(a, { t: "MOVE_VEL", pos: there, dir: [1, 0], speed: 1.4, seq: 1 });
		expect(last(a)?.t).toBe("CORRECT");
		ctx.room.handle(a, { t: "MOVE_VEL", pos: [-5.4, 4.3], dir: [0, 1], speed: 1.4, seq: 2 });
		expect(last(a)).toMatchObject({ t: "MOVED", move: { kind: "vel" } });
	});
});

describe("movement publication order", () => {
	test("normal movement persists before broadcast and correction targets the sender", () => {
		const events: unknown[] = [];
		const { room } = setup(
			{},
			undefined,
			undefined,
			(c, m) => events.push({ persist: c.name, move: structuredClone(m.move) }),
			(c, m) => events.push({ send: c.name, message: structuredClone(m) }),
		);
		const a = conn("a");
		const b = conn("b");
		room.join(a, human("alice"));
		room.join(b, human("bob"));
		const alice = room.memberFor(a);
		if (!alice) throw new Error("alice did not join");
		const start = room.positionOf(alice);
		events.length = 0;
		room.handle(a, {
			t: "MOVE_PATH",
			path: [start, [-10, 10]],
			speed: 1.4,
			seq: 1,
		});
		expect(events).toMatchObject([
			{ persist: "a", move: { kind: "path" } },
			{ send: "a", message: { t: "MOVED", id: "h_alice" } },
			{ send: "b", message: { t: "MOVED", id: "h_alice" } },
		]);
		events.length = 0;
		room.handle(a, {
			t: "MOVE_PATH",
			path: [
				[15, 15],
				[16, 16],
			],
			speed: 1.4,
			seq: 2,
		});
		expect(events).toMatchObject([
			{ persist: "a", move: { kind: "idle" } },
			{ send: "a", message: { t: "CORRECT", move: { kind: "idle" } } },
			{ send: "b", message: { t: "MOVED", id: "h_alice", move: { kind: "idle" } } },
		]);
	});

	test("lifting from a posture broadcasts before persisting altitude", () => {
		const events: unknown[] = [];
		const { room } = setup(
			{ fly: true },
			undefined,
			undefined,
			(c, m) => events.push({ persist: c.name, member: structuredClone(m) }),
			(c, m) => events.push({ send: c.name, message: structuredClone(m) }),
		);
		const a = conn("a");
		room.join(a, human("alice"));
		room.handle(a, { t: "ACTION", motion: "lie" });
		events.length = 0;
		room.handle(a, { t: "FLY", alt: 12 });
		expect(events).toMatchObject([
			{ send: "a", message: { t: "MOVED", move: { kind: "idle" } } },
			{ persist: "a", member: { fly: 12, move: { kind: "idle" } } },
			{ send: "a", message: { t: "FLEW", alt: 12 } },
		]);
		expect(events[0]).not.toHaveProperty("message.move.posture");
	});

	test.each<{ name: string; pos: Vec2; walking: boolean }>([
		{ name: "walking to the seat", pos: [-11, -10], walking: true },
		{ name: "already at the seat", pos: [-9, -9.9], walking: false },
	])("seat approach while $name", ({ pos, walking }) => {
		const events: unknown[] = [];
		const bot = conn("bot");
		ctx = setup(
			{
				seats: [
					{ pos: [-10, -9.4], y: 0.46, face: [0, -1] },
					{ pos: [-9, -9.4], y: 0.46, face: [0, -1] },
				],
			},
			undefined,
			undefined,
			(c, m) => {
				if (c === bot) events.push({ persist: structuredClone(m) });
			},
			(c, m) => {
				if (c !== bot && m.t === "MOVED" && m.id === "a_bot")
					events.push({ message: structuredClone(m), member: structuredClone(ctx.room.memberFor(bot)) });
			},
		);
		const a = conn("a");
		place(a, human("alice"), [-10, -10]);
		place(bot, ai("bot", "alice"), pos);
		ctx.room.handle(a, { t: "COMPANION", on: true });
		const member = ctx.room.memberFor(bot);
		if (!member) throw new Error("not joined");
		member.move = { kind: "idle", pos, at: ctx.clock.now() };
		events.length = 0;
		ctx.room.handle(a, { t: "ACTION", motion: "sit", seat: 0 });
		if (walking) {
			expect(events).toMatchObject([
				{ message: { t: "MOVED", move: { kind: "path" } }, member: { move: { kind: "path" } } },
				{ persist: { move: { kind: "path" }, seatPlan: { seat: 1 } } },
			]);
			expect(events[0]).not.toHaveProperty("member.seatPlan");
		} else {
			expect(events).toMatchObject([{ persist: { move: { kind: "idle" }, seatPlan: { seat: 1 } } }]);
		}
	});
});
