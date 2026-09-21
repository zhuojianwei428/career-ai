# 認証ストア（Redis）の用意 — ログイン機能を本番で有効にする

ログイン・生成履歴（マイページ）は **Vercel の Redis 統合（Upstash Redis）** に保存します。
（Vercel KV は Upstash Redis に統合されたため、新規作成は Redis 連携から行います。コード上は `@upstash/redis` を使用。）

未設定の場合でもサイトは動きますが、**ログイン機能とマイページは無効**になり、生成は匿名の「1日2回」のままです。

## 手順（Vercel ダッシュボード）
1. プロジェクト `career-ai` → **Storage** タブ（または Marketplace → Redis）。
2. **Redis（Upstash）** を選び、**Create / Connect** する（無料枠で十分）。
3. 作成後、プロジェクトの **Environment Variables** に以下が自動で追加されることを確認：
   - `UPSTASH_REDIS_REST_URL`
   - `UPSTASH_REDIS_REST_TOKEN`
   - ※ 自動で入らない場合は、Redis 詳細画面の値を手動で追加（Type: Plaintext で OK）。
4. **Deployments** → 最新ビルドを **Redeploy**（または Push で再デプロイ）。

## 設定できる環境変数
| 変数 | 既定 | 意味 |
|---|---|---|
| `UPSTASH_REDIS_REST_URL` | （必須） | Redis REST エンドポイント |
| `UPSTASH_REDIS_REST_TOKEN` | （必須） | Redis トークン |
| `LOGGED_DAILY_LIMIT` | `10` | ログイン中ユーザの1日生成上限（匿名は固定2回） |

## 動作確認
1. デプロイ完了後、サイト右上に「ログイン」ボタンが表示される。
2. 「新規登録」でメール＋パスワード（6文字以上）を登録 → 自動でログイン。
3. 志望動機などを生成 → **マイページ（/account.html）** に履歴が保存される。
4. ログイン中は1日10回まで生成可能（匿名は2回）。

## セキュリティ留意点
- パスワードは `scrypt` ソルト付きハッシュで保存（平文は保存されません）。
- セッションは httpOnly Cookie（`clk_session`）で管理。
- フリーティアの Redis は容量・回数に上限あり。履歴は1ユーザ最新200件に抑えています。
- 本格運用では、なりすまし防止にレート制限（同一IP の登録試行等）の追加を推奨。
