/* ==========================================================================
 * app.chat.js
 * Chat streaming + profile + credits + resume upload + wiring actions
 * ========================================================================== */
(() => {
  "use strict";

  const A = (window.ANU_APP = window.ANU_APP || {});
  A.chat = A.chat || {};
  const S = A.state;
  const C = A.const;

  /* -------------------------------------------------------------------------- */
  /* PROFILE                                                                      */
  /* -------------------------------------------------------------------------- */
  async function loadUserProfile() {
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
  }

  /* -------------------------------------------------------------------------- */
  /* CREDITS                                                                      */
  /* -------------------------------------------------------------------------- */
  async function deductCredits(delta) {
    const res = await A.api.apiFetch("user/deduct", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ delta })
    }, true);

    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Deduct failed");
    return data;
  }

  function startCreditTicking() {
    if (S.creditTimer) clearInterval(S.creditTimer);
    S.lastCreditAt = Date.now();

    S.creditTimer = setInterval(async () => {
      if (!S.isRunning) return;

      const now = Date.now();
      const sec = Math.floor((now - S.lastCreditAt) / 1000);
      if (sec < C.CREDIT_BATCH_SEC) return;

      const billableSec = sec - (sec % C.CREDIT_BATCH_SEC);
      const delta = billableSec * C.CREDITS_PER_SEC;
      S.lastCreditAt += billableSec * 1000;

      try {
        const out = await deductCredits(delta);
        if (out.remaining <= 0) {
          if (A.actions?.stopAll) A.actions.stopAll();
          A.ui.showBanner("No credits remaining.");
          return;
        }
        await loadUserProfile();
      } catch {}
    }, 500);
  }

  /* -------------------------------------------------------------------------- */
  /* CHAT STREAMING                                                               */
  /* -------------------------------------------------------------------------- */
  function abortChatStreamOnly(silent = true) {
    try { S.chatAbort?.abort(); } catch {}
    S.chatAbort = null;

    if (silent) A.ui.setStatus(A.dom.sendStatus, "Canceled (new request)", "text-orange-600");
    S.chatStreamActive = false;
  }

  function pushHistory(role, content) {
    const c = A.util.normalize(content);
    if (!c) return;
    S.chatHistory.push({ role, content: c });
    if (S.chatHistory.length > 80) S.chatHistory.splice(0, S.chatHistory.length - 80);
  }

  function compactHistoryForRequest() {
    return S.chatHistory.slice(-12).map(m => ({
      role: m.role,
      content: String(m.content || "").slice(0, 1600)
    }));
  }

  async function startChatStreaming(prompt, userTextForHistory) {
    abortChatStreamOnly(true);

    S.chatAbort = new AbortController();
    S.chatStreamActive = true;
    const mySeq = ++S.chatStreamSeq;

    if (userTextForHistory) pushHistory("user", userTextForHistory);

    let raw = "";
    let flushTimer = null;
    let sawFirstChunk = false;

    if (A.dom.responseBox) A.dom.responseBox.innerHTML = `<span class="text-gray-500 text-sm">Receiving…</span>`;
    A.ui.setStatus(A.dom.sendStatus, "Connecting…", "text-orange-600");

    const body = {
      prompt,
      history: compactHistoryForRequest(),
      instructions: A.util.getEffectiveInstructions(),
      resumeText: S.resumeTextMem || ""
    };

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
  }

  /* -------------------------------------------------------------------------- */
  /* RESUME UPLOAD                                                                */
  /* -------------------------------------------------------------------------- */
  function wireResumeUpload() {
    A.dom.resumeInput?.addEventListener("change", async () => {
      const file = A.dom.resumeInput.files?.[0];
      if (!file) return;

      if (A.dom.resumeStatus) A.dom.resumeStatus.textContent = "Processing…";

      const fd = new FormData();
      fd.append("file", file);

      const res = await A.api.apiFetch("resume/extract", { method: "POST", body: fd }, false);

      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        S.resumeTextMem = "";
        if (A.dom.resumeStatus) A.dom.resumeStatus.textContent = `Resume extract failed (${res.status}): ${errText.slice(0, 160)}`;
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
  }

  /* -------------------------------------------------------------------------- */
  /* ACTIONS + WIRING (same buttons, no confusion)                               */
  /* -------------------------------------------------------------------------- */
  async function startAll() {
    A.ui.hideBanner();
    if (S.isRunning) return;

    await A.api.apiFetch("chat/reset", { method: "POST" }, false).catch(() => {});

    S.transcriptEpoch++;
    S.timeline = [];
    S.micInterimEntry = null;
    S.lastSpeechAt = 0;
    S.sentCursor = 0;
    S.pinnedTop = true;

    S.lastSysTail = "";
    S.lastMicTail = "";
    S.lastSysPrinted = "";
    S.lastSysPrintedAt = 0;
    S.lastSysTypeKey = "";
    S.lastSysTypeAt = 0;
    A.transcript.resetRoleCommitState();

    A.audio.stopAsrSession("mic");
    A.audio.stopAsrSession("sys");

    A.transcript.updateTranscript();

    S.isRunning = true;

    // buttons
    A.dom.startBtn && (A.dom.startBtn.disabled = true);
    A.dom.stopBtn && (A.dom.stopBtn.disabled = false);
    A.dom.sysBtn && (A.dom.sysBtn.disabled = false);
    A.dom.sendBtn && (A.dom.sendBtn.disabled = false);

    A.dom.stopBtn && A.dom.stopBtn.classList.remove("opacity-50");
    A.dom.sysBtn && A.dom.sysBtn.classList.remove("opacity-50");
    A.dom.sendBtn && A.dom.sendBtn.classList.remove("opacity-60");

    // mic: streaming ASR immediately (instant transcript while talking)
    if (!S.micMuted) {
      await A.audio.startMicStreamingForStartAll().catch(() => {});
      A.ui.setStatus(A.dom.audioStatus, "Listening… (Mic streaming ASR ready)", "text-green-600");

      // if streaming mic failed, allow legacy fallback recorder
      setTimeout(() => {
        if (!S.isRunning) return;
        if (S.micMuted) return;
        // if no stream, start fallback recorder
        if (!S.micStream) A.audio.enableMicRecorderFallback().catch(() => {});
      }, 1500);
    } else {
      A.ui.setStatus(A.dom.audioStatus, "Mic is OFF. Press System Audio to capture system audio.", "text-orange-600");
    }

    startCreditTicking();
  }

  function stopAll() {
    S.isRunning = false;

    A.audio.stopMicPipelinesOnly();
    A.audio.stopSystemAudioOnly();

    A.audio.stopAsrSession("mic");
    A.audio.stopAsrSession("sys");

    if (S.creditTimer) clearInterval(S.creditTimer);

    A.dom.startBtn && (A.dom.startBtn.disabled = false);
    A.dom.stopBtn && (A.dom.stopBtn.disabled = true);
    A.dom.sysBtn && (A.dom.sysBtn.disabled = true);
    A.dom.sendBtn && (A.dom.sendBtn.disabled = true);

    A.dom.stopBtn && A.dom.stopBtn.classList.add("opacity-50");
    A.dom.sysBtn && A.dom.sysBtn.classList.add("opacity-50");
    A.dom.sendBtn && A.dom.sendBtn.classList.add("opacity-60");

    A.ui.setStatus(A.dom.audioStatus, "Stopped", "text-orange-600");
  }

  function hardClearTranscript() {
    S.transcriptEpoch++;

    try { S.micAbort?.abort(); } catch {}
    try { S.sysAbort?.abort(); } catch {}

    S.micQueue = [];
    S.sysQueue = [];
    S.micSegmentChunks = [];
    S.sysSegmentChunks = [];

    S.lastSysTail = "";
    S.lastMicTail = "";
    S.lastSysPrinted = "";
    S.lastSysPrintedAt = 0;
    S.lastSysTypeKey = "";
    S.lastSysTypeAt = 0;
    A.transcript.resetRoleCommitState();

    S.timeline = [];
    S.micInterimEntry = null;
    S.lastSpeechAt = 0;
    S.sentCursor = 0;
    S.pinnedTop = true;

    A.transcript.updateTranscript();
  }

  async function onSend() {
    const sendBtn = A.dom.sendBtn;
    if (!sendBtn || sendBtn.disabled) return;

    const manual = A.util.normalize(A.dom.manualQuestion?.value || "");
    const freshInterviewer = A.util.normalize(A.transcript.getFreshInterviewerBlocksText());
    const base = manual || freshInterviewer;

    A.q.updateTopicMemory(base);

    const question = A.q.buildDraftQuestion(base);
    if (!base) return;

    if (A.dom.manualQuestion) A.dom.manualQuestion.value = "";

    abortChatStreamOnly(true);

    S.blockMicUntil = Date.now() + 700;
    A.transcript.removeInterimIfAny();

    S.sentCursor = S.timeline.length;
    S.pinnedTop = true;
    A.transcript.updateTranscript();

    if (A.dom.responseBox) {
      A.dom.responseBox.innerHTML = A.util.renderMarkdownLite(`${question}\n\n_Generating answer…_`);
    }
    A.ui.setStatus(A.dom.sendStatus, "Queued…", "text-orange-600");

    const mode = A.dom.modeSelect?.value || "interview";
    const promptToSend =
      mode === "interview"
        ? A.q.buildInterviewQuestionPrompt(question.replace(/^Q:\s*/i, ""))
        : question;

    await startChatStreaming(promptToSend, base);
  }

  async function init() {
    // core DOM refs already created
    // resume wiring
    wireResumeUpload();

    // mic mute wiring
    if (A.dom.micMuteBtn) {
      A.dom.micMuteBtn.addEventListener("click", () => A.audio.setMicMuted(!S.micMuted));
      A.audio.updateMicMuteUI();
    }

    // buttons wiring
    A.dom.startBtn && (A.dom.startBtn.onclick = startAll);
    A.dom.stopBtn && (A.dom.stopBtn.onclick = stopAll);
    A.dom.sysBtn && (A.dom.sysBtn.onclick = A.audio.enableSystemAudio);
    A.dom.sendBtn && (A.dom.sendBtn.onclick = onSend);

    A.dom.clearBtn &&
      (A.dom.clearBtn.onclick = () => {
        hardClearTranscript();
        if (A.dom.manualQuestion) A.dom.manualQuestion.value = "";
        A.ui.setStatus(A.dom.sendStatus, "Transcript cleared", "text-green-600");
        A.ui.setStatus(A.dom.audioStatus, S.isRunning ? "Listening…" : "Stopped", S.isRunning ? "text-green-600" : "text-orange-600");
      });

    A.dom.resetBtn &&
      (A.dom.resetBtn.onclick = async () => {
        if (A.dom.responseBox) A.dom.responseBox.innerHTML = "";
        A.ui.setStatus(A.dom.sendStatus, "Response reset", "text-green-600");
        await A.api.apiFetch("chat/reset", { method: "POST" }, false).catch(() => {});
      });

    A.dom.logoutBtn &&
      (A.dom.logoutBtn.onclick = () => {
        S.chatHistory = [];
        S.resumeTextMem = "";
        stopAll();
        localStorage.removeItem("session");
        window.location.href = "/auth?tab=login";
      });
  }

  // exports
  A.chat.loadUserProfile = loadUserProfile;
  A.chat.startCreditTicking = startCreditTicking;

  A.chat.abortChatStreamOnly = abortChatStreamOnly;
  A.chat.startChatStreaming = startChatStreaming;
  A.chat.wireResumeUpload = wireResumeUpload;

  // init hook called by loader after modules
  const oldInit = A.init;
  A.init = async () => {
    // core init already registers load handler; call it first
    if (typeof oldInit === "function") await oldInit();
    await init();
  };

  // actions used by other modules if needed
  A.actions = { startAll, stopAll, hardClearTranscript };
})();
