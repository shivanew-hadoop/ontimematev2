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

let timeline = [];
let autoFlushTimer = null;
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

//--------------------------------------------------------------
// Load USER PROFILE
//--------------------------------------------------------------
async function loadUserProfile() {
  const res = await fetch("/api?path=user/profile", {
    headers: { Authorization: `Bearer ${session.access_token}` }
  });

  const data = await res.json();
  if (!res.ok) throw new Error(data.error);

  userInfo.innerHTML = `
    Logged in as <b>${data.user.email}</b><br>
    Credits: <b>${data.user.credits}</b><br>
    Joined: ${data.user.created_ymd}
  `;
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
// Resume Upload → /api?path=resume/extract
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

  const data = await res.json();
  localStorage.setItem("resumeText", data.text || "");

  resumeStatus.textContent = "Resume extracted.";
});

//--------------------------------------------------------------
// Mic: Speech Recognition
//--------------------------------------------------------------
function startMic() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    setStatus(audioStatus, "SpeechRecognition not supported", "text-red-600");
    return false;
  }

  function createRecognizer() {
    const r = new SR();
    r.lang = "en-US";
    r.continuous = true;
    r.interimResults = true;
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

    recognition.onerror = () => setTimeout(boot, 400);
    recognition.onend = () => isRunning && setTimeout(boot, 400);

    try { recognition.start(); } catch (_) {}
  }

  boot();
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
  await ensureContext();

  try {
    sysStream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: true
    });
  } catch {
    setStatus(audioStatus, "Permission denied", "text-red-600");
    return;
  }

  const track = sysStream.getAudioTracks()[0];
  if (!track) {
    setStatus(audioStatus, "No system audio detected", "text-red-600");
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

  autoFlushTimer = setInterval(() => {
    if (sysChunks.length && isRunning) flushSystemAudio();
  }, 1400);

  setStatus(audioStatus, "System audio enabled", "text-green-600");
}

//--------------------------------------------------------------
// Float32 → WAV
//--------------------------------------------------------------
function float32ToWav(float32, sr) {
  const int16 = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    int16[i] = Math.max(-1, Math.min(1, float32[i])) * 0x7fff;
  }

  const buf = new ArrayBuffer(44 + int16.length * 2);
  const dv = new DataView(buf);

  const write = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };

  write(0, "RIFF");
  dv.setUint32(4, 36 + int16.length * 2, true);
  write(8, "WAVE");
  write(12, "fmt ");
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);
  dv.setUint16(22, 1, true);
  dv.setUint32(24, sr, true);
  dv.setUint32(28, sr * 2, true);
  dv.setUint16(32, 2, true);
  dv.setUint16(34, 16, true);
  write(36, "data");
  dv.setUint32(40, int16.length * 2, true);

  let offset = 44;
  for (let i = 0; i < int16.length; i++, offset += 2)
    dv.setInt16(offset, int16[i], true);

  return new Blob([buf], { type: "audio/wav" });
}

//--------------------------------------------------------------
// Flush whisper system audio
//--------------------------------------------------------------
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
      body: fd
    });

    const data = await res.json();
    if (data.text) addToTimeline(data.text);
  } catch (err) {
    console.error("System audio error:", err);
  }

  sysFlushInFlight = false;
}

//--------------------------------------------------------------
// START / STOP
//--------------------------------------------------------------
async function startAll() {
  if (isRunning) return;

  await fetch("/api?path=chat/reset", { method: "POST" });

  timeline = [];
  updateTranscript();

  isRunning = true;
  startBtn.disabled = true;
  stopBtn.disabled = false;

  startMic();

  setStatus(audioStatus, "Mic active", "text-green-600");
}

function stopAll() {
  isRunning = false;

  try { recognition?.stop(); } catch (_) {}

  if (sysStream) sysStream.getTracks().forEach(t => t.stop());
  sysStream = null;

  if (autoFlushTimer) clearInterval(autoFlushTimer);

  startBtn.disabled = false;
  stopBtn.disabled = true;

  setStatus(audioStatus, "Stopped", "text-orange-600");
}

//--------------------------------------------------------------
// SEND to ChatGPT
//--------------------------------------------------------------
sendBtn.onclick = async () => {
  const msg = normalize(promptBox.value);
  if (!msg) return setStatus(sendStatus, "Empty message", "text-red-600");

  blockMicUntil = Date.now() + 800;

  timeline = [];
  promptBox.value = "";
  updateTranscript();

  responseBox.textContent = "";
  setStatus(sendStatus, "Sending…", "text-orange-600");

  try {
    const body = {
      prompt: msg,
      instructions: localStorage.getItem("instructions") || "",
      resumeText: localStorage.getItem("resumeText") || ""
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
  } catch (err) {
    console.error(err);
    setStatus(sendStatus, "Failed", "text-red-600");
  }
};

//--------------------------------------------------------------
// CLEAR only transcript (FIXED)
//--------------------------------------------------------------
clearBtn.onclick = () => {
  timeline = [];
  promptBox.value = "";
  updateTranscript();
  setStatus(sendStatus, "Transcript cleared", "text-green-600");
};

//--------------------------------------------------------------
// RESET clears EVERYTHING including ChatGPT
//--------------------------------------------------------------
resetBtn.onclick = () => {
  timeline = [];
  promptBox.value = "";
  responseBox.textContent = "";
  updateTranscript();
  setStatus(sendStatus, "All cleared", "text-green-600");
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
  promptBox.value = "";
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
