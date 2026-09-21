/* 就活AI 共有エンジン
 * - 生成: フォーム収集 → /api/generate → 編集可能な文書として表示
 * - 編集: contenteditable でその場で修正
 * - 写真: FileReader でプレビュー（履歴書・職務経歴書）
 * - 出力: ブラウザ印刷で A4/PDF（依存ゼロ）、および .txt 出力
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
  var ga4Ready = false;

  function ga4Id() {
    var m = document.querySelector('meta[name="ga4-id"]');
    var v = (m && m.getAttribute("content")) || GA4_ID;
    return (v || "").trim();
  }

  function initAnalytics() {
    var id = ga4Id();
    if (!id || ga4Ready) return;
    ga4Ready = true;
    window.dataLayer = window.dataLayer || [];
    window.gtag = function () { window.dataLayer.push(arguments); };
    var s = document.createElement("script");
    s.async = true;
    s.src = "https://www.googletagmanager.com/gtag/js?id=" + encodeURIComponent(id);
    document.head.appendChild(s);
    window.gtag("js", new Date());
    window.gtag("config", id, { anonymize_ip: true });
  }

  // 計測の失敗で生成や登録を止めない（必ず握りつぶす）
  function track(name, params) {
    try {
      if (!ga4Id()) return;
      if (typeof window.gtag === "function") window.gtag("event", name, params || {});
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

  function toParagraphs(text) {
    const safe = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    // 【…】プレースホルダを強調（不捏造の証拠）
    const marked = safe.replace(/【([^】]*)】/g, '<mark class="ph">【$1】</mark>');
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

    let payload;
    if (config.structured) {
      payload = { tool: config.tool || "shibou", fields: vals, model: config.model || null };
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
      has_jd: vals["企業情報"] ? 1 : 0
    });

    try {
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (res.status === 429 && data && data.limitReached) {
        setStatus(data.error || "本日の生成上限に達しました。", "warn");
        if (btn) { btn.disabled = true; btn.innerHTML = "本日の上限に達しました"; }
        // 上限到達＝登録の動機が最も高い瞬間。ここを分母に登録率を見る。
        track("limit_reached", {
          tool: config.tool || "custom",
          logged_in: (Auth && Auth.isLoggedIn && Auth.isLoggedIn()) ? 1 : 0
        });
        return;
      }
      if (!res.ok || !data.text) {
        throw new Error(data.error || ("HTTP " + res.status));
      }
      result.innerHTML = toParagraphs(data.text.trim());
      result.classList.remove("placeholder");
      makeEditable(result);
      showContextNote(data);
      // 履歴の保存はサーバ側（/api/generate 内で session がある場合のみ）で行う。
      // ここで再度 POST すると1回の生成で履歴が2件重複するため、クライアントからは保存しない。
      const rem = (data.remaining != null) ? "（本日あと " + data.remaining + " 回）" : "";
      // ファネル計測：生成が実際に成果物を返した地点（＝このページの主目的の達成）
      track("generate_success", {
        tool: config.tool || "custom",
        company_context: data.companyContextUsed ? 1 : 0,
        had_gap: data.missingExperience ? 1 : 0,
        demo: data.mock ? 1 : 0
      });
      if (data.companyContextUsed) {
        setStatus("公開情報から抽出しました（要確認）。そのまま編集してください。" + rem, "ok");
      } else if (data.missingExperience) {
        setStatus("入力が足りない箇所は【 】で空缺を残しました。ご自身の言葉で埋めてください。" + rem, "warn");
      } else if (data.mock) {
        setStatus("※デモ出力です（APIキー未設定のためテンプレート表示）。本番では実際の AI が生成されます。" + rem, "warn");
      } else {
        setStatus("生成完了。そのまま編集できます。" + rem, "ok");
      }
    } catch (e) {
      setStatus("生成に失敗しました：" + e.message, "warn");
      track("generate_error", { tool: config.tool || "custom", message: String(e.message).slice(0, 100) });
    } finally {
      if (btn) { btn.disabled = false; btn.innerHTML = btn.dataset.label || "生成する"; }
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

  function exportPDF() {
    setStatus("");
    track("pdf_export", {});
    window.print();
  }

  function exportText(resultId) {
    const result = document.getElementById(resultId);
    if (!result) return;
    const text = result.innerText.replace(/ /g, " ");
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "shibou-ai-output.txt";
    a.click();
    URL.revokeObjectURL(a.href);
    track("text_export", {});
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

    // ナビのログイン欄。HTML に #auth-area が無いページでも動くよう、無ければ生成する。
    // （以前は「無ければ何もしない」実装だったため、どのページにもログインボタンが出ていなかった）
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
        note.textContent = "ログイン不要・本日最大" + a + "回まで。ログインすると1日" + l + "回まで、かつ生成履歴を保存できます。";
      } else {
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

    return { init: init, me: me, login: doLogin, register: doRegister, logout: logout, saveRecord: saveRecord, isLoggedIn: isLoggedIn, limits: limits, openModal: openModal };
  })();

  // 生成成功時にログイン中なら記録を保存
  Auth.init(); // 全ページでナビにログインボタンを注入し、状態を取得

  // 計測は初回描画を邪魔しないよう load 後に開始する（LCP/INP を悪化させない）
  if (document.readyState === "complete") initAnalytics();
  else window.addEventListener("load", initAnalytics);

  return {
    generate: generate,
    makeEditable: makeEditable,
    setupPhoto: setupPhoto,
    exportPDF: exportPDF,
    exportText: exportText,
    chipGroup: chipGroup,
    fillExample: fillExample,
    collect: collect,
    initTheme: initTheme,
    applyTheme: applyTheme,
    track: track,
    auth: Auth
  };
})();
