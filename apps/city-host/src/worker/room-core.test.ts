import type { HostToClient, Vec2 } from "@rojibura/protocol";
import { AI_CONV_MAX_TURNS, PRESENCE_TIMEOUT_MS } from "@rojibura/protocol";
import { beforeEach, describe, expect, test } from "vitest";
import { type JoinInfo, RoomCore, type Walkable } from "./room-core.ts";

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

function setup() {
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
		},
		clock.now,
		() => String(++n),
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
