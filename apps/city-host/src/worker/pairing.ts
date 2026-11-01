// Pairing an AI with its owner's PC (docs/prd.md 3.5.1): a short one-time code, typed into the PC's command.

/** No 0/O, 1/I/L: the code is read off one screen and typed on another. */
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const LENGTH = 8;
export const PAIR_CODE_TTL_MS = 10 * 60_000;
export const PAIR_CODE_RE = /^[A-HJKMNP-Z2-9]{8}$/;

export function newPairCode(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(LENGTH));
	return [...bytes].map((b) => ALPHABET[b % ALPHABET.length]).join("");
}

/** As typed: any case, with spaces or a hyphen in the middle. Null if it cannot be a code. */
export function normalizePairCode(raw: unknown): string | null {
	if (typeof raw !== "string") return null;
	const code = raw.toUpperCase().replace(/[\s-]/g, "");
	return PAIR_CODE_RE.test(code) ? code : null;
}
