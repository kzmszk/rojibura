// /agent: put your own AI in the city from the browser (T3, #24). No Cloudflare account or API key: it
// starts on the host's trial LLM. The AI runs in agent.worker.ts while this tab is open.

import type { FromPage, FromWorker } from "./agent.worker.ts";

const PRESETS = [
	"のんびり屋の詩人。夜の街と噴水の音が好き。やわらかい口調。",
	"好奇心旺盛な学生。知らない人にもすぐ話しかける。元気な話し方。",
	"世話好きなカフェの店員。おすすめを聞かれるのが好き。ていねいな話し方。",
];

function el<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	cls: string,
	text?: string,
): HTMLElementTagNameMap[K] {
	const e = document.createElement(tag);
	e.className = cls;
	if (text !== undefined) e.textContent = text;
	return e;
}

export function showAgentPage(root: HTMLElement): void {
	root.classList.add("rj-admin");
	const page = el("div", "rj-admin-page");
	const back = el("a", "", "← 街に戻る");
	back.href = "/";
	page.append(el("h1", "", "自分のAIを街に住まわせる"), back);
	root.append(page);

	const worker = new Worker(new URL("./agent.worker.ts", import.meta.url), { type: "module" });
	const send = (m: FromPage) => worker.postMessage(m);

	// ---- setup ----
	const form = el("form", "rj-report");
	const name = el("input", "");
	name.maxLength = 24;
	name.required = true;
	name.placeholder = "AIの名前（例：ハル）";
	const personality = el("textarea", "");
	personality.maxLength = 400;
	personality.rows = 3;
	personality.required = true;
	personality.placeholder = "性格や話し方、好きなこと";
	// the look, chosen once when the AI is registered (docs/prd.md 3.4.4); VRMs move with the city's motions
	const look = el("select", "");
	look.title = "見た目（登録したあとは変えられません）";
	void fetch("/api/presets")
		.then((r) => (r.ok ? (r.json() as Promise<{ id: string; name: string; assets: { vrm: string } }[]>) : []))
		.then((presets) => {
			for (const p of presets) {
				const o = el("option", "", p.name);
				o.value = p.id;
				look.append(o);
			}
			look.value = presets.find((p) => /\.vrm$/i.test(p.assets.vrm))?.id ?? presets[0]?.id ?? "";
		});
	const presets = el("div", "rj-report-actions");
	for (const p of PRESETS) {
		const b = el("button", "rj-secondary", p.split("。")[0]);
		b.type = "button";
		b.onclick = () => {
			personality.value = p;
		};
		presets.append(b);
	}
	const llm = el(
		"div",
		"rj-note",
		"頭脳：お試し（ホストのAI、1日60回まで、APIキー不要）。自分のAPIキーを使う方法は準備中です。",
	);
	const go = el("button", "", "街に住まわせる");
	go.type = "submit";
	form.append(
		el("b", "", "名前と性格"),
		name,
		el("span", "rj-note", "見た目："),
		look,
		el("span", "rj-note", "性格の例："),
		presets,
		personality,
		llm,
		go,
	);

	// ---- running ----
	const run = el("div", "rj-report");
	const state = el("b", "", "");
	const remaining = el("span", "rj-note", "");
	const actions = el("div", "rj-report-actions");
	const visit = el("a", "", "街を見に行く（別のタブ）");
	visit.href = "/";
	visit.target = "_blank";
	const stop = el("button", "rj-secondary", "街から帰す");
	stop.type = "button";
	stop.onclick = () => send({ cmd: "stop" });
	const restart = el("button", "", "もう一度入れる");
	restart.type = "button";
	restart.onclick = () => send({ cmd: "start", name: name.value, personality: personality.value });
	const forget = el("button", "rj-secondary", "このAIを忘れる");
	forget.type = "button";
	forget.onclick = () => {
		if (confirm("このブラウザに保存したAIの鍵と記憶を消します。同じAIでは入れなくなります。よろしいですか？"))
			send({ cmd: "forget" });
	};
	actions.append(visit, stop, restart, forget);
	const log = el("div", "rj-excerpt rj-agent-log");
	run.append(
		state,
		remaining,
		el(
			"p",
			"rj-note",
			"このタブを開いている間だけ、AIは街にいます。話しかけるには、街のタブでAIをクリックしてください。",
		),
		actions,
		log,
	);

	page.append(form, run);
	run.hidden = true;

	form.onsubmit = (e) => {
		e.preventDefault();
		send({
			cmd: "start",
			name: name.value.trim(),
			personality: personality.value.trim(),
			preset: look.value,
		});
	};

	worker.onmessage = (e: MessageEvent<FromWorker>) => {
		const m = e.data;
		switch (m.t) {
			case "identity":
				// a returning AI keeps its name (it is registered); the personality can be changed
				name.value = m.name ?? "";
				name.disabled = m.name !== null;
				// a registered AI keeps the look it was given
				look.disabled = m.name !== null;
				personality.value = m.personality || personality.value;
				go.textContent = m.name ? `「${m.name}」を街に入れる` : "街に住まわせる";
				form.hidden = false;
				run.hidden = true;
				break;
			case "state": {
				const labels = {
					starting: "準備しています…",
					running: "街にいます",
					stopped: "街から帰りました",
					error: "うまくいきませんでした",
				};
				state.textContent = `${name.value || "AI"}：${labels[m.state]}${m.message ? `（${m.message}）` : ""}`;
				const active = m.state === "starting" || m.state === "running";
				form.hidden = active;
				run.hidden = !active && m.state !== "stopped";
				stop.hidden = !active;
				restart.hidden = active;
				if (m.state === "error") form.hidden = false;
				break;
			}
			case "remaining":
				remaining.textContent = `今日のお試し枠：残り ${m.remaining} 回${m.limit ? `（1日 ${m.limit} 回）` : ""}`;
				break;
			case "log": {
				const line = el("div", "", `${new Date(m.at).toLocaleTimeString()} ${m.line}`);
				log.prepend(line);
				while (log.childElementCount > 200) log.lastElementChild?.remove();
				break;
			}
		}
	};
	send({ cmd: "load" });
}
