// A resident's book of moves and its album, on the owner's PC (docs/prd.md 3.4.11): `<name>.moves.json`, and
// `<name>.album/` with every picture from the mirror and an index.html that shows, move by move, how it
// looked the first time and how it looks now. Nothing goes to the host.

import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import type { Move, MoveBook } from "../../core/body.ts";

export class FileMoveBook implements MoveBook {
	private readonly file: string;
	private readonly album: string;
	private readonly title: string;
	private moves: Move[] | null = null;

	/** `file`: the moves (JSON); `album`: the folder of pictures; `title`: the AI's name, for the page. */
	constructor(file: string, album: string, title: string) {
		this.file = file;
		this.album = album;
		this.title = title;
	}

	/** The album page (open it in a browser). */
	get page(): string {
		return join(this.album, "index.html");
	}

	async list(): Promise<Move[]> {
		if (!this.moves) {
			try {
				const data = JSON.parse(await readFile(this.file, "utf8")) as { moves?: Move[] };
				this.moves = Array.isArray(data.moves) ? data.moves : [];
			} catch {
				this.moves = [];
			}
		}
		return this.moves;
	}

	async save(move: Move): Promise<void> {
		const moves = await this.list();
		const i = moves.findIndex((m) => m.name === move.name);
		if (i >= 0) moves[i] = move;
		else moves.push(move);
		const tmp = `${this.file}.tmp`;
		await writeFile(tmp, `${JSON.stringify({ version: 1, moves }, null, "\t")}\n`, { mode: 0o600 });
		await rename(tmp, this.file);
		await this.writePage();
	}

	async keepPicture(jpeg: Uint8Array, label: string): Promise<string> {
		await mkdir(this.album, { recursive: true, mode: 0o700 });
		// local time: the owner reads it on the album page
		const d = new Date();
		const p2 = (n: number) => String(n).padStart(2, "0");
		const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
		const safe =
			[...label]
				.filter((c) => /[\p{L}\p{N}_-]/u.test(c))
				.join("")
				.slice(0, 24) || "practice";
		const name = `${stamp}-${safe}.jpg`;
		await writeFile(join(this.album, name), jpeg, { mode: 0o600 });
		await this.writePage();
		return name;
	}

	/** index.html: each move with its first and latest picture and every practice between, then the rest. */
	private async writePage(): Promise<void> {
		await mkdir(this.album, { recursive: true, mode: 0o700 });
		const moves = [...(await this.list())].sort((a, b) => b.updated.localeCompare(a.updated));
		const used = new Set(moves.flatMap((m) => m.pictures));
		const loose = (await readdir(this.album).catch(() => [] as string[]))
			.filter((f) => f.endsWith(".jpg") && !used.has(f))
			.sort()
			.reverse()
			.slice(0, 30);
		const esc = (s: string) =>
			s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string);
		const img = (f: string, cls = "") =>
			`<a href="${esc(f)}"><img class="${cls}" src="${esc(f)}" alt=""></a>`;
		const when = (f: string) =>
			esc(f.slice(0, 13).replace(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})/, "$1/$2/$3 $4:$5"));
		const card = (m: Move) => {
			const first = m.pictures[0];
			const latest = m.pictures.at(-1);
			return `<section>
<h2>${esc(m.name)}</h2>
<p class="about">${esc(m.about)}</p>
<p class="meta">練習 ${m.practices} 回 · 街で ${m.uses} 回 · 覚えた日 ${esc(m.made.slice(0, 10))} · 最後に直した日 ${esc(m.updated.slice(0, 10))}</p>
${m.notes.length > 0 ? `<ul class="notes">${m.notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>` : ""}
${
	first && latest && first !== latest
		? `<div class="pair"><figure>${img(first)}<figcaption>はじめ（${when(first)}）</figcaption></figure><figure>${img(latest)}<figcaption>いま（${when(latest)}）</figcaption></figure></div>`
		: latest
			? `<div class="pair"><figure>${img(latest)}<figcaption>${when(latest)}</figcaption></figure></div>`
			: ""
}
${m.pictures.length > 2 ? `<details><summary>練習のあと（${m.pictures.length}枚）</summary><div class="strip">${m.pictures.map((p) => img(p, "small")).join("")}</div></details>` : ""}
</section>`;
		};
		const html = `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(this.title)}のわざ帳</title>
<style>
body{font-family:system-ui,sans-serif;margin:0 auto;max-width:1100px;padding:16px;background:#f6f4ef;color:#222}
h1{font-size:22px}section{background:#fff;border-radius:10px;padding:12px 16px;margin:14px 0;box-shadow:0 1px 3px #0002}
h2{margin:4px 0;font-size:19px}.about{margin:2px 0 6px}.meta{color:#666;font-size:13px;margin:0 0 6px}
.notes{font-size:14px;color:#444;margin:4px 0 8px;padding-left:20px}
.pair{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:10px}
figure{margin:0}figure img{width:100%;border-radius:6px}figcaption{font-size:13px;color:#555}
.strip{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px}img.small{height:90px;border-radius:4px}
</style></head><body>
<h1>${esc(this.title)}のわざ帳</h1>
<p class="meta">鏡の前で練習して覚えた体の動き。新しく直したものが上です。画像は上が右から、下が左から見た姿。</p>
${moves.map(card).join("\n") || "<p>まだ何も覚えていません。</p>"}
${loose.length > 0 ? `<section><h2>名前のない練習</h2><div class="strip">${loose.map((f) => img(f, "small")).join("")}</div></section>` : ""}
</body></html>
`;
		await writeFile(this.page, html, { mode: 0o600 });
	}
}

/** For logs: a path shown from the user's home. */
export function shortPath(p: string, home: string): string {
	return p.startsWith(home) ? `~/${relative(home, p)}` : p;
}
