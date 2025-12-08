//--------------------------------------------------------------
// DOM
//--------------------------------------------------------------
const userInfo = document.getElementById("userInfo");
const logoutBtn = document.getElementById("logoutBtn");
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
const banner = document.getElementById("bannerTop");

//--------------------------------------------------------------
// STATE
//--------------------------------------------------------------
let session = null;
let isRunning = false;

let recognition = null;
let credits = 0;

let audioContext = null;
let sysStream = null;
let sysProcessor = null;
let sysChunks = [];
let lastSysFlushAt = 0;
let sysFlushInFlight = false;

let timeline = [];
let autoFlushTimer = null;
let creditTimer = null;
let blockMicUntil = 0;

//--------------------------------------------------------------
// Helpers
//--------------------------------------------------------------
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

function showBanner(msg, color = "bg-red-600") {
  banner.textContent = msg;
  banner.className = `w-full text-white text-center p-2 ${color}`;
  banner.style.display = "block";
}

function hideBanner() {
  banner.style.display = "none";
}

//--------------------------------------------------------------
// Load USER PROFILE + Credits
//--------------------------------------------------------------
async function loadUserProfile() {
  const res = await fetch("/api?path=user/profile", {
    headers: { Authorization: `Bearer ${session.access_token}` },
  });

  const data = await res.json();
  if (!res.ok) throw new Error(data.error);

  credits = data.user.credits;

  userInfo.innerHTML = `
    Logged in as <b>${data.user.email}</b><br>
    Credits: <b id="creditsLabel">${credits}</b><br>
    Joined: ${data.user.created_ymd}
  `;
}

function updateCreditsUI(newVal) {
  credits = newVal;
  const el = document.getElementById("creditsLabel");
  if (el) el.textContent = credits;

  if (credits <= 0) {
    showBanner("No more credits. Contact admin: shiva509203@gmail.com");
    stopAll();
    sendBtn.disabled = true;
  }
}

//--------------------------------------------------------------
// Deduct Backend Credits each second
//--------------------------------------------------------------
async function deductOneSecond() {
  if (!isRunning) return;
  if (credits <= 0) return stopAll();

  const res = await fetch("/api?path=user/deduct", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${session.access_token}`,
    },
    body: JSON.stringify({ seconds: 1 }),
  });

  const data = await res.json();
  if (!res.ok) return;

  updateCreditsUI(data.credits);
}

function startCreditLoop() {
  creditTimer = setInterval(() => {
    deductOneSecond();
  }, 1000);
}

function stopCreditLoop() {
  if (creditTimer) clearInterval(creditTimer);
  creditTimer = null;
}

//--------------------------------------------------------------
// Instructions
//--------------------------------------------------------------
instructionsBox.value = localStorage.getItem("instructions") || "";
instructionsBox.addEventListener("input", () => {
  localStorage.setItem("instructions", instructionsBox.value);
  setStatus(instrStatus, "Saved", "text-green-600");
  setTimeout(() => setStatus(instrStatus, "", ""), 600);
});

//--------------------------------------------------------------
// Resume Upload
//--------------------------------------------------------------
resumeInput?.addEventListener("change", async () => {
  const file = resumeInput.files?.[0];
  if (!file) return;

  setStatus(resumeStatus, "Processing...", "text-orange-600");

  const fd = new FormData();
  fd.append("file", file);

  const res = await fetch("/api?path=resume/extract", {
    method: "POST",
    body: fd,
  });

  const data = await res.json();
  localStorage.setItem("resumeText", data.text || "");

  setStatus(resumeStatus, "Resume extracted", "text-green-600");
});

//--------------------------------------------------------------
// MIC Speech Recognition
//--------------------------------------------------------------
function startMic() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    setStatus(audioStatus, "Browser does not support speech", "text-red-600");
    return false;
  }

  const r = new SR();
  r.lang = "en-US";
  r.continuous = true;
  r.interimResults = true;

  r.onresult = (ev) => {
    if (!isRunning) return;
    if (Date.now() < blockMicUntil) return;

    let interim = "";

    for (let i = ev.resultIndex; i < ev.results.length; i++) {
      const rr = ev.results[i];
      const txt = normalize(rr[0].transcript || "");
      if (rr.isFinal) addToTimeline(txt);
      else interim = txt;
    }

    if (interim) {
      const base = timeline.map(t => t.text).join(" ");
      promptBox.value = (base + " " + interim).trim();
    }
  };

  r.onerror = (_) => {};
  r.onend = () => isRunning && r.start();

  try {
    r.start();
  } catch {}

  recognition = r;
  return true;
}

//--------------------------------------------------------------
// System Audio Capture
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
      audio: true,
    });
  } catch {
    setStatus(audioStatus, "System audio denied", "text-red-600");
    return;
  }

  const track = sysStream.getAudioTracks()[0];
  if (!track) {
    setStatus(audioStatus, "No system audio detected", "text-red-600");
    return;
  }

  const src = audioContext.createMediaStreamSource(sysStream);
  const gain = audioContext.createGain();
  gain.gain.value = 1;

  sysProcessor = audioContext.createScriptProcessor(4096, 1, 1);
  const silent = audioContext.createGain();
  silent.gain.value = 0;

  src.connect(gain);
  gain.connect(sysProcessor);
  sysProcessor.connect(silent);
  silent.connect(audioContext.destination);

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

  autoFlushTimer = setInterval(() => {
    if (sysChunks.length && isRunning) flushSystemAudio();
  }, 1400);

  sysBtn.className = "px-3 py-2 bg-purple-700 text-white rounded";
  setStatus(audioStatus, "System audio enabled", "text-green-600");
}

function float32ToWav(float32, sr) {
  const int16 = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++)
    int16[i] = Math.max(-1, Math.min(1, float32[i])) * 32767;

  const buf = new ArrayBuffer(44 + int16.length * 2);
  const dv = new DataView(buf);

  function wr(o, s) {
    for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i));
  }

  wr(0, "RIFF");
  dv.setUint32(4, 36 + int16.length * 2, true);
  wr(8, "WAVE");
  wr(12, "fmt ");
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);
  dv.setUint16(22, 1, true);
  dv.setUint32(24, sr, true);
  dv.setUint32(28, sr * 2, true);
  dv.setUint16(32, 2, true);
  dv.setUint16(34, 16, true);
  wr(36, "data");
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
      const o = new Float32Array(acc.length + c.length);
      o.set(acc, 0);
      o.set(c, acc.length);
      return o;
    }, new Float32Array(0));

    const wav = float32ToWav(raw, audioContext.sampleRate);

    const fd = new FormData();
    fd.append("file", wav);

    const res = await fetch("/api?path=transcribe", {
      method: "POST",
      body: fd,
    });

    const data = await res.json();
    if (data.text) addToTimeline(data.text);
  } catch (err) {
    console.error(err);
  }

  sysFlushInFlight = false;
}

//--------------------------------------------------------------
// START / STOP
//--------------------------------------------------------------
async function startAll() {
  if (isRunning) return;

  hideBanner();

  if (credits <= 0) {
    showBanner("You have 0 credits. Contact admin: shiva509203@gmail.com");
    return;
  }

  isRunning = true;
  startBtn.disabled = true;
  stopBtn.disabled = false;
  sendBtn.disabled = false;

  startBtn.className = "px-3 py-2 bg-gray-400 text-white rounded";
  stopBtn.className = "px-3 py-2 bg-red-700 text-white rounded";

  startMic();
  startCreditLoop();

  setStatus(audioStatus, "Mic active", "text-green-600");
}

function stopAll() {
  isRunning = false;

  stopCreditLoop();

  try { recognition?.stop(); } catch {}

  if (sysStream) sysStream.getTracks().forEach(t => t.stop());
  sysStream = null;

  if (autoFlushTimer) clearInterval(autoFlushTimer);

  startBtn.disabled = false;
  stopBtn.disabled = true;
  sendBtn.disabled = true;

  startBtn.className = "px-3 py-2 bg-green-600 text-white rounded";
  stopBtn.className = "px-3 py-2 bg-gray-500 text-white rounded opacity-50";
  sysBtn.className = "px-3 py-2 bg-purple-600 text-white rounded";

  setStatus(audioStatus, "Stopped", "text-orange-600");
}

//--------------------------------------------------------------
// SEND to ChatGPT
//--------------------------------------------------------------
sendBtn.onclick = async () => {
  if (!isRunning) return;

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
      instructions: localStorage.getItem("instructions") || "",
      resumeText: localStorage.getItem("resumeText") || "",
    };

    const res = await fetch("/api?path=chat/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const reader = res.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      responseBox.textContent += decoder.decode(value);
    }

    setStatus(sendStatus, "Completed", "text-green-600");
  } catch {
    setStatus(sendStatus, "Failed", "text-red-600");
  }
};

//--------------------------------------------------------------
// CLEAR + RESET
//--------------------------------------------------------------
clearBtn.onclick = () => {
  timeline = [];
  promptBox.value = "";
  updateTranscript();
  setStatus(sendStatus, "Transcript cleared", "text-green-600");
};

resetBtn.onclick = () => {
  timeline = [];
  promptBox.value = "";
  responseBox.textContent = "";
  updateTranscript();
  setStatus(sendStatus, "All cleared", "text-green-600");
};

//--------------------------------------------------------------
// LOGOUT
//--------------------------------------------------------------
logoutBtn.onclick = () => {
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

  sendBtn.disabled = true;
});
