# 認証ストア（Redis）の用意 — ログイン機能を本番で有効にする

ログイン・生成履歴（マイページ）は **Vercel の Redis 統合（Upstash Redis）** に保存します。
（Vercel KV は Upstash Redis に統合されたため、新規作成は Redis 連携から行います。コード上は `@upstash/redis` を使用。）

未設定の場合でもサイトは動きますが、**ログイン機能とマイページは無効**になり、生成は匿名の「1日2回」のままです。

## 手順（Vercel ダッシュボード）
1. プロジェクト `career-ai` → **Storage** タブ → **Create Database**。
2. 一覧から **Upstash** → さらに **`Upstash for Redis`** を選ぶ。
   - ⚠️ 同じ一覧にある **`Redis — Official Redis for Vercel` は選ばない**（TCP 接続用の `REDIS_URL` を注入する別製品。本コードは REST の URL/TOKEN を読むため動きません）。
   - Upstash の他製品（Vector / QStash / Search）も不要です。
3. Terms of Service → **Accept and Create**。
4. **Configuration and Plan** の設定：

   | 項目 | 値 | 理由 |
   |---|---|---|
   | Primary Region | **Tokyo（hnd1）** | 日本のユーザに最も近い |
   | Read Regions | **空** | 只読レプリカは有料。単一地域で十分 |
   | Eviction | **False** | 有効にすると容量到達時に古いデータ（＝ユーザー記録）を黙って削除する |
   | Plan | **Free** | 256MB / 月50万コマンド。詳細は下記「容量の目安」 |

5. **Confirmation** → **Create**。
6. **Connect a Project**：
   - Project = `career-ai`
   - Environments = `Production, Preview`（ローカルで `vercel dev` を使わないなら Development は不要）
   - **Custom Prefix は空にする**（後述の変数名に影響します）
   - Sensitive は ON のままで OK
7. **Environment Variables** に自動追加された**変数名を確認**（次項）。
8. **Deployments** → 最新ビルドを **Redeploy**（環境変数はビルド時に注入されるため、再デプロイしないと反映されません）。

## 変数名は 2 通りある（Custom Prefix で変わる）
Vercel Marketplace の Upstash 連携は、`Custom Prefix` の指定によって生成される変数名が変わります。
**コード側は両方に対応済み**なので、どちらでも動きます（`api/_lib/storage.mjs` の `redisUrl()/redisToken()`）。

| Custom Prefix | 生成される変数名 |
|---|---|
| 空（既定） | `KV_REST_API_URL` / `KV_REST_API_TOKEN` |
| `UPSTASH` など | `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` |

- `KV_REST_API_READ_ONLY_TOKEN` は**読み取り専用なので使いません**（書き込みが失敗します）。
- 変数の値は `Sensitive: ON` だとダッシュボードから見えませんが、実行時には問題なく読み込まれます。
- 手動で追加する場合は Project → Settings → Environment Variables から（Type: Plaintext / 全環境にチェック）。

## 容量の目安（Free プラン = 月50万コマンド）
実測したコマンド消費量（`api/_lib/storage.mjs` の実装から集計）：

| 操作 | コマンド数 |
|---|---|
| 匿名ユーザーがページを開く | **0** |
| 匿名ユーザーが 1 回生成 | **0**（Cookie 制限のため Redis 不使用） |
| ログイン中がページを開く | 2 |
| ログイン中がマイページを開く | 5 |
| ログイン中が 1 回生成 | 8 |
| 新規登録（コード送信〜認証） | 約10（1回のみ） |

→ ログイン中ユーザーのみが消費。すべての生成を毎日使い切るヘビーユーザー換算で **月50万 ≒ 約250人**、
軽いユーザーなら **約800人**。匿名アクセスは何人でも 0 コマンドです。
上限に近づいたら Upstash コンソールから **Pay As You Go**（$0.2 / 10万コマンド、予算上限を設定可）に
切り替えられます。**REST URL / TOKEN は変わらないので、コード変更もデータ移行も不要**です。

## 設定できる環境変数
| 変数 | 既定 | 意味 |
|---|---|---|
| `UPSTASH_REDIS_REST_URL` / `KV_REST_API_URL` | （いずれか必須） | Redis REST エンドポイント |
| `UPSTASH_REDIS_REST_TOKEN` / `KV_REST_API_TOKEN` | （いずれか必須） | Redis トークン（書き込み権限のある方） |
| `LOGGED_DAILY_LIMIT` | `5` | ログイン中ユーザの1日生成上限（匿名は固定2回） |

## 動作確認
1. `curl https://www.coverletterkit.com/api/auth` → `"configured":true` が返ること（false なら変数名か Redeploy を疑う）。
2. デプロイ完了後、サイト右上に「ログイン」ボタンが表示される。
3. 「新規登録」で**実在のメールアドレス**＋パスワード（6文字以上）を登録 → 届いた6桁コードを入力して認証（メール送信の設定は [EMAIL_SETUP.md](./EMAIL_SETUP.md)）。
4. 志望動機などを生成 → **マイページ（/account.html）** に履歴が保存される。
5. ログイン中は1日5回まで生成可能（匿名は2回）。

## ローカルテスト（ネットワーク不要）
| スクリプト | 内容 |
|---|---|
| `node test-auth-e2e.mjs` | 偽 Redis + 偽 Resend/千問で 登録→認証→ログイン→上限→履歴（42項目） |
| `node test-redis-env-names.mjs` | `UPSTASH_*` / `KV_REST_API_*` どちらの変数名でも動くこと（11項目） |
| `node test-redis-outage.mjs` | **Redis 障害時の降級**：500 を返さず匿名動作／サーキットブレーカー／自動復旧（28項目） |
| `node test-ratelimit.mjs` | 匿名 Cookie 上限 |
| `node test-fallback.mjs` | モデル順次フォールバック |

## 障害時の挙動（500 を返さない設計）
Redis が落ちてもサイトは止まりません。`api/_lib/storage.mjs` が全メソッドをラップし、
例外を投げずに `null` を返すため、呼び出し側は「未設定のとき」と同じ経路に自然に落ちます。

| 状況 | 挙動 |
|---|---|
| 匿名ユーザーが生成 | **影響なし**（Cookie 制限なので Redis を元々使わない） |
| ログイン中が生成 | セッション解決に失敗 → **匿名扱い（Cookie 2回/日）に降級**。500 は出ない |
| ログイン中がマイページ | 履歴が空表示（エラーにはならない） |
| 新規登録 | コードの保存に失敗したら **503**（保存できていないコードをメールで送って行き止まりにしない） |
| 復旧 | **自動**。障害検知後 `KV_DOWN_MS`（既定 30 秒）は Redis を叩かず、その後は通常動作に戻る |

- サーキットブレーカーは**恒久無効化しません**（30 秒ごとに再試行するので、復旧すれば自動で戻ります）。
- `KV_DOWN_MS` はテスト用に短縮できます（既定 30000）。
- 変数が未設定のときは従来どおり `configured:false` を返し、ログイン機能は「準備中」表示になります。

## セキュリティ留意点
- パスワードは `scrypt` ソルト付きハッシュで保存（平文は保存されません）。
- セッションは httpOnly Cookie（`clk_session`）で管理。
- 認証コードは 10 分有効・誤入力 5 回で破棄・再送は 10 分 5 回まで。
- フリーティアの Redis は容量・回数に上限あり。履歴は1ユーザ最新200件に抑えています。
- 本格運用では、なりすまし防止にレート制限（同一IP の登録試行等）の追加を推奨。
