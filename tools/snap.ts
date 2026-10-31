// Headless Chrome screenshots of the running client (for checking rendering without a visible browser).
//   node tools/snap.ts <out.png> <url> [--eval "js"] [--wait ms] [--size 1280x800] [--cookie name=value] [--mock path=json]
// Each --eval runs in the page in order (awaited); its JSON result is printed. The shot is taken at the end.
// Logs in with the dev login when the URL starts with /auth/dev/login.

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

const { values, positionals } = parseArgs({
	allowPositionals: true,
	options: {
		eval: { type: "string", multiple: true, default: [] },
		wait: { type: "string", default: "3000" },
		size: { type: "string", default: "1280x800" },
		// set before loading the page, e.g. the staging dev token (rj_dev=...)
		cookie: { type: "string", multiple: true, default: [] },
		// answer requests whose URL contains PATH with this JSON, e.g. '/api/entry={"ok":false,...}'
		mock: { type: "string", multiple: true, default: [] },
	},
});
const [out, url] = positionals;
if (!out || !url) throw new Error("usage: node tools/snap.ts out.png url [--eval js] [--wait ms]");
const [W, H] = (values.size ?? "1280x800").split("x").map(Number);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const profile = mkdtempSync(join(tmpdir(), "rj-snap-"));
const chrome = spawn(
	"google-chrome",
	[
		"--headless=new",
		"--remote-debugging-port=0",
		`--user-data-dir=${profile}`,
		"--no-first-run",
		"--hide-scrollbars",
		`--window-size=${W},${H}`,
		"--use-gl=angle",
		"--use-angle=gl-egl",
		"--ignore-gpu-blocklist",
		"--enable-gpu",
		"about:blank",
	],
	{ stdio: "ignore" },
);
const portFile = join(profile, "DevToolsActivePort");
for (let i = 0; i < 100 && !existsSync(portFile); i++) await sleep(100);
const port = readFileSync(portFile, "utf8").split("\n")[0];
const targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as {
	type: string;
	webSocketDebuggerUrl: string;
}[];
const page = targets.find((t) => t.type === "page");
if (!page) throw new Error("no page target");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r, j) => {
	ws.onopen = r;
	ws.onerror = j;
});
let seq = 0;
const mocks = (values.mock ?? []).map((m) => {
	const i = m.indexOf("=");
	return [m.slice(0, i), m.slice(i + 1)] as const;
});
const pending = new Map<number, { res: (v: unknown) => void; rej: (e: Error) => void }>();
const logs: string[] = [];
ws.onmessage = (e) => {
	const m = JSON.parse(String(e.data));
	if (m.id && pending.has(m.id)) {
		const p = pending.get(m.id);
		pending.delete(m.id);
		if (m.error) p?.rej(new Error(m.error.message));
		else p?.res(m.result);
	} else if (m.method === "Fetch.requestPaused") {
		const hit = mocks.find(([path]) => m.params.request.url.includes(path));
		const body = Buffer.from(hit?.[1] ?? "").toString("base64");
		if (hit)
			void send("Fetch.fulfillRequest", {
				requestId: m.params.requestId,
				responseCode: 200,
				responseHeaders: [{ name: "Content-Type", value: "application/json" }],
				body,
			});
		else void send("Fetch.continueRequest", { requestId: m.params.requestId });
	} else if (m.method === "Runtime.consoleAPICalled") {
		logs.push(
			`${m.params.type}: ${m.params.args.map((a: { value?: unknown; description?: string }) => a.value ?? a.description).join(" ")}`,
		);
	} else if (m.method === "Runtime.exceptionThrown") {
		logs.push(`EXC: ${JSON.stringify(m.params.exceptionDetails).slice(0, 400)}`);
	}
};
// biome-ignore lint/suspicious/noExplicitAny: CDP results are untyped
const send = (method: string, params = {}): Promise<any> =>
	new Promise((res, rej) => {
		const id = ++seq;
		pending.set(id, { res, rej });
		ws.send(JSON.stringify({ id, method, params }));
	});

let code = 0;
try {
	await send("Page.enable");
	await send("Runtime.enable");
	if (mocks.length > 0)
		await send("Fetch.enable", { patterns: mocks.map(([path]) => ({ urlPattern: `*${path}*` })) });
	for (const c of values.cookie ?? []) {
		const [name = "", ...rest] = c.split("=");
		await send("Network.setCookie", { name, value: rest.join("="), url, secure: url.startsWith("https:") });
	}
	await send("Page.navigate", { url });
	await sleep(Number(values.wait));
	for (const expr of values.eval ?? []) {
		const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
		console.log(
			JSON.stringify(
				r.exceptionDetails ? { error: r.exceptionDetails.exception?.description } : r.result?.value,
			),
		);
	}
	const shot = await send("Page.captureScreenshot", { format: "png" });
	writeFileSync(out, Buffer.from(shot.data, "base64"));
	console.log(`saved ${out}`);
} catch (e) {
	console.error(e);
	code = 1;
} finally {
	for (const l of logs) console.log(`[page] ${l}`);
	ws.close();
	chrome.kill();
}
process.exit(code);
