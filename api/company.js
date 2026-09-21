// Vercel Serverless Function — 企業確認エンドポイント（P0-0）
//
// 目的: 生成の「前に」、利用者に企業を特定してもらう。
//   同名の別法人が実在するため、法人名の自動一致で1社に決め打ちすると
//   「事実だが別会社の情報」が志望動機に混ざる（実測で発生：架空の例「株式会社ミライテック」が
//   沖縄の実在同名法人に命中した）。捏造は「無中生有」だが、これは「実データの取り違え」で、
//   利用者はより気づきにくい。生成後ではなく生成前に見せて選ばせるのが唯一の確実な対策。
//
//   action: "search" → 法人名から候補一覧（法人名/所在地/法人番号/状態/業種/設立）
//   action: "detail" → 選ばれた法人番号の登録情報（＝生成に実際に使う内容のプレビュー）
//
// 方針: 失敗しても 500 を返さない。理由を構造化して返し、必ずログに残す
//       （P-1-2 の教訓：無言の失敗が最悪の失敗モード）。

import { gbizConfigured, gbizSearch, gbizDetail } from "./_lib/gbiz.mjs";

// 入力の上限。法人名は短いので、長文を渡される余地を残さない。
const NAME_MIN = 2;
const NAME_MAX = 60;
const MAX_CANDIDATES = 10;

// 簡易レート制限（プロセス内）。Serverless はインスタンスが使い捨てなので完全な防御ではないが、
// 単一インスタンスへの連打は止まる。外部APIのトークンを無制限に使い潰されないための最低限。
const HITS = new Map();
const WINDOW_MS = 60 * 60 * 1000;
const MAX_PER_WINDOW = 60;
function rateLimited(ip) {
  const now = Date.now();
  const rec = HITS.get(ip);
  if (!rec || now - rec.start > WINDOW_MS) {
    HITS.set(ip, { start: now, n: 1 });
    return false;
  }
  rec.n += 1;
  return rec.n > MAX_PER_WINDOW;
}
function clientIp(req) {
  const h = req.headers || {};
  const f = h["x-forwarded-for"];
  if (typeof f === "string" && f) return f.split(",")[0].trim();
  return (req.socket && req.socket.remoteAddress) || "unknown";
}

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
  const action = (body && body.action) || "search";

  // 未設定でも 500 にせず「使えない」と正直に返す（UI は通常生成に落ちる）
  if (!gbizConfigured()) {
    console.warn("[company][SKIP] GBIZ_API_TOKEN 未設定のため企業検索は無効");
    res.status(200).json({
      configured: false,
      ok: false,
      reason: "not-configured",
      candidates: [],
      message: "企業データベース（gBizINFO）が現在利用できません。入力された企業名と企業情報だけで生成します。"
    });
    return;
  }

  const ip = clientIp(req);
  if (rateLimited(ip)) {
    console.warn("[company][LIMIT] ip=" + ip);
    res.status(429).json({ configured: true, ok: false, reason: "rate-limited", candidates: [], error: "検索回数が多すぎます。しばらく待ってからお試しください。" });
    return;
  }

  if (action === "detail") {
    const cn = body && body.corporateNumber;
    const r = await gbizDetail(cn);
    console.log("[company][detail] " + JSON.stringify(r.diag));
    if (!r.ok) {
      res.status(200).json({
        configured: true,
        ok: false,
        action: "detail",
        diag: r.diag,
        message: "選択された法人の登録情報を取得できませんでした。入力された企業名と企業情報だけで生成します。"
      });
      return;
    }
    res.status(200).json({
      configured: true,
      ok: true,
      action: "detail",
      matched: r.result.matched,
      facts: r.result.facts,
      note: r.result.note,
      diag: r.diag
    });
    return;
  }

  if (action !== "search") {
    res.status(400).json({ error: "unknown action" });
    return;
  }

  const name = String((body && body.name) || "").trim();
  if (name.length < NAME_MIN || name.length > NAME_MAX) {
    res.status(400).json({
      configured: true, ok: false, action: "search", candidates: [],
      error: "企業名は" + NAME_MIN + "〜" + NAME_MAX + "文字で入力してください。"
    });
    return;
  }

  const r = await gbizSearch(name);
  // 成功も失敗も残す（失敗がログにも出ない状態を作らない）
  console.log("[company][search] name=" + name + " " + JSON.stringify(r.diag));
  if (!r.ok) {
    res.status(200).json({
      configured: true,
      ok: false,
      action: "search",
      candidates: [],
      error: r.error,
      diag: r.diag,
      message: "企業データベースに接続できませんでした。入力された企業名と企業情報だけで生成します。"
    });
    return;
  }
  res.status(200).json({
    configured: true,
    ok: true,
    action: "search",
    candidates: r.items.slice(0, MAX_CANDIDATES),
    diag: r.diag,
    message: r.items.length
      ? null
      : "法人データに見つかりませんでした（個人事業主・屋号・新設法人などは登録が無い場合があります）。入力された企業名と企業情報だけで生成します。"
  });
}
