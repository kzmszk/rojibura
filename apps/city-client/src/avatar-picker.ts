import { api } from "./api.ts";
import { el } from "./dom.ts";
import { outfitsOf, type PresetInfo } from "./outfits.ts";

const AVATAR = "rj.avatar";

/** The preset avatar picked last time (an unknown one is Saki on the host). */
export function savedAvatar(): string | null {
	try {
		return localStorage.getItem(AVATAR);
	} catch {
		return null;
	}
}

export function saveAvatar(id: string): void {
	try {
		localStorage.setItem(AVATAR, id);
	} catch {
		// private mode: the choice lasts as long as the URL
	}
}

let presetCache: Promise<PresetInfo[]> | null = null;
/** The host's preset looks (cached: the picker and the "auto" outfit both ask). */
function presets(): Promise<PresetInfo[]> {
	presetCache ??= api("/api/presets")
		.then((r) => (r.ok ? (r.json() as Promise<PresetInfo[]>) : []))
		.catch(() => []);
	return presetCache;
}

/** What a character's outfit setting is: one outfit (a preset id), or "auto" (a different one each time). */
const OUTFIT_MODE = "rj.outfit";
const AUTO = "auto";

function outfitMode(): string | null {
	try {
		return localStorage.getItem(OUTFIT_MODE);
	} catch {
		return null;
	}
}

function saveOutfitMode(mode: string): void {
	try {
		localStorage.setItem(OUTFIT_MODE, mode);
	} catch {
		// private mode: the choice lasts as long as the URL
	}
}

/**
 * The look to enter with when none is in the URL: the saved one, or, if its outfit is set to "auto", one of the
 * character's outfits at random (so the same person turns up in different clothes now and then).
 */
export async function startingAvatar(saved: string): Promise<string> {
	if (outfitMode() !== AUTO) return saved;
	const outfits = outfitsOf(await presets(), saved);
	return outfits[Math.floor(Math.random() * outfits.length)]?.id ?? saved;
}

/**
 * Picks a preset avatar (T1) and, for a character with more than one, its outfit (settings: 👤 見た目 and
 * 👔 服装). The host takes the look when connecting, so picking one enters the area again.
 */
export function avatarPicker(
	current: string,
	showOutfits: (shown: boolean) => void,
): { who: HTMLSelectElement; outfit: HTMLSelectElement } {
	const who = el("select", "rj-select");
	who.title = "見た目を選ぶ（選ぶと入り直します）";
	const outfit = el("select", "rj-select");
	outfit.title = "服装を選ぶ（選ぶと入り直します）";
	const enter = (id: string) => {
		saveAvatar(id);
		const url = new URL(location.href);
		url.searchParams.set("avatar", id);
		url.searchParams.delete("at");
		location.href = url.toString();
	};
	/** Fills the outfit list for a character, and hides it when there is only one. */
	const fillOutfits = (all: PresetInfo[], id: string) => {
		const outfits = outfitsOf(all, id);
		outfit.replaceChildren();
		for (const p of outfits) {
			const o = el("option", "", p.outfit ?? "ふだん");
			o.value = p.id;
			outfit.append(o);
		}
		const auto = el("option", "", "🎲 おまかせ（入るたびに変わる）");
		auto.value = AUTO;
		outfit.append(auto);
		outfit.value = outfitMode() === AUTO ? AUTO : id;
		showOutfits(outfits.length > 1);
	};
	void presets().then((all) => {
		for (const p of all.filter((p) => !p.base)) {
			const o = el("option", "", `👤 ${p.name}`);
			o.value = p.id;
			who.append(o);
		}
		who.value = outfitsOf(all, current)[0]?.id ?? current;
		fillOutfits(all, current);
		who.onchange = async () => {
			// another character: its first outfit (or, if the setting is "auto", a random one)
			saveOutfitMode(outfitMode() === AUTO ? AUTO : who.value);
			enter(await startingAvatar(who.value));
		};
		outfit.onchange = () => {
			if (outfit.value === AUTO) {
				saveOutfitMode(AUTO);
				const outfits = outfitsOf(all, who.value);
				enter(outfits[Math.floor(Math.random() * outfits.length)]?.id ?? who.value);
			} else {
				saveOutfitMode(outfit.value);
				enter(outfit.value);
			}
		};
	});
	return { who, outfit };
}
