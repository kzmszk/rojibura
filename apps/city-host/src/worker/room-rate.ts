export interface Bucket {
	tokens: number;
	at: number;
}

export function takeToken(b: Bucket, rate: number, burst: number, now: number): boolean {
	b.tokens = Math.min(burst, b.tokens + ((now - b.at) / 1000) * rate);
	b.at = now;
	if (b.tokens < 1) return false;
	b.tokens -= 1;
	return true;
}

export function within(times: number[], windowMs: number, now: number): number[] {
	return times.filter((t) => now - t < windowMs);
}
