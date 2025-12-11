//--------------------------------------------------------------
// DOM
//--------------------------------------------------------------
const userInfo = document.getElementById("userInfo");
const instructionsBox = document.getElementBygetElementById("instructionsBox");
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
const modeSelect = document.getElementById("modeSelect");

//--------------------------------------------------------------
// STATE
//--------------------------------------------------------------
let session = null;
let isRunning = false;

// MIC
let recognition = null;
let micInterimEntry = null;
let blockMicUntil = 0;

// SYSTEM AUDIO
let sysStream = null;
let sysTrack = null;
let sysRecorder = null;
let sysSegmentChunks = [];
let sysSegmentTimer = null;
let sysQueue = [];
let sysAbort = null;
let sysInFlight = 0;
let sysSeq = 0;

// Transcript timeline
let timeline = [];

// Credits
let creditTimer = null;
let lastCreditAt = 0;

// Chat
let chatAbort = null;
let chatStreamActive = false;
let chatStreamSeq = 0;
let chatHistory = [];
const MAX_HISTORY_MESSAGES = 8;
const MAX_HISTORY_CHARS_EACH = 1500;

// Resume memory
let resumeTextMem = "";

// System dedupe
let lastSysTail = "";

//--------------------------------------------------------------
// CONFIG (2200ms CHOSEN)
//--------------------------------------------------------------
const SYS_SEGMENT_MS = 2200;
const SYS_MIN_BYTES = 3000;
const SYS_MAX_CONCURRENT = 2;
const SYS_TYPE_MS_PER_WORD = 18;

// Credits
const CREDIT_BATCH_SEC = 5;
const CREDITS_PER_SEC = 1;

// MIC fallback accents
const MIC_LANGS = ["en-IN", "en-GB", "en-US"];
let micLangIndex = 0;

// System audio bias prompt
const WHISPER_BIAS_PROMPT =
  "Transcribe clearly in English. Handle Indian, British, Australian and American accents. Keep proper nouns and numbers.";

//--------------------------------------------------------------
// Helpers
//--------------------------------------------------------------
function normalize(s) {
  return (s || "").replace(/\s+/g, " ").trim();
}

function updateTranscript() {
  promptBox.value = timeline.map(t => t.text).join(" ").trim();
  promptBox.scrollTop = promptBox.scrollHeight;
}

function addToTimeline(txt) {
  txt = normalize(txt);
  if (!txt) return;
  timeline.push({ t: Date.now(), text: txt });
  updateTranscript();
}

function addToTimelineTypewriter(txt) {
  const cleaned = normalize(txt);
  if (!cleaned) return;

  const entry = { t: Date.now(), text: "" };
  timeline.push(entry);

  const words = cleaned.split(" ");
  let i = 0;

  const timer = setInterval(() => {
    if (!isRunning) return clearInterval(timer);
    if (i >= words.length) return clearInterval(timer);

    entry.text += (entry.text ? " " : "") + words[i++];
    updateTranscript();
  }, SYS_TYPE_MS_PER_WORD);
}

// Clean hallucinations
function cleanSysText(t) {
  const s = normalize(t).toLowerCase();
  if (!s) return "";

  const bad = [
    "i'm sorry",
    "i am sorry",
    "cannot transcribe",
    "can't transcribe",
    "unable to transcribe",
    "i don't know",
    "i can't wait to see you",
    "thanks for watching",
    "please like and subscribe"
  ];

  if (bad.some(b => s.includes(b))) return "";
  return t;
}

//--------------------------------------------------------------
// MODE SELECTOR (Interview / Sales / General)
//--------------------------------------------------------------
const MODES = {
  general: "",
  interview:
    "Always answer like a real professional, not ChatGPT. Use real-world project examples, resume context, and explain in natural spoken tone.",
  sales:
    "Respond in a persuasive, customer-centric tone. Focus on value, clarity, and real-world selling situations."
};

function getEffectiveInstructions() {
  const base = MODES[modeSelect.value] || "";
  const userCustom = instructionsBox.value.trim();
  return base + "\n" + userCustom;
}

modeSelect.onchange = () => {
  instructionsBox.value = MODES[modeSelect.value];
  localStorage.setItem("instructions", instructionsBox.value);
  instrStatus.textContent = "Mode applied";
  instrStatus.className = "text-green-600";
  setTimeout(() => (instrStatus.textContent = ""), 600);
};

//--------------------------------------------------------------
// Resume Upload
//--------------------------------------------------------------
resumeInput.addEventListener("change", async () => {
  const f = resumeInput.files?.[0];
  if (!f) return;

  resumeStatus.textContent = "Processing…";

  const fd = new FormData();
  fd.append("file", f);

  const res = await apiFetch("resume/extract", {
    method: "POST",
    body: fd
  }, false);

  const data = await res.json().catch(() => ({}));
  resumeTextMem = data.text || "";

  resumeStatus.textContent =
    resumeTextMem.startsWith("[Resume upload") ?
      resumeTextMem :
      `Resume extracted (${resumeTextMem.length} chars)`;
});

//--------------------------------------------------------------
// MIC
//--------------------------------------------------------------
function stopMicOnly() {
  try { recognition?.stop(); } catch {}
  recognition = null;
  micInterimEntry = null;
}

function startMic() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return false;

  stopMicOnly();

  recognition = new SR();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = MIC_LANGS[micLangIndex];

  recognition.onresult = ev => {
    if (!isRunning) return;
    if (Date.now() < blockMicUntil) return;

    let interim = "";

    for (let i = ev.resultIndex; i < ev.results.length; i++) {
      const r = ev.results[i];
      const text = normalize(r[0].transcript);

      if (r.isFinal) {
        if (micInterimEntry) {
          const idx = timeline.indexOf(micInterimEntry);
          if (idx >= 0) timeline.splice(idx, 1);
          micInterimEntry = null;
        }
        addToTimeline(text);
      } else {
        interim = text;
      }
    }

    if (interim) {
      if (!micInterimEntry) {
        micInterimEntry = { t: Date.now(), text: interim };
        timeline.push(micInterimEntry);
      } else {
        micInterimEntry.text = interim;
      }
      updateTranscript();
    }
  };

  recognition.onerror = () => {
    micLangIndex = (micLangIndex + 1) % MIC_LANGS.length;
  };

  recognition.onend = () => {
    if (isRunning) try { recognition.start(); } catch {}
  };

  try { recognition.start(); } catch {}
  return true;
}

//--------------------------------------------------------------
// SYSTEM AUDIO
//--------------------------------------------------------------
function stopSystemAudioOnly() {
  sysSeq++;
  try { sysAbort?.abort(); } catch {}
  sysAbort = null;

  if (sysSegmentTimer) clearInterval(sysSegmentTimer);
  sysRecorder?.stop();

  sysStream?.getTracks().forEach(t => t.stop());
  sysTrack = null;
  sysRecorder = null;

  sysQueue = [];
  sysInFlight = 0;
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
    setStatus(audioStatus, "Denied — Use Chrome TAB + Share audio", "text-red-600");
    return;
  }

  sysTrack = sysStream.getAudioTracks()[0];
  if (!sysTrack) {
    setStatus(audioStatus, "No system audio", "text-red-600");
    stopSystemAudioOnly();
    return;
  }

  sysAbort = new AbortController();
  sysSeq++;

  startSystemRecorder(sysSeq);
  setStatus(audioStatus, "System audio enabled (fast + stable)", "text-green-600");
}

function startSystemRecorder(runId) {
  const ms = new MediaStream([sysTrack]);
  sysRecorder = new MediaRecorder(ms, { mimeType: "audio/webm;codecs=opus" });
  sysSegmentChunks = [];

  sysRecorder.ondataavailable = ev => {
    if (ev.data?.size) sysSegmentChunks.push(ev.data);
  };

  sysRecorder.onstop = () => {
    if (!isRunning || runId !== sysSeq) return;

    const blob = new Blob(sysSegmentChunks, { type: "audio/webm" });
    sysSegmentChunks = [];

    if (blob.size >= SYS_MIN_BYTES) {
      sysQueue.push({ blob, runId });
      drainSysQueue();
    }

    if (isRunning && sysTrack.readyState === "live") {
      startSystemRecorder(runId);
    }
  };

  sysRecorder.start();
  sysSegmentTimer = setInterval(() => {
    if (isRunning) sysRecorder.stop();
  }, SYS_SEGMENT_MS);
}

function drainSysQueue() {
  while (sysInFlight < SYS_MAX_CONCURRENT && sysQueue.length) {
    const item = sysQueue.shift();
    sysInFlight++;
    transcribeSys(item.blob, item.runId)
      .finally(() => {
        sysInFlight--;
        drainSysQueue();
      });
  }
}

function dedupeSystemText(t) {
  const newText = normalize(t);
  if (!newText) return "";

  if (!lastSysTail) {
    lastSysTail = newText.split(" ").slice(-12).join(" ");
    return newText;
  }

  const tailWords = lastSysTail.split(" ");
  const newWords = newText.split(" ");

  let overlap = 0;
  const maxK = Math.min(10, tailWords.length, newWords.length);

  for (let k = maxK; k >= 3; k--) {
    if (tailWords.slice(-k).join(" ").toLowerCase() === newWords.slice(0, k).join(" ").toLowerCase()) {
      overlap = k;
      break;
    }
  }

  const cleaned = overlap ? newWords.slice(overlap).join(" ") : newText;

  lastSysTail = (lastSysTail + " " + cleaned).split(" ").slice(-12).join(" ");
  return cleaned;
}

async function transcribeSys(blob, runId) {
  if (!isRunning || runId !== sysSeq) return;

  const fd = new FormData();
  fd.append("file", blob, "sys.webm");
  fd.append("prompt", WHISPER_BIAS_PROMPT);

  const res = await apiFetch("transcribe", { method: "POST", body: fd }, false);
  const data = await res.json().catch(() => ({}));

  let text = cleanSysText(data.text || "");
  if (!text) return;

  text = dedupeSystemText(text);
  if (!text) return;

  addToTimelineTypewriter(text);
}

//--------------------------------------------------------------
// Credits
//--------------------------------------------------------------
async function deductCredits(delta) {
  return apiFetch("user/deduct", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ delta })
  }).then(r => r.json());
}

function startCreditTicking() {
  lastCreditAt = Date.now();
  if (creditTimer) clearInterval(creditTimer);

  creditTimer = setInterval(async () => {
    if (!isRunning) return;

    const now = Date.now();
    const elapsed = Math.floor((now - lastCreditAt) / 1000);
    if (elapsed < CREDIT_BATCH_SEC) return;

    const batch = elapsed - (elapsed % CREDIT_BATCH_SEC);
    const delta = batch * CREDITS_PER_SEC;

    lastCreditAt += batch * 1000;

    const out = await deductCredits(delta);
    if (out.remaining <= 0) {
      stopAll();
      showBanner("Out of credits. Contact admin.");
      return;
    }
    await loadUserProfile();
  }, 500);
}

//--------------------------------------------------------------
// Chat
//--------------------------------------------------------------
function abortChatStreamOnly() {
  try { chatAbort?.abort(); } catch {}
  chatAbort = null;
  chatStreamActive = false;
}

function compactHistory() {
  return chatHistory.slice(-MAX_HISTORY_MESSAGES).map(m => ({
    role: m.role,
    content: m.content.slice(0, MAX_HISTORY_CHARS_EACH)
  }));
}

async function startChatStreaming(prompt) {
  abortChatStreamOnly();
  chatAbort = new AbortController();
  chatStreamActive = true;
  const mySeq = ++chatStreamSeq;

  responseBox.textContent = "";
  setStatus(sendStatus, "Sending…", "text-orange-600");

  chatHistory.push({ role: "user", content: prompt });

  const body = {
    prompt,
    history: compactHistory(),
    instructions: getEffectiveInstructions(),
    resumeText: resumeTextMem
  };

  let pending = "";
  let finalAnswer = "";

  const flush = () => {
    if (!pending) return;
    responseBox.textContent += pending;
    finalAnswer += pending;
    pending = "";
  };

  const res = await apiFetch("chat/send", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: chatAbort.signal
  }, false);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();

  const flushTimer = setInterval(() => {
    if (chatStreamActive && mySeq === chatStreamSeq) flush();
  }, 50);

  while (true) {
    const { done, value } = await reader.read();
    if (done || !chatStreamActive || mySeq !== chatStreamSeq) break;
    pending += decoder.decode(value);
  }

  clearInterval(flushTimer);
  flush();

  if (chatStreamActive && mySeq === chatStreamSeq) {
    setStatus(sendStatus, "Done", "text-green-600");
    chatHistory.push({ role: "assistant", content: finalAnswer });
  } else {
    setStatus(sendStatus, "Interrupted", "text-orange-600");
  }
}

//--------------------------------------------------------------
// START / STOP
//--------------------------------------------------------------
async function startAll() {
  if (isRunning) return;
  hideBanner();

  await apiFetch("chat/reset", { method: "POST" }, false);

  timeline = [];
  micInterimEntry = null;
  updateTranscript();

  isRunning = true;

  startBtn.disabled = true;
  stopBtn.disabled = false;
  sysBtn.disabled = false;
  sendBtn.disabled = false;

  startBtn.classList.add("opacity-50");
  stopBtn.classList.remove("opacity-50");
  sysBtn.classList.remove("opacity-50");
  sendBtn.classList.remove("opacity-60");

  const micOk = startMic();
  setStatus(audioStatus, micOk ? "Mic active" : "Mic unavailable", micOk ? "text-green-600" : "text-red-600");

  startCreditTicking();
}

function stopAll() {
  isRunning = false;

  stopMicOnly();
  stopSystemAudioOnly();

  startBtn.disabled = false;
  stopBtn.disabled = true;
  sysBtn.disabled = true;
  sendBtn.disabled = true;

  startBtn.classList.remove("opacity-50");
  stopBtn.classList.add("opacity-50");
  sysBtn.classList.add("opacity-50");
  sendBtn.classList.add("opacity-60");

  setStatus(audioStatus, "Stopped", "text-orange-600");

  clearInterval(creditTimer);
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
  micInterimEntry = null;
  promptBox.value = "";
  updateTranscript();

  await startChatStreaming(msg);
};

clearBtn.onclick = () => {
  timeline = [];
  micInterimEntry = null;
  promptBox.value = "";
  updateTranscript();
  setStatus(sendStatus, "Cleared", "text-green-600");
};

resetBtn.onclick = async () => {
  abortChatStreamOnly();
  responseBox.textContent = "";
  await apiFetch("chat/reset", { method: "POST" }, false);
  setStatus(sendStatus, "Response reset", "text-green-600");
};

//--------------------------------------------------------------
// PAGE LOAD
//--------------------------------------------------------------
window.addEventListener("load", async () => {
  session = JSON.parse(localStorage.getItem("session") || "null");
  if (!session) return (window.location.href = "/auth?tab=login");

  await loadUserProfile();
  await apiFetch("chat/reset", { method: "POST" }, false);

  instructionsBox.value = localStorage.getItem("instructions") || "";
  modeSelect.value = "general";

  stopBtn.disabled = true;
  sysBtn.disabled = true;
  sendBtn.disabled = true;

  stopBtn.classList.add("opacity-50");
  sysBtn.classList.add("opacity-50");
  sendBtn.classList.add("opacity-60");
});

//--------------------------------------------------------------
// LOGOUT
//--------------------------------------------------------------
document.getElementById("logoutBtn").onclick = () => {
  chatHistory = [];
  resumeTextMem = "";
  stopAll();
  localStorage.removeItem("session");
  window.location.href = "/auth?tab=login";
};

//--------------------------------------------------------------
// BUTTONS
//--------------------------------------------------------------
startBtn.onclick = startAll;
stopBtn.onclick = stopAll;
sysBtn.onclick = enableSystemAudio;
