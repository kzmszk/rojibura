// Helpers for building in free play (docs/prd.md 3.7), shared by the host, clients and AI runtimes.

import { BUILD_COLORS, BUILTIN_MODELS } from "./limits.ts";
import type { BuildId, ModelId, Vec2 } from "./types.ts";

const MODEL_RE = /^m_[0-9a-f]{16}$/;
const BUILD_RE = /^b_[A-Za-z0-9_-]{1,64}$/;

export function isBuiltinModel(id: string): boolean {
	return (BUILTIN_MODELS as readonly string[]).includes(id);
}

/** A built-in model or a registered one ("m_" + 16 hex digits). */
export function isModelId(v: unknown): v is ModelId {
	return typeof v === "string" && (isBuiltinModel(v) || MODEL_RE.test(v));
}

export function isBuildId(v: unknown): v is BuildId {
	return typeof v === "string" && BUILD_RE.test(v);
}

/**
 * Where a model's files are: built-in ones are static assets, registered ones come from the host.
 * `block` has no files (it is a box drawn in code).
 */
export function modelUrl(id: ModelId, file: "glb" | "nav.json" | "png"): string {
	return isBuiltinModel(id) ? `/models/${id}.${file}` : `/api/models/${id}.${file}`;
}

/** "#rgb", "#rrggbb" or a BUILD_COLORS name, as "#rrggbb"; null if it is none of them. */
export function normalizeColor(v: string): string | null {
	const s = v.trim().toLowerCase();
	const named = BUILD_COLORS[s];
	if (named) return named;
	if (/^#[0-9a-f]{6}$/.test(s)) return s;
	if (/^#[0-9a-f]{3}$/.test(s)) return `#${[...s.slice(1)].map((c) => c + c).join("")}`;
	return null;
}

/** Degrees in [0, 360), rounded to 0.1. */
export function normalizeRot(deg: number): number {
	const r = Math.round((((deg % 360) + 360) % 360) * 10) / 10;
	return r === 360 ? 0 : r;
}

/** The rotation that makes a model at `from` face `to` (its front is +Z, turned by `rot`). */
export function facing(from: Vec2, to: Vec2): number {
	const dx = to[0] - from[0];
	const dz = to[1] - from[1];
	if (Math.hypot(dx, dz) < 1e-6) return 0;
	return normalizeRot((Math.atan2(dx, dz) * 180) / Math.PI);
}
