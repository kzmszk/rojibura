// The preset looks the host offers, and the outfits of one character (docs/prd.md 3.4.4): shared by the settings
// (your own look) and the AI's panel (its look).

export interface PresetInfo {
	id: string;
	name: string;
	/** Another outfit of the character whose first preset this is. */
	base?: string;
	outfit?: string;
}

/** The outfits of a character (the look `id` and its other outfits), the character's own first. */
export function outfitsOf(all: PresetInfo[], id: string): PresetInfo[] {
	const base = all.find((p) => p.id === id)?.base ?? id;
	return all.filter((p) => p.id === base || p.base === base);
}
