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
   - `MODEL_FALLBACK` ：（推奨）カンマ区切りのモデル順序。例 `qwen-plus,qwen-max,qwen-turbo,qwen-long,qwen-flash`
   - `OPENAI_MODEL`   ：（任意）単一モデル指定時（MODEL_FALLBACK 未設定時のみ利用）
3. デプロイ。各ツールは `/` `/jiko-pr.html` 等の静的ページ、生成は `/api/generate` 関数。

### 推奨（白嫖構成）：阿里云百炼 DashScope の無料モデル順次フォールバック
百炼の各モデルは独立して 100 万トークンの無料枠（90 日）あり。複数を `MODEL_FALLBACK` に並べ、片方の無料枠が枯渇したら自動で次のモデルへ切替わる（認証エラー以外は全滅まで回る。全滅時は「不捏造」骨架に優雅に退化しサイトは止まらない）。詳細は **[QWEN_SETUP.md](./QWEN_SETUP.md)**、フォールバック単体テストは `test-fallback.mjs`。
- `OPENAI_API_KEY` = 百炼（aliyun.com / dashscope）で作成した API Key（`sk-ws-` 始まる汎用キー）
- `OPENAI_BASE_URL` = `https://dashscope.aliyuncs.com/compatible-mode/v1`（未設定でも既定）
- `MODEL_FALLBACK` = `qwen-plus,qwen-max,qwen-turbo,qwen-long,qwen-flash`（検証済み：いずれも無料枠で 200 応答）
※ 国内站は実名認証（中国身份证）必須。課金しない限り無料枠のみ消費。各モデルの無料枠状況は百炼コンソール「リソースパック」で確認。

## 次の拡張（クラスタ深化）
- 各ツールの「職種別」サブページ（例：`/shinsotsu/eigyo.html`）で長尾を取りに行く
- 手引き/FAQ の更なる充実（滞在時間・E-E-A-T）
- 無料回数 → クレジット課金、または有料就活サービスへの誘導
