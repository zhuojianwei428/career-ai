# 接入阿里云百炼 DashScope（国内站 · 無料モデル白嫖 ＋ 有料フォールバック qwen3.8-flash）

本指南带你把 `coverletterkit.com` 的 AI 生成后端从「本地 mock」切到「百炼の無料モデルで白嫖」構成。
方針：**複数の無料モデルを `MODEL_FALLBACK` に並べ、片方の無料枠が枯渇したら自動で次のモデルへ切替**。さらに末尾の `qwen3.8-flash` を「有料フォールバック」として置き、アカウントにチャージ残高があれば無料枠枯渇後も自動で継続生成する（すでにチャージ済み）。

> 状況：すでに百炼の汎用 API Key（`sk-ws-` 始まる）を入手済み。`api/generate.js` は OpenAI 互換で、**コード変更なし**で接続。
> `OPENAI_BASE_URL` 未設定時は既定で `https://dashscope.aliyuncs.com/compatible-mode/v1`（百炼）を使用。

---

## ⚠️ 支付方式（接入前先读，硬门槛）

**Model Studio 国际站（阿里云国际站）不支持微信支付，也不支持支付宝、银联卡。**
官方帮助中心原文：「国际站不支持支付宝、微信支付等中国境内支付方式。」

国际站支持的支付方式：
- **国际信用卡 / 借记卡**：带 Visa / Mastercard / AMEX / JCB 标识、且开通国际支付的卡
- **PayPal**：仅限**注册地非中国内地**的 PayPal 账户（内地 PayPal 会被拒）
- **银行电汇（T/T）**：信控用户可用

🔴 两个坑：
1. 国际站**不支持中国内地发行的信用卡**（双币 Visa/MC 也可能被拒，取决于发卡行风控）。最稳的是海外 PayPal。
2. 不支持人民币直接结算，需外币（美元等）扣款。

👉 如果你只有微信 / 支付宝、没有国际信用卡或海外 PayPal，请改用**国内百炼（阿里云中国站 `dashscope.aliyuncs.com`）**——国内站支持微信 / 支付宝，配置只差 `BASE_URL` 和 Key 区域，详见文末「六、备选：国内百炼（微信/支付宝）」。

⚡ **当前部署决策：采用路径 B（国内百炼）**，原因——支付约束（需微信 / 支付宝）。具体步骤见第六节；东京区（路径 A）作为技术更优备选保留。

---

## 一、Vercel に設定する環境変数（3 つ）

| 环境变量 | 含义 | 取值 |
|---|---|---|
| `OPENAI_API_KEY` | 百炼 汎用 API Key | デスクトップの `新建 文本文档.txt` に記載の `sk-ws-...` キー |
| `OPENAI_BASE_URL` | 百炼 OpenAI 互換端点 | `https://dashscope.aliyuncs.com/compatible-mode/v1`（未設定でも既定） |
| `MODEL_FALLBACK` | モデル順序（カンマ区切り・末尾は有料兜底） | `qwen-plus,qwen-max,qwen-turbo,qwen-long,qwen-flash,qwen3.8-flash`（無料5つ検証済み200；末尾 qwen3.8-flash は有料フォールバック） |

※ `OPENAI_MODEL` は単一モデル指定用（MODEL_FALLBACK 未設定時のみ使用）。変数名は `OPENAI_*` のまま、値に百炼を入れる。
※ キーは **Vercel の Environment Variables にのみ設定**し、コード・Git には絶対に含めない（`.env` も gitignore 推奨）。

---

## 二、分步操作（你在阿里云后台做）

### 步骤 1 — 登录 / 注册阿里云国际站
打开 **Model Studio 国际站控制台**：
`https://bailian.console.alibabacloud.com`
- 用邮箱或国际手机号注册（国际站，非国内 `aliyun.com`）。
- 首次进入按提示开通 **Model Studio**（激活免费，调用才计费）。

### 步骤 2 — 切到「Japan (Tokyo)」区域
控制台**右上角**有区域选择器，切到 **Japan (Tokyo)**（亚太东北 1）。
> 所有后续 Key、模型、端点都必须在这个区域下操作，否则会跨区 401。

### 步骤 3 — 创建东京区 API Key
进入左侧 **API Key** 页面 → **Create API Key** → 复制生成的 Key（形如 `sk-xxxx`）。
此 Key 即 `OPENAI_API_KEY`。

> 🔴 常见坑：东京区的 Key 只能调东京区端点；用北京/新加坡的 Key 调东京端点会 `401 invalid_api_key`。
> 解决：确保「区域」和「Key 创建区域」一致。

### 步骤 4 — 取得 WorkspaceId，拼出 BASE_URL
东京区端点带专属 WorkspaceId。获取方式（任选）：
- 在东京区控制台任意页面，浏览器地址栏含 `workspaceId=xxxx` 参数，复制 `xxxx`；
- 或在 API Key / 模型调用示例页，官方会给出完整 `base_url`，直接复制。

拼出：
```
https://{你的WorkspaceId}.ap-northeast-1.maas.aliyuncs.com/compatible-mode/v1
```
即 `OPENAI_BASE_URL`。（末尾 `/v1` 不要多写 `/chat/completions`，代码会自动补。）

### 步骤 5 — 确认模型名
东京区「模型」列表确认有 **qwen-plus**（通用商业版，非 thinking，直接出答案）。
若东京区暂未上架 `qwen-plus`，可改用 **Singapore** 区（等价替代，对日本延迟同样低）：
- 新加坡端点：`https://{WorkspaceId}.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1`
- 或国际通用域名（无需 WorkspaceId）：`https://dashscope-intl.aliyuncs.com/compatible-mode/v1`
- Key 也必须对应区域创建。

### 步骤 6 — 本地验证（可选，拿到 Key 后跑）
项目根目录已提供 `test-qwen.mjs`：
```bash
DASHSCOPE_API_KEY=sk-xxxx \
BASE_URL=https://{WorkspaceId}.ap-northeast-1.maas.aliyuncs.com/compatible-mode/v1 \
MODEL=qwen-plus \
node test-qwen.mjs
```
成功会打印一段日文回复，说明 Key/端点/模型三件套 OK。

### 步骤 7 — 配到 Vercel 并上线
1. 打开 Vercel 项目 `career-ai` → **Settings → Environment Variables**。
2. 新增 3 条（Production / Preview 都勾上）：
   - `OPENAI_API_KEY` = 你的东京区 Key
   - `OPENAI_BASE_URL` = 上面拼出的端点
   - `OPENAI_MODEL` = `qwen-plus`
3. 保存 → **Deployments → Redeploy**（或 push 一次触发）。
4. 打开 `coverletterkit.com` 任一口子（如志望動機），填企业名+经历点生成：
   - 返回不再是「※デモ文」即成功；
   - 仍显示デモ文 = Key 未生效，检查变量名/区域。

---

## 三、常见坑速查

| 现象 | 原因 | 解决 |
|---|---|---|
| `401 invalid_api_key` | Key 与端点区域不符 | 在端点同区域重新建 Key |
| `404` | BASE_URL 多写 `/chat/completions` 或 WorkspaceId 错 | 端点只到 `/v1`；核对 WorkspaceId |
| 返回带「思考过程」长文 | 误用 thinking 模型 | 改 `OPENAI_MODEL=qwen-plus`（非 qwen3.x-think） |
| 仍是デモ文 | 环境变量未生效/未 redeploy | 确认变量名、redeploy |
| 日文生硬 | 模型版本 | 升级 `qwen-plus` → `qwen-max`（约 3 分/次） |

---

## 四、成本回顾
- Qwen-Plus：输入 ¥0.8 / 输出 ¥2 每百万 tokens。
- 本站点单次约 5k 入 + 1.8k 出 ≈ **¥0.008/次**。
- 月 1 万次 ≈ ¥76；新用户有免费额度可先跑测试期。
- Vercel Serverless 免费额度（10 万次/月）覆盖调用，无额外费。

## 五、回滚 / 切换
- 删掉 Vercel 的 `OPENAI_API_KEY` → 自动回落到本地 mock（不捏造骨架仍生效）。
- 换模型順序：改 `MODEL_FALLBACK`（例：`qwen-turbo,qwen-plus,...`）。
- 换供应商：OpenAI 互換（DeepSeek / OpenRouter 等）なら `OPENAI_BASE_URL` と `OPENAI_API_KEY` のみ変更。`MODEL_FALLBACK` はその供应商のモデル名に合わせて調整。

---

## 六、本番構成：国内百炼（阿里云中国站）の「無料白嫖 ＋ 有料フォールバック qwen3.8-flash」

**現在の採用構成（チャージ済み）**。百炼の各モデルは独立して 100 万トークンの無料枠（90 日）を持つ。これを「白嫖」しつつ、無料枠が枯渇しても生成を止めないよう、末尾に有料フォールバック `qwen3.8-flash` を置く：

1. `OPENAI_API_KEY` = すでに取得済みの百炼汎用キー（`sk-ws-` 始まる）
2. `OPENAI_BASE_URL` = `https://dashscope.aliyuncs.com/compatible-mode/v1`
3. `MODEL_FALLBACK` = `qwen-plus,qwen-max,qwen-turbo,qwen-long,qwen-flash,qwen3.8-flash`
   - `qwen-plus` が主軸（バランス◎）。無料枠枯渇 → `qwen-max` → `qwen-turbo` → `qwen-long` → `qwen-flash` と自動切替。
   - **末尾の `qwen3.8-flash` は「有料フォールバック」**：上記無料5つがいずれも 429（無料枠枯渇）になったら自動で呼ばれ、アカウントにチャージ残高があれば有料で継続生成。**サイトは止まらない。**
   - 切替の判定：`429`（レート/無料枠枯渇）・`400`（モデル不在）・`5xx` は次へ。`401/403`（認証）は即失敗。
   - **真の全滅（無料5つ＋有料 qwen3.8-flash も不可）時のみ**：「不捏造」骨架（【】占位符付き）を返し、サイトは止まらない（`freeQuotaExhausted:true` を返す）。
   - 順序の変更/追加は `MODEL_FALLBACK` を上書きするだけ（例：より安い `qwen-turbo` を先頭にして無料枠を伸ばすことも可）。
4. ローカル動作確認：`test-fallback.mjs`（無料枠枯渇→有料兜底継続→全滅退化 をモックで検証、実APIは呼ばない）。

⚠️ 注意：
- `qwen3.8-flash` は **reasoning（思考）モデル**。content は clean だが reasoning トークンも課金・少し遅い。更快/更省にしたい場合は `api/generate.js` の `callModel` でリクエスト body に `enable_thinking:false` を追加。
- 遅延：国内端点から日本アクセスで約 200–400ms（生成 1–3 秒、体感可）。
- コンプライアンス：入力は阿里云国内へ送信（データ出境扱い）。求职テキストの秘密度は低いが留意。
- 無料枠残量 / チャージ残高は百炼コンソール「リソースパック」で確認。
