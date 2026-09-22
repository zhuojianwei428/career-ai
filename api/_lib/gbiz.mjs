// gBizINFO（経済産業省 法人情報 REST API v2）共有ラッパ
//
//  検索: https://api.info.gbiz.go.jp/hojin/v2/hojin?name=...   ← 末尾スラッシュを付けない
//  詳細: https://api.info.gbiz.go.jp/hojin/v2/hojin/{法人番号}
//  認証: ヘッダ X-hojinInfo-api-token（GBIZ_API_TOKEN）
//
// ⚠️ 実測 2026-09-21 — これが「companyContextUsed が常に false」だった真因:
//   検索を GBIZ_BASE + "/?name=" にすると末尾スラッシュのせいでルートに一致せず、
//   「トークンが正しくても必ず HTTP 500」が返る。存在しないダミールート /zzz と
//   完全に同じ応答なので切り分けられる（401=ルート有り＝認証層到達 / 500=ルート未マッチ）。
//   curl では判定できない（Windows schannel の TLS 再ネゴシエーションで応答体が切れ、
//   正しい URL でも 500 に見える）。判定は Node の fetch で行うこと。
//
// このファイルは `_lib/` 配下なので Vercel の関数としてはデプロイされない（共有モジュール）。
// 検索と詳細を api/company.js（確認UI用）と api/generate.js（生成用）の両方から使うため、
// ここに一本化する。URL 結合を2箇所に書くと、片方だけ直して片方が壊れる事故が起きる。

const GBIZ_BASE = "https://api.info.gbiz.go.jp/hojin/v2/hojin";
// トークンは呼び出し時に読む（モジュール読み込み時に固定しない）。
// 固定すると「読み込み順によって設定の有無が変わる」状態になり、テストでも本番の再起動でも
// 挙動が読めなくなる。呼び出し時に読めば常にその時点の環境変数が正となる。
function gbizToken() { return process.env.GBIZ_API_TOKEN || ""; }

export const JSIC_MAJOR = {
  A: "農業・林業", B: "漁業", C: "鉱業・採石業", D: "建設業", E: "製造業",
  F: "電気・ガス・熱供給・水道業", G: "情報通信業", H: "運輸業・郵便業",
  I: "卸売業・小売業", J: "金融業・保険業", K: "不動産業・物品賃貸業",
  L: "学術研究・専門・技術サービス業", M: "宿泊業・飲食サービス業",
  N: "生活関連サービス業・娯楽業", O: "教育・学習支援業", P: "医療・福祉",
  Q: "複合サービス事業", R: "サービス業（他に分類されないもの）", S: "公務・その他"
};

export function gbizConfigured() { return !!gbizToken(); }

// 法人番号は必ず 13 桁の数字。クライアントから受け取る値なので必ず検証する
// （そのまま URL に連結するため、検証しないとパス注入になる）。
export function isCorporateNumber(v) {
  return typeof v === "string" && /^[0-9]{13}$/.test(v);
}

// 戻り値は必ず { ok, status, error, data }。null を返すと「未設定」と「失敗」が
// 区別できず、障害が無言で消える（今回それが原因で長期間気づけなかった）。必ず理由を返し、必ずログに残す。
async function gbizGet(path) {
  if (!gbizToken()) return { ok: false, status: null, error: "no-token", data: null };
  const ctrl = new AbortController();
  const timer = setTimeout(function () { ctrl.abort(); }, 5000);
  const url = GBIZ_BASE + path;
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: { "X-hojinInfo-api-token": gbizToken() }
    });
    if (!r.ok) {
      let snippet = "";
      try { snippet = (await r.text()).slice(0, 200).replace(/\s+/g, " "); } catch (e) { /* noop */ }
      // 404 は「その資源・その検索結果が無い」という上流の**回答**でありうる
      // （実測 2026-09-22: 検索で該当なしのとき gBizINFO は 404 を返す。トヨタは 200・10件）。
      // これを [gbiz][FAIL] に混ぜると「該当なし」が障害ログとして積み上がり、本物の障害が埋もれる。
      // 一方 401=認証失敗 / 500=ルート未マッチ / 429=レート制限 とは**別物**なので、
      // 404 だけを NOTFOUND として分離する（失敗ログからは外すが、warning として必ず残す＝無言にしない）。
      // 呼び出し側は notFound を見て「正常系の空」と「失敗」を切り分ける。
      if (r.status === 404) {
        console.warn("[gbiz][NOTFOUND] HTTP 404 " + url + " body=" + snippet);
        return { ok: false, status: 404, error: "http-404", data: null, notFound: true };
      }
      console.error("[gbiz][FAIL] HTTP " + r.status + " " + url + " body=" + snippet);
      return { ok: false, status: r.status, error: "http-" + r.status, data: null, notFound: false };
    }
    const j = await r.json();
    // v2 は { "hojin-infos": [...] } 形式だが、配列直返しの可能性も許容する
    const list = Array.isArray(j) ? j : ((j && j["hojin-infos"]) || null);
    return { ok: true, status: r.status, error: null, data: list };
  } catch (e) {
    console.error("[gbiz][FAIL] fetch " + url + " -> " + ((e && e.name) || "Error") + ": " + ((e && e.message) || e));
    return { ok: false, status: null, error: (e && e.name) || "fetch-error", data: null };
  } finally {
    clearTimeout(timer);
  }
}

// 診断オブジェクト。意味を固定する:
//   ok    = 上流（gBizINFO）から**実データが取れた**か。search-empty は「正常だがデータ無し」なので false。
//   step  = どこで止まったか（no-token / search / search-empty / search-done / detail / detail-empty / …）
//   notFound = 上流が 404 を返したか。200 で空リストだった「該当なし」と区別するための印
//              （404 を「該当なし」に倒す判断を後から検証できるようにする。消すと切り分け不能になる）
// 実測 2026-09-21: gbizSearch が成功時に ok を立てておらず、hits:81 / step:"search-done" なのに
// diag.ok:false という**自己矛盾した診断**を返していた（detail 側は立てていた）。
// ログを見て誤診する原因になるので、両関数で同じ意味になるよう統一した。
function emptyDiag(step) {
  return { configured: !!gbizToken(), ok: false, step: step || "init", status: null, error: null, hits: 0, notFound: false };
}

// 法人名で検索し、候補を返す。選ばせるための情報（法人名/所在地/法人番号/状態/業種/設立）だけを返す。
// ここで1件に絞り込んではいけない —— 同名の別法人が実在するため、選ぶのは利用者でなければならない。
export async function gbizSearch(name) {
  const diag = emptyDiag();
  if (!gbizToken()) {
    diag.step = "no-token";
    diag.error = "GBIZ_API_TOKEN が未設定（Vercel の環境変数を確認）";
    console.warn("[gbiz][SKIP] " + diag.error);
    return { ok: false, status: null, error: "no-token", diag: diag, items: [] };
  }
  const q = (name || "").trim();
  if (!q) { diag.step = "empty-name"; return { ok: false, status: null, error: "empty-name", diag: diag, items: [] }; }
  diag.step = "search";
  const search = await gbizGet("?name=" + encodeURIComponent(q));
  diag.status = search.status;
  // 「該当なし」だけを正常系として通す。ただし通すのは **404 のときだけ**。
  // 401（認証失敗）/ 500（ルート未マッチ）/ 429（レート制限）/ 通信失敗は失敗のまま返す ——
  // 404 を無条件に「無登録」と決めつけると、将来トークン失効やルート変更が 404 を返したときに
  // **認証故障が「その会社は存在しない」に化ける**。利用者は自分の入力ミスだと思い込み、
  // こちらの障害に気づけない（黙って失敗するより悪い）。
  // 404 を採用した根拠: 上流は「該当なし」も 404 で返す（実測）／一方で異常系の符号は既に
  // 別に確定している（401=認証層に到達、500=ルート未マッチ、429=制限）。よって 404 は区別できる。
  // 万一この前提が崩れても無言にはしない: diag.notFound=true / diag.status=404 と
  // [gbiz][EMPTY-404] ログが残るので、後から「404 を該当なしに倒した件数」を数えられる。
  if (!search.ok && search.status === 404) {
    diag.step = "search-empty";
    diag.notFound = true;
    console.warn("[gbiz][EMPTY-404] 該当なしとして扱う name=" + q + "（401/500/429 は失敗のまま）");
    return { ok: true, status: 404, error: null, diag: diag, items: [] };
  }
  if (!search.ok) { diag.error = search.error; return { ok: false, status: search.status, error: search.error, diag: diag, items: [] }; }
  if (!Array.isArray(search.data) || !search.data.length) {
    // 法人データに無い（個人事業主・屋号・新設法人など）は正常系。エラー扱いにしない。
    diag.step = "search-empty";
    return { ok: true, status: search.status, error: null, diag: diag, items: [] };
  }
  diag.hits = search.data.length;
  diag.step = "search-done";
  diag.ok = true;   // 上流から候補が取れた（search-empty と混同しないよう必ず立てる）
  const norm = function (x) {
    return {
      corporateNumber: x && x.corporate_number ? String(x.corporate_number) : null,
      name: (x && x.name) || null,
      location: (x && x.location) || null,
      status: (x && x.status) || null,
      kind: (x && x.kind) || null,
      industry: (x && Array.isArray(x.industry) && x.industry[0]) ? (JSIC_MAJOR[x.industry[0]] || x.industry[0]) : null,
      established: (x && x.date_of_establishment) || null,
      url: (x && x.company_url) || null
    };
  };
  const all = search.data
    .map(norm)
    .filter(function (x) { return x.corporateNumber && isCorporateNumber(x.corporateNumber); });
  // 現存（status "-"）を先に。廃業・登記閉鎖は選ばせる候補として後ろへ。
  const live = all.filter(function (x) { return x.status === "-"; });
  const dead = all.filter(function (x) { return x.status !== "-"; });
  const items = live.concat(dead).slice(0, 10);
  return { ok: true, status: search.status, error: null, diag: diag, items: items };
}

// 選ばれた法人番号の詳細を取り、プロンプトに渡す事実の配列に組み立てる。
// 法人番号で引くので同名別法人の混入は起きない（＝P0-0 の要）。
export async function gbizDetail(corporateNumber) {
  const diag = emptyDiag();
  if (!gbizToken()) {
    diag.step = "no-token";
    diag.error = "GBIZ_API_TOKEN が未設定（Vercel の環境変数を確認）";
    console.warn("[gbiz][SKIP] " + diag.error);
    return { ok: false, diag: diag, result: null };
  }
  const cn = String(corporateNumber || "");
  if (!isCorporateNumber(cn)) {
    diag.step = "invalid-corporate-number";
    diag.error = "法人番号が不正です（13桁の数字が必要）";
    console.error("[gbiz][FAIL] " + diag.error + " value=" + JSON.stringify(corporateNumber));
    return { ok: false, diag: diag, result: null };
  }
  diag.corporateNumber = cn;
  try {
    diag.step = "detail";
    const [baseRes, patRes, subRes, proRes, certRes, wpRes] = await Promise.all([
      gbizGet("/" + cn),
      gbizGet("/" + cn + "/patent"),
      gbizGet("/" + cn + "/subsidy"),
      gbizGet("/" + cn + "/procurement"),
      gbizGet("/" + cn + "/certification"),
      gbizGet("/" + cn + "/workplace")
    ]);
    diag.status = baseRes.status;
    const one = function (r) { return (r && r.ok && r.data && r.data[0]) || null; };
    const base = one(baseRes);
    const patent = one(patRes);
    const subsidy = one(subRes);
    const procurement = one(proRes);
    const cert = one(certRes);
    const wp = one(wpRes);
    if (!base) {
      // 上流の理由（401 / 500 / 空応答）を握りつぶさない。
      // 「取得できませんでした」だけでは、トークン失効なのか該当なしなのか切り分けられない。
      diag.step = "detail-empty";
      diag.error = baseRes.ok ? "detail-empty" : (baseRes.error || "detail-empty");
      console.error("[gbiz][FAIL] 基本情報の取得に失敗 cn=" + cn + " status=" + baseRes.status + " error=" + diag.error);
      return { ok: false, diag: diag, result: null };
    }

    const facts = buildFacts(base, { patent: patent, subsidy: subsidy, procurement: procurement, cert: cert, wp: wp });
    if (!facts.length) { diag.step = "no-facts"; return { ok: false, diag: diag, result: null }; }
    diag.ok = true;
    diag.step = "done";
    const matched = {
      name: base.name || null,
      location: base.location || null,
      corporateNumber: cn
    };
    const ident = [
      base.name ? "法人名: " + base.name : null,
      base.location ? "所在地: " + base.location : null,
      "法人番号: " + cn
    ].filter(Boolean).join("／");
    return {
      ok: true,
      diag: diag,
      result: {
        source: "gbiz",
        facts: facts,
        matched: matched,
        note: "経済産業省 gBizINFO（政府保有法人データ）の登録情報を使用（" + ident +
          "）。データは更新タイミングにより最新でない場合があります。最終確認は企業の公式サイトで。出典：gBizINFO"
      }
    };
  } catch (e) {
    diag.step = "exception";
    diag.error = (e && e.message) || String(e);
    console.error("[gbiz][FAIL] 予期しない例外: " + diag.error);
    return { ok: false, diag: diag, result: null };
  }
}

// 事実の組み立て。プロンプトに渡す「企業情報」そのものになるため、
// ここに無いものはモデルも書けない（＝捏造の余地を作らない）。
export function buildFacts(base, extra) {
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
  const patent = extra && extra.patent;
  const subsidy = extra && extra.subsidy;
  const procurement = extra && extra.procurement;
  const cert = extra && extra.cert;
  const wp = extra && extra.wp;
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
  return f;
}
