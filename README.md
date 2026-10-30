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
| `apps/avatar-sdk` | AIのコアとランタイムアダプタ |
| `packages/protocol` | メッセージ型と検証 |
| `packages/nav` | ナビメッシュと経路探索 |
| `tools/city-build` | 街の glb からナビメッシュとランドマークを生成 |

`cf dev`（Vite の development モード）では、ダミー認証（`DEV_AUTH`）と開館時間の解除（`DEV_ALWAYS_OPEN`）が自動で有効になる。本番ビルドでは無効。

デプロイ前に一度 `npx cf auth login` が必要。

## Google ログインの設定（issue #14）

1. Google Cloud Console で OAuth クライアント（ウェブアプリケーション）を作る。スコープは `openid` だけでよい（メールや名前は受け取らない）。
2. 承認済みのリダイレクト URI に次を登録する。
   - 開発：`http://localhost:5173/auth/google/callback`
   - 本番：`https://<worker名>.<サブドメイン>.workers.dev/auth/google/callback`
3. 開発では `apps/city-host/.dev.vars` に `GOOGLE_CLIENT_ID` と `GOOGLE_CLIENT_SECRET` を書く（`.dev.vars.example` を参照）。本番ではシークレットとして登録する。
4. 両方が設定されるとログイン画面に「Google でログイン」が出る。初回ログイン時は表示名を決める画面になる。

## 街に入る・AIを動かす（ローカル）

1. `pnpm dev` で街を起動し、ブラウザで http://localhost:5173 を開く。表示名を入れて「街に入る」（開発用ログイン）。
   - クリックで歩く（Shift で走る）、WASD でも歩ける。
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

## 確認用のスクリプト

```bash
node apps/city-host/scripts/smoke.ts            # 通し確認（ログイン、入場、AI認証、移動、会話、ping）
node apps/city-host/scripts/load.ts --seconds 60  # 100体の負荷試験
node tools/snap.ts out.png "http://localhost:5173/auth/dev/login?name=snap&redirect=/"  # ヘッドレス Chrome で撮影
```
