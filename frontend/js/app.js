//--------------------------------------------------------------
// CONFIG
//--------------------------------------------------------------
const BILL_EVERY_MS = 5000;          // batch interval
const CREDITS_PER_SECOND = 1;        // 1 credit per second
const MAX_INSTR_CHARS = 1200;
const MAX_RESUME_CHARS = 2500;

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

let audioContext = null;
let sysStream = null;
let sysSource = null;
let sysGain = null;
let sysProcessor = null;
let sysSilentGain = null;

let sysChunks = [];
let lastSysFlushAt = 0;
let sysFlushInFlight = false;
let sysFlushTimer = null;

let timeline = [];
let blockMicUntil = 0;

// billing
let billingTimer = null;
let billLastAt = 0;

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
    headers: authHeaders(), // optional, harmless
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

  try {
    recognition.start();
  } catch {}

  return true;
}

//--------------------------------------------------------------
// System Audio
//--------------------------------------------------------------
async function ensureContext() {
  if (!audioContext) audioContext = new AudioContext();
  if (audioContext.state === "suspended") await audioContext.resume();
}

async function enableSystemAudio() {
  if (!isRunning) return;

  await ensureContext();

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
    setStatus(audioStatus, "No audio detected", "text-red-600");
    return;
  }

  sysSource = audioContext.createMediaStreamSource(sysStream);
  sysGain = audioContext.createGain();
  sysGain.gain.value = 1;

  sysProcessor = audioContext.createScriptProcessor(4096, 1, 1);
  sysSilentGain = audioContext.createGain();
  sysSilentGain.gain.value = 0;

  sysSource.connect(sysGain);
  sysGain.connect(sysProcessor);
  sysProcessor.connect(sysSilentGain);
  sysSilentGain.connect(audioContext.destination);

  sysProcessor.onaudioprocess = (ev) => {
    if (!isRunning) return;

    const data = ev.inputBuffer.getChannelData(0);
    sysChunks.push(new Float32Array(data));

    const now = Date.now();
    if (now - lastSysFlushAt >= 1100) {
      lastSysFlushAt = now;
      flushSystemAudio();
    }
  };

  if (sysFlushTimer) clearInterval(sysFlushTimer);
  sysFlushTimer = setInterval(() => {
    if (sysChunks.length && isRunning) flushSystemAudio();
  }, 1400);

  setStatus(audioStatus, "System audio enabled", "text-green-600");
}

function float32ToWav(float32, sr) {
  const int16 = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++)
    int16[i] = Math.max(-1, Math.min(1, float32[i])) * 0x7fff;

  const buf = new ArrayBuffer(44 + int16.length * 2);
  const dv = new DataView(buf);

  function w(o, s) {
    for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i));
  }

  w(0, "RIFF");
  dv.setUint32(4, 36 + int16.length * 2, true);
  w(8, "WAVE");
  w(12, "fmt ");
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);
  dv.setUint16(22, 1, true);
  dv.setUint32(24, sr, true);
  dv.setUint32(28, sr * 2, true);
  dv.setUint16(32, 2, true);
  dv.setUint16(34, 16, true);
  w(36, "data");
  dv.setUint32(40, int16.length * 2, true);

  let off = 44;
  for (let i = 0; i < int16.length; i++, off += 2)
    dv.setInt16(off, int16[i], true);

  return new Blob([buf], { type: "audio/wav" });
}

async function flushSystemAudio() {
  if (sysFlushInFlight) return;
  sysFlushInFlight = true;

  try {
    const chunks = sysChunks;
    sysChunks = [];
    if (!chunks.length) return;

    const raw = chunks.reduce((acc, c) => {
      const out = new Float32Array(acc.length + c.length);
      out.set(acc, 0);
      out.set(c, acc.length);
      return out;
    }, new Float32Array(0));

    const wav = float32ToWav(raw, audioContext.sampleRate);

    const fd = new FormData();
    fd.append("file", wav, "sys.wav");

    const res = await fetch("/api?path=transcribe", {
      method: "POST",
      headers: authHeaders(), // optional but consistent
      body: fd
    });

    const data = await res.json();
    if (data.text) addToTimeline(data.text);
  } catch {
    // don't hard-fail; just keep mic running
  } finally {
    sysFlushInFlight = false;
  }
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

  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Deduction failed");

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

    // compute how many seconds to bill in this batch
    const seconds = Math.floor(elapsedMs / 1000);
    const delta = seconds * CREDITS_PER_SECOND;

    // move the last marker forward by billed seconds
    billLastAt += seconds * 1000;

    try {
      const out = await deductCreditsBatch(delta);

      // refresh profile occasionally (every batch is ok; you can change)
      await loadUserProfile();

      if (Number(out.remaining || 0) <= 0) {
        stopAll();
        showBanner("No more credits. Contact admin: shiva509203@gmail.com");
      }
    } catch (e) {
      stopAll();
      showBanner(e.message || "Billing failed");
    }
  }, 500); // internal tick, low cost
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

  if (sysStream) sysStream.getTracks().forEach(t => t.stop());
  sysStream = null;

  if (billingTimer) clearInterval(billingTimer);
  billingTimer = null;

  if (sysFlushTimer) clearInterval(sysFlushTimer);
  sysFlushTimer = null;

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
  resumeStatus.textContent = "Resume cleared";
});

//--------------------------------------------------------------
// Bind Buttons
//--------------------------------------------------------------
startBtn.onclick = startAll;
stopBtn.onclick = stopAll;
sysBtn.onclick = enableSystemAudio;
