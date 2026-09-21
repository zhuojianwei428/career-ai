// 共有ストレージ/認証ヘルパ（Upstash Redis / Vercel Marketplace の Redis 統合）
// 注意: /api 配下の _lib は Vercel により Serverless Function としてデプロイされない（_ プレフィックス）。
// Redis が未設定（ローカル/未プロビジョニング）の場合は全関数が null/false を返し、既存ロジックに影響しない。
// ※ Vercel KV は Upstash Redis に統合されたため、本番ストアは Vercel Marketplace の Redis 連携で作成する。

import { randomBytes, scryptSync, timingSafeEqual } from "crypto";

// ---- Redis ラップ（遅延生成: 未設定時も障害時もクラッシュしない） ----
// 障害時の降級方針:
//   Redis が落ちても 500 を返さない。全メソッドが null を返すので、呼び出し側は
//   「未設定のとき」と同じ経路に自然に落ちる（＝セッション解決できず匿名扱い＝Cookie の2回/日）。
//   一定時間は呼び出しを止めるサーキットブレーカー付き（復旧は自動。恒久無効化はしない）。
const DOWN_MS = Number(process.env.KV_DOWN_MS) || 30000; // 障害検知後、この時間だけ Redis を叩かない（テストで短縮可）
let _downUntil = 0;
let _downLogged = false;
function redisDown() { return Date.now() < _downUntil; }
function markDown(e) {
  _downUntil = Date.now() + DOWN_MS;
  if (!_downLogged) {
    _downLogged = true;
    console.warn("[storage] Redis 障害を検知 → " + (DOWN_MS / 1000) + "秒間は降級動作（匿名扱い）。原因: " + ((e && e.message) || e));
  }
}
// 例外を投げずに null を返すプロキシ。既存の呼び出し側はすべて null を許容している
// （未設定時に `if (!kv) return null/false/0` で戻る設計のため）。
function safeRedis(instance) {
  return new Proxy(instance, {
    get(target, prop) {
      const v = Reflect.get(target, prop, target);
      if (typeof v !== "function") return v;
      return async function (...args) {
        if (redisDown()) return null;
        try {
          const r = await v.apply(target, args);
          _downLogged = false; // 成功したらログ抑止を解除
          return r;
        } catch (e) {
          markDown(e);
          return null;
        }
      };
    }
  });
}
// Vercel Marketplace の Upstash 連携は、Custom Prefix の指定によって変数名が変わる。
//   接頭辞なし → KV_REST_API_URL / KV_REST_API_TOKEN（旧 Vercel KV 名。既定はこちら）
//   接頭辞 UPSTASH → UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN
// どちらでも動くよう両方を見る。READ_ONLY トークンは書き込み不可なので使わない。
let _redis = null;
let _redisErr = false;
function redisUrl() {
  return process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || "";
}
function redisToken() {
  return process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || "";
}
export function kvReady() {
  return !!(redisUrl() && redisToken());
}
// サーキットブレーカーが開いているか（ログ用・テスト用）
export function kvDegraded() { return redisDown(); }
async function getKV() {
  if (!kvReady()) return null;
  if (_redisErr) return null;
  if (!_redis) {
    try {
      const { Redis } = await import("@upstash/redis");
      _redis = safeRedis(new Redis({ url: redisUrl(), token: redisToken() }));
    } catch (e) {
      _redisErr = true;
      return null;
    }
  }
  return _redis;
}

// ---- Cookie ユーティリティ ----
export function getCookie(req, name) {
  const c = req && req.headers && req.headers.cookie;
  if (!c) return null;
  const m = c.split(";").map((s) => s.trim()).find((s) => s.indexOf(name + "=") === 0);
  return m ? decodeURIComponent(m.slice(name.length + 1)) : null;
}
export function setSessionCookie(res, token) {
  const max = 60 * 60 * 24 * 30; // 30日
  res.setHeader("Set-Cookie",
    "clk_session=" + token + "; Path=/; HttpOnly; SameSite=Lax; Max-Age=" + max);
}
export function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", "clk_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0");
}

// ---- パスワード（scrypt, ソルト付き） ----
export function hashPassword(pw) {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(pw, salt, 64).toString("hex");
  return { salt, hash };
}
export function verifyPassword(pw, salt, hash) {
  try {
    const h = scryptSync(pw, salt, 64).toString("hex");
    return timingSafeEqual(Buffer.from(h, "hex"), Buffer.from(hash, "hex"));
  } catch (e) {
    return false;
  }
}

// ---- セッション ----
export function newToken() {
  return randomBytes(32).toString("hex");
}
export async function createSession(userId) {
  const kv = await getKV();
  if (!kv) return null;
  const token = newToken();
  // 降級時は set が null を返す。使えないセッション Cookie を配らないよう失敗として扱う。
  const r = await kv.set("session:" + token, userId, { ex: 60 * 60 * 24 * 30 });
  if (r === null || r === undefined) return null;
  return token;
}
export async function destroySession(token) {
  const kv = await getKV();
  if (!kv || !token) return;
  await kv.del("session:" + token);
}
// リクエストからセッション解決: { userId, email } または null
export async function resolveSession(req) {
  const kv = await getKV();
  if (!kv) return null;
  const token = getCookie(req, "clk_session");
  if (!token) return null;
  const userId = await kv.get("session:" + token);
  if (!userId) return null;
  const u = await kv.get("user:" + userId);
  return u ? { userId: userId, email: u.email } : null;
}

// ---- ユーザー ----
export async function findUserByEmail(email) {
  const kv = await getKV();
  if (!kv) return null;
  return (await kv.get("user:email:" + email.toLowerCase().trim())) || null;
}
export async function getUserById(id) {
  const kv = await getKV();
  if (!kv || !id) return null;
  return (await kv.get("user:" + id)) || null;
}
export async function createUser(email, pw) {
  const kv = await getKV();
  if (!kv) return null;
  const { salt, hash } = hashPassword(pw);
  return createUserHashed(email, salt, hash);
}
// メール認証後に、保留しておいたハッシュでユーザーを確定作成する
export async function createUserHashed(email, salt, hash) {
  const kv = await getKV();
  if (!kv) return null;
  const id = "u_" + randomBytes(8).toString("hex");
  const u = { id, email: email.toLowerCase().trim(), salt, hash, createdAt: Date.now(), verified: true };
  await kv.set("user:" + id, u);
  await kv.set("user:email:" + u.email, id); // メール→ID 索引
  return u;
}

// ---- メール認証（登録時の確認コード） ----
// 保留データ: verify:<email> = { code, salt, hash, exp }（10分）
export async function storePendingVerification(email, code, salt, hash) {
  const kv = await getKV();
  if (!kv) return false;
  const key = "verify:" + email.toLowerCase().trim();
  // 降級時（Redis 障害）は set が null を返す。ここで false を返さないと
  // 「保存できていないコード」をメールで送ってしまい、ユーザーが入力しても必ず失敗する。
  const r = await kv.set(key, JSON.stringify({ code: String(code), salt, hash, exp: Date.now() + 600000 }), { ex: 600 });
  return r !== null && r !== undefined;
}
export async function getPendingVerification(email) {
  const kv = await getKV();
  if (!kv) return null;
  const raw = await kv.get("verify:" + email.toLowerCase().trim());
  if (!raw) return null;
  let o; try { o = typeof raw === "string" ? JSON.parse(raw) : raw; } catch (e) { return null; }
  if (!o || o.exp < Date.now()) { await delPendingVerification(email); return null; }
  return o;
}
export async function delPendingVerification(email) {
  const kv = await getKV();
  if (!kv) return;
  await kv.del("verify:" + email.toLowerCase().trim());
}
// コード誤入力の試行回数を加算（総当たり対策。残り TTL は維持）
export async function incPendingTries(email) {
  const kv = await getKV();
  if (!kv) return 0;
  const key = "verify:" + email.toLowerCase().trim();
  const raw = await kv.get(key);
  if (!raw) return 0;
  let o; try { o = typeof raw === "string" ? JSON.parse(raw) : raw; } catch (e) { return 0; }
  o.tries = (o.tries || 0) + 1;
  const left = Math.max(1, Math.ceil(((o.exp || 0) - Date.now()) / 1000));
  await kv.set(key, JSON.stringify(o), { ex: left });
  return o.tries;
}
// 同一メールの短時間連続送信を防ぐ（10分窓で最大5回）
export async function incResendCount(email) {
  const kv = await getKV();
  if (!kv) return 0;
  const key = "verify:resend:" + email.toLowerCase().trim();
  const n = (Number(await kv.get(key)) || 0) + 1;
  await kv.set(key, n, { ex: 600 });
  return n;
}

// ---- 生成記録 ----
export async function saveRecord(userId, rec) {
  const kv = await getKV();
  if (!kv) return false;
  const key = "records:" + userId;
  const r = await kv.rpush(key, JSON.stringify(Object.assign({ ts: Date.now() }, rec)));
  if (r === null || r === undefined) return false; // 降級時は「保存できていない」
  await kv.expire(key, 60 * 60 * 24 * 365);
  const len = await kv.llen(key); // 最新 200 件に抑える
  if (len > 200) await kv.ltrim(key, len - 200, -1);
  return true;
}
export async function listRecords(userId) {
  const kv = await getKV();
  if (!kv) return [];
  const arr = await kv.lrange("records:" + userId, 0, -1);
  return (arr || [])
    .map((s) => { try { return typeof s === "string" ? JSON.parse(s) : s; } catch (e) { return null; } })
    .filter(Boolean)
    .sort((a, b) => (b.ts || 0) - (a.ts || 0));
}

// ---- ログインユーザの日別生成回数 ----
export async function getDailyUsage(userId, dateKey) {
  const kv = await getKV();
  if (!kv) return 0;
  return Number(await kv.get("usage:" + userId + ":" + dateKey)) || 0;
}
export async function incDailyUsage(userId, dateKey) {
  const kv = await getKV();
  if (!kv) return 0;
  const key = "usage:" + userId + ":" + dateKey;
  const n = (Number(await kv.get(key)) || 0) + 1;
  const r = await kv.set(key, n, { ex: 60 * 60 * 48 });
  return (r === null || r === undefined) ? 0 : n; // 降級時は 0（記録できていない）
}
