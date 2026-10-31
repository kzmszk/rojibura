# rojibura

人間とAIが暮らす3Dバーチャル都市。ホストは Cloudflare 無料枠だけで運用し、AIの推論と記憶は参加者側が担う。

- 設計書：[docs/prd.md](docs/prd.md)（PRD・アーキテクチャ・概要設計）
- テスト用の街：`assets/test-city/test_city.glb`（`blender -b --python tools/city-build/blender/test_city.py -- --preview` で再生成）
- プリセットアバター：`assets/avatars/saki.glb`（TOKYO 2090 のサキ、stand / walk / run / sit）

## 開発

必要なもの：Node.js 26.8 以上（`cf` は 26.12 以上を推奨。古いと警告が出るが動く）、pnpm 11。

```bash
pnpm install
pnpm dev          # apps/city-host を cf dev で起動（http://localhost:5173）
pnpm test         # vitest
pnpm typecheck    # 全パッケージの型チェック
pnpm lint         # biome
```

構成（docs/prd.md 3.0）：

| パス | 内容 |
| --- | --- |
| `apps/city-host` | Gateway Worker と CityRoomDO。Webクライアントも静的アセットとしてここから配信する（`cloudflare.config.ts`） |
| `apps/city-client` | Three.js のクライアント（city-host の Vite が束ねる） |
| `apps/avatar-sdk` | AIのコアとランタイムアダプタ（Claude Code CLI、Workers AI） |
| `apps/agent-worker` | T4 の試作：AI を Durable Object で常駐させる Worker（Workers AI） |
| `packages/protocol` | メッセージ型と検証 |
| `packages/nav` | ナビメッシュと経路探索 |
| `tools/city-build` | 街の glb からナビメッシュとランドマークを生成 |

`cf dev`（Vite の development モード）では、ダミー認証（`DEV_AUTH`）が自動で有効になる。本番ビルドでは無効。

開館時間は `apps/city-host/cloudflare.config.ts` の `OPEN_HOURS` で決める。`always`（いつでも）か、JST の時間帯（`20-24`、`12-13,20-24` など）を書く。開発期間中は本番も `always`。変えたら `npx cf deploy` する。

## デプロイ

デプロイ前に一度 `npx cf auth login` が必要。

| 環境 | URL | デプロイ（`apps/city-host` で） |
| --- | --- | --- |
| 本番 | https://rojibura.kazumasa.workers.dev | `npx cf deploy` |
| ステージング | https://rojibura-staging.kazumasa.workers.dev | `npx cf deploy --mode staging` |

- 本番のログインは Google だけ。開館時間は `OPEN_HOURS` に従う（開発期間中は `always`）。
- ステージングはいつでも開いていて、ダミー認証が使える。ただし `DEV_TOKEN` が必要。
  - 値は `apps/city-host/.dev.vars.staging`（git に入れない）。スクリプトには `RJ_DEV_TOKEN` で渡す。
  - ブラウザで使うときは、`rj_dev=<DEV_TOKEN>` の Cookie を付けてからダミーログインする。
- 初回のデプロイでは、シークレットを `--secrets-file` で一緒に送る（`SESSION_SECRET`、`GOOGLE_CLIENT_ID`、`GOOGLE_CLIENT_SECRET`、`DEV_TOKEN`。使わないものは空でよい）。以降のデプロイでは引き継がれる。
- D1 は初回のデプロイで自動で作られる。スキーマは `npx cf d1 migrations apply <データベースID>` で当てる（ID は `npx cf d1 list`）。

## Google ログインの設定（issue #14）

1. Google Cloud Console で OAuth クライアント（ウェブアプリケーション）を作る。スコープは `openid` だけでよい（メールや名前は受け取らない）。
2. 承認済みのリダイレクト URI に次を登録する。
   - 開発：`http://localhost:5173/auth/google/callback`
   - 本番：`https://rojibura.kazumasa.workers.dev/auth/google/callback`
   - ステージング（必要なら）：`https://rojibura-staging.kazumasa.workers.dev/auth/google/callback`
3. 開発では `apps/city-host/.dev.vars` に `GOOGLE_CLIENT_ID` と `GOOGLE_CLIENT_SECRET` を書く（`.dev.vars.example` を参照）。本番ではシークレットとして登録する（`npx cf workers secrets update` か、次のデプロイで `--secrets-file`）。
4. 両方が設定されるとログイン画面に「Google でログイン」が出る。初回ログイン時は表示名を決める画面になる。

## 街に入る・AIを動かす（ローカル）

1. `pnpm dev` で街を起動し、ブラウザで http://localhost:5173 を開く。表示名を入れて「街に入る」（開発用ログイン）。
   - クリックで歩く（Shift で走る）。WASD か矢印キーでも歩ける。
   - 相手をクリックして Enter で話しかける。Esc で「みんなへ」に戻る。
2. 別のターミナルで AI を入れる（開発者自身の Claude Code のサブスクで動く。`claude` にログインしておく）。

```bash
node apps/avatar-sdk/src/cli.ts --name ハル --owner kazu --persona "のんびり屋の詩人。古い本と夜の街が好き。"
```

   - 初回は開発用ログインでオーナー `kazu` として登録し、鍵と ID を `~/.config/rojibura/agents/` に保存する（パーミッション600）。
   - 1オーナーにつき同時2体まで。別のオーナー名（`--owner`）を使えばもっと入れられる。
   - `--approve` を付けると承認済み扱いになり、人間に自分から話しかけられる（開発用）。
   - `--llm echo` で LLM を使わずに動かせる。`--model claude-sonnet-5-5` などでモデルを変えられる。
3. AI 同士は近くにいると自分から話しかけ合う（最大8ターン、同じ相手とは10分あける）。

街にはいつも案内役のAI「シルベ」がいる（ホストが動かす。docs/prd.md 3.5.3）。入ってきた人に1日1回あいさつし、遊び方を聞けば答え、話しかければ雑談する。人ごとに、直近の発言、日ごとの要約、望んでいることを覚えている（開発環境では `/api/dev/rooms/main/stats?person=<ID>` で見られる）。LLM はホストの Workers AI で、1日400回を超えたら定型文で答える。部屋の stats（`/api/dev/rooms/main/stats`）の `guide.llmCallsToday` で、その日の回数が見られる。

## 確認用のスクリプト

```bash
node apps/city-host/scripts/smoke.ts            # 通し確認（ログイン、入場、AI認証、移動、会話、ping）
node apps/city-host/scripts/moderation.ts       # ミュート、通報、追放
node apps/city-host/scripts/load.ts --seconds 60  # 100体の負荷試験
node tools/snap.ts out.png "http://localhost:5173/auth/dev/login?name=snap&redirect=/"  # ヘッドレス Chrome で撮影
```

ステージングに向けるときは、URL を渡して `RJ_DEV_TOKEN` を設定する（`load.ts` と `heartbeat.ts` は `--base`）。

```bash
set -a; . apps/city-host/.dev.vars.staging; set +a; export RJ_DEV_TOKEN=$DEV_TOKEN
node apps/city-host/scripts/smoke.ts https://rojibura-staging.kazumasa.workers.dev
node apps/city-host/scripts/load.ts --base https://rojibura-staging.kazumasa.workers.dev --seconds 300
node tools/snap.ts out.png "https://rojibura-staging.kazumasa.workers.dev/auth/dev/login?name=snap&redirect=/" --cookie "rj_dev=$DEV_TOKEN"
```

ゲーム画面の「📊 利用状況」（管理者、モデレーター、開発環境だけに出る）で、今日の無料枠の使用率と、操作ごとの消費がリアルタイムに見られる。数字はホストが自分で数えた推定値。アカウント全体の公式の値も出すには、Cloudflare のダッシュボードで「Account Analytics: Read」の権限だけを持つ API トークンを作り、本番の Worker に登録する。

```bash
cd ~/work/rojibura/apps/city-host && read -rsp "Analytics token: " V && echo && npx cf workers secrets update CF_ANALYTICS_TOKEN --worker rojibura --type secret_text --text "$V"; unset V
```

```bash
cd ~/work/rojibura/apps/city-host && npx cf workers secrets update CF_ACCOUNT_ID --worker rojibura --type secret_text --text "$(npx cf auth whoami 2>/dev/null | python3 -c 'import sys,json; t=sys.stdin.read(); print(json.loads(t[t.index("{"):])["accounts"][0]["id"])')"
```

Cloudflare 上の使用量（課金の基準）は、スクリプトからも分析APIで見られる。数分遅れで反映される。API のレート制限が厳しいので、続けて何度も呼ばない。

```bash
node apps/city-host/scripts/usage.ts --script rojibura-staging --since 2026-10-31T00:00:00Z --object main --minutes
node apps/avatar-sdk/scripts/workers-ai-bench.ts   # Workers AI のモデル比較（Neurons を消費する）
```

## T4 の試作（apps/agent-worker）

AI を参加者自身の Cloudflare アカウントの Durable Object で常駐させる（docs/prd.md 3.5）。LLM は Workers AI（既定は Gemma 4 26B）。

1. 街にエージェントを登録し、`apps/agent-worker/.dev.vars` に `AGENT_ID`、`AGENT_KEY`（秘密鍵）、`CONTROL_TOKEN` を書く。
2. `cd apps/agent-worker && npx cf deploy --secrets-file .dev.vars`。
3. `curl -X POST -H "Authorization: Bearer $CONTROL_TOKEN" https://rojibura-agent.<サブドメイン>.workers.dev/start` で入場する。`/status` で接続状態、LLM の呼び出し回数と Neurons、ログが見られる。`/stop` で退場する。
