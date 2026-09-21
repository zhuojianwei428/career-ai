// ローカル単体テスト: 無料モデル + 有料フォールバック(qwen3.8-flash) の検証（実APIを呼ばず fetch をモック）
// 使い方: OPENAI_API_KEY=test node test-fallback.mjs
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test";
// MODEL_FALLBACK / OPENAI_MODEL は未設定 → デフォルト [qwen-plus,qwen-max,qwen-turbo,qwen-long,qwen-flash,qwen3.8-flash]

const FREE = ["qwen-plus", "qwen-max", "qwen-turbo", "qwen-long", "qwen-flash"];

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
  return { _c: 0, _j: null, status(c) { this._c = c; return this; }, json(o) { this._j = o; return this; } };
}
const handler = (await import("./api/generate.js")).default;
const baseBody = { tool: "shibou", fields: { "企業名": "テスト", "経験・キーワード": "x" } };

// S1: 1番目(qwen-plus)が無料枠枯渇(429) → qwen-max で成功
callLog = [];
global.fetch = makeFetch((m) => m === "qwen-plus"
  ? { status: 429, payload: { error: { message: "free quota exhausted" } } }
  : { status: 200, payload: { choices: [{ message: { content: "OK from " + m } }] } });
let res = resMock();
await handler({ method: "POST", body: JSON.stringify(baseBody) }, res);
console.log("[S1] status=%d tried=%j model=%s text=%s", res._c, callLog, res._j.model, (res._j.text || "").slice(0, 20));
const s1ok = res._c === 200 && res._j.model === "qwen-max" && callLog[0] === "qwen-plus" && callLog[1] === "qwen-max";

// S2: 無料5モデル全枯渇(429) → 有料フォールバック qwen3.8-flash で成功（チャージ残高あり）
callLog = [];
global.fetch = makeFetch((m) => FREE.includes(m)
  ? { status: 429, payload: { error: { message: "free quota exhausted" } } }
  : { status: 200, payload: { choices: [{ message: { content: "OK from " + m } }] } });
res = resMock();
await handler({ method: "POST", body: JSON.stringify(baseBody) }, res);
console.log("[S2] status=%d tried=%j model=%s freeQuotaExhausted=%s text=%s", res._c, callLog, res._j.model, res._j.freeQuotaExhausted, (res._j.text || "").slice(0, 20));
const s2ok = res._c === 200 && res._j.model === "qwen3.8-flash" && !res._j.freeQuotaExhausted && callLog[5] === "qwen3.8-flash";

// S3: 認証エラー(401) → 即失敗（他モデルへ回さない）
callLog = [];
global.fetch = makeFetch(() => ({ status: 401, payload: { error: { message: "AuthFailed" } } }));
res = resMock();
await handler({ method: "POST", body: JSON.stringify(baseBody) }, res);
console.log("[S3] status=%d tried=%j (401は1回のみ)", res._c, callLog);
const s3ok = res._c === 500 && callLog.length === 1;

// S4: 全モデル(無料+有料)失敗 → 不捏造骨架に優雅に退化
callLog = [];
global.fetch = makeFetch(() => ({ status: 429, payload: { error: { message: "all exhausted" } } }));
res = resMock();
await handler({ method: "POST", body: JSON.stringify(baseBody) }, res);
console.log("[S4] status=%d tried=%j freeQuotaExhausted=%s mock=%s hasPlaceholder=%s", res._c, callLog, res._j.freeQuotaExhausted, res._j.mock, (res._j.text || "").includes("【"));
const s4ok = res._c === 200 && res._j.freeQuotaExhausted === true && res._j.mock === true && res._j.text.includes("【") && callLog.includes("qwen3.8-flash");

console.log("\nRESULT:", (s1ok && s2ok && s3ok && s4ok) ? "PASS ✅" : "FAIL ❌");
process.exit((s1ok && s2ok && s3ok && s4ok) ? 0 : 1);
