# 就活AI（career-ai）

志望動機・自己PR・履歴書・職務経歴書・面接対策を AI で生成し、その場で編集して PDF 出力できるツール群。
各キーワードは独立したツールページ（= 独立 URL）で、SEO の内容クラスターを構成。

## 構成
```
career-ai/
├─ index.html         志望動機AI（旗舰页）
├─ jiko-pr.html       自己PR
├─ rirekisho.html     履歴書（写真枠付き）
├─ shokumu.html       職務経歴書（写真枠付き）
├─ mensetsu.html      面接対策
├─ assets/css/style.css
├─ assets/js/engine.js  共有エンジン（生成・編集・写真・PDF・txt）
└─ api/generate.js       Vercel Serverless 生成関数（OpenAI 互換）
```

## 機能
- 生成：フォーム入力 → `/api/generate` → 編集可能な文書として表示
- 編集：結果は `contenteditable` でその場で書き換え（履歴書の氏名等も編集可能）
- 写真：履歴書・職務経歴書は写真枠を用意。アップロードでプレビュー
- 出力：ブラウザ印刷で A4/PDF（依存ゼロ）、および .txt 出力
- 制限：匿名は**1日2回/人**（Cookie で同日カウント、サーバ側強制）。**ログイン中は1日5回**（Redis でカウント・全デバイス共有、`LOGGED_DAILY_LIMIT` で変更可）。超過は `429` を返しフロントでボタンを無効化。単体テストは `test-ratelimit.mjs`

## ローカル確認
```
cd career-ai
npx serve .        # または python -m http.server
```
※ `api/generate.js` は Vercel 上でのみ実行されます。キー未設定時は日本語のデモ文を返します。

## Vercel デプロイ
1. このフォルダを Git リポジトリに push（または Vercel にドラッグ＆ドロップ）。
2. 環境変数を設定（未設定ならデモ動作）。`api/generate.js` は OpenAI 互換。モデルは複数指定でき、無料枠枯渇時に自動で次へ切替：
   - `OPENAI_API_KEY` ：API キー
   - `OPENAI_BASE_URL`：（任意）互換エンドポイント。未設定時は `https://dashscope.aliyuncs.com/compatible-mode/v1`（百炼）
   - `MODEL_FALLBACK` ：（推奨）カンマ区切りのモデル順序。末尾に有料フォールバック `qwen3.8-flash` を置くと、無料枠枯渇後もチャージ残高があれば継続生成。例 `qwen-plus,qwen-max,qwen-turbo,qwen-long,qwen-flash,qwen3.8-flash`
   - `OPENAI_MODEL`   ：（任意）単一モデル指定時（MODEL_FALLBACK 未設定時のみ利用）
3. デプロイ。各ツールは `/` `/jiko-pr.html` 等の静的ページ、生成は `/api/generate` 関数。

### 推奨構成：阿里云百炼 DashScope の「無料白嫖 ＋ 有料フォールバック」
百炼の各モデルは独立して 100 万トークンの無料枠（90 日）あり。複数を `MODEL_FALLBACK` に並べ、片方の無料枠が枯渇したら自動で次のモデルへ切替わる。さらに**末尾の `qwen3.8-flash` を「有料フォールバック」として置く**と、アカウントにチャージ残高があれば無料枠枯渇後も自動で継続生成（サイトは止まらない）。認証エラー以外は全滅まで回り、全滅時のみ「不捏造」骨架に優雅に退化。詳細は **[QWEN_SETUP.md](./QWEN_SETUP.md)**、フォールバック単体テストは `test-fallback.mjs`。
- `OPENAI_API_KEY` = 百炼（aliyun.com / dashscope）で作成した API Key（`sk-ws-` 始まる汎用キー）
- `OPENAI_BASE_URL` = `https://dashscope.aliyuncs.com/compatible-mode/v1`（未設定でも既定）
- `MODEL_FALLBACK` = `qwen-plus,qwen-max,qwen-turbo,qwen-long,qwen-flash,qwen3.8-flash`（無料5つは検証済み 200；末尾 qwen3.8-flash は有料フォールバック、チャージで継続生成）
※ `qwen3.8-flash` は reasoning（思考）モデル。更快/更省にしたい場合は `api/generate.js` の呼び出しに `enable_thinking:false` を追加。
※ 国内站は実名認証（中国身份证）必須。各モデルの無料枠残量は百炼コンソール「リソースパック」で確認。

## ログイン・マイページ（生成履歴）
- 右上に「ログイン」ボタン（全ページ共通）。**新規登録は実在メール必須**：`noreply@coverletterkit.com` から届く**6桁の認証コード**（10分有効）を入力して初めてアカウントが確定します。パスワードは scrypt + ソルトでハッシュ保存。
- 総当たり対策：コード誤入力は5回まで（超過で保留データ破棄→再登録）。再送信は10分あたり5回まで。
- ログイン中は生成履歴が **Redis** に保存され、`/account.html`（マイページ）でいつでも確認可能。
- ログイン中は1日生成上限が2回→**5回**にアップ。
- ストア／メール未設定時はログイン機能は無効、匿名の「1日2回」のまま動作。
- 用意手順：ストア（Redis）は **[REDIS_SETUP.md](./REDIS_SETUP.md)**、メール送信（Resend）は **[EMAIL_SETUP.md](./EMAIL_SETUP.md)**。
- バックエンド：`api/auth.js`（登録/メール認証/再送/ログイン/ログアウト/状態）、`api/records.js`（履歴保存/取得）、`api/_lib/storage.mjs`（Redis ラップ＋ハッシュ）、`api/_lib/email.mjs`（認証メール送信）。フロント：`assets/js/engine.js` の `Auth` モジュール。
- 環境変数：`RESEND_API_KEY` / `RESEND_FROM`（既定 `noreply@coverletterkit.com`）/ `RESEND_REPLY_TO`（既定 `contact@coverletterkit.com`）/ `LOGGED_DAILY_LIMIT`（既定 5）。
- **Redis の変数名は 2 通り**：Vercel 連携の `Custom Prefix` が空なら `KV_REST_API_URL` / `KV_REST_API_TOKEN`、`UPSTASH` 等を入れれば `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`。コードは両方に対応（`api/_lib/storage.mjs` の `redisUrl()/redisToken()`）。`*_READ_ONLY_TOKEN` は使わない。
- 認証まわりの E2E テスト：`test-auth-e2e.mjs`（フェイク Redis + フェイク Resend で登録→認証→ログイン→上限→履歴まで通す）、`test-redis-env-names.mjs`（変数名 2 通りどちらでも動くこと・11項目）
- 容量の目安：Free プラン（月50万コマンド）でヘビーユーザー約250人 / 軽いユーザー約800人。**匿名アクセスは Redis を一切使わない**（Cookie 制限）ため 0 コマンド。上限到達時は Upstash コンソールから Pay As You Go（$0.2/10万コマンド、予算上限設定可）へ切替のみで、コード変更もデータ移行も不要。詳細は [REDIS_SETUP.md](./REDIS_SETUP.md)。

## 次の拡張（クラスタ深化）
- 各ツールの「職種別」サブページ（例：`/shinsotsu/eigyo.html`）で長尾を取りに行く
- 手引き/FAQ の更なる充実（滞在時間・E-E-A-T）
- 無料回数 → クレジット課金、または有料就活サービスへの誘導
