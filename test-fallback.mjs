// ローカル単体テスト: 無料モデル順次フォールバックの検証（実APIを呼ばず fetch をモック）
// 使い方: OPENAI_API_KEY=test node test-fallback.mjs
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test";
// MODEL_FALLBACK / OPENAI_MODEL は未設定 → デフォルト無料チェーン [qwen-plus,qwen-max,qwen-turbo,qwen-long,qwen-flash]

let callLog = [];
function makeFetch(behavior) {
  return async (url, opts) => {
    const body = JSON.parse(opts.body);
    const model = body.model;
    callLog.push(model);
    const { status, payload } = behavior(model);
    return new Response(JSON.stringify(payload), { status });
  };
}

function resMock() {
  return {
    _c: 0, _j: null,
    status(c) { this._c = c; return this; },
    json(o) { this._j = o; return this; }
  };
}

const handler = (await import("./api/generate.js")).default;

// シナリオ1: 1番目(qwen-plus)が無料枠枯渇(429) → 2番目(qwen-max)で成功
callLog = [];
global.fetch = makeFetch((model) =>
  model === "qwen-plus"
    ? { status: 429, payload: { error: { message: "free quota exhausted", code: "QuotaExceeded" } } }
    : { status: 200, payload: { choices: [{ message: { content: "OK from " + model } }] } }
);
let req = { method: "POST", body: JSON.stringify({ tool: "shibou", fields: { "企業名": "テスト", "経験・キーワード": "x" } }) };
let res = resMock();
await handler(req, res);
console.log("[S1] status=%d tried=%j model=%s freeQuotaExhausted=%s text=%s",
  res._c, callLog, res._j.model, res._j.freeQuotaExhausted, (res._j.text || "").slice(0, 20));
const s1ok = res._c === 200 && res._j.model === "qwen-max" && callLog[0] === "qwen-plus" && callLog[1] === "qwen-max";

// シナリオ2: 全モデル枯渇(429) → 不捏造骨架に優雅に退化
callLog = [];
global.fetch = makeFetch(() => ({ status: 429, payload: { error: { message: "free quota exhausted", code: "QuotaExceeded" } } }));
req = { method: "POST", body: JSON.stringify({ tool: "shibou", fields: { "企業名": "テスト", "経験・キーワード": "x" } }) };
res = resMock();
await handler(req, res);
console.log("[S2] status=%d tried=%j freeQuotaExhausted=%s mock=%s hasPlaceholder=%s",
  res._c, callLog, res._j.freeQuotaExhausted, res._j.mock, (res._j.text || "").includes("【"));
const s2ok = res._c === 200 && res._j.freeQuotaExhausted === true && res._j.mock === true && res._j.text.includes("【");

// シナリオ3: 認証エラー(401) → 即失敗（他モデルへ回さない）
callLog = [];
global.fetch = makeFetch(() => ({ status: 401, payload: { error: { message: "Invalid API key", code: "AuthFailed" } } }));
req = { method: "POST", body: JSON.stringify({ tool: "shibou", fields: { "企業名": "テスト", "経験・キーワード": "x" } }) };
res = resMock();
await handler(req, res);
console.log("[S3] status=%d tried=%j (401は1回のみ呼べばOK)", res._c, callLog);
const s3ok = res._c === 500 && callLog.length === 1;

console.log("\nRESULT:", s1ok && s2ok && s3ok ? "PASS ✅" : "FAIL ❌");
process.exit(s1ok && s2ok && s3ok ? 0 : 1);
