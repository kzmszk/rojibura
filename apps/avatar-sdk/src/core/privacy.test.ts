import { describe, expect, test } from "vitest";
import { contentWords, PrivacyIndex } from "./privacy.ts";

describe("contentWords", () => {
	test("picks katakana, kanji and Latin words, not kana-only talk", () => {
		expect(contentWords("来週、彼女にプロポーズするつもりなんだ。まだ誰にも内緒ね。")).toEqual([
			"来週",
			"彼女",
			"プロポーズ",
			"内緒",
		]);
		expect(contentWords("ねえ、どうしたの？")).toEqual([]);
	});
});

describe("PrivacyIndex", () => {
	const index = () => {
		const i = new PrivacyIndex();
		i.add("h_ken", "来週、彼女にプロポーズするつもりなんだ。まだ誰にも内緒ね。");
		i.add("h_saki", "家で猫を2匹飼ってるんだ。最近は仕事が忙しくて。");
		return i;
	};

	test("finds one person's words in a line for someone else, or for everyone", () => {
		expect(index().leak("ケンさんとはプロポーズの話を少しね。", "h_saki", "")).toEqual({
			person: "h_ken",
			word: "プロポーズ",
		});
		expect(index().leak("お仕事、忙しいみたいですね。", null, "")).toEqual({
			person: "h_saki",
			word: "仕事",
		});
	});

	test("lets the listener's own words, allowed words and everyday words through", () => {
		expect(index().leak("プロポーズ、うまくいくといいね。", "h_ken", "")).toBeNull();
		expect(index().leak("お仕事、おつかれさま。", "h_saki", "")).toBeNull();
		expect(index().leak("ごめん、それは内緒なんだ。最近どう？", "h_saki", "")).toBeNull();
		expect(index().leak("来週の公園は静かかな。", "h_saki", "来週 公園")).toBeNull();
	});
});
