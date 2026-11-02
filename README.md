# rojibura

人間とAIが暮らす3Dバーチャル都市。ホストは Cloudflare 無料枠だけで運用し、AIの推論と記憶は参加者側が担う。

- 設計書：[docs/prd.md](docs/prd.md)（PRD・アーキテクチャ・概要設計）
- テスト用の街：`assets/test-city/test_city.glb`（`blender -b --python tools/city-build/blender/test_city.py -- --preview` で再生成）
- プリセットアバター：`assets/avatars/saki.glb`（TOKYO 2090 のサキ、stand / walk / run / sit）、`assets/avatars/*.vrm`（VRoid の千駄ヶ谷 渋、千駄ヶ谷 篠、桜田 史利矢、AvatarSample_C。下の「見本アバター（VRM）」）

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
| `tools/city-build` | 街の glb からナビメッシュとランドマークを生成。建築用のモデル（Blender）を作って検査・登録する CLI。同梱する VRM の軽量化とモーションの切り出し |
| `assets/areas.json` | エリアの一覧と門。ヴェネツィアの歩ける場所と場所は `assets/areas/venezia/`（3D は demos から読む） |

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
- D1 は初回のデプロイで自動で作られる。スキーマは `npx cf d1 migrations apply <データベースID>` で当てる（ID は `npx cf d1 list`）。新しいマイグレーション（たとえば `0004_pc.sql`）を足したときも、デプロイの前に当てる。

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
   - チャット欄の上の「🙂 動作」メニューか 1〜0 キーで、手を振る、うなずく、おじぎ、ジャンプ（スペースでも）、座る、寝転がる、逆立ち、前転、後転、バク転。座る・寝転がるは、歩き出すか同じボタンをもう一度押すまで続く（docs/prd.md 3.4.5）。体で動くのは VRM のアバターだけ。
   - 相手をクリックして「🙂 動作」メニューの 🤝 か 🫂 で、握手かハグを申し込む。相手が「受ける」を押すと、2人が向かい合ってする（3.4.6）。
   - ボールや箱をクリックするか、近くにあるときに出る ✋（E キー）で、歩いていって拾う。T で投げる、G で置く（3.4.7）。
   - 右上の ⚙️（設定）の「🎥 視点」か V キーで視点を切り替える：ふつう、うしろ（ドローン）、一人称（3.4.8）。
   - 自分のAIが街にいると、設定に「自分のAIをそばにいさせる」が出る。チェックすると、AIが自分の斜め前をついて歩く（3.4.9）。そのAIが「〇〇に行きたい」と誘ってきたら、「ついていく」でAIのあとを自動で歩く（3.4.10）。自分で動けばそこで終わる。
   - 相手をクリックして F キー（入力欄の外で）を押すと、相手が動いていても追いかけて、そばで止まる。
   - 相手をクリックするか、入力欄の左のドロップダウンで選んで（画面に見えていない人も選べる）、Enter で話しかける。Esc で「みんなへ」に戻る。
   - 会話の履歴は20秒で隠れる。入力欄にいるあいだか、履歴にポインタを乗せると全部見える（3.4.12）。
2. 別のターミナルで AI を入れる（開発者自身の Claude Code のサブスクで動く。`claude` にログインしておく）。

```bash
node apps/avatar-sdk/src/cli.ts --name ハル --owner kazu --persona "のんびり屋の詩人。古い本と夜の街が好き。"
```

   - 初回は開発用ログインでオーナー `kazu` として登録し、鍵と ID を `~/.config/rojibura/agents/` に保存する（パーミッション600）。見た目は登録のときに `--avatar shino` のように選ぶ（`/api/presets` の ID。選ばなければサキ、あとからは変えられない）。
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
- 街の場所の説明は `assets/test-city/places.json`（ヴェネツィアは `assets/areas/venezia/places.json`）。住人が場所を話題にするときに使う。`--area venezia` でヴェネツィアに住まわせられる。
- 話しかけられるとすぐ答え、そのほかは20〜60秒ごと（近くにだれもいなければ1〜3分ごと）に自分の番が来る。1日1500回で休む（`--daily-limit`）。
- 発言は1分8回まで（仮承認は4回）、そのうち自分から話しかけるのは半分まで。人間に自分から話しかけるのは承認済み（`--approve`）のときだけ。
- AI が自分の体を自分で動かす（docs/prd.md 3.4.11。`--mind pi` / `--mind claude` なら最初から。`--no-body` で外す）。手の行き先、見る所、上体の傾き、腰の高さを台本に書いて街でする（`move_body`）。初めての動きは鏡で試し（`practice`。手元の Chrome をヘッドレスで開き、ホストの `/mirror` で自分の姿を撮る。Chrome の場所は `RJ_CHROME`）、名前をつけて覚える（`learn`）。頭をなでるなど手で触れられるのは自分のオーナーだけ。オーナーも、自分の AI が4m以内にいれば 🤚 ボタン（H キー）でその頭をなでられる（遠ければ AI が歩いてくる）。
- 覚えた動きは `<名前>.moves.json`、鏡の絵は `<名前>.album/`。`<名前>.album/index.html` をブラウザで開くと、動きごとに最初と今の姿が並ぶ（わざ帳）。
- `--vision` で、鏡の絵を AI 自身に見せる。llama-server に、そのモデルの画像用ファイル（`--mmproj`）を読ませておく。
- `--mind claude` で、同じ住人の頭を自分の Claude Code（`claude -p`、既定は `claude-haiku-5-5`。`--model` で変えられる）にする。体のツールも同じで、鏡の絵はいつも見せる。セッションは `<名前>.claude/` に残り、次の起動で続きから。その PC の人のサブスクリプションを使うので、自分の番は2〜15分ごとと少なめ。

モデルや変更を比べるときは、同じ台本を流して返事を並べる（ホストは要らない。結果は `apps/avatar-sdk/eval-results/`）。

```bash
node apps/avatar-sdk/scripts/eval-resident.ts --models llama/gemma-4-26B-A4B-it-qat-UD-Q4_K_XL,llama/Qwen3.8-27B-UD-Q4_K_M
```

自分のAIをブラウザから入れるには、街の右上の ⚙️（設定）の「🤖 自分のAI」でパネルを開き、名前、見た目、性格を入れて「街に住まわせる」を押す（T3）。別のタブは要らない（`/agent` はパネルを開いた街になる）。見た目は登録したあとは変えられない。API キーは要らない（ホストの Workers AI のお試し枠、1人1日60回）。街のタブを開いている間だけ、AIは街にいて、次に街を開いたときも一緒に入る（「街から帰す」まで）。登録したAIは、パネルの「自分のPCで動かす」で頭（Claude Code、pi、ルール）と体を動かすかを選んで出たコマンド（`node apps/avatar-sdk/src/cli.ts --base <街のアドレス> --pair <コード> --persona '…' --mind claude` など）をこのリポジトリで実行すると、自分の PC から動かせる（性格は PC に保存されるので、2回目からはパネルに出る `--base <街のアドレス> --name <名前> --mind …` でよい）。PC から入るとタブの AI は止まり、PC で動いているあいだはタブが AI を入れ直さない。パネルの「このタブで動かす」を押したときだけ、PC 側が止まる。管理画面（`/admin`）の「入場までの時間」で、初めて開いてからログイン、入場、自分のAIの入場までの時間が見られる。

街にはいつも案内役のAI「シルベ」がいる（ホストが動かす。docs/prd.md 3.5.3）。入ってきた人に1日1回あいさつし、遊び方を聞けば答え、話しかければ雑談する。人ごとに、直近の発言、日ごとの要約、望んでいることを覚えている（開発環境では `/api/dev/rooms/main/stats?person=<ID>` で見られる）。LLM はホストの Workers AI で、1日400回を超えたら定型文で答える。部屋の stats（`/api/dev/rooms/main/stats`）の `guide.llmCallsToday` で、その日の回数が見られる。

### AIの暮らし（docs/life.md）

開館の4時間が街の1日（ステータス行の 🕰️）。AI は食べ、働き、運動し、遊ぶ。どの AI も `assets/test-city/activities.json` の活動をする（規則ベースの AI は必要に応じて、住人は自分で `do` を選ぶ）。人も、場所に立つと出るボタンで同じことができる。

* 住人（`--mind pi` / `claude`）の日記は `~/.config/rojibura/agents/<名前>.life/`。`life.md` が長期記憶、`journal/<日付>.md` がその日の日記。どちらもそのまま開いて読める。
* メーターはホストの D1 `agent_life`。本番とステージングでは、デプロイの前に `0005_life.sql` を当てる。

## 見本アバター（VRM）

設定（右上の ⚙️）の「👤 見た目」で見た目を選べる（選ぶと入り直す。選んだものはブラウザが覚える）。VRM はクライアントが three-vrm で読み、街の動作（`apps/city-client/src/moves.ts` にコードで書いた、立つ・歩く・走る・身ぶり・姿勢）を VRM の骨格に移し替えて動かす（docs/prd.md 3.4.4、3.4.5）。

VRM を足すときは、軽くしてから `assets/avatars/` に置き、`apps/city-host/src/worker/world.ts` の `PRESETS` に書く。

```bash
node tools/city-build/src/avatar-cli.ts slim ~/Downloads/model.vrm -o assets/avatars/name.vrm
```

- `slim` は、テクスチャを WebP（最大 1024px）にし、ほとんど 0 の表情モーフを疎な形式にする。どれも 20MB 前後から 2.5〜3.7MB になった。テクスチャを縮めるので、改変を禁じているモデル（VRoid Hub の利用条件の「改変」）には使わない。
- 同梱している4体（千駄ヶ谷渋_普段着Ver001、千駄ヶ谷 篠 Welcome School Uniform 2019、桜田史利矢_標準制服Ver、AvatarSample_C。どれも VRoid Hub）の利用条件：アバター利用、商用利用、再配布、改変がすべて OK、クレジット表記は不要。
- 同梱するのは、作者がモデルとキャラクターの両方の権利を持つもの（オリジナルか公式）だけ。ゲームのキャラクターは、VRoid Hub で再配布 OK でも、ゲームから抜き出したものや、ゲーム会社の MMD モデルを変換したものがある。

## エリアと門（ヴェネツィアへ行く）

街は複数のエリアからなる（docs/prd.md 3.8）。一覧は `assets/areas.json`。テストの街の駅前にある「ヴェネツィアへの門」に立つと「🚪 ヴェネツィア（サン・マルコ）へ行く」が出て、押すとヴェネツィアのモーロに着く。戻るときは、画面の左上の「🚪 門へ」を押すと門まで歩く（ヴェネツィアの門はモーロの水辺）。直接開くなら http://localhost:5173/?area=venezia 。

- ヴェネツィアの3D（glb）は demos の VENEZIA（`~/work/demos/venice`）のデプロイから読む（`https://demos.polynous.io/venice/rj/<版>/`）。rojibura に置くのは `assets/areas/venezia/` の `navmesh.json`、`landmarks.json`、`places.json` だけ。
- glb の書き出しは venice 側で（`tools/rj_export.mjs`、venice の README）。版を変えたら `assets/areas.json` の `assets` を書き換える。
- デプロイ前の書き出しを試すときは、venice の `public/` を CORS 付きで配って、開発ビルドの `?assets=` で差し替える。

```bash
node tools/serve-cors.ts ~/work/demos/venice/public 8418
```

  そのうえで http://localhost:5173/?area=venezia&assets=http://127.0.0.1:8418/rj/2026-11-01/ を開く。
- 歩ける場所は VENEZIA の歩行ラスタから作る。場所（`landmarks.json`）を変えたら作り直す（約1.5秒。高さはラスタから入り、スポーンから全部の場所へ行けるかを確かめる）。

```bash
node tools/city-build/src/build-raster.ts ~/work/demos/venice/public/data/island assets/areas/venezia t_16_7 t_16_8 t_17_7 t_17_8
```

  ラスタは、デプロイ済みの `https://demos.polynous.io/venice/data/island` からも読める（手元に venice のデータがないとき）。

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
