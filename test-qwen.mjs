// 本地 smoke test：验证千问 Qwen-Plus（Model Studio 国际站）三件套是否可用。
// 用法：
//   DASHSCOPE_API_KEY=sk-xxxx \
//   BASE_URL=https://{WorkspaceId}.ap-northeast-1.maas.aliyuncs.com/compatible-mode/v1 \
//   MODEL=qwen-plus node test-qwen.mjs
//
// 成功：打印一段日文回复。失败：打印错误（多为 401 区域不符 / 404 端点错 / 网络）。

const key = process.env.DASHSCOPE_API_KEY;
const base = process.env.BASE_URL;
const model = process.env.MODEL || "qwen-plus";

if (!key || !base) {
  console.error("缺少环境变量：请设置 DASHSCOPE_API_KEY 与 BASE_URL");
  process.exit(1);
}

const url = base.replace(/\/+$/, "") + "/chat/completions";

const body = {
  model,
  messages: [
    { role: "system", content: "あなたは日本語の採用ライターです。簡潔に答えてください。" },
    { role: "user", content: "志望動機の第1文を20文字程度で書いてください。" }
  ],
  temperature: 0.8,
  max_tokens: 200
};

try {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + key },
    body: JSON.stringify(body)
  });
  const data = await r.json();
  if (!r.ok) {
    console.error("HTTP " + r.status, JSON.stringify(data, null, 2));
    process.exit(1);
  }
  const text = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  console.log("✅ 调用成功（" + model + "）");
  console.log("回复：", text);
  const usage = data.usage;
  if (usage) console.log("tokens:", JSON.stringify(usage));
} catch (e) {
  console.error("❌ 调用失败：", e.message);
  process.exit(1);
}
