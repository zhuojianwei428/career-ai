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
├─ privacy.html       個人情報の取り扱い（プライバシーポリシー）
├─ robots.txt         Sitemap 宣言 ＋ /api/ と /account.html を除外
├─ sitemap.xml        インデックス対象 6 ページ（loc と lastmod のみ）
├─ .vercelignore      **パターン指定**で内部ドキュメント・テストを配信対象から除外（`*_SETUP.md` / `test-*.mjs` / `_*.mjs`）
├─ assets/css/style.css
├─ assets/js/engine.js  共有エンジン（生成・編集・写真・PDF・txt・認証UI・計測・企業確認・字数・穴埋め・コピー）
└─ api/
   ├─ generate.js       生成（OpenAI 互換。企業情報は**確認済みの法人番号だけ**を受け取る）
   ├─ company.js        企業名 → 候補 → 確認（P0-0。生成の前段。500 を返さない）
   ├─ auth.js           登録 / メール認証 / ログイン / セッション
   ├─ records.js        生成履歴の取得
   └─ _lib/             gbiz.mjs（gBizINFO の唯一の URL 組み立て点）
                        storage.mjs（Redis ＋ scrypt）/ email.mjs（Resend）
```

> `.vercelignore` は**個別列挙ではなくパターン**で書きます。1 つずつ並べると、次にファイルを
> 足した人が必ず漏らし、気づかないまま配信されます。`test-p1-baseline.mjs` が
> **glob として実際に一致するか**＋**まだ存在しない将来のファイルも一致するか**＋
> **配信対象を巻き込んでいないか（対照）** を検査します。
> なお **配信除外 ≠ 秘匿**です。リポジトリが public のあいだは GitHub 上で誰でも読めます。

## 機能
- **企業確認（生成の前段・必須）**：企業名を入れて欄から離れると gBizINFO の候補（法人名／所在地／業種／設立／法人番号）が出る。**1 社を選んで「✓ 確認済み」になってから**でないと生成に進まない。選んだ内容は折りたたみで事前に全部見られる（この情報だけが prompt に入る）。
- 生成：フォーム入力 → `/api/generate` → 編集可能な文書として表示
- 編集：結果は `contenteditable` でその場で書き換え（履歴書の氏名等も編集可能）
- **穴埋め（`【 】`）**：情報が足りない箇所は短いラベルの `【 】` で残される。本文中のそれをクリックするとその場で入力でき、埋めると装飾は消えてただの本文になる。節見出し（`【学歴】` 等）と説明用の空 `【 】` はクリック対象にしない（`SECTION_LABELS` で判別）。
- **字数のリアルタイム表示**：`いま N 字（改行を除く）／目安 a〜b字／【 】が残り n 箇所`。`Intl.Segmenter` で書字素単位に数える。**モデルが文末に書く「（文字数：698字）」はサーバ側で除去**してから数える（自己申告は実測と合わない）。
- **全文コピー**：ワンクリックで全文をクリップボードへ（`copy_all`）。
- 写真：履歴書・職務経歴書は写真枠を用意。アップロードでプレビュー
- 出力：ブラウザ印刷で A4/PDF（依存ゼロ）、および .txt 出力
- モバイル：狭い画面では結果を全画面で編集（`body.edit-full` ＋ `--vvh` でソフトキーボードに追随）。印刷時は通常配置に戻る。
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
- 発火イベント（14）：`generate_start` / `generate_success` / `generate_error` / `limit_reached` / `example_fill` / `pdf_export` / `text_export` / `signup_code_sent` / `signup_complete` / `login_success` / `logout` / **`copy_all` / `ph_fill` / `hint_tag_insert`**
  - 見るべきファネルは 2 本：**`generate_start` → `generate_success`**（生成成功率＝離脱ポイントの特定）と、**`limit_reached` → `signup_complete`**（上限到達＝登録意欲が最も高い瞬間を分母にした登録率）。
  - 新規 3 件は「生成後」の行動：**`ph_fill`**（穴埋めを実際に埋めた数＝文案の詰まり具合）、**`copy_all`**（＝転換に最も近い行動）、**`hint_tag_insert`**（補助タグを使って書き始めた）。`generate_success` には `truncated`（出力上限で切れたか）と `gaps_left`（残った `【 】` の数）を載せている。
  - `generate_start` には `company_confirmed` を載せている。**未確認で `generate_error` に落ちる率が高いなら、確認 UI が重すぎるサイン**。
- **転換導線**：全ツールページのフォーム先頭に「例を入れてみる」（`CareerAI.fillExample(formId, EXAMPLE)`）。`EXAMPLE` のキーは各ページの `data-field` と一致していないと**無言で無視される**ため、`test-seo-lp.mjs` がキー一致・必須項目充足・chip 選択肢の実在まで検証する。`index.html` はさらに HERO 直下に「入力例 → 生成結果例」を置き、出力フォーマットを先に見せる（框内の `【 】` は「捏造しない」方針の可視化）。
- **CLS 対策**：ナビの認証欄はログアウト時（ログイン 1 ボタン）とログイン時（マイページ ＋ ログアウト）で幅が変わり、`Auth.me()` の応答時にナビ全体が横にずれる。`.auth-area` に `min-width: 10.25rem` を予約して消している（狭い画面ではナビ高さを優先して解除）。
- この一群の回帰テスト：`node test-seo-lp.mjs`（133 項目・ネットワーク不要）

## 「不捏造」エンジン（gBizINFO ＋ プロンプト）
- **企業研究（gBizINFO v2）**：経済産業省の法人情報 REST API から業種・事業概要・資本金・従業員数・特許・補助金・認定・職場情報を取得し prompt に注入する。トークンは `GBIZ_API_TOKEN`（未設定なら自動でスキップ）。手順は [GBIZ_SETUP.md](./GBIZ_SETUP.md)、URL 組み立ては `api/_lib/gbiz.mjs` の**1 か所だけ**。
- 🔴 **同名の別法人を防ぐ「確認してから生成」（P0-0・2026-09-21）**：gBizINFO が直った直後に生まれた**新しい種類の危険**への対策。捏造（存在しない情報）は疑いようがあるが、**実在する別会社の実データ**は一見それらしく、ユーザーは気づかないまま面接で語ってしまう。
  - 変更前：サーバが企業名で検索 → **自動で 1 社目**を採用 → 生成。
  - 変更後：`/api/company` が候補一覧を返す → **ユーザーが選択** → `detail` で「生成に使う情報」を生成**前**に見せる → **確認済みの法人番号だけ**を `/api/generate` に渡す。
  - 重要なのは**サーバ側が企業名で自動検索を一切しなくなった**こと。名前から引く経路が残っている限り、誤配線の可能性も残る。したがって未確認のまま生成した場合は `gbiz.step: "no-confirmation"` になり、**企業情報は 1 件も混ざらない**（`notice` で再入力を促す）。
  - 法人番号は URL パスに連結するため `/^[0-9]{13}$/` で検証し、不正なら **fetch を 1 回も発行しない**（`../../zzz` のような値を投げても外部到達ゼロ）。
  - 「確認」で生成を止めない：候補ゼロ・DB 未設定・通信失敗・ユーザーが「使わない」を選んだ——のいずれも**生成可能**（`fallback` / `declined`）。新しい必須ステップが行き止まりを作らないようにしている。
- ⚠️ **2026-09-21 に修正した重大バグ**：検索 URL を `GBIZ_BASE + "/?name=…"`（**末尾スラッシュ付き**）にしていたため、ルートに一致せず**トークンが正しくても必ず HTTP 500** が返り、`companyContextUsed` が常に false だった。しかも失敗がログに出ず無言で `null` を返す実装だったため、**機能が全滅していても誰も気づけない**状態が続いていた。正しい形は `GBIZ_BASE + "?name=…"`。
  - 切り分け方：**401=ルート有り（認証層に到達）/ 500=ルート未マッチ**。存在しないダミールート `/zzz` が 500 を返すのと同じ挙動になるので、パスの誤りはこれで一発で判る。curl で試すと Windows の schannel が TLS 再ネゴシエーションで本文を取りこぼすため、**Node の fetch で確認する**こと。
- **失敗を必ず観測できる形にした**：`gbizGet()` は `{ok, status, error, data}` を返し、失敗時は `console.error("[gbiz][FAIL] …")` に URL と上流ステータスを残す。リクエストごとに `console.log("[gbiz] {…}")` を出し、レスポンスにも `gbiz`（`{configured, ok, step, status, error, hits, corporateNumber}`）を載せるので、**本番に 1 リクエストで現在の状態を確認できる**。異常ではないケース（法人データに該当なし＝`search-empty`、トークン未設定＝`no-token`、未確認＝`no-confirmation`）は FAIL ログにしない。`/api/company` 側も `[company][search]` / `[company][detail]` / `[company][SKIP]` / `[company][LIMIT]` を出し、**どれも 500 を返さない**。
- **捏造禁止ルール**：`api/generate.js` の `NO_FABRICATION_RULES` に一本化し、**構造化契約（`buildPrompt`）と旧契約（`messages`）の両方に前置**する。片方だけだとツールによって捏造の有無が変わる（実際 `index.html` 以外の 4 ツールは旧契約を通っており、この規則が一切効いていなかった）。特に「企業のミッション・理念・スローガンを `「」` 付きで引用しない」「企業情報に無い数値を書かない」「文字数を自己申告しない」を明文化している（プロンプトに書いただけでは足りないので、実測で検証する）。
  - 実測で効いた順は **「引用符を禁じる」＞「"捏造するな"と書く」**。企業の理念の捏造は、**`「」` で括って"会社がそう言った"体裁にする**ことで初めて成立するからで、`「」``『』` を禁じると捏造の**文体そのもの**が書けなくなる。
  - **規則は必ず出力フォーマットの直前に置く**（プロンプト先頭に置いただけでは弱い）。旧契約（`messages`）では `NO_FABRICATION_RULES` が `content` の先頭に来るよう組み立てている。
- **出力の完全性**：`finish_reason === "length"` を検知して `truncated: true` を返し、`notice` にも「文が途中で切れた可能性（出力上限）」を出してログ `[gen][FAIL]` に残す。`MAX_TOKENS` は reasoning モデルの思考分も同じ枠を食うため **1600 → 3000** に拡大した（1600 では「長め 500〜800字」指定時に切れる）。
- 回帰テスト：`node test-p1-baseline.mjs`（**177 項目**・ネットワーク不要）。gBizINFO のスタブが**実測した壊れ方（末尾スラッシュ＝500）を再現する**ので、同じ改修をするとテストが落ちる。ハンドラを実際に走らせて `companyContextUsed`・`notice`・`gbiz` の診断値まで確認する。`node test-p0.mjs`（**207 項目**）は確認フロー・不正な法人番号で fetch 0 回・実レート制限・文案・去歧義・字数・モバイルまで見る。

## 回帰テスト一覧（すべてネットワーク不要）

```
node test-p0.mjs              207 項目  P0-0 確認フロー / 文案 / 占位符 / 字数 / モバイル
node test-p1-baseline.mjs     177 項目  gBizINFO の URL・失敗の可観測性 / 捏造禁止規則 / 截断
node test-seo-lp.mjs          133 項目  sitemap・robots・構造化データと可視 FAQ の一致 / EXAMPLE キー
node test-auth-e2e.mjs         42 項目  登録→認証→ログイン→上限→履歴（fake Redis + fake Resend）
node test-redis-outage.mjs     28 項目  Redis 障害時の降級・断路器・自動復旧
node test-redis-env-names.mjs  11 項目  KV_REST_API_* / UPSTASH_* どちらの変数名でも動く
node test-ratelimit.mjs         匿名 Cookie 上限
node test-fallback.mjs          モデル順次フォールバック
node --check assets/js/engine.js
```

変更後はこの一式を通してから push する。`node test-live-smoke.mjs`（**ネットワーク必須**）は
デプロイ後の生存確認用で、全ページ 200・`configured` の状態・偽セッションで 500 を出さないこと・
認証 API の異常系が 4xx に落ちることなどを 37 項目で見る。

## 次の拡張（クラスタ深化）
- 各ツールの「職種別」サブページ（例：`/shinsotsu/eigyo.html`）で長尾を取りに行く
  - ※ 新規サイトの第一優先は**既存 5 ページの転換率**。programmatic SEO はその後。
- 手引きの更なる充実（滞在時間・E-E-A-T）。FAQ は構造化データまで完了
- ~~企業名の入力時リアルタイム候補（gBizINFO）~~ → **P0-0 で実装済み**（`/api/company`）。
  次にやるなら「かな/ローマ字表記ゆれの吸収」と「候補の並び順チューニング」。ただし
  並び順で自動的に 1 社へ絞るのは禁止（誤配線が復活する）。
- **強文案の解禁**：`そのまま提出できる` は P0-0 の本番稼働＋より大きなサンプルでの再測定
  （捏造率と企業情報の一致率の両方）を通過するまで**使わない**。現状は半升级版。
- 無料回数 → クレジット課金、または有料就活サービスへの誘導
