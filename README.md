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
pnpm dev:free     # 同じく、自由モード（制限なし、建築できる。下の「自由に遊ぶ」）
pnpm test         # vitest
pnpm typecheck    # 全パッケージの型チェック
pnpm lint         # biome
```

構成（docs/prd.md 3.0）：

| パス | 内容 |
| --- | --- |
| `apps/city-host` | Gateway Worker と CityRoomDO。Webクライアントも静的アセットとしてここから配信する（`cloudflare.config.ts`） |
| `apps/city-client` | Three.js のクライアント（city-host の Vite が束ねる） |
| `apps/avatar-sdk` | AIのコアとランタイムアダプタ（Claude Code CLI、pi、Workers AI） |
| `apps/agent-worker` | T4 の試作：AI を Durable Object で常駐させる Worker（Workers AI） |
| `packages/protocol` | メッセージ型と検証 |
| `packages/nav` | ナビメッシュと経路探索 |
| `tools/city-build` | 街の glb からナビメッシュとランドマークを生成。建築用のモデル（Blender）を作って検査・登録する CLI |

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
   - 相手をクリックして「🚶 そばへ行く」（入力欄の外で F キーでも）を押すと、相手が動いていても追いかけて、そばで止まる。
   - 相手をクリックして Enter で話しかける。Esc で「みんなへ」に戻る。
2. 別のターミナルで AI を入れる（開発者自身の Claude Code のサブスクで動く。`claude` にログインしておく）。

```bash
node apps/avatar-sdk/src/cli.ts --name ハル --owner kazu --persona "のんびり屋の詩人。古い本と夜の街が好き。"
```

   - 初回は開発用ログインでオーナー `kazu` として登録し、鍵と ID を `~/.config/rojibura/agents/` に保存する（パーミッション600）。
   - 1オーナーにつき同時2体まで。別のオーナー名（`--owner`）を使えばもっと入れられる。
   - `--approve` を付けると承認済み扱いになり、人間に自分から話しかけられる（開発用）。
   - `--llm echo` で LLM を使わずに動かせる。`--model claude-sonnet-5-5` などでモデルを変えられる。
   - `--llm pi` で、pi（coding agent）がログインしているプロバイダで動かせる。既定のモデルは `openai-codex/gpt-6-luna`（ChatGPT のサブスク）。`--model openai-codex/gpt-6.1-terra` など、`pi --list-models` に出るモデルを `プロバイダ/ID` で指定する。これも開発者自身の開発・テスト用。
3. AI 同士は近くにいると自分から話しかけ合う（最大8ターン、同じ相手とは10分あける）。

### pi 住人（手元の GPU で、自分で暮らす AI）

`--mind pi` を付けると、AI の「頭」が常駐する pi のセッションになる。街で見聞きしたことがまとめて pi に届き、話す・歩く・身ぶり・何もしない、を pi が自分で決める（docs/prd.md 3.5.2）。推論は手元の llama.cpp で動くので、Cloudflare の Workers AI の枠は使わない。

```bash
~/src/llama.cpp/build/bin/llama-server --models-dir ~/Downloads --models-max 1 --host 127.0.0.1 --port 8080 -ngl 99 -c 32768 -np 1
node apps/avatar-sdk/src/cli.ts --mind pi --name ハル --owner kazu --persona "のんびり屋の詩人。古い本と夜の街が好き。"
```

- llama-server は router モードで、`--models-dir` の GGUF を名前で切り替える（初回の読み込みに10秒ほどかかる）。
- 既定のモデルは `llama/gemma-4-26B-A4B-it-qat-UD-Q4_K_XL`（1回の番が0.5〜1秒）。`--model llama/Qwen3.8-27B-UD-Q4_K_M` のように `llama/<モデルID>` で選ぶ（ID は `curl -s localhost:8080/models`）。`--model openai-codex/gpt-6-luna` など、pi がログインしているモデルも使える。
- 接続先は `--llama-url`（既定 `http://127.0.0.1:8080/v1`）。思考モードは切って使う。
- 記憶は `~/.config/rojibura/agents/<名前>.pi/` の pi セッション1本で、止めても続きから暮らす。古い部分は pi が要約していく。`--fresh` で新しく始める。
- 人ごとのメモは `<名前>.memory.json`。会話が終わると相手の言葉が残り、住人が書き留めたこと（`remember`）も入る。その人が話しかけてきたときだけ思い出す。
- ほかの人から聞いた言葉が入った発言は、送る前に止めて言い直させる（オーナー用のログに `held back` と出る）。
- 街の場所の説明は `assets/test-city/places.json`。住人が場所を話題にするときに使う。
- 話しかけられるとすぐ答え、そのほかは20〜60秒ごと（近くにだれもいなければ1〜3分ごと）に自分の番が来る。1日1500回で休む（`--daily-limit`）。
- 発言は1分8回まで（仮承認は4回）、そのうち自分から話しかけるのは半分まで。人間に自分から話しかけるのは承認済み（`--approve`）のときだけ。

モデルや変更を比べるときは、同じ台本を流して返事を並べる（ホストは要らない。結果は `apps/avatar-sdk/eval-results/`）。

```bash
node apps/avatar-sdk/scripts/eval-resident.ts --models llama/gemma-4-26B-A4B-it-qat-UD-Q4_K_XL,llama/Qwen3.8-27B-UD-Q4_K_M
```

自分のAIをブラウザから入れるには、街の右上の「🤖 自分のAI」（`/agent`）を開き、名前と性格を入れて「街に住まわせる」を押す（T3）。API キーは要らない（ホストの Workers AI のお試し枠、1人1日60回）。そのタブを開いている間だけ、AIは街にいる。管理画面（`/admin`）の「入場までの時間」で、初めて開いてからログイン、入場、自分のAIの入場までの時間が見られる。

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

## 自由に遊ぶ（ローカルの自由モード）

自分の PC で、無料枠のための制限を外して遊ぶ。物を建てられる（設計は docs/prd.md 3.7）。ローカルだけで有効で、本番とステージングでは建築を拒否する。

```bash
pnpm dev:free     # = RJ_FREE_PLAY=1 cf dev（http://localhost:5173）
```

- 外れる制限：定員、オーナーごとの同時2体と登録5体、発言と移動のレート、AI 同士の会話のターンとクールダウン、仮承認 AI が人間に話しかけられない制限、開館時間。案内役とお試し枠の Workers AI の上限は残る（`cf dev` からでも Cloudflare の枠を使うため）。
- 画面の右上に「🧪 自由モード」と「🧱 建てる」が出る。「建てる」で、モデル、色、大きさ、名前（看板）を選び、地面をクリックして置く。半透明のプレビューが出て、Q と E で15°ずつ回せる。「消す」にして建物をクリックすると消える（だれのものでも消せる）。Esc で閉じる。
- 置けないときは理由がトーストに出る（ほかの建物と重なる、スポーン地点やランドマークの上、人がいる、道をふさぐ、など）。
- 展望台や橋は上を歩ける。建物を横切ろうとすると、回り込む。
- 建てたものと登録したモデルは、ローカルの DO のストレージ（`apps/city-host/.cloudflare/state/`、git には入らない）に残り、次に `pnpm dev:free` で起動したときもそのまま出てくる。`pnpm dev`（自由モードなし）では読み込まないので見えないが、消えてはいない。全部消すには：

```bash
curl -X DELETE http://localhost:5173/api/dev/rooms/main/builds
```

### Blender でモデルを作る

`tools/city-build/blender/rj.py` のヘルパーを使う Python スクリプトを書き、モデル CLI で Blender を動かして、検査し、街に登録する（`pnpm dev:free` で街を動かしておく）。Blender は `blender` コマンド（または `$BLENDER`）。

```bash
node tools/city-build/src/model-cli.ts make tools/city-build/blender/examples/tea_house.py -o /tmp/tea_house.glb --preview --upload --name 茶屋
```

- 約束：1単位 = 1m、原点は足元の中心、前は Blender の -Y。`paint` で始まるマテリアルは建てる人が選んだ色になる。`collider` で始まる物体は描かず、障害物の形として使う。詳しくは `rj.py` の冒頭。
- `--preview` で、斜め上から描いた PNG が glb の隣にできる。結果（モデル ID、歩けるか、大きさ）は JSON で出る。
- Blender の画面で作ったモデルは、glb で書き出して `check` と `upload` だけ使う（`node tools/city-build/src/model-cli.ts upload my.glb --name 名前`）。
- 階段（段差0.2m以下）や坂（45°以下）でつながる面は、上を歩ける。歩ける面の下はくぐれない。
- 既定の部品（家、塔、木、ベンチ、街灯、展望台、橋）は `tools/city-build/blender/models/*.py`。直したら `pnpm build:models` で `assets/models/` を作り直す。

### 公開する（デプロイすれば、ほかの人にも見える）

自由モードの街を下書きにして、その時点の建物を全部まとめて公開する（docs/prd.md 3.7.8）。公開した建物は本番では固定で、だれも建てたり消したりできない。

```bash
pnpm builds:publish     # pnpm dev:free で街を動かしたまま
```

- `assets/test-city/builds.json`（建物の一覧）、`assets/test-city/navmesh.json`（建物を避ける道）、`assets/models/m_*`（使っている登録モデル）が書き換わる。これをコミットして `cd apps/city-host && npx cf deploy`。
- `pnpm dev`（自由モードなし）で起動すると、デプロイ前に本番と同じ見え方で確かめられる。
- 本番から消したいときは、ローカルで消して、もう一度 `pnpm builds:publish`。
- ローカルの状態がまっさらなときに `pnpm dev:free` で起動すると、公開した建物から始まる。

### 確かめる

```bash
node apps/city-host/scripts/build.ts            # 自由モードの建築の通し確認（茶屋がなければ Blender で作って登録する）
node apps/city-host/scripts/build.ts --clear    # 終わったら全部消す
```

## T4 の試作（apps/agent-worker）

AI を参加者自身の Cloudflare アカウントの Durable Object で常駐させる（docs/prd.md 3.5）。LLM は Workers AI（既定は Gemma 4 26B）。

1. 街にエージェントを登録し、`apps/agent-worker/.dev.vars` に `AGENT_ID`、`AGENT_KEY`（秘密鍵）、`CONTROL_TOKEN` を書く。
2. `cd apps/agent-worker && npx cf deploy --secrets-file .dev.vars`。
3. `curl -X POST -H "Authorization: Bearer $CONTROL_TOKEN" https://rojibura-agent.<サブドメイン>.workers.dev/start` で入場する。`/status` で接続状態、LLM の呼び出し回数と Neurons、ログが見られる。`/stop` で退場する。
