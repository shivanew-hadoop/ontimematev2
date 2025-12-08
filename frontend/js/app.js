//--------------------------------------------------------------
// DOM
//--------------------------------------------------------------
const userInfo = document.getElementById("userInfo");
const creditBanner = document.getElementById("creditBanner");

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

const logoutBtn = document.getElementById("logoutBtn");

//--------------------------------------------------------------
// STATE
//--------------------------------------------------------------
let session = null;
let isRunning = false;
let recognition = null;

let audioContext = null;
let sysStream = null;
let sysProcessor = null;

let sysChunks = [];
let lastSysFlushAt = 0;
let sysFlushInFlight = false;

let timeline = [];
let blockMicUntil = 0;
let creditTimer = null;

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

function setLiveCredits(c) {
  const html = userInfo.innerHTML.replace(/Credits:\s*<b>.*?<\/b>/, `Credits: <b>${c}</b>`);
  userInfo.innerHTML = html;
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
// LOGOUT
//--------------------------------------------------------------
logoutBtn.onclick = () => {
  localStorage.removeItem("session");
  window.location.href = "/auth?tab=login";
};

//--------------------------------------------------------------
// Instructions
//--------------------------------------------------------------
instructionsBox.value = localStorage.getItem("instructions") || "";

instructionsBox.addEventListener("input", () => {
  localStorage.setItem("instructions", instructionsBox.value);
  instrStatus.textContent = "Saved";
  instrStatus.className = "text-green-600";
  setTimeout(() => (instrStatus.textContent = ""), 500);
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

  const data = await res.json();
  localStorage.setItem("resumeText", data.text || "");

  resumeStatus.textContent = "Resume extracted.";
});

//--------------------------------------------------------------
// Mic Speech Recognition
//--------------------------------------------------------------
function startMic() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return;

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

    try { recognition.start(); } catch {}
  }

  boot();
}

//--------------------------------------------------------------
// System Audio Capture
//--------------------------------------------------------------
async function ensureContext() {
  if (!audioContext) audioContext = new AudioContext();
  if (audioContext.state === "suspended") await audioContext.resume();
}

async function enableSystemAudio() {
  if (!isRunning) return alert("Start recording first!");

  await ensureContext();

  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: { channelCount: 1 }
    });
  } catch (err) {
    setStatus(audioStatus, "Window capture denied", "text-red-600");
    return;
  }

  sysStream = stream;
  const source = audioContext.createMediaStreamSource(stream);

  sysProcessor = audioContext.createScriptProcessor(4096, 1, 1);
  sysProcessor.onaudioprocess = (ev) => {
    if (!isRunning) return;
    const ch = ev.inputBuffer.getChannelData(0);
    if (ch.length === 0) return;
    sysChunks.push(new Float32Array(ch));

    const now = Date.now();
    if (now - lastSysFlushAt >= 1000) {
      lastSysFlushAt = now;
      flushSystemAudio();
    }
  };

  source.connect(sysProcessor);
  sysProcessor.connect(audioContext.destination);

  setStatus(audioStatus, "System audio enabled", "text-green-600");
}

//--------------------------------------------------------------
// Convert Float32 → WAV
//--------------------------------------------------------------
function float32ToWav(float32, sr) {
  const int16 = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++)
    int16[i] = Math.max(-1, Math.min(1, float32[i])) * 0x7fff;

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
// Flush System Audio → Whisper
//--------------------------------------------------------------
async function flushSystemAudio() {
  if (!isRunning || sysFlushInFlight) return;
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
    fd.append("file", wav, "sys.wav");

    const res = await fetch("/api?path=transcribe", {
      method: "POST",
      body: fd
    });
    const data = await res.json();

    if (data.text) addToTimeline(data.text);
  } catch (e) {
    console.error(e);
  }

  sysFlushInFlight = false;
}

//--------------------------------------------------------------
// CREDIT DEDUCTION LOOP
//--------------------------------------------------------------
function startCreditTimer() {
  if (creditTimer) clearInterval(creditTimer);

  creditTimer = setInterval(async () => {
    if (!isRunning) return;

    const res = await fetch("/api?path=user/deduct", {
      method: "POST",
      headers: { Authorization: `Bearer ${session.access_token}` }
    });

    const data = await res.json();

    if (data?.credits != null) {
      const c = Number(data.credits);
      setLiveCredits(c);

      if (c <= 0) {
        creditBanner.classList.remove("hidden");
        stopAll();
        sendBtn.disabled = true;
        sendBtn.classList.add("opacity-50");
        startBtn.disabled = true;
        startBtn.classList.add("opacity-50");
      }
    }
  }, 1000);
}

//--------------------------------------------------------------
// START / STOP
//--------------------------------------------------------------
async function startAll() {
  if (!session) return;
  if (isRunning) return;

  await fetch("/api?path=chat/reset", { method: "POST" });

  isRunning = true;

  startBtn.disabled = true;
  startBtn.classList.add("opacity-50");

  stopBtn.disabled = false;
  stopBtn.classList.remove("opacity-50");

  sysBtn.disabled = false;
  sysBtn.classList.remove("opacity-50");

  sendBtn.disabled = false;

  timeline = [];
  updateTranscript();

  startMic();
  startCreditTimer();

  setStatus(audioStatus, "Mic active", "text-green-600");
}

function stopAll() {
  isRunning = false;

  try { recognition?.stop(); } catch {}

  if (sysStream) sysStream.getTracks().forEach(t => t.stop());
  sysStream = null;

  if (creditTimer) clearInterval(creditTimer);

  startBtn.disabled = false;
  startBtn.classList.remove("opacity-50");

  stopBtn.disabled = true;
  stopBtn.classList.add("opacity-50");

  sysBtn.disabled = true;
  sysBtn.classList.add("opacity-50");

  setStatus(audioStatus, "Stopped", "text-orange-600");
}

//--------------------------------------------------------------
// SEND to ChatGPT
//--------------------------------------------------------------
sendBtn.onclick = async () => {
  if (!isRunning) return alert("Start recording first!");

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
};

//--------------------------------------------------------------
// RESET all
//--------------------------------------------------------------
resetBtn.onclick = () => {
  timeline = [];
  promptBox.value = "";
  responseBox.textContent = "";
  updateTranscript();
};

//--------------------------------------------------------------
// PAGE LOAD
//--------------------------------------------------------------
window.addEventListener("load", async () => {
  session = JSON.parse(localStorage.getItem("session") || "null");
  if (!session) return (window.location.href = "/auth?tab=login");

  await loadUserProfile();
  await fetch("/api?path=chat/reset", { method: "POST" });

  promptBox.value = "";
  timeline = [];
  updateTranscript();
});

//--------------------------------------------------------------
// Bind Buttons
//--------------------------------------------------------------
startBtn.onclick = startAll;
stopBtn.onclick = stopAll;
sysBtn.onclick = enableSystemAudio;
