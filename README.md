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
