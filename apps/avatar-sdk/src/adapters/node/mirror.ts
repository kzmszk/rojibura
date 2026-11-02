// The mirror on the AI's own PC (docs/prd.md 3.4.11): headless Chrome with the city's /mirror page, where a
// resident rehearses a body script and gets back a picture of itself and how far its hands stayed from their
// spots. One browser is started when first needed and kept until the resident stops.

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Mirror, MirrorShot, RehearseRequest } from "../../core/body.ts";
import type { Logger } from "../../core/types.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface ChromeMirrorOptions {
	/** The city host whose /mirror page (and avatar files) to use. */
	base: string;
	logger: Logger;
	/** The Chrome executable (default: RJ_CHROME, else google-chrome). */
	chrome?: string;
}

export class ChromeMirror implements Mirror {
	private readonly o: ChromeMirrorOptions;
	private chrome: ChildProcess | null = null;
	private profile = "";
	private ws: WebSocket | null = null;
	private seq = 0;
	private readonly waiting = new Map<number, { res: (v: unknown) => void; rej: (e: Error) => void }>();
	private opening: Promise<void> | null = null;
	/** One rehearsal at a time. */
	private queue: Promise<unknown> = Promise.resolve();

	constructor(opts: ChromeMirrorOptions) {
		this.o = opts;
	}

	rehearse(req: RehearseRequest): Promise<MirrorShot> {
		const run = this.queue.then(() => this.once(req));
		this.queue = run.catch(() => {});
		return run;
	}

	close(): void {
		this.ws?.close();
		this.chrome?.kill();
		if (this.profile) rmSync(this.profile, { recursive: true, force: true });
		this.ws = null;
		this.chrome = null;
		this.opening = null;
	}

	private async once(req: RehearseRequest): Promise<MirrorShot> {
		if (!this.ws) {
			this.opening ??= this.open().catch((e) => {
				this.close();
				throw e;
			});
			await this.opening;
		}
		const r = (await this.send("Runtime.evaluate", {
			expression: `window.rjMirror.rehearse(${JSON.stringify(req)})`,
			awaitPromise: true,
			returnByValue: true,
			timeout: 60_000,
		})) as { result?: { value?: unknown }; exceptionDetails?: { exception?: { description?: string } } };
		if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "mirror failed");
		const v = r.result?.value as {
			image: string;
			moments: MirrorShot["moments"];
			loaded: MirrorShot["loaded"];
		};
		const jpeg = Buffer.from(v.image.slice(v.image.indexOf(",") + 1), "base64");
		return { image: new Uint8Array(jpeg), moments: v.moments, loaded: v.loaded };
	}

	private async open(): Promise<void> {
		this.profile = mkdtempSync(join(tmpdir(), "rj-mirror-"));
		const bin = this.o.chrome ?? process.env.RJ_CHROME ?? "google-chrome";
		this.chrome = spawn(
			bin,
			[
				"--headless=new",
				"--remote-debugging-port=0",
				`--user-data-dir=${this.profile}`,
				"--no-first-run",
				"--hide-scrollbars",
				"--window-size=400,400",
				"--use-gl=angle",
				"--use-angle=gl-egl",
				"--ignore-gpu-blocklist",
				"--enable-gpu",
				"about:blank",
			],
			{ stdio: "ignore" },
		);
		this.chrome.on("exit", () => {
			this.ws = null;
			this.opening = null;
		});
		const portFile = join(this.profile, "DevToolsActivePort");
		for (let i = 0; i < 100 && !existsSync(portFile); i++) await sleep(100);
		if (!existsSync(portFile)) throw new Error(`${bin} did not start (set RJ_CHROME to a Chrome executable)`);
		const port = readFileSync(portFile, "utf8").split("\n")[0];
		const targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as {
			type: string;
			webSocketDebuggerUrl: string;
		}[];
		const page = targets.find((t) => t.type === "page");
		if (!page) throw new Error("no page in Chrome");
		const ws = new WebSocket(page.webSocketDebuggerUrl);
		await new Promise((res, rej) => {
			ws.onopen = res;
			ws.onerror = () => rej(new Error("could not reach Chrome"));
		});
		ws.onmessage = (e) => {
			const m = JSON.parse(String(e.data)) as { id?: number; error?: { message: string }; result?: unknown };
			const w = m.id !== undefined ? this.waiting.get(m.id) : undefined;
			if (!w || m.id === undefined) return;
			this.waiting.delete(m.id);
			if (m.error) w.rej(new Error(m.error.message));
			else w.res(m.result);
		};
		ws.onclose = () => {
			for (const w of this.waiting.values()) w.rej(new Error("Chrome went away"));
			this.waiting.clear();
		};
		this.ws = ws;
		await this.send("Page.enable");
		await this.send("Page.navigate", { url: `${this.o.base.replace(/\/$/, "")}/mirror` });
		for (let i = 0; i < 150; i++) {
			const r = (await this.send("Runtime.evaluate", {
				expression: "typeof window.rjMirror === 'object'",
				returnByValue: true,
			})) as { result?: { value?: boolean } };
			if (r.result?.value) {
				this.o.logger.info("mirror ready");
				return;
			}
			await sleep(200);
		}
		throw new Error("the mirror page did not load");
	}

	private send(method: string, params: object = {}): Promise<unknown> {
		const ws = this.ws;
		if (!ws) return Promise.reject(new Error("no mirror"));
		return new Promise((res, rej) => {
			const id = ++this.seq;
			this.waiting.set(id, { res, rej });
			ws.send(JSON.stringify({ id, method, params }));
		});
	}
}
