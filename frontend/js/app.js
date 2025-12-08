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

// System audio (MediaRecorder-based)
let sysStream = null;
let sysRecorder = null;
let sysQueue = [];
let sysUploading = false;
let sysAbort = null; // AbortController for inflight transcribe calls

// Transcript timeline
let timeline = [];

// Credits (batch)
let creditTimer = null;
let lastCreditAt = 0;

// Chat streaming cancellation
let chatAbort = null;
let chatStreamActive = false;
let chatStreamSeq = 0; // monotonically increasing stream id

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
  const res = await fetch("/api?path=user/profile", {
    headers: authHeaders()
  });
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

  const res = await fetch("/api?path=resume/extract", {
    method: "POST",
    body: fd
  });

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
// SYSTEM AUDIO — MediaRecorder (fixes corrupted WAV issue)
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
  try { sysRecorder?.stop(); } catch {}
  sysRecorder = null;

  if (sysStream) {
    try { sysStream.getTracks().forEach(t => t.stop()); } catch {}
  }
  sysStream = null;

  sysQueue = [];
  sysUploading = false;

  try { sysAbort?.abort(); } catch {}
  sysAbort = null;
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

  const track = sysStream.getAudioTracks()[0];
  if (!track) {
    setStatus(audioStatus, "No system audio detected. Use Chrome Tab + Share audio.", "text-red-600");
    stopSystemAudioOnly();
    return;
  }

  // Use clean audio-only stream
  const audioOnly = new MediaStream([track]);

  const mimeType = pickBestMimeType();
  try {
    sysRecorder = new MediaRecorder(audioOnly, mimeType ? { mimeType } : undefined);
  } catch (e) {
    console.error(e);
    setStatus(audioStatus, "MediaRecorder failed. Try Chrome Tab capture.", "text-red-600");
    stopSystemAudioOnly();
    return;
  }

  sysAbort = new AbortController();

  sysRecorder.ondataavailable = (ev) => {
    if (!isRunning) return;
    if (!ev.data || ev.data.size < 1500) return;
    sysQueue.push(ev.data);
    drainSysQueue();
  };

  sysRecorder.onerror = (e) => console.error("sysRecorder error", e);

  try {
    sysRecorder.start(2000); // 2s slices
  } catch (e) {
    console.error(e);
    setStatus(audioStatus, "System audio start failed", "text-red-600");
    stopSystemAudioOnly();
    return;
  }

  setStatus(audioStatus, "System audio enabled", "text-green-600");
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
    type.includes("webm") ? "webm" :
    type.includes("ogg") ? "ogg" :
    "webm";

  fd.append("file", blob, `sys.${ext}`);

  const res = await fetch("/api?path=transcribe", {
    method: "POST",
    body: fd,
    signal: sysAbort?.signal
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    console.error("transcribe failed", res.status, txt);
    return;
  }

  const data = await res.json().catch(() => ({}));
  const t = normalize(data.text || "");
  if (t) addToTimeline(t);
}

//--------------------------------------------------------------
// CREDITS — batched every 5 seconds
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
    if (elapsedSec < 5) return;

    // deduct in batches: every 5 seconds deduct 5 credits
    const batchSec = elapsedSec - (elapsedSec % 5);
    const delta = batchSec; // 1 credit/sec
    lastCreditAt += batchSec * 1000;

    try {
      const out = await deductCredits(delta);
      if (out.remaining <= 0) {
        stopAll();
        showBanner("No more credits. Contact admin: shiva509203@gmail.com");
        return;
      }
      // refresh occasionally
      await loadUserProfile();
    } catch (e) {
      console.error(e);
      // do not kill app immediately; show banner
      showBanner(e.message || "Credit deduction error");
    }
  }, 500);
}

//--------------------------------------------------------------
// CHAT STREAM CONTROL (Reset + Send priority switching)
//--------------------------------------------------------------
function abortChatStreamOnly() {
  // This is EXACTLY what you asked: stop streaming + clear response box
  try { chatAbort?.abort(); } catch {}
  chatAbort = null;
  chatStreamActive = false;
}

async function startChatStreaming(prompt) {
  // Stop previous stream immediately, then start new
  abortChatStreamOnly();

  chatAbort = new AbortController();
  chatStreamActive = true;
  const mySeq = ++chatStreamSeq;

  responseBox.textContent = "";
  setStatus(sendStatus, "Sending…", "text-orange-600");

  const body = {
    prompt,
    instructions: localStorage.getItem("instructions") || "",
    resumeText: localStorage.getItem("resumeText") || ""
  };

  let pending = "";
  let flushTimer = null;

  const flush = () => {
    if (!pending) return;
    responseBox.textContent += pending;
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

    // flush every ~50ms to reduce slowness in Chrome DOM rendering
    flushTimer = setInterval(() => {
      // if replaced by new send/reset, stop flushing
      if (!chatStreamActive || mySeq !== chatStreamSeq) return;
      flush();
    }, 50);

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      // If user clicked Reset or sent a newer request -> stop immediately
      if (!chatStreamActive || mySeq !== chatStreamSeq) break;

      pending += decoder.decode(value);
    }

    // final flush if still active and same stream
    if (chatStreamActive && mySeq === chatStreamSeq) {
      flush();
      setStatus(sendStatus, "Done", "text-green-600");
    } else {
      setStatus(sendStatus, "Interrupted", "text-orange-600");
    }
  } catch (e) {
    if (e?.name === "AbortError") {
      setStatus(sendStatus, "Interrupted", "text-orange-600");
    } else {
      console.error(e);
      setStatus(sendStatus, "Failed", "text-red-600");
    }
  } finally {
    if (flushTimer) clearInterval(flushTimer);
    pending = "";
    // do not forcibly flip streamActive here; reset/send owns it
  }
}

//--------------------------------------------------------------
// START / STOP
//--------------------------------------------------------------
async function startAll() {
  hideBanner();
  if (isRunning) return;

  // reset server-side chat state
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

  // NOTE: this DOES NOT stop the response box by itself unless you call Reset/Send.
  // But Stop should stop everything else.
  // If you want Stop to also stop chat: uncomment next line:
  // abortChatStreamOnly();

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
// SEND (priority switching)
//--------------------------------------------------------------
sendBtn.onclick = async () => {
  if (sendBtn.disabled) return;

  const msg = normalize(promptBox.value);
  if (!msg) return;

  blockMicUntil = Date.now() + 700;

  // Clear transcript for next question (your current behavior)
  timeline = [];
  promptBox.value = "";
  updateTranscript();

  // Start streaming; if user clicks Send again, previous gets aborted
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
// RESET (your exact requirement):
// - stop ChatGPT streaming output
// - clear response box
// - do NOT stop mic/system/credits
//--------------------------------------------------------------
resetBtn.onclick = async () => {
  abortChatStreamOnly();          // stops remaining tokens immediately
  responseBox.textContent = "";   // clears response box
  setStatus(sendStatus, "Response reset", "text-green-600");

  // optional: also reset backend chat state
  await fetch("/api?path=chat/reset", { method: "POST" }).catch(() => {});
};

//--------------------------------------------------------------
// LOGOUT
//--------------------------------------------------------------
document.getElementById("logoutBtn").onclick = () => {
  localStorage.removeItem("session");
  window.location.href = "/auth?tab=login";
};

//--------------------------------------------------------------
// PAGE LOAD
//--------------------------------------------------------------
window.addEventListener("load", async () => {
  session = JSON.parse(localStorage.getItem("session") || "null");
  if (!session) return (window.location.href = "/auth?tab=login");

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
