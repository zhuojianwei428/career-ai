/* 就活AI 共有エンジン
 * - 生成: フォーム収集 → /api/generate → 編集可能な文書として表示
 * - 編集: contenteditable でその場で修正
 * - 写真: FileReader でプレビュー（履歴書・職務経歴書）
 * - 出力: ブラウザ印刷で A4/PDF（依存ゼロ）、および .txt 出力
 */
window.CareerAI = (function () {
  "use strict";

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
        return;
      }
      if (!res.ok || !data.text) {
        throw new Error(data.error || ("HTTP " + res.status));
      }
      result.innerHTML = toParagraphs(data.text.trim());
      result.classList.remove("placeholder");
      makeEditable(result);
      showContextNote(data);
      if (CareerAI.auth && CareerAI.auth.isLoggedIn() && !data.mock) {
        CareerAI.auth.saveRecord(config.tool, vals, data.text);
      }
      const rem = (data.remaining != null) ? "（本日あと " + data.remaining + " 回）" : "";
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
    var state = { loggedIn: false, email: null, configured: true };
    var modal = null;

    async function me() {
      try {
        const r = await fetch("/api/auth", { headers: { "Accept": "application/json" } });
        const d = await r.json();
        state.loggedIn = !!d.loggedIn;
        state.email = d.email || null;
        state.configured = d.configured !== false;
      } catch (e) {
        state.configured = false;
      }
      renderNav();
      applyQuotaUI();
    }

    function renderNav() {
      const area = document.getElementById("auth-area");
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
      if (state.loggedIn) {
        note.textContent = "ログイン中：1日最大10回まで生成でき、履歴はマイページに保存されます。";
      } else if (state.configured) {
        note.textContent = "ログイン不要・本日最大2回まで。ログインすると1日10回まで、かつ生成履歴を保存できます。";
      } else {
        note.textContent = "ログイン不要・本日最大2回まで。";
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
            '<label>メールアドレス<input type="email" id="auth-email" autocomplete="email" placeholder="example@coverletterkit.com"></label>' +
            '<label>パスワード<input type="password" id="auth-pw" autocomplete="current-password" placeholder="6文字以上"></label>' +
            '<button type="submit" class="btn block" id="auth-submit">ログイン</button>' +
            '<p class="auth-err" id="auth-err"></p>' +
          '</form>' +
          '<p class="auth-hint">アカウントは生成履歴の保存・照会用です。パスワードはハッシュ保存され、平文は保存されません。</p>' +
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
    }

    let currentTab = "login";
    function switchTab(tab) {
      currentTab = tab;
      modal.querySelectorAll(".auth-tab").forEach(function (t) {
        t.classList.toggle("active", t.getAttribute("data-tab") === tab);
      });
      modal.querySelector("#auth-submit").textContent = tab === "register" ? "新規登録してログイン" : "ログイン";
      modal.querySelector("#auth-err").textContent = "";
      const pw = modal.querySelector("#auth-pw");
      pw.setAttribute("autocomplete", tab === "register" ? "new-password" : "current-password");
    }
    function openModal() {
      ensureModal();
      modal.hidden = false;
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
        state.loggedIn = true; state.email = d.email;
        close(); renderNav(); applyQuotaUI();
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
      const btn = modal.querySelector("#auth-submit");
      btn.disabled = true;
      try {
        const r = await fetch("/api/auth", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "register", email: email, password: pw })
        });
        const d = await r.json();
        if (!r.ok || !d.loggedIn) { setErr(d.error || "登録に失敗しました。"); return; }
        state.loggedIn = true; state.email = d.email;
        close(); renderNav(); applyQuotaUI();
        if (typeof onAuthChange === "function") onAuthChange();
      } catch (e) {
        setErr("通信エラーが発生しました。");
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
      state.loggedIn = false; state.email = null;
      renderNav(); applyQuotaUI();
      if (typeof onAuthChange === "function") onAuthChange();
    }

    // 生成成功時に呼ぶ（ログイン中のみ記録を保存；失敗は無視）
    function saveRecord(tool, vals, text) {
      if (!state.loggedIn || !text) return;
      fetch("/api/records", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tool: tool,
          scene: (vals && vals["応募種別"]) || "",
          company: (vals && vals["企業名"]) || "",
          len: (vals && vals["文字数"]) || "",
          tone: (vals && vals["トーン"]) || "",
          text: text
        })
      }).catch(function () {});
    }

    function isLoggedIn() { return state.loggedIn; }

    // ナビに auth-area を注入（全ページ共通）
    function init() {
      const navInner = document.querySelector(".nav-inner");
      const toggle = document.getElementById("theme-toggle");
      if (navInner && !document.getElementById("auth-area")) {
        const span = document.createElement("span");
        span.id = "auth-area";
        span.className = "auth-area";
        if (toggle && toggle.parentNode === navInner) {
          navInner.insertBefore(span, toggle);
        } else {
          navInner.appendChild(span);
        }
      }
      me();
    }

    return { init: init, me: me, login: doLogin, register: doRegister, logout: logout, saveRecord: saveRecord, isLoggedIn: isLoggedIn, openModal: openModal };
  })();

  // 生成成功時にログイン中なら記録を保存
  Auth.init(); // 全ページでナビにログインボタンを注入し、状態を取得
  return {
    generate: generate,
    makeEditable: makeEditable,
    setupPhoto: setupPhoto,
    exportPDF: exportPDF,
    exportText: exportText,
    chipGroup: chipGroup,
    collect: collect,
    initTheme: initTheme,
    applyTheme: applyTheme,
    auth: Auth
  };
})();
