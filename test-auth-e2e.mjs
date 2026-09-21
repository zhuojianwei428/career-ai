// 認証フロー E2E テスト（ローカル専用・外部依存なし）
//   1) フェイク Upstash Redis(REST) を起動し、環境変数を差し向ける
//   2) Resend への fetch を横取りして認証コードを捕捉
//   3) 登録 → 認証コード → ログイン → 履歴 → 1日5回上限 を実際のハンドラで通す
// 実行: node test-auth-e2e.mjs

import http from "http";

// ---------- 1. フェイク Upstash Redis ----------
const store = new Map(); // key -> { v: string|[..], exp: number|null }
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
    case "del": {
      let n = 0;
      for (const k of args) if (store.delete(k)) n++;
      return n;
    }
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
        const from = a < 0 ? Math.max(0, n + a) : a;
        const to = b < 0 ? n + b : b;
        e.v = e.v.slice(from, to + 1);
      }
      return "OK";
    }
    case "lrange": {
      const [k, s, t] = args;
      const e = live(k);
      if (!e || !Array.isArray(e.v)) return [];
      const n = e.v.length, a = Number(s), b = Number(t);
      const from = a < 0 ? Math.max(0, n + a) : a;
      const to = b < 0 ? n + b : b;
      return e.v.slice(from, to + 1);
    }
    case "expire": { const e = live(args[0]); if (e) e.exp = Date.now() + Number(args[1]) * 1000; return e ? 1 : 0; }
    default: throw new Error("fake-redis: unsupported command " + c);
  }
}
const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (d) => (raw += d));
  req.on("end", () => {
    try {
      const body = JSON.parse(raw || "[]");
      const isPipe = Array.isArray(body[0]);
      // パイプライン要求は [{result},{result}] をそのまま返す（Upstash REST 仕様）
      const payload = isPipe
        ? body.map((c) => ({ result: exec(c) }))
        : { result: exec(body) };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(payload));
    } catch (e) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

process.env.UPSTASH_REDIS_REST_URL = "http://127.0.0.1:" + port;
process.env.UPSTASH_REDIS_REST_TOKEN = "test-token";
process.env.RESEND_API_KEY = "test-resend-key";
process.env.OPENAI_API_KEY = "test-model-key"; // モデルもスタブ（実生成パスを通す）

// ---------- 2. 外部 API（Resend / 千問）を横取り ----------
let lastCode = null;
let lastMail = null;
let modelCalls = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = async function (url, opts) {
  const u = String(url);
  if (u.indexOf("api.resend.com") !== -1) {
    const b = JSON.parse(opts.body);
    lastMail = b;
    const m = /(\d{6})/.exec(b.text || "");
    lastCode = m ? m[1] : null;
    return new Response(JSON.stringify({ id: "fake" }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  if (u.indexOf("dashscope.aliyuncs.com") !== -1) {
    modelCalls++;
    return new Response(JSON.stringify({
      model: "qwen-plus",
      choices: [{ message: { role: "assistant", content: "【スタブ生成文】" + modelCalls } }]
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  return realFetch(url, opts);
};

// ---------- 3. テストハーネス ----------
const { default: authHandler } = await import("./api/auth.js");
const { default: genHandler } = await import("./api/generate.js");
const { default: recHandler } = await import("./api/records.js");

function mkRes() {
  return {
    statusCode: 0,
    headers: {},
    body: null,
    setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; },
    status(c) { this.statusCode = c; return this; },
    json(o) { this.body = o; return this; }
  };
}
function mkReq(method, body, cookie) {
  const h = {};
  if (cookie) h.cookie = cookie;
  return { method, headers: h, body };
}
function sessionCookie(res) {
  const sc = res.headers["set-cookie"] || "";
  const m = /clk_session=([^;]*)/.exec(sc);
  return m && m[1] ? "clk_session=" + m[1] : null;
}
let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (extra ? "  -> " + JSON.stringify(extra) : "")); }
}
const EMAIL = "tester@example.com";
const PW = "secret123";

console.log("\n[1] 認証ストア状態");
{
  const r = mkRes();
  await authHandler(mkReq("GET", null, null), r);
  ok("GET /api/auth configured=true", r.body && r.body.configured === true, r.body);
  ok("GET /api/auth emailConfigured=true", r.body && r.body.emailConfigured === true, r.body);
}

console.log("\n[2] 登録（認証コード送信）");
{
  const r = mkRes();
  await authHandler(mkReq("POST", { action: "register", email: EMAIL, password: PW }), r);
  ok("register 200 + needVerify", r.statusCode === 200 && r.body.needVerify === true, r.body);
  ok("6桁コードをメール送信", /^\d{6}$/.test(lastCode || ""), lastCode);
  ok("送信元はドメイン固定(noreply@)", lastMail.from === "noreply@coverletterkit.com", lastMail.from);
  ok("Reply-To は contact@", lastMail.reply_to === "contact@coverletterkit.com", lastMail.reply_to);
  ok("宛先は入力されたメール", lastMail.to && lastMail.to[0] === EMAIL, lastMail.to);
  ok("登録直後は未ログイン（Cookieなし）", !sessionCookie(r), r.headers["set-cookie"]);
  const r2 = mkRes();
  await authHandler(mkReq("POST", { action: "register", email: EMAIL, password: PW }), r2);
  ok("認証前の再登録はOK（コード再発行で上書き）", r2.statusCode === 200 && r2.body.needVerify === true, r2.body);
  ok("再登録でコードが更新される", /^\d{6}$/.test(lastCode || ""));
  const r3 = mkRes();
  await authHandler(mkReq("POST", { action: "login", email: EMAIL, password: PW }), r3);
  ok("未認証ログインは401+案内", r3.statusCode === 401 && /認証がまだ完了していません/.test(r3.body.error), r3.body);
}

console.log("\n[3] 認証コード検証");
{
  const good = lastCode;
  const bad = mkRes();
  await authHandler(mkReq("POST", { action: "verify", email: EMAIL, code: "000000" }), bad);
  ok("誤コードは400", bad.statusCode === 400 && bad.body.loggedIn !== true, bad.body);

  const r = mkRes();
  await authHandler(mkReq("POST", { action: "verify", email: EMAIL, code: good }), r);
  ok("正コードで登録確定+ログイン", r.statusCode === 200 && r.body.loggedIn === true, r.body);
  var cookie = sessionCookie(r);
  ok("セッションCookie取得", !!cookie);

  const rdup = mkRes();
  await authHandler(mkReq("POST", { action: "verify", email: EMAIL, code: good }), rdup);
  ok("コードは使い捨て（再利用不可）", rdup.statusCode === 400, rdup.body);
}

console.log("\n[3b] コード総当たり対策");
{
  const E2 = "brute@example.com";
  const r = mkRes();
  await authHandler(mkReq("POST", { action: "register", email: E2, password: PW }), r);
  ok("別メールの登録OK", r.statusCode === 200, r.body);
  const good2 = lastCode;
  let last = null;
  for (let i = 1; i <= 5; i++) {
    const rr = mkRes();
    await authHandler(mkReq("POST", { action: "verify", email: E2, code: "111111" }), rr);
    last = rr;
    if (i < 5) ok("誤コード" + i + "回目は400（残り回数つき）", rr.statusCode === 400 && /残り \d/.test(rr.body.error), rr.body);
  }
  ok("5回目の誤コードで429", last.statusCode === 429, last.body);
  const ra = mkRes();
  await authHandler(mkReq("POST", { action: "verify", email: E2, code: good2 }), ra);
  ok("破棄後は正しいコードでも通らない", ra.statusCode === 400, ra.body);
  const rr2 = mkRes();
  await authHandler(mkReq("POST", { action: "register", email: E2, password: PW }), rr2);
  ok("再登録でコードを受け直せる", rr2.statusCode === 200 && rr2.body.needVerify === true, rr2.body);
}

console.log("\n[4] ログイン / セッション / ログアウト");
{
  const r = mkRes();
  await authHandler(mkReq("GET", null, cookie), r);
  ok("GET /api/auth でログイン中", r.body.loggedIn === true && r.body.email === EMAIL, r.body);

  const rb = mkRes();
  await authHandler(mkReq("POST", { action: "login", email: EMAIL, password: "wrongpass" }), rb);
  ok("誤パスワードは401", rb.statusCode === 401, rb.body);

  const rg = mkRes();
  await authHandler(mkReq("POST", { action: "login", email: EMAIL, password: PW }), rg);
  ok("正パスワードでログイン", rg.statusCode === 200 && rg.body.loggedIn === true, rg.body);
  ok("ログインでCookie再発行", !!sessionCookie(rg));

  const rd = mkRes();
  await authHandler(mkReq("POST", { action: "register", email: EMAIL, password: PW }), rd);
  ok("確定済みメールの再登録は409", rd.statusCode === 409, rd.body);

  const rx = mkRes();
  await authHandler(mkReq("POST", { action: "register", email: "not-an-email", password: PW }), rx);
  ok("不正メール形式は400", rx.statusCode === 400, rx.body);

  const rp = mkRes();
  await authHandler(mkReq("POST", { action: "register", email: "short@example.com", password: "123" }), rp);
  ok("短すぎるパスワードは400", rp.statusCode === 400, rp.body);
}

console.log("\n[5] 生成上限（ログイン中 1日5回）");
{
  const F = { fields: { "企業名": "テスト株式会社", "応募種別": "新卒", "経験・キーワード": "学園祭の実行委員長" } };
  const codes = [];
  for (let i = 1; i <= 6; i++) {
    const r = mkRes();
    await genHandler(mkReq("POST", Object.assign({ tool: "shibou" }, F), cookie), r);
    codes.push(r.statusCode + "/rem" + (r.body && r.body.remaining));
    if (i <= 5) ok("生成" + i + "回目 OK (remaining=" + (5 - i) + ")", r.statusCode === 200 && r.body.remaining === 5 - i, r.body);
    else ok("6回目は429でブロック", r.statusCode === 429 && r.body.limitReached === true, r.body);
  }
  console.log("      推移: " + codes.join("  "));
}

console.log("\n[6] 生成履歴（マイページ用）");
{
  const r = mkRes();
  await recHandler(Object.assign(mkReq("GET", null, cookie), { headers: { cookie: cookie } }), r);
  const recs = (r.body && r.body.records) || [];
  ok("履歴が5件保存されている", recs.length === 5, { n: recs.length });
  ok("履歴に企業名/本文が入っている", !!(recs[0] && recs[0].company === "テスト株式会社" && recs[0].text), recs[0]);

  const r2 = mkRes();
  await recHandler(mkReq("GET", null, null), r2);
  ok("未ログインで履歴取得は401", r2.statusCode === 401, r2.body);
}

console.log("\n[7] 匿名（未ログイン）は1日2回のまま");
{
  const F = { fields: { "企業名": "テスト株式会社", "経験・キーワード": "x" } };
  let ck = null;
  const trace = [];
  for (let i = 1; i <= 3; i++) {
    const r = mkRes();
    await genHandler(mkReq("POST", Object.assign({ tool: "shibou" }, F), ck), r);
    const sc = /clk_gen=([^;]*)/.exec(r.headers["set-cookie"] || "");
    if (sc) ck = "clk_gen=" + sc[1];
    trace.push(r.statusCode + "/rem" + (r.body && r.body.remaining));
  }
  ok("匿名1・2回目はOK、3回目は429", trace[0].indexOf("200") === 0 && trace[1].indexOf("200") === 0 && trace[2].indexOf("429") === 0, trace);
  ok("匿名の初回 remaining=1", trace[0] === "200/rem1", trace[0]);
  console.log("      推移: " + trace.join("  "));

  // ログイン済み Cookie を送れば 5 回枠が使われる（匿名 Cookie は無視される）
  const r = mkRes();
  await genHandler(mkReq("POST", Object.assign({ tool: "shibou" }, F), cookie + "; clk_gen=" + jst() + ":2"), r);
  ok("ログイン中は匿名Cookieに影響されない", r.statusCode === 429, r.body && r.body.loggedIn); // 既に5回使い切り
}
function jst() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

// ---------- 4. 後片付け ----------
server.close();
globalThis.fetch = realFetch;
console.log("\n===== 結果: PASS " + pass + " / FAIL " + fail + " =====");
process.exit(fail ? 1 : 0);
