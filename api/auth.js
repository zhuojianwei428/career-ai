// Vercel Serverless Function — 認証（登録/ログイン/ログアウト/状態確認）
// メール+パスワード（scrypt ハッシュ）。セッションは httpOnly Cookie(clk_session) で管理。
// ストア(Redis)未設定時は 503 を返す（既存の匿名生成には影響しない）。

import {
  kvReady, getCookie, setSessionCookie, clearSessionCookie, resolveSession,
  findUserByEmail, getUserById, createUser, verifyPassword, createSession, destroySession
} from "./_lib/storage.mjs";

function json(res, code, obj) {
  res.status(code).json(obj);
}

function isValidEmail(e) {
  return typeof e === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
}

export default async function handler(req, res) {
  // GET: 状態確認
  if (req.method === "GET") {
    if (!kvReady()) return json(res, 200, { loggedIn: false, configured: false });
    const token = getCookie(req, "clk_session");
    if (!token) return json(res, 200, { loggedIn: false, configured: true });
    const s = await resolveSession(req);
    return json(res, 200, s ? { loggedIn: true, email: s.email } : { loggedIn: false, configured: true });
  }

  if (req.method !== "POST") return json(res, 405, { error: "Method not allowed" });

  let body;
  try {
    body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
  } catch (e) {
    return json(res, 400, { error: "Invalid JSON" });
  }
  const action = (body && body.action) || "";

  if (action === "register") {
    const email = (body.email || "").trim();
    const password = body.password || "";
    if (!isValidEmail(email)) return json(res, 400, { error: "メールアドレスの形式が正しくありません。" });
    if (typeof password !== "string" || password.length < 6) {
      return json(res, 400, { error: "パスワードは6文字以上で入力してください。" });
    }
    if (!kvReady()) return json(res, 503, { error: "認証ストアが未設定です（管理者へ連絡）。" });
    if (await findUserByEmail(email)) {
      return json(res, 409, { error: "このメールアドレスは既に登録されています。ログインしてください。" });
    }
    const u = await createUser(email, password);
    const token = await createSession(u.id);
    if (!token) return json(res, 500, { error: "セッション作成に失敗しました。" });
    setSessionCookie(res, token);
    return json(res, 200, { loggedIn: true, email: u.email });
  }

  if (action === "login") {
    const email = (body.email || "").trim();
    const password = body.password || "";
    if (!isValidEmail(email)) return json(res, 400, { error: "メールアドレスの形式が正しくありません。" });
    if (!kvReady()) return json(res, 503, { error: "認証ストアが未設定です（管理者へ連絡）。" });
    const id = await findUserByEmail(email);
    if (!id) return json(res, 401, { error: "メールアドレスまたはパスワードが違います。" });
    const u = await getUserById(id);
    if (!u || !verifyPassword(password, u.salt, u.hash)) {
      return json(res, 401, { error: "メールアドレスまたはパスワードが違います。" });
    }
    const token = await createSession(u.id);
    if (!token) return json(res, 500, { error: "セッション作成に失敗しました。" });
    setSessionCookie(res, token);
    return json(res, 200, { loggedIn: true, email: u.email });
  }

  if (action === "logout") {
    const token = getCookie(req, "clk_session");
    if (token) await destroySession(token);
    clearSessionCookie(res);
    return json(res, 200, { loggedIn: false });
  }

  return json(res, 400, { error: "不明なアクションです。" });
}
