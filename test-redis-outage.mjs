// Redis 障害時の降級テスト（ローカル専用・外部依存なし）
//   Redis が落ちても 500 を返さず、匿名（Cookie 2回/日）として動き続けることを検証する。
//   さらにサーキットブレーカーが効くこと・一定時間後に自動復旧することを検証する。
// 実行: node test-redis-outage.mjs
import http from "http";

// ---------- 1. 落とせる偽 Upstash REST ----------
let mode = "ok";        // "ok" | "fail"
let requests = 0;
const store = new Map(); // key -> { v: string|string[], exp: number|null }
function live(k) {
  const e = store.get(k);
  if (!e) return null;
  if (e.exp && e.exp < Date.now()) { store.delete(k); return null; }
  return e;
}
function exec(cmd) {
  const [raw, ...args] = cmd;
  const c = String(raw).toLowerCase();
  switch (c) {
    case "set": {
      const [k, v, ...opt] = args;
      let exp = null;
      for (let i = 0; i < opt.length; i++) {
        const o = String(opt[i]).toLowerCase();
        if (o === "ex") exp = Date.now() + Number(opt[i + 1]) * 1000;
        if (o === "px") exp = Date.now() + Number(opt[i + 1]);
      }
      store.set(k, { v: String(v), exp });
      return "OK";
    }
    case "get": { const e = live(args[0]); return e ? e.v : null; }
    case "del": { let n = 0; for (const k of args) if (store.delete(k)) n++; return n; }
    case "rpush": {
      const [k, ...vals] = args;
      const e = live(k) || { v: [], exp: null };
      if (!Array.isArray(e.v)) e.v = [];
      e.v.push(...vals.map(String));
      store.set(k, e);
      return e.v.length;
    }
    case "llen": { const e = live(args[0]); return e && Array.isArray(e.v) ? e.v.length : 0; }
    case "ltrim": {
      const [k, s, t] = args;
      const e = live(k);
      if (e && Array.isArray(e.v)) {
        const n = e.v.length, a = Number(s), b = Number(t);
        e.v = e.v.slice(a < 0 ? Math.max(0, n + a) : a, (b < 0 ? n + b : b) + 1);
      }
      return "OK";
    }
    case "lrange": {
      const [k, s, t] = args;
      const e = live(k);
      if (!e || !Array.isArray(e.v)) return [];
      const n = e.v.length, a = Number(s), b = Number(t);
      return e.v.slice(a < 0 ? Math.max(0, n + a) : a, (b < 0 ? n + b : b) + 1);
    }
    case "expire": { const e = live(args[0]); if (e) e.exp = Date.now() + Number(args[1]) * 1000; return e ? 1 : 0; }
    default: return null;
  }
}
const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    requests++;
    if (mode === "fail") { // Redis 障害を模擬
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "simulated redis outage" }));
      return;
    }
    const body = JSON.parse(raw || "[]");
    const isPipe = Array.isArray(body[0]);
    const payload = isPipe
      ? body.map((c) => ({ result: exec(c) }))
      : { result: exec(body) };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(payload));
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

process.env.KV_REST_API_URL = "http://127.0.0.1:" + port;
process.env.KV_REST_API_TOKEN = "test-token";
process.env.KV_DOWN_MS = "400";        // 復旧テストを速くするため窓を短縮
process.env.RESEND_API_KEY = "test-resend-key";
process.env.OPENAI_API_KEY = "test-model-key";

const realFetch = globalThis.fetch;
globalThis.fetch = async function (url, opts) {
  const u = String(url);
  if (u.indexOf("api.resend.com") !== -1) {
    return new Response(JSON.stringify({ id: "fake" }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  if (u.indexOf("dashscope.aliyuncs.com") !== -1) {
    return new Response(JSON.stringify({
      model: "qwen-plus", choices: [{ message: { role: "assistant", content: "【スタブ生成文】" } }]
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  return realFetch(url, opts);
};

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (extra !== undefined ? "  -> " + JSON.stringify(extra) : "")); }
}
function mkRes() {
  return {
    statusCode: 0, headers: {}, body: null,
    setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; },
    status(c) { this.statusCode = c; return this; },
    json(o) { this.body = o; return this; }
  };
}
function mkReq(method, body, cookie, query) {
  const h = {};
  if (cookie) h.cookie = cookie;
  return { method, headers: h, body, query: query || {} };
}
const jst = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const BOGUS = "clk_session=" + "de".repeat(32); // ログイン中ユーザの Cookie（ただし Redis 側に存在しない）

const { default: genHandler } = await import("./api/generate.js");
const { default: authHandler } = await import("./api/auth.js");
const S = await import("./api/_lib/storage.mjs");

// ---------- [1] 障害の"最初の一撃"を実際のハンドラで受ける ----------
// （サーキットブレーカーが開く前の状態で、例外が漏れないことを確かめる）
console.log("\n[1] Redis 障害中でも /api/generate は 500 を返さない");
mode = "fail";
{
  const F = { tool: "shibou", fields: { "企業名": "テスト株式会社", "経験・キーワード": "x" } };
  const r = mkRes();
  await genHandler(mkReq("POST", F, BOGUS), r);
  ok("500 を返さない", r.statusCode !== 500, r.statusCode);
  ok("生成は成功する（200）", r.statusCode === 200, { status: r.statusCode, body: r.body });
  ok("レスポンスに課金/上限情報が入る", r.body && r.body.remaining !== undefined, r.body && r.body.remaining);
  ok("KV は「設定済み」のまま（未設定と誤判定しない）", S.kvReady() === true);
  ok("降級フラグが立つ", S.kvDegraded() === true);
}

// ---------- [2] ストレージ関数が例外を投げずに降級値で返る ----------
console.log("\n[2] ストレージ関数は例外を投げず降級値で返る");
{
  const sess = await S.resolveSession(mkReq("GET", null, BOGUS));
  ok("resolveSession → null（＝匿名扱い）", sess === null, sess);
  ok("getDailyUsage → 0", (await S.getDailyUsage("u_x", jst())) === 0);
  ok("incDailyUsage → 0（例外なし）", (await S.incDailyUsage("u_x", jst())) === 0);
  ok("saveRecord → false（例外なし）", (await S.saveRecord("u_x", { text: "t" })) === false);
  ok("listRecords → []", Array.isArray(await S.listRecords("u_x")) && (await S.listRecords("u_x")).length === 0);
  ok("findUserByEmail → null", (await S.findUserByEmail("a@b.com")) === null);
  ok("createSession → null（死んだ Cookie を配らない）", (await S.createSession("u_x")) === null);
  ok("getUserById → null", (await S.getUserById("u_x")) === null);
}

// ---------- [3] サーキットブレーカー（叩き続けない） ----------
console.log("\n[3] サーキットブレーカーが効く（無駄なリトライをしない）");
{
  const before = requests;
  for (let i = 0; i < 8; i++) {
    await S.resolveSession(mkReq("GET", null, BOGUS));
    await S.getDailyUsage("u_x", jst());
  }
  ok("障害検知後は Redis を叩かない", requests === before, { before, after: requests });
}

// ---------- [4] 登録は「行き止まりのメール」を送らない ----------
console.log("\n[4] 障害中の新規登録は 503 で止まる（コードだけ送って失敗させない）");
{
  const r = mkRes();
  await authHandler(mkReq("POST", { action: "register", email: "outage@example.com", password: "secret123" }), r);
  ok("503 を返す", r.statusCode === 503, { status: r.statusCode, body: r.body });
  ok("500 ではない", r.statusCode !== 500);
}

// ---------- [5] 自動復旧（恒久無効化しない） ----------
console.log("\n[5] Redis 復旧後は自動で戻る（恒久降級しない）");
let sessToken = null;
mode = "ok";
{
  await new Promise((r) => setTimeout(r, Number(process.env.KV_DOWN_MS) + 120));
  ok("降級フラグが下りる", S.kvDegraded() === false);
  const saved = await S.storePendingVerification("recover@example.com", "112233", "s", "h");
  ok("書き込みが再び成功する", saved === true, saved);
  const u = await S.createUserHashed("recover@example.com", "salt", "hash");
  ok("ユーザー作成が成功する", !!u, u);
  sessToken = await S.createSession(u.id);
  ok("セッション作成が再び成功する", typeof sessToken === "string" && sessToken.length > 0, sessToken);
  const sess = await S.resolveSession(mkReq("GET", null, "clk_session=" + sessToken));
  ok("セッション解決が再び成功する", !!sess && sess.userId === u.id, sess);
  const rec = await S.saveRecord(u.id, { text: "hello" });
  ok("履歴保存が再び成功する", rec === true, rec);
  const list = await S.listRecords(u.id);
  ok("履歴が実際に読める", Array.isArray(list) && list.length === 1, list);
}

// ---------- [6] 正常時の挙動（回帰確認） ----------
console.log("\n[6] 正常時は通常どおり動く");
{
  const F = { tool: "shibou", fields: { "企業名": "テスト株式会社", "経験・キーワード": "x" } };
  // 匿名は Cookie 制限なので Redis を一切使わない（＝無料枠を消費しない設計）
  const b1 = requests;
  const r1 = mkRes();
  await genHandler(mkReq("POST", F, null), r1);
  ok("匿名生成が 200", r1.statusCode === 200, { status: r1.statusCode, body: r1.body });
  ok("匿名生成は Redis にアクセスしない（設計どおり0コマンド）", requests === b1, { before: b1, after: requests });
  // ログイン中は Redis を使う
  const b2 = requests;
  const r2 = mkRes();
  await genHandler(mkReq("POST", F, "clk_session=" + sessToken), r2);
  ok("ログイン中の生成が 200", r2.statusCode === 200, { status: r2.statusCode, body: r2.body });
  ok("ログイン中の生成は Redis にアクセスする", requests > b2, { before: b2, after: requests });
  ok("ログイン中は残回数が5回ベースで返る", r2.body && r2.body.remaining === 4, r2.body && r2.body.remaining);
}

console.log("\n=== " + pass + " passed, " + fail + " failed ===");
server.close();
process.exit(fail ? 1 : 0);
