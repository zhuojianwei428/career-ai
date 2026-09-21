// Vercel Serverless Function — AI 生成エンドポイント
// 不捏造(証拠駆動)エンジン:
//   1) ユーザーが貼った JD/企業情報(URL またはテキスト)を取得・抽出（ルートA）
//   2) 企業名から gBizINFO(経済産業省 REST API v2) で政府保有法人データを自動取得（ルートB）
//   3) 企業固有の内容は取得・入力された事実のみから記述、不明は【】占位符
//   4) 入力不足時は骨架+占位符を返し、経歴を捏造しない
// OpenAI 互換 API を呼ぶ。環境変数 OPENAI_API_KEY が無い場合は日本語デモ(同ルール適用)。
// 複数の無料モデルを順に試し、無料枠枯渇時は自動で次のモデルへ切替(MODEL_FALLBACK)。

const BASE_URL = process.env.OPENAI_BASE_URL || "https://dashscope.aliyuncs.com/compatible-mode/v1";
const MAX_TOKENS = 1600;
// 無料モデル順次フォールバック（百炼の各モデルは独立して100万トークンの無料枠あり）
// 片方の無料枠が枯渇したら自動で次のモデルへ。MODEL_FALLBACK で順序を上書き可能。
const FALLBACK_MODELS = (process.env.MODEL_FALLBACK && process.env.MODEL_FALLBACK.trim())
  ? process.env.MODEL_FALLBACK.split(",").map((s) => s.trim()).filter(Boolean)
  : (process.env.OPENAI_MODEL && process.env.OPENAI_MODEL.trim() && process.env.OPENAI_MODEL !== "gpt-4o-mini")
    ? [process.env.OPENAI_MODEL.trim()]
    : ["qwen-plus", "qwen-max", "qwen-turbo", "qwen-long", "qwen-flash"];

// ---------- gBizINFO (経済産業省 法人情報 REST API v2) ----------
// エンドポイント: https://api.info.gbiz.go.jp/hojin/v2/hojin/{法人番号}
// 認証ヘッダ: X-hojinInfo-api-token (利用申請で取得したトークンを GBIZ_API_TOKEN に設定)
// 無 token の場合はこの機能をスキップ（既存ロジックに影響なし）
const GBIZ_BASE = "https://api.info.gbiz.go.jp/hojin/v2/hojin";
const GBIZ_TOKEN = process.env.GBIZ_API_TOKEN;
const JSIC_MAJOR = {
  A: "農業・林業", B: "漁業", C: "鉱業・採石業", D: "建設業", E: "製造業",
  F: "電気・ガス・熱供給・水道業", G: "情報通信業", H: "運輸業・郵便業",
  I: "卸売業・小売業", J: "金融業・保険業", K: "不動産業・物品賃貸業",
  L: "学術研究・専門・技術サービス業", M: "宿泊業・飲食サービス業",
  N: "生活関連サービス業・娯楽業", O: "教育・学習支援業", P: "医療・福祉",
  Q: "複合サービス事業", R: "サービス業（他に分類されないもの）", S: "公務・その他"
};

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

// ---------- ルートB: gBizINFO 自動取得 ----------
async function gbizGet(path) {
  if (!GBIZ_TOKEN) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(function () { ctrl.abort(); }, 5000);
  try {
    const r = await fetch(GBIZ_BASE + path, {
      signal: ctrl.signal,
      headers: { "X-hojinInfo-api-token": GBIZ_TOKEN }
    });
    if (!r.ok) return null;
    const j = await r.json();
    return (j && j["hojin-infos"]) || null;
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
async function gbizResearch(companyName) {
  if (!GBIZ_TOKEN || !companyName || !companyName.trim()) return null;
  try {
    const q = companyName.trim();
    const searchList = await gbizGet("/?name=" + encodeURIComponent(q));
    if (!searchList || !searchList.length) return null;
    const list = searchList;
    const live = list.filter(function (x) { return x.status === "-"; });
    const pool = live.length ? live : list;
    const hit = pool.find(function (x) {
      return x.name && (x.name.indexOf(q) >= 0 || q.indexOf(x.name) >= 0);
    }) || pool[0];
    const cn = hit.corporate_number;
    if (!cn) return null;

    const [baseArr, patArr, subArr, proArr, certArr, wpArr] = await Promise.all([
      gbizGet("/" + cn),
      gbizGet("/" + cn + "/patent"),
      gbizGet("/" + cn + "/subsidy"),
      gbizGet("/" + cn + "/procurement"),
      gbizGet("/" + cn + "/certification"),
      gbizGet("/" + cn + "/workplace")
    ]);
    const base = baseArr && baseArr[0];
    const patent = patArr && patArr[0];
    const subsidy = subArr && subArr[0];
    const procurement = proArr && proArr[0];
    const cert = certArr && certArr[0];
    const wp = wpArr && wpArr[0];
    if (!base) return null;

    const f = [];
    if (base.name) f.push("法人名: " + base.name);
    if (base.industry && base.industry[0]) f.push("業種(JSIC): " + (JSIC_MAJOR[base.industry[0]] || base.industry[0]));
    if (base.business_summary) f.push("事業概要: " + base.business_summary);
    if (typeof base.capital_stock === "number") f.push("資本金: " + base.capital_stock.toLocaleString("ja-JP") + "円");
    if (typeof base.employee_number === "number") f.push("従業員数: " + base.employee_number.toLocaleString("ja-JP") + "人");
    if (base.location) f.push("本店所在地: " + base.location);
    if (base.date_of_establishment) f.push("設立: " + base.date_of_establishment);
    if (base.representative_name) f.push("代表者: " + base.representative_name);
    if (base.company_url) f.push("企業URL: " + base.company_url);
    if (patent && Array.isArray(patent.patent) && patent.patent.length) {
      f.push("特許: " + patent.patent.length + "件（最新登録番号 " + (patent.patent[0].registration_number || "—") + "）");
    }
    if (subsidy && Array.isArray(subsidy.subsidy) && subsidy.subsidy.length) {
      f.push("補助金受給: " + subsidy.subsidy.length + "件（例: " + (subsidy.subsidy[0].title || "—") + "）");
    }
    if (procurement && Array.isArray(procurement.procurement) && procurement.procurement.length) {
      f.push("官公庁調達実績: " + procurement.procurement.length + "件（例: " + (procurement.procurement[0].title || "—") + "）");
    }
    if (cert && Array.isArray(cert.certification) && cert.certification.length) {
      const titles = cert.certification.slice(0, 3).map(function (c) {
        return c.title + (c.government_departments ? "（" + c.government_departments + "）" : "");
      }).join("、");
      f.push("認定・表彰: " + cert.certification.length + "件（" + titles + "）");
    }
    if (wp && wp.workplace_info && wp.workplace_info.base_infos) {
      const b = wp.workplace_info.base_infos;
      const parts = [];
      if (b.average_continuous_service_years_Male != null) {
        parts.push("平均継続勤務年数 男" + b.average_continuous_service_years_Male + "/女" + (b.average_continuous_service_years_Female != null ? b.average_continuous_service_years_Female : "—") + "年");
      }
      if (b.average_age_Male != null) parts.push("平均年齢" + b.average_age_Male + "歳");
      if (b.average_overtime_work_hours != null) parts.push("月平均所定外労働時間" + b.average_overtime_work_hours + "h");
      if (b.worker_women_rate != null) parts.push("女性労働者比率" + b.worker_women_rate + "%");
      if (parts.length) f.push("職場情報: " + parts.join("、"));
    }
    if (!f.length) return null;
    return {
      source: "gbiz",
      facts: f,
      note: "経済産業省 gBizINFO（政府保有法人データ）から自動取得。データは更新タイミングにより最新ではない場合があり、最終確認は企業公式サイトで。"
    };
  } catch (e) {
    return null; // 失敗時は無視（既存ロジックに影響なし）
  }
}

// ルートA と ルートB を統合
function mergeContext(ctx, gbiz) {
  if (ctx && ctx.context) {
    let text = ctx.context;
    if (gbiz && gbiz.facts.length) {
      text += "\n\n【gBizINFO 登録情報（自動取得）】\n" + gbiz.facts.join("\n");
    }
    return { text: text, source: ctx.source || "gbiz", note: ctx.note || (gbiz ? gbiz.note : null) };
  }
  if (gbiz) {
    return { text: gbiz.facts.join("\n"), source: "gbiz", note: gbiz.note };
  }
  return { text: null, source: null, note: null };
}

// ---------- プロンプト構築（不捏造ルール） ----------
function buildPrompt(tool, f, merged) {
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
5. 必ず「企業名」を含め、その企業にしか通用しない内容（企業研究の成果）を企業情報から抽出して盛り込んでください。
6. gBizINFO（経済産業省）等の公開情報は「要確認」の扱いとし、最新情報は必ず企業公式サイトで再確認する前提で引用してください。`;
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
    ? `（${isGbiz ? "経済産業省 gBizINFO より自動取得" : "公開情報より抽出"}：${ctxSnippet}… — 要確認）`
    : `（企業情報が未入力のため、${company}固有の内容は【 】で空缺を残します。企業名を入力すれば gBizINFO から自動補完、または公式サイトURL/募集要項を貼るとより具体的になります）`;

  let body = "";
  const phExp = "【ここにあなたの経験を入力：例：大学のゼミで地域課題をフィールドワークし、チームで調査報告書を作成。その過程で得た工夫を活かしたい】";

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
  const text = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  if (!text) { const err = new Error("空の応答"); err.action = "switch"; throw err; }
  return text;
}

// 無料モデルを順に試す。全滅(無料枠枯渇等)なら null、認証エラー等はそのまま投げる。
async function generateWithFallback(messages) {
  let lastErr = null;
  for (const model of FALLBACK_MODELS) {
    try {
      const text = await callModel(model, messages);
      return { text: text, model: model };
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

  // 新契約: 構造化入力 + 企業情報取得（ルートA + ルートB）
  if (body && body.fields) {
    const f = body.fields;
    const ctx = await research(f["企業情報"]);          // ルートA: ユーザー貼りURL/テキスト
    const gbiz = await gbizResearch(f["企業名"]);         // ルートB: gBizINFO 自動取得
    const merged = mergeContext(ctx, gbiz);
    const { system, user } = buildPrompt(body.tool || "shibou", f, merged);
    const key = process.env.OPENAI_API_KEY;
    if (!key) {
      const m = mock(body.tool || "shibou", f, merged);
      res.status(200).json(m);
      return;
    }
    try {
      const result = await generateWithFallback([
        { role: "system", content: system },
        { role: "user", content: user }
      ]);
      if (!result) {
        // 全無料モデル枯渇: 不捏造骨架を返し、通知（サイトは停止しない）
        const m = mock(body.tool || "shibou", f, merged);
        m.notice = (m.notice ? m.notice + " " : "") +
          "※すべての無料モデルの無料枠が枯渇しました。しばらく経ってから再度お試しいただくか、有料課金を有効化してください。";
        m.freeQuotaExhausted = true;
        m.mock = true;
        res.status(200).json(m);
        return;
      }
      res.status(200).json({
        text: result.text,
        mock: false,
        model: result.model,
        companyContextUsed: !!merged.text,
        contextSource: merged.source,
        missingExperience: !(f["経験・キーワード"] || "").trim(),
        notice: merged.note
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
    const result = await generateWithFallback(messages);
    if (!result) {
      res.status(200).json(Object.assign(legacyMock(system, userText), {
        notice: "※すべての無料モデルの無料枠が枯渇しました。",
        freeQuotaExhausted: true
      }));
      return;
    }
    res.status(200).json({ text: result.text, model: result.model });
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
