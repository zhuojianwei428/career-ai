// 回数制限の単体検証（実APIは呼ばない: OPENAI_API_KEY 未設定で mock パスを通る）
import handler from "./api/generate.js";

function makeRes() {
  let _status = 200, _body = null, _cookie = null;
  return {
    status(s) { _status = s; return this; },
    json(b) { _body = b; return this; },
    setHeader(k, v) { if (k === "Set-Cookie") _cookie = v; },
    _get() { return { status: _status, body: _body, cookie: _cookie }; }
  };
}
function makeReq(cookie) {
  return {
    method: "POST",
    headers: cookie ? { cookie } : {},
    body: { tool: "shibou", fields: { "応募種別": "新卒", "職種": "総務", "企業名": "テスト", "経験・キーワード": "研究" } }
  };
}

const out = [];
let cookie = "";
for (let i = 1; i <= 4; i++) {
  const res = makeRes();
  const req = makeReq(cookie);
  await handler(req, res);
  const r = res._get();
  if (r.cookie) cookie = r.cookie; // raw Set-Cookie を次回リクエストにそのまま渡す
  out.push(`#${i} status=${r.status} remaining=${r.body && r.body.remaining} limitReached=${r.body && r.body.limitReached}`);
}
console.log(out.join("\n"));

// 期待: #1 200 rem=1, #2 200 rem=0, #3 429 limitReached=true rem=0, #4 429
const ok = out[0].includes("200") && out[0].includes("remaining=1")
  && out[1].includes("200") && out[1].includes("remaining=0")
  && out[2].includes("429") && out[3].includes("429");
console.log(ok ? "\nPASS ✅" : "\nFAIL ❌");
process.exit(ok ? 0 : 1);
