export const STYLES = `
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
.rj-hud { position: absolute; top: 12px; left: 12px; right: 12px; display: flex; justify-content: space-between; pointer-events: none; }
.rj-status, .rj-logout { pointer-events: auto; font-size: 13px; padding: 6px 10px; border-radius: 8px; background: rgba(255,255,255,.8); color: #222; }
.rj-logout { text-decoration: none; }
.rj-chat { position: absolute; left: 12px; bottom: 12px; width: min(440px, calc(100% - 24px)); display: flex; flex-direction: column; gap: 6px; }
.rj-log { max-height: 30vh; overflow-y: auto; font-size: 13px; line-height: 1.5; padding: 6px 10px; border-radius: 8px; background: rgba(255,255,255,.75); }
.rj-log:empty { display: none; }
.rj-line { overflow-wrap: anywhere; }
.rj-line.sys { color: #777; font-size: 12px; }
.rj-line.mine b { color: #b46a17; }
.rj-say { display: flex; gap: 6px; }
.rj-say input { flex: 1; font-size: 15px; padding: 8px 10px; border-radius: 8px; border: 1px solid #aab; }
.rj-target { font-size: 13px; padding: 0 10px; border-radius: 8px; border: 1px solid #aab; background: #f3f4f6; cursor: pointer; white-space: nowrap; }
.rj-target.on { background: #2f6fae; color: #fff; border-color: #2f6fae; }
.rj-toast { position: absolute; top: 56px; left: 50%; transform: translateX(-50%); padding: 8px 14px; border-radius: 8px;
  background: rgba(30,30,30,.85); color: #fff; font-size: 14px; opacity: 0; transition: opacity .3s; pointer-events: none; }
.rj-toast.show { opacity: 1; }
.rj-login { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); width: min(320px, calc(100% - 32px));
  display: flex; flex-direction: column; gap: 10px; padding: 24px; border-radius: 14px; background: #fff; box-shadow: 0 6px 30px rgba(0,0,0,.15); }
.rj-login h1 { margin: 0; font-size: 26px; }
.rj-login p { margin: 0; color: #555; }
.rj-login input, .rj-login select, .rj-login button { font-size: 16px; padding: 9px 10px; border-radius: 8px; border: 1px solid #bbc; }
.rj-login button { background: #2f6fae; color: #fff; border: none; cursor: pointer; }
.rj-note { font-size: 12px; color: #888 !important; }
`;
