export const STYLES = `
[hidden] { display: none !important; }
:root { color-scheme: light; font-family: system-ui, "Hiragino Sans", "Noto Sans JP", sans-serif; }
html, body { margin: 0; height: 100%; overflow: hidden; background: #bfd6e8; }
.rj-root { position: fixed; inset: 0; }
.rj-root canvas { display: block; }
.rj-labels { position: absolute; inset: 0; pointer-events: none; }
.rj-tag { display: flex; flex-direction: column; align-items: center; gap: 4px; transform: translateY(-50%); }
.rj-name { font-size: 12px; padding: 1px 6px; border-radius: 8px; background: rgba(20, 24, 32, .55); color: #fff; white-space: nowrap; }
.rj-name.me { background: rgba(196, 120, 30, .85); }
.rj-name.ai { background: rgba(40, 100, 160, .75); }
.rj-bubble { display: none; max-width: 220px; font-size: 13px; line-height: 1.4; padding: 6px 10px; border-radius: 12px;
  background: #fff; color: #222; box-shadow: 0 1px 4px rgba(0,0,0,.25); overflow-wrap: anywhere; }
.rj-bubble.show { display: block; }
.rj-bubble.thinking { color: #888; letter-spacing: 2px; }
.rj-hud { position: absolute; top: 12px; left: 12px; right: 12px; display: flex; justify-content: space-between; align-items: flex-start; pointer-events: none; }
.rj-status, .rj-logout { pointer-events: auto; font-size: 13px; padding: 6px 10px; border-radius: 8px; background: rgba(255,255,255,.8); color: #222; }
.rj-logout { text-decoration: none; }
.rj-logout.on { background: #2f6fae; color: #fff; }
.rj-logout[hidden] { display: none; }
.rj-right { display: flex; gap: 8px; align-items: center; }
.rj-left { display: flex; flex-direction: column; gap: 6px; align-items: flex-start; }
.rj-gate { white-space: nowrap; }
.rj-map { position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); width: min(1100px, calc(100vw - 24px)); max-height: calc(100vh - 24px);
  box-sizing: border-box; display: flex; flex-direction: column; gap: 8px; padding: 10px 12px; border-radius: 10px; background: rgba(255,255,255,.97);
  color: #222; font-size: 13px; box-shadow: 0 2px 14px rgba(0,0,0,.25); pointer-events: auto; z-index: 9; }
.rj-map-body { display: flex; gap: 10px; min-height: 0; }
.rj-map-stage { position: relative; flex: 1; align-self: flex-start; line-height: 0; border-radius: 6px; overflow: hidden; background: #cfd8c8; }
.rj-map-picture { width: 100%; height: auto; display: block; }
.rj-map-list { width: 210px; flex: none; display: flex; flex-direction: column; gap: 4px; overflow-y: auto; max-height: calc(100vh - 110px); }
.rj-map-list button { text-align: left; font-size: 13px; padding: 5px 8px; border-radius: 6px; border: 1px solid #d5d0c4; background: #faf8f3; cursor: pointer; }
.rj-map-list button:hover { background: #eef4fb; }
.rj-map-head { font-weight: bold; margin-bottom: 2px; }
.rj-map-note { color: #666; font-size: 12px; }
.rj-map-place { position: absolute; transform: translate(-50%, -50%); width: 9px; height: 9px; padding: 0; border-radius: 50%;
  border: 1.5px solid #fff; background: #7a6a55; cursor: pointer; line-height: 1; }
.rj-map-place.major { width: 11px; height: 11px; background: #c4561e; }
.rj-map-place.gate { background: #2a8fd0; border-radius: 3px; }
.rj-map-place span { position: absolute; left: 50%; bottom: 13px; transform: translateX(-50%); white-space: nowrap; font-size: 11px; padding: 1px 5px;
  border-radius: 6px; background: rgba(255,255,255,.88); color: #222; pointer-events: none; }
.rj-map-place:hover { outline: 2px solid #2f6fae; z-index: 2; }
.rj-map-people i { position: absolute; width: 6px; height: 6px; border-radius: 50%; background: #fff; border: 1px solid #333; transform: translate(-50%, -50%); pointer-events: none; }
.rj-map-people i.ai { background: #6aa7d8; }
.rj-map-me { position: absolute; color: #e0301e; font-size: 18px; line-height: 1; text-shadow: 0 0 3px #fff, 0 0 3px #fff; pointer-events: none; z-index: 3; }
@media (max-width: 700px) { .rj-map-body { flex-direction: column; } .rj-map-list { width: auto; max-height: 30vh; } }
.rj-fly { display: flex; gap: 4px; }
.rj-settings { position: fixed; top: 52px; right: 12px; width: 300px; max-width: calc(100vw - 24px); max-height: calc(100vh - 220px); overflow-y: auto; box-sizing: border-box;
  display: flex; flex-direction: column; gap: 10px; padding: 10px 12px; border-radius: 10px; background: rgba(255,255,255,.96); color: #222; font-size: 13px;
  box-shadow: 0 2px 10px rgba(0,0,0,.15); pointer-events: auto; z-index: 7; }
.rj-settings-head { display: flex; justify-content: space-between; align-items: center; font-size: 14px; }
.rj-settings-close { border: none; background: none; color: #555; font-size: 18px; line-height: 1; padding: 0 4px; cursor: pointer; }
.rj-settings-body { display: flex; flex-direction: column; gap: 8px; }
.rj-settings-row { display: flex; align-items: center; gap: 8px; }
.rj-settings-label { flex: 0 0 96px; color: #444; }
.rj-settings-row select, .rj-settings-row button { flex: 1; min-width: 0; font: inherit; padding: 5px 8px; border-radius: 8px; border: 1px solid #bbc; background: #fff; color: #222; cursor: pointer; }
.rj-settings-row button.on { background: #2f6fae; border-color: #2f6fae; color: #fff; }
.rj-settings-check { cursor: pointer; }
.rj-settings-credit { font-size: 11px; line-height: 1.5; color: #555; padding-top: 6px; border-top: 1px solid #e3e5ea; overflow-wrap: anywhere; }
.rj-settings-credit b { font-size: 13px; color: #444; }
.rj-settings-credit a { color: #2f6fae; }
.rj-settings-links { display: flex; gap: 14px; padding-top: 6px; border-top: 1px solid #e3e5ea; flex: 1; }
.rj-settings-links a { color: #2f6fae; text-decoration: none; }
.rj-google { display: block; text-align: center; font-size: 16px; padding: 10px; border-radius: 8px; border: 1px solid #bbc; color: #222; text-decoration: none; background: #fff; }
.rj-chat { position: absolute; left: 12px; bottom: 12px; width: min(440px, calc(100% - 24px)); display: flex; flex-direction: column; gap: 6px; }
.rj-log { max-height: 30vh; overflow-y: auto; font-size: 13px; line-height: 1.5; padding: 6px 10px; border-radius: 8px; background: rgba(255,255,255,.75); }
.rj-log:empty { display: none; }
.rj-log:focus { outline: none; }
.rj-log:not(.full) .rj-line.old { display: none; }
.rj-line { overflow-wrap: anywhere; }
.rj-line.sys { color: #777; font-size: 12px; }
.rj-line.mine b { color: #b46a17; }
.rj-say { display: flex; gap: 6px; }
.rj-motions { display: flex; flex-wrap: wrap; gap: 4px; }
.rj-motions select { font-size: 14px; padding: 6px 8px; border-radius: 8px; border: 1px solid #aab; background: rgba(255,255,255,.85); color: #222; cursor: pointer; }
.rj-motions button { font-size: 18px; line-height: 1; padding: 6px 8px; border-radius: 8px; border: 1px solid #aab; background: rgba(255,255,255,.85); cursor: pointer; }
.rj-motions button:hover { background: #fff; }
.rj-motions button[hidden] { display: none; }
.rj-offer { position: absolute; top: 64px; left: 50%; transform: translateX(-50%); display: flex; gap: 8px; align-items: center; padding: 10px 14px; border-radius: 10px; background: #fff; box-shadow: 0 2px 10px rgba(0,0,0,.25); font-size: 14px; }
.rj-offer[hidden] { display: none; }
.rj-offer button { font-size: 14px; padding: 6px 12px; border-radius: 8px; border: 1px solid #2f6fae; background: #2f6fae; color: #fff; cursor: pointer; }
.rj-offer button.rj-secondary { background: #fff; color: #2f6fae; }
.rj-say input { flex: 1; font-size: 15px; padding: 8px 10px; border-radius: 8px; border: 1px solid #aab; }
.rj-target { max-width: 40%; font-size: 13px; padding: 0 6px; border-radius: 8px; border: 1px solid #aab; background: #f3f4f6; color: #222; cursor: pointer; }
.rj-target option { background: #fff; color: #222; }
.rj-target.on { background: #2f6fae; color: #fff; border-color: #2f6fae; }
.rj-toast { position: absolute; top: 56px; left: 50%; transform: translateX(-50%); padding: 8px 14px; border-radius: 8px;
  background: rgba(30,30,30,.85); color: #fff; font-size: 14px; opacity: 0; transition: opacity .3s; pointer-events: none; }
.rj-toast.show { opacity: 1; }
.rj-portal { font-size: 13px; padding: 3px 9px; border-radius: 10px; background: rgba(20, 90, 140, .82); color: #fff; white-space: nowrap; }
.rj-agent-life { font-size: 12px; line-height: 1.6; padding: 6px 8px; border-radius: 8px; background: #f3f6f9; white-space: pre-line; }
.rj-acts { position: absolute; left: 50%; bottom: 150px; transform: translateX(-50%); display: flex; flex-wrap: wrap; gap: 6px;
  justify-content: center; max-width: calc(100% - 32px); }
.rj-acts button { font-size: 14px; padding: 7px 12px; border-radius: 10px; border: 0; background: rgba(255,255,255,.92); color: #222;
  box-shadow: 0 2px 6px rgba(0,0,0,.25); cursor: pointer; }
.rj-acts button.on { background: #c4781e; color: #fff; }
.rj-travel { position: absolute; left: 50%; bottom: 96px; transform: translateX(-50%); font-size: 16px; padding: 10px 18px;
  border-radius: 12px; border: 0; background: #1f7fbf; color: #fff; box-shadow: 0 2px 8px rgba(0,0,0,.3); cursor: pointer; }
.rj-purse { pointer-events: auto; }
.rj-purse.earned { animation: rj-earned 0.9s ease-out; }
@keyframes rj-earned { 0% { background: rgba(255, 214, 92, .95); transform: scale(1.08); } 100% { background: rgba(255,255,255,.8); transform: scale(1); } }
.rj-shop-panel { position: absolute; left: 50%; bottom: 148px; transform: translateX(-50%); width: min(300px, calc(100% - 32px));
  display: flex; flex-direction: column; gap: 4px; padding: 10px; border-radius: 12px; background: rgba(255,252,244,.96);
  box-shadow: 0 4px 16px rgba(0,0,0,.25); }
.rj-shop-title { font-weight: 600; padding: 2px 4px 6px; }
.rj-shop-panel button { display: flex; align-items: center; gap: 8px; padding: 7px 8px; border: 0; border-radius: 8px;
  background: transparent; font-size: 14px; cursor: pointer; text-align: left; }
.rj-shop-panel button:hover { background: rgba(31,127,191,.12); }
.rj-shop-dot { width: 12px; height: 12px; border-radius: 50%; flex: none; box-shadow: 0 0 0 1px rgba(0,0,0,.2); }
.rj-shop-price { margin-left: auto; color: #6b5a3a; }
.rj-login { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); width: min(320px, calc(100% - 32px));
  display: flex; flex-direction: column; gap: 10px; padding: 24px; border-radius: 14px; background: #fff; box-shadow: 0 6px 30px rgba(0,0,0,.15); }
.rj-login h1 { margin: 0; font-size: 26px; }
.rj-login p { margin: 0; color: #555; }
.rj-login input, .rj-login select, .rj-login button { font-size: 16px; padding: 9px 10px; border-radius: 8px; border: 1px solid #bbc; }
.rj-login button { background: #2f6fae; color: #fff; border: none; cursor: pointer; }
.rj-note { font-size: 12px; color: #888 !important; }
.rj-report-actions button { font-size: 12px; padding: 4px 10px; border-radius: 8px; border: 1px solid #aab; background: #fff; cursor: pointer; }
.rj-dialog { position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); width: min(340px, calc(100% - 32px)); display: flex; flex-direction: column; gap: 8px;
  padding: 18px; border-radius: 12px; background: #fff; box-shadow: 0 6px 30px rgba(0,0,0,.25); z-index: 10; font-size: 14px; }
.rj-dialog select, .rj-dialog textarea, .rj-dialog button { font-size: 14px; padding: 8px; border-radius: 8px; border: 1px solid #bbc; }
.rj-dialog textarea { min-height: 70px; resize: vertical; }
.rj-dialog button[type=submit], .rj-dialog button:not([type]) { background: #b33; color: #fff; border: none; }
.rj-dialog .rj-secondary { background: #fff; color: #333; border: 1px solid #bbc; }
.rj-admin { overflow: auto; background: #f4f5f7; }
.rj-admin-page { max-width: 760px; margin: 0 auto; padding: 24px 16px; display: flex; flex-direction: column; gap: 12px; font-size: 14px; }
.rj-report { background: #fff; border-radius: 10px; padding: 12px 14px; display: flex; flex-direction: column; gap: 6px; box-shadow: 0 1px 3px rgba(0,0,0,.08); }
.rj-excerpt { font-size: 13px; background: #f6f6f8; border-radius: 6px; padding: 6px 8px; overflow-wrap: anywhere; }
.rj-note-text { color: #444; overflow-wrap: anywhere; }
.rj-report-actions { display: flex; flex-wrap: wrap; gap: 6px; }
.rj-admin-page button { font: inherit; padding: 6px 12px; border-radius: 8px; border: 1px solid #bbc; background: #fff; color: #222; cursor: pointer; }
.rj-admin-page button[type="submit"] { background: #2f6fae; border-color: #2f6fae; color: #fff; }
.rj-admin-page input:disabled { background: #f0f1f3; color: #555; }
.rj-agent { position: fixed; top: 52px; right: 12px; width: 340px; max-width: calc(100vw - 24px); max-height: calc(100vh - 220px); overflow-y: auto; box-sizing: border-box;
  display: flex; flex-direction: column; gap: 8px; padding: 10px 12px; border-radius: 10px; background: rgba(255,255,255,.96); color: #222; font-size: 13px;
  box-shadow: 0 2px 10px rgba(0,0,0,.15); pointer-events: auto; z-index: 6; }
.rj-agent-head { display: flex; justify-content: space-between; align-items: center; font-size: 14px; }
.rj-agent-sec { display: flex; flex-direction: column; gap: 6px; }
.rj-agent-row { display: flex; flex-wrap: wrap; gap: 6px; }
.rj-agent input, .rj-agent select, .rj-agent textarea { font: inherit; padding: 6px 8px; border-radius: 6px; border: 1px solid #bbc; }
.rj-agent textarea { resize: vertical; }
.rj-agent button { font: inherit; padding: 5px 12px; border-radius: 8px; border: 1px solid #2f6fae; background: #2f6fae; color: #fff; cursor: pointer; }
.rj-agent button.rj-secondary { background: #fff; color: #222; border-color: #bbc; }
.rj-agent .rj-agent-row .rj-secondary { font-size: 12px; padding: 3px 9px; }
.rj-agent button.rj-agent-close { border: none; background: none; color: #555; font-size: 18px; line-height: 1; padding: 0 4px; }
.rj-agent details { display: flex; flex-direction: column; gap: 6px; }
.rj-agent details[open] { padding-bottom: 2px; }
.rj-agent details > * + * { margin-top: 6px; }
.rj-agent details textarea { width: 100%; box-sizing: border-box; }
.rj-agent summary { cursor: pointer; color: #333; }
.rj-diary-page { max-height: 260px; overflow-y: auto; display: flex; flex-direction: column; gap: 3px; font-size: 12px; line-height: 1.6; white-space: pre-wrap; }
.rj-diary-h1 { font-weight: 700; font-size: 13px; }
.rj-diary-h2 { font-weight: 600; margin-top: 6px; }
.rj-diary-h3 { font-style: italic; color: #555; margin-top: 2px; }
.rj-agent .rj-diary .rj-agent-row button.on { background: #2f6fae; color: #fff; border-color: #2f6fae; }
.rj-agent .rj-diary .rj-agent-row button:disabled { opacity: .45; cursor: default; }
.rj-agent .rj-diary select { font-size: 12px; padding: 2px 4px; }
.rj-agent-log { max-height: 180px; overflow-y: auto; display: flex; flex-direction: column; gap: 2px; font-size: 12px; }
.rj-command { display: block; margin: 4px 0 6px; padding: 6px 8px; background: #fff; border: 1px solid #dde; border-radius: 6px; font-size: 12px; white-space: pre-wrap; word-break: break-all; user-select: all; }
.rj-report textarea, .rj-report input, .rj-report select { font: inherit; padding: 8px; border-radius: 6px; border: 1px solid #ccd; }
.rj-onboarding { border-collapse: collapse; font-size: 13px; width: 100%; }
.rj-onboarding th, .rj-onboarding td { text-align: left; padding: 4px 6px; border-bottom: 1px solid #eee; font-variant-numeric: tabular-nums; }
.rj-good { color: #1a7f37; font-weight: 600; }
.rj-bad { color: #c62828; font-weight: 600; }
.rj-dim { color: #aaa; }
.rj-usage { display: none; position: fixed; top: 52px; right: 12px; width: 380px; max-width: calc(100vw - 24px); max-height: calc(100vh - 200px); overflow-y: auto; box-sizing: border-box; padding: 10px 12px; border-radius: 10px; background: rgba(255,255,255,.94); color: #222; font-size: 12px; box-shadow: 0 2px 10px rgba(0,0,0,.15); pointer-events: auto; z-index: 5; }
.rj-usage.show { display: block; }
.rj-usage-head { display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-bottom: 6px; font-size: 13px; }
.rj-usage-close { border: none; background: none; font-size: 18px; line-height: 1; cursor: pointer; color: #555; padding: 0 4px; }
.rj-usage-bars { display: flex; flex-direction: column; gap: 4px; }
.rj-usage-top { display: flex; justify-content: space-between; }
.rj-usage-pct { font-variant-numeric: tabular-nums; color: #444; }
.rj-usage-bar { height: 5px; border-radius: 3px; background: #e6e8ec; overflow: hidden; margin: 1px 0; }
.rj-usage-fill { height: 100%; background: #3a7bd5; }
.rj-usage-fill.warm { background: #e0a020; }
.rj-usage-fill.hot { background: #d64545; }
.rj-usage-nums { color: #666; font-size: 11px; font-variant-numeric: tabular-nums; }
.rj-usage-sub { display: block; margin: 10px 0 4px; font-size: 12px; }
.rj-usage-events { display: flex; flex-direction: column; gap: 3px; }
.rj-usage-event { display: grid; grid-template-columns: auto 1fr; column-gap: 6px; row-gap: 2px; padding: 3px 4px; border-radius: 4px; }
.rj-usage-event.mine { background: #eef4ff; }
.rj-usage-time { color: #888; font-variant-numeric: tabular-nums; }
.rj-usage-label { overflow-wrap: anywhere; }
.rj-usage-chips { grid-column: 2; display: flex; flex-wrap: wrap; gap: 3px; }
.rj-chip { font-size: 10px; padding: 1px 5px; border-radius: 8px; background: #eceff3; color: #333; font-variant-numeric: tabular-nums; }
.rj-chip-neurons { background: #f3e8ff; }
.rj-chip-sqlRowsWritten, .rj-chip-d1RowsWritten { background: #ffefe0; }
.rj-chip-workerRequests, .rj-chip-doRequests { background: #e5f2ff; }
.rj-free { pointer-events: auto; font-size: 12px; padding: 6px 10px; border-radius: 8px; background: rgba(255, 236, 200, .92); color: #6a4300; }
.rj-build-label { font-size: 12px; padding: 2px 8px; border-radius: 6px; background: rgba(255,255,255,.85); color: #333; border: 1px solid #c9b48a; white-space: nowrap; }
.rj-build { position: fixed; top: 52px; right: 12px; width: 300px; max-width: calc(100vw - 24px); max-height: calc(100vh - 220px); overflow-y: auto; box-sizing: border-box;
  display: flex; flex-direction: column; gap: 8px; padding: 10px 12px; border-radius: 10px; background: rgba(255,255,255,.95); color: #222; font-size: 13px;
  box-shadow: 0 2px 10px rgba(0,0,0,.15); pointer-events: auto; z-index: 5; }
.rj-build.removing { outline: 2px solid #d64545; }
.rj-build-head { display: flex; justify-content: space-between; align-items: center; }
.rj-build-row { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.rj-build button { font: inherit; padding: 4px 10px; border-radius: 8px; border: 1px solid #bbc; background: #fff; color: #222; cursor: pointer; }
.rj-build button.on { background: #2f6fae; border-color: #2f6fae; color: #fff; }
.rj-build input { font: inherit; padding: 5px 8px; border-radius: 6px; border: 1px solid #bbc; min-width: 0; }
.rj-build-row input[type=number] { width: 56px; }
.rj-build-models { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; }
.rj-build .rj-build-model { display: flex; flex-direction: column; align-items: center; gap: 2px; padding: 4px; font-size: 11px; }
.rj-build-model img { width: 52px; height: 52px; object-fit: contain; }
.rj-build-block { display: grid; place-items: center; width: 52px; height: 52px; font-size: 30px; color: #b59a6e; }
.rj-build-colors { display: flex; flex-wrap: wrap; gap: 5px; }
.rj-build .rj-swatch { width: 22px; height: 22px; padding: 0; border-radius: 50%; border: 2px solid #fff; box-shadow: 0 0 0 1px #aab; }
.rj-build .rj-swatch.on { box-shadow: 0 0 0 2px #2f6fae; }
.rj-build-hint { font-size: 11px; color: #777; }
`;
