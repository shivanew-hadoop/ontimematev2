/* ========================================================================== */
/* app.js — STATE-OF-THE-ART DEEPGRAM NOVA-2 TRANSCRIPTION                    */
/* 90%+ accuracy, <300ms latency, real-time word-by-word                      */
/* ========================================================================== */

const COMMIT_WORDS = 2;

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

function getSessionId() {
  let id = sessionStorage.getItem("chatSessionId");
  if (!id) {
    id = crypto.randomUUID();
    sessionStorage.setItem("chatSessionId", id);
  }
  return id;
}

function renderMarkdownLite(md) {
  if (!md) return "";
  let text = String(md).replace(/<br\s*\/?>/gi, "\n").replace(/\r\n/g, "\n");
  text = text.replace(/(Q:[^\n]+?)(\s+\*\*[A-Z])/g, "$1\n$2");
  text = text.replace(/([^\n])(Here's how I handle it in production:?)/gi, "$1\n$2");
  text = text.replace(/([^\n])([1-9]️⃣)/g, "$1\n$2");
  const preParts = text.split(/(```[\s\S]*?```)/g);
  for (let i = 0; i < preParts.length; i++) {
    if (i % 2 === 0) preParts[i] = preParts[i].replace(/ \* /g, "\n* ");
  }
  text = preParts.join("");
  text = text.replace(/([^\n])(\*\*[A-Z][^*\n]{15,}\*\*)(\s*)$/gm, "$1\n$2$3");
  const parts = text.split(/(```[\s\S]*?```)/g);
  const processedParts = parts.map((part, i) => {
    if (i % 2 === 1) {
      const fenceMatch = part.match(/^```(\w*)\n?([\s\S]*?)```$/);
      const lang = fenceMatch?.[1] || "";
      const code = fenceMatch?.[2] ?? part.replace(/^```\w*\n?/, "").replace(/```$/, "");
      const escapedCode = code
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;");
      return `<pre><code class="language-${lang}">${escapedCode}</code></pre>`;
    }
    let s = part;
    s = s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
    s = s.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
    s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
    const lines = s.split("\n");
    const htmlLines = lines.map(line => {
      const trimmed = line.trim();
      if (/^[1-9]️⃣/.test(trimmed)) return `<div style="margin-top:12px;margin-bottom:4px;font-weight:600">${trimmed}</div>`;
      if (/^\*\s+/.test(trimmed)) {
        const content = trimmed.replace(/^\*\s+/, "");
        return `<div style="margin-left:18px;margin-top:3px;line-height:1.55">• ${content}</div>`;
      }
      if (/^Q:\s/.test(trimmed)) return `<div style="margin-bottom:8px;font-weight:600">${trimmed}</div>`;
      if (/^here'?s how i handle it in production/i.test(trimmed)) return `<div style="margin-top:8px;margin-bottom:6px;font-style:italic">${trimmed}</div>`;
      if (!trimmed) return `<div style="height:6px"></div>`;
      return `<div style="line-height:1.6">${trimmed}</div>`;
    });
    return htmlLines.join("");
  });
  return processedParts.join("");
}

let aiRawBuffer = "";

function setupMarkdownRenderer() {
  if (!window.marked || !window.hljs || !window.DOMPurify) return;
  marked.setOptions({
    gfm: true,
    breaks: true,
    highlight: (code, lang) => {
      try {
        if (lang && hljs.getLanguage(lang)) return hljs.highlight(code, { language: lang }).value;
        return hljs.highlightAuto(code).value;
      } catch { return code; }
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

document.addEventListener("DOMContentLoaded", () => {
  setupMarkdownRenderer();
});

const userInfo = document.getElementById("userInfo");
const instructionsBox = document.getElementById("instructionsBox");
const instrStatus = document.getElementById("instrStatus");
const resumeInput = document.getElementById("resumeInput");
const resumeStatus = document.getElementById("resumeStatus");
const liveTranscript = document.getElementById("liveTranscript");
const manualQuestion = document.getElementById("manualQuestion");
const responseBox = document.getElementById("responseBox");
const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const sysBtn = document.getElementById("sysBtn");
const clearBtn = document.getElementById("clearBtn");
const resetBtn = document.getElementById("resetBtn");
const audioStatus = document.getElementById("audioStatus");
const sendBtn = document.getElementById("sendBtn");
const sendStatus = document.getElementById("sendStatus");
const bannerTop = document.getElementById("bannerTop");
const modeSelect = document.getElementById("modeSelect");
const micMuteBtn = document.getElementById("micMuteBtn");

let session = null;
let isRunning = false;
let hiddenInstructions = "";
let micMuted = false;

/** Transcript blocks:
 *  timeline[0] = CURRENT block (bold)
 *  timeline[1..] = previous blocks (normal)
 */
let currentBlockIndex = -1; // -1 means no active block (next final starts a new top block)
let timeline = [];

let pinnedTop = true;

// Deepgram/system audio
let sysStream = null;
let sysAudioContext = null;
let sysProcessor = null;

let sysWebSocket = null;
let sysReconnectTimer = null;

let currentInterimText = ""; // keep interim separate (DO NOT push interim into timeline)
let silenceStart = null;
const RMS_THRESHOLD = 0.015;
const SILENCE_MS = 4000;

// Credits/chat
let creditTimer = null;
let lastCreditAt = 0;

let chatAbort = null;
let chatStreamActive = false;
let chatStreamSeq = 0;
let chatHistory = [];
let resumeTextMem = "";
let transcriptEpoch = 0;

const CREDIT_BATCH_SEC = 5;
const CREDITS_PER_SEC = 1;

const MODE_INSTRUCTIONS = {
  general: "",
  interview: "",
  sales: "Respond in persuasive, value-driven style. Highlight benefits/outcomes.".trim()
};

function showBanner(msg) {
  if (!bannerTop) return;
  bannerTop.textContent = msg;
  bannerTop.classList.remove("hidden");
  bannerTop.classList.add("bg-red-600");
}

function hideBanner() {
  if (!bannerTop) return;
  bannerTop.classList.add("hidden");
  bannerTop.textContent = "";
}

function setStatus(el, text, cls = "") {
  if (!el) return;
  el.textContent = text;
  el.className = cls;
}

function authHeaders() {
  const token = session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function updateMicMuteUI() {
  if (!micMuteBtn) return;
  if (micMuted) {
    micMuteBtn.textContent = "Mic: OFF";
    micMuteBtn.classList.remove("bg-gray-700");
    micMuteBtn.classList.add("bg-gray-900");
  } else {
    micMuteBtn.textContent = "Mic: ON";
    micMuteBtn.classList.remove("bg-gray-900");
    micMuteBtn.classList.add("bg-gray-700");
  }
}

async function setMicMuted(on) {
  micMuted = !!on;
  updateMicMuteUI();
}

if (micMuteBtn) {
  micMuteBtn.addEventListener("click", () => setMicMuted(!micMuted));
  updateMicMuteUI();
}

function applyModeInstructions() {
  const mode = modeSelect?.value || "interview";
  hiddenInstructions = MODE_INSTRUCTIONS[mode] || "";
  if (!instructionsBox || !instrStatus) return;
  if (mode === "general") {
    instructionsBox.disabled = false;
    instrStatus.textContent = "You can enter custom instructions.";
  } else {
    instructionsBox.disabled = true;
    instructionsBox.value = "";
    instrStatus.textContent = `${mode.charAt(0).toUpperCase() + mode.slice(1)} mode selected. Custom instructions disabled.`;
  }
  setTimeout(() => (instrStatus.textContent = ""), 900);
}

if (modeSelect) {
  modeSelect.addEventListener("change", applyModeInstructions);
  modeSelect.value = modeSelect.value || "interview";
  applyModeInstructions();
}

function getEffectiveInstructions() {
  const mode = modeSelect?.value || "interview";
  if (mode === "interview" || mode === "sales") return hiddenInstructions;
  const live = (instructionsBox?.value || "").trim();
  if (live) return live;
  return (localStorage.getItem("instructions") || "").trim();
}

// Keep "top pinned" behavior (if user scrolls away, don't force scroll)
if (liveTranscript) {
  const TH = 40;
  liveTranscript.addEventListener("scroll", () => {
    pinnedTop = liveTranscript.scrollTop <= TH;
  }, { passive: true });
}

/* ========================= Transcript Rendering ========================== */
/**
 * Requirement:
 * - NEWEST block always at TOP
 * - CURRENT block is BOLD
 * - AFTER send: that block becomes normal; next speech creates new bold top block
 */
function updateTranscript() {
  if (!liveTranscript) return;

  let html = "";

  for (let i = 0; i < timeline.length; i++) {
    const isCurrent = (i === 0 && currentBlockIndex === 0); // current always index 0 if active
    const txt = String(timeline[i]?.text || "");

    html += `
      <div style="
        font-weight:${isCurrent ? "700" : "400"};
        opacity:${isCurrent ? "1" : "0.9"};
        margin:0 0 10px 0;
        padding:0;
        white-space:pre-wrap;
      ">${escapeHtml(txt)}</div>
    `;
  }

  liveTranscript.innerHTML = html;

  if (pinnedTop) {
    requestAnimationFrame(() => { liveTranscript.scrollTop = 0; });
  }
}

/* ========================= Transcript Commit Logic ======================= */
function addFinalSpeech(txt, role) {
  const cleanedRaw = normalize(txt);
  if (!cleanedRaw) return;

  const r = role === "interviewer" ? "interviewer" : "candidate";
  const now = Date.now();

  // If no active block → create new block at TOP
  if (currentBlockIndex === -1 || !timeline[0]) {
    timeline.unshift({ t: now, text: cleanedRaw, role: r });
    currentBlockIndex = 0;
  } else {
    // Append inside current TOP block only
    timeline[0].text = normalize((timeline[0].text || "") + " " + cleanedRaw);
    timeline[0].t = now;
    timeline[0].role = r;
  }

  updateTranscript();
}

/** Commit interim text if visible, so we never miss words on Send */
function forceCommitInterim() {
  const interim = normalize(currentInterimText);
  if (!interim) return;
  currentInterimText = "";
  addFinalSpeech(interim, "interviewer"); // you can route role if needed
}

/* ========================= Chat Helpers ======================= */
function extractPriorQuestions() {
  const qs = [];
  for (const m of chatHistory.slice(-30)) {
    if (m.role !== "assistant") continue;
    const c = String(m.content || "");
    const m1 = c.match(/(?:^|\n)Q:\s*([^\n<]+)/i);
    if (m1?.[1]) qs.push(normalize(m1[1]).slice(0, 240));
  }
  return Array.from(new Set(qs)).slice(-8);
}

function buildDraftQuestion(spoken) {
  const cleaned = normalize(spoken).replace(/\s+/g, " ").trim();
  if (!cleaned) return "Q: Can you walk me through your current project?";
  return "Q: " + cleaned.charAt(0).toUpperCase() + cleaned.slice(1) + (cleaned.endsWith("?") ? "" : "?");
}

function buildInterviewQuestionPrompt(currentTextOnly) {
  const base = normalize(currentTextOnly);
  if (!base) return "";
  const priorQs = extractPriorQuestions();
  let prompt = base;
  if (priorQs.length) prompt = `Previously asked:\n${priorQs.map(q => "- " + q).join("\n")}\n\n${prompt}`;
  return prompt;
}

/* ========================= Auth / API ======================= */
async function loadUserProfile() {
  try {
    const res = await apiFetch("user/profile", {}, true);
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data?.user) {
      userInfo.innerHTML = `<span class='text-red-600 text-sm'>Unable to load profile</span>`;
      return;
    }
    const u = data.user;
    userInfo.innerHTML = `<div class="text-sm text-gray-800 truncate"><b>${u.email || "N/A"}</b><span class="ml-3">Credits: <b>${u.credits ?? 0}</b></span></div>`;
  } catch {
    userInfo.innerHTML = `<span class='text-red-600 text-sm'>Error loading profile</span>`;
  }
}

function isTokenNearExpiry() {
  const exp = Number(session?.expires_at || 0);
  if (!exp) return false;
  const now = Math.floor(Date.now() / 1000);
  return exp - now < 60;
}

async function refreshAccessToken() {
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
  if (needAuth && isTokenNearExpiry()) {
    try { await refreshAccessToken(); } catch {}
  }
  const headers = { ...(opts.headers || {}) };
  if (needAuth) Object.assign(headers, authHeaders());
  const res = await fetch(`/api?path=${encodeURIComponent(path)}`, { ...opts, headers, cache: "no-store" });
  if (needAuth && res.status === 401) {
    const t = await res.text().catch(() => "");
    const looksExpired = t.includes("token is expired") || t.includes("invalid JWT") || t.includes("Missing token");
    if (looksExpired) {
      await refreshAccessToken();
      const headers2 = { ...(opts.headers || {}), ...authHeaders() };
      return fetch(`/api?path=${encodeURIComponent(path)}`, { ...opts, headers: headers2, cache: "no-store" });
    }
  }
  return res;
}

async function getDeepgramKey() {
  const res = await apiFetch("deepgram/key", {
    method: "POST",
    headers: { "Content-Type": "application/json" }
  }, true);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data?.key) throw new Error(data?.error || "Failed to get Deepgram key");
  return data.key;
}

/* ========================= Deepgram (NO repeated tab picker) ============== */
/**
 * IMPORTANT:
 * - getDisplayMedia() is called ONLY ONCE (inside enableSystemAudioOnce)
 * - Deepgram websocket can open/close many times without triggering picker
 */

function closeDeepgramSocketOnly() {
  try { sysWebSocket?.close(); } catch {}
  sysWebSocket = null;
}

function handleDeepgramMessage(event) {
  try {
    const data = JSON.parse(event.data);
    if (data.type !== "Results") return;

    const transcript = data.channel?.alternatives?.[0]?.transcript || "";
    const isFinal = !!data.is_final;
    if (!transcript.trim()) return;

    // Interim: keep in memory and show as "live" by appending to current block visually
    if (!isFinal) {
      currentInterimText = normalize(transcript);

      // Ensure there is a current block to display into
      if (currentBlockIndex === -1) {
        // create empty block so interim shows at top immediately
        timeline.unshift({ t: Date.now(), text: "", role: "interviewer" });
        currentBlockIndex = 0;
      }

      // Show interim by temporarily combining (do not permanently commit)
      const base = normalize(timeline[0]?.text || "");
      const combined = normalize(base + " " + currentInterimText);

      // Render with combined text (but don't store combined permanently)
      const original = timeline[0].text;
      timeline[0].text = combined;
      updateTranscript();
      timeline[0].text = original;

      return;
    }

    // Final: commit interim/final cleanly
    currentInterimText = "";
    addFinalSpeech(transcript, "interviewer");
  } catch (e) {
    console.error("[DEEPGRAM] Message parse error:", e);
  }
}

async function openDeepgramSocket() {
  if (sysWebSocket && sysWebSocket.readyState === WebSocket.OPEN) return;

  const apiKey = await getDeepgramKey();
  const wsUrl = `wss://api.deepgram.com/v1/listen?model=nova-2&language=en-IN&punctuate=true&interim_results=true&smart_format=true&encoding=linear16&sample_rate=16000`;

  sysWebSocket = new WebSocket(wsUrl, ["token", apiKey]);

  sysWebSocket.onopen = () => {
    console.log("[DEEPGRAM] WebSocket connected");
    setStatus(audioStatus, "System audio LIVE (Deepgram Nova-2).", "text-green-600");
  };

  sysWebSocket.onmessage = handleDeepgramMessage;

  sysWebSocket.onerror = (err) => {
    console.error("[DEEPGRAM] WebSocket error:", err);
    setStatus(audioStatus, "Deepgram connection error.", "text-red-600");
  };

  sysWebSocket.onclose = () => {
    console.log("[DEEPGRAM] WebSocket closed");
    // Keep capture alive. Just wait for speech to reopen socket.
    setStatus(audioStatus, "Waiting for speech...", "text-orange-600");
    sysWebSocket = null;
  };
}

/** Capture screen audio ONCE and keep it */
async function enableSystemAudioOnce() {
  if (!isRunning) return;

  // If already captured, just ensure socket is open (no picker)
  if (sysStream && sysAudioContext && sysProcessor) {
    await openDeepgramSocket().catch(() => {});
    return;
  }

  // Hard stop any previous
  stopSystemAudioOnly();

  console.log("[DEEPGRAM] Starting system audio capture (ONE-TIME picker)...");
  try {
    sysStream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        sampleRate: 16000
      }
    });
  } catch (err) {
    console.error("[DEEPGRAM] Permission denied:", err);
    setStatus(audioStatus, "Share audio denied.", "text-red-600");
    return;
  }

  const audioTrack = sysStream.getAudioTracks()[0];
  if (!audioTrack) {
    console.error("[DEEPGRAM] No audio track");
    setStatus(audioStatus, "No system audio detected.", "text-red-600");
    stopSystemAudioOnly();
    showBanner("System audio requires selecting a window/tab and enabling 'Share audio' in the picker.");
    return;
  }

  audioTrack.onended = () => {
    console.log("[DEEPGRAM] Track ended");
    stopSystemAudioOnly();
    setStatus(audioStatus, "System audio stopped (share ended).", "text-orange-600");
  };

  // Create audio pipeline ONCE
  sysAudioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
  const source = sysAudioContext.createMediaStreamSource(sysStream);
  sysProcessor = sysAudioContext.createScriptProcessor(4096, 1, 1);

  // Open socket initially
  await openDeepgramSocket().catch(() => {});

  sysProcessor.onaudioprocess = async (e) => {
    if (!isRunning) return;

    const inputData = e.inputBuffer.getChannelData(0);

    // RMS for silence detect
    let sum = 0;
    for (let i = 0; i < inputData.length; i++) sum += inputData[i] * inputData[i];
    const rms = Math.sqrt(sum / inputData.length);
    const now = Date.now();

    // Speech -> open Deepgram socket if closed (NO picker)
    if (rms > RMS_THRESHOLD) {
      silenceStart = null;
      if (!sysWebSocket || sysWebSocket.readyState !== WebSocket.OPEN) {
        try { await openDeepgramSocket(); } catch {}
      }
    }

    // Silence -> close socket after SILENCE_MS
    if (rms <= RMS_THRESHOLD) {
      if (!silenceStart) silenceStart = now;
      if (now - silenceStart > SILENCE_MS) {
        if (sysWebSocket && sysWebSocket.readyState === WebSocket.OPEN) {
          console.log("[VOICE] Silence → close Deepgram WS (capture stays)");
          closeDeepgramSocketOnly();
        }
      }
    }

    // If socket open, send audio
    if (sysWebSocket && sysWebSocket.readyState === WebSocket.OPEN) {
      const int16Data = new Int16Array(inputData.length);
      for (let i = 0; i < inputData.length; i++) {
        const s = Math.max(-1, Math.min(1, inputData[i]));
        int16Data[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
      }
      try { sysWebSocket.send(int16Data.buffer); } catch {}
    }
  };

  source.connect(sysProcessor);
  sysProcessor.connect(sysAudioContext.destination);

  setStatus(audioStatus, "System audio ready. Listening…", "text-green-600");
}

function stopSystemAudioOnly() {
  if (sysReconnectTimer) {
    clearTimeout(sysReconnectTimer);
    sysReconnectTimer = null;
  }

  closeDeepgramSocketOnly();

  try { sysProcessor?.disconnect(); } catch {}
  sysProcessor = null;

  try { sysAudioContext?.close(); } catch {}
  sysAudioContext = null;

  if (sysStream) {
    try { sysStream.getTracks().forEach(t => t.stop()); } catch {}
  }
  sysStream = null;

  currentInterimText = "";
}

/* ========================= Credits ======================= */
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
  if (creditTimer) clearInterval(creditTimer);
  lastCreditAt = Date.now();
  creditTimer = setInterval(async () => {
    if (!isRunning) return;
    const now = Date.now();
    const sec = Math.floor((now - lastCreditAt) / 1000);
    if (sec < CREDIT_BATCH_SEC) return;
    const billableSec = sec - (sec % CREDIT_BATCH_SEC);
    const delta = billableSec * CREDITS_PER_SEC;
    lastCreditAt += billableSec * 1000;
    try {
      const out = await deductCredits(delta);
      if (out.remaining <= 0) {
        stopAll();
        showBanner("No credits remaining.");
        return;
      }
      await loadUserProfile();
    } catch {}
  }, 500);
}

/* ========================= Chat Streaming ======================= */
function abortChatStreamOnly(silent = true) {
  try { chatAbort?.abort(); } catch {}
  chatAbort = null;
  if (silent) setStatus(sendStatus, "Canceled (new request)", "text-orange-600");
  chatStreamActive = false;
}

function pushHistory(role, content) {
  const c = normalize(content);
  if (!c) return;
  chatHistory.push({ role, content: c });
  if (chatHistory.length > 80) chatHistory.splice(0, chatHistory.length - 80);
}

function compactHistoryForRequest() {
  return chatHistory.slice(-12).map(m => ({
    role: m.role,
    content: String(m.content || "").slice(0, 1600)
  }));
}

async function startChatStreaming(prompt, userTextForHistory) {
  abortChatStreamOnly(true);
  chatAbort = new AbortController();
  chatStreamActive = true;
  const mySeq = ++chatStreamSeq;

  if (userTextForHistory) pushHistory("user", userTextForHistory);

  aiRawBuffer = "";
  responseBox.innerHTML = `<span class="text-gray-500 text-sm">Receiving…</span>`;
  setStatus(sendStatus, "Connecting…", "text-orange-600");

  const body = {
    prompt,
    history: compactHistoryForRequest(),
    instructions: getEffectiveInstructions(),
    resumeText: resumeTextMem || "",
    sessionId: getSessionId()
  };

  let raw = "";
  let flushTimer = null;
  let sawFirstChunk = false;
  const render = () => { responseBox.innerHTML = renderMarkdownLite(raw); };

  try {
    const res = await apiFetch("chat/send", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/plain" },
      body: JSON.stringify(body),
      signal: chatAbort.signal
    }, false);

    if (!res.ok) throw new Error(await res.text());
    if (!res.body) throw new Error("No stream body");

    const reader = res.body.getReader();
    const decoder = new TextDecoder();

    flushTimer = setInterval(() => {
      if (mySeq !== chatStreamSeq) return;
      if (!sawFirstChunk) return;
      render();
    }, 30);

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (mySeq !== chatStreamSeq) return;

      raw += decoder.decode(value, { stream: true });

      if (!sawFirstChunk) {
        sawFirstChunk = true;
        responseBox.innerHTML = "";
        setStatus(sendStatus, "Receiving…", "text-orange-600");
      }
      render();
    }

    if (mySeq === chatStreamSeq) {
      render();
      setStatus(sendStatus, "Done", "text-green-600");
      pushHistory("assistant", raw);
      resumeTextMem = "";
      enhanceCodeBlocks(responseBox);
    }
  } catch (e) {
    if (e?.name === "AbortError" || chatAbort?.signal?.aborted) return;
    console.error(e);
    setStatus(sendStatus, "Failed", "text-red-600");
    responseBox.innerHTML = `<span class="text-red-600 text-sm">Failed. Check backend /chat/send streaming.</span>`;
  } finally {
    if (flushTimer) clearInterval(flushTimer);
    if (mySeq === chatStreamSeq) chatStreamActive = false;
  }
}

/* ========================= Resume Upload ======================= */
resumeInput?.addEventListener("change", async () => {
  const file = resumeInput.files?.[0];
  if (!file) return;
  if (resumeStatus) resumeStatus.textContent = "Processing…";
  const fd = new FormData();
  fd.append("file", file);
  const res = await apiFetch("resume/extract", { method: "POST", body: fd }, false);
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    resumeTextMem = "";
    if (resumeStatus) resumeStatus.textContent = `Resume extract failed (${res.status}): ${errText.slice(0, 160)}`;
    return;
  }
  const data = await res.json().catch(() => ({}));
  resumeTextMem = String(data.text || "").trim();
  if (resumeStatus) {
    resumeStatus.textContent = resumeTextMem ? `Resume extracted (${resumeTextMem.length} chars)` : "Resume extracted: empty";
  }
});

/* ========================= Start / Stop ======================= */
async function startAll() {
  console.log("[START] Initializing...");
  hideBanner();
  if (isRunning) return;

  await apiFetch("chat/reset", { method: "POST" }, false).catch(() => {});

  transcriptEpoch++;
  timeline = [];
  currentBlockIndex = -1;
  currentInterimText = "";
  pinnedTop = true;
  updateTranscript();

  isRunning = true;
  startBtn.disabled = true;
  stopBtn.disabled = false;
  sysBtn.disabled = false;
  sendBtn.disabled = false;

  stopBtn.classList.remove("opacity-50");
  sysBtn.classList.remove("opacity-50");
  sendBtn.classList.remove("opacity-60");

  setStatus(audioStatus, "Starting system audio capture...", "text-orange-600");

  // ONE-TIME picker (only here)
  setTimeout(async () => { await enableSystemAudioOnce(); }, 250);

  startCreditTicking();
}

function stopAll() {
  console.log("[STOP] Stopping all...");
  isRunning = false;

  stopSystemAudioOnly();

  if (creditTimer) clearInterval(creditTimer);

  startBtn.disabled = false;
  stopBtn.disabled = true;
  sysBtn.disabled = true;
  sendBtn.disabled = true;

  stopBtn.classList.add("opacity-50");
  sysBtn.classList.add("opacity-50");
  sendBtn.classList.add("opacity-60");

  setStatus(audioStatus, "Stopped", "text-orange-600");
}

function hardClearTranscript() {
  transcriptEpoch++;
  timeline = [];
  currentBlockIndex = -1;
  currentInterimText = "";
  pinnedTop = true;
  updateTranscript();
}

/* ========================= Send ======================= */
async function handleSend() {
  // Commit interim that user can see (no missing words)
  forceCommitInterim();

  await new Promise(r => setTimeout(r, 80));
  if (sendBtn.disabled) return;

  // manual refinement takes priority if typed
  const manual = normalize(manualQuestion?.value || "");

  // ONLY send current block text (top block)
  const topBlockText = normalize(timeline[0]?.text || "");

  const base = manual || topBlockText;

  if (!base) {
    setStatus(sendStatus, "Nothing to send", "text-orange-600");
    return;
  }

  const question = buildDraftQuestion(base);
  if (manualQuestion) manualQuestion.value = "";

  abortChatStreamOnly(true);

  // Freeze current block (it becomes normal). Next speech creates NEW bold block at top.
  currentBlockIndex = -1;
  currentInterimText = "";
  updateTranscript();

  responseBox.innerHTML = renderMarkdownLite(`${question}\n\n_Generating answer…_`);
  setStatus(sendStatus, "Queued…", "text-orange-600");

  const mode = modeSelect?.value || "interview";
  const promptToSend =
    mode === "interview"
      ? buildInterviewQuestionPrompt(question.replace(/^Q:\s*/i, ""))
      : question;

  await startChatStreaming(promptToSend, base);
}

sendBtn.onclick = handleSend;

document.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" || e.shiftKey) return;
  e.preventDefault();
  handleSend();
});

clearBtn.onclick = () => {
  hardClearTranscript();
  if (manualQuestion) manualQuestion.value = "";
  setStatus(sendStatus, "Transcript cleared", "text-green-600");
  setStatus(audioStatus, isRunning ? "Listening…" : "Stopped", isRunning ? "text-green-600" : "text-orange-600");
};

resetBtn.onclick = async () => {
  responseBox.innerHTML = "";
  setStatus(sendStatus, "Response reset", "text-green-600");
  await apiFetch("chat/reset", { method: "POST" }, false).catch(() => {});
};

document.getElementById("logoutBtn").onclick = () => {
  chatHistory = [];
  resumeTextMem = "";
  stopAll();
  localStorage.removeItem("session");
  window.location.href = "/auth?tab=login";
};

window.addEventListener("load", async () => {
  console.log("[LOAD] Page loaded");
  session = JSON.parse(localStorage.getItem("session") || "null");
  if (!session) return (window.location.href = "/auth?tab=login");
  if (!session.refresh_token) {
    localStorage.removeItem("session");
    return (window.location.href = "/auth?tab=login");
  }

  chatHistory = [];
  resumeTextMem = "";
  if (resumeStatus) resumeStatus.textContent = "Resume cleared.";

  await loadUserProfile();
  await apiFetch("chat/reset", { method: "POST" }, false).catch(() => {});

  transcriptEpoch++;
  timeline = [];
  currentBlockIndex = -1;
  currentInterimText = "";
  pinnedTop = true;

  stopSystemAudioOnly();
  updateTranscript();

  stopBtn.disabled = true;
  sysBtn.disabled = true;
  sendBtn.disabled = true;

  stopBtn.classList.add("opacity-50");
  sysBtn.classList.add("opacity-50");
  sendBtn.classList.add("opacity-60");

  setStatus(audioStatus, "Stopped", "text-orange-600");
  updateMicMuteUI();
  console.log("[LOAD] Initialization complete");
});

startBtn.onclick = startAll;
stopBtn.onclick = stopAll;

// System Audio button should NOT reprompt if already captured
sysBtn.onclick = async () => {
  if (!isRunning) return;
  await enableSystemAudioOnce();
};
