import type { Activity, ClientToHost } from "@rojibura/protocol";
import {
	ACTIVITY_REACH,
	dist,
	insidePolygon,
	type JobKind,
	type JobZone,
	SHOP_REACH,
	type Shop,
	type Vec2,
	WALK_SPEED,
} from "@rojibura/protocol";
import type { Landmark, Logger } from "./types.ts";
import type { World } from "./world.ts";

export interface ErrandOptions {
	landmarks: Landmark[];
	logger: Logger;
	send: (msg: ClientToHost) => void;
	/** What can be done in the area (docs/life.md 3): with it, it eats, works and plays by what it needs. */
	activities?: Activity[];
	/** The area's shops and where one works or studies (docs/prd.md 3.8.6). */
	shops?: Shop[];
	jobZones?: JobZone[];
}

/** Where it is walking, a leg at a time, and what it will do there. */
type Errand = (
	| { kind: "act"; id: string }
	| { kind: "buy"; shop: string; goods: string }
	| { kind: "job"; job: JobKind; zone: string }
) & { to?: Vec2; legs?: number };

const MAX_LEGS = 8;

/** A life errand, from its first walk until arrival or cancellation. */
export class Errands {
	private going: Errand | null = null;

	private readonly o: ErrandOptions;
	private readonly world: World;
	private readonly walkTo: (to: Vec2) => boolean;
	private readonly schedule: (delay: number) => void;
	private readonly random: () => number;

	constructor(
		o: ErrandOptions,
		world: World,
		walkTo: (to: Vec2) => boolean,
		schedule: (delay: number) => void,
		random: () => number,
	) {
		this.o = o;
		this.world = world;
		this.walkTo = walkTo;
		this.schedule = schedule;
		this.random = random;
	}

	get busy(): boolean {
		return this.going !== null;
	}

	cancel(): void {
		this.going = null;
	}

	continue(here: Vec2): boolean {
		const going = this.going;
		this.going = null;
		if (going && this.arrive(going, here)) return true;
		return !!(
			going?.to &&
			(going.legs ?? 0) < MAX_LEGS &&
			dist(here, going.to) > 1.5 &&
			this.goFor(going, going.to, "on")
		);
	}

	activity(a: NonNullable<ErrandOptions["activities"]>[number], here: Vec2): boolean {
		const place = this.o.landmarks.find((l) => l.id === a.place);
		if (!place) return false;
		const e: Errand = { kind: "act", id: a.id };
		if (dist(here, place.pos) <= ACTIVITY_REACH - 0.5) return this.arrive(e, here);
		const angle = this.random() * Math.PI * 2;
		const near: Vec2 = [place.pos[0] + Math.cos(angle) * 1.2, place.pos[1] + Math.sin(angle) * 1.2];
		const what = `to ${place.name} for ${a.name}`;
		return this.goFor(e, near, what) || this.goFor(e, place.pos, what);
	}

	buy(shop: Shop, goods: Shop["goods"][number], here: Vec2): boolean {
		const e: Errand = { kind: "buy", shop: shop.id, goods: goods.id };
		if (dist(here, shop.counter) <= SHOP_REACH - 0.5) return this.arrive(e, here);
		return this.goFor(e, shop.counter, `to ${shop.name} for ${goods.name}`);
	}

	work(zone: JobZone, here: Vec2): boolean {
		const e: Errand = { kind: "job", job: zone.kind, zone: zone.id };
		if (insidePolygon(here, zone.poly)) return this.arrive(e, here);
		const n = zone.poly.length;
		const mid: Vec2 = [
			zone.poly.reduce((s, p) => s + p[0], 0) / n,
			zone.poly.reduce((s, p) => s + p[1], 0) / n,
		];
		return this.goFor(e, mid, `to ${zone.name} to ${zone.kind}`);
	}

	private arrive(e: Errand, here: Vec2): boolean {
		if (e.kind === "act") {
			const a = this.o.activities?.find((x) => x.id === e.id);
			const place = a ? this.o.landmarks.find((l) => l.id === a.place) : undefined;
			if (!a || !place || dist(here, place.pos) > ACTIVITY_REACH - 0.5) return false;
			this.o.send({ t: "ACT", activity: a.id });
			this.o.logger.info(`doing ${a.id}`);
			return true;
		}
		if (e.kind === "buy") {
			const shop = this.o.shops?.find((s) => s.id === e.shop);
			if (!shop || dist(here, shop.counter) > SHOP_REACH - 0.5) return false;
			this.o.send({ t: "BUY", shop: shop.id, goods: e.goods });
			this.o.logger.info(`buying ${e.goods} at ${shop.name}`);
			return true;
		}
		const zone = this.o.jobZones?.find((z) => z.id === e.zone);
		if (!zone || !insidePolygon(here, zone.poly)) return false;
		this.o.send({ t: "JOB", kind: e.job });
		this.o.logger.info(`${e.job === "work" ? "working" : "studying"} at ${zone.name}`);
		return true;
	}

	private goFor(e: Errand, to: Vec2, what: string): boolean {
		const from = this.world.me ? this.world.positionOf(this.world.me) : null;
		if (!this.walkTo(to)) return false;
		this.going = { ...e, to, legs: (e.legs ?? 0) + 1 };
		this.o.logger.info(`going ${what}`);
		const eta = from ? (dist(from, to) / WALK_SPEED) * 1000 : 10_000;
		this.schedule(eta * 1.4 + 2000);
		return true;
	}
}
