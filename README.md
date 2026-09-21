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
├─ account.html       マイページ（生成履歴）
├─ robots.txt         Sitemap 宣言 ＋ /api/ と /account.html を除外
├─ sitemap.xml        インデックス対象 5 ページ（loc と lastmod のみ）
├─ assets/css/style.css
├─ assets/js/engine.js  共有エンジン（生成・編集・写真・PDF・txt・認証UI・計測）
└─ api/
   ├─ generate.js       生成（OpenAI 互換 ＋ gBizINFO 企業研究）
   ├─ auth.js           登録 / メール認証 / ログイン / セッション
   ├─ records.js        生成履歴の取得
   └─ _lib/             storage.mjs（Redis ＋ scrypt）/ email.mjs（Resend）
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
- 認証まわりの E2E テスト：`test-auth-e2e.mjs`（フェイク Redis + フェイク Resend で登録→認証→ログイン→上限→履歴まで通す）、`test-redis-env-names.mjs`（変数名 2 通りどちらでも動くこと・11項目）、`test-redis-outage.mjs`（**Redis 障害時の降級**・28項目）
- **本番スモークテスト**：`node test-live-smoke.mjs`（ネットワーク必須）。実メールを送らずに、全ページ 200・`configured/emailConfigured`・偽セッションで 500 を出さないこと・認証 API の異常系が 4xx に落ちること・登録が 503 か 200 のいずれかであること・匿名生成が 200/429 であることを 37 項目で確認する。デプロイ後の生存確認に使う。
- **Redis 障害時も 500 を返さない**：`_lib/storage.mjs` が全メソッドをラップし例外を投げずに null を返すため、ログイン中でも自動で「匿名（Cookie 2回/日）」に降級して生成は継続。障害検知後 30 秒は呼び出しを止めるサーキットブレーカー付きで、復旧は自動。新規登録のみ 503 で止める（保存できていないコードをメールで送らない）。詳細は [REDIS_SETUP.md](./REDIS_SETUP.md)。
- 容量の目安：Free プラン（月50万コマンド）でヘビーユーザー約250人 / 軽いユーザー約800人。**匿名アクセスは Redis を一切使わない**（Cookie 制限）ため 0 コマンド。上限到達時は Upstash コンソールから Pay As You Go（$0.2/10万コマンド、予算上限設定可）へ切替のみで、コード変更もデータ移行も不要。詳細は [REDIS_SETUP.md](./REDIS_SETUP.md)。

## SEO ・計測 ・転換導線
- **sitemap / robots**：`/robots.txt` と `/sitemap.xml` はリポジトリ直下の静的ファイル（Vercel がそのまま配信）。**GSC に登録するのは `https://www.coverletterkit.com/sitemap.xml`**。`account.html` はログイン必須なので sitemap に含めず robots でも除外。`changefreq` / `priority` は Google が無視するため書いていない。
- **構造化データ（FAQPage）**：`index.html` の head に JSON-LD を 1 ブロック。Google は **2023-08 以降 FAQ リッチリザルトを政府・医療の権威サイトに限定**しているため、ここでの目的は SERP 装飾ではなく **AI Overviews / LLM に Q&A 構造を正しく渡すこと**（HowTo は完全廃止済みなので使わない）。Google の要件どおり **構造化データの内容はページ上の可視 FAQ と完全一致**させる必要があるので、両者の乖離を `test-seo-lp.mjs` が毎回照合する（片方だけ直すと即 FAIL）。
- **計測（GA4）**：有効化は `assets/js/engine.js` 冒頭の **`var GA4_ID = "";` に `G-XXXXXXXXXX` を入れるだけ**（1 か所で全ページに効く。`<meta name="ga4-id" content="...">` を置けばそちらが優先）。未設定のあいだは gtag.js を読み込まず `track()` は何もしないので、ID が無くてもページに影響しない。計測の初期化は `load` 後なので LCP / INP を悪化させない。IP は匿名化して送信。
- 発火イベント（11）：`generate_start` / `generate_success` / `generate_error` / `limit_reached` / `example_fill` / `pdf_export` / `text_export` / `signup_code_sent` / `signup_complete` / `login_success` / `logout`
  - 見るべきファネルは 2 本：**`generate_start` → `generate_success`**（生成成功率＝離脱ポイントの特定）と、**`limit_reached` → `signup_complete`**（上限到達＝登録意欲が最も高い瞬間を分母にした登録率）。
- **転換導線**：全ツールページのフォーム先頭に「例を入れてみる」（`CareerAI.fillExample(formId, EXAMPLE)`）。`EXAMPLE` のキーは各ページの `data-field` と一致していないと**無言で無視される**ため、`test-seo-lp.mjs` がキー一致・必須項目充足・chip 選択肢の実在まで検証する。`index.html` はさらに HERO 直下に「入力例 → 生成結果例」を置き、出力フォーマットを先に見せる（框内の `【 】` は「捏造しない」方針の可視化）。
- **CLS 対策**：ナビの認証欄はログアウト時（ログイン 1 ボタン）とログイン時（マイページ ＋ ログアウト）で幅が変わり、`Auth.me()` の応答時にナビ全体が横にずれる。`.auth-area` に `min-width: 10.25rem` を予約して消している（狭い画面ではナビ高さを優先して解除）。
- この一群の回帰テスト：`node test-seo-lp.mjs`（107 項目・ネットワーク不要）

## 次の拡張（クラスタ深化）
- 各ツールの「職種別」サブページ（例：`/shinsotsu/eigyo.html`）で長尾を取りに行く
  - ※ 新規サイトの第一優先は**既存 5 ページの転換率**。programmatic SEO はその後。
- 手引きの更なる充実（滞在時間・E-E-A-T）。FAQ は構造化データまで完了
- 企業名の入力時リアルタイム候補（gBizINFO）。現状は生成時にサーバ側で自動補完するため、
  社名を誤っても生成自体は成功し【 】が残るだけ。「入力を止めない」導線は
  **計測で離脱ポイントが判明してから**着手する
- 無料回数 → クレジット課金、または有料就活サービスへの誘導
