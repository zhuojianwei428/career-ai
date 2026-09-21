// Vercel Serverless Function — AI 生成エンドポイント
// 不捏造(証拠駆動)エンジン:
//   1) ユーザーが貼った JD/企業情報(URL またはテキスト)を取得・抽出
//   2) 企業固有の内容は取得・入力された事実のみから記述、不明は【】占位符
//   3) 入力不足時は骨架+占位符を返し、経歴を捏造しない
// OpenAI 互換 API を呼ぶ。環境変数 OPENAI_API_KEY が無い場合は日本語デモ(同ルール適用)。

const BASE_URL = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const MAX_TOKENS = 1600;

// ---------- 企業情報の取得（URL なら取得、テキストならそのまま） ----------
function isPrivateUrl(u) {
  try {
    const host = new URL(u).hostname;
    if (/^localhost$/i.test(host)) return true;
    if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host)) return true;
    if (/^169\.254\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
    if (host === "[::1]" || host === "::1") return true;
  } catch (e) { return true; }
  return false;
}
function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z#0-9]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}
async function research(companyInfo) {
  if (!companyInfo) return { context: null, source: null, note: null };
  const trimmed = (companyInfo || "").trim();
  if (!trimmed) return { context: null, source: null, note: null };
  const isUrl = /^https?:\/\//i.test(trimmed);
  if (!isUrl) {
    return { context: trimmed.slice(0, 4000), source: "text", note: null };
  }
  if (isPrivateUrl(trimmed)) {
    return { context: null, source: "url", note: "ローカル/非公開アドレスは取得できません" };
  }
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(function () { ctrl.abort(); }, 6000);
    const r = await fetch(trimmed, {
      signal: ctrl.signal,
      redirect: "follow",
      headers: { "User-Agent": "Mozilla/5.0 (compatible; coverletterkit-bot/1.0)" }
    });
    clearTimeout(timer);
    const ct = r.headers.get("content-type") || "";
    let raw = "";
    if (ct.includes("html")) {
      raw = stripHtml(await r.text());
    } else if (ct.includes("text")) {
      raw = (await r.text()).replace(/\s+/g, " ").trim();
    } else {
      return { context: null, source: "url", note: "対応していないコンテンツ形式です" };
    }
    const text = raw.slice(0, 4000);
    if (!text) return { context: null, source: "url", note: "本文を抽出できませんでした" };
    return { context: text, source: "url", note: null };
  } catch (e) {
    return { context: null, source: "url", note: "取得失敗: " + e.message };
  }
}

// ---------- プロンプト構築（不捏造ルール） ----------
function buildPrompt(tool, f, ctx) {
  const label = tool === "jiko-pr" ? "自己PR"
    : tool === "rirekisho" ? "履歴書"
    : tool === "shokumu" ? "職務経歴書"
    : tool === "mensetsu" ? "面接対策"
    : "志望動機";
  const system =
`あなたは日本の採用担当者を納得させる${label}のプロライターです。
【厳守ルール：経歴・実績の捏造禁止】
1. 企業固有の内容（事業内容・製品・技術スタック・具体的な課題・数値・固有名詞）は、以下の「企業情報」に記載がある場合のみ記述してください。企業情報にない事実は絶対に創作しないでください。
2. 企業情報に企業固有の記述がない場合は、その部分を【 】で括ったプレースホルダとして空缺を残してください（例：【ここに御社の事業で関心を持った具体的な取り組みを入力】）。
3. ユーザーの経験・エピソードが不足している箇所は、絶対に捏造せず【ここにあなたの経験を入力：例：…】の形で埋めてください。
4. 入力された応募種別・職種・文字数・トーンに従い、結論ファーストで具体的に作成してください。
5. 必ず「企業名」を含め、その企業にしか通用しない内容（企業研究の成果）を企業情報から抽出して盛り込んでください。`;
  const ctxBlock = ctx && ctx.context
    ? ctx.context
    : "なし";
  const user = [
    "応募種別: " + (f["応募種別"] || ""),
    "職種: " + (f["職種"] || ""),
    "企業名: " + (f["企業名"] || ""),
    "経験・キーワード: " + (f["経験・キーワード"] || ""),
    "文字数: " + (f["文字数"] || ""),
    "トーン: " + (f["トーン"] || ""),
    "企業情報（募集要項・公式サイト等から取得。ない場合は「なし」）:\n" + ctxBlock
  ].join("\n");
  return { system: system, user: user };
}

// ---------- デモ生成（不捏造ルールを模倣） ----------
function mock(tool, f, ctx) {
  const scene = f["応募種別"] || "新卒";
  const job = f["職種"] || "総務・人事";
  const company = f["企業名"] || "御社";
  const exp = (f["経験・キーワード"] || "").trim();
  const len = f["文字数"] || "400";
  const tone = f["トーン"] || "フォーマル";
  const ctxText = ctx && ctx.context ? ctx.context : "";
  const ctxSnippet = ctxText ? ctxText.slice(0, 160) : "";

  let body = "";
  const phExp = "【ここにあなたの経験を入力：例：大学のゼミで地域課題をフィールドワークし、チームで調査報告書を作成。その過程で得た工夫を活かしたい】";
  const ctxLine = ctxSnippet
    ? `（公開情報より抽出：${ctxSnippet}… — 要確認）`
    : `（企業情報が未入力のため、${company}固有の内容は【 】で空缺を残します。公式サイトURLまたは募集要項を貼ると、より具体的になります）`;

  if (tool === "rirekisho" || tool === "shokumu") {
    body =
`【学歴】
20XX年4月　○○大学 ○○学部 ○○学科 入学
20XX年3月　同 卒業見込

【職歴】
（該当があれば記入）

【志望動機】
${company}を志望する理由は、${exp ? exp + "を通じて" : ""}貴社の事業で貢献したいと考えたからです。${ctxLine}

【自己PR】
${exp ? exp + "の経験から、" : ""}【ここにあなたの強みを入力：例：目標に向けて計画を立て、最後までやり遂げる力】

（※デモ文。上の写真枠に画像を貼り、氏名・住所などを直接編集してください。企業固有の内容は「企業情報」からのみ記述します。）`;
  } else if (tool === "jiko-pr") {
    body =
`【自分の強み】
${exp ? exp + "を成功させた経験があり、" : ""}【ここにあなたの強みを入力：例：目標に向けて計画を立て、粘り強く進める力】

【エピソード】
具体的には、${exp ? exp + "の過程で" : "【ここに具体的なエピソードを入力：例：3人チームで2ヶ月で〇〇を達成】"}、成果を出しました。このプロセスで得た力を${company}でも活かせます。
${ctxLine}

（※デモ文。本番はご入力からオリジナルの自己PRを生成します。）`;
  } else if (tool === "mensetsu") {
    body =
`【よく聞かれる質問と回答の構成】

Q. なぜ${company}を志望しますか？
A. 結論ファーストで「${exp ? exp + "を活かしたい" : "【ここに動機を入力：例：貴社の〇〇事業に共感】"}」と述べ、理由を具体化。${ctxLine}

Q. あなたの強みは？
A. 【ここにあなたの強みを入力：例：限られた期間で関係者と調整し、成果を出した経験】

Q. 入社後にどんな活躍をしたいですか？
A. 【ここに入社後のビジョンを入力：例：3年以内に△△領域を任され、〇〇を達成したい】

（※デモ文。本番はあなたの経歴から本番想定の回答を生成します。）`;
  } else {
    body =
`■第1段落（結論）：なぜ${company}なのか
${company}を志望する理由は、${exp ? exp + "を通じて" : ""}【ここにあなたの動機を入力：例：貴社の〇〇事業に共感し、自分の△△経験を活かしたい】です。

■第2段落（経験と接続）：あなたの経験
${exp ? exp + "の経験から、" : ""}【ここにあなたの経験を入力：例：大学のゼミで地域課題をフィールドワークし、チームで調査報告書を作成】。

■第3段落（入社後のビジョン）
入社後は、【ここに入社後のビジョンを入力：例：3年以内に△△領域を任され、〇〇を達成したい】。
${ctxLine}

（※デモ文。実際の AI はご入力から生成します。企業固有の内容は「企業情報」からのみ記述し、空欄は【】で残します。文字数目安：${len}字／トーン：${tone}）`;
  }

  const missingExperience = !exp;
  return {
    text: `【${scene}・${job}｜${company}】\n\n` + body,
    mock: true,
    companyContextUsed: !!ctxSnippet,
    contextSource: ctx ? ctx.source : null,
    missingExperience: missingExperience,
    notice: ctx && ctx.note ? ctx.note : null
  };
}

// ---------- ハンドラ ----------
export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  let body;
  try {
    body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
  } catch (e) {
    res.status(400).json({ error: "Invalid JSON" });
    return;
  }

  // 新契約: 構造化入力 + 企業情報取得
  if (body && body.fields) {
    const f = body.fields;
    const ctx = await research(f["企業情報"]);
    const { system, user } = buildPrompt(body.tool || "shibou", f, ctx);
    const key = process.env.OPENAI_API_KEY;
    if (!key) {
      const m = mock(body.tool || "shibou", f, ctx);
      res.status(200).json(m);
      return;
    }
    try {
      const r = await fetch(BASE_URL + "/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + key
        },
        body: JSON.stringify({
          model: body.model || MODEL,
          messages: [{ role: "system", content: system }, { role: "user", content: user }],
          temperature: 0.8,
          max_tokens: MAX_TOKENS
        })
      });
      const data = await r.json();
      if (!r.ok) {
        res.status(r.status).json({ error: data.error && data.error.message ? data.error.message : "API error" });
        return;
      }
      const text = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
      res.status(200).json({
        text: text || "",
        mock: false,
        companyContextUsed: !!ctx.context,
        contextSource: ctx.source,
        missingExperience: !(f["経験・キーワード"] || "").trim(),
        notice: ctx.note
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
    return;
  }

  // 旧契約: messages のみ（他ツール互換）
  const messages = (body && body.messages) || [];
  const userText = (messages.filter((m) => m.role === "user").pop() || {}).content || "";
  const system = (messages.find((m) => m.role === "system") || {}).content || "";
  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    res.status(200).json(legacyMock(system, userText));
    return;
  }
  try {
    const r = await fetch(BASE_URL + "/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + key },
      body: JSON.stringify({ model: body.model || MODEL, messages: messages, temperature: 0.8, max_tokens: MAX_TOKENS })
    });
    const data = await r.json();
    if (!r.ok) { res.status(r.status).json({ error: data.error && data.error.message ? data.error.message : "API error" }); return; }
    const text = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    res.status(200).json({ text: text || "" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

// 旧契約用デモ（既存互換）
function legacyMock(system, userText) {
  const v = {};
  (userText || "").split(/\n+/).forEach(function (line) {
    const m = line.match(/^(.+?)[:：]\s*(.+)$/);
    if (m) v[m[1].trim()] = m[2].trim();
  });
  const kind = (system || "") + (userText || "");
  const scene = v["応募種別"] || "新卒";
  const job = v["職種"] || "総務・人事";
  const company = v["企業名"] || "御社";
  const exp = v["経験・キーワード"] || "学生時代の企画運営経験";
  let text = `【${scene}・${job}】\n\n${company}の${job}職を志望する理由は、${exp}を通じて得た視点を、貴社の事業で活かしたいと考えたからです。\n\n（※デモ文。実際の AI はご入力から生成します。）`;
  return { text: text, mock: true };
}
