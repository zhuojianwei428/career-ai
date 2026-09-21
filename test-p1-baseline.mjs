/* P-1（地基の修復・6項目）の検証。ネットワーク不要。
 *
 * 実行: node test-p1-baseline.mjs
 *
 * 方針: 「コードを読んで安心する」テストにしない。特に P-1-2 は
 *   「実は前から壊れていたのに、失敗がログにも出ず無言で null を返していた」
 *   のが問題の本質なので、fetch を横取りして**実際にハンドラを走らせ**、
 *   レスポンスの中身（companyContextUsed / notice / gbiz）まで確認する。
 *   gBizINFO のスタブは実測した挙動を再現する:
 *     末尾スラッシュ形式 "/hojin/?name=" → ルート未マッチで 500（トークンに関係なく）
 *     正しい形式   "/hojin?name="        → 401（認証層到達）または 200
 *   これにより「末尾スラッシュに戻す」改修をした瞬間にテストが落ちる。
 */
import { readFileSync, existsSync } from "node:fs";

const BASE = "https://www.coverletterkit.com";
const PAGES = ["index.html", "jiko-pr.html", "rirekisho.html", "shokumu.html", "mensetsu.html"];
const ALL_PAGES = PAGES.concat(["account.html", "privacy.html"]);
const TOOLS_WITH_COMPANY_REQUIRED = ["index.html", "rirekisho.html", "shokumu.html"];
const GBIZ = "https://api.info.gbiz.go.jp/hojin/v2/hojin";
const CN = "1180301018771";

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

/* ================= 1. P-1-1 .vercelignore ================= */
ok(existsSync(new URL("./.vercelignore", import.meta.url)), ".vercelignore が存在する");
const vi = read(".vercelignore");

/* .vercelignore は**個別列挙ではなくパターン**で書く（1つずつ並べると、次にファイルを足した人が
 * 必ず漏らし、気づかないまま配信される）。そのため検査も「文字列が書いてあるか」ではなく
 * 「glob として実際にそのファイルに一致するか」で行う。
 * → 列挙に戻す改修をすると落ちる。パターンを緩めすぎた（例: 行が `*` だけ）場合も下の対照検査で落ちる。 */
function globToRe(pat) {
  const esc = pat.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]");
  return new RegExp("^" + esc + "$");
}
// コメント行・空行を除いた「実際に効いているパターン」
const viPatterns = vi.split("\n").map((l) => l.trim()).filter((l) => l && l[0] !== "#");
ok(viPatterns.length >= 3, ".vercelignore に除外パターンが 3 行以上ある");
const isIgnored = (f) => viPatterns.some((p) => globToRe(p).test(f));

// 既存の内部ファイルが実際に除外されること
const MUST_IGNORE = ["QWEN_SETUP.md", "GBIZ_SETUP.md", "EMAIL_SETUP.md", "REDIS_SETUP.md", "test-seo-lp.mjs"];
for (const f of MUST_IGNORE) {
  ok(isIgnored(f), ".vercelignore のパターンが " + f + " を実際に除外する");
}
// 除外先が実在しないと、タイポに気づけない
for (const f of MUST_IGNORE) {
  ok(existsSync(new URL("./" + f, import.meta.url)), "除外対象の " + f + " がリポジトリに実在する（タイポ検知）");
}
// パターンが効いている証明：**まだ存在しない**将来のファイルも除外される（＝列挙に戻すとここが落ちる）
for (const f of ["test-p1-baseline.mjs", "test-p0.mjs", "PRIVACY_SETUP.md", "_scratch.mjs"]) {
  ok(isIgnored(f), "将来追加される " + (/(SETUP|scratch)/.test(f) ? "文書/検証スクリプト " : "") + f + " も列挙せずとも除外される");
}
// 対照検査：配信すべきファイルまで巻き込んでいない（パターンを `*` にすると即バレる）
for (const f of ["index.html", "privacy.html", "assets/js/engine.js", "assets/css/style.css", "api/generate.js", "robots.txt", "sitemap.xml"]) {
  ok(!isIgnored(f), "配信対象の " + f + " は除外されていない（パターンが広すぎない）");
}

/* ================= 2. P-1-2 gBizINFO（静的な形） ================= */
const gen = read("api/generate.js");
// 検索・詳細の URL 組み立ては api/_lib/gbiz.mjs に一本化した（2箇所に書くと片方だけ直して事故る）。
const lib = read("api/_lib/gbiz.mjs");
const comp = read("api/company.js");
// コメントには「やってはいけない形」を説明として書いてあるため、判定はコード行だけで行う
const libCode = lib.split("\n").filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l)).join("\n");
ok(/const GBIZ_BASE = "https:\/\/api\.info\.gbiz\.go\.jp\/hojin\/v2\/hojin"/.test(lib),
  "GBIZ_BASE が末尾スラッシュ無しで定義されている");
ok(!/GBIZ_BASE \+ "\/\?name="/.test(libCode), "検索 URL に末尾スラッシュを付けていない（500 の原因だった形）");
ok(/gbizGet\("\?name=" \+ encodeURIComponent\(q\)\)/.test(lib), "検索 URL が GBIZ_BASE + \"?name=\" の形");
ok(/console\.error\("\[gbiz\]\[FAIL\] HTTP "/.test(lib), "gbizGet が HTTP 失敗をログに残す");
ok(/console\.error\("\[gbiz\]\[FAIL\] fetch "/.test(lib), "gbizGet が fetch 例外をログに残す");
ok(/console\.warn\("\[gbiz\]\[SKIP\] "/.test(lib), "トークン未設定も警告として残す");
ok(!/GBIZ_BASE/.test(gen) && /from "\.\/_lib\/gbiz\.mjs"/.test(gen),
  "generate.js は URL を自前で組み立てず共有ライブラリを使う（事故の再発防止）");
ok(/isCorporateNumber/.test(lib) && /\^\[0-9\]\{13\}\$/.test(lib),
  "法人番号を 13 桁の数字として検証する（URL へ連結するため、パス注入を防ぐ）");
ok(/console\.log\("\[company\]\[search\]/.test(comp) && /console\.log\("\[company\]\[detail\]/.test(comp),
  "企業確認エンドポイントも成功/失敗を必ずログに残す");
ok(/console\.log\("\[gbiz\] " \+ JSON\.stringify\(gbizRes\.diag\)\)/.test(gen), "ハンドラが毎回 gbiz の診断結果をログに出す");
ok(/return \{ ok: false, status: null, error: "no-token", data: null \}/.test(lib), "gbizGet が「未設定」と「失敗」を区別して返す");
ok(!/catch \(e\) \{\s*return null; \/\/ 失敗時は無視/.test(gen), "「失敗時は無視して null」の無言経路が消えている");
ok(/gbiz: gbizRes\.diag/.test(gen), "診断結果をレスポンスに載せている（外部から状態を確認できる）");
ok(/NO_FABRICATION_RULES/.test(gen), "不捏造ルールが共有定数として定義されている");

/* ================= 3. P-1-2 gBizINFO（実際に走らせる） ================= */
function jsonRes(status, obj) {
  return {
    ok: status >= 200 && status < 300,
    status: status,
    headers: { get: () => "application/json" },
    json: async () => obj,
    text: async () => JSON.stringify(obj)
  };
}
const gbizCalls = [];
function stubFetch(mode) {
  return async function (url) {
    const u = String(url);
    if (u.indexOf("api.info.gbiz.go.jp") >= 0) {
      gbizCalls.push(u);
      // 実測再現①: 末尾スラッシュ付きはトークンが正しくても 500（ダミールート扱い）
      if (/\/hojin\/v2\/hojin\/\?/.test(u)) {
        return jsonRes(500, { id: null, message: "500 - Internal Server Error.", errors: [] });
      }
      // 実測再現②: トークン不正は正しい形式なら 401（＝認証層に到達している証拠）
      if (mode === "bad") return jsonRes(401, { id: null, message: "401 - Unauthorized", errors: [] });
      if (u.indexOf("?name=") >= 0) {
        if (mode === "nomatch") return jsonRes(200, { "hojin-infos": [] });
        return jsonRes(200, { "hojin-infos": [
          { corporate_number: "9999999999999", name: "トヨタ自動車九州株式会社", status: "-" },
          { corporate_number: CN, name: "トヨタ自動車株式会社", status: "-" }
        ] });
      }
      if (u === GBIZ + "/" + CN) {
        return jsonRes(200, { "hojin-infos": [{
          corporate_number: CN,
          name: "トヨタ自動車株式会社",
          industry: ["E"],
          business_summary: "自動車の製造・販売",
          capital_stock: 635401000000,
          employee_number: 375870,
          location: "愛知県豊田市トヨタ町1番地",
          date_of_establishment: "1937-08-28",
          representative_name: "佐藤 恒治",
          company_url: "https://global.toyota/"
        }] });
      }
      return jsonRes(200, { "hojin-infos": [] }); // patent/subsidy/... は空
    }
    if (u.indexOf("dashscope.aliyuncs.com") >= 0) {
      // 実測で観測した「文末に自己申告の文字数を混ぜる」挙動（数字も実際と食い違う）を再現する
      if (mode === "selfreport") {
        return jsonRes(200, { choices: [{ finish_reason: "stop", message: { content: "これはテスト本文です。（文字数：698字）" } }] });
      }
      // 上限で切れた場合（finish_reason=length）も再現する
      if (mode === "truncated") {
        return jsonRes(200, { choices: [{ finish_reason: "length", message: { content: "これは途中で切れた本文です。" } }] });
      }
      return jsonRes(200, { choices: [{ finish_reason: "stop", message: { content: "ダミー生成文（テスト用）。" } }] });
    }
    throw new Error("unexpected fetch: " + u);
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
function makeReq(company, gbizSel) {
  return {
    method: "POST",
    headers: { cookie: "" },
    body: {
      tool: "shibou",
      // P0-0 以降、企業情報（gBizINFO）は「確認して選んだ法人番号」があるときだけ使う
      gbiz: gbizSel,
      fields: {
        "応募種別": "転職", "職種": "ITエンジニア", "企業名": company,
        "経験・キーワード": "前職で社内基幹システムのリプレースを担当。",
        "文字数": "300〜500字", "トーン": "フォーマル", "企業情報": ""
      }
    }
  };
}
async function loadHandler(tag) {
  const url = new URL("./api/generate.js?case=" + tag, import.meta.url).href;
  return (await import(url)).default;
}
async function runCase(tag, env, mode, gbizSel) {
  if (env.GBIZ_API_TOKEN === undefined) delete process.env.GBIZ_API_TOKEN;
  else process.env.GBIZ_API_TOKEN = env.GBIZ_API_TOKEN;
  process.env.OPENAI_API_KEY = env.OPENAI_API_KEY === undefined ? "test-key" : env.OPENAI_API_KEY;
  globalThis.fetch = stubFetch(mode);
  const handler = await loadHandler(tag);
  const res = makeRes();
  const logs = [], errs = [], warns = [];
  const origLog = console.log, origErr = console.error, origWarn = console.warn;
  console.log = (...a) => logs.push(a.join(" "));
  console.error = (...a) => errs.push(a.join(" "));
  console.warn = (...a) => warns.push(a.join(" "));
  try {
    await handler(makeReq("トヨタ自動車株式会社", gbizSel), res);
  } finally {
    console.log = origLog;
    console.error = origErr;
    console.warn = origWarn;
  }
  return { res: res, logs: logs, errs: errs, warns: warns };
}

/* --- ケースA: 確認済みの法人番号で生成（P0-0 以降の正常系） --- */
gbizCalls.length = 0;
const A = await runCase("ok", { GBIZ_API_TOKEN: "t".repeat(40) }, "ok", { corporateNumber: CN });
eq(A.res.code, 200, "A: 正常系で 200 を返す");
ok(A.res.payload && A.res.payload.companyContextUsed === true, "A: companyContextUsed が true（P-1-2 の合格条件）");
ok(A.res.payload && typeof A.res.payload.notice === "string" && A.res.payload.notice.length > 0,
  "A: notice が非空（P-1-2 の合格条件）");
// 確認済みなので「同名の別法人かも」ではなく「どの法人を使ったか」を明示する
ok(/法人番号: 1180301018771/.test(A.res.payload.notice), "A: notice に使った法人番号が出る");
ok(/法人名: トヨタ自動車株式会社/.test(A.res.payload.notice), "A: notice に法人名が出る");
ok(/出典：gBizINFO/.test(A.res.payload.notice), "A: notice に出典（gBizINFO）が入る（赤線#3 の要求）");
ok(/最終確認は企業の公式サイト/.test(A.res.payload.notice), "A: 最新性を断定しない注意書きがある");
ok(A.res.payload && A.res.payload.contextSource === "gbiz", "A: contextSource が gbiz");
ok(A.res.payload && A.res.payload.gbiz && A.res.payload.gbiz.ok === true, "A: 診断 ok=true");
eq(A.res.payload && A.res.payload.gbiz && A.res.payload.gbiz.step, "done", "A: 診断 step=done");
eq(A.res.payload && A.res.payload.gbiz && A.res.payload.gbiz.corporateNumber, CN, "A: 確認した法人番号を使っている");
ok(gbizCalls.length >= 2, "A: gBizINFO を実際に呼んでいる（" + gbizCalls.length + " 回）");
ok(gbizCalls.every((u) => u.indexOf(GBIZ + "/" + CN) === 0),
  "A: 呼び先はすべて「/{確認した法人番号}」系（法人名検索はしない＝取り違えが起きない）");
ok(gbizCalls.every((u) => u.indexOf("?name=") < 0), "A: 法人名での検索を一切していない");
ok(gbizCalls.every((u) => !/\/hojin\/v2\/hojin\/\?/.test(u)), "A: 末尾スラッシュ形式の URL を一度も使っていない");
ok(A.logs.some((l) => l.indexOf("[gbiz]") >= 0 && l.indexOf('"ok":true') >= 0), "A: 診断ログに ok:true が出る");

/* --- ケースA2: 確認を経ていないリクエスト（旧キャッシュのJSなど） --- */
gbizCalls.length = 0;
const A2 = await runCase("noconfirm", { GBIZ_API_TOKEN: "t".repeat(40) }, "ok", undefined);
eq(A2.res.code, 200, "A2: 確認が無くても 200（生成は止めない）");
eq(gbizCalls.length, 0, "A2: 確認が無ければ gBizINFO を一切呼ばない（取り違えの経路を塞ぐ）");
ok(A2.res.payload && A2.res.payload.companyContextUsed === false, "A2: companyContextUsed は false");
eq(A2.res.payload && A2.res.payload.gbiz && A2.res.payload.gbiz.step, "no-confirmation", "A2: 診断 step=no-confirmation");
ok(/再読み込み/.test(A2.res.payload.notice || ""), "A2: notice が再読み込みを案内する（黙って劣化させない）");

/* --- ケースA3: 利用者が「企業情報を使わない」を選んだ --- */
gbizCalls.length = 0;
const A3 = await runCase("declined", { GBIZ_API_TOKEN: "t".repeat(40) }, "ok", { confirmed: false, reason: "declined" });
eq(A3.res.code, 200, "A3: 200");
eq(gbizCalls.length, 0, "A3: 使用しない選択なら呼ばない");
eq(A3.res.payload && A3.res.payload.gbiz && A3.res.payload.gbiz.step, "declined", "A3: 診断 step=declined（異常ではない）");
ok(/使用していません/.test(A3.res.payload.notice || ""), "A3: 「使っていない」ことを本文の注記に出す");

/* --- ケースA4: 法人番号に細工を混ぜたリクエスト（パス注入の試み） --- */
gbizCalls.length = 0;
const A4 = await runCase("injection", { GBIZ_API_TOKEN: "t".repeat(40) }, "ok", { corporateNumber: "../../zzz" });
eq(A4.res.code, 200, "A4: 200");
eq(gbizCalls.length, 0, "A4: 不正な法人番号では1回も fetch しない（URL に連結しない）");
ok(A4.res.payload && A4.res.payload.gbiz && A4.res.payload.gbiz.step === "no-confirmation",
  "A4: 不正な値は「確認なし」として扱い、企業情報を使わない");

/* --- ケースB: 上流 401（トークン不正・失効） --- */
gbizCalls.length = 0;
const B = await runCase("badtoken", { GBIZ_API_TOKEN: "x".repeat(40) }, "bad", { corporateNumber: CN });
eq(B.res.code, 200, "B: 上流が 401 でも 200 を返す（機能全滅でもサイトは止めない）");
ok(B.res.payload && B.res.payload.companyContextUsed === false, "B: companyContextUsed は false");
ok(B.res.payload && B.res.payload.gbiz && B.res.payload.gbiz.ok === false, "B: 診断 ok=false");
eq(B.res.payload && B.res.payload.gbiz && B.res.payload.gbiz.error, "http-401", "B: 診断 error が http-401");
eq(B.res.payload && B.res.payload.gbiz && B.res.payload.gbiz.status, 401, "B: 診断 status が 401");
ok(B.errs.some((l) => l.indexOf("[gbiz][FAIL]") >= 0 && l.indexOf("401") >= 0), "B: 401 がログに残る（＝もう無言で消えない）");
ok(B.res.payload && B.res.payload.text, "B: それでも生成結果は返る");

/* --- ケースC: トークン未設定 --- */
gbizCalls.length = 0;
const C = await runCase("notoken", { GBIZ_API_TOKEN: undefined }, "ok", { corporateNumber: CN });
eq(C.res.code, 200, "C: トークン未設定でも 200");
eq(C.res.payload && C.res.payload.gbiz && C.res.payload.gbiz.step, "no-token", "C: 診断 step=no-token");
ok(C.res.payload && C.res.payload.gbiz && C.res.payload.gbiz.configured === false, "C: configured=false");
ok(C.errs.some((l) => l.indexOf("[gbiz][SKIP]") >= 0) || C.warns.some((l) => l.indexOf("[gbiz][SKIP]") >= 0),
  "C: 未設定が警告として残る");
eq(gbizCalls.length, 0, "C: 未設定なら gBizINFO を呼ばない");

/* --- ケースD: 法人詳細が取れない（／該当法人のデータが空） --- */
const D = await runCase("detailfail", { GBIZ_API_TOKEN: "t".repeat(40) }, "ok", { corporateNumber: "9999999999999" });
eq(D.res.code, 200, "D: 詳細が空でも 200");
ok(D.res.payload && D.res.payload.companyContextUsed === false, "D: companyContextUsed は false");
eq(D.res.payload && D.res.payload.gbiz && D.res.payload.gbiz.step, "detail-empty", "D: 診断 step=detail-empty");
ok(D.errs.some((l) => l.indexOf("[gbiz][FAIL]") >= 0), "D: 取れなかったことがログに残る（無言にしない）");

/* --- ケースE: 文末に混ざる「（文字数：698字）」を落とす --- */
const E = await runCase("strip", { GBIZ_API_TOKEN: undefined }, "selfreport", { confirmed: false });
eq(E.res.code, 200, "E: 200");
ok(E.res.payload && E.res.payload.text.indexOf("（文字数：698字）") < 0, "E: 自己申告の文字数が本文から消えている");
ok(E.res.payload && E.res.payload.strippedSelfReport === true, "E: 除去したことをレスポンスに載せる（観測できる）");
ok(E.res.payload && /これはテスト本文です。/.test(E.res.payload.text), "E: 本文自体は壊していない");

/* --- ケースF: 出力上限で切れた場合 --- */
const F = await runCase("trunc", { GBIZ_API_TOKEN: undefined }, "truncated", { confirmed: false });
eq(F.res.code, 200, "F: 200");
ok(F.res.payload && F.res.payload.truncated === true, "F: truncated=true（黙って「完成」と言わない）");
ok(/途中で切れた可能性/.test(F.res.payload.notice || ""), "F: notice で切れている可能性を伝える");
ok(F.errs.some((l) => l.indexOf("[gen][FAIL]") >= 0 && l.indexOf("length") >= 0), "F: finish_reason=length がログに残る");

/* ================= 4. P-1-3 反捏造ルール ================= */
ok(/【厳守ルール：経歴・実績・企業情報の捏造禁止】/.test(gen), "不捏造ルールの見出しがある");
ok(/人のための技術/.test(gen), "実測で再現した偽スローガンを禁止例として明記している");
ok(/「遊び」/.test(gen), "実測で再現した2例目（任天堂で出た「遊び」）も禁止例に追加されている");
ok(/開発哲学・価値観を推測して書くこと/.test(gen), "開発哲学・価値観の推測も禁止対象に含めている");
ok(/出力で鉤括弧「」『』を一切使わない/.test(gen),
  "出力での鉤括弧を全面禁止（引用体裁の捏造を封じる。実測で残った「遊び」対策）");
ok(/強調したい場合は括弧を使わず、地の文で書く/.test(gen), "引用符禁止の代わりに地の文で書くよう指示している");
ok(/同名の別法人/.test(gen), "同名の別法人に当たる可能性をルールにも明記");
ok(/ミッション・経営理念・スローガン・キャッチコピー・社風・社訓/.test(gen), "禁止対象に理念・スローガン・社風・社訓を列挙");
ok(/業績・売上・シェア・従業員数・導入技術などの数値も、企業情報に無い限り書かない/.test(gen), "数値の捏造も禁止");
ok(/【 】で括った穴埋めを残す/.test(gen), "情報が無い箇所は穴埋め（【 】）で残すと明記");
ok(/文字数の自己申告/.test(gen) && /を書かない/.test(gen), "文字数の自己申告を禁止（実測 698字 vs 実際579字 の食い違い対策）");
// 両方の契約に前置されていること（片方だけだとツールによって捏造の有無が変わる）
ok(/const NO_FABRICATION_RULES =\s*\n`/.test(gen), "ルールが定数として1か所に定義されている");
ok(/\$\{NO_FABRICATION_RULES\}/.test(gen), "構造化契約(buildPrompt)がルールを前置している");
ok(/content: NO_FABRICATION_RULES \+ "\\n\\n【出力ルール】/.test(gen),
  "旧契約(messages)にもルールと出力ルールを前置している（4ツールがこちらを通るため）");
ok(/generateWithFallback\(hardened\)/.test(gen), "旧契約は強化後のメッセージで生成している");
// index 以外は structured 契約を通らない＝旧契約にもルールが要る、という前提の固定
for (const p of ["jiko-pr.html", "rirekisho.html", "shokumu.html", "mensetsu.html"]) {
  ok(!/structured:\s*true/.test(read(p)), p + " は旧契約（messages）を通る＝共通ルールの前置が必須");
}

/* ================= 5. P-1-4 不実な約束と中文残留 ================= */
let stray = [];
for (const p of ALL_PAGES) if (read(p).indexOf("空缺") >= 0) stray.push(p);
if (read("assets/js/engine.js").indexOf("空缺") >= 0) stray.push("engine.js");
if (read("api/generate.js").indexOf("空缺") >= 0) stray.push("api/generate.js");
eq(stray, [], "中文残留「空缺」が1ファイルも残っていない");
ok(!/情報からのみ記述し/.test(read("index.html")),
  "実測で偽だった「ご入力いただいた情報からのみ記述し」が消えている");
ok(/情報が足りない箇所は【 】のまま残します/.test(read("index.html")), "代わりに検証可能な表現になっている");
// 修正した3か所が、いずれも自然な日本語になっていること
// （jiko-pr 等は元々【 】の説明を持たないため対象外。無理に文言を足さない）
ok(/【 】のまま残します（経歴を捏造しない方針）/.test(read("index.html")), "index.html: 出力例の注記が自然な日本語");
ok(/情報が足りない箇所は【 】のまま残します/.test(read("index.html")), "index.html: 不捏造の約束欄が自然な日本語");
ok(/御社固有の内容を【 】のまま残します/.test(read("index.html")), "index.html: 企業情報欄の注記が自然な日本語");
const eng = read("assets/js/engine.js");
ok(/入力が足りない箇所は【 】のまま残しました/.test(eng), "engine.js のステータス文言も修正済み");

/* ================= 6. P-1-5 プライバシーポリシー ================= */
ok(existsSync(new URL("./privacy.html", import.meta.url)), "privacy.html が存在する");
const pv = read("privacy.html");
ok(/Alibaba Cloud/.test(pv) && /百炼/.test(pv) && /DashScope/.test(pv), "委託先（Alibaba Cloud / 百炼 / DashScope）を明記");
ok(/中華人民共和国/.test(pv), "所在国（中華人民共和国）を明記");
ok(/外国にある事業者に委託/.test(pv), "外国にある第三者への委託であることを明記");
ok(/Vercel Inc\./.test(pv) && /Upstash, Inc\./.test(pv), "その他の委託先（ホスティング・ストア）も明記");
ok(/個人情報保護法/.test(pv), "個人情報保護法に言及している");
ok(!/PIPL/.test(pv), "PIPL（中国の法域）を書いていない");
ok(!/一切保存しません|入力内容はサーバーに保存しません/.test(pv), "絶対化した「保存しません」を書いていない");
ok(/未ログイン[\s\S]{0,80}?保存しません/.test(pv), "「保存しない」は未ログイン時に限定して書いている");
ok(/1年/.test(pv) && /200 件/.test(pv), "保存期間（1年・200件）が実装と一致している");
ok(/原文そのものは、履歴として保存していません/.test(pv), "経験・企業情報の原文が未保存であることを明記");
ok(/10分/.test(pv), "認証コードの有効期限を明記");
ok(/contact@coverletterkit\.com/.test(pv), "削除等の請求先を明記");
ok(/現時点では画面上から履歴を削除する機能をご用意していない/.test(pv),
  "存在しない削除機能を約束していない（実装は GET/POST のみ）");
// 削除機能が本当に無いことの裏取り
ok(!/DELETE/.test(read("api/records.js")), "records.js に DELETE が無い＝手動削除の案内が正しい");
// リンク（フォーム下部とフッター）
for (const p of ALL_PAGES) {
  if (p === "privacy.html") continue;
  ok(/href="\/privacy\.html"/.test(read(p)), p + ": プライバシーポリシーへのリンクがある");
}
for (const p of ["index.html", "jiko-pr.html", "rirekisho.html", "shokumu.html", "mensetsu.html"]) {
  const html = read(p);
  const forms = html.indexOf("</form>");
  ok(html.slice(0, forms).indexOf("/privacy.html") >= 0, p + ": フォーム内（＝送信ボタン付近）にもリンクがある");
}
ok(/<loc>https:\/\/www\.coverletterkit\.com\/privacy\.html<\/loc>/.test(read("sitemap.xml")), "sitemap に privacy.html が入っている");

/* ================= 7. P-1-6 企業名は必須 ================= */
for (const p of TOOLS_WITH_COMPANY_REQUIRED) {
  const html = read(p);
  const req = (html.match(/required:\s*\[([^\]]*)\]/) || [])[1] || "";
  ok(/"企業名"/.test(req), p + ": required に 企業名 が入っている");
  ok(/志望(する)?企業名 <span class="hint">（必須）<\/span>/.test(html), p + ": ラベルが（必須）になっている");
}
for (const p of ALL_PAGES) {
  ok(!/自動補完/.test(read(p)), p + ": 成立しない「自動補完」の説明が消えている");
}
ok(!/自動補完/.test(gen), "api/generate.js にも「自動補完」の説明が残っていない");
// 必須項目が EXAMPLE で埋まること（「例を入れてみる」→生成 が弾かれない）
for (const p of TOOLS_WITH_COMPANY_REQUIRED) {
  const html = read(p);
  const req = [...((html.match(/required:\s*\[([^\]]*)\]/) || [])[1] || "").matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  const block = (html.match(/var EXAMPLE = \{([\s\S]*?)\n  \};/) || [])[1] || "";
  const exKeys = [...block.matchAll(/^\s*"([^"]+)":/gm)].map((m) => m[1]);
  eq(req.filter((k) => !exKeys.includes(k)), [], p + ": EXAMPLE が必須項目（企業名含む）をすべて埋める");
}

/* ================= 8. 既存機能を壊していないか ================= */
ok(existsSync(new URL("./assets/js/engine.js", import.meta.url)), "engine.js が存在する");
for (const k of ["function generate(", "function fillExample(", "function track(", "function exportPDF("]) {
  ok(eng.indexOf(k) >= 0, "engine.js の " + k + " が残っている");
}
for (const p of ALL_PAGES) {
  ok(/<span class="auth-area" id="auth-area"><\/span>/.test(read(p)), p + ": auth-area の器が残っている（CLS 対策）");
}
ok(/<h1[\s\S]{0,200}?<\/h1>/.test(read("index.html")), "index.html の H1 が残っている");
for (const p of PAGES) {
  ok(/id="gen-form"/.test(read(p)), p + ": 生成フォームが残っている");
}

/* ================= 結果 ================= */
console.log("\n=== P-1（地基の修復）検査 ===");
if (failures.length) {
  console.log("\n失敗 (" + failures.length + "):");
  failures.forEach((f, i) => console.log("  " + (i + 1) + ") " + f));
} else {
  console.log("  失敗なし");
}
console.log("\nPASS: " + pass + "  FAIL: " + fail + "\n");
process.exit(fail ? 1 : 0);
