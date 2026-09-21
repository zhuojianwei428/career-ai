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
    setStatus("AI が文章を作成しています（数秒〜十数秒）");

    try {
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (!res.ok || !data.text) {
        throw new Error(data.error || ("HTTP " + res.status));
      }
      result.innerHTML = toParagraphs(data.text.trim());
      result.classList.remove("placeholder");
      makeEditable(result);
      showContextNote(data);
      if (data.companyContextUsed) {
        setStatus("公開情報から抽出しました（要確認）。そのまま編集してください。", "ok");
      } else if (data.missingExperience) {
        setStatus("入力が足りない箇所は【 】で空缺を残しました。ご自身の言葉で埋めてください。", "warn");
      } else if (data.mock) {
        setStatus("※デモ出力です（APIキー未設定のためテンプレート表示）。本番では実際の AI が生成されます。", "warn");
      } else {
        setStatus("生成完了。そのまま編集できます。", "ok");
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

  return {
    generate: generate,
    makeEditable: makeEditable,
    setupPhoto: setupPhoto,
    exportPDF: exportPDF,
    exportText: exportText,
    chipGroup: chipGroup,
    collect: collect,
    initTheme: initTheme,
    applyTheme: applyTheme
  };
})();
