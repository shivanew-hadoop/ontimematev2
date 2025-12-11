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

// MIC
let recognition = null;
let blockMicUntil = 0;

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

// chat stream
let chatAbort = null;
let chatStreamActive = false;
let chatStreamSeq = 0;

// memory
let chatHistory = [];
const MAX_HISTORY_MESSAGES = 8;
const MAX_HISTORY_CHARS_EACH = 1500;

// resume memory
let resumeTextMem = "";

// system transcript tail
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

//--------------------------------------------------------------
// MODE SELECTOR → Built-in instructions
//--------------------------------------------------------------
function getModeInstructions() {
  const mode = modeSelect.value;

  if (mode === "interview") {
    return `
Answer like a real professional, not like ChatGPT.
Use real project examples based on the resume when relevant.
Keep tone natural, human, confident.
Avoid definitions — explain how YOU used the concept in real projects.
Structure:
• Quick Answer first (interview style)
• Bullet points
• Real-time example from resume
• No sugar-coating, no generic textbook lines.
`;
  }

  if (mode === "sales") {
    return `
Respond in a persuasive, crisp, business tone.
Focus on value, ROI, client impact.
Use short sentences and real use cases.
Keep messaging confident, non-technical unless required.
`;
  }

  return ""; // general
}

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
  return session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {};
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

// typewriter UI for system audio
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
  const rt = session?.refresh_token;
  if (!rt) throw new Error("Missing refresh token.");

  const res = await fetch("/api?path=auth/refresh", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refresh_token: rt })
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

  const res = await fetch(`/api?path=${encodeURIComponent(path)}`, { ...opts, headers });

  if (needAuth && res.status === 401) {
    const t = await res.text().catch(() => "");
    if (
      t.includes("expired") ||
      t.includes("invalid JWT") ||
      t.includes("Missing token")
    ) {
      await refreshAccessToken();
      return fetch(`/api?path=${encodeURIComponent(path)}`, {
        ...opts,
        headers: { ...(opts.headers || {}), ...authHeaders() }
      });
    }
  }

  return res;
}

//--------------------------------------------------------------
// Load Profile
//--------------------------------------------------------------
async function loadUserProfile() {
  const res = await apiFetch("user/profile");
  const data = await res.json().catch(() => ({}));
  userInfo.innerHTML =
    `Logged in as <b>${data.user.email}</b><br>` +
    `Credits: <b>${data.user.credits}</b><br>` +
    `Joined: ${data.user.created_ymd}`;
}

//--------------------------------------------------------------
// Custom Instructions
//--------------------------------------------------------------
instructionsBox.value = localStorage.getItem("instructions") || "";

instructionsBox.addEventListener("input", () => {
  localStorage.setItem("instructions", instructionsBox.value);
  instrStatus.textContent = "Saved";
  instrStatus.className = "text-green-600";
  setTimeout(() => (instrStatus.textContent = ""), 600);
});

function getEffectiveInstructions() {
  const base = (instructionsBox.value || "").trim();
  return (getModeInstructions() + "\n" + base).trim();
}

//--------------------------------------------------------------
// Resume Upload
//--------------------------------------------------------------
resumeInput?.addEventListener("change", async () => {
  const f = resumeInput.files?.[0];
  if (!f) return;
  resumeStatus.textContent = "Processing…";

  const fd = new FormData();
  fd.append("file", f);

  const res = await apiFetch("resume/extract", { method: "POST", body: fd }, false);
  const data = await res.json().catch(() => ({}));

  resumeTextMem = (data.text || "").trim();

  if (!resumeTextMem) resumeStatus.textContent = "Resume: empty";
  else resumeStatus.textContent = `Resume loaded (${resumeTextMem.length} chars)`;
});

//--------------------------------------------------------------
// MIC
//--------------------------------------------------------------
function stopMicOnly() {
  try { recognition?.stop(); } catch {}
  recognition = null;
}

function startMic() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    setStatus(audioStatus, "Browser does not support SpeechRecognition", "text-red-600");
    return false;
  }

  stopMicOnly();

  recognition = new SR();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = MIC_LANGS[micLangIndex];

  recognition.onresult = ev => {
    if (!isRunning) return;
    if (Date.now() < blockMicUntil) return;

    let interim = "";

    for (let i = ev.resultIndex; i < ev.results.length; i++) {
      const r = ev.results[i];
      const text = normalize(r[0].transcript);
      if (r.isFinal) addToTimeline(text);
      else interim = text;
    }

    if (interim) {
      const base = timeline.map(t => t.text).join(" ");
      promptBox.value = (base + " " + interim).trim();
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
// SYSTEM AUDIO
//--------------------------------------------------------------
function pickBestMimeType() {
  const opts = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
    "audio/ogg"
  ];
  return opts.find(t => MediaRecorder.isTypeSupported(t)) || "";
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
    sysStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
  } catch {
    setStatus(audioStatus, "System audio denied. Use Chrome → Share tab audio.", "text-red-600");
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
  setStatus(audioStatus, "System audio enabled", "text-green-600");
}

function startSystemSegmentRecorder() {
  if (!sysTrack) return;

  const audioOnly = new MediaStream([sysTrack]);
  const mimeType = pickBestMimeType();
  sysSegmentChunks = [];

  try {
    sysRecorder = new MediaRecorder(audioOnly, mimeType ? { mimeType } : undefined);
  } catch {
    setStatus(audioStatus, "Recorder failed.", "text-red-600");
    stopSystemAudioOnly();
    return;
  }

  sysRecorder.ondataavailable = ev => {
    if (!isRunning) return;
    if (ev.data && ev.data.size) sysSegmentChunks.push(ev.data);
  };

  sysRecorder.onstop = () => {
    if (!isRunning) return;

    const blob = new Blob(sysSegmentChunks);
    sysSegmentChunks = [];

    if (blob.size >= SYS_MIN_BYTES) {
      sysQueue.push(blob);
      drainSysQueue();
    }

    if (isRunning && sysTrack.readyState === "live") {
      startSystemSegmentRecorder();
    }
  };

  try { sysRecorder.start(); } catch {}

  if (sysSegmentTimer) clearInterval(sysSegmentTimer);
  sysSegmentTimer = setInterval(() => {
    if (!isRunning) return;
    try { sysRecorder.stop(); } catch {}
  }, SYS_SEGMENT_MS);
}

function drainSysQueue() {
  if (!isRunning) return;

  while (sysInFlight < SYS_MAX_CONCURRENT && sysQueue.length) {
    const blob = sysQueue.shift();
    sysInFlight++;

    transcribeSysBlob(blob)
      .catch(() => {})
      .finally(() => {
        sysInFlight--;
        drainSysQueue();
      });
  }
}

function dedupeSystemText(raw) {
  const t = normalize(raw);
  if (!t) return "";

  if (!lastSysTail) {
    lastSysTail = t.split(" ").slice(-12).join(" ");
    return t;
  }

  const tailWords = lastSysTail.split(" ");
  const newWords = t.split(" ");

  let best = 0;
  const max = Math.min(10, tailWords.length, newWords.length);
  for (let k = max; k >= 3; k--) {
    if (
      tailWords.slice(-k).join(" ").toLowerCase() ===
      newWords.slice(0, k).join(" ").toLowerCase()
    ) {
      best = k;
      break;
    }
  }

  const cleaned = best ? newWords.slice(best).join(" ") : t;
  lastSysTail = (lastSysTail + " " + cleaned).split(" ").slice(-12).join(" ");
  return normalize(cleaned);
}

function looksLikeWhisperHallucination(t) {
  const s = normalize(t).toLowerCase();
  return (
    !s ||
    s.includes("i'm sorry") ||
    s.includes("cannot transcribe") ||
    s.includes("thanks for watching") ||
    s.includes("please like and subscribe")
  );
}

async function transcribeSysBlob(blob) {
  const fd = new FormData();
  fd.append("file", blob, "sys.webm");
  fd.append("prompt", WHISPER_BIAS_PROMPT);

  const res = await apiFetch("transcribe", { method: "POST", body: fd }, false);
  if (!res.ok) return;

  const data = await res.json().catch(() => ({}));
  const raw = data.text || "";
  if (looksLikeWhisperHallucination(raw)) return;

  const cleaned = dedupeSystemText(raw);
  if (cleaned) addToTimelineTypewriter(cleaned);
}

//--------------------------------------------------------------
// Credits
//--------------------------------------------------------------
async function deductCredits(delta) {
  const res = await apiFetch("user/deduct", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ delta })
  });
  return res.json().catch(() => ({}));
}

function startCreditTicking() {
  if (creditTimer) clearInterval(creditTimer);
  lastCreditAt = Date.now();

  creditTimer = setInterval(async () => {
    if (!isRunning) return;

    const now = Date.now();
    const sec = Math.floor((now - lastCreditAt) / 1000);
    if (sec < CREDIT_BATCH_SEC) return;

    const batch = sec - (sec % CREDIT_BATCH_SEC);
    const delta = batch * CREDITS_PER_SEC;
    lastCreditAt += batch * 1000;

    const out = await deductCredits(delta);
    if (out.remaining <= 0) {
      stopAll();
      showBanner("No more credits. Contact admin: shiva509203@gmail.com");
      return;
    }

    loadUserProfile();
  }, 500);
}

//--------------------------------------------------------------
// Chat Streaming
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
  if (chatHistory.length > 50) chatHistory = chatHistory.slice(-50);
}

function compactHistory() {
  return chatHistory.slice(-MAX_HISTORY_MESSAGES).map(m => ({
    role: m.role,
    content: m.content.slice(0, MAX_HISTORY_CHARS_EACH)
  }));
}

async function startChatStreaming(prompt) {
  abortChatStreamOnly();
  chatAbort = new AbortController();
  chatStreamActive = true;
  const seq = ++chatStreamSeq;

  responseBox.textContent = "";
  setStatus(sendStatus, "Sending…", "text-orange-600");

  pushHistory("user", prompt);

  const body = {
    prompt,
    history: compactHistory(),
    instructions: getEffectiveInstructions(),
    resumeText: resumeTextMem
  };

  let pending = "";
  let finalAnswer = "";
  let flushTimer = setInterval(() => {
    if (!chatStreamActive || seq !== chatStreamSeq) return;
    if (!pending) return;
    responseBox.textContent += pending;
    finalAnswer += pending;
    pending = "";
  }, 50);

  try {
    const res = await apiFetch("chat/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: chatAbort.signal
    }, false);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!chatStreamActive || seq !== chatStreamSeq) break;
      pending += decoder.decode(value);
    }

    if (chatStreamActive && seq === chatStreamSeq) {
      if (pending) {
        responseBox.textContent += pending;
        finalAnswer += pending;
      }
      setStatus(sendStatus, "Done", "text-green-600");
      pushHistory("assistant", finalAnswer);
    } else {
      setStatus(sendStatus, "Interrupted", "text-orange-600");
    }
  } catch {
    setStatus(sendStatus, "Failed", "text-red-600");
  } finally {
    clearInterval(flushTimer);
  }
}

//--------------------------------------------------------------
// Start / Stop
//--------------------------------------------------------------
async function startAll() {
  hideBanner();
  if (isRunning) return;

  await apiFetch("chat/reset", { method: "POST" }, false);
  timeline = [];
  updateTranscript();

  isRunning = true;

  startBtn.disabled = true;
  startBtn.classList.add("opacity-50");

  stopBtn.disabled = false;
  stopBtn.classList.remove("opacity-50");

  sysBtn.disabled = false;
  sysBtn.classList.remove("opacity-50");

  sendBtn.disabled = false;
  sendBtn.classList.remove("opacity-60");

  micLangIndex = 0;
  const micOK = startMic();
  if (!micOK) setStatus(audioStatus, "Mic not available", "text-orange-600");
  else setStatus(audioStatus, "Mic active. System audio optional.", "text-green-600");

  startCreditTicking();
}

function stopAll() {
  isRunning = false;

  stopMicOnly();
  stopSystemAudioOnly();

  if (creditTimer) clearInterval(creditTimer);
  creditTimer = null;

  startBtn.disabled = false;
  startBtn.classList.remove("opacity-50");

  stopBtn.disabled = true;
  stopBtn.classList.add("opacity-50");

  sysBtn.disabled = true;
  sysBtn.classList.add("opacity-50");

  sendBtn.disabled = true;
  sendBtn.classList.add("opacity-60");

  setStatus(audioStatus, "Stopped", "text-orange-600");
}

//--------------------------------------------------------------
// Send / Clear / Reset
//--------------------------------------------------------------
sendBtn.onclick = async () => {
  if (sendBtn.disabled) return;

  const msg = normalize(promptBox.value);
  if (!msg) return;

  blockMicUntil = Date.now() + 700;

  timeline = [];
  promptBox.value = "";
  updateTranscript();

  await startChatStreaming(msg);
};

clearBtn.onclick = () => {
  timeline = [];
  promptBox.value = "";
  updateTranscript();
  setStatus(sendStatus, "Transcript cleared", "text-green-600");
};

resetBtn.onclick = async () => {
  abortChatStreamOnly();
  responseBox.textContent = "";
  setStatus(sendStatus, "Response reset", "text-green-600");
  await apiFetch("chat/reset", { method: "POST" }, false);
};

//--------------------------------------------------------------
// Logout
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
// Page Load
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
  resumeStatus.textContent = "Resume cleared (refresh)";

  await loadUserProfile();
  await apiFetch("chat/reset", { method: "POST" }, false);

  timeline = [];
  updateTranscript();

  stopBtn.disabled = true;
  sysBtn.disabled = true;
  sendBtn.disabled = true;
});
