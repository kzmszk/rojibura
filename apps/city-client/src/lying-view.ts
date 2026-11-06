// Looking about from your own eyes, lying on your back (docs/prd.md 3.4.8): at the sky, with the top of your head at
// the top of the view. Turning goes round the length of the body, as a head turns on the ground: left and right, down
// to the ground at either side. Nodding goes towards the feet or past the top of the head.

import * as THREE from "three";

/** As far as the head turns (radians), and nods past the top of the head, and towards the feet. */
export const LIE_TURN = Math.PI / 2;
export const LIE_NOD_UP = 0.7;
export const LIE_NOD_DOWN = -0.7;

const WORLD_UP = new THREE.Vector3(0, 1, 0);

/** Which way the eyes look (unit vectors), and which way is the top of the view. */
export interface Sight {
	look: THREE.Vector3;
	up: THREE.Vector3;
}

/**
 * Lying with the feet towards `heading` (radians; 0 is +Z): `turn` to the right of the body (left if negative) and
 * `nod` past the top of the head (towards the feet if negative).
 */
export function lyingSight(heading: number, turn = 0, nod = 0): Sight {
	const crown = new THREE.Vector3(-Math.sin(heading), 0, -Math.cos(heading));
	// (lying back turns the body about the line through its shoulders, so its right is where it was: facing +z, -x)
	const right = new THREE.Vector3(crown.z, 0, -crown.x);
	const above = WORLD_UP.clone().multiplyScalar(Math.cos(turn)).addScaledVector(right, Math.sin(turn));
	return {
		look: above.clone().multiplyScalar(Math.cos(nod)).addScaledVector(crown, Math.sin(nod)),
		up: crown.clone().multiplyScalar(Math.cos(nod)).addScaledVector(above, -Math.sin(nod)),
	};
}

/** `up`, or if a camera looking `look` could not tell the top of its view from it, what will do. */
export function steadyUp(look: THREE.Vector3, up: THREE.Vector3): THREE.Vector3 {
	if (look.clone().cross(up).lengthSq() > 1e-4) return up;
	return Math.abs(look.y) < 0.99 ? WORLD_UP.clone() : new THREE.Vector3(0, 0, 1);
}

/** On the way down or up again: `amount` of the way from looking `standing` (0) to `lying` (1). */
export function sightBetween(standing: THREE.Vector3, lying: Sight, amount: number): Sight {
	if (amount <= 0) return { look: standing, up: WORLD_UP.clone() };
	const look = standing.clone().lerp(lying.look, amount).normalize();
	return { look, up: steadyUp(look, WORLD_UP.clone().lerp(lying.up, amount).normalize()) };
}
