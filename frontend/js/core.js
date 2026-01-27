/* core.js - shared helpers + API + markdown + UI status */
(function () {
  window.ANU = window.ANU || {};
  const ANU = window.ANU;

  function normalize(s) {
    return (s || "").replace(/\s+/g, " ").trim();
  }

  function escapeHtml(s) {
    return String(s || "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function fixSpacingOutsideCodeBlocks(text) {
    if (!text) return "";
    const parts = String(text).split("```");
    for (let i = 0; i < parts.length; i++) {
      if (i % 2 === 1) continue;
      parts[i] = parts[i]
        .replace(/([,.;:!?])([A-Za-z0-9])/g, "$1 $2")
        .replace(/([\)\]])([A-Za-z0-9])/g, "$1 $2")
        .replace(/[ \t]{2,}/g, " ")
        .replace(/(\S)(\?|\!|\.)(\S)/g, "$1$2 $3");
    }
    return parts.join("```");
  }

  function renderMarkdownLite(md) {
    if (!md) return "";
    let safe = String(md).replace(/<br\s*\/?>/gi, "\n");
    safe = fixSpacingOutsideCodeBlocks(safe);
    safe = escapeHtml(safe);
    safe = safe.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
    safe = safe
      .replace(/\r\n/g, "\n")
      .replace(/\n\s*\n/g, "<br><br>")
      .replace(/\n/g, "<br>");
    return safe.trim();
  }

  function setupMarkdownRenderer() {
    if (!window.marked || !window.hljs || !window.DOMPurify) return;
    marked.setOptions({
      gfm: true,
      breaks: true,
      highlight: (code, lang) => {
        try {
          if (lang && hljs.getLanguage(lang)) {
            return hljs.highlight(code, { language: lang }).value;
          }
          return hljs.highlightAuto(code).value;
        } catch {
          return code;
        }
      }
    });
  }

  function renderMarkdownSafe(mdText) {
    if (!window.marked || !window.DOMPurify) return renderMarkdownLite(mdText);
    const html = marked.parse(mdText || "");
    return DOMPurify.sanitize(html);
  }

  function enhanceCodeBlocks(containerEl) {
    if (!containerEl) return;
    const pres = containerEl.querySelectorAll("pre");
    pres.forEach((pre) => {
      if (pre.querySelector(".code-actions")) return;

      const toolbar = document.createElement("div");
      toolbar.className = "code-actions";

      const btn = document.createElement("button");
      btn.className = "code-btn";
      btn.type = "button";
      btn.textContent = "Copy";

      btn.addEventListener("click", async () => {
        const codeEl = pre.querySelector("code");
        const text = codeEl ? codeEl.innerText : pre.innerText;
        try {
          await navigator.clipboard.writeText(text);
          btn.textContent = "Copied";
          setTimeout(() => (btn.textContent = "Copy"), 900);
        } catch {
          btn.textContent = "Failed";
          setTimeout(() => (btn.textContent = "Copy"), 900);
        }
      });

      toolbar.appendChild(btn);
      pre.appendChild(toolbar);
    });
  }

  function showBanner(refs, msg) {
    const bannerTop = refs?.bannerTop;
    if (!bannerTop) return;
    bannerTop.textContent = msg;
    bannerTop.classList.remove("hidden");
    bannerTop.classList.add("bg-red-600");
  }

  function hideBanner(refs) {
    const bannerTop = refs?.bannerTop;
    if (!bannerTop) return;
    bannerTop.classList.add("hidden");
    bannerTop.textContent = "";
  }

  function setStatus(el, text, cls = "") {
    if (!el) return;
    el.textContent = text;
    el.className = cls;
  }

  // ---------------- API + session refresh ----------------
  function authHeaders(session) {
    const token = session?.access_token;
    return token ? { Authorization: `Bearer ${token}` } : {};
  }

  function isTokenNearExpiry(session) {
    const exp = Number(session?.expires_at || 0);
    if (!exp) return false;
    const now = Math.floor(Date.now() / 1000);
    return exp - now < 60;
  }

  async function refreshAccessToken(session) {
    const refresh_token = session?.refresh_token;
    if (!refresh_token) throw new Error("Missing refresh_token. Please login again.");

    const res = await fetch("/api?path=auth/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token })
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Refresh failed");

    session.access_token = data.session.access_token;
    session.refresh_token = data.session.refresh_token;
    session.expires_at = data.session.expires_at;

    localStorage.setItem("session", JSON.stringify(session));
  }

  async function apiFetch(path, opts = {}, needAuth = true) {
    const session = ANU.state?.session || null;

    if (needAuth && session && isTokenNearExpiry(session)) {
      try { await refreshAccessToken(session); } catch {}
    }

    const headers = { ...(opts.headers || {}) };
    if (needAuth && session) Object.assign(headers, authHeaders(session));

    const res = await fetch(`/api?path=${encodeURIComponent(path)}`, {
      ...opts,
      headers,
      cache: "no-store"
    });

    if (needAuth && res.status === 401 && session) {
      const t = await res.text().catch(() => "");
      const looksExpired =
        t.includes("token is expired") ||
        t.includes("invalid JWT") ||
        t.includes("Missing token");
      if (looksExpired) {
        await refreshAccessToken(session);
        const headers2 = { ...(opts.headers || {}), ...authHeaders(session) };
        return fetch(`/api?path=${encodeURIComponent(path)}`, { ...opts, headers: headers2, cache: "no-store" });
      }
    }

    return res;
  }

  async function loadUserProfile(refs) {
    try {
      const res = await apiFetch("user/profile", {}, true);
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.user) {
        if (refs?.userInfo) refs.userInfo.innerHTML = `<span class='text-red-600 text-sm'>Unable to load profile</span>`;
        return;
      }
      const u = data.user;
      if (refs?.userInfo) {
        refs.userInfo.innerHTML = `
          <div class="text-sm text-gray-800 truncate">
            <b>${u.email || "N/A"}</b>
            <span class="ml-3">Credits: <b>${u.credits ?? 0}</b></span>
          </div>
        `;
      }
    } catch {
      if (refs?.userInfo) refs.userInfo.innerHTML = `<span class='text-red-600 text-sm'>Error loading profile</span>`;
    }
  }

  ANU.core = {
    normalize,
    escapeHtml,
    renderMarkdownLite,
    setupMarkdownRenderer,
    renderMarkdownSafe,
    enhanceCodeBlocks,
    showBanner,
    hideBanner,
    setStatus,
    apiFetch,
    loadUserProfile
  };
})();
