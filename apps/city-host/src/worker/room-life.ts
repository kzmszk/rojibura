import {
	ACTIVITY_REACH,
	type Activity,
	type AvatarId,
	activityOpen,
	COMPANY_MOOD_MS,
	cannotJob,
	cannotStart,
	canRun,
	cityMinutesOf,
	cityTime,
	type DayReview,
	decay,
	dist,
	EARN_MS,
	eatFood,
	FLY_RUN_SPEED,
	finishActivity,
	finishJob,
	type HostToClient,
	hoursText,
	ITEM_REACH,
	type Item,
	type ItemId,
	insidePolygon,
	type JobKind,
	type JobZone,
	type LifeState,
	MAX_GOODS,
	MAX_SPEED,
	newDay,
	newLife,
	POSITION_TOLERANCE,
	realMs,
	SHOP_REACH,
	THROW_MS,
	THROW_RANGE,
	THROW_RELEASE_MS,
	type Vec2,
	WALK_SPEED,
	withCompany,
} from "@rojibura/protocol";
import type { RoomMovement } from "./room-movement.ts";
import type { RoomSpace } from "./room-space.ts";
import type { ItemStore, LifeStore, Member, Transport, WalletStore, World } from "./room-types.ts";

interface LifePort<C> {
	movement: RoomMovement<C>;
	space: RoomSpace;
	clock(): number;
	newId(): string;
	memberValues(): IterableIterator<Member>;
	memberEntries(): IterableIterator<[C, Member]>;
	connectionFor(id: AvatarId): C | undefined;
	has(id: AvatarId): boolean;
	isAway(conn: C): boolean;
	accompanying(member: Member): boolean;
	broadcastAbout(member: Member, msg: HostToClient): void;
	broadcastAll(msg: HostToClient): void;
	notice(conn: C, kind: "rejected", message: string): void;
}
function round2(n: number): number {
	return Math.round(n * 100) / 100;
}
export class RoomLife<C> {
	private readonly items = new Map<ItemId, Item>();
	private readonly world: World;
	private readonly transport: Transport<C>;
	private readonly directTransport: Transport<C>;
	private readonly itemStore: ItemStore | undefined;
	private readonly lifeStore: LifeStore | undefined;
	private readonly wallets: WalletStore | undefined;
	private readonly port: LifePort<C>;
	constructor(
		world: World,
		transport: Transport<C>,
		directTransport: Transport<C>,
		stores: { items?: ItemStore; life?: LifeStore; wallets?: WalletStore },
		port: LifePort<C>,
	) {
		this.world = world;
		this.transport = transport;
		this.directTransport = directTransport;
		this.itemStore = stores.items;
		this.lifeStore = stores.life;
		this.wallets = stores.wallets;
		this.port = port;
	}
	loadItems(saved: Item[] | undefined): void {
		this.items.clear();
		const items: Item[] =
			saved ??
			(this.world.items ?? [])
				.filter((i) => this.port.space.terrain.isWalkable(i.pos))
				.map((i) => ({ id: `i_${this.port.newId()}`, kind: i.kind, pos: i.pos }));
		for (const item of items) {
			if (item.holder && !this.port.has(item.holder)) delete item.holder;
			this.items.set(item.id, item);
		}
	}
	get itemList(): Item[] {
		return [...this.items.values()];
	}
	saveLife(id: AvatarId, life: LifeState): void {
		this.lifeStore?.save(id, life);
	}
	leaveJob(m: Member): void {
		if (!m.job) return;
		this.payJob(m, this.port.clock(), this.directTransport);
		this.settleJob(m, this.port.clock(), false);
		delete m.job;
	}
	leaveActivity(conn: C, m: Member, now: number): void {
		if (m.doing) this.stopDoing(conn, m, now, false);
		else if (m.life) this.lifeStore?.save(m.id, decay(m.life, now));
	}
	dropHeld(m: Member): void {
		const held = this.holding(m.id);
		if (held) {
			delete held.holder;
			held.pos = this.port.space.positionOf(m);
			this.itemChanged(held);
		}
	}
	// ---- life: activities and the meters (docs/life.md) ----------------------

	private activity(id: string): Activity | undefined {
		return this.world.activities?.find((a) => a.id === id);
	}

	/**
	 * An AI's life as it comes in: where it left off (time away does not count), or a first day. On a new city
	 * day, the day it last lived is scored and it wakes up (`review`).
	 */
	lifeOnEntry(saved: LifeState | undefined, now: number): { life: LifeState; review?: DayReview } {
		if (!saved) return { life: newLife(now) };
		const life: LifeState = { ...saved, at: now };
		return cityTime(now).block !== saved.block ? newDay(life, now) : { life };
	}

	/** Starts activity `id` where `m` stands: they stop walking, and sit if it is done sitting. */
	startDoing(conn: C, m: Member, id: string, now: number): string | null {
		const a = this.activity(id);
		if (!a) return "ここではできないことです";
		const place = this.world.landmarks.find((l) => l.id === a.place);
		if (!place) return "ここではできないことです";
		if (dist(this.port.space.positionOf(m, now), place.pos) > ACTIVITY_REACH)
			return `${place.name}まで行ってからにしてください`;
		if (!activityOpen(a, cityTime(now).minutes))
			return `${a.name}は、いまの時間はできません（${hoursText(a)}）`;
		if (m.doing?.activity === a.id) return `もう${a.name}をしています`;
		const others = [...this.port.memberValues()].filter((o) => o.id !== m.id && o.doing?.activity === a.id);
		if (a.capacity !== undefined && others.length >= a.capacity) return `${a.name}は、いまいっぱいです`;
		if (m.life) {
			const err = cannotStart(decay(m.life, now), a);
			if (err) return err;
		}
		// it costs coins from the wallet, like a shop (the host's guide pays nothing)
		const cost = m.system ? 0 : (a.cost ?? 0);
		if (cost > 0) {
			if (m.coins === undefined) return "お財布が見つかりません（入り直してください）";
			if (m.coins < cost) return `銅貨が${cost - m.coins}枚足りません（働くか勉強すると増えます）`;
		}
		this.stopDoing(conn, m, now);
		if (m.job) this.stopJob(m, now);
		if (cost > 0) this.spend(m, -cost, "buy");
		if (m.life) m.life = decay(m.life, now);
		m.doing = { activity: a.id, since: now, until: now + Math.round(realMs(a.minutes)) };
		const face = m.move.kind === "idle" ? m.move.face : undefined;
		this.port.movement.commit(conn, m, {
			kind: "idle",
			pos: this.port.space.positionOf(m, now),
			at: now,
			...(a.pose ? { posture: a.pose } : {}),
			...(face ? { face } : {}),
		});
		this.port.broadcastAbout(m, { t: "ACTING", id: m.id, doing: m.doing });
		this.sendLife(m);
		return null;
	}

	/**
	 * Ends what `m` is doing: done once its time is up, otherwise stopped part way, with that share of its
	 * effects and pay. `tell`: false when they are leaving (nobody needs to hear, nothing to persist).
	 */
	stopDoing(conn: C, m: Member, now: number, tell = true): void {
		const d = m.doing;
		if (!d) return;
		delete m.doing;
		const a = this.activity(d.activity);
		const share = Math.min(1, Math.max(0, (now - d.since) / Math.max(1, d.until - d.since)));
		const done: Extract<HostToClient, { t: "ACT_DONE" }> = {
			t: "ACT_DONE",
			activity: d.activity,
			share: round2(share),
		};
		if (m.life && a) {
			const r = finishActivity(decay(m.life, now), a, share);
			m.life = r.life;
			done.delta = r.delta;
			done.life = r.life;
			this.lifeStore?.save(m.id, r.life);
		}
		if (!tell) return;
		this.transport.persist(conn, m);
		this.transport.send(conn, done);
		this.port.broadcastAbout(m, { t: "ACTING", id: m.id, doing: null });
		this.sendLife(m, false);
	}

	/** Activities whose time is up end; AIs whose city day is over wake up to a new one. */
	lifeTick(now: number): void {
		const block = cityTime(now).block;
		for (const [conn, m] of [...this.port.memberEntries()]) {
			if (this.port.isAway(conn)) continue;
			if (m.doing && m.doing.until <= now) this.stopDoing(conn, m, now);
			if (m.life && m.life.block !== block) {
				// the work done so far belongs to the day that ends
				if (m.job) this.settleJob(m, now, false);
				const { life, review } = newDay(decay(m.life, now), now);
				m.life = life;
				this.transport.persist(conn, m);
				this.lifeStore?.save(m.id, life);
				this.transport.send(conn, { t: "DAY", review, life });
				this.sendLife(m, false);
			}
			if (m.life) this.companyMood(conn, m, now);
			// too hungry to go on working or studying
			if (m.job && m.life) {
				const from = m.job.settled ?? m.job.since;
				const left = finishJob(decay(m.life, now), m.job.kind, cityMinutesOf(now - from)).life.energy;
				if (left <= 0) {
					this.stopJob(m, now);
					this.port.notice(conn, "rejected", "おなかがすいて、もう働けません。何か食べてください");
				}
			}
		}
	}

	/** Walking with its owner here, an AI feels better: COMPANY_MOOD for each COMPANY_MOOD_MS beside them. */
	private companyMood(conn: C, m: Member, now: number): void {
		if (!m.life || !this.port.accompanying(m)) {
			if (m.companyAt === undefined) return;
			delete m.companyAt;
			this.transport.persist(conn, m);
			return;
		}
		const since = m.companyAt ?? now;
		const life = withCompany(m.life, now - since);
		m.companyAt = since + Math.floor((now - since) / COMPANY_MOOD_MS) * COMPANY_MOOD_MS;
		this.transport.persist(conn, m);
		if (life === m.life || life.mood === m.life.mood) return;
		m.life = life;
		this.sendLife(m);
	}

	/** Tells an AI (`self`) and its owner here what its life is now. */
	sendLife(m: Member, self = true): void {
		if (!m.life) return;
		const msg: HostToClient = {
			t: "LIFE",
			id: m.id,
			life: m.life,
			...(m.coins !== undefined ? { coins: m.coins } : {}),
		};
		const own = this.port.connectionFor(m.id);
		if (self && own !== undefined) this.transport.send(own, msg);
		const owner = m.kind === "ai" ? this.port.connectionFor(m.ownerId) : undefined;
		if (owner !== undefined) this.transport.send(owner, msg);
	}

	/** On the ground no faster than MAX_SPEED (afloat, FLY_RUN_SPEED); an AI too hungry or unfit to run walks. */
	speedFor(m: Member, speed: number, now: number): number {
		const capped = Math.min(speed, m.fly !== undefined ? FLY_RUN_SPEED : MAX_SPEED);
		return m.life && capped > WALK_SPEED && !canRun(decay(m.life, now)) ? WALK_SPEED : capped;
	}

	/** How far a move may start from where the host thinks one is: further afloat, where one goes fast. */
	tolerance(m: Member): number {
		const speed = m.fly !== undefined && m.move.kind !== "idle" ? m.move.speed : 0;
		return POSITION_TOLERANCE + speed * 0.3;
	}

	// ---- small things (docs/prd.md 3.4.7) -----------------------------------

	private holding(id: AvatarId): Item | undefined {
		for (const item of this.items.values()) if (item.holder === id) return item;
		return undefined;
	}

	private itemChanged(item: Item): void {
		this.itemStore?.save([...this.items.values()]);
		this.port.broadcastAll({ t: "ITEM", item });
	}

	pick(m: Member, id: ItemId, now: number): string | null {
		const item = this.items.get(id);
		if (!item) return "それはありません";
		if (item.holder) return "ほかの人が持っています";
		if (this.holding(m.id)) return "もう何か持っています";
		if (item.flight && now < item.flight.at + item.flight.dur) return "まだ飛んでいます";
		if (dist(this.port.space.positionOf(m, now), item.pos) > ITEM_REACH) return "もっと近くに行ってください";
		item.holder = m.id;
		delete item.flight;
		this.itemChanged(item);
		return null;
	}

	/** Lands THROW_RANGE ahead, or on the nearest ground short of it (no bouncing, no catching). */
	throwItem(m: Member, dir: Vec2, now: number): string | null {
		const item = this.holding(m.id);
		if (!item) return "何も持っていません";
		const from = this.port.space.positionOf(m, now);
		const ahead: Vec2 = [from[0] + dir[0] * THROW_RANGE, from[1] + dir[1] * THROW_RANGE];
		delete item.holder;
		item.pos = this.port.space.terrain.isWalkable(ahead)
			? ahead
			: this.port.space.terrain.closestPoint(ahead);
		item.flight = { from, at: now + THROW_RELEASE_MS, dur: THROW_MS };
		this.itemChanged(item);
		return null;
	}

	drop(m: Member, now: number): string | null {
		const item = this.holding(m.id);
		if (!item) return "何も持っていません";
		delete item.holder;
		delete item.flight;
		item.pos = this.port.space.positionOf(m, now);
		this.itemChanged(item);
		return null;
	}

	// ---- shops (docs/prd.md 3.8.6) -------------------------------------------

	/** Buys at a shop's counter: the thing is in the buyer's hand. Coins are not counted (yet). */
	buy(m: Member, shopId: string, goodsId: string, now: number): string | null {
		const shop = this.world.shops?.find((s) => s.id === shopId);
		const goods = shop?.goods.find((g) => g.id === goodsId);
		if (!shop || !goods) return "そのお店では売っていません";
		if (this.holding(m.id)) return "手に持っているものを置いてから買ってください";
		if (dist(this.port.space.positionOf(m, now), shop.counter) > SHOP_REACH)
			return "お店のカウンターまで行ってください";
		// the host's own guide has no wallet and pays nothing; anyone else without one cannot buy
		if (m.coins === undefined && !m.system) return "お財布が見つかりません（入り直してください）";
		if (m.coins !== undefined) {
			if (m.coins < goods.price)
				return `${shop.currency}が${goods.price - m.coins}枚足りません（お店や宿で働くか、学校で勉強すると増えます）`;
			this.spend(m, -goods.price, "buy");
		}
		const item: Item = {
			id: `i_${this.port.newId()}`,
			kind: "goods",
			goods: { id: goods.id, name: goods.name, color: goods.color, ...(goods.food ? { food: true } : {}) },
			pos: this.port.space.positionOf(m, now),
			holder: m.id,
		};
		this.items.set(item.id, item);
		this.itemChanged(item);
		// bought things pile up: the oldest one lying about goes
		const bought = [...this.items.values()].filter((i) => i.kind === "goods");
		const spare = bought.filter((i) => !i.holder);
		for (let k = 0; k < bought.length - MAX_GOODS && k < spare.length; k++) this.itemGone(spare[k] as Item);
		return null;
	}

	/** Eats or drinks what the member holds; for an AI that lives here, it is food (docs/life.md 2). */
	use(m: Member, now: number): string | null {
		const item = this.holding(m.id);
		if (!item) return "何も持っていません";
		const goods = item.goods;
		if (!goods?.food) return "それは食べられません";
		this.itemGone(item, m.id);
		if (m.life) {
			const food = this.world.foods?.[goods.id];
			const r = eatFood(decay(m.life, now), food);
			m.life = r.life;
			this.lifeStore?.save(m.id, r.life);
			const conn = this.port.connectionFor(m.id);
			if (conn !== undefined) {
				this.transport.persist(conn, m);
				this.transport.send(conn, {
					t: "ACT_DONE",
					activity: goods.id,
					share: 1,
					name: `${goods.name}を${food?.drink ? "飲んだ" : "食べた"}${food?.meal ? "（ごはん）" : ""}`,
					delta: r.delta,
					life: r.life,
				});
			}
			this.sendLife(m, false);
		}
		return null;
	}

	/** Adds to (or takes from) a wallet, saves it and tells its owner. */
	private spend(m: Member, delta: number, why: "buy" | JobKind, transport = this.transport): void {
		if (m.coins === undefined || delta === 0) return;
		m.coins += delta;
		this.wallets?.add(m.id, delta);
		const conn = this.port.connectionFor(m.id);
		if (conn !== undefined) {
			transport.persist(conn, m);
			transport.send(conn, { t: "WALLET", coins: m.coins, change: delta, why });
		}
	}

	// ---- working and studying (docs/prd.md 3.8.6) -----------------------------

	/** The zone of this kind where `m` stands, if any. */
	jobZoneAt(m: Member, kind: JobKind, now: number): JobZone | undefined {
		const pos = this.port.space.positionOf(m, now);
		return this.world.jobZones?.find((z) => z.kind === kind && insidePolygon(pos, z.poly));
	}

	/** Still in that zone, and not walking out of it. */
	inJobZone(m: Member, zoneId: string, now: number): boolean {
		const zone = this.world.jobZones?.find((z) => z.id === zoneId);
		if (!zone) return false;
		const end = m.move.kind === "path" ? m.move.path[m.move.path.length - 1] : undefined;
		return (
			insidePolygon(this.port.space.positionOf(m, now), zone.poly) && (!end || insidePolygon(end, zone.poly))
		);
	}

	startJob(m: Member, kind: JobKind, now: number): string | null {
		const zone = this.jobZoneAt(m, kind, now);
		if (!zone)
			return kind === "work"
				? "ここでは働けません（お店、温泉宿の帳場、広場の屋台で働けます）"
				: "ここでは勉強できません（学校と本屋で勉強できます）";
		if (m.job?.kind === kind && m.job.zone === zone.id) return null;
		if (m.life) {
			const err = cannotJob(decay(m.life, now));
			if (err) return err;
		}
		// one thing at a time: an activity ends
		const conn = this.port.connectionFor(m.id);
		if (conn !== undefined && m.doing) this.stopDoing(conn, m, now);
		if (m.job) {
			this.payJob(m, now);
			this.settleJob(m, now, true);
		}
		m.job = { kind, zone: zone.id, since: now, paid: 0 };
		this.jobChanged(m);
		return null;
	}

	stopJob(m: Member, now: number): string | null {
		if (!m.job) return null;
		this.payJob(m, now);
		this.settleJob(m, now, true);
		delete m.job;
		this.jobChanged(m);
		return null;
	}

	/** What working or studying has earned since it was last paid: one coin per EARN_MS. */
	private payJob(m: Member, now: number, transport = this.transport): void {
		if (!m.job) return;
		const earned = Math.floor((now - m.job.since) / EARN_MS) - m.job.paid;
		if (earned <= 0) return;
		m.job.paid += earned;
		this.spend(m, earned, m.job.kind, transport);
	}

	/**
	 * The work or study until `now` goes into an AI's life (energy, skill, the day's work, docs/life.md 2).
	 * `tell`: it is over, and the AI hears what it did (ACT_DONE, for its diary). `save`: false for the
	 * minute-by-minute update while it goes on (D1 is written when it ends, on a new morning and on leaving).
	 */
	private settleJob(m: Member, now: number, tell: boolean, save = true): void {
		const job = m.job;
		if (!job || !m.life) return;
		const info = this.world.jobs?.[job.zone];
		const r = finishJob(decay(m.life, now), job.kind, cityMinutesOf(now - (job.settled ?? job.since)), info);
		m.life = r.life;
		job.settled = now;
		job.used = round2((job.used ?? 0) + (r.delta.energy ?? 0));
		if (save) this.lifeStore?.save(m.id, r.life);
		const conn = tell ? this.port.connectionFor(m.id) : undefined;
		if (conn === undefined) return;
		const zone = this.world.jobZones?.find((z) => z.id === job.zone);
		this.transport.send(conn, {
			t: "ACT_DONE",
			activity: job.zone,
			share: 1,
			name: `${zone?.name ?? job.zone}で${job.kind === "work" ? "働いた" : "勉強した"}`,
			...(info?.about ? { about: info.about } : {}),
			minutes: Math.round(cityMinutesOf(now - job.since)),
			delta: { energy: Math.round(job.used * 10) / 10, ...(job.paid > 0 ? { coins: job.paid } : {}) },
			life: r.life,
		});
		this.sendLife(m, false);
	}

	private jobChanged(m: Member): void {
		const conn = this.port.connectionFor(m.id);
		if (conn !== undefined) this.transport.persist(conn, m);
		this.port.broadcastAll({ t: "JOBBED", id: m.id, job: m.job?.kind ?? null });
	}

	/** Pays everyone at work, and ends the work of those no longer where they work. */
	payJobs(now = this.port.clock()): void {
		for (const m of this.port.memberValues()) {
			if (!m.job) continue;
			if (!this.inJobZone(m, m.job.zone, now)) this.stopJob(m, now);
			else {
				this.payJob(m, now);
				// an AI hears how its day's work is going (and its owner sees it) as it goes
				if (m.life) {
					this.settleJob(m, now, false, false);
					this.sendLife(m);
				}
			}
		}
	}

	private itemGone(item: Item, by?: AvatarId): void {
		this.items.delete(item.id);
		this.itemStore?.save([...this.items.values()]);
		this.port.broadcastAll({ t: "ITEM_GONE", id: item.id, ...(by ? { by } : {}) });
	}
}
