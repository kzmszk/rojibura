import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { donorTorso, skinOf } from "./donor-body.ts";

const avatar = (name: string) =>
	readFileSync(new URL(`../../../assets/avatars/${name}.vrm`, import.meta.url));

test("Shino's trunk moved onto Shibu: on her skeleton, as tall as her trunk, and the file is up to date", () => {
	const shibu = skinOf(avatar("shibu"));
	const torso = donorTorso(shibu, skinOf(avatar("shino")));
	expect(torso.index.length / 3).toBeGreaterThan(1000);
	const hips = shibu.at.get("J_Bip_C_Hips")?.[1] ?? 0;
	const neck = shibu.at.get("J_Bip_C_Neck")?.[1] ?? 0;
	let lo = Infinity;
	let hi = -Infinity;
	for (let i = 1; i < torso.pos.length; i += 3) {
		lo = Math.min(lo, torso.pos[i] as number);
		hi = Math.max(hi, torso.pos[i] as number);
	}
	// from below the hips' joint to about the neck's root
	expect(lo).toBeLessThan(hips);
	expect(hi).toBeGreaterThan(neck - 0.05);
	expect(hi).toBeLessThan(neck + 0.08);
	// the committed file is what the tool makes now
	const saved = JSON.parse(
		readFileSync(new URL("../../../assets/avatars/shibu.torso.json", import.meta.url), "utf8"),
	);
	expect(saved.pos).toEqual(torso.pos);
	expect(saved.index).toEqual(torso.index);
});
