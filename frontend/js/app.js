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

// MIC recognition
let recognition = null;
let blockMicUntil = 0;

// System audio (segment-based MediaRecorder)
let sysStream = null;
let sysTrack = null;
let sysRecorder = null;
let sysSegmentChunks = [];
let sysSegmentTimer = null;
let sysQueue = [];
let sysUploading = false;
let sysAbort = null;

// Transcript timeline
let timeline = [];

// Credits (batched)
let creditTimer = null;
let lastCreditAt = 0;

// Chat streaming cancellation
let chatAbort = null;
let chatStreamActive = false;
let chatStreamSeq = 0;

// In-session memory (reset on refresh/logout automatically)
let chatHistory = []; // [{role:"user"|"assistant", content:string}]
const MAX_HISTORY_MESSAGES = 8; // last 4 turns
const MAX_HISTORY_CHARS_EACH = 1500;

//--------------------------------------------------------------
// CONFIG
//--------------------------------------------------------------
const SYS_SEGMENT_MS = 2500;      // each segment becomes a standalone file (Chrome-safe)
const SYS_MIN_BYTES = 5000;       // ignore tiny segments
const CREDIT_BATCH_SEC = 5;       // every 5 seconds
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
function authHeaders() {
  const token = session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

//--------------------------------------------------------------
// Load USER PROFILE
//--------------------------------------------------------------
async function loadUserProfile() {
  const res = await fetch("/api?path=user/profile", { headers: authHeaders() });
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
// Resume Upload
//--------------------------------------------------------------
resumeInput?.addEventListener("change", async () => {
  const file = resumeInput.files?.[0];
  if (!file) return;

  resumeStatus.textContent = "Processing…";

  const fd = new FormData();
  fd.append("file", file);

  const res = await fetch("/api?path=resume/extract", { method: "POST", body: fd });
  const data = await res.json().catch(() => ({}));

  localStorage.setItem("resumeText", data.text || "");
  resumeStatus.textContent = "Resume extracted.";
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
// SYSTEM AUDIO — segment recorder (Chrome-safe)
// Reason: Chrome timeslice chunks may be non-decodable standalone.
// Fix: stop->upload complete file->restart each segment.
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
    setStatus(audioStatus, "MediaRecorder failed. Try Chrome TAB capture.", "text-red-600");
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

    // restart recorder for next segment (this is the Chrome-safe trick)
    if (isRunning && sysTrack && sysTrack.readyState === "live") {
      startSystemSegmentRecorder();
    }
  };

  try {
    sysRecorder.start(); // no timeslice
  } catch (e) {
    console.error(e);
    setStatus(audioStatus, "System audio start failed", "text-red-600");
    stopSystemAudioOnly();
    return;
  }

  // force segment boundary
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

async function transcribeSysBlob(blob) {
  const fd = new FormData();

  const type = (blob.type || "").toLowerCase();
  const ext =
    type.includes("ogg") ? "ogg" :
    "webm";

  fd.append("file", blob, `sys.${ext}`);

  const res = await fetch("/api?path=transcribe", {
    method: "POST",
    body: fd,
    signal: sysAbort?.signal
  });

  // show real error (if backend returns 400, you see 400 now)
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    console.error("transcribe failed", res.status, t);
    return;
  }

  const data = await res.json().catch(() => ({}));
  const txt = normalize(data.text || "");
  if (txt) addToTimeline(txt);
}

//--------------------------------------------------------------
// CREDITS — batch deduct every 5 seconds
//--------------------------------------------------------------
async function deductCredits(delta) {
  const res = await fetch("/api?path=user/deduct", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ delta })
  });
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
    if (elapsedSec < CREDIT_BATCH_SEC) return;

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
// CHAT STREAM CONTROL (Reset stops stream only; Send overrides stream)
// + In-session memory (history) passed to backend
//--------------------------------------------------------------
function abortChatStreamOnly() {
  try { chatAbort?.abort(); } catch {}
  chatAbort = null;
  chatStreamActive = false;
}

function compactHistoryForRequest() {
  // last MAX_HISTORY_MESSAGES only; clamp very large messages
  const tail = chatHistory.slice(-MAX_HISTORY_MESSAGES).map(m => ({
    role: m.role,
    content: String(m.content || "").slice(0, MAX_HISTORY_CHARS_EACH)
  }));
  return tail;
}

function pushHistory(role, content) {
  const c = normalize(content);
  if (!c) return;
  chatHistory.push({ role, content: c });
  if (chatHistory.length > 50) chatHistory = chatHistory.slice(-50);
}

async function startChatStreaming(prompt) {
  // Stop previous stream immediately, then start new
  abortChatStreamOnly();

  chatAbort = new AbortController();
  chatStreamActive = true;
  const mySeq = ++chatStreamSeq;

  responseBox.textContent = "";
  setStatus(sendStatus, "Sending…", "text-orange-600");

  // store user message in history immediately
  pushHistory("user", prompt);

  const body = {
    prompt,
    history: compactHistoryForRequest(),
    instructions: localStorage.getItem("instructions") || "",
    resumeText: localStorage.getItem("resumeText") || ""
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
    const res = await fetch("/api?path=chat/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: chatAbort.signal
    });

    if (!res.ok) {
      const t = await res.text().catch(() => "");
      throw new Error(t || `Chat failed (${res.status})`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();

    // reduce Chrome UI slowness
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
      // store assistant answer only when stream completes normally
      pushHistory("assistant", finalAnswer);
    } else {
      setStatus(sendStatus, "Interrupted", "text-orange-600");
      // interrupted -> remove last user entry (avoid half-context)
      // keep it simple: pop last "user" if it matches prompt
      for (let i = chatHistory.length - 1; i >= 0; i--) {
        if (chatHistory[i].role === "user" && chatHistory[i].content === normalize(prompt)) {
          chatHistory.splice(i, 1);
          break;
        }
      }
    }
  } catch (e) {
    if (e?.name === "AbortError") {
      setStatus(sendStatus, "Interrupted", "text-orange-600");
      // rollback last user entry on abort
      for (let i = chatHistory.length - 1; i >= 0; i--) {
        if (chatHistory[i].role === "user" && chatHistory[i].content === normalize(prompt)) {
          chatHistory.splice(i, 1);
          break;
        }
      }
    } else {
      console.error(e);
      setStatus(sendStatus, "Failed", "text-red-600");
    }
  } finally {
    if (flushTimer) clearInterval(flushTimer);
    pending = "";
  }
}

//--------------------------------------------------------------
// START / STOP
//--------------------------------------------------------------
async function startAll() {
  hideBanner();
  if (isRunning) return;

  await fetch("/api?path=chat/reset", { method: "POST" }).catch(() => {});
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
// SEND (2nd Send cancels 1st automatically)
//--------------------------------------------------------------
sendBtn.onclick = async () => {
  if (sendBtn.disabled) return;

  const msg = normalize(promptBox.value);
  if (!msg) return;

  blockMicUntil = Date.now() + 700;

  // clear transcript for next question (existing behavior)
  timeline = [];
  promptBox.value = "";
  updateTranscript();

  await startChatStreaming(msg);
};

//--------------------------------------------------------------
// CLEAR transcript only
//--------------------------------------------------------------
clearBtn.onclick = () => {
  timeline = [];
  promptBox.value = "";
  updateTranscript();
  setStatus(sendStatus, "Transcript cleared", "text-green-600");
};

//--------------------------------------------------------------
// RESET (your exact requirement)
// - stops ChatGPT streaming immediately
// - clears response box
// - does NOT stop mic/system/credits
//--------------------------------------------------------------
resetBtn.onclick = async () => {
  abortChatStreamOnly();
  responseBox.textContent = "";
  setStatus(sendStatus, "Response reset", "text-green-600");
  await fetch("/api?path=chat/reset", { method: "POST" }).catch(() => {});
};

//--------------------------------------------------------------
// LOGOUT (must reset memory)
//--------------------------------------------------------------
document.getElementById("logoutBtn").onclick = () => {
  // reset in-session memory before redirect
  chatHistory = [];
  abortChatStreamOnly();
  stopAll();
  localStorage.removeItem("session");
  window.location.href = "/auth?tab=login";
};

//--------------------------------------------------------------
// PAGE LOAD
// Memory resets automatically on hard refresh (JS memory cleared)
//--------------------------------------------------------------
window.addEventListener("load", async () => {
  session = JSON.parse(localStorage.getItem("session") || "null");
  if (!session) return (window.location.href = "/auth?tab=login");

  // Ensure memory is clean per fresh page load
  chatHistory = [];

  await loadUserProfile();
  await fetch("/api?path=chat/reset", { method: "POST" }).catch(() => {});

  timeline = [];
  updateTranscript();

  localStorage.removeItem("resumeText");
  if (resumeStatus) resumeStatus.textContent = "Resume cleared";
});

//--------------------------------------------------------------
// Bind Buttons
//--------------------------------------------------------------
startBtn.onclick = startAll;
stopBtn.onclick = stopAll;
sysBtn.onclick = enableSystemAudio;
