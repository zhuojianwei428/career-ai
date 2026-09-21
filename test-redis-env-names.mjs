// Redis 環境変数名の互換テスト（ネットワーク不要・自前の偽 Upstash REST を使用）
// Vercel Marketplace の Upstash 連携は Custom Prefix の指定で変数名が変わる:
//   接頭辞なし → KV_REST_API_URL / KV_REST_API_TOKEN（既定）
//   UPSTASH   → UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN
// どちらの名前でも kvReady() が true になり、実際に読み書きできることを確認する。
import http from "http";

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (extra ? "  -> " + extra : "")); }
}

// ---------- 偽 Upstash REST（GET / SET のみ・パイプライン対応） ----------
const store = new Map();
function exec(cmd) {
  const op = String(cmd[0] || "").toLowerCase();
  if (op === "set") { store.set(cmd[1], cmd[2]); return "OK"; }
  if (op === "get") { return store.has(cmd[1]) ? store.get(cmd[1]) : null; }
  if (op === "del") { const had = store.delete(cmd[1]); return had ? 1 : 0; }
  return null;
}
const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const body = JSON.parse(raw || "[]");
    // クライアントは複数コマンドを 1 リクエストにまとめる（auto-pipelining）ことがある。
    // パイプライン時のレスポンスは「裸の配列」で返す必要がある（{result:[..]} で包むと壊れる）
    const isPipe = Array.isArray(body[0]);
    const payload = isPipe
      ? body.map((c) => ({ result: exec(c) }))
      : { result: exec(body) };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(payload));
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = "http://127.0.0.1:" + server.address().port;

// ---------- 全パターンを消してから検証 ----------
const ALL = [
  "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN",
  "KV_REST_API_URL", "KV_REST_API_TOKEN"
];
function clearAll() { for (const k of ALL) delete process.env[k]; }

clearAll();
const S = await import("./api/_lib/storage.mjs");

console.log("[1] 変数名の判定");
clearAll();
ok("両方なし → kvReady() = false", S.kvReady() === false);
clearAll();
process.env.UPSTASH_REDIS_REST_URL = base;
process.env.UPSTASH_REDIS_REST_TOKEN = "t";
ok("UPSTASH_* のみ → true", S.kvReady() === true);
clearAll();
process.env.KV_REST_API_URL = base;
process.env.KV_REST_API_TOKEN = "t";
ok("KV_REST_API_* のみ → true（今回の Vercel 連携の実名）", S.kvReady() === true);
clearAll();
process.env.KV_REST_API_URL = base;
ok("URL だけ（TOKEN なし）→ false", S.kvReady() === false);

console.log("\n[2] KV_REST_API_* 経由で実際に読み書きできる");
clearAll();
process.env.KV_REST_API_URL = base;
process.env.KV_REST_API_TOKEN = "t";
{
  // 検証用: 保留データを保存 → 取得（内部で SET 1回・GET 1回）
  const saved = await S.storePendingVerification("a@example.com", "123456", "salt", "hash");
  ok("storePendingVerification が成功", saved === true, String(saved));
  ok("偽 Redis にキーが入った", store.has("verify:a@example.com"));
  const got = await S.getPendingVerification("a@example.com");
  ok("getPendingVerification で読み戻せる", !!got, JSON.stringify(got));
  ok("保存したコードが一致", got && got.code === "123456", got && got.code);
  await S.delPendingVerification("a@example.com");
  ok("delPendingVerification で削除できる", !store.has("verify:a@example.com"));
}

console.log("\n[3] UPSTASH_* 経由でも同じく動く");
clearAll();
process.env.UPSTASH_REDIS_REST_URL = base;
process.env.UPSTASH_REDIS_REST_TOKEN = "t";
{
  store.clear();
  const saved = await S.storePendingVerification("b@example.com", "654321", "s", "h");
  ok("UPSTASH_* でも書き込み成功", saved === true);
  const got = await S.getPendingVerification("b@example.com");
  ok("UPSTASH_* でも読み戻せる", got && got.code === "654321", got && got.code);
}

console.log("\n=== " + pass + " passed, " + fail + " failed ===");
server.close();
process.exit(fail ? 1 : 0);
