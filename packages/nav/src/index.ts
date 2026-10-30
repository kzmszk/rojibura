/** 2D (XZ) point on the walkable plane. Height is decided by the renderer (docs/prd.md 2.3). */
export type Vec2 = [x: number, z: number];

export function distance(a: Vec2, b: Vec2): number {
	return Math.hypot(a[0] - b[0], a[1] - b[1]);
}
