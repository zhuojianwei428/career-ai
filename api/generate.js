// Vercel Serverless Function — AI 生成エンドポイント
// 不捏造(証拠駆動)エンジン:
//   1) ユーザーが貼った JD/企業情報(URL またはテキスト)を取得・抽出（ルートA）
//   2) 企業名は api/company.js で候補を出し、利用者が「確認して選んだ」法人番号のみを使う（ルートB）
//      ※ 法人名で自動的に1社へ決め打ちしない。同名の別法人が実在するため（P0-0）。
//   3) 企業固有の内容は取得・入力された事実のみから記述、不明は【】の短いラベルで残す
//   4) 入力不足時は骨架+占位符を返し、経歴を捏造しない
// OpenAI 互換 API を呼ぶ。環境変数 OPENAI_API_KEY が無い場合は日本語デモ(同ルール適用)。
// 無料モデルを順に試し、無料枠枯渇時は自動で次のモデルへ。末尾の qwen3.8-flash は「有料フォールバック」：
// アカウントにチャージ残高があれば、無料枠枯渇後も自動で継続生成（サイトは止まらない）。

const BASE_URL = process.env.OPENAI_BASE_URL || "https://dashscope.aliyuncs.com/compatible-mode/v1";
// 日本語 500〜800 字は本文だけで概ね 1600 トークン超、かつ qwen3.8-flash は reasoning モデルで
// 思考分も同じ枠を食う。1600 だと「長め」選択時に文が途中で切れる（＝字数表示と矛盾する）。
// max_tokens は上限であって課金量ではないので、余裕を持たせる。
const MAX_TOKENS = 3000;
// 無料モデル順次フォールバック（百炼の各モデルは独立して100万トークンの無料枠あり）。
// 末尾の qwen3.8-flash は「有料フォールバック」＝チャージ残高があれば無料枠枯渇後も継続生成。
// qwen3.8-flash は reasoning（思考）モデル。更快/更省にしたい場合は callModel の body に enable_thinking:false を追加。
const FALLBACK_MODELS = (process.env.MODEL_FALLBACK && process.env.MODEL_FALLBACK.trim())
  ? process.env.MODEL_FALLBACK.split(",").map((s) => s.trim()).filter(Boolean)
  : (process.env.OPENAI_MODEL && process.env.OPENAI_MODEL.trim() && process.env.OPENAI_MODEL !== "gpt-4o-mini")
    ? [process.env.OPENAI_MODEL.trim()]
    : ["qwen-plus", "qwen-max", "qwen-turbo", "qwen-long", "qwen-flash", "qwen3.8-flash"];

// ログイン中ユーザの1日上限（匿名は下の DAILY_LIMIT=2）。Redis 未設定時は匿名扱い。
const LOGGED_DAILY = Number(process.env.LOGGED_DAILY_LIMIT) || 5;
import { kvReady, resolveSession, getDailyUsage, incDailyUsage, saveRecord } from "./_lib/storage.mjs";
// gBizINFO は共有ライブラリに一本化（api/company.js と同じ実装を使う）。
// URL 結合を2箇所に書くと、片方だけ直して片方が壊れる（末尾スラッシュ事故の再来）を防ぐ。
import { gbizConfigured, gbizDetail, isCorporateNumber } from "./_lib/gbiz.mjs";

// ログイン中のみ、真实生成の記録を保存（失敗しても生成結果には影響させない）
async function persistRecord(session, tool, f, text) {
  if (!session || !text) return;
  try {
    await saveRecord(session.userId, {
      tool: tool || "shibou",
      scene: (f && f["応募種別"]) || "",
      company: (f && f["企業名"]) || "",
      len: (f && f["文字数"]) || "",
      tone: (f && f["トーン"]) || "",
      text: text
    });
  } catch (e) { /* ignore */ }
}

// ---------- 生成回数制限（ログイン不要・1日2回/人） ----------
// ブラウザ Cookie(clk_gen = "YYYY-MM-DD:N") で同日カウント。サーバ側で強制するため、全ツールページをまたいでも共有。
// ※ Cookie 消去で回避可能（ログイン不要・無料という要件とのトレードオフ）。本格運用は IP 制限 / KV ストアが必要。
const DAILY_LIMIT = 2;
const GEN_COOKIE = "clk_gen";
function jstDate() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}
function getCookie(req, name) {
  const c = req.headers && req.headers.cookie;
  if (!c) return null;
  const m = c.split(";").map(function (s) { return s.trim(); }).find(function (s) { return s.indexOf(name + "=") === 0; });
  return m ? decodeURIComponent(m.slice(name.length + 1)) : null;
}
function setGenCookie(res, value) {
  res.setHeader("Set-Cookie", GEN_COOKIE + "=" + encodeURIComponent(value) + "; Path=/; Max-Age=86400; SameSite=Lax");
}

// ---------- ルートA: ユーザーが貼った URL/テキスト ----------
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

// ルートA（貼り付け/URL）と ルートB（確認済み gBizINFO）を統合
function mergeContext(ctx, gbiz) {
  if (ctx && ctx.context) {
    let text = ctx.context;
    if (gbiz && gbiz.facts.length) {
      text += "\n\n【gBizINFO 登録情報（確認のうえ選択）】\n" + gbiz.facts.join("\n");
    }
    return { text: text, source: ctx.source || "gbiz", note: ctx.note || (gbiz ? gbiz.note : null) };
  }
  if (gbiz) {
    return { text: gbiz.facts.join("\n"), source: "gbiz", note: gbiz.note };
  }
  return { text: null, source: null, note: null };
}

// ---------- 出力の後始末 ----------
// モデルは指示しても文末に「（文字数：698字）」を混ぜる（自己申告の数字も実際と食い違う）。
// 本文に残ると (a) 字数カウンタと矛盾して壊れて見える (b) 全文コピー/PDF でそのまま相手に渡る。
// 文末に現れた自己申告だけを落とす（本文中の数値や「698字」という語自体は消さない）。
const SELF_REPORT_PATTERNS = [
  /[（(]\s*(?:文字数|字数)\s*[：:]?\s*(?:約)?\s*[\d,，]+\s*字(?:\s*程度)?\s*[）)]\s*$/,
  /[（(]\s*(?:約)?\s*[\d,，]+\s*字(?:\s*程度)?\s*[）)]\s*$/,
  /[（(]\s*(?:約)?\s*[\d,，]+\s*(?:文字|chars?)\s*[）)]\s*$/,
  /[※*＊]?\s*(?:文字数|字数)\s*[：:]\s*(?:約)?\s*[\d,，]+\s*字(?:\s*程度)?\s*$/,
  /[。．.]?\s*[（(]\s*[^）)]{0,16}(?:文字数|字数)[^）)]{0,16}[）)]\s*$/
];
function stripSelfReport(text) {
  let t = String(text || "").trim();
  let stripped = false;
  for (let i = 0; i < 4; i++) {
    let hit = false;
    for (const re of SELF_REPORT_PATTERNS) {
      const next = t.replace(re, "").trim();
      if (next !== t) { t = next; hit = true; stripped = true; break; }
    }
    if (!hit) break;
  }
  return { text: t, stripped: stripped };
}

// ---------- プロンプト構築（不捏造ルール） ----------
// 捏造禁止ルールは全ツール共通の定数にし、構造化契約(buildPrompt)と旧契約(messages)の
// 両方に必ず前置する。片方にしか置かないと「ツールによって捏造の有無が変わる」状態になる
// （実際、index.html 以外の4ツールは旧契約を通っており、この規則が一切効いていなかった）。
//
// ⚠️ 実測で分かったこと（2026-09-21）: 抽象的に「捏造するな」と書いても守られない。
//   実効的なレバーは「鉤括弧「」『』を一切出すな」だった。偽の理念・スローガンは
//   引用符で括ることで初めて「会社がそう言っている」体裁になるため、引用符を禁じると成立しない。
// さらに 2026-09-21 追記: 【 】の中に長い指示文（60字超の「例：…」）を書かせると
//   穴埋めUIが成立しない。ラベルは短く、10〜14文字までに制限する。
const NO_FABRICATION_RULES =
`【厳守ルール：経歴・実績・企業情報の捏造禁止】
0. 与えられた事実だけを書く。書かれていない事実の補完・推測・連想は一切しない。
1. 企業固有の内容（事業内容・製品・サービス名・技術スタック・具体的な施策・課題・数値・固有名詞）は、「企業情報」に明記されている場合のみ記述する。記載が無いものは絶対に書かない。
2. 特に禁止：企業のミッション・経営理念・スローガン・キャッチコピー・社風・社訓・開発哲学・価値観を推測して書くこと。企業情報に書かれていない「その企業らしさ」の要約（◯◯を起点とした開発哲学／◯◯を大切にする社風／◯◯を体現する、など）は書かない。著名企業ほど一般的なイメージ（例：「人のための技術」「遊び」）を書きたくなるが、企業情報にその語が無ければ書いてはならない。
3. 出力で鉤括弧「」『』を一切使わない。企業のキーワード・理念・製品名であっても、自分の強みや特質であっても、引用符で括ってはならない。引用した体裁そのものが「出典がある」という誤解を生むため、強調目的の引用符は全面的に禁止する。強調したい場合は括弧を使わず、地の文で書く。
4. 業績・売上・シェア・従業員数・導入技術などの数値も、企業情報に無い限り書かない。
5. 企業固有の記述が無い部分は、【 】で括った穴埋めを残す。中身は短いラベルだけ（10〜14文字以内）にし、「例：」「：」や説明文・指示文を入れない。1つの【 】に複数の指示を詰め込まない。良い例：【事業内容への共感】【入社後に携わりたい業務】【志望の理由】。悪い例：【ここにあなたの経験を入力：例：大学のゼミで地域課題をフィールドワークし、チームで調査報告書を作成】。
6. ユーザーの経験・エピソードが不足している箇所も絶対に捏造せず、同じく短いラベルの【 】で残す（例：【経験の場面】【成果の数字】【学び】）。長い指示文や穴埋めの説明文を本文に差し込まない。
7. 穴は1つの文に1つまで（例外なし）。複数の穴を連結して1文に詰め込まない。穴は文の主語・目的語として置き、残りの穴は必ず別の文に分ける。
   実際に観測された悪い例（そのまま再現しないこと）：
     ・「【事業内容への共感】【入社後に携わりたい業務】【志望の理由】を基に、成長していきたいです」
     ・「【事業内容への共感】から、【入社後に携わりたい業務】に取り組み、社会に貢献したいです」
     ・「その結果、【成果の数字】を達成し、【学び】として、信頼構築が鍵だと実感しました」
   とくに**最後の一文（締め）に企業固有の穴をまとめて入れない**。締めの文は穴を置かないか、置くなら1つだけにする。
   企業情報が乏しく「なぜこの会社か」を語れない場合も、1文に複数の穴を置いて済ませてはならない。その場合は文を増やして穴を1つずつ置く（良い例：「【事業内容への共感】から、応募を決めました。」「入社後は【入社後に携わりたい業務】に取り組みたいです。」）。穴の総数は3つ程度までを目安にし、それ以上必要なら一般的な意欲・経験の記述に置き換える。
8. 企業名は必ず含める。ただし企業名以外の企業固有情報は「企業情報」由来のものだけにする。
9. 企業情報は、利用者が候補から選び法人番号まで確認した1社の登録情報である。同名他社の情報が混ざっている心配はない。ただし登録情報は取得時点のスナップショットなので、数値や状況を過度に断定せず、推測で補完しない（補完は禁止のまま）。
10. 本文だけを出力する。前置き・後書き・文字数の自己申告（例：文字数698字）を書かない。`;

function buildPrompt(tool, f, merged) {
  const label = (tool === "jiko-pr" || tool === "jiko") ? "自己PR"
    : tool === "rirekisho" ? "履歴書"
    : tool === "shokumu" ? "職務経歴書"
    : tool === "mensetsu" ? "面接対策"
    : "志望動機";
  const system =
`あなたは日本の採用担当者を納得させる${label}のプロライターです。

${NO_FABRICATION_RULES}

【出力ルール】
- 入力された応募種別・職種・文字数・トーンに従い、結論ファーストで具体的に作成する。
- 指定の文字数目安に収める。
- 本文のみを出力する。`;
  const ctxBlock = merged && merged.text ? merged.text : "なし";
  const user = [
    "応募種別: " + (f["応募種別"] || ""),
    "職種: " + (f["職種"] || ""),
    "企業名: " + (f["企業名"] || ""),
    "経験・キーワード: " + (f["経験・キーワード"] || ""),
    "文字数: " + (f["文字数"] || ""),
    "トーン: " + (f["トーン"] || ""),
    "企業情報（募集要項・公式サイト・gBizINFO 等から取得。ない場合は「なし」）:\n" + ctxBlock
  ].join("\n");
  return { system: system, user: user };
}

// ---------- デモ生成（不捏造ルールを模倣 / gBizINFO も反映） ----------
function mock(tool, f, merged) {
  const scene = f["応募種別"] || "新卒";
  const job = f["職種"] || "総務・人事";
  const company = f["企業名"] || "御社";
  const exp = (f["経験・キーワード"] || "").trim();
  const len = f["文字数"] || "400";
  const tone = f["トーン"] || "フォーマル";
  const ctxText = merged && merged.text ? merged.text : "";
  const isGbiz = merged && merged.source === "gbiz";
  const ctxSnippet = ctxText ? ctxText.slice(0, 160) : "";
  const ctxLine = ctxSnippet
    ? `（${isGbiz ? "経済産業省 gBizINFO の登録情報（利用者が候補から選択し確認済み）" : "参考情報"}：${ctxSnippet}…）`
    : `（企業情報が未確認・未入力のため、${company}固有の内容は【 】のまま残します。公式サイトの採用ページや募集要項を貼ると、より具体的になります）`;

  let body = "";

  if (tool === "rirekisho" || tool === "shokumu") {
    body =
`【学歴】
20XX年4月　○○大学 ○○学部 ○○学科 入学
20XX年3月　同 卒業見込

【職歴】
（該当があれば記入）

【志望動機】
${company}を志望する理由は、${exp ? exp + "を通じて" : ""}【志望の理由】です。${ctxLine}

【自己PR】
${exp ? exp + "の経験から、" : ""}【強み】

（※デモ文。上の写真枠に画像を貼り、氏名・住所などを直接編集してください。企業固有の内容は「企業情報」からのみ記述します。）`;
  } else if (tool === "jiko-pr") {
    body =
`【自分の強み】
${exp ? exp + "を成功させた経験があり、" : ""}【強み】

【エピソード】
具体的には、${exp ? exp + "の過程で" : "【具体的なエピソード】"}、成果を出しました。このプロセスで得た力を${company}でも活かせます。
${ctxLine}

（※デモ文。本番はご入力からオリジナルの自己PRを生成します。）`;
  } else if (tool === "mensetsu") {
    body =
`【よく聞かれる質問と回答の構成】

Q. なぜ${company}を志望しますか？
A. 結論ファーストで「${exp ? exp + "を活かしたい" : "【志望の理由】"}」と述べ、理由を具体化。${ctxLine}

Q. あなたの強みは？
A. 【強み】

Q. 入社後にどんな活躍をしたいですか？
A. 【入社後のビジョン】

（※デモ文。本番はあなたの経歴から本番想定の回答を生成します。）`;
  } else {
    body =
`■第1段落（結論）：なぜ${company}なのか
${company}を志望する理由は、${exp ? exp + "を通じて" : ""}【志望の理由】です。

■第2段落（経験と接続）：あなたの経験
${exp ? exp + "の経験から、" : ""}【経験の場面】。

■第3段落（入社後のビジョン）
入社後は、【入社後のビジョン】。

${ctxLine}

（※デモ文。実際の AI はご入力から生成します。企業固有の内容は「企業情報」からのみ記述し、空欄は【 】で残します。文字数目安：${len}字／トーン：${tone}）`;
  }

  const missingExperience = !exp;
  return {
    text: `【${scene}・${job}｜${company}】\n\n` + body,
    mock: true,
    companyContextUsed: !!ctxSnippet,
    contextSource: merged ? merged.source : null,
    missingExperience: missingExperience,
    notice: merged ? merged.note : null
  };
}

// ---------- モデル順次フォールバック（無料枠枯渇時に自動切替） ----------
// エラー分類: fatal=即失敗(認証等) / switch=次モデルへ(無料枠枯渇・レート制限・モデル不在)
function errorAction(status, data) {
  if (status === 401 || status === 403) return "fatal";
  if (status === 429) return "switch";                 // レート制限 / 無料枠枯渇
  if (status === 400) return "switch";                 // モデル不在等
  if (status >= 500 && status < 600) return "switch";  // 一時的なサーバーエラー
  return "fatal";
}

async function callModel(model, messages) {
  const key = process.env.OPENAI_API_KEY;
  const r = await fetch(BASE_URL + "/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + key },
    body: JSON.stringify({ model: model, messages: messages, temperature: 0.8, max_tokens: MAX_TOKENS })
  });
  let data = {};
  try { data = await r.json(); } catch (e) { data = {}; }
  if (!r.ok) {
    const action = errorAction(r.status, data);
    const err = new Error((data && data.error && data.error.message) || ("HTTP " + r.status));
    err.action = action;
    err.status = r.status;
    throw err;
  }
  const choice = (data.choices && data.choices[0]) || null;
  const text = choice && choice.message && choice.message.content;
  if (!text) { const err = new Error("空の応答"); err.action = "switch"; throw err; }
  // finish_reason: "length" は上限で切れた（＝文が途中で終わっている）。黙って返すと
  // 字数カウンタと食い違い「壊れている」ように見えるため、フラグとして持ち回る。
  return { text: text, finishReason: (choice && choice.finish_reason) || null };
}

// 無料モデルを順に試す。全滅(無料枠枯渇等)なら null、認証エラー等はそのまま投げる。
async function generateWithFallback(messages) {
  let lastErr = null;
  for (const model of FALLBACK_MODELS) {
    try {
      const out = await callModel(model, messages);
      return { text: out.text, model: model, finishReason: out.finishReason };
    } catch (e) {
      if (e.action === "fatal") throw e;
      lastErr = e;
      console.error("[fallback] model " + model + " failed: " + e.message + " -> next");
    }
  }
  return null;
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

  // 生成回数制限: ログイン中は Redis で1日 LOGGED_DAILY 回、匿名は Cookie で DAILY_LIMIT(2) 回。
  const todayStr = jstDate();
  const session = kvReady() ? await resolveSession(req) : null;
  let isAnon = true, limit, remaining, used = 0;
  if (session) {
    isAnon = false;
    limit = LOGGED_DAILY;
    used = await getDailyUsage(session.userId, todayStr);
    if (used >= limit) {
      res.status(429).json({
        error: "本日の生成回数上限（ログイン中は1日 " + limit + " 回）に達しました。明日またお試しください。",
        limitReached: true, remaining: 0, loggedIn: true
      });
      return;
    }
    await incDailyUsage(session.userId, todayStr);
    remaining = limit - (used + 1);
  } else {
    limit = DAILY_LIMIT;
    const cookieVal = getCookie(req, GEN_COOKIE);
    if (cookieVal) {
      const parts = cookieVal.split(":");
      if (parts[0] === todayStr) used = parseInt(parts[1], 10) || 0;
    }
    if (used >= limit) {
      res.status(429).json({
        error: "本日の生成回数上限（1日 " + limit + " 回）に達しました。ログインすると1日 " + LOGGED_DAILY + " 回まで生成できます。",
        limitReached: true, remaining: 0
      });
      return;
    }
    setGenCookie(res, todayStr + ":" + (used + 1));
    remaining = limit - (used + 1);
  }

  // 新契約: 構造化入力 + 企業情報取得（ルートA + ルートB）
  if (body && body.fields) {
    const f = body.fields;
    const ctx = await research(f["企業情報"]);          // ルートA: ユーザー貼りURL/テキスト

    // ルートB: 確認済みの法人番号があるときだけ gBizINFO を使う。
    // 法人名での自動検索は行わない —— 同名の別法人に当たると「事実だが別会社」が
    // 志望動機に混ざり、利用者はより気づきにくい（P0-0）。確認が無ければ使わない、が正しい。
    let gbizRes = { result: null, diag: { configured: gbizConfigured(), ok: false, step: "not-confirmed", status: null, error: null, hits: 0 } };
    const sel = (body.gbiz && typeof body.gbiz === "object") ? body.gbiz : null;
    if (sel && isCorporateNumber(sel.corporateNumber)) {
      gbizRes = await gbizDetail(sel.corporateNumber);
    } else if (sel && sel.confirmed === false) {
      gbizRes.diag.step = "declined";                 // 利用者が「該当なし/使わない」を明示（正常系）
    } else {
      // 旧キャッシュのJS・直接API呼び出しなど、確認を経ていないリクエスト
      gbizRes.diag.step = "no-confirmation";
    }

    const merged = mergeContext(ctx, gbizRes.result);
    if (!merged.note) {
      if (gbizRes.diag.step === "declined") {
        merged.note = "企業の登録情報（gBizINFO）は使用していません。入力された企業名と企業情報のみで生成しました。";
      } else if (gbizRes.diag.step === "no-confirmation") {
        merged.note = "企業情報の自動取得は、企業名の候補を確認したうえで有効になります。ページを再読み込みして企業名を入力し直してください。";
      }
    }
    // 成功も失敗も必ず残す。旧実装は失敗時に無言で null を返しており、
    // 機能が全滅していても誰も気づけない（＝最悪の失敗モード）状態だった。
    console.log("[gbiz] " + JSON.stringify(gbizRes.diag));
    const { system, user } = buildPrompt(body.tool || "shibou", f, merged);
    const key = process.env.OPENAI_API_KEY;
    if (!key) {
      const m = mock(body.tool || "shibou", f, merged);
      res.status(200).json(Object.assign(m, { remaining: remaining, gbiz: gbizRes.diag }));
      return;
    }
    try {
      const result = await generateWithFallback([
        { role: "system", content: system },
        { role: "user", content: user }
      ]);
      if (!result) {
        // 全モデル失敗（無料枠枯渇＋有料フォールバック qwen3.8-flash も不可）: 不捏造骨架を返し通知
        const m = mock(body.tool || "shibou", f, merged);
        m.notice = (m.notice ? m.notice + " " : "") +
          "※すべてのモデルが一時的に利用できませんでした（無料枠枯渇・有料フォールバック qwen3.8-flash も失敗）。しばらく経ってから再度お試しください。";
        m.freeQuotaExhausted = true;
        m.mock = true;
        res.status(200).json(Object.assign(m, { remaining: remaining, gbiz: gbizRes.diag }));
        return;
      }
      const cleaned = stripSelfReport(result.text);
      if (cleaned.stripped) console.log("[gen][strip] 自己申告の文字数を除去しました");
      const truncated = result.finishReason === "length";
      if (truncated) console.error("[gen][FAIL] finish_reason=length（上限で切断） model=" + result.model);
      let notice = merged.note;
      if (truncated) {
        notice = (notice ? notice + " " : "") +
          "※文が途中で切れた可能性があります（出力上限に到達）。もう一度生成するか、文字数の目安を短くしてください。";
      }
      await persistRecord(session, body.tool || "shibou", f, cleaned.text);
      res.status(200).json({
        text: cleaned.text,
        mock: false,
        model: result.model,
        truncated: truncated,
        strippedSelfReport: cleaned.stripped,
        companyContextUsed: !!merged.text,
        contextSource: merged.source,
        missingExperience: !(f["経験・キーワード"] || "").trim(),
        notice: notice,
        gbiz: gbizRes.diag,
        remaining: remaining
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
    return;
  }

  // 旧契約: messages のみ（他ツール互換）
  // ※ この契約を通るツールにも同じ不捏造ルールを必ず前置する（片方だけに置くと方針が崩れる）
  const messages = (body && body.messages) || [];
  const userText = (messages.filter((m) => m.role === "user").pop() || {}).content || "";
  const system = (messages.find((m) => m.role === "system") || {}).content || "";
  const hardened = [{ role: "system", content: NO_FABRICATION_RULES + "\n\n【出力ルール】\n- 本文のみを出力する。前置き・後書き・文字数の自己申告を書かない。\n\n" + (system || "") }]
    .concat(messages.filter(function (m) { return m.role !== "system"; }));
  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    res.status(200).json(Object.assign(legacyMock(system, userText), { remaining: remaining }));
    return;
  }
  try {
    const result = await generateWithFallback(hardened);
    if (!result) {
      res.status(200).json(Object.assign(legacyMock(system, userText), {
        notice: "※すべてのモデルが一時的に利用できませんでした。",
        freeQuotaExhausted: true,
        remaining: remaining
      }));
      return;
    }
    const cleaned = stripSelfReport(result.text);
    if (cleaned.stripped) console.log("[gen][strip] 自己申告の文字数を除去しました");
    res.status(200).json({
      text: cleaned.text,
      model: result.model,
      truncated: result.finishReason === "length",
      strippedSelfReport: cleaned.stripped,
      remaining: remaining
    });
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
  const scene = v["応募種別"] || "新卒";
  const job = v["職種"] || "総務・人事";
  const company = v["企業名"] || "御社";
  const exp = v["経験・キーワード"] || "学生時代の企画運営経験";
  let text = `【${scene}・${job}】\n\n${company}の${job}職を志望する理由は、${exp}を通じて得た視点を、貴社の事業で活かしたいと考えたからです。\n\n（※デモ文。実際の AI はご入力から生成します。）`;
  return { text: text, mock: true };
}
