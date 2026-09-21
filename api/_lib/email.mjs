// 認証メール送信（Resend 経由、REST API なので SDK 不要）。
// 環境変数:
//   RESEND_API_KEY    — Resend の API Key（必須）
//   RESEND_FROM       — 送信元（省略時 noreply@coverletterkit.com。Resend で coverletterkit.com を認証済みであること）
//   RESEND_REPLY_TO   — 返信先（省略時 contact@coverletterkit.com。サイトのドメインメール転送先）
// 未設定 / 送信失敗時は false を返し、呼び出し側で適切に処理する。

const RESEND_URL = "https://api.resend.com/emails";

export function emailReady() {
  return !!process.env.RESEND_API_KEY;
}

export async function sendVerificationEmail(email, code) {
  const key = process.env.RESEND_API_KEY;
  if (!key) return false;
  const from = process.env.RESEND_FROM || "noreply@coverletterkit.com";
  const replyTo = process.env.RESEND_REPLY_TO || "contact@coverletterkit.com";
  const subject = "【coverletterkit】メール認証コード";
  const text =
`こんにちは。

coverletterkit.com への登録用認証コードです。

認証コード: ${code}

このコードは10分間有効です。心当たりがない場合は、このメールを破棄してください。

—
coverletterkit.com 運営`;
  const html =
`<p>こんにちは。</p>
<p>coverletterkit.com への登録用認証コードです。</p>
<p style="font-size:24px;font-weight:700;letter-spacing:3px;margin:0.6rem 0;">認証コード: ${code}</p>
<p>このコードは10分間有効です。心当たりがない場合は、このメールを破棄してください。</p>
<p style="color:#888;font-size:0.85rem;">—<br>coverletterkit.com 運営</p>`;
  try {
    const r = await fetch(RESEND_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + key },
      body: JSON.stringify({ from: from, to: [email], subject: subject, text: text, html: html, reply_to: replyTo })
    });
    if (!r.ok) {
      const t = await r.text().catch(function () { return ""; });
      console.error("[resend] send failed " + r.status + " " + t);
      return false;
    }
    return true;
  } catch (e) {
    console.error("[resend] error " + e.message);
    return false;
  }
}
