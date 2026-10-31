// Keeps what each person told the resident, so a line meant for someone else can be held back before it is said
// (docs/prd.md 3.5.2, "pi 住人"). The resident's mind is one session that heard everyone, so the prompt alone
// does not stop it from passing on one person's words to another; this check does, for the words themselves.

/** Content words: katakana runs of 3+, kanji runs of 2+, Latin letters or digits of 4+. */
const WORD = /[\p{Script=Katakana}ー]{3,}|\p{Script=Han}{2,}|[A-Za-z0-9]{4,}/gu;

/** Words of everyday talk and of keeping a secret ("内緒にする") that are never anyone's private words. */
const COMMON = new Set([
	"内緒",
	"秘密",
	"約束",
	"今日",
	"明日",
	"昨日",
	"今度",
	"最近",
	"自分",
	"本当",
	"時間",
	"場所",
	"大丈夫",
	"一緒",
	"元気",
	"素敵",
	"散歩",
	"相談",
	"応援",
]);

/** Lines kept per person. */
const LINES_KEPT = 40;

export function contentWords(text: string): string[] {
	return [...new Set(text.match(WORD) ?? [])];
}

export class PrivacyIndex {
	private readonly texts = new Map<string, string[]>();

	/** Something `person` said to the resident, or a note about them. */
	add(person: string, text: string): void {
		const lines = this.texts.get(person) ?? [];
		lines.push(text);
		if (lines.length > LINES_KEPT) lines.shift();
		this.texts.set(person, lines);
	}

	/**
	 * A word of `reply` that came from someone other than `listener` (null: everyone nearby), or null.
	 * Words the listener used themselves, and words in `allowed` (the resident's persona, the city's places,
	 * people's names), are fine.
	 */
	leak(reply: string, listener: string | null, allowed: string): { person: string; word: string } | null {
		const known = `${allowed}\n${listener ? (this.texts.get(listener) ?? []).join("\n") : ""}`;
		const words = contentWords(reply);
		for (const [person, lines] of this.texts) {
			if (person === listener) continue;
			const theirs = lines.join("\n");
			const shared = [
				...words.filter((w) => theirs.includes(w)),
				...contentWords(theirs).filter((w) => reply.includes(w)),
			];
			const word = shared.find((w) => !COMMON.has(w) && !known.includes(w));
			if (word) return { person, word };
		}
		return null;
	}
}
