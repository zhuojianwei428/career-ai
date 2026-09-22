/* 就活AI 共有エンジン
 * - 生成: フォーム収集 → /api/generate → 編集可能な文書として表示
 * - 編集: contenteditable でその場で修正
 * - 写真: FileReader でプレビュー（履歴書・職務経歴書）
 * - 出力: 全文コピー（クリップボード・P0-4）
 */
window.CareerAI = (function () {
  "use strict";

  /* ---------- Analytics（GA4） ----------
   * 計測 ID はこの1か所だけで管理する（各 HTML に散らすと更新漏れするため）。
   * 空文字のあいだは gtag.js を読み込まず、track() は何もしない（ページへの影響ゼロ）。
   * <meta name="ga4-id" content="G-XXXXXXX"> を置けばそちらが優先される。
   * 目的は「どのページで、どこまで進んで、どこで離脱したか」の把握のみ。
   * 広告向け信号は送らない（匿名 Cookie の上限判定を壊さないため）。
   */
  var GA4_ID = "";
  var ga4Primed = false;
  var ga4ScriptLoaded = false;

  function ga4Id() {
    var m = document.querySelector('meta[name="ga4-id"]');
    var v = (m && m.getAttribute("content")) || GA4_ID;
    return (v || "").trim();
  }

  /* 同期処理：dataLayer と gtag のスタブだけを用意する（外部スクリプトは読まない）。
   * これを load まで遅らせると、load より前に起きたイベント
   * （遅い回線でフォーム送信や例の投入が先に走るケース）が捨てられる。
   * gtag.js は dataLayer を後から順に再生するので、先に積んでおけば取りこぼさない。
   * ID が未設定のあいだは何も作らない（ページへの影響ゼロ）。 */
  function primeGtag() {
    if (ga4Primed) return;
    var id = ga4Id();
    if (!id) return;
    ga4Primed = true;
    window.dataLayer = window.dataLayer || [];
    if (typeof window.gtag !== "function") {
      window.gtag = function () { window.dataLayer.push(arguments); };
    }
    window.gtag("js", new Date());
    window.gtag("config", id, { anonymize_ip: true });
  }

  // load 後に呼ぶ：重い外部スクリプトの読み込みだけを遅らせる（LCP/INP を悪化させない）
  function loadGtagScript() {
    if (!ga4Primed || ga4ScriptLoaded) return;
    ga4ScriptLoaded = true;
    var s = document.createElement("script");
    s.async = true;
    s.src = "https://www.googletagmanager.com/gtag/js?id=" + encodeURIComponent(ga4Id());
    document.head.appendChild(s);
  }

  // 計測の失敗で生成や登録を止めない（必ず握りつぶす）
  function track(name, params) {
    try {
      primeGtag();                       // ID 未設定ならここで return（何も起きない）
      if (typeof window.gtag !== "function") return;
      window.gtag("event", name, params || {});
    } catch (e) { /* noop */ }
  }

  function collect(form) {
    const vals = {};
    const nodes = form.querySelectorAll("[data-field]");
    nodes.forEach(function (n) {
      const key = n.getAttribute("data-field");
      if (n.matches('input[type=text], input[type=url], textarea, select')) {
        vals[key] = (n.value || "").trim();
      } else if (n.classList.contains("chip")) {
        if (n.getAttribute("aria-pressed") === "true") {
          vals[key] = n.getAttribute("data-value") || n.textContent.trim();
        }
      }
    });
    return vals;
  }

  /* 本文中の【 】のうち、どれが「穴埋め対象」かを決める。
   * 【 】には3種類が混在していて、同じ正規表現で全部拾うと
   *   ① 履歴書の見出し（【学歴】【志望動機】…）
   *   ② 免責文の【 】（中身が空）
   * まで「クリックで埋められる空欄」として扱ってしまう（誤操作と混乱の元）。
   * 見出しは既知の数個しかないので、中身が空のもの・見出し語のものを除外する。
   * 残り＝モデルが「事実が無いので残した」穴埋めなので、クリックで埋められる。 */
  var SECTION_LABELS = {
    "学歴": 1, "職歴": 1, "志望動機": 1, "自己PR": 1,
    "自分の強み": 1, "エピソード": 1, "よく聞かれる質問と回答の構成": 1
  };
  function isFillTarget(inner) {
    const s = (inner || "").trim();
    if (!s) return false;
    return !Object.prototype.hasOwnProperty.call(SECTION_LABELS, s);
  }

  /* 穴を「主观动机类 / 客観事実类」の2種に分類する（2026-09-22 の赤線 #1 運用）。
   * 主观动机类：事業内容への共感・志望理由・入社後にやりたいこと・自己PR 等、事実としては
   *   存在せず「あなただけが書ける」もの。ここをAIが埋める＝面接で「具体的にどこが？」と
   *   問われた瞬間に破綻する捏造。よって**補完UIでも一切代筆せず、型だけ提示**。
   * 客観事実类：事業内容・企業名・職務経験・保有スキル等、利用者が入力済み・または公開情報から
   *   書けるもの。具体的事実（業務の中身・数字）を促す。
   * 分類は補完モーダルの案内を切り替えるために使い、穴の残り数などの判定には使わない。 */
  function holeCategory(label) {
    const s = (label || "").trim();
    if (/共感|志望|やりたい|入社後|自己PR|強み|なぜ|興味|動機|想い|魅力|貢献したい|関わりたい|働きたい|熱意|こだばり|理由|価値観|やりがい|思い|理解/.test(s)) return "subj";
    if (/事業内容|企業名|職務|経験|スキル|成果|学び|エピソード|資格|担当|保有|実績|沿革|取扱|サービス|商品|専門|技術/.test(s)) return "obj";
    return "?";
  }

  function toParagraphs(text) {
    const safe = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    // 【…】プレースホルダを強調（不捏造の証拠）。穴埋め対象のものだけ操作可能にする。
    const marked = safe.replace(/【([^】]*)】/g, function (all, inner) {
      return isFillTarget(inner) ? '<mark class="ph" data-ph="1">' + all + "</mark>" : all;
    });
    return marked
      .split(/\n{2,}/)
      .map(function (block) {
        const inner = block.replace(/\n/g, "<br>");
        return "<p>" + (inner || "&nbsp;") + "</p>";
      })
      .join("");
  }

  function setStatus(msg, kind) {
    const el = document.getElementById("status");
    if (!el) return;
    el.textContent = msg || "";
    el.className = "muted" + (kind ? " status-" + kind : "");
  }

  function showContextNote(data) {
    const el = document.getElementById("ctx-note");
    if (!el) return;
    if (data && data.notice) {
      el.textContent = "※ " + data.notice;
      el.hidden = false;
    } else if (data && data.companyContextUsed) {
      el.textContent = "※ 公開情報から企業固有の内容を抽出しました。事実と異なればご自身で修正してください。";
      el.hidden = false;
    } else {
      el.hidden = true;
    }
  }

  /* P0-5: 生成時にログインを求めたときの「保留中の生成」。
   * ログイン完了後に同じ条件で自動再開する（＝もう一度ボタンを押させない）。
   * 入力内容は保持の必要がない —— ログインはオーバーレイでフォームを再描画しないため、
   * DOM の値がそのまま残っている。ここで保持するのは「何を生成しようとしたか」だけ。 */
  var pendingGenerate = null;
  function resumePendingGenerate() {
    const p = pendingGenerate;
    pendingGenerate = null;
    if (!p) return;
    // 可観測性: 「ログイン後に同じ生成が自動で続いた」は実機で能動検証しづらい（登録にメール認証が要る）。
    // 静かに通させない —— GA4 イベントと console の両方に残し、実利用者のデータで発火を確認できるようにする。
    // イベント名は test-seo-lp.mjs の EXPECTED_EVENTS にも登録済み（足し忘れるとテストが落ちる）。
    track("generate_resumed_after_login", { tool: (p.config && p.config.tool) || "custom" });
    console.info("[P0-5] ログイン後に保留生成を自動再開 tool=" + ((p.config && p.config.tool) || "custom"));
    generate(p.formId, p.resultId, p.config);
  }

  /* P0-5（改）: ログインを求めるのは「匿名の上限に達した瞬間」だけ。
   * 毎回の生成で門を出すと、既定の匿名枠（未ログイン2回/日）が一度も使われず、
   * 新規訪問者が価値を見る前に登録を求められて離脱する —— 新規サイトでは
   * 行動データが貯まらず順位にも不利。まず価値を渡し、上限に当たった時に登録を促す。
   * 上限の判定はサーバ（匿名はCookie・ログイン中はRedis）が唯一の正。クライアントで数え直さない。
   * 認証ストアが使えないときは門を作らない（入口を塞ぐと全員が生成不能になる＝劣化ではなく全停止）。 */
  /* この関数は「上限に達した」ときだけ呼ばれる。以前は残り 0 回でも
   * 「あと0回、ログインなしで生成できます。」と出していて、できる/できないが
   * 文面上で矛盾していた（実装＝もう生成できない）。到達を事実として述べる形にする。
   * 「2回」は実装値（Auth.limits().anon）から取る —— 手で書くと上限を変えた時に
   * 文言だけ古くなり、約束と実装がずれる。 */
  function loginOfferText() {
    const lim = (Auth && Auth.limits && Auth.limits()) || {};
    const a = lim.anon || 2, l = lim.logged || 5;
    return "本日のログインなしでの生成は上限（" + a + "回）に達しました。ログインすると入力内容はそのまま引き継がれ、1日" + l + "回まで生成できます。";
  }

  async function generate(formId, resultId, config) {
    const form = document.getElementById(formId);
    const result = document.getElementById(resultId);
    if (!form || !result || !config) return;
    const btn = form.querySelector('button[type=submit]') || document.getElementById("gen-btn");
    const vals = collect(form);

    const missing = (config.required || []).filter(function (k) { return !vals[k]; });
    if (missing.length) {
      setStatus("入力が足りない項目があります：「" + missing.join("、") + "」", "warn");
      return;
    }

    // P0-5（改）: ここではログインを求めない。未ログインでも匿名枠（既定2回/日）の範囲で
    // そのまま生成できる。門は「上限に達した」応答（下の 429 分岐）でだけ開く。
    // 理由: 毎回弾くと匿名枠が架空になり、価値を見る前の登録要求で訪問者が離脱する。

    // P0-0: 企業の確認が済むまで生成させない（確認済みの法人番号だけを送る）。
    // 同名の別法人に当たると「事実だが別会社」の情報が混ざり、利用者はより気づきにくい。
    // ただし「確認できない」で行き止まりにしない —— 該当なし・未設定・通信失敗のときは
    // CompanyConfirm 側が自動で fallback に落とすので、ここでは止めない。
    const cc = CompanyConfirm.get(formId);
    let ccPayload = null;
    if (cc) {
      if (cc.status() === "searching") {
        setStatus("企業名の候補を検索しています。数秒お待ちください。", "warn");
        return;
      }
      if (!cc.isResolved()) {
        setStatus("企業名の候補を確認してください（別会社の情報が混ざるのを防ぐため）。候補が無い場合はそのまま生成できます。", "warn");
        cc.start();
        return;
      }
      ccPayload = cc.payload();
    }

    let payload;
    if (config.structured) {
      payload = { tool: config.tool || "shibou", fields: vals, model: config.model || null };
      if (ccPayload) payload.gbiz = ccPayload;
    } else {
      const userMsg = config.buildUser(vals);
      const messages = [
        { role: "system", content: config.system },
        { role: "user", content: userMsg }
      ];
      payload = { messages: messages, model: config.model || null };
    }

    if (btn) { btn.disabled = true; btn.dataset.label = btn.innerHTML; btn.innerHTML = '<span class="spinner"></span> 生成中…'; }
    setStatus("AI が精密に作成しています…");
    // ファネル計測：入力完了して実際に生成を押した地点
    track("generate_start", {
      tool: config.tool || "custom",
      scene: vals["応募種別"] || "",
      length: vals["文字数"] || "",
      tone: vals["トーン"] || "",
      has_company: vals["企業名"] ? 1 : 0,
      has_jd: vals["企業情報"] ? 1 : 0,
      company_confirmed: ccPayload && ccPayload.corporateNumber ? 1 : 0
    });

    try {
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (res.status === 429 && data && data.limitReached) {
        // 上限到達＝登録の動機が最も高い瞬間。ここを分母に登録率を見る。
        track("limit_reached", {
          tool: config.tool || "custom",
          logged_in: (Auth && Auth.isLoggedIn && Auth.isLoggedIn()) ? 1 : 0
        });
        // P0-5（改）: 匿名の枠を使い切った「この瞬間」だけログインを促す。
        // 入力はモーダル（フォームを再描画しないオーバーレイ）の後ろにそのまま残り、
        // ログインが済んだら resumePendingGenerate() が同じ生成を自動で再開する。
        // ストア未設定/障害時はここも開かない（門を作ると誰も生成できなくなる）。
        if (Auth && Auth.limits && Auth.isLoggedIn && Auth.limits().configured && !Auth.isLoggedIn()) {
          pendingGenerate = { formId: formId, resultId: resultId, config: config };
          track("generate_login_required", {
            tool: config.tool || "custom",
            has_company: vals["企業名"] ? 1 : 0,
            has_jd: vals["企業情報"] ? 1 : 0,
            remaining: 0
          });
          setStatus(loginOfferText(), "warn");
          // 押した瞬間に無効化したボタンを戻す（ログイン後の自動再開のため）
          if (btn) { btn.disabled = false; if (btn.dataset.label) btn.innerHTML = btn.dataset.label; }
          Auth.openModal();
          return;
        }
        setStatus(data.error || "本日の生成上限に達しました。", "warn");
        if (btn) { btn.disabled = true; btn.innerHTML = "本日の上限に達しました"; }
        return;
      }
      if (!res.ok || !data.text) {
        throw new Error(data.error || ("HTTP " + res.status));
      }
      result.innerHTML = toParagraphs(data.text.trim());
      result.classList.remove("placeholder");
      makeEditable(result);
      showContextNote(data);
      refreshDoc();
      // 履歴の保存はサーバ側（/api/generate 内で session がある場合のみ）で行う。
      // ここで再度 POST すると1回の生成で履歴が2件重複するため、クライアントからは保存しない。
      // remaining=0 で「あと 0 回」と出すと、直前の上限到達文案（「上限に達しました」）と
      // 同じ UI で食い違う（まだ生成できるように読める）。0 は事実をそのまま述べる。
      const rem = (data.remaining == null) ? ""
        : (data.remaining === 0 ? "（本日の上限に達しました）" : "（本日あと " + data.remaining + " 回）");
      const phLeft = countPh(result);
      // ファネル計測：生成が実際に成果物を返した地点（＝このページの主目的の達成）
      track("generate_success", {
        tool: config.tool || "custom",
        company_context: data.companyContextUsed ? 1 : 0,
        had_gap: data.missingExperience ? 1 : 0,
        demo: data.mock ? 1 : 0,
        truncated: data.truncated ? 1 : 0,
        gaps_left: phLeft,
        multi_holes: data.multiHoleSentences || 0
      });
      // P0-3 の殘留（同一文に穴が2つ以上）。サーバ側の**確定判定**で受け取る。
      // prompt を 3 ラウンド改めても消えなかった形なので、消せないものをせめて可視化する。
      // 穴が殘っているときだけ添える（穴が無いのに「同じ文に2つ」と言うのは意味不明）。
      const mh = data.multiHoleSentences || 0;
      const mhNote = (mh > 0 && phLeft > 0)
        ? " ※同じ文に【 】が2つ以上ある箇所が " + mh + " 件あります（1つずつクリックで埋められます）。"
        : "";
      let msg, kind = "ok";
      if (data.truncated) {
        // 上限で切れた文をそのまま「完成」と言わない（字数カウンタとも辻褄が合わなくなる）
        msg = "生成しましたが、文が途中で切れた可能性があります。もう一度生成するか、文字数の目安を短くしてください。";
        kind = "warn";
      } else if (data.companyContextUsed) {
        // 利用者は P0-0 で既に確認済みなので、「確認が必要」という但し書きを添えると自己矛盾する
        msg = "選んだ法人の登録情報を反映しました（確認済み・法人番号つき）。そのまま編集できます。";
      } else if (phLeft) {
        msg = "入力が足りない箇所は【 】のまま残しました（" + phLeft + " 箇所）。クリックするとその場で埋められます。";
        kind = "warn";
      } else if (data.missingExperience) {
        msg = "入力が足りない箇所は【 】のまま残しました。ご自身の言葉で埋めてください。";
        kind = "warn";
      } else if (data.mock) {
        msg = "※デモ出力です（APIキー未設定のためテンプレート表示）。本番では実際の AI が生成されます。";
        kind = "warn";
      } else {
        msg = "生成完了。そのまま編集できます。";
      }
      setStatus(msg + mhNote + rem, kind);
    } catch (e) {
      setStatus("生成に失敗しました：" + e.message, "warn");
      track("generate_error", { tool: config.tool || "custom", message: String(e.message).slice(0, 100) });
    } finally {
      if (btn) { btn.disabled = false; btn.innerHTML = btn.dataset.label || "生成する"; }
    }
  }

  /* ================= 文字数カウンタ（P0-6） =================
   * モデルは文末に「（文字数：698字）」を混ぜるが、その数字は実際と食い違う（実測 698 対 579）。
   * サーバ側で自己申告は落としている（api/generate.js の stripSelfReport）が、
   * カウンタ自体もモデルの申告を使わず、こちらで数える。
   * Intl.Segmenter は絵文字や結合文字を1文字として数えるので見た目と数が合う
   * （未対応ブラウザはコードポイント数にフォールバック）。改行は数えない。 */
  function countChars(text) {
    const t = String(text || "").replace(/[\n\r]/g, "");
    if (!t) return 0;
    try {
      if (typeof Intl !== "undefined" && typeof Intl.Segmenter === "function") {
        const seg = new Intl.Segmenter("ja", { granularity: "grapheme" });
        let n = 0;
        for (const _ of seg.segment(t)) n++;
        return n;
      }
    } catch (e) { /* フォールバックへ */ }
    return Array.from(t).length;
  }

  // 「300〜500字」→ {min:300,max:500}。目安が無いページ（面接対策など）では null。
  function parseRange(v) {
    const m = String(v || "").match(/(\d{2,4})\s*[〜~\-ー–]\s*(\d{2,4})/);
    if (!m) return null;
    const a = parseInt(m[1], 10), b = parseInt(m[2], 10);
    if (!a || !b) return null;
    return { min: Math.min(a, b), max: Math.max(a, b) };
  }

  /* ================= 結果ドキュメントの付随 UI =================
   * 5ページ共通。器（.toolbar / #result）は各HTMLに置いてあるので、
   * 中身だけをここで足す（HTML側に散らすと更新漏れするため）。 */
  var docState = { resultId: "result" };
  function docEl() { return document.getElementById(docState.resultId); }
  function formEl() { return document.getElementById("gen-form"); }
  function formValues() { const f = formEl(); return f ? collect(f) : {}; }

  function ensureCountEl(result) {
    let el = document.querySelector("[data-char-count]");
    if (el) return el;
    el = document.createElement("p");
    el.className = "doc-count no-print";
    el.setAttribute("data-char-count", "");
    el.hidden = true;
    result.parentNode.insertBefore(el, result.nextSibling);
    return el;
  }

  function countPh(root) {
    return root ? root.querySelectorAll("mark.ph[data-ph]").length : 0;
  }

  function updateCount() {
    const result = docEl();
    if (!result) return;
    const el = ensureCountEl(result);
    if (!el) return;
    const empty = result.classList.contains("placeholder");
    const text = empty ? "" : (result.innerText || result.textContent || "");
    const n = countChars(text);
    if (!n) { el.hidden = true; el.textContent = ""; el.classList.remove("over", "under"); return; }
    const range = parseRange(formValues()["文字数"]);
    const ph = countPh(result);
    const parts = ["いま " + n + " 字（改行を除く）"];
    if (range) parts.push("目安 " + range.min + "〜" + range.max + "字");
    if (ph) parts.push("【 】が残り " + ph + " 箇所");
    el.textContent = parts.join("　/　");
    // 目安オーバーは「削られていないか確認」の合図。少なすぎは穴埋め待ちなので警告にしない。
    el.classList.toggle("over", !!range && n > range.max && ph === 0);
    el.classList.toggle("under", !!range && n < range.min && ph === 0);
    el.hidden = false;
  }

  function updatePhButton() {
    const btn = document.querySelector("[data-fill-ph]");
    if (!btn) return;
    const n = countPh(docEl());
    btn.hidden = !n;
    btn.textContent = n ? "【 】を埋める（" + n + "）" : "【 】を埋める";
  }

  function refreshDoc() { updateCount(); updatePhButton(); }

  /* ================= 全文コピー（P0-4） =================
   * このページの成果物は「文章そのもの」なので、コピーが最も価値の高い一手。
   * 生成結果の外（免責や注記）を含めず、本文だけをコピーする。 */
  async function writeClipboard(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (e) { /* 古いブラウザ・権限なしはフォールバックへ */ }
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.top = "-1000px";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      return ok;
    } catch (e) { return false; }
  }

  async function copyAll(btn) {
    const result = docEl();
    if (!result || result.classList.contains("placeholder")) {
      setStatus("まだ生成結果がありません。先に「生成する」を押してください。", "warn");
      return;
    }
    const text = (result.innerText || "").replace(/\u00a0/g, " ").replace(/\n{3,}/g, "\n\n").trim();
    if (!text) { setStatus("コピーできる本文がありません。", "warn"); return; }
    const ok = await writeClipboard(text);
    if (!ok) { setStatus("コピーできませんでした。本文を選択してコピーしてください。", "warn"); return; }
    track("copy_all", { chars: countChars(text) });
    if (btn) {
      if (!btn.dataset.label) btn.dataset.label = btn.textContent;
      btn.textContent = "コピーしました";
      setTimeout(function () { btn.textContent = btn.dataset.label || "全文コピー"; }, 1600);
    }
    setStatus("全文をコピーしました。応募フォームや履歴書に貼り付けられます。", "ok");
  }

  /* ================= 【 】をクリックで埋める（P0-3） =================
   * 「穴が残っている」を欠点で終わらせず、その場で埋められるようにする。
   * モーダルの見た目は .auth-modal の CSS をそのまま使う（新規デザインを増やさない）。 */
  var phModal = null, phTarget = null, phOpenCount = 0, phUnknownCount = 0;
  // 频控：同じセッションで何度も穴を埋めるとき、5回目以降は「例句・詳しい説明」だけを省く。
  // 信任锚点（「AIは代筆しません」＋主客観ラベ）は省かない——消すと「今回はAIが書いてくれるはず」
  // と勘違いし、代筆を待つよう誘導してしまう（赤線#1 の逆走）。
  var PH_GUIDE_TRIM_AFTER = 5;

  function ensurePhModal() {
    if (phModal) return phModal;
    phModal = document.createElement("div");
    phModal.className = "auth-modal ph-modal";
    phModal.hidden = true;
    phModal.innerHTML =
      '<div class="auth-backdrop" data-ph-close="1"></div>' +
      '<div class="auth-card" role="dialog" aria-modal="true" aria-label="空欄を埋める">' +
        '<button type="button" class="auth-x" data-ph-close="1" aria-label="閉じる">×</button>' +
        '<p class="ph-label" id="ph-label"></p>' +
        '<span class="ph-kind" id="ph-kind"></span>' +
        '<div class="ph-guidance" id="ph-guidance"></div>' +
        '<textarea id="ph-input" rows="4" placeholder=""></textarea>' +
        '<p class="auth-err" id="ph-err"></p>' +
        '<div class="ph-actions">' +
          '<button type="button" class="btn block" id="ph-save">この内容を反映</button>' +
          '<button type="button" class="btn ghost block mini" data-ph-close="1">あとで埋める</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(phModal);
    phModal.querySelectorAll("[data-ph-close]").forEach(function (el) {
      el.addEventListener("click", closePhModal);
    });
    phModal.querySelector("#ph-save").addEventListener("click", function () {
      const v = (phModal.querySelector("#ph-input").value || "").trim();
      const err = phModal.querySelector("#ph-err");
      if (!v) { err.textContent = "内容を入力してください。"; return; }
      if (/^【[^】]*】$/.test(v)) { err.textContent = "【 】のままになっています。具体的な内容を入力してください。"; return; }
      applyPh(v);
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && phModal && !phModal.hidden) closePhModal();
    });
    return phModal;
  }

  function openPhModal(mark) {
    if (!mark) return;
    ensurePhModal();
    phTarget = mark;
    const label = (mark.textContent || "").replace(/^【|】$/g, "");
    const raw = holeCategory(label);
    // 未知ラベル（「?」）は保守的に「主观」扱い（赤線#1 の非対称リスク）：
    // ・誤って客観と判断 → 事実の例を出す → 利用者が動機の代わりに事業内容を書くよう誘導 ＝ 捏造共感と同罪。
    // ・誤って主观と判断 → 最坏でも「もう1文書かせる」だけで、赤線には触れない。
    // よって「?」は必ず主观に落とす（安全側）。同時に「?」の増加を打点する——
    // ある日突然増えれば、モデルが新しいラベル型を出力した信号（分類表の更新が必要）。
    let cat = raw;
    if (raw === "?") {
      phUnknownCount++;
      console.log("[ph][unknown-category] label=\"" + label + "\" total=" + phUnknownCount);
      cat = "subj";
    }
    phOpenCount++;
    // 信任锚点（「AIは代筆しません」＋主客観ラベ）は常に表示。
    // 频控は「例句・詳しい説明」だけを省く——5回目以降も锚点は絶対に消さない。
    const verbose = phOpenCount <= PH_GUIDE_TRIM_AFTER;
    phModal.querySelector("#ph-label").textContent = "【" + label + "】を埋める";
    const kind = phModal.querySelector("#ph-kind");
    const guide = phModal.querySelector("#ph-guidance");
    const input = phModal.querySelector("#ph-input");
    if (cat === "subj") {
      // 主观动机类：あなただけが書ける。AIは型だけ示し、絶対に代筆しない。
      kind.textContent = "動機・思い（あなただけが書けます）";
      kind.className = "ph-kind ph-kind-subj";
      // 信任锚点：常に「AIは代筆しません」（省かない）
      let html = '<b>AIは代筆しません。</b>';
      if (verbose) {
        html += ' 面接で「具体的にどこが響きましたか？」と問われるので、ここはご自身の言葉で埋めてください。<br>書き方の型：<br><span class="ph-frame">貴社の◯◯という取り組みに、△△という点で共感しました</span>';
      } else {
        html += ' ご自身の言葉で埋めてください。';
      }
      guide.innerHTML = html;
      input.placeholder = "例：貴社の地域に密着したリフォーム事例に、暮らしに寄り添う姿勢に共感しました";
    } else {
      // 客観事実类（防御的実装：実測 0/14 で未検証。将来データソースが変わり客観類の穴が出たときに発動）。
      // 具体的事実（業務の中身・数字）を促す。抽象形容はNG。
      kind.textContent = "事実・経験（入力した内容から）";
      kind.className = "ph-kind ph-kind-obj";
      // 信任锚点：事実も「ご入力からのみ」であることを常に宣言（客観だからこそ「AIが埋めてくれる」誤認を防ぐ）
      let html = '<b>AIは代筆しません。</b>（事実もご入力からのみ）';
      if (verbose) {
        html += ' 具体的な事実を入れてください。抽象的な形容（「すばらしい会社」等）ではなく、<strong>業務の中身や数字</strong>を。<br>書き方の型：<br><span class="ph-frame">木造住宅の設計・施工／自動車部品のプレス加工</span>';
      } else {
        html += ' 具体的な事実（業務の中身・数字）を入れてください。';
      }
      guide.innerHTML = html;
      input.placeholder = "例：木造住宅の設計・施工、チーム5人で企画を進めた";
    }
    input.value = "";
    phModal.querySelector("#ph-err").textContent = "";
    phModal.hidden = false;
    setTimeout(function () { input.focus(); }, 30);
  }

  function closePhModal() {
    if (phModal) phModal.hidden = true;
    phTarget = null;
  }

  function applyPh(value) {
    if (!phTarget || !phTarget.parentNode) { closePhModal(); return; }
    const label = (phTarget.textContent || "").replace(/^【|】$/g, "");
    const text = document.createTextNode(value);
    phTarget.parentNode.replaceChild(text, phTarget);
    if (text.parentNode && text.parentNode.normalize) text.parentNode.normalize();
    closePhModal();
    refreshDoc();
    track("ph_fill", { label: label, chars: countChars(value) });
    setStatus("空欄を1箇所埋めました。残りはご自身の言葉で埋められます。", "ok");
  }

  /* ================= モバイルでの編集（P0-7） =================
   * 狭い画面では編集領域が小さく、キーボードで隠れて文が見えない。
   * 編集開始時に全画面へ切り替え、visualViewport の高さに追従させる。 */
  function isNarrow() {
    return !!(window.matchMedia && window.matchMedia("(max-width: 40rem)").matches);
  }
  function ensureDoneBtn() {
    let b = document.querySelector("[data-edit-done]");
    if (b) return b;
    b = document.createElement("button");
    b.type = "button";
    b.className = "btn edit-done no-print";
    b.setAttribute("data-edit-done", "");
    b.textContent = "編集を終える";
    b.hidden = true;
    b.addEventListener("click", exitEditFull);
    document.body.appendChild(b);
    return b;
  }
  function enterEditFull() {
    if (document.body.classList.contains("edit-full")) return;
    document.body.classList.add("edit-full");
    const b = ensureDoneBtn();
    if (b) b.hidden = false;
    syncViewportHeight();
  }
  function exitEditFull() {
    document.body.classList.remove("edit-full");
    const b = document.querySelector("[data-edit-done]");
    if (b) b.hidden = true;
    refreshDoc();
  }
  function syncViewportHeight() {
    const vv = window.visualViewport;
    if (!vv) return;
    document.documentElement.style.setProperty("--vvh", Math.round(vv.height) + "px");
  }

  /* ================= 入力補助（P0-2） ================= */
  // 応募種別ごとに「何を書けばいいか」が変わるので、プレースホルダも切り替える。
  var SCENE_PLACEHOLDERS = {
    "新卒": {
      "職種": "例：総務・人事、ITエンジニア、経済学部",
      "経験・キーワード": "例：ゼミの研究で地域課題をフィールドワーク。チームで調査報告書を作成した。",
      "企業情報": "公式採用ページや募集要項のURLを貼ると、事業・技術・課題を抽出します。テキストを直接貼ってもOK。"
    },
    "転職": {
      "職種": "例：法人営業、Webエンジニア、経理",
      "経験・キーワード": "例：前職で法人営業を担当。担当顧客を30社から52社に拡大した。",
      "企業情報": "求人票や募集要項のURL・本文を貼ると、求める役割と事業内容を反映します。"
    },
    "バイト": {
      "職種": "例：カフェスタッフ、コンビニ、軽作業",
      "経験・キーワード": "例：週3日・土日勤務可。接客とレジ締めを担当した経験がある。",
      "企業情報": "店舗の募集ページや「こんな人を求めています」の文言を貼ると反映します。"
    },
    "進学": {
      "職種": "例：経済学部、情報工学科、大学院",
      "経験・キーワード": "例：高校で文化祭の企画責任者を務めた。統計の授業でデータ分析に興味を持った。",
      "企業情報": "志望校のアドミッションポリシーや学部紹介を貼ると、方針に沿った内容にします。"
    }
  };

  function applyScenePlaceholders(form, scene) {
    const map = SCENE_PLACEHOLDERS[scene];
    if (!map) return;
    Object.keys(map).forEach(function (key) {
      form.querySelectorAll('[data-field="' + key + '"]').forEach(function (n) {
        if (n.matches("input, textarea")) n.setAttribute("placeholder", map[key]);
      });
    });
  }

  function bindDynamicPlaceholders(formId) {
    const form = document.getElementById(formId);
    if (!form) return;
    form.querySelectorAll('.chip[data-group="scene"]').forEach(function (c) {
      c.addEventListener("click", function () {
        applyScenePlaceholders(form, c.getAttribute("data-value"));
      });
    });
  }

  // 空欄を叱るのではなく「入れると何が変わるか」を1回だけ伝える。
  var gentleHintShown = false;
  function bindGentleHints(formId) {
    const form = document.getElementById(formId);
    if (!form) return;
    const ta = form.querySelector('[data-field="経験・キーワード"]');
    if (!ta) return;
    ta.addEventListener("blur", function () {
      if ((ta.value || "").trim() || gentleHintShown) return;
      gentleHintShown = true;
      setStatus("経験を入れると、あなた固有の文章になります（未入力の場合は【 】のまま残ります）。", "warn");
    });
  }

  // 書く切り口のタグ。【 】を挿入するだけで、事実や数字は入力させない（捏造しない）。
  var HINT_TAGS = ["経験の場面", "自分の役割", "成果・数字", "学び・強み"];
  function insertAtCursor(ta, text) {
    const start = ta.selectionStart == null ? ta.value.length : ta.selectionStart;
    const end = ta.selectionEnd == null ? ta.value.length : ta.selectionEnd;
    ta.value = ta.value.slice(0, start) + text + ta.value.slice(end);
    const pos = start + text.length;
    ta.focus();
    try { ta.setSelectionRange(pos, pos); } catch (e) { /* noop */ }
  }
  function injectHintTags(formId) {
    const form = document.getElementById(formId);
    if (!form) return;
    const ta = form.querySelector('[data-field="経験・キーワード"]');
    if (!ta || form.querySelector("[data-hint-tags]")) return;
    const wrap = document.createElement("div");
    wrap.className = "hint-tags no-print";
    wrap.setAttribute("data-hint-tags", "");
    const lead = document.createElement("span");
    lead.className = "hint-tags-lead";
    lead.textContent = "書くヒント：";
    wrap.appendChild(lead);
    HINT_TAGS.forEach(function (t) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "hint-tag";
      b.textContent = t;
      b.addEventListener("click", function () {
        insertAtCursor(ta, "【" + t + "】");
        track("hint_tag_insert", { tag: t });
      });
      wrap.appendChild(b);
    });
    const note = document.createElement("span");
    note.className = "hint-tags-note";
    note.textContent = "（押すと【 】が入ります。数字や事実はご自身で入力してください）";
    wrap.appendChild(note);
    ta.parentNode.insertBefore(wrap, ta.nextSibling);
  }

  /* ================= 企業確認（P0-0） =================
   * gBizINFO の法人名検索は同名の別法人を返すことがある（実測：架空の例「株式会社ミライテック」が
   * 沖縄の実在同名法人に命中）。捏造は「無中生有」だが、これは「実データの取り違え」で
   * 利用者はより気づきにくい。生成の前に候補を見せて選ばせ、選ばれた法人番号だけを使う。
   * ただし確認できないことを行き止まりにしない：該当なし・未設定・通信失敗のときは
   * 自動で「入力した企業名のみで生成」に落とす（生成機会を失わせない）。 */
  var CompanyConfirm = (function () {
    var states = {};

    function state(formId) { return states[formId] || null; }

    function attach(formId) {
      const form = document.getElementById(formId);
      if (!form) return null;
      const input = form.querySelector('[data-field="企業名"]');
      if (!input) return null;
      const field = input.closest(".field") || input.parentNode;
      const box = document.createElement("div");
      box.className = "company-box no-print";
      box.setAttribute("data-company-box", "");
      box.hidden = true;
      field.appendChild(box);
      const st = {
        formId: formId, input: input, box: box,
        status: "unconfirmed",   // unconfirmed | searching | candidates | confirmed | declined | fallback
        selected: null, facts: null, token: 0
      };
      states[formId] = st;
      // 名前を書き換えたら確認は無効（別会社の法人番号で生成する事故を防ぐ）
      input.addEventListener("input", function () {
        if (st.selected && (input.value || "").trim() !== st.selected.name) reset(st);
        else if (!st.selected && (st.status === "confirmed" || st.status === "declined" || st.status === "fallback")) reset(st);
      });
      input.addEventListener("blur", function () { maybeSearch(st); });
      return st;
    }

    function reset(st) {
      st.status = "unconfirmed";
      st.selected = null;
      st.facts = null;
      st.token++;
      hide(st);
    }

    function hide(st) { st.box.hidden = true; st.box.innerHTML = ""; }

    function message(st, text, kind) {
      st.box.hidden = false;
      st.box.innerHTML = "";
      const p = document.createElement("p");
      p.className = "company-msg" + (kind ? " " + kind : "");
      p.textContent = text;
      st.box.appendChild(p);
    }

    function maybeSearch(st) {
      const name = (st.input.value || "").trim();
      if (name.length < 2) return;
      if (st.status !== "unconfirmed") return;
      search(st);
    }

    async function search(st) {
      const name = (st.input.value || "").trim();
      if (name.length < 2) {
        message(st, "企業名を2文字以上入力すると、法人データの候補を確認できます。", "warn");
        return;
      }
      const my = ++st.token;
      st.status = "searching";
      message(st, "企業名の候補を検索しています…");
      let d = null;
      try {
        const r = await fetch("/api/company", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "search", name: name })
        });
        d = await r.json();
      } catch (e) {
        if (my !== st.token) return;
        // 失敗しても生成は可能にする（企業情報を必須にしない）
        st.status = "fallback";
        message(st, "企業データベースに接続できませんでした。入力された企業名と企業情報だけで生成します。", "warn");
        console.warn("[company] search failed:", e && e.message);
        return;
      }
      if (my !== st.token) return;
      if (!d || d.configured === false) {
        st.status = "fallback";
        message(st, (d && d.message) || "企業データベースは現在利用できません。入力された企業名だけで生成します。", "warn");
        return;
      }
      if (!d.ok) {
        st.status = "fallback";
        message(st, d.message || "企業データベースに接続できませんでした。入力された企業名だけで生成します。", "warn");
        console.warn("[company] search not ok:", d && d.error, d && d.diag);
        return;
      }
      const cands = (d.candidates || []).filter(function (c) { return c && c.corporateNumber; });
      if (!cands.length) {
        st.status = "fallback";
        message(st, d.message || "法人データに見つかりませんでした。入力された企業名だけで生成します。", "warn");
        return;
      }
      st.status = "candidates";
      renderCandidates(st, cands, name);
    }

    function renderCandidates(st, cands, query) {
      st.box.hidden = false;
      st.box.innerHTML = "";
      const head = document.createElement("p");
      head.className = "company-head";
      head.textContent = "「" + query + "」に一致する法人が " + cands.length + " 件あります。志望する企業を選んでください（同名の別会社が登録されていることがあります）。";
      st.box.appendChild(head);

      const group = document.createElement("div");
      group.className = "company-list";
      group.setAttribute("role", "radiogroup");
      group.setAttribute("aria-label", "法人の候補");
      cands.forEach(function (c) {
        const row = document.createElement("label");
        row.className = "company-item";
        const radio = document.createElement("input");
        radio.type = "radio";
        radio.name = "company-choice";
        radio.value = c.corporateNumber;
        radio.addEventListener("change", function () { confirmCandidate(st, c, message); });
        const body = document.createElement("span");
        body.className = "company-item-body";
        const nm = document.createElement("strong");
        nm.textContent = c.name || "(名称不明)";
        body.appendChild(nm);
        const meta = document.createElement("span");
        meta.className = "company-item-meta";
        const bits = [];
        if (c.location) bits.push(c.location);
        if (c.industry) bits.push(c.industry);
        if (c.established) bits.push("設立 " + c.established);
        bits.push("法人番号 " + c.corporateNumber);
        if (c.status && c.status !== "-") bits.push("登記閉鎖等");
        meta.textContent = bits.join(" ／ ");
        body.appendChild(meta);
        row.appendChild(radio);
        row.appendChild(body);
        group.appendChild(row);
      });
      st.box.appendChild(group);

      // 情報密度の補足（ユーザーの「所在地だけで本社と子会社を見分けられない」懸念への対応）。
      // 法人番号こそ一意の識別子。所在地は登記上の本店所在地であり、実際の勤務地・本社機能と
      // 異なることがあるため、所在地だけで決めず法人番号でも照合するよう促す。
      const hint = document.createElement("p");
      hint.className = "company-hint";
      hint.textContent = "法人番号は一意の識別子です。所在地は登記上の本店所在地で、実際の勤務地や本社機能と異なる場合があります。迷ったら、ご自身がご存知の法人番号で照合してください。";
      st.box.appendChild(hint);

      const btns = document.createElement("div");
      btns.className = "company-actions";
      const none = document.createElement("button");
      none.type = "button";
      none.className = "btn ghost mini";
      none.textContent = "リストに無い／企業情報を使わずに生成する";
      none.addEventListener("click", function () {
        st.status = "declined";
        st.selected = null;
        st.token++;
        message(st, "企業の登録情報は使わず、入力された企業名と企業情報だけで生成します。", null);
      });
      btns.appendChild(none);
      st.box.appendChild(btns);
    }

    async function confirmCandidate(st, c, msgFn) {
      const my = ++st.token;
      st.selected = { corporateNumber: c.corporateNumber, name: c.name, location: c.location };
      st.status = "confirmed";
      st.facts = null;
      renderConfirmed(st, null, "登録情報を確認しています…");
      // 生成に実際に使う情報を、生成の前に見せる（確認できる状態にする）
      try {
        const r = await fetch("/api/company", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "detail", corporateNumber: c.corporateNumber })
        });
        const d = await r.json();
        if (my !== st.token) return;
        st.facts = (d && d.ok && d.facts) || null;
        renderConfirmed(st, d && d.note ? d.note : null, st.facts ? null : "登録情報を取得できませんでした。入力された企業名と企業情報だけで生成します。");
      } catch (e) {
        if (my !== st.token) return;
        renderConfirmed(st, null, "登録情報を取得できませんでした。入力された企業名と企業情報だけで生成します。");
      }
    }

    function renderConfirmed(st, note, warn) {
      const s = st.selected || {};
      st.box.hidden = false;
      st.box.innerHTML = "";
      const ok = document.createElement("p");
      ok.className = "company-ok";
      ok.textContent = "✓ 確認済み：" + (s.name || "") + (s.location ? "（" + s.location + "）" : "") +
        "／法人番号 " + s.corporateNumber;
      st.box.appendChild(ok);
      if (st.facts && st.facts.length) {
        const det = document.createElement("details");
        det.className = "company-facts";
        const sum = document.createElement("summary");
        sum.textContent = "生成に使う登録情報を見る（" + st.facts.length + " 項目・出典：gBizINFO）";
        det.appendChild(sum);
        const ul = document.createElement("ul");
        st.facts.forEach(function (f) {
          const li = document.createElement("li");
          li.textContent = f;
          ul.appendChild(li);
        });
        det.appendChild(ul);
        st.box.appendChild(det);
      }
      if (note) {
        const p = document.createElement("p");
        p.className = "company-note";
        p.textContent = "※ " + note;
        st.box.appendChild(p);
      }
      if (warn) {
        const p = document.createElement("p");
        p.className = "company-msg warn";
        p.textContent = warn;
        st.box.appendChild(p);
      }
      const change = document.createElement("button");
      change.type = "button";
      change.className = "btn ghost mini";
      change.textContent = "選び直す";
      change.addEventListener("click", function () { st.status = "unconfirmed"; st.selected = null; st.token++; search(st); });
      st.box.appendChild(change);
    }

    return {
      attach: attach,
      get: function (formId) {
        const st = state(formId);
        if (!st) return null;
        return {
          status: function () { return st.status; },
          isResolved: function () { return st.status === "confirmed" || st.status === "declined" || st.status === "fallback"; },
          start: function () { search(st); },
          payload: function () {
            if (st.status === "confirmed" && st.selected) {
              return { corporateNumber: st.selected.corporateNumber, name: st.selected.name || null };
            }
            return { confirmed: false, reason: st.status };
          }
        };
      }
    };
  })();

  /* ================= 初期化 ================= */
  function initDoc(opts) {
    const result = document.getElementById((opts && opts.resultId) || "result");
    if (!result) return;
    docState.resultId = result.id || "result";
    const tb = document.querySelector(".toolbar");

    // 全文コピー：ツールバーの先頭（最も押してほしいボタン）
    if (tb && !tb.querySelector("[data-copy-all]")) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "btn mini";
      b.setAttribute("data-copy-all", "");
      b.textContent = "全文コピー";
      b.addEventListener("click", function () { copyAll(b); });
      tb.insertBefore(b, tb.firstChild);
    }
    // 【 】を埋める
    if (tb && !tb.querySelector("[data-fill-ph]")) {
      const f = document.createElement("button");
      f.type = "button";
      f.className = "btn ghost mini";
      f.setAttribute("data-fill-ph", "");
      f.textContent = "【 】を埋める";
      f.hidden = true;
      f.addEventListener("click", function () {
        const first = result.querySelector("mark.ph[data-ph]");
        if (!first) return;
        if (first.scrollIntoView) first.scrollIntoView({ block: "center", behavior: "smooth" });
        openPhModal(first);
      });
      tb.appendChild(f);
    }
    ensureCountEl(result);
    // 穴埋めは本文のクリックで（contenteditable のキャレット移動より優先する）
    result.addEventListener("click", function (e) {
      const t = e.target;
      const mark = t && t.closest ? t.closest("mark.ph[data-ph]") : null;
      if (!mark) return;
      e.preventDefault();
      openPhModal(mark);
    });
    result.addEventListener("input", refreshDoc);
    // 狭い画面では編集を全画面にする（キーボードで本文が隠れるのを防ぐ）
    result.addEventListener("focusin", function () { if (isNarrow()) enterEditFull(); });
    window.addEventListener("resize", function () { if (!isNarrow()) exitEditFull(); });
    refreshDoc();
  }

  function boot() {
    const form = formEl();
    if (form) {
      bindDynamicPlaceholders("gen-form");
      bindGentleHints("gen-form");
      injectHintTags("gen-form");
      const on = form.querySelector('.chip[data-group="scene"][aria-pressed="true"]');
      if (on) applyScenePlaceholders(form, on.getAttribute("data-value"));
    }
    initDoc({ resultId: "result" });
    ensureDoneBtn();
    syncViewportHeight();
    if (window.visualViewport) {
      window.visualViewport.addEventListener("resize", syncViewportHeight);
      window.visualViewport.addEventListener("scroll", syncViewportHeight);
    }
  }

  function makeEditable(el) {
    el.setAttribute("contenteditable", "true");
    el.spellcheck = false;
  }

  function setupPhoto(inputId, slotId) {
    const input = document.getElementById(inputId);
    const slot = document.getElementById(slotId);
    if (!input || !slot) return;
    input.addEventListener("change", function () {
      const file = input.files && input.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = function (ev) {
        slot.innerHTML = '<img alt="写真" src="' + ev.target.result + '">';
      };
      reader.readAsDataURL(file);
    });
  }

  /* 例文の一括投入。
   * 「何を書けばいいか分からない」で離脱する層の入口を作る（試用のハードルを下げる）。
   * 投入するのはあくまで例であって、生成結果ではありません。ユーザーが上書きする前提。 */
  function fillExample(formId, data) {
    const form = document.getElementById(formId);
    if (!form || !data) return;
    Object.keys(data).forEach(function (key) {
      const want = data[key];
      form.querySelectorAll('[data-field="' + key + '"]').forEach(function (n) {
        if (n.matches("input, textarea, select")) {
          n.value = want;
        } else if (n.classList.contains("chip")) {
          const val = n.getAttribute("data-value") || n.textContent.trim();
          n.setAttribute("aria-pressed", val === want ? "true" : "false");
        }
      });
    });
    setStatus("入力例を入れました。このまま生成するか、ご自身の内容に書き換えてください。", "ok");
    track("example_fill", { form: formId });
    const first = form.querySelector("textarea, input[type=text]");
    if (first && first.focus) first.focus();
  }

  // chip toggle (単一選択)
  function chipGroup(group) {
    const chips = document.querySelectorAll('.chip[data-group="' + group + '"]');
    chips.forEach(function (c) {
      c.addEventListener("click", function () {
        chips.forEach(function (x) { x.setAttribute("aria-pressed", "false"); });
        c.setAttribute("aria-pressed", "true");
      });
    });
  }

  /* テーマ（ライト/ダーク）— Front-End-Checklist: dark-mode-css
   * OS 設定を優先し、手動切り替えは localStorage に保存。
   * data-theme 属性で CSS トークンを切り替える。 */
  var THEME_KEY = "shibou-theme";
  function applyTheme(theme) {
    if (theme === "dark" || theme === "light") {
      document.documentElement.setAttribute("data-theme", theme);
    } else {
      document.documentElement.removeAttribute("data-theme");
    }
  }
  function initTheme() {
    var saved = null;
    try { saved = localStorage.getItem(THEME_KEY); } catch (e) {}
    if (saved === "dark" || saved === "light") {
      applyTheme(saved);
    } else {
      var prefersDark = window.matchMedia &&
        window.matchMedia("(prefers-color-scheme: dark)").matches;
      applyTheme(prefersDark ? "dark" : "light");
    }
    var btn = document.getElementById("theme-toggle");
    if (btn) {
      btn.addEventListener("click", function () {
        var cur = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
        applyTheme(cur);
        try { localStorage.setItem(THEME_KEY, cur); } catch (e) {}
        btn.setAttribute("aria-label", cur === "dark" ? "ライトモードに切替" : "ダークモードに切替");
      });
    }
  }

  // ---------- 認証 / マイページ（ログイン不要でも動作；Redis 未設定時は login のみ無効） ----------
  var Auth = (function () {
    var state = { loggedIn: false, email: null, configured: true, emailConfigured: true, anonLimit: 2, loggedLimit: 5 };
    var modal = null;
    // ログイン/登録完了/ログアウトで呼ぶフック。P0-5 の「生成時にログイン → そのまま再開」に使う。
    // 未設定なら何もしない（以前は未宣言の自由変数を typeof で呼んでおり、実際には誰も掴んでいなかった）。
    var onAuthChange = null;

    async function me() {
      try {
        const r = await fetch("/api/auth", { headers: { "Accept": "application/json" } });
        const d = await r.json();
        state.loggedIn = !!d.loggedIn;
        state.email = d.email || null;
        state.configured = d.configured !== false;
        state.emailConfigured = d.emailConfigured !== false;
        if (typeof d.anonDailyLimit === "number") state.anonLimit = d.anonDailyLimit;
        if (typeof d.loggedDailyLimit === "number") state.loggedLimit = d.loggedDailyLimit;
      } catch (e) {
        state.configured = false;
      }
      renderNav();
      applyQuotaUI();
    }
    // ストア／メール送信が未設定のときは、必ず失敗する入力欄を出さない
    function unavailableReason() {
      if (!state.configured) return "現在ログイン機能を準備中です。ご利用いただけるまで今しばらくお待ちください。";
      if (!state.emailConfigured) return "現在メール送信の準備中です。新規登録はもうしばらくお待ちください。";
      return null;
    }

    // ナビのログイン欄。器は各 HTML に <span class="auth-area" id="auth-area"> として
    // 置いてある（JS で挿入すると初回描画との間でナビがずれるため）。
    // ここは「HTML に無いページでも動く」ための保険として生成も担う。
    function ensureAuthArea() {
      let area = document.getElementById("auth-area") || document.querySelector(".auth-area");
      if (area) return area;
      const inner = document.querySelector("header.nav .nav-inner") ||
                    document.querySelector(".nav-inner") ||
                    document.querySelector("header.nav");
      if (!inner) return null;
      area = document.createElement("div");
      area.id = "auth-area";
      area.className = "auth-area";
      const toggle = inner.querySelector("#theme-toggle");
      if (toggle) inner.insertBefore(area, toggle); else inner.appendChild(area);
      return area;
    }

    function renderNav() {
      const area = ensureAuthArea();
      if (!area) return;
      if (state.loggedIn) {
        area.innerHTML =
          '<a class="nav-auth-link" href="/account.html">マイページ</a>' +
          '<button type="button" class="nav-auth-btn ghost" id="auth-logout">ログアウト</button>';
        const lo = document.getElementById("auth-logout");
        if (lo) lo.addEventListener("click", logout);
      } else {
        area.innerHTML = '<button type="button" class="nav-auth-btn" id="auth-open">ログイン</button>';
        const o = document.getElementById("auth-open");
        if (o) o.addEventListener("click", openModal);
      }
    }

    function applyQuotaUI() {
      const note = document.getElementById("limit-note");
      if (!note) return;
      const a = state.anonLimit, l = state.loggedLimit;
      if (state.loggedIn) {
        note.textContent = "ログイン中：1日最大" + l + "回まで生成でき、履歴はマイページに保存されます。";
      } else if (state.configured) {
        // P0-5（改）: 入力も生成も、まずは匿名枠の範囲で試せる。ログインを求めるのは上限に当たった時だけ。
        note.textContent = "入力も生成も、まずは" + a + "回までログインなしで試せます（ログインで1日" + l + "回・履歴も保存）。";
      } else {
        // 認証ストアが使えないときは門を作らない（作ると誰も生成できなくなる）。この時は匿名の上限が効く。
        note.textContent = "ログイン不要・本日最大" + a + "回まで。";
      }
    }

    function ensureModal() {
      if (modal) return;
      modal = document.createElement("div");
      modal.className = "auth-modal";
      modal.hidden = true;
      modal.innerHTML =
        '<div class="auth-backdrop" data-close="1"></div>' +
        '<div class="auth-card" role="dialog" aria-modal="true" aria-label="ログイン / 新規登録">' +
          '<button type="button" class="auth-x" data-close="1" aria-label="閉じる">×</button>' +
          '<div class="auth-tabs">' +
            '<button type="button" class="auth-tab active" data-tab="login">ログイン</button>' +
            '<button type="button" class="auth-tab" data-tab="register">新規登録</button>' +
          '</div>' +
          '<form id="auth-form" class="auth-form" novalidate>' +
            '<label>メールアドレス<input type="email" id="auth-email" autocomplete="email" placeholder="you@example.com" required></label>' +
            '<label>パスワード<input type="password" id="auth-pw" autocomplete="current-password" placeholder="6文字以上" required></label>' +
            '<button type="submit" class="btn block" id="auth-submit">ログイン</button>' +
            '<p class="auth-err" id="auth-err"></p>' +
          '</form>' +
          '<div id="auth-verify" hidden>' +
            '<p class="auth-verify-msg" id="auth-verify-msg"></p>' +
            '<label>認証コード（6桁）<input type="text" id="auth-code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="123456"></label>' +
            '<button type="button" class="btn block" id="auth-verify-btn">認証して登録</button>' +
            '<button type="button" class="btn ghost block mini" id="auth-resend">コードを再送信</button>' +
            '<p class="auth-err" id="auth-verify-err"></p>' +
          '</div>' +
          '<p class="auth-hint">新規登録には<b>実際に受信できるメールアドレス</b>が必要です。6桁の認証コードで本人確認します（コードは10分間有効）。アカウントは生成履歴の保存・照会用で、パスワードはハッシュ保存され平文は保存されません。</p>' +
          '<div id="auth-notice" hidden><p class="auth-verify-msg"></p></div>' +
        '</div>';
      document.body.appendChild(modal);
      modal.querySelectorAll("[data-close]").forEach(function (el) {
        el.addEventListener("click", close);
      });
      modal.querySelectorAll(".auth-tab").forEach(function (t) {
        t.addEventListener("click", function () { switchTab(t.getAttribute("data-tab")); });
      });
      modal.querySelector("#auth-form").addEventListener("submit", function (e) {
        e.preventDefault();
        const tab = modal.querySelector(".auth-tab.active").getAttribute("data-tab");
        if (tab === "register") doRegister(); else doLogin();
      });
      const vb = modal.querySelector("#auth-verify-btn");
      if (vb) vb.addEventListener("click", doVerify);
      const rb = modal.querySelector("#auth-resend");
      if (rb) rb.addEventListener("click", doResend);
    }

    let currentTab = "login";
    let pendingEmail = null; // 認証コード入力待ちのメール（再オープン時に復元する）
    function switchTab(tab) {
      currentTab = tab;
      modal.querySelectorAll(".auth-tab").forEach(function (t) {
        t.classList.toggle("active", t.getAttribute("data-tab") === tab);
      });
      modal.querySelector("#auth-submit").textContent = tab === "register" ? "認証コードを受け取る" : "ログイン";
      modal.querySelector("#auth-err").textContent = "";
      const pw = modal.querySelector("#auth-pw");
      pw.setAttribute("autocomplete", tab === "register" ? "new-password" : "current-password");
    }
    function openModal() {
      ensureModal();
      modal.hidden = false;
      // 認証ビューをリセットして通常のログイン/登録表示に戻す
      const v = modal.querySelector("#auth-verify");
      if (v) v.hidden = true;
      modal.querySelectorAll(".auth-tab").forEach(function (t) { t.style.display = ""; });
      const f = modal.querySelector("#auth-form");
      if (f) f.hidden = false;
      const n = modal.querySelector("#auth-notice");
      const reason = unavailableReason();
      if (n) n.hidden = !reason;
      if (reason) {
        const msg = n.querySelector(".auth-verify-msg");
        if (msg) msg.textContent = reason;
        modal.querySelectorAll(".auth-tab").forEach(function (t) { t.style.display = "none"; });
        if (f) f.hidden = true;
        if (v) v.hidden = true;
        return;
      }
      // 認証コード入力待ちなら、その画面に戻す（コード再送を無駄にしない）
      if (pendingEmail) { showVerify(pendingEmail); return; }
      switchTab("login");
      setTimeout(function () { const e = modal.querySelector("#auth-email"); if (e) e.focus(); }, 30);
    }
    function close() { if (modal) modal.hidden = true; }

    function setErr(msg) { const e = modal && modal.querySelector("#auth-err"); if (e) e.textContent = msg || ""; }

    async function doLogin() {
      const email = modal.querySelector("#auth-email").value.trim();
      const pw = modal.querySelector("#auth-pw").value;
      setErr("");
      const btn = modal.querySelector("#auth-submit");
      btn.disabled = true;
      try {
        const r = await fetch("/api/auth", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "login", email: email, password: pw })
        });
        const d = await r.json();
        if (!r.ok || !d.loggedIn) { setErr(d.error || "ログインに失敗しました。"); return; }
        pendingEmail = null;
        state.loggedIn = true; state.email = d.email;
        close(); renderNav(); applyQuotaUI();
        track("login_success", {});
        if (typeof onAuthChange === "function") onAuthChange();
      } catch (e) {
        setErr("通信エラーが発生しました。");
      } finally {
        btn.disabled = false;
      }
    }

    async function doRegister() {
      const email = modal.querySelector("#auth-email").value.trim();
      const pw = modal.querySelector("#auth-pw").value;
      setErr("");
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { setErr("メールアドレスの形式が正しくありません。"); return; }
      if (pw.length < 6) { setErr("パスワードは6文字以上で入力してください。"); return; }
      const btn = modal.querySelector("#auth-submit");
      btn.disabled = true;
      try {
        const r = await fetch("/api/auth", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "register", email: email, password: pw })
        });
        const d = await r.json();
        if (!r.ok) { setErr((d && d.error) || "登録に失敗しました。"); return; }
        if (d.needVerify) { pendingEmail = email; showVerify(email); track("signup_code_sent", {}); return; }
        if (d.loggedIn) {
          pendingEmail = null;
          state.loggedIn = true; state.email = d.email;
          close(); renderNav(); applyQuotaUI();
          if (typeof onAuthChange === "function") onAuthChange();
        }
      } catch (e) {
        setErr("通信エラーが発生しました。");
      } finally {
        btn.disabled = false;
      }
    }

    function showVerify(email) {
      pendingEmail = email;
      modal.querySelectorAll(".auth-tab").forEach(function (t) { t.style.display = "none"; });
      const f = modal.querySelector("#auth-form");
      if (f) f.hidden = true;
      const v = modal.querySelector("#auth-verify");
      v.hidden = false;
      modal.querySelector("#auth-verify-msg").textContent =
        "認証コードを " + email + " に送信しました。受信メールから6桁のコードを入力してください（10分間有効）。";
      modal.querySelector("#auth-verify-err").textContent = "";
      modal.querySelector("#auth-code").value = "";
      setTimeout(function () { const c = modal.querySelector("#auth-code"); if (c) c.focus(); }, 30);
    }

    async function doVerify() {
      const email = (modal.querySelector("#auth-email").value || "").trim();
      const code = (modal.querySelector("#auth-code").value || "").trim();
      const errEl = modal.querySelector("#auth-verify-err");
      errEl.textContent = "";
      const btn = modal.querySelector("#auth-verify-btn");
      btn.disabled = true;
      try {
        const r = await fetch("/api/auth", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "verify", email: email, code: code })
        });
        const d = await r.json();
        if (!r.ok || !d.loggedIn) { errEl.textContent = (d && d.error) || "認証に失敗しました。"; return; }
        pendingEmail = null;
        state.loggedIn = true; state.email = d.email;
        close(); renderNav(); applyQuotaUI();
        track("signup_complete", {});
        if (typeof onAuthChange === "function") onAuthChange();
      } catch (e) {
        errEl.textContent = "通信エラーが発生しました。";
      } finally {
        btn.disabled = false;
      }
    }

    async function doResend() {
      const email = (modal.querySelector("#auth-email").value || "").trim();
      const errEl = modal.querySelector("#auth-verify-err");
      const btn = modal.querySelector("#auth-resend");
      btn.disabled = true;
      try {
        const r = await fetch("/api/auth", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "resend", email: email })
        });
        const d = await r.json();
        if (!r.ok) { errEl.textContent = (d && d.error) || "再送信に失敗しました。"; return; }
        errEl.textContent = "";
        modal.querySelector("#auth-verify-msg").textContent = "認証コードを再送信しました。新しいコードを入力してください。";
      } catch (e) {
        errEl.textContent = "通信エラーが発生しました。";
      } finally {
        btn.disabled = false;
      }
    }

    async function logout() {
      try {
        await fetch("/api/auth", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "logout" })
        });
      } catch (e) {}
      state.loggedIn = false; state.email = null; pendingEmail = null;
      renderNav(); applyQuotaUI();
      track("logout", {});
      if (typeof onAuthChange === "function") onAuthChange();
    }

    // 生成記録の保存はサーバ側（api/generate.js の persistRecord）が担当する。
    // クライアントから保存すると重複するため、ここでは何もしない（後方互換のための no-op）。
    function saveRecord() { /* server-side */ }

    function isLoggedIn() { return state.loggedIn; }
    // 画面文言用：サーバが返した実際の上限値
    function limits() { return { anon: state.anonLimit, logged: state.loggedLimit, configured: state.configured }; }

    // ナビのログイン欄。コンテナの生成は ensureAuthArea() に一本化する
    //（以前は init() にも同じ生成コードがあり二重管理になっていた）
    function init() {
      // 先に器だけ作る。renderNav() は me() の fetch 応答後に呼ばれるため、
      // ここで作らないと「ナビに空きが無い状態 → 応答後に要素が出現」となり、
      // ナビのリンク列が丸ごと横にずれる（実測 186px、CLS 0.0033）。
      // 器を先に置けば min-width の予約が初回描画から効き、ずれが起きない。
      ensureAuthArea();
      me();
    }

    return { init: init, me: me, login: doLogin, register: doRegister, logout: logout, saveRecord: saveRecord, isLoggedIn: isLoggedIn, limits: limits, openModal: openModal, onChange: function (fn) { onAuthChange = fn; } };
  })();

  // 生成成功時にログイン中なら記録を保存
  Auth.init(); // 全ページでナビにログインボタンを注入し、状態を取得
  // P0-5: ログインを理由に止めた生成を、ログイン完了後に自動で再開する
  Auth.onChange(resumePendingGenerate);

  // 計測：スタブは同期で用意（load 前のイベントを取りこぼさない）、外部スクリプトだけ load 後
  primeGtag();
  if (document.readyState === "complete") loadGtagScript();
  else window.addEventListener("load", loadGtagScript);

  // 結果の付随UI（全文コピー・字数・【 】補完・全画面編集）と入力補助を配線する。
  // engine.js は body 末尾の同期スクリプトなので、#result も .toolbar も存在している。
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();

  return {
    generate: generate,
    makeEditable: makeEditable,
    setupPhoto: setupPhoto,
    chipGroup: chipGroup,
    fillExample: fillExample,
    collect: collect,
    initTheme: initTheme,
    applyTheme: applyTheme,
    track: track,
    countChars: countChars,
    company: CompanyConfirm,
    auth: Auth
  };
})();
