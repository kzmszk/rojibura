import {
	type AvatarId,
	type AvatarState,
	BODY_REACH,
	type BodyKey,
	bodyDuration,
	bodyNeedsPartner,
	bodyTouches,
	dist,
	parseBodyKeys,
	sanitizeText,
} from "@rojibura/protocol";
import { MOVE_ABOUT_MAX, MOVE_NAME_MAX, MOVE_NOTES_KEPT, type Move } from "./body.ts";
import { clean, cleanNote } from "./prompt.ts";
import type { ResidentOptions, ToolResult } from "./resident.ts";
import type { World } from "./world.ts";

/** What the mirror showed last, not yet learned under a name. */
interface Practice {
	keys: BodyKey[];
	/** Pictures and rehearsals since the last learn. */
	pictures: string[];
	count: number;
}

const MAX_PRACTICES = 4;
const ARM_REACH = 0.6;
const TOUCH_DISTANCE = 0.4;

export class BodyTools {
	private practice: Practice | null = null;
	private bodyTimer: ReturnType<typeof setTimeout> | null = null;

	private readonly deps: {
		options: Pick<ResidentOptions, "mirror" | "moves" | "sees" | "send" | "logger">;
		world: World;
		find: (name: string) => AvatarState | undefined;
		approach: (target: AvatarState, distance: number) => number | string;
		nameOf: (id: AvatarId) => string;
	};

	constructor(deps: BodyTools["deps"]) {
		this.deps = deps;
	}

	stop(): void {
		if (this.bodyTimer) clearTimeout(this.bodyTimer);
		this.bodyTimer = null;
	}

	/**
	 * The script a body tool means: a learned move by name, or keys of its own; and who "you" is (whom `to`
	 * names, or its owner when it walks with them). Throws what the mind should fix.
	 */
	private async scriptOf(
		args: Record<string, unknown>,
	): Promise<{ keys: BodyKey[]; move?: Move; to?: AvatarState }> {
		let move: Move | undefined;
		let raw = args.keys;
		if (typeof args.move === "string" && args.move.trim()) {
			const name = args.move.trim();
			move = (await this.deps.options.moves?.list())?.find((m) => m.name === name);
			if (!move)
				throw new Error(`「${clean(name, MOVE_NAME_MAX)}」という動きはまだ覚えていない。keys で組み立てる。`);
			raw = move.keys;
		}
		if (typeof raw === "string") {
			raw = parseKeysText(raw);
			if (raw === null) throw new Error('keys は JSON の配列の文字列にする。例: [{"at":1,"look":"ahead"}]');
		}
		if (raw === undefined) throw new Error("move（覚えた動きの名前）か keys がいる。");
		const keys = parseBodyKeys(raw);
		if (typeof keys === "string") throw new Error(`keys がおかしい: ${keys}`);
		const toRaw = typeof args.to === "string" && args.to.trim() ? args.to.trim() : undefined;
		let to = toRaw ? this.deps.find(toRaw) : undefined;
		if (toRaw && !to)
			throw new Error(`${clean(toRaw, 24)} という人は近くにいない。to には近くにいる人の id を使う。`);
		if (!to && bodyNeedsPartner(keys)) {
			to = this.deps.world.company ? this.deps.world.avatars.get(this.deps.world.company) : undefined;
			if (!to) throw new Error('of: "you" を使うときは to に相手の id を入れる。');
		}
		if (to && bodyTouches(keys) && to.id !== this.deps.world.self?.ownerId)
			throw new Error(
				"手で触れられるのは自分のオーナーだけ。ほかの人には、触れない動き（of: me や look）にする。",
			);
		return { keys, move, ...(to ? { to } : {}) };
	}

	/** The move_body tool: does a script (or a learned move) in the city, stepping up first if it must. */
	async moveBody(args: Record<string, unknown>, distance: number | undefined): Promise<string> {
		if (!this.deps.options.mirror) throw new Error("体を自由に動かすことはできない。gesture を使う。");
		const { keys, move, to } = await this.scriptOf(args);
		const here = this.deps.world.me ? this.deps.world.positionOf(this.deps.world.me) : null;
		const there = to ? this.deps.world.positionOf(to.id) : null;
		const far = here && there ? dist(here, there) : 0;
		const touches = bodyTouches(keys);
		let wait = 0;
		if (to && (distance !== undefined || (touches && far > BODY_REACH - 0.05))) {
			const walk = this.deps.approach(to, distance ?? TOUCH_DISTANCE);
			if (typeof walk === "string") return walk;
			wait = walk > 0 ? walk + 400 : 0;
		}
		if (to && touches && distance !== undefined && distance > BODY_REACH - 0.05)
			throw new Error(`触れるには${BODY_REACH - 0.1}m以内まで近づく。distance を小さくする。`);
		const send = () => {
			this.bodyTimer = null;
			this.deps.options.send({ t: "BODY", keys, ...(to ? { to: to.id } : {}) });
		};
		if (this.bodyTimer) clearTimeout(this.bodyTimer);
		if (wait > 0) this.bodyTimer = setTimeout(send, wait);
		else send();
		if (move && this.deps.options.moves) {
			move.uses++;
			await this.deps.options.moves
				.save(move)
				.catch((e) => this.deps.options.logger.warn(`moves: ${(e as Error).message}`));
		}
		const what = move ? `「${move.name}」` : "体の動き";
		this.deps.options.logger.info(
			`body ${move ? move.name : "script"} (${keys.length} keys)${to ? ` for ${this.deps.nameOf(to.id)}` : ""}`,
		);
		return `${wait > 0 ? "近づいてから、" : ""}${what}をした（${Math.round(bodyDuration(keys) * 10) / 10}秒）。`;
	}

	/** The practice tool: rehearses in the mirror and sees itself (or, without sight, how far its hands were). */
	async rehearse(
		turn: { practices: number },
		args: Record<string, unknown>,
		distance: number | undefined,
	): Promise<ToolResult> {
		const mirror = this.deps.options.mirror;
		if (!mirror) throw new Error("鏡がない。");
		if (++turn.practices > MAX_PRACTICES) return "この番の練習はここまで。続きは次の番で。";
		const { keys, move, to } = await this.scriptOf(args);
		const me = this.deps.world.self;
		const vrm = me?.assets.vrm || me?.assets.lod;
		if (!me || !vrm) return "自分の姿が分からない。";
		let at: [number, number] | undefined;
		if (to) {
			const here = this.deps.world.positionOf(me.id);
			const there = this.deps.world.positionOf(to.id);
			const now = here && there ? dist(here, there) : 1;
			// as it would be in the city: stepping up first to touch, or to the distance asked
			const d = distance ?? (bodyTouches(keys) && now > BODY_REACH - 0.05 ? TOUCH_DISTANCE : now);
			at = [0, Math.max(0.3, Math.min(3, d))];
		}
		const req = {
			me: { vrm },
			keys,
			...(to && at ? { you: { vrm: to.assets.vrm || to.assets.lod, at } } : {}),
		};
		const shot = await mirror.rehearse(req);
		const label = move?.name ?? (typeof args.name === "string" ? args.name : "practice");
		const picture = (await this.deps.options.moves?.keepPicture(shot.image, label).catch(() => null)) ?? null;
		const same = this.practice && JSON.stringify(this.practice.keys) === JSON.stringify(keys);
		this.practice = {
			keys,
			pictures: [...(this.practice?.pictures ?? []), ...(picture ? [picture] : [])],
			count: (this.practice?.count ?? 0) + 1,
		};
		this.deps.options.logger.info(
			`practice ${label}${same ? " (again)" : ""}: ${JSON.stringify(shot.moments)}`,
		);
		const lines = [
			`鏡の前でやってみた${at ? `（相手は${at[1]}m前に立っている）` : ""}。`,
			...shot.moments.map((m) => {
				const hands = [
					m.right !== undefined ? `右手は狙った所から${m.right}cm` : "",
					m.left !== undefined ? `左手は狙った所から${m.left}cm` : "",
				].filter(Boolean);
				return `- ${m.at}秒: ${hands.join("、") || "（手の狙いなし）"}`;
			}),
			`10cm以上なら、届いていないか、ずれている。自分の腕は、肩から手のひらまで${ARM_REACH}mくらい。`,
			...(shot.loaded.me ? [] : ["自分の体を鏡に映せなかった（骨のない姿）。"]),
			this.deps.options.sees
				? "画像は、列が時間、上の段が右から、下の段が左から見た自分（と相手）。思った通りに見えるか確かめて、直すなら keys を変えてもう一度 practice。よければ learn で名前をつけて覚える。"
				: "画像はアルバムに残した（いまは自分では見られないので、数字で確かめる）。よければ learn で名前をつけて覚える。",
		];
		const text = lines.join("\n");
		return this.deps.options.sees ? { text, image: shot.image } : text;
	}

	/** The learn tool: names the last rehearsed script (or `keys`), or adds a note to a move it knows. */
	async learn(
		nameRaw: string | undefined,
		aboutRaw: string | undefined,
		keysRaw: unknown,
		noteRaw: string | undefined,
	): Promise<string> {
		const book = this.deps.options.moves;
		if (!book) throw new Error("覚えておく場所がない。");
		const name = nameRaw ? [...sanitizeText(nameRaw)].slice(0, MOVE_NAME_MAX).join("") : "";
		if (!name) throw new Error("name に動きの名前をつける。");
		const moves = await book.list();
		const old = moves.find((m) => m.name === name);
		let keys: BodyKey[] | undefined;
		if (keysRaw !== undefined) {
			const parsed = parseBodyKeys(typeof keysRaw === "string" ? parseKeysText(keysRaw) : keysRaw);
			if (typeof parsed === "string") throw new Error(`keys がおかしい: ${parsed}`);
			keys = parsed;
		} else keys = this.practice?.keys;
		if (!keys && !old) throw new Error("まだ何も練習していない。practice で試してから learn する。");
		const about = aboutRaw ? cleanNote(aboutRaw, MOVE_ABOUT_MAX) : null;
		const note = noteRaw ? cleanNote(noteRaw, 80) : null;
		const now = new Date().toISOString();
		const practiced = keys && this.practice && JSON.stringify(this.practice.keys) === JSON.stringify(keys);
		const move: Move = old ?? {
			name,
			about: about ?? name,
			keys: keys ?? [],
			made: now,
			updated: now,
			practices: 0,
			uses: 0,
			notes: [],
			pictures: [],
		};
		if (keys) move.keys = keys;
		if (about) move.about = about;
		if (note) move.notes = [...move.notes, note].slice(-MOVE_NOTES_KEPT);
		if (practiced && this.practice) {
			move.practices += this.practice.count;
			move.pictures.push(...this.practice.pictures.filter((p) => !move.pictures.includes(p)));
			this.practice = { keys: this.practice.keys, pictures: [], count: 0 };
		}
		move.updated = now;
		await book.save(move);
		this.deps.options.logger.info(`learned ${name}${old ? " (again)" : ""}: ${move.about}`);
		return old
			? `「${name}」を覚え直した。`
			: `「${name}」として覚えた。次からは move_body の move に「${name}」と書けばできる。`;
	}
}

/**
 * A script the mind wrote as text: the JSON array in it, forgiving a code fence around it and keys without
 * quotes (models write `{at:1}`). Null if there is none.
 */
export function parseKeysText(text: string): unknown {
	const from = text.indexOf("[");
	const to = text.lastIndexOf("]");
	if (from < 0 || to < from) return null;
	const body = text.slice(from, to + 1);
	for (const t of [body, body.replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:/g, '$1"$2":')]) {
		try {
			return JSON.parse(t);
		} catch {}
	}
	return null;
}
