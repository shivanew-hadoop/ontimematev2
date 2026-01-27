/* app.js - orchestration only (DOM refs + start/stop + send wiring) */
(function () {
  window.ANU = window.ANU || {};
  const ANU = window.ANU;
  const { setupMarkdownRenderer, apiFetch, setStatus, hideBanner, loadUserProfile, renderMarkdownLite } = ANU.core;

  ANU.state = ANU.state || {
    session: null,
    isRunning: false,
    creditTimer: null,
    lastCreditAt: 0
  };

  const refs = {
    userInfo: document.getElementById("userInfo"),
    instructionsBox: document.getElementById("instructionsBox"),
    instrStatus: document.getElementById("instrStatus"),
    resumeInput: document.getElementById("resumeInput"),
    resumeStatus: document.getElementById("resumeStatus"),

    liveTranscript: document.getElementById("liveTranscript"),
    manualQuestion: document.getElementById("manualQuestion"),

    responseBox: document.getElementById("responseBox"),
    startBtn: document.getElementById("startBtn"),
    stopBtn: document.getElementById("stopBtn"),
    sysBtn: document.getElementById("sysBtn"),
    clearBtn: document.getElementById("clearBtn"),
    resetBtn: document.getElementById("resetBtn"),
    audioStatus: document.getElementById("audioStatus"),
    sendBtn: document.getElementById("sendBtn"),
    sendStatus: document.getElementById("sendStatus"),
    bannerTop: document.getElementById("bannerTop"),
    modeSelect: document.getElementById("modeSelect"),
    micMuteBtn: document.getElementById("micMuteBtn"),
    logoutBtn: document.getElementById("logoutBtn")
  };

  // ---- credits (kept same logic) ----
  const CREDIT_BATCH_SEC = 5;
  const CREDITS_PER_SEC = 1;

  async function deductCredits(delta) {
    const res = await apiFetch("user/deduct", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ delta })
    }, true);

    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Deduct failed");
    return data;
  }

  function startCreditTicking() {
    if (ANU.state.creditTimer) clearInterval(ANU.state.creditTimer);
    ANU.state.lastCreditAt = Date.now();

    ANU.state.creditTimer = setInterval(async () => {
      if (!ANU.state.isRunning) return;

      const now = Date.now();
      const sec = Math.floor((now - ANU.state.lastCreditAt) / 1000);
      if (sec < CREDIT_BATCH_SEC) return;

      const billableSec = sec - (sec % CREDIT_BATCH_SEC);
      const delta = billableSec * CREDITS_PER_SEC;
      ANU.state.lastCreditAt += billableSec * 1000;

      try {
        const out = await deductCredits(delta);
        if (out.remaining <= 0) {
          stopAll();
          if (refs.bannerTop) {
            refs.bannerTop.textContent = "No credits remaining.";
            refs.bannerTop.classList.remove("hidden");
          }
          return;
        }
        await loadUserProfile(refs);
      } catch {}
    }, 500);
  }

  // ---- lifecycle ----
  async function startAll() {
    hideBanner(refs);
    if (ANU.state.isRunning) return;

    await apiFetch("chat/reset", { method: "POST" }, false).catch(() => {});

    // reset transcript state
    ANU.transcript.state.transcriptEpoch++;
    ANU.transcript.state.timeline = [];
    ANU.transcript.state.micInterimEntry = null;
    ANU.transcript.state.lastSpeechAt = 0;
    ANU.transcript.state.sentCursor = 0;
    ANU.transcript.state.pinnedTop = true;

    ANU.transcript.state.lastSysTail = "";
    ANU.transcript.state.lastMicTail = "";
    ANU.transcript.state.lastSysPrinted = "";
    ANU.transcript.state.lastSysPrintedAt = 0;
    ANU.transcript.resetRoleCommitState();

    ANU.asr.stopAsrSession("mic");
    ANU.asr.stopAsrSession("sys");

    ANU.transcript.updateTranscript();

    ANU.state.isRunning = true;

    refs.startBtn.disabled = true;
    refs.stopBtn.disabled = false;
    refs.sysBtn.disabled = false;
    refs.sendBtn.disabled = false;

    refs.stopBtn.classList.remove("opacity-50");
    refs.sysBtn.classList.remove("opacity-50");
    refs.sendBtn.classList.remove("opacity-60");

    // Preserve your current behavior: start mic realtime immediately
    try {
      await ANU.asr.bootstrapMicRealtime();
    } catch {
      setStatus(refs.audioStatus, "Mic streaming ASR failed. Enable mic permissions and retry.", "text-orange-600");
    }

    startCreditTicking();
  }

  function stopAll() {
    ANU.state.isRunning = false;

    ANU.asr.stopAllAudio();

    if (ANU.state.creditTimer) clearInterval(ANU.state.creditTimer);

    refs.startBtn.disabled = false;
    refs.stopBtn.disabled = true;
    refs.sysBtn.disabled = true;
    refs.sendBtn.disabled = true;

    refs.stopBtn.classList.add("opacity-50");
    refs.sysBtn.classList.add("opacity-50");
    refs.sendBtn.classList.add("opacity-60");

    setStatus(refs.audioStatus, "Stopped", "text-orange-600");
  }

  async function handleSend() {
    if (refs.sendBtn.disabled) return;

    const manual = ANU.core.normalize(refs.manualQuestion?.value || "");
    const quickSnap = ANU.transcript.getQuickInterviewerSnapshot();
    const freshInterviewer = ANU.core.normalize(ANU.transcript.getFreshInterviewerBlocksText());

    let base = "";
    if (manual) base = manual;
    else if (quickSnap) {
      base = quickSnap.text;
      ANU.transcript.state.lastQuickInterviewerAt = quickSnap.at;
    } else base = freshInterviewer;

    if (!base) return;

    ANU.transcript.updateTopicMemory(base);
    const question = ANU.transcript.buildDraftQuestion(base);

    if (refs.manualQuestion) refs.manualQuestion.value = "";

    // identical to your previous logic
    ANU.chat.abortChatStreamOnly(true);

    ANU.asr.state.blockMicUntil = Date.now() + 700;
    ANU.transcript.removeInterimIfAny();

    ANU.transcript.state.sentCursor = ANU.transcript.state.timeline.length;
    ANU.transcript.state.pinnedTop = true;
    ANU.transcript.updateTranscript();

    refs.responseBox.innerHTML = renderMarkdownLite(`${question}\n\n_Generating answer…_`);
    setStatus(refs.sendStatus, "Queued…", "text-orange-600");

    const mode = refs.modeSelect?.value || "interview";
    const promptToSend =
      mode === "interview"
        ? ANU.chat.buildInterviewQuestionPrompt(question.replace(/^Q:\s*/i, ""))
        : question;

    await ANU.chat.startChatStreaming(promptToSend, base);
  }

  // ---- wiring ----
  document.addEventListener("DOMContentLoaded", () => {
    setupMarkdownRenderer();
  });

  window.addEventListener("load", async () => {
    ANU.state.session = JSON.parse(localStorage.getItem("session") || "null");
    if (!ANU.state.session) return (window.location.href = "/auth?tab=login");

    if (!ANU.state.session.refresh_token) {
      localStorage.removeItem("session");
      return (window.location.href = "/auth?tab=login");
    }

    // init modules
    ANU.transcript.init(refs.liveTranscript);
    ANU.chat.init(refs);
    ANU.chat.setSendStatusEl(refs.sendStatus);
    ANU.asr.init(refs);

    ANU.chat.clearResume();

    await loadUserProfile(refs);
    await apiFetch("chat/reset", { method: "POST" }, false).catch(() => {});

    ANU.transcript.state.transcriptEpoch++;
    ANU.transcript.hardClearTranscript();

    refs.stopBtn.disabled = true;
    refs.sysBtn.disabled = true;
    refs.sendBtn.disabled = true;

    refs.stopBtn.classList.add("opacity-50");
    refs.sysBtn.classList.add("opacity-50");
    refs.sendBtn.classList.add("opacity-60");

    setStatus(refs.audioStatus, "Stopped", "text-orange-600");
  });

  refs.startBtn.onclick = startAll;
  refs.stopBtn.onclick = stopAll;

  refs.sysBtn.onclick = () => ANU.asr.enableSystemAudio(refs);

  refs.sendBtn.onclick = handleSend;

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || e.shiftKey) return;
    e.preventDefault();
    handleSend();
  });

  refs.clearBtn.onclick = () => {
    ANU.transcript.hardClearTranscript();
    if (refs.manualQuestion) refs.manualQuestion.value = "";
    setStatus(refs.sendStatus, "Transcript cleared", "text-green-600");
    setStatus(refs.audioStatus, ANU.state.isRunning ? "Listening…" : "Stopped", ANU.state.isRunning ? "text-green-600" : "text-orange-600");
  };

  refs.resetBtn.onclick = async () => {
    refs.responseBox.innerHTML = "";
    setStatus(refs.sendStatus, "Response reset", "text-green-600");
    await apiFetch("chat/reset", { method: "POST" }, false).catch(() => {});
  };

  refs.logoutBtn.onclick = () => {
    ANU.chat.state.chatHistory = [];
    ANU.chat.clearResume();
    stopAll();
    localStorage.removeItem("session");
    window.location.href = "/auth?tab=login";
  };
})();
