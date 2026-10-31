// Minimal PNG reader: 8-bit greyscale, RGB or RGBA, not interlaced. Enough for walk rasters.

import { inflateSync } from "node:zlib";

export interface Png {
	width: number;
	height: number;
	/** Samples per pixel: 1 (grey), 3 (RGB) or 4 (RGBA). */
	channels: number;
	data: Uint8Array;
}

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 6: 4 };

export function readPng(bytes: Uint8Array): Png {
	if (!SIGNATURE.every((b, i) => bytes[i] === b)) throw new Error("not a PNG");
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	let width = 0;
	let height = 0;
	let channels = 0;
	const idat: Uint8Array[] = [];
	for (let o = 8; o < bytes.length; ) {
		const len = view.getUint32(o);
		const type = String.fromCharCode(...bytes.subarray(o + 4, o + 8));
		const body = bytes.subarray(o + 8, o + 8 + len);
		if (type === "IHDR") {
			width = view.getUint32(o + 8);
			height = view.getUint32(o + 12);
			const [depth, colour, , , interlace] = body.subarray(8, 13);
			channels = CHANNELS[colour as number] ?? 0;
			if (depth !== 8 || !channels || interlace !== 0)
				throw new Error(`unsupported PNG (depth ${depth}, colour type ${colour}, interlace ${interlace})`);
		} else if (type === "IDAT") idat.push(body);
		else if (type === "IEND") break;
		o += 12 + len;
	}
	const raw = inflateSync(Buffer.concat(idat));
	const stride = width * channels;
	const data = new Uint8Array(stride * height);
	for (let y = 0; y < height; y++) {
		const filter = raw[y * (stride + 1)] as number;
		const src = y * (stride + 1) + 1;
		const out = y * stride;
		for (let x = 0; x < stride; x++) {
			const a = x >= channels ? (data[out + x - channels] as number) : 0;
			const b = y > 0 ? (data[out - stride + x] as number) : 0;
			const c = x >= channels && y > 0 ? (data[out - stride + x - channels] as number) : 0;
			let p = raw[src + x] as number;
			if (filter === 1) p += a;
			else if (filter === 2) p += b;
			else if (filter === 3) p += (a + b) >> 1;
			else if (filter === 4) {
				const pa = Math.abs(b - c);
				const pb = Math.abs(a - c);
				const pc = Math.abs(a + b - 2 * c);
				p += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
			}
			data[out + x] = p & 0xff;
		}
	}
	return { width, height, channels, data };
}
