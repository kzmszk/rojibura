export class Invitation {
	private askedAt = 0;
	private pending: { place: string; arrived: () => void } | null = null;

	canInvite(): boolean {
		return Date.now() - this.askedAt >= 3 * 60_000;
	}

	offer(place: string, arrived?: () => void): void {
		this.askedAt = Date.now();
		this.pending = arrived ? { place, arrived } : null;
	}

	answer(place: string, accept: boolean, at: number, hostNow: number): void {
		const arrived = this.pending?.place === place ? this.pending.arrived : null;
		this.pending = null;
		if (arrived && accept) setTimeout(arrived, Math.max(0, at - hostNow) + 1000);
	}
}
