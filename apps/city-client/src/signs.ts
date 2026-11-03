// Name boards of places in the 3D (docs/prd.md 3.8): drawn into the scene with depth, so a board behind a building
// is hidden by it, and about the same size on screen near or far.

import * as THREE from "three";

export interface SignLook {
	/** CSS colours. */
	background: string;
	color: string;
	border?: string;
	/** Text height in CSS pixels on screen. */
	size?: number;
}

/** The view's height at distance 1 counts as this many CSS pixels (the 55° camera on a common screen). */
const SCREEN_PX = 900;

/** A board with `text`; its bottom sits at the sprite's position. */
export function signSprite(text: string, look: SignLook): THREE.Sprite {
	const px = look.size ?? 13;
	// drawn at 3x for sharpness
	const k = 3;
	const font = `${px * k}px system-ui, sans-serif`;
	const canvas = document.createElement("canvas");
	const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;
	ctx.font = font;
	const padX = 9 * k;
	const padY = 3 * k;
	const w = Math.ceil(ctx.measureText(text).width + padX * 2);
	const h = Math.ceil(px * k * 1.35 + padY * 2);
	canvas.width = w;
	canvas.height = h;
	ctx.font = font;
	const r = Math.min(10 * k, h / 2);
	ctx.beginPath();
	ctx.roundRect(1, 1, w - 2, h - 2, r);
	ctx.fillStyle = look.background;
	ctx.fill();
	if (look.border) {
		ctx.lineWidth = k;
		ctx.strokeStyle = look.border;
		ctx.stroke();
	}
	ctx.fillStyle = look.color;
	ctx.textAlign = "center";
	ctx.textBaseline = "middle";
	ctx.fillText(text, w / 2, h / 2 + k);
	const map = new THREE.CanvasTexture(canvas);
	map.colorSpace = THREE.SRGBColorSpace;
	map.anisotropy = 4;
	const sprite = new THREE.Sprite(
		new THREE.SpriteMaterial({
			map,
			transparent: true,
			depthWrite: false,
			// the depth test is the point: buildings in front hide it
			depthTest: true,
			sizeAttenuation: false,
			fog: false,
		}),
	);
	// with sizeAttenuation off, scale is a fraction of the view's height at distance 1 (about the screen at 55°)
	const height = h / k / SCREEN_PX;
	sprite.scale.set((height * w) / h, height, 1);
	sprite.center.set(0.5, 0);
	sprite.renderOrder = 20;
	return sprite;
}

export function disposeSign(sprite: THREE.Sprite): void {
	sprite.material.map?.dispose();
	sprite.material.dispose();
}
