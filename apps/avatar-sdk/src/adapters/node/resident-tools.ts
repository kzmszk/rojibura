// The tools a resident's mind acts through (docs/prd.md 3.5.2, 3.4.11), for any mind: pi takes them as its
// custom tools, Claude Code through a local MCP server. The resident (core/resident.ts) carries them out.

import { MOTIONS } from "@rojibura/protocol";
import { type TSchema, Type } from "typebox";

export interface ResidentTool {
	name: string;
	description: string;
	parameters: TSchema;
	/** Whether calling it ends the turn (a mind that can end turns early: pi). */
	terminate: boolean;
}

/**
 * A body script's keys as one JSON string (checked by the resident against the protocol): local models write
 * nested objects in tool arguments badly (Gemma 4's call format mangles their quotes), a string they write well.
 */
const KEYS = Type.String({
	description:
		'キーの配列を JSON で書いた文字列。例: [{"at":1,"look":"ahead"}]。書き方はシステムプロンプトの「体の動かし方」',
});

/**
 * Every action ends the turn, so a model cannot keep talking to itself; a failed call does not, so it can
 * retry; writing a note does not either, so it can still answer after it. With a body, saying does not end
 * the turn either: "I'll do it" comes before rehearsing and doing it (the resident still lets it speak to
 * each one once per turn). Rehearsing and learning do not end it.
 */
export function residentTools(body: boolean): ResidentTool[] {
	const tool = (name: string, description: string, parameters: TSchema, terminate = true): ResidentTool => ({
		name,
		description,
		parameters,
		terminate,
	});
	return [
		tool(
			"say",
			"声に出して話す。to は話す相手の id（近くのみんなに向けて話すなら省く）。",
			Type.Object({ text: Type.String({ maxLength: 200 }), to: Type.Optional(Type.String()) }),
			!body,
		),
		tool(
			"walk_to",
			"ランドマークの id の場所か、人の id のそばへ歩く。",
			Type.Object({ target: Type.String() }),
		),
		tool(
			"gesture",
			"身ぶりをする。sit（座る）と lie（寝転がる）は、歩き出すまで続く。to は相手の id（任意）。",
			Type.Object({
				motion: Type.Union(MOTIONS.map((m) => Type.Literal(m))),
				to: Type.Optional(Type.String()),
			}),
		),
		tool(
			"turn",
			"その場で体の向きを変える。target は人かランドマークの id（その方を向く）、または left / right / back（今の向きから左・右・後ろ）。",
			Type.Object({ target: Type.String() }),
			false,
		),
		tool("wait", "何もしないで、次の出来事を待つ。", Type.Object({})),
		...(body
			? [
					tool(
						"move_body",
						"街で体を動かす。覚えた動きなら move に名前、新しい動きなら keys。to は of: you の相手の id（省くとオーナー）。distance を入れると、その人からその距離（メートル）まで近づいてからする。",
						Type.Object({
							move: Type.Optional(Type.String()),
							keys: Type.Optional(KEYS),
							to: Type.Optional(Type.String()),
							distance: Type.Optional(Type.Number()),
						}),
					),
					tool(
						"practice",
						"鏡の前で体の動きを試す。自分の姿の画像と、手が狙った所から何cm離れたかが返る。引数は move_body と同じ。name に練習中の動きの名前を付けてもよい。show: true なら、試したあとそのまま街でもする（頼まれた動きはこれ）。false なら鏡の中だけで、だれにも見えない。",
						Type.Object({
							move: Type.Optional(Type.String()),
							keys: Type.Optional(KEYS),
							to: Type.Optional(Type.String()),
							distance: Type.Optional(Type.Number()),
							name: Type.Optional(Type.String()),
							show: Type.Optional(Type.Boolean()),
						}),
						false,
					),
					tool(
						"learn",
						"体の動きに名前をつけて覚える（keys を省くと、最後に practice したもの）。覚えた動きに note（言われたこと、気づいたこと）だけ書き足すこともできる。",
						Type.Object({
							name: Type.String({ description: "24文字まで" }),
							about: Type.Optional(Type.String({ description: "どんな動きか（60文字まで）" })),
							keys: Type.Optional(KEYS),
							note: Type.Optional(Type.String({ description: "80文字まで" })),
						}),
						false,
					),
					tool(
						"step",
						"オーナー（to）のそばで、立つ位置を変える。distance はその人から何メートルのところに立つか（0.3〜2.5）。",
						Type.Object({ to: Type.Optional(Type.String()), distance: Type.Number() }),
					),
				]
			: []),
		tool(
			"remember",
			"覚えておきたいことを書き留める。about はその人の id で、次にその人と話すときに見られる。自分のこと（今日やりたいことなど）は about を self にする。self にはほかの人の話を書かない。",
			Type.Object({ about: Type.String(), note: Type.String({ maxLength: 160 }) }),
			false,
		),
	];
}
