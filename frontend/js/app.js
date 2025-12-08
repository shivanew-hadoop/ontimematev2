//--------------------------------------------------------------
// CONFIG
//--------------------------------------------------------------
const BILL_EVERY_MS = 5000;          // batch interval (5s)
const CREDITS_PER_SECOND = 1;        // 1 credit per second

// System audio chunk size (tradeoff: lower = faster, higher = more accurate)
const SYS_RECORDER_SLICE_MS = 2000;  // 2000–3000 recommended

const MAX_INSTR_CHARS = 1200;
const MAX_RESUME_CHARS = 2500;

// Dedupe tuning
const DEDUPE_WINDOW_MS = 8000;
const DUP_TOKEN_OVERLAP = 0.82;      // 0.75–0.90

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

let sysStream = null;
let sysRecorder = null;
let sysQueue = [];
let sysUploadInFlight = false;

let timeline = [];
let blockMicUntil = 0;

// billing
let billingTimer = null;
let billLastAt = 0;

// dedupe
let lastAcceptedText = "";
let lastAcceptedAt = 0;

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
function mustHaveSessionOrRedirect() {
  if (session?.access_token) return true;
  localStorage.removeItem("session");
  window.location.href = "/auth?tab=login";
  return false;
}

// token overlap similarity (cheap dedupe)
function tokenSet(s) {
  return new Set(
    normalize(s)
      .toLowerCase()
      .split(" ")
      .filter(Boolean)
  );
}
function overlapRatio(a, b) {
  const A = tokenSet(a);
  const B = tokenSet(b);
  if (!A.size || !B.size) return 0;

  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  const denom = Math.min(A.size, B.size);
  return inter / denom;
}

function shouldAcceptText(txt) {
  txt = normalize(txt);
  if (!txt) return false;

  // ignore 1-word noise
  const wc = txt.split(" ").filter(Boolean).length;
  if (wc < 2) return false;

  const now = Date.now();

  // strong dedupe: exact repeat in short window
  if (txt === lastAcceptedText && (now - lastAcceptedAt) < DEDUPE_WINDOW_MS) {
    return false;
  }

  // fuzzy dedupe: high overlap with last segment in short window
  if ((now - lastAcceptedAt) < DEDUPE_WINDOW_MS) {
    const r = overlapRatio(txt, lastAcceptedText);
    if (r >= DUP_TOKEN_OVERLAP) return false;
  }

  lastAcceptedText = txt;
  lastAcceptedAt = now;
  return true;
}

//--------------------------------------------------------------
// Load USER PROFILE
//--------------------------------------------------------------
async function loadUserProfile() {
  if (!mustHaveSessionOrRedirect()) return;

  const res = await fetch("/api?path=user/profile", {
    headers: authHeaders()
  });

  const data = await res.json();
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
    headers: authHeaders(), // optional; safe
    body: fd
  });

  const data = await res.json();
  localStorage.setItem("resumeText", (data.text || "").slice(0, MAX_RESUME_CHARS));
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

      if (r.isFinal) {
        if (shouldAcceptText(text)) addToTimeline(text);
      } else {
        interim = text;
      }
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
// System Audio (MediaRecorder-based, avoids corrupted WAV chunks)
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
  return ""; // let browser choose
}

async function enableSystemAudio() {
  if (!isRunning) return;

  // Stop old system audio if any
  try { sysRecorder?.stop(); } catch {}
  sysRecorder = null;
  sysQueue = [];
  sysUploadInFlight = false;

  try {
    sysStream = await navigator.mediaDevices.getDisplayMedia({
      video: true,  // required for picker UI
      audio: true
    });
  } catch {
    setStatus(audioStatus, "System audio denied", "text-red-600");
    return;
  }

  const audioTrack = sysStream.getAudioTracks()[0];
  if (!audioTrack) {
    setStatus(audioStatus, "No system audio track. Select Chrome Tab + Share audio.", "text-red-600");
    // stop tracks
    try { sysStream.getTracks().forEach(t => t.stop()); } catch {}
    sysStream = null;
    return;
  }

  // Use only the audio track in a clean stream (avoid weird mux)
  const cleanAudioStream = new MediaStream([audioTrack]);

  const mimeType = pickBestMimeType();
  try {
    sysRecorder = new MediaRecorder(cleanAudioStream, mimeType ? { mimeType } : undefined);
  } catch (e) {
    console.error("MediaRecorder init failed", e);
    setStatus(audioStatus, "MediaRecorder failed. Try Chrome Tab capture.", "text-red-600");
    return;
  }

  sysRecorder.ondataavailable = (ev) => {
    if (!isRunning) return;
    if (!ev.data || ev.data.size < 1200) return; // ignore tiny blobs
    sysQueue.push(ev.data);
    drainSysQueue();
  };

  sysRecorder.onerror = (e) => {
    console.error("sysRecorder error", e);
  };

  sysRecorder.onstop = () => {};

  // Start chunking
  try {
    sysRecorder.start(SYS_RECORDER_SLICE_MS);
  } catch (e) {
    console.error("sysRecorder start failed", e);
    setStatus(audioStatus, "System audio start failed", "text-red-600");
    return;
  }

  setStatus(audioStatus, "System audio enabled", "text-green-600");
}

async function drainSysQueue() {
  if (sysUploadInFlight) return;
  if (!sysQueue.length) return;

  sysUploadInFlight = true;
  try {
    while (sysQueue.length && isRunning) {
      const blob = sysQueue.shift();
      await transcribeSysBlob(blob);
    }
  } finally {
    sysUploadInFlight = false;
  }
}

async function transcribeSysBlob(blob) {
  // IMPORTANT: if you play system audio on speakers, mic will also hear it → duplicates.
  // Use headphones for best results.

  const fd = new FormData();

  // filename extension based on mime
  const type = (blob.type || "").toLowerCase();
  const ext =
    type.includes("webm") ? "webm" :
    type.includes("ogg") ? "ogg" :
    "webm";

  fd.append("file", blob, `sys.${ext}`);

  const res = await fetch("/api?path=transcribe", {
    method: "POST",
    headers: authHeaders(), // optional but consistent
    body: fd
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    console.error("transcribe failed", res.status, errText);
    return;
  }

  const data = await res.json().catch(() => ({}));
  const txt = normalize(data.text || "");

  if (shouldAcceptText(txt)) addToTimeline(txt);
}

//--------------------------------------------------------------
// Credits deduction — BATCHED
//--------------------------------------------------------------
async function deductCreditsBatch(delta) {
  if (!mustHaveSessionOrRedirect()) return { remaining: 0 };

  const res = await fetch("/api?path=user/deduct", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ delta })
  });

  if (res.status === 401) {
    stopAll();
    showBanner("Session expired. Please login again.");
    localStorage.removeItem("session");
    window.location.href = "/auth?tab=login";
    return { remaining: 0 };
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Deduction failed (${res.status})`);
  return data;
}

function startBilling() {
  if (billingTimer) clearInterval(billingTimer);

  billLastAt = Date.now();

  billingTimer = setInterval(async () => {
    if (!isRunning) return;

    const now = Date.now();
    const elapsedMs = now - billLastAt;
    if (elapsedMs < BILL_EVERY_MS) return;

    const seconds = Math.floor(elapsedMs / 1000);
    const delta = seconds * CREDITS_PER_SECOND;

    billLastAt += seconds * 1000;

    try {
      const out = await deductCreditsBatch(delta);
      await loadUserProfile();

      if (Number(out.remaining || 0) <= 0) {
        stopAll();
        showBanner("No more credits. Contact admin: shiva509203@gmail.com");
      }
    } catch (e) {
      stopAll();
      showBanner(e.message || "Billing failed");
    }
  }, 500);
}

//--------------------------------------------------------------
// START
//--------------------------------------------------------------
async function startAll() {
  hideBanner();

  if (!mustHaveSessionOrRedirect()) return;
  if (isRunning) return;

  await fetch("/api?path=chat/reset", { method: "POST" });

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
  startBilling();

  setStatus(audioStatus, "Mic active. System audio optional.", "text-green-600");
}

//--------------------------------------------------------------
// STOP
//--------------------------------------------------------------
function stopAll() {
  isRunning = false;

  try { recognition?.stop(); } catch {}
  recognition = null;

  try { sysRecorder?.stop(); } catch {}
  sysRecorder = null;
  sysQueue = [];
  sysUploadInFlight = false;

  if (sysStream) {
    try { sysStream.getTracks().forEach(t => t.stop()); } catch {}
  }
  sysStream = null;

  if (billingTimer) clearInterval(billingTimer);
  billingTimer = null;

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
// SEND to GPT
//--------------------------------------------------------------
sendBtn.onclick = async () => {
  if (sendBtn.disabled) return;

  const msg = normalize(promptBox.value);
  if (!msg) return;

  blockMicUntil = Date.now() + 700;

  timeline = [];
  promptBox.value = "";
  updateTranscript();

  responseBox.textContent = "";
  setStatus(sendStatus, "Sending…", "text-orange-600");

  try {
    const body = {
      prompt: msg,
      instructions: (localStorage.getItem("instructions") || "").slice(0, MAX_INSTR_CHARS),
      resumeText: (localStorage.getItem("resumeText") || "").slice(0, MAX_RESUME_CHARS)
    };

    const res = await fetch("/api?path=chat/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });

    const reader = res.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      responseBox.textContent += decoder.decode(value);
    }

    setStatus(sendStatus, "Done", "text-green-600");
  } catch {
    setStatus(sendStatus, "Failed", "text-red-600");
  }
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
// RESET everything including GPT response
//--------------------------------------------------------------
resetBtn.onclick = () => {
  timeline = [];
  promptBox.value = "";
  responseBox.textContent = "";
  setStatus(sendStatus, "All cleared", "text-green-600");
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
  await fetch("/api?path=chat/reset", { method: "POST" });

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
