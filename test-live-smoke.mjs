// 本番（https://www.coverletterkit.com）向けのスモークテスト。
// 実メールを送らずに検証できる範囲を網羅し、「500 が出ないこと」を第一の目的にする。
//   node test-live-smoke.mjs
// ネットワーク必須（サンドボックスの HTTP プロキシを避けるため、fetch では localhost を使わない）。
const BASE = process.env.SMOKE_BASE || "https://www.coverletterkit.com";

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  ✅ " + name); }
  else { fail++; console.log("  ❌ " + name + "  → " + JSON.stringify(extra)); }
}

async function req(method, path, body, cookie) {
  const headers = { "Accept": "application/json" };
  if (body) headers["Content-Type"] = "application/json";
  if (cookie) headers["Cookie"] = cookie;
  const r = await fetch(BASE + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    redirect: "follow"
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) {}
  return { status: r.status, json, text, headers: r.headers };
}

console.log("=== スモークテスト: " + BASE + " ===\n");

// [1] 静的ページが全部 200 で、ナビにログイン導線があること
console.log("[1] ページ（ナビのログイン欄は JS 生成なので、script 参照があることまで確認）");
for (const p of ["/", "/jiko-pr.html", "/rirekisho.html", "/shokumu.html", "/mensetsu.html", "/account.html"]) {
  const r = await req("GET", p);
  ok(p + " が 200", r.status === 200, r.status);
  ok(p + " に engine.js 参照あり", r.text.indexOf("assets/js/engine.js") !== -1, null);
}

// [2] 状態確認 API
console.log("\n[2] GET /api/auth");
{
  const r = await req("GET", "/api/auth");
  ok("200", r.status === 200, r.status);
  ok("configured:true（Redis 接続済）", r.json && r.json.configured === true, r.json);
  ok("anonDailyLimit=2 / loggedDailyLimit=5",
     r.json && r.json.anonDailyLimit === 2 && r.json.loggedDailyLimit === 5, r.json);
  ok("emailConfigured:true（Resend key 投入済）", r.json && r.json.emailConfigured === true, r.json);
}

// [3] 偽セッション Cookie → 500 にならず 401/200 に落ちること（Redis 読链路の確認）
console.log("\n[3] 偽セッション Cookie（Redis 読み込みが例外を投げないこと）");
{
  const bogus = "clk_session=deadbeefdeadbeefdeadbeefdeadbeef";
  const a = await req("GET", "/api/auth", null, bogus);
  ok("GET /api/auth が 200", a.status === 200, a.status);
  ok("loggedIn:false に落ちる", a.json && a.json.loggedIn === false, a.json);
  const rec = await req("GET", "/api/records", null, bogus);
  ok("GET /api/records が 401（500 ではない）", rec.status === 401, { status: rec.status, body: rec.json });
  ok("エラー文言が日本語で返る", rec.json && /ログイン/.test(rec.json.error || ""), rec.json);
}

// [4] 認証まわりの異常系が 500 にならないこと
console.log("\n[4] /api/auth の異常系");
{
  const cases = [
    ["login: 存在しないユーザー", { action: "login", email: "nobody-smoke@example.com", password: "test1234" }, [401]],
    ["login: パスワード短すぎ", { action: "login", email: "a@b.com", password: "x" }, [400, 401]],
    ["verify: pending 無し", { action: "verify", email: "nobody-smoke@example.com", code: "000000" }, [400, 404, 410]],
    ["resend: pending 無し", { action: "resend", email: "nobody-smoke@example.com" }, [400, 404, 410]],
    ["未知の action", { action: "no-such-action" }, [400, 404]],
    ["register: パスワード5文字", { action: "register", email: "smoke@example.com", password: "12345" }, [400]]
  ];
  for (const [name, body, allowed] of cases) {
    const r = await req("POST", "/api/auth", body);
    ok(name + " → " + allowed.join("/") + "（実際 " + r.status + "）",
       allowed.indexOf(r.status) !== -1, { status: r.status, body: r.json });
    ok(name + ": 500 ではない", r.status < 500, r.status);
  }
}

// [5] 登録（実在メール必須）— 送信可否に応じて 503 か 200 のどちらかであること
console.log("\n[5] register（Resend のドメイン検証が未完了なら 503、完了なら 200）");
{
  const r = await req("POST", "/api/auth", { action: "register", email: "smoke-" + Date.now() + "@example.com", password: "test1234" });
  ok("503 か 200 のいずれか（500 は不可）", r.status === 503 || r.status === 200, { status: r.status, body: r.json });
  if (r.status === 503) {
    const msg = (r.json && r.json.error) || "";
    ok("Redis 書き込みは成功している（＝「認証ストア」ではなく「メール送信」で落ちている）",
       /認証メールの送信/.test(msg), msg);
    ok("「認証ストア」エラーではない（storePendingVerification は成功した証拠）",
       !/認証ストア/.test(msg), msg);
  }
}

// [6] 生成 API（匿名）— 429 でも 200 でもよいが 500 は不可
console.log("\n[6] POST /api/generate（匿名）");
{
  const r = await req("POST", "/api/generate", { tool: "shibou", fields: { "企業名": "スモーク", "経験・キーワード": "x" } });
  ok("200 か 429（500 は不可）", r.status === 200 || r.status === 429, { status: r.status, body: r.json });
  ok("remaining が返る", r.json && (typeof r.json.remaining === "number" || /リセット/.test(r.json.error || "")), r.json);
}

console.log("\n===== 結果: PASS " + pass + " / FAIL " + fail + " =====");
process.exit(fail ? 1 : 0);
