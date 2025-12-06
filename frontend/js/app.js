//--------------------------------------------------------------
// CONFIG
//--------------------------------------------------------------
const API_BASE = ""; // same origin on Vercel

const TARGET_SR = 16000;
const FLUSH_EVERY_MS = 1100;
const OVERLAP_MS = 250;

const PING_INTERVAL = 1000; // 1 second credit deduction

//--------------------------------------------------------------
// DOM
//--------------------------------------------------------------
const instructionsBox = document.getElementById("instructionsBox");
const instrStatus = document.getElementById("instrStatus");
const resumeInput = document.getElementById("resumeInput");
const resumeStatus = document.getElementById("resumeStatus");
const promptBox = document.getElementById("promptBox");
const responseBox = document.getElementById("responseBox");
const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const sysBtn = document.getElementById("sysBtn");
const resetBtn = document.getElementById("resetBtn");
const audioStatus = document.getElementById("audioStatus");
const sendBtn = document.getElementById("sendBtn");
const sendStatus = document.getElementById("sendStatus");
const logoutBtn = document.getElementById("logoutBtn");
const userInfo = document.getElementById("userInfo");

//--------------------------------------------------------------
// STATE
//--------------------------------------------------------------
let isRunning = false;
let recognition = null;

let audioContext = null;
let sysStream = null;
let sysSource = null;
let sysGain = null;
let sysProcessor = null;
let sysSilentGain = null;

let sysChunks = [];
let sysCarryRaw = new Float32Array(0);
let lastSysFlushAt = 0;
let sysFlushInFlight = false;

let timeline = [];
let autoFlushTimer = null;

let blockMicUntil = 0;   
let creditTimer = null;
let userSession = null;
let userProfile = null;

//--------------------------------------------------------------
// Helper
//--------------------------------------------------------------
function setStatus(el, text, cls = "") {
  if (!el) return;
  el.className = `text-xs ${cls}`;
  el.textContent = text;
}

function normalize(s) {
  return (s || "").replace(/\s+/g, " ").trim();
}

function updateTranscript() {
  promptBox.value = timeline.map(t => t.text).join(" ");
  promptBox.scrollTop = promptBox.scrollHeight;
}

function addToTimeline(txt) {
  const cleaned = normalize(txt);
  if (!cleaned) return;
  timeline.push({ t: Date.now(), text: cleaned });
  updateTranscript();
}

//--------------------------------------------------------------
// Load Session From LocalStorage
//--------------------------------------------------------------
async function loadUserSession() {
  try {
    const raw = localStorage.getItem("session");
    if (!raw) {
      window.location.href = "/auth";
      return;
    }

    userSession = JSON.parse(raw);

    if (userSession.is_admin) {
      userInfo.innerHTML = `<b>Admin:</b> ${userSession.user.email}`;
      return;
    }

    // load user profile details
    const r = await fetch("/api/user/profile", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: userSession.user.id })
    });

    const data = await r.json();
    userProfile = data.data;

    if (!userProfile) {
      userInfo.innerHTML = "<span class='text-red-600'>Profile missing.</span>";
      return;
    }

    if (!userProfile.approved) {
      userInfo.innerHTML = `<b>${userProfile.email}</b><br>
        Status: <span class='text-red-600'>Not Approved</span>`;
      startBtn.disabled = true;
      return;
    }

    userInfo.innerHTML = `
      <b>${userProfile.name}</b><br>
      ${userProfile.email}<br>
      Credits: <span id="creditCounter">${userProfile.credits}</span>
    `;
  } catch (e) {
    console.error("Session load error:", e);
    window.location.href = "/auth";
  }
}

//--------------------------------------------------------------
// Credit Deduction per Second
//--------------------------------------------------------------
async function startCreditTimer() {
  if (userSession?.is_admin) return;

  creditTimer = setInterval(async () => {
    let credits = Number(document.getElementById("creditCounter")?.textContent || "0");

    if (credits <= 0) {
      stopAll();
      alert("Credits exhausted.");
      return;
    }

    // Deduct 1 credit
    const r = await fetch("/api/credits/deductSecond", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: userSession.user.id })
    });

    const data = await r.json();
    if (data?.credits !== undefined) {
      document.getElementById("creditCounter").textContent = data.credits;
    }
  }, PING_INTERVAL);
}

function stopCreditTimer() {
  if (creditTimer) clearInterval(creditTimer);
  creditTimer = null;
}

//--------------------------------------------------------------
// Instructions + Resume persistence
//--------------------------------------------------------------
instructionsBox.value = localStorage.getItem("custom_instructions") || "";
instructionsBox.addEventListener("input", () => {
  localStorage.setItem("custom_instructions", instructionsBox.value.trim());
  setStatus(instrStatus, "Saved", "text-green-600");
  setTimeout(() => setStatus(instrStatus, "", ""), 600);
});

function getResumeText() {
  return sessionStorage.getItem("resume_text") || "";
}

resumeInput.onchange = async () => {
  try {
    const f = resumeInput.files?.[0];
    if (!f) return;

    const fd = new FormData();
    fd.append("resume", f);

    const res = await fetch(`/upload-resume`, {
      method: "POST",
      body: fd
    });
    const data = await res.json();
    sessionStorage.setItem("resume_text", data.text || "");

    setStatus(resumeStatus, "Resume loaded", "text-green-600");
  } catch (_) {
    setStatus(resumeStatus, "Resume load failed", "text-red-600");
  }
};

//--------------------------------------------------------------
// Speech Recognition
//--------------------------------------------------------------
function startMic() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    setStatus(audioStatus, "SpeechRecognition not supported", "text-red-600");
    return false;
  }

  function createRecognizer() {
    const r = new SR();
    r.continuous = true;
    r.interimResults = true;
    r.lang = "en-US";
    return r;
  }

  function boot() {
    recognition = createRecognizer();

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

    recognition.onerror = () => setTimeout(boot, 250);
    recognition.onend = () => isRunning && setTimeout(boot, 250);

    try { recognition.start(); } catch (_) {}
  }

  boot();
  return true;
}

//--------------------------------------------------------------
// Audio Context Utils
//--------------------------------------------------------------
async function ensureContext() {
  if (!audioContext) audioContext = new AudioContext();
  if (audioContext.state === "suspended") await audioContext.resume();
}

function stopSystemAudio() {
  try { sysProcessor && (sysProcessor.onaudioprocess = null); } catch (_) {}

  try { sysSource?.disconnect(); } catch (_) {}
  try { sysGain?.disconnect(); } catch (_) {}
  try { sysProcessor?.disconnect(); } catch (_) {}
  try { sysSilentGain?.disconnect(); } catch (_) {}

  if (sysStream) sysStream.getTracks().forEach(t => t.stop());

  sysStream = null;
  sysChunks = [];
  sysCarryRaw = new Float32Array(0);
}

//--------------------------------------------------------------
// System Audio Enable
//--------------------------------------------------------------
async function enableSystemAudio() {
  await ensureContext();

  try {
    sysStream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: { channelCount: 1 }
    });
  } catch {
    setStatus(audioStatus, "Tab audio denied", "text-red-600");
    return;
  }

  const aTrack = sysStream.getAudioTracks()[0];
  if (!aTrack) {
    setStatus(audioStatus, "No tab audio found", "text-red-600");
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

  sysChunks = [];
  lastSysFlushAt = Date.now();

  sysProcessor.onaudioprocess = (ev) => {
    if (!isRunning) return;
    const ch = ev.inputBuffer.getChannelData(0);
    sysChunks.push(new Float32Array(ch));

    const now = Date.now();
    if (now - lastSysFlushAt >= FLUSH_EVERY_MS) {
      lastSysFlushAt = now;
      flushSystem();
    }
  };

  if (autoFlushTimer) clearInterval(autoFlushTimer);
  autoFlushTimer = setInterval(() => {
    if (isRunning && sysChunks.length) flushSystem();
  }, FLUSH_EVERY_MS + 200);

  setStatus(audioStatus, "System audio ON", "text-green-600");
}

//--------------------------------------------------------------
// Whisper Flush
//--------------------------------------------------------------
async function flushSystem() {
  if (sysFlushInFlight) return;
  sysFlushInFlight = true;

  try {
    const chunks = sysChunks;
    sysChunks = [];
    if (!chunks.length) return;

    const raw = chunks.reduce((acc, c) => {
      const o = new Float32Array(acc.length + c.length);
      o.set(acc, 0);
      o.set(c, acc.length);
      return o;
    }, new Float32Array(0));

    const wav16 = float32ToWav(raw, audioContext.sampleRate);
    const fd = new FormData();
    fd.append("audio", wav16, "tab.wav");

    const res = await fetch(`/whisper`, {
      method: "POST",
      body: fd
    });
    const data = await res.json();
    if (data?.text) addToTimeline(data.text);
  } catch (e) {
    console.error("WHISPER ERROR", e);
  }

  sysFlushInFlight = false;
}

function float32ToWav(float32, sr) {
  const int16 = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    int16[i] = Math.max(-1, Math.min(1, float32[i])) * 0x7fff;
  }

  const buf = new ArrayBuffer(44 + int16.length * 2);
  const dv = new DataView(buf);

  function w(off, str) { for (let i = 0; i < str.length; i++) dv.setUint8(off + i, str.charCodeAt(i)); }

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
  for (let i = 0; i < int16.length; i++, off += 2) dv.setInt16(off, int16[i], true);

  return new Blob([buf], { type: "audio/wav" });
}

//--------------------------------------------------------------
// Start / Stop
//--------------------------------------------------------------
async function startAll() {
  if (isRunning) return;

  if (!userSession?.is_admin) startCreditTimer();

  await fetch(`/reset-memory`, { method: "POST" });

  timeline = [];
  promptBox.value = "";
  updateTranscript();

  isRunning = true;
  startBtn.disabled = true;
  stopBtn.disabled = false;

  if (!startMic()) {
    isRunning = false;
    startBtn.disabled = false;
    stopBtn.disabled = true;
  }

  setStatus(audioStatus, "Mic running. Enable tab audio if needed.", "text-green-600");
}

function stopAll() {
  isRunning = false;

  stopCreditTimer();

  try { recognition?.stop(); } catch (_) {}
  stopSystemAudio();

  if (autoFlushTimer) clearInterval(autoFlushTimer);

  timeline = [];
  promptBox.value = "";
  updateTranscript();

  startBtn.disabled = false;
  stopBtn.disabled = true;

  setStatus(audioStatus, "Stopped", "text-yellow-600");
}

//--------------------------------------------------------------
// Send Prompt
//--------------------------------------------------------------
sendBtn.onclick = async () => {
  const msg = normalize(promptBox.value);
  if (!msg) return setStatus(sendStatus, "Nothing to send", "text-yellow-600");

  blockMicUntil = Date.now() + 700;

  timeline = [];
  promptBox.value = "";
  updateTranscript();

  responseBox.innerText = "";
  setStatus(sendStatus, "Sending…", "text-yellow-600");

  try {
    const res = await fetch(`/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: msg })
    });

    const reader = res.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      responseBox.innerText += decoder.decode(value, { stream: true });
    }

    setStatus(sendStatus, "Done", "text-green-600");
  } catch {
    setStatus(sendStatus, "Send failed", "text-red-600");
  }
};

//--------------------------------------------------------------
// Reset
//--------------------------------------------------------------
resetBtn.onclick = () => {
  timeline = [];
  promptBox.value = "";
  updateTranscript();
  setStatus(sendStatus, "Cleared", "text-green-600");
};

//--------------------------------------------------------------
// Logout
//--------------------------------------------------------------
logoutBtn.onclick = () => {
  localStorage.removeItem("session");
  window.location.href = "/auth";
};

//--------------------------------------------------------------
// Page Load
//--------------------------------------------------------------
window.addEventListener("load", async () => {
  await loadUserSession();

  await fetch(`/reset-memory`, { method: "POST" });

  timeline = [];
  promptBox.value = "";
  updateTranscript();

  sessionStorage.removeItem("resume_text");
  setStatus(resumeStatus, "Resume cleared", "text-gray-600");
});
