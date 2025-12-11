//--------------------------------------------------------------
// DOM
//--------------------------------------------------------------
const userInfo = document.getElementById("userInfo");
const instructionsBox = document.getElementById("instructionsBox");
const instrStatus = document.getElementById("instrStatus");
const resumeInput = document.getElementById("resumeInput");
const resumeStatus = document.getElementById("resumeStatus");
const promptBox = document.getElementById("promptBox");
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

//--------------------------------------------------------------
// STATE
//--------------------------------------------------------------
let session = null;
let isRunning = false;

// MIC (browser SR)
let recognition = null;
let blockMicUntil = 0;
let micInterimEntry = null; // live partial text entry for mic

// MIC via Whisper (Chrome-only)
let micStream = null;
let micRecorder = null;
let micChunks = [];
let micTimer = null;
let micAbort = null;
let micQueue = [];
let micInFlight = 0;

// SYSTEM AUDIO
let sysStream = null;
let sysTrack = null;
let sysRecorder = null;
let sysSegmentChunks = [];
let sysSegmentTimer = null;
let sysQueue = [];
let sysAbort = null;
let sysInFlight = 0;

// transcript timeline
let timeline = [];

// credits
let creditTimer = null;
let lastCreditAt = 0;

// chat stream cancellation
let chatAbort = null;
let chatStreamActive = false;
let chatStreamSeq = 0;

// memory
let chatHistory = [];
const MAX_HISTORY_MESSAGES = 8;
const MAX_HISTORY_CHARS_EACH = 1500;

// resume memory
let resumeTextMem = "";

// system audio dedupe
let lastSysTail = "";

//--------------------------------------------------------------
// CONFIG
//--------------------------------------------------------------
const SYS_SEGMENT_MS = 2800;
const SYS_MIN_BYTES = 6000;
const SYS_MAX_CONCURRENT = 2;
const SYS_TYPE_MS_PER_WORD = 18;

const CREDIT_BATCH_SEC = 5;
const CREDITS_PER_SEC = 1;

const MIC_LANGS = ["en-IN", "en-GB", "en-US"];
let micLangIndex = 0;

const WHISPER_BIAS_PROMPT =
  "Transcribe clearly in English. Handle Indian, British, Australian, and American accents. Keep proper nouns and numbers.";

// Chrome detection (not Edge / Opera)
const ua = navigator.userAgent || "";
const IS_CHROME =
  ua.includes("Chrome") &&
  !ua.includes("Edg") &&
  !ua.includes("OPR");

// Mic-via-Whisper segment config (Chrome only)
const MIC_SEGMENT_MS = 1300;
const MIC_MIN_BYTES = 1500;
const MIC_MAX_CONCURRENT = 2;

//--------------------------------------------------------------
// MODE-BASED INSTRUCTIONS
//--------------------------------------------------------------
const MODE_INSTRUCTIONS = {
  general: "",
  
  interview: `
Give responses in human conversational tone. Prioritize real project examples. 
Avoid ChatGPT tone and avoid textbook definitions. 
Always give Quick Answer (Interview Style) first, crisp bullet points, then real-time example from project or resume.
Avoid assumptions; answer based on user's resume context.`,

  sales: `
Give responses in persuasive, human-friendly tone focused on value, benefits, and clarity.
Avoid technical jargon unless asked. 
Use short, confident statements. 
Include mini real-world customer scenario examples.`
};

function applyModeInstructions() {
  const mode = modeSelect.value;
  const text = MODE_INSTRUCTIONS[mode] || "";

  instructionsBox.value = text.trim();
  localStorage.setItem("instructions", text.trim());
  instrStatus.textContent = "Mode instructions applied";
  instrStatus.className = "text-green-600";
  setTimeout(() => (instrStatus.textContent = ""), 800);
}

modeSelect.addEventListener("change", applyModeInstructions);

//--------------------------------------------------------------
// Helpers
//--------------------------------------------------------------
function showBanner(msg) {
  bannerTop.textContent = msg;
  bannerTop.classList.remove("hidden");
  bannerTop.classList.add("bg-red-600");
}

function hideBanner() {
  bannerTop.classList.add("hidden");
  bannerTop.textContent = "";
}

function setStatus(el, text, cls = "") {
  el.textContent = text;
  el.className = cls;
}

function normalize(s) {
  return (s || "").replace(/\s+/g, " ").trim();
}

function authHeaders() {
  const token = session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function updateTranscript() {
  promptBox.value = timeline.map(t => t.text).join(" ");
  promptBox.scrollTop = promptBox.scrollHeight;
}

function addToTimeline(txt) {
  txt = normalize(txt);
  if (!txt) return;
  timeline.push({ t: Date.now(), text: txt });
  updateTranscript();
}

// TYPEWRITER for audio (system + mic-Whisper)
function addToTimelineTypewriter(txt, msPerWord = SYS_TYPE_MS_PER_WORD) {
  const cleaned = normalize(txt);
  if (!cleaned) return;

  const entry = { t: Date.now(), text: "" };
  timeline.push(entry);

  const words = cleaned.split(" ");
  let i = 0;

  const timer = setInterval(() => {
    if (!isRunning) return clearInterval(timer);
    if (i >= words.length) return clearInterval(timer);

    entry.text += (entry.text ? " " : "") + words[i++];
    updateTranscript();
  }, msPerWord);
}

//--------------------------------------------------------------
// TOKEN REFRESH
//--------------------------------------------------------------
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
    try { await refreshAccessToken(); } catch (e) { console.error(e); }
  }

  const headers = { ...(opts.headers || {}) };
  if (needAuth) Object.assign(headers, authHeaders());

  const res = await fetch(`/api?path=${encodeURIComponent(path)}`, { ...opts, headers });

  if (needAuth && res.status === 401) {
    const t = await res.text().catch(() => "");
    const looksExpired =
      t.includes("token is expired") ||
      t.includes("invalid JWT") ||
      t.includes("Missing token");

    if (looksExpired) {
      await refreshAccessToken();
      const headers2 = { ...(opts.headers || {}), ...authHeaders() };
      return fetch(`/api?path=${encodeURIComponent(path)}`, { ...opts, headers: headers2 });
    }
  }

  return res;
}

//--------------------------------------------------------------
// LOAD USER PROFILE
//--------------------------------------------------------------
async function loadUserProfile() {
  const res = await apiFetch("user/profile", {}, true);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Failed to load profile");

  userInfo.innerHTML =
    `Logged in as <b>${data.user.email}</b><br>` +
    `Credits: <b>${data.user.credits}</b><br>` +
    `Joined: ${data.user.created_ymd}`;
}

//--------------------------------------------------------------
// INSTRUCTIONS SAVING
//--------------------------------------------------------------
instructionsBox.value = localStorage.getItem("instructions") || "";

instructionsBox.addEventListener("input", () => {
  localStorage.setItem("instructions", instructionsBox.value);
  instrStatus.textContent = "Saved";
  instrStatus.className = "text-green-600";
  setTimeout(() => (instrStatus.textContent = ""), 600);
});

function getEffectiveInstructions() {
  const live = (instructionsBox?.value || "").trim();
  if (live) return live;
  return (localStorage.getItem("instructions") || "").trim();
}

//--------------------------------------------------------------
// RESUME UPLOAD
//--------------------------------------------------------------
resumeInput?.addEventListener("change", async () => {
  const file = resumeInput.files?.[0];
  if (!file) return;

  resumeStatus.textContent = "Processing…";

  const fd = new FormData();
  fd.append("file", file);

  const res = await apiFetch("resume/extract", { method: "POST", body: fd }, false);
  const data = await res.json().catch(() => ({}));

  resumeTextMem = String(data.text || "").trim();

  if (!resumeTextMem) {
    resumeStatus.textContent = "Resume extracted: empty";
  } else if (resumeTextMem.startsWith("[Resume upload received")) {
    resumeStatus.textContent = resumeTextMem;
  } else {
    resumeStatus.textContent = `Resume extracted (${resumeTextMem.length} chars)`;
  }
});

//--------------------------------------------------------------
// MIC — SpeechRecognition (Edge / non-Chrome path)
//--------------------------------------------------------------
function stopMicOnly() {
  try { recognition?.stop(); } catch {}
  recognition = null;
  micInterimEntry = null;
}

function startMic() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    setStatus(audioStatus, "SpeechRecognition not supported.", "text-red-600");
    return false;
  }

  stopMicOnly();

  recognition = new SR();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = MIC_LANGS[micLangIndex] || "en-US";

  recognition.onresult = (ev) => {
    if (!isRunning) return;
    if (Date.now() < blockMicUntil) return;

    let latestInterim = "";

    for (let i = ev.resultIndex; i < ev.results.length; i++) {
      const r = ev.results[i];
      const text = normalize(r[0].transcript || "");

      if (r.isFinal) {
        // remove interim entry (if any) and add final as permanent line
        if (micInterimEntry) {
          const idx = timeline.indexOf(micInterimEntry);
          if (idx >= 0) timeline.splice(idx, 1);
          micInterimEntry = null;
        }
        addToTimeline(text);
      } else {
        latestInterim = text;
      }
    }

    // keep interim visible as its own entry and keep updating it
    if (latestInterim) {
      if (!micInterimEntry) {
        micInterimEntry = { t: Date.now(), text: latestInterim };
        timeline.push(micInterimEntry);
      } else {
        micInterimEntry.text = latestInterim;
      }
      updateTranscript(); // shows: all final + current partial, no disappearing
    }
  };

  recognition.onerror = () => {
    micLangIndex = (micLangIndex + 1) % MIC_LANGS.length;
  };

  recognition.onend = () => {
    if (!isRunning) return;
    try { recognition.start(); } catch {}
  };

  try { recognition.start(); } catch {}
  return true;
}

//--------------------------------------------------------------
// MIC via Whisper (Chrome-only path)
//--------------------------------------------------------------
function stopMicWhisperOnly() {
  try { micAbort?.abort(); } catch {}
  micAbort = null;

  if (micTimer) clearInterval(micTimer);
  micTimer = null;

  try { micRecorder?.stop(); } catch {}
  micRecorder = null;

  micChunks = [];
  micQueue = [];
  micInFlight = 0;

  if (micStream) {
    try { micStream.getTracks().forEach(t => t.stop()); } catch {}
  }
  micStream = null;
}

async function startMicWhisper() {
  stopMicWhisperOnly();

  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  } catch (e) {
    console.error(e);
    setStatus(audioStatus, "Mic capture denied.", "text-red-600");
    return false;
  }

  const audioOnly = new MediaStream(micStream.getAudioTracks());
  const mimeType = pickBestMimeType();
  micChunks = [];
  micAbort = new AbortController();

  try {
    micRecorder = new MediaRecorder(audioOnly, mimeType ? { mimeType } : undefined);
  } catch (e) {
    console.error(e);
    setStatus(audioStatus, "Mic recorder failed.", "text-red-600");
    stopMicWhisperOnly();
    return false;
  }

  micRecorder.ondataavailable = (ev) => {
    if (!isRunning) return;
    if (ev.data && ev.data.size) micChunks.push(ev.data);
  };

  micRecorder.onstop = () => {
    if (!isRunning) return;

    const blob = new Blob(micChunks, { type: micRecorder?.mimeType || "" });
    micChunks = [];

    if (blob.size >= MIC_MIN_BYTES) {
      micQueue.push(blob);
      drainMicQueue();
    }

    if (
      isRunning &&
      micStream &&
      micStream.getAudioTracks()[0] &&
      micStream.getAudioTracks()[0].readyState === "live"
    ) {
      startMicWhisperRecorderLoop();
    }
  };

  function startMicWhisperRecorderLoop() {
    try { micRecorder.start(); } catch (e) { console.error(e); return; }

    if (micTimer) clearInterval(micTimer);
    micTimer = setInterval(() => {
      if (!isRunning) return;
      try { micRecorder?.stop(); } catch {}
    }, MIC_SEGMENT_MS);
  }

  startMicWhisperRecorderLoop();
  setStatus(audioStatus, "Mic (Whisper) active.", "text-green-600");
  return true;
}

function drainMicQueue() {
  if (!isRunning) return;

  while (micInFlight < MIC_MAX_CONCURRENT && micQueue.length) {
    const blob = micQueue.shift();
    micInFlight++;

    transcribeMicBlob(blob)
      .catch(e => console.error("mic transcribe error", e))
      .finally(() => {
        micInFlight--;
        drainMicQueue();
      });
  }
}

async function transcribeMicBlob(blob) {
  if (!isRunning) return;

  const fd = new FormData();
  fd.append("file", blob, "mic.webm");
  fd.append("prompt", WHISPER_BIAS_PROMPT);

  const res = await apiFetch("transcribe", {
    method: "POST",
    body: fd,
    signal: micAbort?.signal
  }, false);

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    console.error("mic transcribe failed", res.status, t);
    return;
  }

  const data = await res.json().catch(() => ({}));
  const raw = String(data.text || "").trim();
  if (!raw) return;

  // Stream back into transcript UI
  addToTimelineTypewriter(raw);
}

//--------------------------------------------------------------
// SYSTEM AUDIO
//--------------------------------------------------------------
function pickBestMimeType() {
  const c = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
    "audio/ogg"
  ];
  for (const t of c) {
    if (MediaRecorder.isTypeSupported(t)) return t;
  }
  return "";
}

function stopSystemAudioOnly() {
  try { sysAbort?.abort(); } catch {}
  sysAbort = null;

  if (sysSegmentTimer) clearInterval(sysSegmentTimer);
  sysSegmentTimer = null;

  try { sysRecorder?.stop(); } catch {}
  sysRecorder = null;

  sysSegmentChunks = [];
  sysQueue = [];
  sysInFlight = 0;

  if (sysStream) {
    try { sysStream.getTracks().forEach(t => t.stop()); } catch {}
  }
  sysStream = null;
  sysTrack = null;

  lastSysTail = "";
}

async function enableSystemAudio() {
  if (!isRunning) return;

  stopSystemAudioOnly();

  try {
    sysStream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: true
    });
  } catch {
    setStatus(audioStatus, "Share audio denied.", "text-red-600");
    return;
  }

  sysTrack = sysStream.getAudioTracks()[0];
  if (!sysTrack) {
    setStatus(audioStatus, "No system audio detected.", "text-red-600");
    stopSystemAudioOnly();
    return;
  }

  sysAbort = new AbortController();
  startSystemSegmentRecorder();
  setStatus(audioStatus, "System audio enabled.", "text-green-600");
}

function startSystemSegmentRecorder() {
  if (!sysTrack) return;

  const audioOnly = new MediaStream([sysTrack]);
  const mimeType = pickBestMimeType();
  sysSegmentChunks = [];

  try {
    sysRecorder = new MediaRecorder(audioOnly, mimeType ? { mimeType } : undefined);
  } catch {
    setStatus(audioStatus, "System audio start failed.", "text-red-600");
    return;
  }

  sysRecorder.ondataavailable = (ev) => {
    if (!isRunning) return;
    if (ev.data.size) sysSegmentChunks.push(ev.data);
  };

  sysRecorder.onstop = () => {
    if (!isRunning) return;

    const blob = new Blob(sysSegmentChunks, { type: sysRecorder?.mimeType || "" });
    sysSegmentChunks = [];

    if (blob.size >= SYS_MIN_BYTES) {
      sysQueue.push(blob);
      drainSysQueue();
    }

    if (isRunning && sysTrack.readyState === "live") startSystemSegmentRecorder();
  };

  try { sysRecorder.start(); } catch {}
  if (sysSegmentTimer) clearInterval(sysSegmentTimer);

  sysSegmentTimer = setInterval(() => {
    if (!isRunning) return;
    try { sysRecorder?.stop(); } catch {}
  }, SYS_SEGMENT_MS);
}

function drainSysQueue() {
  if (!isRunning) return;

  while (sysInFlight < SYS_MAX_CONCURRENT && sysQueue.length) {
    const blob = sysQueue.shift();
    sysInFlight++;

    transcribeSysBlob(blob)
      .catch(e => console.error("sys transcribe error", e))
      .finally(() => {
        sysInFlight--;
        drainSysQueue();
      });
  }
}

// slightly more aggressive dedupe to avoid repeated short sentences
function dedupeSystemText(newText) {
  const t = normalize(newText);
  if (!t) return "";

  // If this is a short chunk and already present in recent tail, drop it
  if (t.length <= 180 && lastSysTail && lastSysTail.toLowerCase().includes(t.toLowerCase())) {
    return "";
  }

  const tail = lastSysTail;
  if (!tail) {
    lastSysTail = t.split(" ").slice(-12).join(" ");
    return t;
  }

  const tailWords = tail.split(" ");
  const newWords = t.split(" ");

  let bestK = 0;
  const maxK = Math.min(10, tailWords.length, newWords.length);
  for (let k = maxK; k >= 3; k--) {
    const tw = tailWords.slice(-k).join(" ").toLowerCase();
    const nw = newWords.slice(0, k).join(" ").toLowerCase();
    if (tw === nw) { bestK = k; break; }
  }

  const cleaned = bestK ? newWords.slice(bestK).join(" ") : t;
  lastSysTail = (tail + " " + cleaned).trim().split(" ").slice(-12).join(" ");
  return normalize(cleaned);
}

function looksLikeWhisperHallucination(t) {
  const s = normalize(t).toLowerCase();
  if (!s) return true;

  const bad = [
    "thanks for watching",
    "thank you for watching",
    "subscribe",
    "i'm sorry",
    "i am sorry",
    "please like and subscribe"
  ];
  return bad.some(p => s.includes(p));
}

async function transcribeSysBlob(blob) {
  const fd = new FormData();
  const type = (blob.type || "").toLowerCase();
  const ext = type.includes("ogg") ? "ogg" : "webm";
  fd.append("file", blob, `sys.${ext}`);
  fd.append("prompt", WHISPER_BIAS_PROMPT);

  const res = await apiFetch("transcribe", {
    method: "POST",
    body: fd,
    signal: sysAbort?.signal
  }, false);

  if (!res.ok) return;

  const data = await res.json().catch(() => ({}));
  const raw = String(data.text || "");
  if (looksLikeWhisperHallucination(raw)) return;

  const cleaned = dedupeSystemText(raw);
  if (cleaned) addToTimelineTypewriter(cleaned);
}

//--------------------------------------------------------------
// CREDIT DEDUCTION
//--------------------------------------------------------------
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

    const batchSec = sec - (sec % CREDIT_BATCH_SEC);
    const delta = batchSec * CREDITS_PER_SEC;
    lastCreditAt += batchSec * 1000;

    try {
      const out = await deductCredits(delta);
      if (out.remaining <= 0) {
        stopAll();
        showBanner("No credits remaining.");
        return;
      }
      await loadUserProfile();
    } catch (e) {
      console.error(e);
    }
  }, 500);
}

//--------------------------------------------------------------
// CHAT STREAMING
//--------------------------------------------------------------
function abortChatStreamOnly() {
  try { chatAbort?.abort(); } catch {}
  chatAbort = null;
  chatStreamActive = false;
}

function pushHistory(role, content) {
  const c = normalize(content);
  if (!c) return;
  chatHistory.push({ role, content: c });
  if (chatHistory.length > 50) chatHistory.splice(0, chatHistory.length - 50);
}

function compactHistoryForRequest() {
  return chatHistory.slice(-MAX_HISTORY_MESSAGES).map(m => ({
    role: m.role,
    content: String(m.content || "").slice(0, MAX_HISTORY_CHARS_EACH)
  }));
}

async function startChatStreaming(prompt) {
  abortChatStreamOnly();

  chatAbort = new AbortController();
  chatStreamActive = true;
  const mySeq = ++chatStreamSeq;

  responseBox.textContent = "";
  setStatus(sendStatus, "Sending…", "text-orange-600");

  pushHistory("user", prompt);

  const body = {
    prompt,
    history: compactHistoryForRequest(),
    instructions: getEffectiveInstructions(),
    resumeText: resumeTextMem || ""
  };

  let pending = "";
  let finalAnswer = "";
  let flushTimer = null;

  const flush = () => {
    if (!pending) return;
    responseBox.textContent += pending;
    finalAnswer += pending;
    pending = "";
  };

  try {
    const res = await apiFetch("chat/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: chatAbort.signal
    }, false);

    if (!res.ok) throw new Error(await res.text());

    const reader = res.body.getReader();
    const decoder = new TextDecoder();

    flushTimer = setInterval(() => {
      if (!chatStreamActive || mySeq !== chatStreamSeq) return;
      flush();
    }, 40);

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!chatStreamActive || mySeq !== chatStreamSeq) break;
      pending += decoder.decode(value);
    }

    if (chatStreamActive && mySeq === chatStreamSeq) {
      flush();
      setStatus(sendStatus, "Done", "text-green-600");
      pushHistory("assistant", finalAnswer);
    }

  } catch (e) {
    setStatus(sendStatus, "Failed", "text-red-600");
  } finally {
    if (flushTimer) clearInterval(flushTimer);
  }
}

//--------------------------------------------------------------
// START / STOP
//--------------------------------------------------------------
async function startAll() {
  hideBanner();
  if (isRunning) return;

  await apiFetch("chat/reset", { method: "POST" }, false).catch(() => {});

  timeline = [];
  micInterimEntry = null;
  updateTranscript();

  isRunning = true;

  // ENABLE BUTTONS
  startBtn.disabled = true;
  stopBtn.disabled = false;
  sysBtn.disabled = false;
  sendBtn.disabled = false;

  stopBtn.classList.remove("opacity-50");
  sysBtn.classList.remove("opacity-50");
  sendBtn.classList.remove("opacity-60");

  let micOk = false;
  if (IS_CHROME) {
    // Chrome → use Whisper mic pipeline
    micOk = await startMicWhisper();
  } else {
    // Edge / others → keep SpeechRecognition
    micOk = startMic();
  }

  if (!micOk) setStatus(audioStatus, "Mic not available.", "text-orange-600");
  else if (!IS_CHROME)
    setStatus(audioStatus, "Mic active. System audio optional.", "text-green-600");

  startCreditTicking();
}

function stopAll() {
  isRunning = false;

  stopMicOnly();
  stopMicWhisperOnly();
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

//--------------------------------------------------------------
// SEND / CLEAR / RESET
//--------------------------------------------------------------
sendBtn.onclick = async () => {
  if (sendBtn.disabled) return;

  const msg = normalize(promptBox.value);
  if (!msg) return;

  blockMicUntil = Date.now() + 700;

  timeline = [];
  micInterimEntry = null;
  promptBox.value = "";
  updateTranscript();

  await startChatStreaming(msg);
};

clearBtn.onclick = () => {
  timeline = [];
  micInterimEntry = null;
  promptBox.value = "";
  updateTranscript();
  setStatus(sendStatus, "Transcript cleared", "text-green-600");
};

resetBtn.onclick = async () => {
  abortChatStreamOnly();
  responseBox.textContent = "";
  setStatus(sendStatus, "Response reset", "text-green-600");
  await apiFetch("chat/reset", { method: "POST" }, false).catch(() => {});
};

//--------------------------------------------------------------
// LOGOUT
//--------------------------------------------------------------
document.getElementById("logoutBtn").onclick = () => {
  chatHistory = [];
  resumeTextMem = "";
  abortChatStreamOnly();
  stopAll();
  localStorage.removeItem("session");
  window.location.href = "/auth?tab=login";
};

//--------------------------------------------------------------
// PAGE LOAD
//--------------------------------------------------------------
window.addEventListener("load", async () => {
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

  timeline = [];
  micInterimEntry = null;
  updateTranscript();

  stopBtn.disabled = true;
  sysBtn.disabled = true;
  sendBtn.disabled = true;

  stopBtn.classList.add("opacity-50");
  sysBtn.classList.add("opacity-50");
  sendBtn.classList.add("opacity-60");
});

//--------------------------------------------------------------
// BUTTON BINDINGS - new
//--------------------------------------------------------------
startBtn.onclick = startAll;
stopBtn.onclick = stopAll;
sysBtn.onclick = enableSystemAudio;
