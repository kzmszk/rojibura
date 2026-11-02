// Moving its own body (docs/prd.md 3.4.11): what a resident needs besides the protocol's body scripts. The
// mirror it rehearses in, the book of moves it has learned (its わざ帳), and the words that tell its mind
// how a body script is written. No move is taught: the mind learns what its parts are and composes the rest.

import {
	BODY_HEIGHT,
	BODY_KEYS_MAX,
	BODY_LEAN,
	BODY_OFFSET_MAX,
	BODY_OFFSET_YOU_MAX,
	BODY_PARTS,
	BODY_SECONDS_MAX,
	type BodyKey,
	PALMS,
	TOUCHABLE,
} from "@rojibura/protocol";

/** What the mirror page takes (city-client's mirror.ts). */
export interface RehearseRequest {
	me: { vrm: string };
	/** Where the one "you" means stands: metres to my right and to my front; they face me. */
	you?: { vrm: string; at: [right: number, front: number] };
	keys: BodyKey[];
}

export interface MirrorShot {
	/** JPEG: the moments in columns, seen from the right (top row) and the left (bottom row). */
	image: Uint8Array;
	/** Per moment: its time, and how far each hand's palm stayed from the spot its key gave it (cm). */
	moments: { at: number; right?: number; left?: number }[];
	loaded: { me: boolean; you: boolean | null };
}

export interface Mirror {
	rehearse(req: RehearseRequest): Promise<MirrorShot>;
	close?(): void;
}

/** A move the resident learned and named. */
export interface Move {
	name: string;
	/** What it is, in its own words. */
	about: string;
	keys: BodyKey[];
	made: string;
	updated: string;
	/** Times rehearsed in the mirror, and done in the city. */
	practices: number;
	uses: number;
	/** What the owner (or anyone) said about it, and its own notes. */
	notes: string[];
	/** Pictures from the mirror, oldest first (album paths). */
	pictures: string[];
}

/** Where moves and mirror pictures are kept (the node adapter: a JSON file and an album folder). */
export interface MoveBook {
	list(): Promise<Move[]>;
	save(move: Move): Promise<void>;
	/** Keeps a picture from the mirror; returns where (for Move.pictures). */
	keepPicture(jpeg: Uint8Array, label: string): Promise<string>;
}

export const MOVE_NAME_MAX = 24;
export const MOVE_ABOUT_MAX = 60;
export const MOVE_NOTES_KEPT = 8;
export const MOVES_SHOWN = 12;

/** How a body script is written, for a resident's system prompt. */
export function bodyGuide(): string {
	return [
		"体の動かし方:",
		"- あなたには体があり、手、頭の向き、上体の傾き、腰の高さを自分で動かせます。決まった動作（gesture）にない動きは、move_body で自分で組み立てます。",
		`- keys はキーの配列を JSON で書いた文字列。キーは時間順に${BODY_KEYS_MAX}個まで。各キーは at（始めからの秒、${BODY_SECONDS_MAX}秒まで）までに、書いた部位をそこへ持っていきます。書かなかった部位は前のキーのまま。最後のキーのあと、体は自然に元に戻ります。`,
		'- right / left: 右手 / 左手を「どこへ」持っていくか。{ "part": 行き先の部位, "of": "me" か "you", "off": [右, 上, 前], "palm": 手のひらの向き, "wiggle": 揺らし } か "rest"（下ろす）。part は手の行き先で、動かす手そのものではない（右手を相手の肩に置くなら right の part に相手の肩を書く）。',
		`  - part: ${BODY_PARTS.join(", ")}。head は頭のてっぺん、_l / _r はその体の左 / 右、front は自分の胸の35cm前（of は me だけ）。`,
		`  - of: me は自分の体（省略時）、you は to に入れた相手の体。手で触れられる相手は自分のオーナーだけで、部位は ${TOUCHABLE.join(", ")} だけ。`,
		`  - off: その体の向きで、右・上・前へずらすメートル（自分は${BODY_OFFSET_MAX}まで、相手は${BODY_OFFSET_YOU_MAX}まで）。`,
		`  - palm: ${PALMS.join(" / ")}（下 / 上 / 前 / 体の内側）。wiggle: { "dir": "side" か "up" か "front", "size": メートル（0.15まで）, "hz": 1秒の往復回数（4まで） }。`,
		'- look: 見る所。{ "part": 部位, "of": ... } か、"ahead"（前）、"left"、"right"、"up"、"down"（首の向き）。体ごと向きを変えるのは turn。',
		`- lean: 上体を前へ傾ける角度（${BODY_LEAN[0]}〜${BODY_LEAN[1]}度）。height: 腰の高さ（${BODY_HEIGHT[0]}でしゃがむ、${BODY_HEIGHT[1]}で背伸び）。smile: true で微笑む。`,
		'- 書き方の例（右手を自分の胸に当てて、相手の顔を見る）: [{"at":0.8,"right":{"part":"chest","palm":"in"},"look":{"part":"face","of":"you"}},{"at":2.5}]',
		"- 相手に触れるには、その人のすぐそば（0.9m以内）にいる必要があります。move_body の distance で、近づいてからできます。オーナーのそばでは、step で立つ位置を自分で変えられます。",
		"育ち方:",
		"- 初めての動きは、practice で鏡の前で試します。自分の姿の画像と、手が狙った所から何cm離れていたかが返ります。見て直し、納得するまで試してかまいません。",
		"- 頼まれた動きは、その番のうちに実際にします。覚えていない動きなら practice に show: true を付けると、鏡で試してそのまま街でもします。show を付けない practice は鏡の中だけで、だれにも見えません。「します」と say で言うだけで終わらせない。",
		"- うまくできたら learn で名前をつけて覚えます。覚えた動きは move_body の move に名前を入れるだけでできます。",
		"- オーナーに感想や注文を言われたら、それをふまえて practice で直し、learn で同じ名前に上書きします（note に言われたことを残す）。",
		"- ひとりで手が空いているときに、鏡の前で練習してもかまいません。",
	].join("\n");
}

/** The resident's moves in a line or two, for each turn: what it can do by name. */
export function movesLine(moves: Move[]): string {
	if (moves.length === 0) return "覚えた体の動き: まだない";
	const shown = [...moves].sort((a, b) => b.updated.localeCompare(a.updated)).slice(0, MOVES_SHOWN);
	return `覚えた体の動き（move_body の move で使える）: ${shown
		.map(
			(m) =>
				`${m.name}（${m.about}。練習${m.practices}回、${m.uses}回した${m.notes.length > 0 ? `。言われたこと: ${m.notes.at(-1)}` : ""}）`,
		)
		.join("、")}`;
}
