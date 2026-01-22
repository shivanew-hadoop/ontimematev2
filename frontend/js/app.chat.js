/* ==========================================================================
   app.chat.js
   - load profile
   - credits ticking
   - chat streaming
   - resume upload
   ========================================================================== */

(() => {
  "use strict";

  const A = window.ANU_APP;
  const S = A.state;

  A.chat = A.chat || {};

  // ------------------------------------------------------------
  // PROFILE
  // ------------------------------------------------------------
  A.chat.loadUserProfile = async function loadUserProfile() {
    try {
      const res = await A.api.apiFetch("user/profile", {}, true);
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.user) {
        if (A.dom.userInfo) A.dom.userInfo.innerHTML = `<span class='text-red-600 text-sm'>Unable to load profile</span>`;
        return;
      }
      const u = data.user;
      if (A.dom.userInfo) {
        A.dom.userInfo.innerHTML = `
          <div class="text-sm text-gray-800 truncate">
            <b>${u.email || "N/A"}</b>
            <span class="ml-3">Credits: <b>${u.credits ?? 0}</b></span>
          </div>
        `;
      }
    } catch {
      if (A.dom.userInfo) A.dom.userInfo.innerHTML = `<span class='text-red-600 text-sm'>Error loading profile</span>`;
    }
  };

  // ------------------------------------------------------------
  // CREDITS
  // ------------------------------------------------------------
  async function deductCredits(delta) {
    const res = await A.api.apiFetch(
      "user/deduct",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ delta })
      },
      true
    );

    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Deduct failed");
    return data;
  }

  A.chat.startCreditTicking = function startCreditTicking() {
    if (S.creditTimer) clearInterval(S.creditTimer);
    S.lastCreditAt = Date.now();

    S.creditTimer = setInterval(async () => {
      if (!S.isRunning) return;

      const now = Date.now();
      const sec = Math.floor((now - S.lastCreditAt) / 1000);
      if (sec < A.const.CREDIT_BATCH_SEC) return;

      const billableSec = sec - (sec % A.const.CREDIT_BATCH_SEC);
      const delta = billableSec * A.const.CREDITS_PER_SEC;
      S.lastCreditAt += billableSec * 1000;

      try {
        const out = await deductCredits(delta);
        if (out.remaining <= 0) {
          A.actions?.stopAll?.();
          A.ui.showBanner("No credits remaining.");
          return;
        }
        await A.chat.loadUserProfile();
      } catch {}
    }, 500);
  };

  // ------------------------------------------------------------
  // CHAT STREAMING
  // ------------------------------------------------------------
  A.chat.abortChatStreamOnly = function abortChatStreamOnly(silent = true) {
    try { S.chatAbort?.abort(); } catch {}
    S.chatAbort = null;

    if (silent) A.ui.setStatus(A.dom.sendStatus, "Canceled (new request)", "text-orange-600");
    S.chatStreamActive = false;
  };

  function pushHistory(role, content) {
    const c = A.util.normalize(content);
    if (!c) return;
    S.chatHistory.push({ role, content: c });
    if (S.chatHistory.length > 80) S.chatHistory.splice(0, S.chatHistory.length - 80);
  }

  function compactHistoryForRequest() {
    return S.chatHistory.slice(-12).map((m) => ({
      role: m.role,
      content: String(m.content || "").slice(0, 1600)
    }));
  }

  A.chat.startChatStreaming = async function startChatStreaming(prompt, userTextForHistory) {
    A.chat.abortChatStreamOnly(true);

    S.chatAbort = new AbortController();
    S.chatStreamActive = true;
    const mySeq = ++S.chatStreamSeq;

    if (userTextForHistory) pushHistory("user", userTextForHistory);

    S.aiRawBuffer = "";
    if (A.dom.responseBox) A.dom.responseBox.innerHTML = `<span class="text-gray-500 text-sm">Receiving…</span>`;
    A.ui.setStatus(A.dom.sendStatus, "Connecting…", "text-orange-600");

    const body = {
      prompt,
      history: compactHistoryForRequest(),
      instructions: A.util.getEffectiveInstructions(),
      resumeText: S.resumeTextMem || ""
    };

    let raw = "";
    let flushTimer = null;
    let sawFirstChunk = false;

    const render = () => {
      if (A.dom.responseBox) A.dom.responseBox.innerHTML = A.util.renderMarkdownLite(raw);
    };

    try {
      const res = await A.api.apiFetch(
        "chat/send",
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "text/plain" },
          body: JSON.stringify(body),
          signal: S.chatAbort.signal
        },
        false
      );

      if (!res.ok) throw new Error(await res.text());
      if (!res.body) throw new Error("No stream body");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();

      flushTimer = setInterval(() => {
        if (mySeq !== S.chatStreamSeq) return;
        if (!sawFirstChunk) return;
        render();
      }, 30);

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        if (mySeq !== S.chatStreamSeq) return;

        raw += decoder.decode(value, { stream: true });

        if (!sawFirstChunk) {
          sawFirstChunk = true;
          if (A.dom.responseBox) A.dom.responseBox.innerHTML = "";
          A.ui.setStatus(A.dom.sendStatus, "Receiving…", "text-orange-600");
        }

        if (raw.length < 1800) render();
      }

      if (mySeq === S.chatStreamSeq) {
        render();
        A.ui.setStatus(A.dom.sendStatus, "Done", "text-green-600");
        pushHistory("assistant", raw);
      }
    } catch (e) {
      if (e?.name === "AbortError" || S.chatAbort?.signal?.aborted) return;

      console.error(e);
      A.ui.setStatus(A.dom.sendStatus, "Failed", "text-red-600");
      if (A.dom.responseBox) {
        A.dom.responseBox.innerHTML =
          `<span class="text-red-600 text-sm">Failed. Check backend /chat/send streaming.</span>`;
      }
    } finally {
      if (flushTimer) clearInterval(flushTimer);
      if (mySeq === S.chatStreamSeq) S.chatStreamActive = false;
    }
  };

  // ------------------------------------------------------------
  // RESUME UPLOAD
  // ------------------------------------------------------------
  A.chat.wireResumeUpload = function wireResumeUpload() {
    if (!A.dom.resumeInput) return;

    A.dom.resumeInput.addEventListener("change", async () => {
      const file = A.dom.resumeInput.files?.[0];
      if (!file) return;

      if (A.dom.resumeStatus) A.dom.resumeStatus.textContent = "Processing…";

      const fd = new FormData();
      fd.append("file", file);

      const res = await A.api.apiFetch("resume/extract", { method: "POST", body: fd }, false);

      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        S.resumeTextMem = "";
        if (A.dom.resumeStatus) {
          A.dom.resumeStatus.textContent = `Resume extract failed (${res.status}): ${errText.slice(0, 160)}`;
        }
        return;
      }

      const data = await res.json().catch(() => ({}));
      S.resumeTextMem = String(data.text || "").trim();

      if (A.dom.resumeStatus) {
        A.dom.resumeStatus.textContent = S.resumeTextMem
          ? `Resume extracted (${S.resumeTextMem.length} chars)`
          : "Resume extracted: empty";
      }
    });
  };
})();
