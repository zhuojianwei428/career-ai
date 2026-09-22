// 测量脚本（赤線 #1 長期監視点）— 独立コマンド `npm run measure`
//
// 目的: 生成出力の【 】穴を「主観動機 / 客観事実 / 分類不能(?)」に分類し、
//   客観事実類の穴が 0 かを監視する。客観事実類の穴 > 0 は「モデルが事実を知らないのに
//   穴を残さず書こうとした」または「新しい出力形」のサイン → 要調査。
//   分類不能(?) が急増することも信号（モデルが新しいラベル型を出した）。
//
// 設計:
//   - 対象は本番デプロイ済み /api/generate（MEASURE_BASE で指定、既定は coverletterkit.com）
//   - 节流: 呼び出し間に MEASURE_THROTTLE_MS（既定 1500）スリープ
//   - 缓存: _measure-cache.json に保存。再実行時は再利用（--force で再取得）
//   - 429 感知: ステータス 429 を検知したら残りを中止し、レート制限と報告
//   - npm test には含まれない（独立コマンド）。報告は標準出力 + _measure-report.json
//
// 入力は「中小完全同名」6 例（A/B 両側）。経験・キーワードは空 → 主観動機の穴が残るのが正解。
// 企業は P0-0 で確認済みの法人番号を渡す（ルートB）。

import { fileURLToPath } from "url";
import { writeFileSync, readFileSync } from "fs";

const BASE = process.env.MEASURE_BASE || "https://www.coverletterkit.com";
const THROTTLE = Number(process.env.MEASURE_THROTTLE_MS || 1500);
const FORCE = process.argv.includes("--force");
const CACHE_FILE = fileURLToPath(new URL("./_measure-cache.json", import.meta.url));
const REPORT_FILE = fileURLToPath(new URL("./_measure-report.json", import.meta.url));

// 中小完全同名 6 例（A/B 両側）。法人番号は P0-0 で確認済みのもの。
const CASES = [
  { tag: "中央建設-A", name: "中央建設", cn: "1010001004816" },
  { tag: "中央建設-B", name: "中央建設", cn: "1020001052665" },
  { tag: "第一工業-A", name: "第一工業", cn: "1020002008352" },
  { tag: "第一工業-B", name: "第一工業", cn: "1030002056598" },
  { tag: "あおぞら-A", name: "あおぞら", cn: "1010001216948" },
  { tag: "あおぞら-B", name: "あおぞら", cn: "1011001137135" }
];

// 経験・キーワードは「入力済み」として渡す（現実的な利用法 + Task 1 の 0 客観基線との比較用）。
// 空にすると【経験の場面】【学び】などの「ユーザー自身の事実」の穴が出るが、それは捏造ではなく
// 正しい動作（ユーザーが埋めるべき事実）。赤線 #1 の監視は「動機を捏造せず穴に残す」なので、
// 入力を揃えた状態で客観事実類の穴が 0 になるのが健康な基線。
const EXPERIENCE = "飲食店アルバイトで接客と在庫管理を担当。チームで月次売上を前年比10%向上。ゼミで地域課題をフィールドワークし調査報告書を作成。";

// engine.js の holeCategory と同一ロジック（分類表の単一ソースではないが、監視用に同期）
function classify(label) {
  const s = (label || "").trim();
  if (/共感|志望|やりたい|入社後|自己PR|強み|なぜ|興味|動機|想い|魅力|貢献したい|関わりたい|働きたい|熱意|こだばり|理由|価値観|やりがい|思い|理解/.test(s)) return "subj";
  if (/事業内容|企業名|職務|経験|スキル|成果|学び|エピソード|資格|担当|保有|実績|沿革|取扱|サービス|商品|専門|技術/.test(s)) return "obj";
  return "?";
}

// 出力から【 】を抽出。構造的見出し（段落等）や wrapper（｜含む）は除外。
function extractHoles(text) {
  const out = [];
  const re = /【([^】]*?)】/g;
  let m;
  while ((m = re.exec(text || "")) !== null) {
    const label = (m[1] || "").trim();
    if (!label) continue;
    if (label.includes("｜")) continue; // 【scene・job｜company】wrapper
    if (label.length > 20) continue;    // 穴ラベルは 10〜14 字。長いのは見出し等
    out.push(label);
  }
  return out;
}

function loadCache() {
  try { return JSON.parse(readFileSync(CACHE_FILE, "utf8")); } catch (e) { return {}; }
}
function saveCache(c) {
  try { writeFileSync(CACHE_FILE, JSON.stringify(c, null, 2)); } catch (e) { /* ignore */ }
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function measureCase(c, cache) {
  if (!FORCE && cache[c.tag] && cache[c.tag].text) {
    return { tag: c.tag, cached: true, ...cache[c.tag] };
  }
  const body = {
    tool: "shibou",
    fields: {
      "応募種別": "新卒",
      "職種": "総務・人事",
      "企業名": c.name,
      "経験・キーワード": EXPERIENCE, // 入力済みとして渡す（Task 1 の 0 客観基線と比較）
      "文字数": "400",
      "トーン": "フォーマル"
    },
    gbiz: { corporateNumber: c.cn, name: c.name } // P0-0 確認済みルートB
  };
  const res = await fetch(BASE + "/api/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (res.status === 429) {
    return { tag: c.tag, rateLimited: true, status: 429 };
  }
  if (!res.ok) {
    return { tag: c.tag, error: true, status: res.status };
  }
  const data = await res.json();
  const text = data.text || "";
  const rec = {
    text,
    mock: !!data.mock,
    truncated: !!data.truncated,
    contextSource: data.contextSource || null,
    gbizStep: (data.gbiz && data.gbiz.step) || null
  };
  cache[c.tag] = rec;
  return { tag: c.tag, cached: false, ...rec };
}

function tally(holes) {
  const t = { subj: 0, obj: 0, q: 0, detail: [] };
  for (const h of holes) {
    const cat = classify(h);
    if (cat === "subj") t.subj++;
    else if (cat === "obj") t.obj++;
    else t.q++;
    t.detail.push({ label: h, cat });
  }
  return t;
}

async function main() {
  const cache = loadCache();
  const results = [];
  let rateLimited = false;
  for (const c of CASES) {
    if (rateLimited) { results.push({ tag: c.tag, skipped: "rate-limited" }); continue; }
    if (results.length > 0) await sleep(THROTTLE);
    let r;
    try {
      r = await measureCase(c, cache);
    } catch (e) {
      r = { tag: c.tag, error: true, message: e.message };
    }
    if (r.rateLimited) rateLimited = true;
    results.push(r);
  }
  saveCache(cache);

  // 集計
  const totals = { subj: 0, obj: 0, q: 0, cases: 0, holesTotal: 0 };
  const perCase = [];
  for (const r of results) {
    if (r.skipped || r.error || r.rateLimited || !r.text) {
      perCase.push({ tag: r.tag, status: r.skipped || (r.rateLimited ? "rate-limited" : "error"), note: r.message || "" });
      continue;
    }
    const holes = extractHoles(r.text);
    const t = tally(holes);
    totals.cases++;
    totals.subj += t.subj;
    totals.obj += t.obj;
    totals.q += t.q;
    totals.holesTotal += holes.length;
    perCase.push({
      tag: r.tag,
      cached: !!r.cached,
      mock: !!r.mock,
      contextSource: r.contextSource,
      gbizStep: r.gbizStep,
      holeCount: holes.length,
      subj: t.subj,
      obj: t.obj,
      q: t.q,
      holes: t.detail
    });
  }

  const verdict = totals.subj > 0
    ? "✅ 主観動機類の穴が " + totals.subj + " 件残っている → 赤線 #1 の正しい執行（動機を捏造せず穴に残した）。客観事実類の穴 = " + totals.obj + "。"
    : "⚠️ 主観動機類の穴が 0 件 — 模型が動機を埋めた（捏造の可能性あり）。要調査。";

  const report = { generatedAt: new Date().toISOString(), base: BASE, totals, perCase, verdict };
  try { writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2)); } catch (e) { /* ignore */ }

  // 人間向け出力
  console.log("===== 【 】主/客観分類 測定（赤線 #1 監視）=====");
  console.log("対象: " + BASE + "  /  例数: " + CASES.length + "（中小完全同名 A/B）  /  throttle=" + THROTTLE + "ms  force=" + FORCE);
  console.log("経験・キーワード: 入力済みとして渡す（Task 1 の「客観=0」基線との比較用）");
  console.log("");
  for (const p of perCase) {
    if (p.status) { console.log("・" + p.tag + " — " + p.status + (p.note ? " (" + p.note + ")" : "")); continue; }
    console.log("・" + p.tag + (p.cached ? " [cache]" : "") + " — 穴 " + p.holeCount + " | 主観 " + p.subj + " / 客観 " + p.obj + " / 分類不能 " + p.q +
      " | mock=" + p.mock + " src=" + (p.contextSource || "-") + " gbiz=" + (p.gbizStep || "-"));
    for (const h of p.holes) {
      console.log("    - 【" + h.label + "】 → " + (h.cat === "subj" ? "主観動機" : h.cat === "obj" ? "客観事実" : "分類不能(?)"));
    }
  }
  console.log("");
  console.log("===== 集計 =====");
  console.log("生成成功例: " + totals.cases + " / " + CASES.length);
  console.log("穴合計: " + totals.holesTotal + "  |  主観動機: " + totals.subj + "  /  客観事実: " + totals.obj + "  /  分類不能(?): " + totals.q);
  console.log("");
  console.log(verdict);
  if (totals.obj > 0) console.log("※ 客観事実類の穴 " + totals.obj + " 件 — 入力済みの事実が埋まらず残った（捏造ではないが、模型が事実を使い切れていない/保守的）。経験・キーワード を入力しているなら要調査。");
  if (totals.q > 0) console.log("※ 分類不能(?) が " + totals.q + " 件 — 分類表の更新が必要な新ラベル型の可能性（holeCategory を見直せ）。");
  console.log("補足：穴の「有無」だけでは「動機を捏造して穴を消した」は検出できない（穴が無い＝埋めた可能性）。要調査時は実際の本文を目視確認せよ。");
  if (rateLimited) console.log("⚠️ 途中で 429（レート制限）を検知 → 残りを中止。少し経って --force で再実行。");
  console.log("");
  console.log("報告ファイル: " + REPORT_FILE);
}

main().catch((e) => { console.error("FATAL: " + e.message); process.exit(1); });
