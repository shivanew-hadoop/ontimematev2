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

//--------------------------------------------------------------
// STATE
//--------------------------------------------------------------
let session = null;
let isRunning = false;

let recognition = null;
let blockMicUntil = 0;

// System audio (segment recording)
let sysStream = null;
let sysTrack = null;
let sysRecorder = null;
let sysSegmentChunks = [];
let sysSegmentTimer = null;
let sysQueue = [];
let sysUploading = false;
let sysAbort = null;

// transcript timeline
let timeline = [];

// credits
let creditTimer = null;
let lastCreditAt = 0;

// chat stream cancellation
let chatAbort = null;
let chatStreamActive = false;
let chatStreamSeq = 0;

// in-session memory (clears on refresh/logout automatically)
let chatHistory = [];
const MAX_HISTORY_MESSAGES = 8;       // last 4 turns
const MAX_HISTORY_CHARS_EACH = 1500;

// resume in memory (NOT localStorage)
let resumeTextMem = "";

// system transcript dedupe
let lastSysTail = "";

//--------------------------------------------------------------
// CONFIG
//--------------------------------------------------------------
const SYS_SEGMENT_MS = 6500;          // longer improves accuracy
const SYS_MIN_BYTES = 9000;
const CREDIT_BATCH_SEC = 5;
const CREDITS_PER_SEC = 1;

//--------------------------------------------------------------
// Helpers
//--------------------------------------------------------------
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

//--------------------------------------------------------------
// TOKEN REFRESH (fix expired JWT)
//--------------------------------------------------------------
function isTokenNearExpiry() {
  const exp = Number(session?.expires_at || 0);
  if (!exp) return false;
  const now = Math.floor(Date.now() / 1000);
  return exp - now < 60; // refresh if <60s remaining
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
  if (needAuth) {
    if (isTokenNearExpiry()) {
      try { await refreshAccessToken(); } catch (e) { console.error(e); }
    }
  }

  const headers = { ...(opts.headers || {}) };
  if (needAuth) Object.assign(headers, authHeaders());

  const res = await fetch(`/api?path=${encodeURIComponent(path)}`, { ...opts, headers });

  // retry once on expired/invalid token
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
// Load USER PROFILE
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
// Instructions
//--------------------------------------------------------------
instructionsBox.value = localStorage.getItem("instructions") || "";
instructionsBox.addEventListener("input", () => {
  localStorage.setItem("instructions", instructionsBox.value);
  instrStatus.textContent = "Saved";
  instrStatus.className = "text-green-600";
  setTimeout(() => (instrStatus.textContent = ""), 600);
});

//--------------------------------------------------------------
// Resume Upload (memory only)
//--------------------------------------------------------------
resumeInput?.addEventListener("change", async () => {
  const file = resumeInput.files?.[0];
  if (!file) return;

  resumeStatus.textContent = "Processing…";

  const fd = new FormData();
  fd.append("file", file);

  const res = await apiFetch("resume/extract", { method: "POST", body: fd }, false);
  const data = await res.json().catch(() => ({}));

  resumeTextMem = String(data.text || "");
  resumeStatus.textContent = resumeTextMem ? "Resume extracted (in session)." : "Resume empty";
});

//--------------------------------------------------------------
// MIC — SpeechRecognition
//--------------------------------------------------------------
function startMic() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    setStatus(audioStatus, "SpeechRecognition not supported", "text-red-600");
    return false;
  }

  recognition = new SR();
  recognition.lang = "en-US";
  recognition.continuous = true;
  recognition.interimResults = true;

  recognition.onresult = (ev) => {
    if (!isRunning) return;
    if (Date.now() < blockMicUntil) return;

    let interim = "";
    for (let i = ev.resultIndex; i < ev.results.length; i++) {
      const r = ev.results[i];
      const text = normalize(r[0].transcript || "");
      if (r.isFinal) addToTimeline(text);
      else interim = text;
    }

    if (interim) {
      const base = timeline.map(t => t.text).join(" ");
      promptBox.value = (base + " " + interim).trim();
    }
  };

  recognition.onerror = () => {};
  recognition.onend = () => {
    if (isRunning) {
      try { recognition.start(); } catch {}
    }
  };

  try { recognition.start(); } catch {}
  return true;
}

//--------------------------------------------------------------
// SYSTEM AUDIO — segment recorder + basic dedupe
//--------------------------------------------------------------
function pickBestMimeType() {
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
    "audio/ogg"
  ];
  for (const t of candidates) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported(t)) return t;
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
  sysUploading = false;

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
    setStatus(audioStatus, "System audio denied", "text-red-600");
    return;
  }

  sysTrack = sysStream.getAudioTracks()[0];
  if (!sysTrack) {
    setStatus(audioStatus, "No system audio detected. Use Chrome TAB + Share audio.", "text-red-600");
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
  } catch (e) {
    console.error(e);
    setStatus(audioStatus, "MediaRecorder failed. Use Chrome TAB capture.", "text-red-600");
    stopSystemAudioOnly();
    return;
  }

  sysRecorder.ondataavailable = (ev) => {
    if (!isRunning) return;
    if (ev.data && ev.data.size) sysSegmentChunks.push(ev.data);
  };

  sysRecorder.onstop = () => {
    if (!isRunning) return;

    const blob = new Blob(sysSegmentChunks, { type: sysRecorder?.mimeType || "" });
    sysSegmentChunks = [];

    if (blob.size >= SYS_MIN_BYTES) {
      sysQueue.push(blob);
      drainSysQueue();
    }

    if (isRunning && sysTrack && sysTrack.readyState === "live") {
      startSystemSegmentRecorder();
    }
  };

  try {
    sysRecorder.start();
  } catch (e) {
    console.error(e);
    setStatus(audioStatus, "System audio start failed", "text-red-600");
    stopSystemAudioOnly();
    return;
  }

  if (sysSegmentTimer) clearInterval(sysSegmentTimer);
  sysSegmentTimer = setInterval(() => {
    if (!isRunning) return;
    try { sysRecorder?.stop(); } catch {}
  }, SYS_SEGMENT_MS);
}

async function drainSysQueue() {
  if (sysUploading) return;
  if (!sysQueue.length) return;

  sysUploading = true;
  try {
    while (sysQueue.length && isRunning) {
      const blob = sysQueue.shift();
      await transcribeSysBlob(blob);
    }
  } finally {
    sysUploading = false;
  }
}

// removes duplicated beginnings like: "Artificial intelligence..." repeating
function dedupeSystemText(newText) {
  const t = normalize(newText);
  if (!t) return "";

  const tail = lastSysTail;
  if (!tail) {
    lastSysTail = t.split(" ").slice(-12).join(" ");
    return t;
  }

  // find overlap of up to last 10 words
  const tailWords = tail.split(" ");
  const newWords = t.split(" ");

  let bestK = 0;
  const maxK = Math.min(10, tailWords.length, newWords.length);
  for (let k = maxK; k >= 3; k--) {
    const tailEnd = tailWords.slice(-k).join(" ").toLowerCase();
    const newStart = newWords.slice(0, k).join(" ").toLowerCase();
    if (tailEnd === newStart) {
      bestK = k;
      break;
    }
  }

  const cleaned = bestK ? newWords.slice(bestK).join(" ") : t;

  // update tail
  const merged = (tail + " " + cleaned).trim();
  lastSysTail = merged.split(" ").slice(-12).join(" ");

  return normalize(cleaned);
}

async function transcribeSysBlob(blob) {
  const fd = new FormData();

  const type = (blob.type || "").toLowerCase();
  const ext = type.includes("ogg") ? "ogg" : "webm";
  fd.append("file", blob, `sys.${ext}`);

  const res = await apiFetch("transcribe", {
    method: "POST",
    body: fd,
    signal: sysAbort?.signal
  }, false);

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    console.error("transcribe failed", res.status, t);
    return;
  }

  const data = await res.json().catch(() => ({}));
  const cleaned = dedupeSystemText(data.text || "");
  if (cleaned) addToTimeline(cleaned);
}

//--------------------------------------------------------------
// Credits deduction (batch)
//--------------------------------------------------------------
async function deductCredits(delta) {
  const res = await apiFetch("user/deduct", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ delta })
  }, true);

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Deduct failed (${res.status})`);
  return data;
}

function startCreditTicking() {
  if (creditTimer) clearInterval(creditTimer);
  lastCreditAt = Date.now();

  creditTimer = setInterval(async () => {
    if (!isRunning) return;

    const now = Date.now();
    const elapsedSec = Math.floor((now - lastCreditAt) / 1000);
    if (elapsedSec < 5) return;

    const batchSec = elapsedSec - (elapsedSec % CREDIT_BATCH_SEC);
    const delta = batchSec * CREDITS_PER_SEC;
    lastCreditAt += batchSec * 1000;

    try {
      const out = await deductCredits(delta);
      if (out.remaining <= 0) {
        stopAll();
        showBanner("No more credits. Contact admin: shiva509203@gmail.com");
        return;
      }
      await loadUserProfile();
    } catch (e) {
      console.error(e);
      showBanner(e.message || "Credit deduction error");
    }
  }, 500);
}

//--------------------------------------------------------------
// Chat streaming + in-session memory + resume
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
    instructions: localStorage.getItem("instructions") || "",
    resumeText: resumeTextMem || ""
  };

  let pending = "";
  let flushTimer = null;
  let finalAnswer = "";

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

    if (!res.ok) {
      const t = await res.text().catch(() => "");
      throw new Error(t || `Chat failed (${res.status})`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();

    flushTimer = setInterval(() => {
      if (!chatStreamActive || mySeq !== chatStreamSeq) return;
      flush();
    }, 50);

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
    } else {
      setStatus(sendStatus, "Interrupted", "text-orange-600");
    }
  } catch (e) {
    if (e?.name === "AbortError") setStatus(sendStatus, "Interrupted", "text-orange-600");
    else {
      console.error(e);
      setStatus(sendStatus, "Failed", "text-red-600");
    }
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

  startMic();
  startCreditTicking();

  setStatus(audioStatus, "Mic active. System audio optional.", "text-green-600");
}

function stopAll() {
  isRunning = false;

  try { recognition?.stop(); } catch {}
  recognition = null;

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
// SEND / CLEAR / RESET
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
  await apiFetch("chat/reset", { method: "POST" }, false).catch(() => {});
};

//--------------------------------------------------------------
// LOGOUT (hard reset all memory)
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
// PAGE LOAD (memory resets automatically because JS reloads)
//--------------------------------------------------------------
window.addEventListener("load", async () => {
  session = JSON.parse(localStorage.getItem("session") || "null");
  if (!session) return (window.location.href = "/auth?tab=login");

  // if older session has no refresh_token, force relogin for stability
  if (!session.refresh_token) {
    localStorage.removeItem("session");
    return (window.location.href = "/auth?tab=login");
  }

  chatHistory = [];
  resumeTextMem = "";
  if (resumeStatus) resumeStatus.textContent = "Resume cleared (refresh).";

  await loadUserProfile();

  await apiFetch("chat/reset", { method: "POST" }, false).catch(() => {});

  timeline = [];
  updateTranscript();
});

//--------------------------------------------------------------
// Bind Buttons
//--------------------------------------------------------------
startBtn.onclick = startAll;
stopBtn.onclick = stopAll;
sysBtn.onclick = enableSystemAudio;
