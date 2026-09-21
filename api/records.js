// Vercel Serverless Function — 生成記録（ログインユーザ専用）
// GET: 記録一覧  /  POST: 記録保存。いずれもセッション必須。

import { kvReady, resolveSession, listRecords, saveRecord } from "./_lib/storage.mjs";

function json(res, code, obj) {
  res.status(code).json(obj);
}

const TOOL_LABEL = {
  shibou: "志望動機", jiko_pr: "自己PR", rirekisho: "履歴書",
  shokumu: "職務経歴書", mensetsu: "面接対策"
};

export default async function handler(req, res) {
  if (!kvReady()) return json(res, 503, { error: "ストアが未設定です。" });
  const session = await resolveSession(req);
  if (!session) return json(res, 401, { error: "ログインが必要です。" });

  if (req.method === "GET") {
    const items = await listRecords(session.userId);
    return json(res, 200, { email: session.email, records: items });
  }

  if (req.method === "POST") {
    let body;
    try {
      body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    } catch (e) {
      return json(res, 400, { error: "Invalid JSON" });
    }
    const text = (body && body.text) || "";
    if (!text.trim()) return json(res, 400, { error: "保存する内容がありません。" });
    const rec = {
      tool: body.tool || "shibou",
      toolLabel: TOOL_LABEL[body.tool] || "志望動機",
      scene: (body.scene || "").slice(0, 40),
      company: (body.company || "").slice(0, 80),
      len: (body.len || "").slice(0, 40),
      tone: (body.tone || "").slice(0, 40),
      text: text.slice(0, 8000)
    };
    const ok = await saveRecord(session.userId, rec);
    if (!ok) return json(res, 500, { error: "保存に失敗しました。" });
    return json(res, 200, { saved: true });
  }

  return json(res, 405, { error: "Method not allowed" });
}
