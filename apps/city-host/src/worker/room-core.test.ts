import type { ClientToHost, HostToClient, Item, Vec2 } from "@rojibura/protocol";
import { AI_CONV_MAX_TURNS, PRESENCE_TIMEOUT_MS } from "@rojibura/protocol";
import { beforeEach, describe, expect, test } from "vitest";
import { AWAY_GRACE_MS, type JoinInfo, RoomCore, type Walkable, type World } from "./room-core.ts";

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

function setup(extra: Partial<World> = {}, saved?: (items: Item[]) => void) {
	let now = 1_000_000;
	let n = 0;
	const clock = { now: () => now, advance: (ms: number) => (now += ms) };
	const room = new RoomCore<Conn>(
		{
			send: (c, m) => c.inbox.push(m),
			close: (c, code) => {
				c.closed = code;
			},
			persist: () => {},
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
		saved ? { items: { save: saved } } : {},
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

	test("someone whose socket closed while the room slept leaves when it wakes, unless they came back in", () => {
		const a = conn("a");
		const b = conn("b");
		ctx.room.join(a, human("alice"));
		ctx.room.join(b, human("bob"));
		const alice = structuredClone(ctx.room.members.get(a));
		const bob = structuredClone(ctx.room.members.get(b));
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
		const saved = structuredClone(ctx.room.members.get(bot));
		const bob = structuredClone(ctx.room.members.get(other));
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
	const me = ctx.room.members.get(c);
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
		const me = ctx.room.members.get(a);
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

describe("walking with your AIs", () => {
	test("they come up close, walk along a little ahead to the right of where you go, and do not wander", () => {
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
		// standing, facing +z (nothing walked yet): a metre off, in front to the right (-x)
		const first = last(a);
		expect(first).toMatchObject({ t: "MOVED", id: "a_bot", move: { kind: "path" } });
		const end = (m: HostToClient | undefined) =>
			m?.t === "MOVED" && m.move.kind === "path" ? m.move.path.at(-1) : null;
		const near = end(first) ?? [0, 0];
		expect(near[0]).toBeCloseTo(-10.42, 3);
		expect(near[1]).toBeCloseTo(-9.09, 3);
		expect(Math.hypot(near[0] + 10, near[1] + 10)).toBeCloseTo(1, 2);
		// alice walks 10 m along +z; the AI goes along, ending ahead to her right, and takes as long
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
		expect(end(along)?.[0]).toBeCloseTo(-10.8, 3);
		expect(end(along)?.[1]).toBeCloseTo(2, 3);
		// she is there and says she stopped: it comes back up close, in front of her
		ctx.clock.advance((10 / 1.4) * 1000 + 100);
		ctx.room.handle(a, { t: "MOVE_VEL", pos: [-10, 0], dir: [0, 0], speed: 0, seq: 2 });
		const close = last(a);
		expect(end(close)?.[0]).toBeCloseTo(-10.42, 3);
		expect(end(close)?.[1]).toBeCloseTo(0.91, 3);
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
		const at = ctx.room.positionOf(ctx.room.members.get(bot) as never);
		ctx.room.handle(bot, { t: "MOVE_PATH", path: [at, [-15, 15]], speed: 1.4, seq: 2 });
		expect(last(a)).toMatchObject({ t: "MOVED", id: "a_bot", move: { kind: "path" } });
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
		const here = ctx.room.positionOf(ctx.room.members.get(a) as never);
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
		// a metre from her: too far to touch
		ctx.room.handle(bot, pat);
		expect(last(bot)).toMatchObject({ t: "NOTICE", kind: "rejected" });
		// it steps up to 40 cm in front of her by itself
		const here = ctx.room.positionOf(ctx.room.members.get(bot) as never);
		bot.inbox.length = 0;
		ctx.room.handle(bot, { t: "MOVE_PATH", path: [here, [-10, -9.6]], speed: 1.4, seq: 1 });
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
});
