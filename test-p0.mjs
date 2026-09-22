// P0（企業確認・H1/Title・フォーム減負・【】補完・コピー・字数・モバイル・信任）検査
//   node test-p0.mjs
// ネットワーク不要。fetch を横取りして実ハンドラを走らせる（ESM のキャッシュは ?case= で回避）。
import { readFileSync, existsSync } from "node:fs";

const BASE = "https://www.coverletterkit.com";
const PAGES = ["index.html", "jiko-pr.html", "rirekisho.html", "shokumu.html", "mensetsu.html"];
const ALL_PAGES = PAGES.concat(["account.html", "privacy.html"]);
const GBIZ = "https://api.info.gbiz.go.jp/hojin/v2/hojin";
const CN = "1180301018771";
const CN2 = "4180301018772";

let pass = 0, fail = 0;
const failures = [];
function ok(cond, label) {
  if (cond) { pass++; return; }
  fail++; failures.push(label);
}
function eq(actual, expected, label) {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a === b) { pass++; return; }
  fail++; failures.push(label + "\n      actual:   " + a + "\n      expected: " + b);
}
const read = (f) => readFileSync(new URL("./" + f, import.meta.url), "utf8");

const gen = read("api/generate.js");
const comp = read("api/company.js");
const lib = read("api/_lib/gbiz.mjs");
const eng = read("assets/js/engine.js");
const css = read("assets/css/style.css");
const index = read("index.html");

/* ================= 1. P0-0 企業確認エンドポイント（実際に走らせる） ================= */
function jsonRes(status, obj) {
  return {
    ok: status >= 200 && status < 300,
    status: status,
    headers: { get: () => "application/json" },
    json: async () => obj,
    text: async () => JSON.stringify(obj)
  };
}
const calls = [];
function stubFetch(mode) {
  return async function (url) {
    const u = String(url);
    calls.push(u);
    if (u.indexOf("api.info.gbiz.go.jp") < 0) throw new Error("unexpected fetch: " + u);
    // 実測再現: 末尾スラッシュ付きはトークンが正しくても 500（ダミールート扱い）
    if (/\/hojin\/v2\/hojin\/\?/.test(u)) {
      return jsonRes(500, { message: "500 - Internal Server Error." });
    }
    if (mode === "bad") return jsonRes(401, { message: "401 - Unauthorized" });
    if (u.indexOf("?name=") >= 0) {
      if (mode === "empty") return jsonRes(200, { "hojin-infos": [] });
      // 同名の別法人が並ぶ実際の形（＝選ばせないと取り違える）
      return jsonRes(200, { "hojin-infos": [
        { corporate_number: CN2, name: "株式会社ミライテック", location: "沖縄県那覇市", status: "-", industry: ["G"], date_of_establishment: "2015-04-01" },
        { corporate_number: CN, name: "トヨタ自動車株式会社", location: "愛知県豊田市トヨタ町1番地", status: "-", industry: ["E"] },
        { corporate_number: "9999999999999", name: "旧社名 株式会社ミライテック", location: "東京都", status: "2" }
      ] });
    }
    if (u === GBIZ + "/" + CN) {
      return jsonRes(200, { "hojin-infos": [{
        corporate_number: CN, name: "トヨタ自動車株式会社", industry: ["E"],
        business_summary: "自動車の製造・販売", capital_stock: 635401000000, employee_number: 375870,
        location: "愛知県豊田市トヨタ町1番地", date_of_establishment: "1937-08-28",
        representative_name: "佐藤 恒治", company_url: "https://global.toyota/"
      }] });
    }
    return jsonRes(200, { "hojin-infos": [] });
  };
}
function makeRes() {
  return {
    code: null, payload: null, headers: {},
    status(c) { this.code = c; return this; },
    json(o) { this.payload = o; return this; },
    setHeader(k, v) { this.headers[k] = v; }
  };
}
async function loadCompany(tag) {
  const url = new URL("./api/company.js?case=" + tag, import.meta.url).href;
  return (await import(url)).default;
}
async function callCompany(handler, body, ip) {
  const res = makeRes();
  const logs = [], errs = [], warns = [];
  const oL = console.log, oE = console.error, oW = console.warn;
  console.log = (...a) => logs.push(a.join(" "));
  console.error = (...a) => errs.push(a.join(" "));
  console.warn = (...a) => warns.push(a.join(" "));
  try {
    await handler({ method: "POST", headers: { "x-forwarded-for": ip || "10.0.0.1" }, body: body }, res);
  } finally {
    console.log = oL; console.error = oE; console.warn = oW;
  }
  return { res, logs, errs, warns };
}
async function withFetch(mode, fn) {
  const orig = globalThis.fetch;
  globalThis.fetch = stubFetch(mode);
  try { return await fn(); } finally { globalThis.fetch = orig; }
}

// 検索: 同名別法人を「選ばせる」ために複数返す
const c1 = await loadCompany("search");
const S = await withFetch("ok", async () => {
  process.env.GBIZ_API_TOKEN = "t".repeat(40);
  calls.length = 0;
  return callCompany(c1, { action: "search", name: "株式会社ミライテック" }, "10.0.0.10");
});
eq(S.res.code, 200, "P0-0: 検索は 200");
ok(S.res.payload && S.res.payload.configured === true, "P0-0: configured=true");
eq(S.res.payload.candidates.length, 3, "P0-0: 同名の別法人を含む候補を3件返す（1社に決め打ちしない）");
ok(S.res.payload.candidates.every((x) => /^[0-9]{13}$/.test(x.corporateNumber)),
  "P0-0: 候補には必ず13桁の法人番号が付く（選んだ法人を特定するため）");
ok(S.res.payload.candidates.every((x) => x.name && x.location !== undefined),
  "P0-0: 候補に法人名と所在地が入る（利用者が見分けられる）");
eq(S.res.payload.candidates[2].status, "2", "P0-0: 登記閉鎖等の状態も候補に含める（除外せず後ろに回す）");
ok(typeof S.logs.find((l) => l.indexOf("[company][search]") >= 0) === "string",
  "P0-0: 検索結果が必ずログに残る");
ok(calls.every((u) => !/\/hojin\/v2\/hojin\/\?/.test(u)), "P0-0: 末尾スラッシュ形式を使っていない");
// 本番で実測した自己矛盾: search が成功しているのに diag.ok が false だった（detail 側は true）。
// 「hits はあるのに ok:false」はログを見た人を誤診させるので、意味を統一して固定する。
eq(S.res.payload.diag.step, "search-done", "P0-0: 検索成功時は step=search-done");
eq(S.res.payload.diag.ok, true, "P0-0: 実データが取れたら diag.ok=true（detail 側と意味を揃える）");
ok(S.res.payload.diag.hits > 0, "P0-0: 取得件数を diag.hits に残す");

// 候補ゼロ（個人事業主など）は正常系
const S0 = await withFetch("empty", async () => {
  process.env.GBIZ_API_TOKEN = "t".repeat(40);
  return callCompany(c1, { action: "search", name: "個人事業のミライ工房" }, "10.0.0.11");
});
eq(S0.res.code, 200, "P0-0: 該当なしでも 200");
eq(S0.res.payload.candidates, [], "P0-0: 候補ゼロを返す");
ok(/見つかりませんでした/.test(S0.res.payload.message), "P0-0: 「見つからなかった」ことを正直に伝える");
ok(!S0.errs.some((l) => l.indexOf("[gbiz][FAIL]") >= 0), "P0-0: 該当なしは FAIL ログにしない（異常ではない）");
// 「正常だがデータ無し」は diag.ok=false のまま。ここを true にすると、今度は逆に
// 「データが取れた」と誤読される。search-done と search-empty を区別できることが要点。
eq(S0.res.payload.diag.step, "search-empty", "P0-0: 該当なしは step=search-empty");
eq(S0.res.payload.diag.ok, false, "P0-0: 該当なしは diag.ok=false（データは取れていない）");

// 上流 401 でも 500 を返さない
const SB = await withFetch("bad", async () => {
  process.env.GBIZ_API_TOKEN = "x".repeat(40);
  return callCompany(c1, { action: "search", name: "トヨタ自動車株式会社" }, "10.0.0.12");
});
eq(SB.res.code, 200, "P0-0: 上流 401 でも 200（UIは通常生成へ落とせる）");
ok(SB.res.payload.ok === false && SB.res.payload.error === "http-401", "P0-0: 理由を構造化して返す");
ok(SB.errs.some((l) => l.indexOf("[gbiz][FAIL]") >= 0), "P0-0: 失敗がログに残る");

// 未設定
const SN = await withFetch("ok", async () => {
  delete process.env.GBIZ_API_TOKEN;
  return callCompany(c1, { action: "search", name: "トヨタ自動車株式会社" }, "10.0.0.13");
});
eq(SN.res.code, 200, "P0-0: トークン未設定でも 200");
eq(SN.res.payload.configured, false, "P0-0: configured=false を返す");
ok(SN.warns.some((l) => l.indexOf("[company][SKIP]") >= 0), "P0-0: 未設定が警告として残る");

// 入力の検証
const SX = await withFetch("ok", async () => {
  process.env.GBIZ_API_TOKEN = "t".repeat(40);
  return callCompany(c1, { action: "search", name: "あ" }, "10.0.0.14");
});
eq(SX.res.code, 400, "P0-0: 1文字の企業名は 400（無駄な外部呼び出しをしない）");

// 詳細（生成に使う情報を、生成の前に見せる）
process.env.GBIZ_API_TOKEN = "t".repeat(40);
const DT = await withFetch("ok", async () => callCompany(c1, { action: "detail", corporateNumber: CN }, "10.0.0.15"));
eq(DT.res.code, 200, "P0-0: 詳細は 200");
ok(DT.res.payload.ok === true, "P0-0: 詳細 ok=true");
eq(DT.res.payload.matched.corporateNumber, CN, "P0-0: 選んだ法人番号の情報を返す");
ok(DT.res.payload.facts.some((f) => f.indexOf("法人名: トヨタ自動車株式会社") === 0), "P0-0: 法人名が事実に含まれる");
ok(DT.res.payload.facts.some((f) => f.indexOf("事業概要:") === 0), "P0-0: 事業概要が事実に含まれる（＝生成前に見せられる）");
ok(/出典：gBizINFO/.test(DT.res.payload.note), "P0-0: 出典を明示する");

// 法人番号の検証（パス注入の防止）
for (const bad of ["../../zzz", CN + "/patent", "12345", "abcdefghijklm", ""]) {
  calls.length = 0;
  const r = await withFetch("ok", async () => callCompany(c1, { action: "detail", corporateNumber: bad }, "10.0.0.16"));
  eq(r.res.code, 200, "P0-0: 不正な法人番号 " + JSON.stringify(bad) + " でも 500 にしない");
  eq(calls.length, 0, "P0-0: 不正な法人番号 " + JSON.stringify(bad) + " では外部に fetch しない");
  eq(r.res.payload.ok, false, "P0-0: 不正な法人番号 " + JSON.stringify(bad) + " は ok=false");
}

// GET は受け付けない
const rGet = makeRes();
await withFetch("ok", async () => {
  const oL = console.log; console.log = () => {};
  await c1({ method: "GET", headers: {}, body: null }, rGet);
  console.log = oL;
});
eq(rGet.code, 405, "P0-0: GET は 405");

// 簡易レート制限（外部APIのトークンを使い潰されないための最低限）
const rateH = await loadCompany("rate");
let last = null;
for (let i = 0; i < 61; i++) {
  const r = await withFetch("ok", async () => callCompany(rateH, { action: "search", name: "テスト株式会社" }, "10.9.9.9"));
  last = r.res.code;
}
eq(last, 429, "P0-0: 同一IPからの連打は 429 で止まる（60回/時）");

/* ================= 2. P0-0 フロント側 ================= */
ok(/CareerAI\.company\.attach\("gen-form"\)/.test(index), "P0-0: index.html が企業確認UIを取り付けている");
ok(/var CompanyConfirm = \(function \(\)/.test(eng), "P0-0: engine.js に CompanyConfirm がある");
ok(/unconfirmed/.test(eng) && /st\.status = "searching"/.test(eng), "P0-0: 未確認/検索中を状態として持つ");
ok(/isResolved: function \(\) \{ return st\.status === "confirmed" \|\| st\.status === "declined" \|\| st\.status === "fallback"; \}/.test(eng),
  "P0-0: 「確認済み／該当なし／データベース不可」の3通りで解決扱い（行き止まりを作らない）");
ok(/radio\.name = "company-choice"/.test(eng), "P0-0: 候補は radio で1社を選ばせる");
ok(/payload\.gbiz = ccPayload/.test(eng), "P0-0: 確認結果（法人番号）を生成リクエストに載せる");
// 2026-09-22 改: 候補カードはフォーム内に出さず、「生成する」押下時にモーダルで選ばせ、
// 選んだら同じ生成を自動続行する（押し直させない）。旧「確認を促して止める」方式は廃止。
ok(/await cc\.ensure\(\)/.test(eng) && /company-modal/.test(eng) && !/企業名の候補を確認してください/.test(eng),
  "P0-0: 未確認なら生成押下時にモーダルで確認する（旧フォーム内候補＋押し直し方式は廃止）");
ok(!/maybeSearch/.test(eng) && !/blur", function \(\) \{ maybeSearch/.test(eng),
  "P0-0: 入力欄 blur の自動検索は廃止（入力中に候補カードが出ない。P0-2 ヒントの blur は別物）");
ok(/同じ生成を自動で続行させる/.test(eng) && /st\.onResolve/.test(eng),
  "P0-0: モーダルで選んだ後は同じ生成を自動続行する（押し直させない）");
// 確認・放弃後に主状態条が古い「候補を確認してください」のまま残らないこと（2026-09-22 実測の残像バグ）
ok((eng.match(/setStatus\("法人を確認しました。/g) || []).length >= 2 && /setStatus\("企業情報を使わずに生成します。/.test(eng),
  "P0-0: 確認成功・取得失敗・リストに無い、の3経路で状態条を更新する（残像を残さない）");
// 名前を書き換えたら確認を無効化（別会社の法人番号で生成する事故を防ぐ）
ok(/input\.addEventListener\("input", function \(\) \{[\s\S]{0,220}?reset\(st\)/.test(eng),
  "P0-0: 企業名を書き換えると確認が無効になる");
// 生成に使う情報を生成前に見せる（赤線#3）
ok(/生成に使う登録情報を見る/.test(eng), "P0-0: 生成前に「使う情報」を確認できる");
ok(/company-facts/.test(css), "P0-0: 確認情報の折りたたみが CSS にある");
for (const p of ["jiko-pr.html", "rirekisho.html", "shokumu.html", "mensetsu.html"]) {
  const html = read(p);
  ok(!/structured:\s*true/.test(html), p + " は旧契約のまま（gBizINFO を使わない＝取り違えの経路が無い）");
  ok(!/CareerAI\.company\.attach/.test(html), p + " には企業確認UIを付けない（使わないものを確認させない）");
}

/* ================= 3. P0-1 H1 と Title ================= */
const h1 = (index.match(/<h1[^>]*>([\s\S]*?)<\/h1>/) || [])[1] || "";
const h1text = h1.replace(/<br\s*\/?>/g, "").replace(/\s+/g, " ").trim();
ok(/^志望動機 AI/.test(h1text), "P0-1: H1 が「志望動機 AI」で始まる（実測 " + JSON.stringify(h1text.slice(0, 24)) + "）");
ok(h1text.indexOf("志望動機 AI") >= 0, "P0-1: H1 に「志望動機 AI」が連続した語として入っている");
ok(h1text.indexOf("経歴は捏造しません") >= 0, "P0-1: H1 で不捏造を宣言している");
ok(h1text.indexOf("就活AI") < 0, "P0-1: H1 にブランド名（就活AI）を入れない（キーワードに場所を譲る）");
const title = (index.match(/<title>([^<]*)<\/title>/) || [])[1] || "";
ok(/^志望動機 AI｜/.test(title), "P0-1: Title の先頭がキーワード（志望動詞 AI）");
ok(/ - 就活AI$/.test(title), "P0-1: Title の末尾がブランド名（就活AI）");
const ogt = (index.match(/<meta property="og:title" content="([^"]*)"/) || [])[1] || "";
eq(ogt, title, "P0-1: og:title が <title> と一致する");
const desc = (index.match(/<meta name="description" content="([^"]*)"/) || [])[1] || "";
ok(/^志望動機 AI/.test(desc), "P0-1: description もキーワードから始まる");
ok(desc.length <= 120, "P0-1: description が 120 文字以内（実測 " + desc.length + "）");
ok(/og:description" content="([^"]*)"/.test(index) &&
  (index.match(/og:description" content="([^"]*)"/) || [])[1] === desc, "P0-1: og:description が description と一致する");

// バッジの順序（登録不要 ・ すぐ使える ・ 完全無料）
const badges = [...(index.match(/<div class="badges">([\s\S]*?)<\/div>/) || [, ""])[1].matchAll(/<span class="badge">([^<]+)<\/span>/g)]
  .map((m) => m[1]);
eq(badges, ["登録不要", "すぐ使える", "完全無料"], "P0-1: バッジが指定どおりの3つ・指定どおりの順");

// 他ツールページもキーワード先頭（一頁一詞）
for (const [p, kw] of [["jiko-pr.html", "自己PR AI"], ["rirekisho.html", "履歴書 AI"],
  ["shokumu.html", "職務経歴書 AI"], ["mensetsu.html", "面接対策 AI"]]) {
  const t = (read(p).match(/<h1[^>]*>([\s\S]*?)<\/h1>/) || [])[1] || "";
  ok(t.replace(/<br\s*\/?>/g, "").replace(/\s+/g, " ").trim().indexOf(kw) === 0,
    "P0-1: " + p + " の H1 が「" + kw + "」で始まる");
}

/* ================= 4. P0-1 半升级の文案（言い過ぎていない） ================= */
ok(!/そのまま提出/.test(index) && !/そのまま出せ/.test(index),
  "P0-1: 「そのまま提出できる」と断定していない（同名別法人の解が入るまで半升级に留める）");
ok(!/企業研究済み|企業研究も完了/.test(index), "P0-8: 「企業研究済み」と断定していない");
// 2026-09-22 ユーザー指示: hero の副文は省スペースのため削除。meta description（2箇所）には残す（SEO）。
eq((index.match(/登録情報を確認して反映/g) || []).length, 2, "P0-8: meta description の2箇所は「登録情報を確認して反映」を維持（hero 副文は削除済み・復活禁止）");
eq((index.match(/候補が表示される場合があります（該当する法人がない場合は表示されません）/g) || []).length, 3, "P0-8: FAQ/JSON-LD/手引きの3箇所とも候補は条件付き（404 実測と整合）");
ok(!/の候補が表示されます。/.test(index), "P0-8: 旧「候補が表示されます」（入力必ず候補が出る暗示）の退行を禁止");
ok(/候補が出ることがあり（該当する法人がない場合は出ません）/.test(index), "P0-8: 企業名ヒントも候補が出ない場合がある旨を明記");
ok(!/進学/.test(index), "P0-8: 進学シーン廃止後の残留なし（手引き/FAQ/JSON-LD 含む）");
// SCENE_GUIDE（モデル注入）↔ 手引き「書き分け」（ユーザー向け）の軸心が一致すること。
// 一致しないと「ページの軸心で文章を確認したのに AI 出力に無い」という紅線が再発する。
ok(/"新卒":\s*"[^"]*学生時代の経験/.test(gen), "P0-8: SCENE_GUIDE 新卒＝手引き「学生時代の経験→仕事への接続」");
ok(/"転職":\s*"[^"]*前職の実績/.test(gen) && /"転職":\s*"[^"]*即戦力/.test(gen), "P0-8: SCENE_GUIDE 転職＝手引き「前職の実績→即戦力」");
ok(/"バイト":\s*"[^"]*シフト/.test(gen) && /"バイト":\s*"[^"]*熱意/.test(gen) && !/勤務を続ける意思/.test(gen), "P0-8: SCENE_GUIDE バイト＝手引き「シフト柔軟性＋熱意」（旧「勤務継続の意思」の退行を禁止）");
ok(/新卒は「学生時代の経験→仕事への接続」、転職は「前職の実績→即戦力」、バイトは「シフト柔軟性＋熱意」/.test(index), "P0-8: 手引き「書き分け」の3軸心がページに存在（SCENE_GUIDE の対照物）");
ok(/情報が足りない箇所は【 】のまま残します/.test(index), "P0-1: 半升级の検証可能な表現が残っている");

/* ================= 5. P0-2 フォーム減負 ================= */
// 2026-09-22 ユーザー指示: 詳細設定はフォーム下部の折りたたみから、応募種別の直後へ移動し
// 初期展開（open）。通る途中で文字数・トーンを「順に」選べるようにする。
ok(/<details class="adv"[^>]*\bopen\b>/.test(index), "P0-2: 詳細設定は初期展開（open）で見えている");
ok(index.indexOf('<details class="adv"') >= 0 && index.indexOf('<details class="adv"') < index.indexOf('data-field="職種"'),
  "P0-2: 詳細設定は必須入力（応募職種・企業名）より上に置く（順路の途中で選べる）");
const advBlock = (index.match(/<details class="adv"[^>]*>([\s\S]*?)<\/details>/) || [, ""])[1];
ok(/data-field="文字数"/.test(advBlock) && /data-field="トーン"/.test(advBlock),
  "P0-2: 折りたたみの中に文字数とトーンが入っている");
ok(/aria-pressed="true"/.test(advBlock), "P0-2: 折りたたんでも初期値が選ばれている（既定のまま送れる）");
eq((index.match(/data-field="応募種別"/g) || []).length, 3, "P0-2: 応募種別は3種（新卒・転職・バイト、進学は廃止）");
ok(/\.adv summary \{[\s\S]{0,200}?min-height: 2\.5rem/.test(css), "P0-2: 折りたたみの見出しもタップ領域を確保");
// 動的プレースホルダ
ok(/var SCENE_PLACEHOLDERS = \{/.test(eng), "P0-2: 応募種別ごとのプレースホルダ表がある");
for (const s of ["新卒", "転職", "バイト"]) ok(eng.indexOf('"' + s + '": {') >= 0, "P0-2: " + s + " 用の文言がある");
ok(/function bindDynamicPlaceholders/.test(eng) && /applyScenePlaceholders\(form, c\.getAttribute\("data-value"\)\)/.test(eng),
  "P0-2: 応募種別の切替でプレースホルダが変わる");
ok(/hint-tags/.test(eng) && /【" \+ t \+ "】/.test(eng), "P0-2: 書くヒントのタグが【 】を挿入する");
ok(/数字や事実はご自身で入力してください/.test(eng), "P0-2: タグは事実を作らないと明記（捏造しない）");
ok(/gentleHintShown/.test(eng) && /経験を入れると、あなた固有の文章になります/.test(eng),
  "P0-2: 空欄の指摘ではなく「入れると何が変わるか」を1回だけ伝える");

// P0-2（中小強誘導）：3 推奨フィールド。減負の手段（タグ/例/折りたたみ）で「より埋める」を促す。
ok(/class="form-lead">入力が多いほど/.test(index), "P0-2: フォーム上部に価値提案バナー（入力量＝完成度）");
ok(/<details class="rec-group">/.test(index) && /rec-group-lead/.test(index) && /<summary>推奨：さらに具体的にする 3 項目/.test(index),
  "P0-2: 推奨フィールドを折りたたみ（details+summary）の強誘導グループで囲っている");
// 3 フィールドが data-field 付きで存在し、例プレースホルダ付き
ok(/data-field="事業内容"[^>]*placeholder="例：保育園向けに給食食材の配送を行っている"/.test(index),
  "P0-2: ①事業内容フィールド（例プレースホルダ付き）");
ok(/data-field="共感した点"[^>]*placeholder="例：大学で栄養学を学び、子どもの食に関わりたいと思った"/.test(index),
  "P0-2: ②共感した点フィールド（例プレースホルダ付き）");
ok(/data-field="入社後にやりたいこと"[^>]*placeholder="例：まずは配送ルートの改善から取り組みたい"/.test(index),
  "P0-2: ③入社後にやりたいことフィールド（例プレースホルダ付き）");
// 推奨マーク（必須の赤系 hint と別）
const recCount = (index.match(/class="mark rec">推奨<\/span>/g) || []).length;
eq(recCount, 3, "P0-2: 3 フィールドすべてに「推奨」マーク（必須ではない）");
// 主観素材フィールドには信任アンカー（AIは代筆しません）を同梱
ok(/data-field="共感した点"[\s\S]{0,260}?AIは代筆しません/.test(index),
  "P0-2: 共感フィールドに「AIは代筆しません」を明記（P0-3 信任アンカーと一致）");
ok(/data-field="入社後にやりたいこと"[\s\S]{0,260}?AIは代筆しません/.test(index),
  "P0-2: 入社後フィールドに「AIは代筆しません」を明記");
// 推奨なので required に入れない（強制必須にすると埋められない中小層が離脱）
ok(/required:\s*\[[^\]]*\]/.test(index) && !/required:\s*\[[^\]]*事業内容/.test(index) && !/required:\s*\[[^\]]*共感した点/.test(index),
  "P0-2: 3 推奨フィールドは required に入っていない（推奨＝任意）");
// 生成へ渡す（system / buildUser に含まれる）
ok(/事業内容・共感した点・入社後にやりたいこと/.test(index), "P0-2: system プロンプトに 3 フィールドを含む");
ok(/事業内容: " \+ \(v\["事業内容"\]/.test(index) && /共感した点: " \+ \(v\["共感した点"\]/.test(index) && /入社後にやりたいこと: " \+ \(v\["入社後にやりたいこと"\]/.test(index),
  "P0-2: legacy 契約用の buildUser も 3 フィールドを含む（structured 経路では未使用）");
// 🔴 実機（2026-09-22）で発覚：structured:true の送信は {tool, fields} で、プロンプトを組むのは
// サーバの buildPrompt() だけ。index.html の system/buildUser は structured では使われない。
// ここを直し忘れると「ブラウザは送っているのに出力に一切反映されない」＝静かに壊れる。
ok(/f\["事業内容"\]/.test(gen) && /f\["共感した点"\]/.test(gen) && /f\["入社後にやりたいこと"\]/.test(gen),
  "P0-2: buildPrompt() が 3 フィールドをプロンプトに載せる（送ったのに効かない事故の再発防止）");
ok(/「企業情報」または「事業内容」に明記されている場合のみ/.test(gen),
  "P0-2: 不捏造ルール#1 は利用者入力の「事業内容」も事実ソースとして許可");
ok(/本人の言葉として本文に組み込み/.test(gen) && /入力が無い場合にだけ、その穴を【 】で残す/.test(gen),
  "P0-2: 共感/入社後は入力があれば穴を残さない・無ければ残す（赤線#1 と整合）");
ok(/const empath = \(f\["共感した点"\] \|\| ""\)\.trim\(\)/.test(gen),
  "P0-2: デモ出力も入力を反映（本番と同じ約束を崩さない）");
// 保持の仕組み：collect() は data-field を動的走査するため、新フィールドは自動で保持される
// （書き込み済みのホワイトリスト列挙＝「企業名＋経験」だけ残す実装は存在しないこと）
ok(/querySelectorAll\("\[data-field\]"\)/.test(eng), "P0-2: collect() は data-field を動的走査（新フィールドは自動保持・ハードコード列挙なし）");
ok(!/(PRESERVE_FIELDS|KEEP_FIELDS|SAVE_FIELDS|ALLOWED_FIELDS)\s*=/.test(eng),
  "P0-2: 書き込み済みの保持列挙定数なし（未ログイン→生成→ログインでも全フィールド維持）");

/* ===== 5b. P0-5 生成のログイン（匿名枠を使い切った「その瞬間」だけログインを促す） ===== */
// 匿名でも既定 2 回/日は生成できる。門は「上限に達した」応答でのみ開く ——
// 毎回の生成で弾くと匿名枠が架空になり（1 回も使えない）、新規サイトは行動データも
// 貯まらず、価値を見る前の登録要求で離脱する。上限判定はサーバが唯一の正。
const engFetchIdx = eng.indexOf('await fetch("/api/generate"');
const engPendingIdx = eng.indexOf("pendingGenerate = { formId: formId, resultId: resultId, config: config }");
ok(engFetchIdx > 0 && engPendingIdx > engFetchIdx,
  "P0-5: ログインの門は生成リクエストの前ではなく「上限到達(429)の後」にだけ開く（匿名枠を架空にしない）");
ok(/res\.status === 429 && data\.limitReached/.test(eng) || /res\.status === 429 && data && data\.limitReached/.test(eng),
  "P0-5: 門を開く条件はサーバの 429/limitReached（クライアント側で回数を数え直さない）");
ok(/pendingGenerate\s*=\s*\{\s*formId: formId, resultId: resultId, config: config\s*\}/.test(eng),
  "P0-5: 上限到達時に生成条件を保留し、ログイン後に自動再開できるようにする");
ok(/Auth\.openModal\(\)/.test(eng) && /function resumePendingGenerate\(\)/.test(eng),
  "P0-5: 上限到達時にログインを求め、完了後に同じ生成を再開する（もう一度押させない）");
ok(/Auth\.onChange\(resumePendingGenerate\)/.test(eng),
  "P0-5: 再開フックが実際に配線されている");
ok(/var onAuthChange = null;/.test(eng) && /onChange: function \(fn\)/.test(eng),
  "P0-5: onAuthChange を宣言して setter 経由で渡す（未宣言の自由変数を typeof で呼ぶ実装を残さない）");
// 認証ストアが落ちているときに門を作ると、劣化ではなく「全員生成不能」になる。
ok(/Auth\.limits\(\)\.configured && !Auth\.isLoggedIn\(\)/.test(eng),
  "P0-5: ストア未設定/障害時は門を作らない（匿名の上限に降格して生成を通す）");
ok(/generate_login_required/.test(eng), "P0-5: ログイン要求地点を計測（ファネルの分母）");
// 文案：実装と矛盾しないこと。匿名で使える回数とログイン後の回数を必ず両方出す。
// 上限到達時の文案は「もう生成できない」という事実を述べる形にする（残り0回を
// 「できます」で結ぶと、できる/できないが文面上で矛盾する＝赤線）。
ok(/function loginOfferText\(\) \{\s*const lim = \(Auth && Auth\.limits && Auth\.limits\(\)\) \|\| \{\};\s*const a = lim\.anon \|\| 2, l = lim\.logged \|\| 5;/.test(eng),
  "P0-5: 上限到達文案の回数は実装値（Auth.limits()）から取る（数字を手書きすると上限変更で文言だけ古くなる）");
ok(eng.indexOf('本日のログインなしでの生成は上限（" + a + "回）に達しました。ログインすると入力内容はそのまま引き継がれ、1日" + l + "回まで生成できます。') >= 0,
  "P0-5: 上限到達時は「上限（◯回）に達しました」＋引き継ぎ＋ログイン後の上限を出す");
ok(eng.indexOf('あと" + remaining + "回、ログインなしで生成できます') < 0,
  "P0-5: 「あと0回、ログインなしで生成できます」という矛盾した文言を残さない");
ok(eng.indexOf('入力も生成も、まずは" + a + "回までログインなしで試せます') >= 0,
  "P0-5: 配额行は「入力も生成も、まずは◯回までログインなしで試せます」");
ok(index.indexOf("入力も生成も、まずは2回までログインなしで試せます") >= 0,
  "P0-5: index.html の静的文案も同じ約束（JS 無効でも矛盾しない）");
ok(eng.indexOf("入力内容はそのまま引き継がれ") >= 0,
  "P0-5: 入力保持の約束を文言に残す（実測で確認済みの主張）");
ok(!/生成にはログインが必要/.test(index + eng),
  "P0-5: 「生成にはログインが必要」という旧文言が残っていない（匿名2回の実装と矛盾するため）");
ok(!/ログイン不要/.test(index),
  "P0-5: index.html に「ログイン不要」を残さない（匿名枠の説明は回数つきで行う）");
// 自動再開は能動検証しづらい（登録にメール認証が要る）。GA4 イベントと console の両方に残し、
// 実利用者のデータで発火を確認できるようにする —— 静かに通させない。
ok(/track\("generate_resumed_after_login"/.test(eng) && /console\.info\("\[P0-5\] ログイン後に保留生成を自動再開/.test(eng),
  "P0-5: 自動再開を GA4＋console の両方で可観測にする（黙って续がせない）");
// remaining=0 の表示は「あと0回」ではなく事実を述べる（直前の上限到達文案と同じ UI で矛盾させない）
ok(/data\.remaining === 0 \? "（本日の上限に達しました）" : "（本日あと " \+ data\.remaining \+ " 回）"/.test(eng),
  "P0-5: remaining=0 は「本日の上限に達しました」と出す（「あと0回」は上限到達文案と食い違う）");

/* ================= 6. P0-3 【 】の短ラベル化と去歧義 ================= */
ok(/中身は短いラベルだけ（10〜14文字以内）/.test(gen), "P0-3: 【 】の中身を10〜14文字の短いラベルに限定");
ok(/【事業内容への共感】【入社後に携わりたい業務】【志望の理由】/.test(gen), "P0-3: 良い例を示している");
ok(/【ここにあなたの経験を入力：例：/.test(gen), "P0-3: 悪い例（60字超の指示文）も明示して排除");
ok(/1つの【 】に複数の指示を詰め込まない/.test(gen), "P0-3: 1つの穴に複数指示を入れさせない");
for (const lbl of ["【経験の場面】", "【成果の数字】", "【学び】"]) {
  ok(gen.indexOf(lbl) >= 0, "P0-3: 短ラベルの語彙 " + lbl + " を提示している");
}
// デモ（mock）にも長い指示文を残さない
// ルール本文には「悪い例」として長い【 】を意図的に載せているので、そこは除外して数える
const genMockPart = gen.replace(/const NO_FABRICATION_RULES =[\s\S]*?`;/, "");
const longPh = [...genMockPart.matchAll(/【[^】]{30,}】/g)].map((m) => m[0]);
eq(longPh, [], "P0-3: generate.js に 30 文字超の【 】が残っていない（短ラベル化）");
// 去歧義：見出しと免責の【 】はクリック対象にしない
ok(/var SECTION_LABELS = \{/.test(eng), "P0-3: 見出しラベルの一覧を持つ");
for (const s of ["学歴", "職歴", "志望動機", "自己PR", "自分の強み", "エピソード", "よく聞かれる質問と回答の構成"]) {
  ok(eng.indexOf('"' + s + '": 1') >= 0, "P0-3: 見出し「" + s + "」を穴埋め対象から除外");
}
ok(/if \(!s\) return false;/.test(eng), "P0-3: 中身が空の【 】（免責文）は穴埋め対象にしない");
ok(/data-ph="1"/.test(eng), "P0-3: 穴埋め対象だけに目印を付ける");
ok(/t\.closest \? t\.closest\("mark\.ph\[data-ph\]"\)/.test(eng), "P0-3: 本文のクリックで穴埋めを開く");
ok(/phModal\.className = "auth-modal ph-modal"/.test(eng), "P0-3: モーダルは .auth-modal の CSS を再利用");
ok(/【" \+ label \+ "】を埋める/.test(eng), "P0-3: どの穴を埋めているかをタイトルに出す");
ok(/【 】のままになっています。具体的な内容を入力してください/.test(eng),
  "P0-3: 【 】のままの入力を弾く（穴を穴で埋めさせない）");
ok(/data-fill-ph/.test(eng) && /【 】を埋める（" \+ n \+ "）/.test(eng), "P0-3: 残りの穴数を出して埋める導線がある");
// 埋めたあとは素のテキストに戻す（強調が残って印刷/コピーに混ざらない）
ok(/createTextNode\(value\)/.test(eng) && /replaceChild\(text, phTarget\)/.test(eng),
  "P0-3: 反映後は mark を外して素のテキストにする（印刷・コピーに装飾が残らない）");
ok(/mark\.ph \{\n  background: color-mix/.test(css), "P0-3: 穴埋めの強調表示は従来どおり");
// 【 】は「主観的動機」と「客観的事実」の2種に分け、埋め方の導線を変える（赤線#1の正しい執行）。
// 主観（共感・志望・やりたい）は空のままが正解 → AIは代筆せず、型だけ出す。
// 客観（事業内容・経験・スキル）は入力した事実を書く → 具体的な例を出す。
ok(/function holeCategory\(/.test(eng), "P0-3: 【 】を主観/客観の2類に分類する");
ok(/ph-kind-subj/.test(eng) && /ph-kind-obj/.test(eng), "P0-3: 主観・客観で異なる案内バッジを出す");
ok(/AIは代筆しません/.test(eng), "P0-3: 主観（動機）は『AIは代筆しません』と明示（捏造共感を防ぐ）");
ok(/貴社の◯◯という取り組みに、△△という点で共感しました/.test(eng), "P0-3: 主観には感情表現の型（フレーム）を出す");
ok(/木造住宅の設計・施工/.test(eng), "P0-3: 客観には具体的事実の例（抽象形容ではなく）を出す");
ok(/var PH_GUIDE_TRIM_AFTER = 5/.test(eng) && /phOpenCount\+\+/.test(eng),
  "P0-3: 頻出時に説明を省略する頻控を持つ（書き込みの流れを邪魔しない）");
// 同一文に穴が2つ以上（prompt を3ラウンド改めても逐字で再出現した形）への層変え対応。
// prompt ではなく**サーバ側の確定判定**で数を返し、UI は軽く一言だけ添える。
ok(/function countMultiHoleSentences\(/.test(gen), "P0-3: 同一文の複数穴をサーバ側で確定判定する");
ok(/multiHoleSentences: multiHole|multiHoleSentences: multiHoleLegacy/.test(gen),
  "P0-3: 旧契約・新契約の**両方**のレスポンスに件数を載せる（片方だけだと4ページで見えない）");
ok(/\[gen\]\[multi-hole\]/.test(gen), "P0-3: 殘留を必ずログに殘す（消せないものは、せめて數える）");
ok(/multi_holes: data\.multiHoleSentences \|\| 0/.test(eng), "P0-3: 計測にも件数を載せる（改善したかを後から見られる）");
ok(/同じ文に【 】が2つ以上ある箇所が " \+ mh \+ " 件あります/.test(eng), "P0-3: 利用者に軽く一言添える");
ok(/\(mh > 0 && phLeft > 0\)/.test(eng),
  "P0-3: 穴が殘っていないときは出さない（「同じ文に2つ」と言う意味が無くなるため）");
// notice には入れない（捏造ではなく読みやすさの問題なので、利用者を驚かせない）
ok(!/truncated\)[^\n]*multiHoleSentences/.test(gen), "P0-3: notice ではなく別フィールドで返す（驚かせない）");

/* ================= 6.5 P0-0 企業確認 UI（赤線 #3） ================= */
// 生成の「前に」企業を特定させる。同名の別法人が実在するため、法人名の自動一致で1社に
// 決め打ちすると「事実だが別会社の情報」が混ざる（実測：架空の「株式会社ミライテック」が
// 沖縄の実在同名法人に命中）。生成後ではなく生成前に見せて選ばせるのが唯一の確実な対策。
ok(/function renderCandidates\(/.test(eng) && /type = "radio"/.test(eng),
  "P0-0: 候補は手動選択の radio で出す");
ok(!/\.checked\s*=\s*true/.test(eng),
  "P0-0: 候補を自動選択しない（checked=true は無い → 冲縄の同名法人もデフォルト選択されない）");
ok(/radio\.addEventListener\("change"/.test(eng),
  "P0-0: 選択は利用者の change 操作で確定する（confirmCandidate を呼ぶ）");
ok(/action: "search"/.test(eng) && /action: "detail"/.test(eng),
  "P0-0: 企業名で gBizINFO 検索し、選択後に詳細を取得して生成に使う");
ok(/入力された企業名と企業情報だけで生成します/.test(eng),
  "P0-0: 候補が無いときは入力情報のみで生成（自動補完・捏造しない）");
ok(/法人番号は一意の識別子です/.test(eng),
  "P0-0: 候補リストに「法人番号＝一意識別子」の補足を出す（本店所在地≠勤務地の誤選択を防ぐ）");
ok(/MAX_CANDIDATES = 20/.test(comp),
  "P0-0: 候補上限を20件にして、同名の別所在地法人（沖縄等）がリストから切れないようにする");

/* ================= 7. P0-4 全文コピー ================= */
ok(/data-copy-all/.test(eng), "P0-4: 全文コピーのボタンを生成する");
ok(/async function copyAll\(/.test(eng) && /navigator\.clipboard\.writeText/.test(eng), "P0-4: Clipboard API を使う");
ok(/document\.execCommand\("copy"\)/.test(eng), "P0-4: 失敗時に execCommand へフォールバック (HTTP/旧ブラウザ)");
ok(/track\("copy_all", \{ chars: countChars\(text\) \}\)/.test(eng), "P0-4: コピーを計測（転換点）");
ok(/btn\.textContent = "コピーしました"/.test(eng), "P0-4: 押した手応えを返す");
ok(/tb\.insertBefore\(b, tb\.firstChild\)/.test(eng), "P0-4: コピーはツールバーの先頭（主導線上）");
ok(/応募フォームや履歴書に貼り付けられます/.test(eng), "P0-4: 使い道を書く（ただし「提出できる」とは断定しない）");

/* ================= 8. P0-6 字数 ================= */
ok(/function countChars\(text\)/.test(eng), "P0-6: 文字数を自前で数える");
ok(/Intl\.Segmenter\("ja", \{ granularity: "grapheme" \}\)/.test(eng), "P0-6: Intl.Segmenter で書記素を数える");
ok(/return Array\.from\(t\)\.length;/.test(eng), "P0-6: 非対応ブラウザは Array.from にフォールバック");
ok(/replace\(\/\[\\n\\r\]\/g, ""\)/.test(eng), "P0-6: 改行は数えない（目安と比較できるように）");
ok(/function parseRange\(v\)/.test(eng) && /目安 " \+ range\.min \+ "〜" \+ range\.max/.test(eng), "P0-6: 目安の範囲を表示する");
ok(/result\.addEventListener\("input", refreshDoc\)/.test(eng), "P0-6: 編集のたびに数え直す");
// モデルの自己申告は先に落とす（カウンタと食い違わせない）
ok(/function stripSelfReport\(text\)/.test(gen), "P0-6: サーバ側でモデルの自己申告を除去する");
ok(/文字数\|字数\)?\\s\*\[：:\]/.test(gen) || /文字数\|字数/.test(gen), "P0-6: 「文字数：698字」型を対象にしている");
ok(/strippedSelfReport: cleaned\.stripped/.test(gen), "P0-6: 除去したかどうかをレスポンスに載せる（観測できる）");
ok(/MAX_TOKENS = 3000/.test(gen), "P0-6: 上限を 3000 に上げた（「長め」で文が切れないように）");
ok(/finish_reason/.test(gen) && /truncated: truncated/.test(gen), "P0-6: 上限で切れたかを返す");
ok(/文が途中で切れた可能性があります/.test(eng), "P0-6: 切れている可能性を UI で伝える");
ok(/\.doc-count \{/.test(css), "P0-6: 文字数表示のスタイルがある");

/* ================= 9. P0-7 モバイル ================= */
ok(/function syncViewportHeight\(\)/.test(eng) && /window\.visualViewport/.test(eng), "P0-7: visualViewport に追従する");
ok(/--vvh/.test(eng) && /--vvh/.test(css), "P0-7: キーボード表示時の高さを CSS 変数で渡す");
ok(/body\.edit-full \.doc \{[\s\S]{0,120}?position: fixed/.test(css), "P0-7: 編集は全画面に切り替えられる");
ok(/height: var\(--vvh, 100vh\)/.test(css), "P0-7: 全画面の高さがビューポートに追従");
ok(/data-edit-done/.test(eng) && /編集を終える/.test(eng), "P0-7: 全画面から戻るボタンがある（抜け道を確保）");
ok(/result\.addEventListener\("focusin", function \(\) \{ if \(isNarrow\(\)\) enterEditFull\(\); \}\)/.test(eng),
  "P0-7: 狭い画面では編集開始時に全画面へ");
ok(/\.btn\.mini \{ min-height: 2\.75rem; \}/.test(css), "P0-7: 小さいボタンも 44px 相当に拡大（モバイル）");
ok(/#gen-btn \{ position: sticky; bottom: 0\.5rem/.test(css), "P0-7: 生成ボタンが常に指の届く位置に残る");
ok(/body\.edit-full \.doc \{\s*position: static;/.test(css), "P0-7: 全画面のまま印刷しても崩れない");
// [hidden] が作者CSSに負けないこと（過去に踏んだ罠）
ok(/\[data-fill-ph\]\[hidden\], \.edit-done\[hidden\] \{ display: none; \}/.test(css),
  "[hidden] が display 指定に負けないよう明示している");

// --- P0-7（全面自查・2026-09-22）: 実測で見つかった 5 件のモバイル欠陥を固定する ---
// ナビ: 320px の実測で .nav-inner が折り返さず、リンク列が 113px に潰れて 5 件が縦積み
// （ヘッダー 236px ＝ 画面の 42%）。「ログイン」は 23px 幅で縦割れ、副題は 1 文字ずつ折返し。
ok(css.indexOf(".nav-inner { flex-wrap: wrap; gap: 0 0.5rem; padding-block: 0.25rem; }") >= 0,
  "P0-7: モバイルではナビを折り返す（リンク列を潰して縦積みにしない）");
// 1 段で収めるには約 920px 必要。切断を 56rem にすると 900px でもリンクが箱の中で
// 折り返して 2 行になり文字が切れる（実測）。よって切断は 60rem。
ok(/@media \(max-width: 60rem\) \{\s*\.nav-inner \{ flex-wrap: wrap;/.test(css),
  "P0-7: ナビの 2 段化は 60rem から（1 段で収まる約 920px 未満で折返しを止める）");
ok(css.indexOf("flex-wrap: nowrap; overflow-x: auto; overscroll-behavior-x: contain;") >= 0,
  "P0-7: リンク行は横スクロールの 1 行に固定（折り返してヘッダーを高くしない）");
ok(css.indexOf("order: 3; flex: 1 1 100%; margin-left: 0;") >= 0,
  "P0-7: リンク行を全幅の 2 段目に置く（ブランド／ログインと同居させない）");
ok(css.indexOf(".brand small { display: none; }") >= 0,
  "P0-7: モバイルでは副題を出さない（HTML には残るので SEO 上の消失はない）");
ok(css.indexOf(".auth-area { flex: 0 0 auto; min-width: 0; }") >= 0,
  "P0-7: モバイルのログインボタンを潰さない（実測 23px 幅の縦割れを防ぐ）");
// モーダル: align-items:center ＋ スクロール不可だと、スマホのキーボード表示時に上下が切れて詰む
ok(css.indexOf("height: var(--vvh, 100vh); overflow-y: auto") >= 0,
  "P0-7: モーダルは可視領域(--vvh)に追従してスクロールできる（キーボードで送信ボタンが隠れない）");
ok(css.indexOf("color: var(--ink); margin: auto;") >= 0,
  "P0-7: center + overflow で上端が切れる挙動を margin:auto で回避");
ok(css.indexOf(".auth-x { width: 2.75rem; height: 2.75rem;") >= 0,
  "P0-7: 閉じる「×」の当たり判定を 44px に（実測 36×26px）");
// 触控目標: 実測 36px / 28px で 44px に届いていなかった
ok(css.indexOf(".hint-tag { min-height: 2.75rem;") >= 0 && css.indexOf(".hint-tag { min-height: 2.25rem") < 0,
  "P0-7: ヒントタグを 44px に（実測 36px・従来の 2.25rem を排除）");
ok(css.indexOf(".faq summary { padding-block: 0.5rem; }") >= 0,
  "P0-7: FAQ の開閉も 44px の当たり判定に（実測 28px）");
// iOS は 16px 未満の入力欄にフォーカスすると自動ズームする（＝送信ボタンが画面外へ出る）
ok(css.indexOf(".auth-form input { font-size: 1rem; }") >= 0,
  "P0-7: モバイルの入力欄は 16px 以上（実測 13.6px は iOS の自動ズームを招く）");
// 候補リスト: 小さい端末では 14rem でも画面の 4 割近い
ok(css.indexOf("@media (max-width: 30rem) {") >= 0 && css.indexOf(".company-list { max-height: 12rem; }") >= 0,
  "P0-7: 320〜480px では候補リストを 12rem に（14rem は画面の 39%）");
ok(css.indexOf(".company-list { max-height: 20rem;") < css.indexOf(".company-list { max-height: 14rem; }") &&
   css.indexOf(".company-list { max-height: 14rem; }") < css.indexOf(".company-list { max-height: 12rem; }"),
  "P0-7: 候補リストの上限は 20rem → 14rem → 12rem の順に効く（カスケード順が逆だと上書きが崩れる）");
// 企業候補カードは label なので「.field label」が命中すると display:block に負けて枠が崩れる（2026-09-22 実測事故）。
ok(/\.field > label \{/.test(css) && !/\.field label \{/.test(css) && /label\.company-item \{[^}]*display: flex/.test(css),
  "P0-8: 企業候補カードの flex は .field label のブロック化に負けない（.field > label + label.company-item の二重防御）");

/* ================= 10. P0-8 信任と出典 ================= */
ok(/企業情報の扱いと、捏造しない仕組み/.test(index), "P0-8: 信任セクションがある");
ok(!/gBizINFO/i.test(index), "P0-8: 首页は gBizINFO に言及しない（データソース名の秘匿・競合模倣対策。出典は確認モーダル側で表示）");
ok(/出典：gBizINFO/.test(eng), "P0-8: 出典（gBizINFO）は確認モーダル側で明示（engine.js・全頁共通）");
ok(/法人データベース/.test(index) && /法人単位の登録情報です/.test(index), "P0-8: データの出所を具体的に書く（名前を出さず「法人データベース」として）");
ok(/足りない情報は空欄で残します/.test(index), "P0-8: 不捏造の仕組みを説明している");
ok(/企業情報はどこから取得しますか？/.test(index), "P0-8: 企業情報の入手方法を FAQ にも書く");
const faqLd = JSON.parse((index.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/) || [, "{}"])[1]);
const faqQ = (faqLd.mainEntity || []).map((x) => x.name);
ok(faqQ.indexOf("企業情報はどこから取得しますか？") >= 0, "P0-8: FAQ 構造化データにも同じ質問がある");
ok(faqQ.length === 5, "P0-8: FAQ は 5 問（実測 " + faqQ.length + "）");

/* ================= 11. 4ページを含む全ページの対外約束を監査 ================= */
// 「捏造」という語が出てくるのは“しない”という約束の形だけであること
const badClaims = [];
for (const p of ALL_PAGES) {
  const html = read(p);
  for (const m of html.matchAll(/捏造[^\s、。,）)」<]{0,6}/g)) {
    const tail = m[0].slice(2);
    if (!/^(しません|しない|せず|は一切|は絶対)/.test(tail)) badClaims.push(p + ": " + m[0]);
  }
}
eq(badClaims, [], "全ページで「捏造」は否定形（しない約束）としてのみ使われている");
for (const p of ALL_PAGES) {
  const html = read(p);
  ok(!/そのまま提出|そのまま出せ|提出を保証|合格を保証|採用を保証|内定を保証/.test(html),
    p + ": 成果を保証する言い方をしていない");
  ok(!/自動補完/.test(html), p + ": 成立しない「自動補完」が残っていない");
}
// index 以外に「不捏造」の約束を新設していない（実装が伴わない約束を増やさない）
for (const p of ["jiko-pr.html", "mensetsu.html"]) {
  ok(!/捏造/.test(read(p)), p + " には捏造の約束を置いていない（旧契約で gBizINFO を使わないため）");
}
// 実測で偽だった約束の再来防止
ok(!/情報からのみ記述し/.test(index), "index.html: 実測で偽だった「情報からのみ記述し」が復活していない");

/* ================= 12. 既存機能の保全 ================= */
for (const p of ALL_PAGES) {
  ok(/<span class="auth-area" id="auth-area"><\/span>/.test(read(p)), p + ": auth-area の器が残っている");
}
for (const p of PAGES) {
  ok(/id="gen-form"/.test(read(p)), p + ": 生成フォームが残っている");
  ok(/id="result"/.test(read(p)), p + ": 結果の器が残っている");
  ok(idExistsInToolbar(p), p + ": ツールバーが残っている（全文コピーの置き場）");
}
function idExistsInToolbar(p) { return /class="toolbar no-print"/.test(read(p)); }
ok(/const DAILY_LIMIT = 2;/.test(gen), "既存: 匿名の1日2回は据え置き");
ok(/const LOGGED_DAILY = Number\(process\.env\.LOGGED_DAILY_LIMIT\) \|\| 5;/.test(gen), "既存: ログイン中の上限は据え置き");
ok(/persistRecord\(session, body\.tool/.test(gen), "既存: 履歴保存はサーバ側のみ（二重保存しない）");
ok(!/DELETE/.test(read("api/records.js")), "既存: records.js に DELETE を足していない");
for (const k of ["function generate(", "function fillExample(", "function setupPhoto("]) {
  ok(eng.indexOf(k) >= 0, "既存: engine.js の " + k + " が残っている");
}
ok(/gbizConfigured\(\)/.test(comp) && /gbizDetail\(/.test(comp), "既存: 企業確認も共有ライブラリ経由で gBizINFO を使う");
ok(/function gbizToken\(\) \{ return process\.env\.GBIZ_API_TOKEN \|\| ""; \}/.test(lib),
  "既存: トークンは呼び出し時に読む（読み込み順で挙動が変わらない）");

/* ================= 結果 ================= */
console.log("\n=== P0（企業確認・キーワード・補完・転換・モバイル・信任）検査 ===");
if (failures.length) {
  console.log("\n失敗 (" + failures.length + "):");
  failures.forEach((f, i) => console.log("  " + (i + 1) + ") " + f));
} else {
  console.log("  失敗なし");
}
console.log("\nPASS: " + pass + "  FAIL: " + fail + "\n");
process.exit(fail ? 1 : 0);
