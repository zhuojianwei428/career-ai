// Vercel Serverless Function — 認証（登録/メール認証/再送/ログイン/ログアウト/状態確認）
// メール+パスワード（scrypt ハッシュ）。セッションは httpOnly Cookie(clk_session) で管理。
// 登録時はメール認証コードを送信し、コード一致後にのみアカウントを確定する（実在メール必須）。
// ストア(Redis)未設定時は 503 を返す（既存の匿名生成には影響しない）。

import {
  kvReady, getCookie, setSessionCookie, clearSessionCookie, resolveSession,
  findUserByEmail, getUserById, createUserHashed, verifyPassword, createSession, destroySession,
  hashPassword, storePendingVerification, getPendingVerification, delPendingVerification,
  incResendCount, incPendingTries
} from "./_lib/storage.mjs";
import { sendVerificationEmail, emailReady } from "./_lib/email.mjs";

function json(res, code, obj) {
  res.status(code).json(obj);
}
function isValidEmail(e) {
  return typeof e === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
}
function newCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}
const MAX_TRIES = 5;   // コード誤入力の許容回数（超過で保留データ破棄）
const MAX_SENDS = 5;   // 10分あたりの送信回数上限（連投対策）
const ANON_DAILY = 2;  // 未ログインの1日上限（generate.js の DAILY_LIMIT と合わせる）
const LOGGED_DAILY = Number(process.env.LOGGED_DAILY_LIMIT) || 5;

// 画面の文言が実装とズレないよう、上限値もクライアントへ返す
function limits() {
  return { anonDailyLimit: ANON_DAILY, loggedDailyLimit: LOGGED_DAILY, emailConfigured: emailReady() };
}

export default async function handler(req, res) {
  // GET: 状態確認
  if (req.method === "GET") {
    if (!kvReady()) return json(res, 200, Object.assign({ loggedIn: false, configured: false }, limits()));
    const token = getCookie(req, "clk_session");
    if (!token) return json(res, 200, Object.assign({ loggedIn: false, configured: true }, limits()));
    const s = await resolveSession(req);
    return json(res, 200, s
      ? Object.assign({ loggedIn: true, email: s.email }, limits())
      : Object.assign({ loggedIn: false, configured: true }, limits()));
  }

  if (req.method !== "POST") return json(res, 405, { error: "Method not allowed" });

  let body;
  try {
    body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
  } catch (e) {
    return json(res, 400, { error: "Invalid JSON" });
  }
  const action = (body && body.action) || "";

  // ---- 登録: メール認証コードを送信（まだログインしない） ----
  if (action === "register") {
    const email = (body.email || "").trim();
    const password = body.password || "";
    if (!isValidEmail(email)) return json(res, 400, { error: "メールアドレスの形式が正しくありません。" });
    if (typeof password !== "string" || password.length < 6) {
      return json(res, 400, { error: "パスワードは6文字以上で入力してください。" });
    }
    if (!kvReady()) return json(res, 503, { error: "認証ストアが未設定です（管理者へ連絡）。" });
    if (!emailReady()) return json(res, 503, { error: "メール送信が未設定です（管理者へ連絡）。" });
    if (await findUserByEmail(email)) {
      return json(res, 409, { error: "このメールアドレスは既に登録されています。ログインしてください。" });
    }
    // 短時間の連続送信防止
    if ((await incResendCount(email)) > MAX_SENDS) {
      return json(res, 429, { error: "送信回数が多すぎます。しばらく経ってから再度お試しください。" });
    }
    const { salt, hash } = hashPassword(password);
    const code = newCode();
    await storePendingVerification(email, code, salt, hash);
    const ok = await sendVerificationEmail(email, code);
    if (!ok) {
      await delPendingVerification(email);
      return json(res, 502, { error: "認証メールの送信に失敗しました。しばらく経ってから再度お試しください。" });
    }
    return json(res, 200, { ok: true, needVerify: true, email: email });
  }

  // ---- 認証: コード一致でアカウント確定 + ログイン ----
  if (action === "verify") {
    const email = (body.email || "").trim();
    const code = (body.code || "").trim();
    if (!kvReady()) return json(res, 503, { error: "認証ストアが未設定です（管理者へ連絡）。" });
    const pending = await getPendingVerification(email);
    if (!pending) {
      return json(res, 400, { error: "認証の有効期限が切れたか、登録情報が見つかりません。もう一度新規登録してください。" });
    }
    if (pending.code !== code) {
      // 総当たり対策: 誤入力を数え、5回で保留データを破棄
      const tries = await incPendingTries(email);
      if (tries >= MAX_TRIES) {
        await delPendingVerification(email);
        return json(res, 429, { error: "認証コードの入力回数が上限に達しました。もう一度「新規登録」から認証コードを受け取り直してください。" });
      }
      return json(res, 400, { error: "認証コードが一致しません。もう一度お確かめください（残り " + (MAX_TRIES - tries) + " 回）。" });
    }
    const u = await createUserHashed(email, pending.salt, pending.hash);
    await delPendingVerification(email);
    if (!u) return json(res, 500, { error: "アカウント作成に失敗しました。" });
    const token = await createSession(u.id);
    if (!token) return json(res, 500, { error: "セッション作成に失敗しました。" });
    setSessionCookie(res, token);
    return json(res, 200, { loggedIn: true, email: u.email });
  }

  // ---- コード再送信 ----
  if (action === "resend") {
    const email = (body.email || "").trim();
    if (!kvReady()) return json(res, 503, { error: "認証ストアが未設定です（管理者へ連絡）。" });
    const pending = await getPendingVerification(email);
    if (!pending) {
      return json(res, 400, { error: "認証情報が見つかりません。もう一度新規登録してください。" });
    }
    if ((await incResendCount(email)) > MAX_SENDS) {
      return json(res, 429, { error: "送信回数が多すぎます。しばらく経ってから再度お試しください。" });
    }
    const code = newCode();
    await storePendingVerification(email, code, pending.salt, pending.hash);
    const ok = await sendVerificationEmail(email, code);
    if (!ok) return json(res, 502, { error: "認証メールの再送に失敗しました。" });
    return json(res, 200, { ok: true, email: email });
  }

  if (action === "login") {
    const email = (body.email || "").trim();
    const password = body.password || "";
    if (!isValidEmail(email)) return json(res, 400, { error: "メールアドレスの形式が正しくありません。" });
    if (!kvReady()) return json(res, 503, { error: "認証ストアが未設定です（管理者へ連絡）。" });
    const id = await findUserByEmail(email);
    if (!id) {
      if (await getPendingVerification(email)) {
        return json(res, 401, { error: "このメールアドレスの認証がまだ完了していません。受信した認証コードを入力してください。" });
      }
      return json(res, 401, { error: "メールアドレスまたはパスワードが違います。" });
    }
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
