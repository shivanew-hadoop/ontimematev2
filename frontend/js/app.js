//--------------------------------------------------------------
// CONFIG
//--------------------------------------------------------------
const API_BASE = ""; // same domain on Vercel

//--------------------------------------------------------------
// DOM REFERENCES
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
const creditsLabel = document.getElementById("creditsLabel");

//--------------------------------------------------------------
// SESSION
//--------------------------------------------------------------
const session = JSON.parse(localStorage.getItem("session"));
if (!session) window.location.href = "/auth";

const TOKEN = session.token;

//--------------------------------------------------------------
// STATE VARIABLES
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
let autoFlushTimer = null;

let timeline = [];
let blockMicUntil = 0;

//--------------------------------------------------------------
// Utility
//--------------------------------------------------------------
function normalize(s) {
  return (s || "").replace(/\s+/g, " ").trim();
}

function setStatus(el, text, cls = "") {
  if (!el) return;
  el.className = `text-xs mt-1 ${cls}`;
  el.textContent = text;
}

//--------------------------------------------------------------
// USER PROFILE + CREDITS LOADING
//--------------------------------------------------------------
async function loadProfile() {
  try {
    const res = await fetch("/api/user/profile", {
      method: "GET",
      headers: { Authorization: `Bearer ${TOKEN}` }
    });

    const data = await res.json();
    if (!data.ok) throw new Error(data.error);

    const u = data.user;

    userInfo.innerHTML = `
      <div><strong>${u.name}</strong></div>
      <div>${u.email}</div>
      <div>Status: ${u.approved ? "Approved" : "Pending"}</div>
    `;

    creditsLabel.textContent = u.credits ?? 0;

    if (!u.approved) {
      alert("Your account is not approved yet.");
      window.location.href = "/auth";
    }
  } catch (e) {
    alert("Session expired. Login again.");
    window.location.href = "/auth";
  }
}

loadProfile();

//--------------------------------------------------------------
// CREDIT DEDUCTION PING
//--------------------------------------------------------------
setInterval(async () => {
  if (!isRunning) return;
  try {
    const res = await fetch("/api/user/deductSecond", {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}` }
    });

    const data = await res.json();
    if (data.error) throw new Error(data.error);

    const credits = data.credits ?? 0;
    creditsLabel.textContent = credits;

    // AUTO-STOP when credits hit zero
    if (credits <= 0) {
      stopAll();
      alert("Your credits are finished.");
    }
  } catch (_) {}
}, 1000);

//--------------------------------------------------------------
// TIMELINE + TRANSCRIPT
//--------------------------------------------------------------
function addToTimeline(txt) {
  const cleaned = normalize(txt);
  if (!cleaned) return;

  timeline.push({ time: Date.now(), text: cleaned });

  promptBox.value = timeline.map(t => t.text).join(" ");
  promptBox.scrollTop = promptBox.scrollHeight;
}

//--------------------------------------------------------------
// CUSTOM INSTRUCTIONS (LOCAL STORAGE)
//--------------------------------------------------------------
instructionsBox.value = localStorage.getItem("custom_instructions") || "";

instructionsBox.addEventListener("input", () => {
  localStorage.setItem("custom_instructions", instructionsBox.value.trim());
  setStatus(instrStatus, "Saved", "text-green-600");
});

//--------------------------------------------------------------
// RESUME UPLOAD
//--------------------------------------------------------------
resumeInput.onchange = async () => {
  try {
    const f = resumeInput.files?.[0];
    if (!f) return;

    const fd = new FormData();
    fd.append("resume", f);

    const res = await fetch("/upload-resume", {
      method: "POST",
      body: fd
    });

    const data = await res.json();
    sessionStorage.setItem("resume_text", data.text || "");

    setStatus(resumeStatus, "Uploaded", "text-green-600");
  } catch (e) {
    setStatus(resumeStatus, "Failed", "text-red-600");
  }
};

//--------------------------------------------------------------
// SPEECH RECOGNITION
//--------------------------------------------------------------
function startMic() {
  const SR =
    window.SpeechRecognition || window.webkitSpeechRecognition;
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

    try {
      recognition.start();
    } catch (_) {}
  }

  boot();
  return true;
}

//--------------------------------------------------------------
// AUDIO CONTEXT + SYSTEM AUDIO
//--------------------------------------------------------------
async function ensureContext() {
  if (!audioContext) audioContext = new AudioContext();
  if (audioContext.state === "suspended") await audioContext.resume();
}

function stopSystemAudio() {
  try { sysProcessor.onaudioprocess = null; } catch (_) {}
  try { sysSource.disconnect(); } catch (_) {}
  try { sysGain.disconnect(); } catch (_) {}
  try { sysProcessor.disconnect(); } catch (_) {}
  try { sysSilentGain.disconnect(); } catch (_) {}

  if (sysStream) sysStream.getTracks().forEach(t => t.stop());

  sysStream = null;
  sysChunks = [];
}

async function enableSystemAudio() {
  await ensureContext();

  try {
    sysStream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: { channelCount: 1 }
    });
  } catch {
    setStatus(audioStatus, "Permission denied", "text-red-600");
    return;
  }

  const aTrack = sysStream.getAudioTracks()[0];
  if (!aTrack) {
    setStatus(audioStatus, "No tab audio", "text-red-600");
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
    const ch = ev.inputBuffer.getChannelData(0);
    sysChunks.push(new Float32Array(ch));

    const now = Date.now();
    if (now - lastSysFlushAt >= 1100) {
      lastSysFlushAt = now;
      flushTabAudio();
    }
  };

  setStatus(audioStatus, "System audio ON", "text-green-600");
}

//--------------------------------------------------------------
// Flush system audio to Whisper API
//--------------------------------------------------------------
async function flushTabAudio() {
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
    fd.append("audio", wav, "sys.wav");

    const res = await fetch("/whisper", { method: "POST", body: fd });
    const data = await res.json();

    if (data.text) addToTimeline(data.text);
  } finally {
    sysFlushInFlight = false;
  }
}

function float32ToWav(float32, sr) {
  const int16 = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    int16[i] = Math.max(-1, Math.min(1, float32[i])) * 0x7fff;
  }

  const buf = new ArrayBuffer(44 + int16.length * 2);
  const dv = new DataView(buf);

  function w(off, str) {
    for (let i = 0; i < str.length; i++)
      dv.setUint8(off + i, str.charCodeAt(i));
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

//--------------------------------------------------------------
// START / STOP
//--------------------------------------------------------------
async function startAll() {
  if (isRunning) return;

  await fetch("/reset-memory", { method: "POST" });

  timeline = [];
  promptBox.value = "";

  isRunning = true;
  startBtn.disabled = true;
  stopBtn.disabled = false;

  if (!startMic()) {
    isRunning = false;
    startBtn.disabled = false;
    stopBtn.disabled = true;
    return;
  }

  setStatus(audioStatus, "Mic running", "text-green-600");
}

function stopAll() {
  isRunning = false;

  try { recognition?.stop(); } catch (_) {}
  stopSystemAudio();

  timeline = [];
  promptBox.value = "";

  startBtn.disabled = false;
  stopBtn.disabled = true;

  setStatus(audioStatus, "Stopped", "text-red-600");
}

//--------------------------------------------------------------
// SEND to ChatGPT
//--------------------------------------------------------------
sendBtn.onclick = async () => {
  const msg = normalize(promptBox.value);
  if (!msg) return setStatus(sendStatus, "Nothing to send", "text-red-600");

  blockMicUntil = Date.now() + 700;

  timeline = [];
  promptBox.value = "";
  responseBox.innerText = "";
  setStatus(sendStatus, "Sending…", "text-yellow-600");

  try {
    const res = await fetch("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: msg })
    });

    const reader = res.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      responseBox.innerText += decoder.decode(value, { stream: true });
    }

    setStatus(sendStatus, "Done", "text-green-600");
  } catch (_) {
    setStatus(sendStatus, "Failed", "text-red-600");
  }
};

//--------------------------------------------------------------
// CLEAR BUTTON
//--------------------------------------------------------------
resetBtn.onclick = () => {
  timeline = [];
  promptBox.value = "";
  setStatus(sendStatus, "Cleared", "text-gray-600");
};

//--------------------------------------------------------------
// BUTTON EVENTS
//--------------------------------------------------------------
startBtn.onclick = startAll;
stopBtn.onclick = stopAll;
sysBtn.onclick = enableSystemAudio;

logoutBtn.onclick = () => {
  localStorage.removeItem("session");
  window.location.href = "/auth";
};
