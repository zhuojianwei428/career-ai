/* SEO / 落地页转化 相关改动的本地校验（网络不要）
 *
 * 这一批改动有三个"会静默失效"的风险点，必须用测试钉住：
 *   1. FAQPage 的结构化数据与页面上可见的 FAQ 文字不一致 → Google 视为误导性 markup（可能吃手动操作）。
 *      手工维护两份文案迟早会跑偏，所以每次都要比对。
 *   2. 「例を入れてみる」的 EXAMPLE 键名与页面的 data-field 不一致 → 按钮点了没反应，
 *      而且不会报错（fillExample 查不到节点就静默跳过）。
 *   3. sitemap 里写了不存在的页面 / 漏了实际存在的页面。
 *
 * 実行: node test-seo-lp.mjs
 */
import { readFileSync, existsSync } from "node:fs";

const BASE = "https://www.coverletterkit.com";
const PAGES = ["index.html", "jiko-pr.html", "rirekisho.html", "shokumu.html", "mensetsu.html"];
const NOINDEX_PAGES = ["account.html"];
// ツールではないがインデックスさせたいページ（EXAMPLE やフォームを持たないため PAGES とは分ける）
const EXTRA_INDEXABLE = ["privacy.html"];

let pass = 0, fail = 0;
const failures = [];
function ok(cond, label) {
  if (cond) { pass++; } else { fail++; failures.push(label); }
}
function eq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; } else { fail++; failures.push(label + "\n      actual:   " + a + "\n      expected: " + e); }
}
const read = (f) => readFileSync(new URL("./" + f, import.meta.url), "utf8");

/* ---------- 1. robots.txt ---------- */
ok(existsSync(new URL("./robots.txt", import.meta.url)), "robots.txt が存在する");
const robots = read("robots.txt");
ok(/^User-agent:\s*\*/m.test(robots), "robots.txt に User-agent: * がある");
ok(/^Allow:\s*\/\s*$/m.test(robots), "robots.txt が全体を Allow している");
ok(/^Disallow:\s*\/account\.html\s*$/m.test(robots), "robots.txt が /account.html を除外している");
ok(/^Disallow:\s*\/api\/\s*$/m.test(robots), "robots.txt が /api/ を除外している");
const smLine = (robots.match(/^Sitemap:\s*(\S+)\s*$/m) || [])[1];
eq(smLine, BASE + "/sitemap.xml", "robots.txt の Sitemap 行が本番URLを指す");

/* ---------- 2. sitemap.xml ---------- */
ok(existsSync(new URL("./sitemap.xml", import.meta.url)), "sitemap.xml が存在する");
const sm = read("sitemap.xml");
ok(sm.startsWith('<?xml version="1.0" encoding="UTF-8"?>'), "sitemap が XML 宣言で始まる");
ok(sm.includes('xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"'), "sitemap の名前空間が正しい");
ok(!/<changefreq>|<priority>/.test(sm), "sitemap に Google が無視する changefreq/priority を書いていない");

const locs = [...sm.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
ok(locs.length === PAGES.length + EXTRA_INDEXABLE.length, "sitemap の URL 数が対象ページ数と一致（" + locs.length + "/" + (PAGES.length + EXTRA_INDEXABLE.length) + "）");
ok(new Set(locs).size === locs.length, "sitemap に重複 URL がない");
ok(locs.every((u) => u.startsWith(BASE)), "sitemap の URL がすべて本番ドメイン配下");

// sitemap に載せた URL がすべて実在のファイルに対応しているか
for (const u of locs) {
  const path = u.slice(BASE.length);
  const file = path === "/" ? "index.html" : path.replace(/^\//, "");
  ok(existsSync(new URL("./" + file, import.meta.url)), "sitemap の " + path + " に対応する " + file + " が存在する");
}
// 逆に、インデックスさせたい実在ページが漏れていないか
for (const p of PAGES.concat(EXTRA_INDEXABLE)) {
  ok(locs.some((u) => u === BASE + "/" + (p === "index.html" ? "" : p)), "sitemap に " + p + " 相当の URL が含まれる");
}
for (const p of NOINDEX_PAGES) {
  ok(!locs.some((u) => u.endsWith("/" + p)), "sitemap に noindex 扱いの " + p + " が入っていない");
}

/* ---------- 3. FAQPage 構造化データと可視 FAQ の一致 ---------- */
const home = read("index.html");
const ldBlocks = [...home.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => m[1]);
eq(ldBlocks.length, 1, "index.html に JSON-LD ブロックが1つある");
ok(ldBlocks.length > 0, "JSON-LD ブロックが取得できる");

let faqLd = null;
if (ldBlocks.length) {
  try {
    faqLd = JSON.parse(ldBlocks[0]);
    pass++;
  } catch (e) {
    fail++;
    failures.push("JSON-LD が JSON として壊れている: " + e.message);
  }
}
if (faqLd) {
  eq(faqLd["@context"], "https://schema.org", "JSON-LD の @context が schema.org");
  eq(faqLd["@type"], "FAQPage", "JSON-LD の @type が FAQPage");

  // ページ上に実在する Q/A（details/summary）を抽出
  const visible = [...home.matchAll(/<details><summary>([^<]+)<\/summary><p>([^<]+)<\/p><\/details>/g)]
    .map((m) => ({ q: m[1].trim(), a: m[2].trim() }));
  ok(visible.length >= 3, "ページ上に可視 FAQ が3件以上ある（実測 " + visible.length + " 件）");

  const declared = (faqLd.mainEntity || []).map((x) => ({
    q: (x.name || "").trim(),
    a: ((x.acceptedAnswer && x.acceptedAnswer.text) || "").trim()
  }));

  // Google の要件：構造化データに書いた内容は必ずページ上に見えていること
  eq(declared, visible, "JSON-LD の Q/A が可視 FAQ と完全一致（順序・文言とも）");
  ok(declared.every((d) => d.q && d.a), "すべての Q/A が空でない");
  // 「【◯◯】が回答に残る」のは、未記入の穴が SERP に出る事故なので許さない。
  // ただし空の【 】は「足りない箇所は【 】のまま残ります」という説明での言及なので許容する。
  ok(declared.every((d) => (d.a.match(/【[^】\s]+】/) || []).length === 0), "回答に未記入のプレースホルダ【◯◯】が残っていない（空の【 】は説明の言及として許容）");
  ok(!/aggregateRating|reviewCount|ratingValue/.test(ldBlocks[0]), "検証していない評価値を宣言していない");
}

/* ---------- 4. 「例を入れてみる」が全ツールページで機能する形か ---------- */
for (const p of PAGES) {
  const html = read(p);
  ok(/example-bar/.test(html), p + ": 例投入ボタンの器がある");
  ok(/CareerAI\.fillExample\('gen-form', EXAMPLE\)/.test(html), p + ": fillExample を EXAMPLE 付きで呼んでいる");
  ok(/var EXAMPLE = \{/.test(html), p + ": EXAMPLE を定義している");

  const block = (html.match(/var EXAMPLE = \{([\s\S]*?)\n  \};/) || [])[1] || "";
  const exKeys = [...block.matchAll(/^\s*"([^"]+)":/gm)].map((m) => m[1]);
  const fields = [...new Set([...html.matchAll(/data-field="([^"]+)"/g)].map((m) => m[1]))];

  ok(exKeys.length > 0, p + ": EXAMPLE にキーがある（" + exKeys.length + " 個）");
  // EXAMPLE のキーがフォームに実在しないと、その値は黙って捨てられる
  const strayKeys = exKeys.filter((k) => !fields.includes(k));
  eq(strayKeys, [], p + ": EXAMPLE のキーがすべて data-field に存在する（余りなし）");
  // 必須項目が埋まらないと「例を入れてみる」→生成で弾かれる
  const required = (html.match(/required:\s*\[([^\]]*)\]/) || [])[1] || "";
  const reqKeys = [...required.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  const unfilled = reqKeys.filter((k) => !exKeys.includes(k));
  eq(unfilled, [], p + ": EXAMPLE が必須項目をすべて埋めている（未充足なし）");
  // chip の値は data-value と一致していないと選択が動かない
  for (const k of exKeys) {
    const vals = [...html.matchAll(new RegExp('data-field="' + k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + '" data-group="[^"]*" data-value="([^"]+)"', "g"))].map((m) => m[1]);
    if (vals.length) {
      const want = (block.match(new RegExp('"' + k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + '":\\s*"([^"]+)"')) || [])[1];
      ok(vals.includes(want), p + ": chip「" + k + "」の例値『" + want + "』が選択肢に存在する");
    }
  }
}

/* ---------- 5. 計測イベントの取りこぼし・増えすぎを検知 ---------- */
const engine = read("assets/js/engine.js");
ok(/function track\(name, params\)/.test(engine), "engine.js に track() がある");
ok(/function fillExample\(formId, data\)/.test(engine), "engine.js に fillExample() がある");
ok(/fillExample: fillExample,/.test(engine), "fillExample が公開APIに出ている");
ok(/track: track,/.test(engine), "track が公開APIに出ている");
ok(/var GA4_ID = "";/.test(engine), "GA4_ID が1か所で管理されている（既定は未設定）");
ok(/function primeGtag\(\)/.test(engine), "gtag スタブを同期で用意する primeGtag() がある");
ok(/typeof window\.gtag !== "function"\) return;/.test(engine), "track() が gtag 未読込でも落ちない（早期 return）");
// スタブを load まで遅らせると、load 前に起きたイベントが捨てられる。
// track() 側でも primeGtag() を呼び、ID があるのに未準備という状態を作らない。
ok(
  /function track\(name, params\) \{[\s\S]{0,300}?primeGtag\(\);/.test(engine),
  "track() が送信前に primeGtag() を呼ぶ（load 前のイベントを取りこぼさない）"
);
ok(
  /addEventListener\("load", loadGtagScript\)/.test(engine),
  "外部スクリプトの読み込みだけを load 後に回している（LCP/INP を悪化させない）"
);
ok(!/initAnalytics/.test(engine), "旧 initAnalytics() が残っていない（load 前の取りこぼし経路を消した）");

const events = [...engine.matchAll(/track\("([a-z_]+)"/g)].map((m) => m[1]);
const EXPECTED_EVENTS = [
  "generate_start", "limit_reached", "generate_success", "generate_error",
  "pdf_export", "text_export", "example_fill",
  "login_success", "signup_code_sent", "signup_complete", "logout",
  // P0 で追加：コピーはこのサイト最大の転換点、ph_fill は「空欄を埋めた」＝価値到達の証拠
  "copy_all", "ph_fill", "hint_tag_insert"
];
for (const e of events) ok(EXPECTED_EVENTS.includes(e), "計測イベント名 " + e + " が既知の一覧にある");
for (const e of EXPECTED_EVENTS) ok(events.includes(e), "計測イベント " + e + " が実際に発火する場所がある");

/* ---------- 6. CLS 対策（ナビの幅予約） ---------- */
const css = read("assets/css/style.css");
ok(/\.auth-area \{[^}]*min-width:\s*10\.25rem/.test(css), ".auth-area が幅を予約している（CLS 対策）");
// 幅を予約しても、器そのものが fetch 応答後に作られると初回描画では空きが無く、
// 要素が出現した瞬間にナビのリンク列が丸ごとずれる（実測 186px）。器は同期的に作る。
ok(
  /function init\(\) \{[\s\S]{0,400}?ensureAuthArea\(\);\s*\n\s*me\(\);/.test(engine),
  "init() が fetch を待たずに auth-area の器を同期的に作る"
);
// それでも nav は HTML の時点で一度描画されるため、器が HTML に無いと
// 「初回描画 → スクリプトが挿入」の間で nav のリンク列がずれる（実測 632→446、186px）。
// 6 ページすべてが器を HTML に持つことを固定する。
for (const p of PAGES.concat(NOINDEX_PAGES).concat(EXTRA_INDEXABLE)) {
  ok(
    /<span class="auth-area" id="auth-area"><\/span>/.test(read(p)),
    p + ": auth-area の器を HTML に持つ（JS 挿入による初回描画のずれを防ぐ）"
  );
  ok(
    read(p).indexOf('<span class="auth-area" id="auth-area"></span>') < read(p).indexOf('id="theme-toggle"'),
    p + ": 器が theme-toggle より前に置かれている（ログイン欄は左、テーマ切替は右）"
  );
}
// 幅予約は狭い画面では解除する。予約したまま行を占有させると
// 折り返すナビが 1 段増えて、モバイルの常時ナビ高さが 188px→236px に膨らむ（実測）。
ok(
  /@media \(max-width: 35rem\) \{ \.auth-area \{ min-width: 0; \} \}/.test(css),
  "狭い画面では幅予約を解除してナビ高さを増やさない"
);
ok(/\.io-grid/.test(css) && /\.io-arrow/.test(css) && /\.example-bar/.test(css), "入力例→結果例 / 例ボタンのスタイルがある");
ok(/\.card\.policy/.test(css), "プライバシーポリシー用のスタイルがある（.card の持ち上げを打ち消す）");

/* ---------- 7. 計測タグが計測以外の用途に使われていない ---------- */
ok(!/googletagmanager[\s\S]{0,80}adsbygoogle/.test(engine), "広告タグを混ぜていない");
ok(/anonymize_ip: true/.test(engine), "IP を匿名化して送信している");

/* ---------- 結果 ---------- */
console.log("\n=== SEO / ランディングページ改修 検査 ===");
if (failures.length) {
  console.log("\n失敗:");
  failures.forEach((f, i) => console.log("  " + (i + 1) + ") " + f));
} else {
  console.log("  失敗なし");
}
console.log("\nPASS: " + pass + "  FAIL: " + fail + "\n");
process.exit(fail ? 1 : 0);
