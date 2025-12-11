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
const modeSelect = document.getElementById("modeSelect");   // NEW

//--------------------------------------------------------------
// STATE
//--------------------------------------------------------------
let session = null;
let isRunning = false;

// MIC
let recognition = null;
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

// transcript timeline
let timeline = [];

// credits
let creditTimer = null;
let lastCreditAt = 0;

// chat stream
let chatAbort = null;
let chatStreamActive = false;
let chatStreamSeq = 0;

// in-session memory
let chatHistory = [];
const MAX_HISTORY_MESSAGES = 8;
const MAX_HISTORY_CHARS_EACH = 1500;

// resume memory
let resumeTextMem = "";

// system dedupe tail
let lastSysTail = "";

//--------------------------------------------------------------
// CONFIG
//--------------------------------------------------------------
const SYS_SEGMENT_MS = 2800;
const SYS_MIN_BYTES = 6000;
const SYS_MAX_CONCURRENT = 2;
const SYS_TYPE_MS_PER_WORD = 18;

const CREDIT_BATCH_SEC = 5;
const CREDITS_PER_SEC = 1;

const MIC_LANGS = ["en-IN", "en-GB", "en-US"];
let micLangIndex = 0;

const WHISPER_BIAS_PROMPT =
  "Transcribe clearly in English. Handle Indian, British, Australian, and American accents. Keep proper nouns and numbers.";

//--------------------------------------------------------------
// MODE-SPECIFIC INSTRUCTIONS  (NEW)
//--------------------------------------------------------------
// const MODE_INSTRUCTIONS = {
//   general: `Give responses in a clear human tone. Avoid textbook definitions. Provide practical, real-world clarity.`,
  
//   interview: `Give responses in human conversational tone. Prioritize real project examples. Avoid ChatGPT style, avoid textbook definitions, avoid fluff. Be crisp, confident, structured. If asked technical concepts, explain using practical industry examples.`,
  
//   sales: `Respond in a friendly human tone. Focus on problem-solving, value, storytelling, and persuasion. Do not sound like AI. Keep sentences short and confident.`
// };

const MODE_INSTRUCTIONS = {
  general: `
Give responses in a clear human tone. Avoid textbook definitions.
Keep answers practical and grounded in real-world clarity.
`,

  interview: `
Always answer in two parts:

1) Quick Answer (Interview Style)
- Bullet points only
- Short, direct, no fluff
- Use domain terminology based on the question
- Highlight challenges, decisions, and solutions

2) Real-Time Project Example
- 2–4 bullets
- Practical scenario of how this applies in real work
- Focus on action taken and impact created

Rules:
- No ChatGPT-style generic explanations
- No intros, no conclusions, no sugar-coating
- No repeating the question
- Always sound like a candidate answering instantly
- Blend user's resume/project details when provided
- For behavioral questions, use fast STAR in bullets
- For technical questions, identify core challenge + mitigation
`
};


function getModeInstructions() {
  return MODE_INSTRUCTIONS[modeSelect.value] || MODE_INSTRUCTIONS.general;
}

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
  el.textContent = text;
  el.className = cls;
}
function normalize(s) {
  return (s || "").replace(/\s+/g, " ").trim();
}
function authHeaders() {
  const token = session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
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

// typewriter for system audio
function addToTimelineTypewriter(txt, msPerWord = SYS_TYPE_MS_PER_WORD) {
  const cleaned = normalize(txt);
  if (!cleaned) return;

  const entry = { t: Date.now(), text: "" };
  timeline.push(entry);

  const words = cleaned.split(" ");
  let i = 0;

  const timer = setInterval(() => {
    if (!isRunning) { clearInterval(timer); return; }
    if (i >= words.length) { clearInterval(timer); return; }
    entry.text += (entry.text ? " " : "") + words[i++];
    updateTranscript();
  }, msPerWord);
}

//--------------------------------------------------------------
// TOKEN REFRESH
//--------------------------------------------------------------
function isTokenNearExpiry() {
  const exp = Number(session?.expires_at || 0);
  const now = Math.floor(Date.now() / 1000);
  return exp && (exp - now < 60);
}

async function refreshAccessToken() {
  const refresh_token = session?.refresh_token;
  if (!refresh_token) return;

  const res = await fetch("/api?path=auth/refresh", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refresh_token })
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) return;

  session.access_token = data.session.access_token;
  session.refresh_token = data.session.refresh_token;
  session.expires_at = data.session.expires_at;

  localStorage.setItem("session", JSON.stringify(session));
}

async function apiFetch(path, opts = {}, needAuth = true) {
  if (needAuth && isTokenNearExpiry()) {
    await refreshAccessToken().catch(() => {});
  }

  const headers = { ...(opts.headers || {}) };
  if (needAuth) Object.assign(headers, authHeaders());

  return fetch(`/api?path=${encodeURIComponent(path)}`, {
    ...opts,
    headers
  });
}

//--------------------------------------------------------------
// Load User Profile
//--------------------------------------------------------------
async function loadUserProfile() {
  const res = await apiFetch("user/profile", {}, true);
  const data = await res.json().catch(() => ({}));

  userInfo.innerHTML =
    `Logged in as <b>${data.user.email}</b><br>` +
    `Credits: <b>${data.user.credits}</b><br>` +
    `Joined: ${data.user.created_ymd}`;
}

//--------------------------------------------------------------
// INSTRUCTIONS — with MODE SUPPORT
//--------------------------------------------------------------
instructionsBox.value = localStorage.getItem("instructions") || "";

instructionsBox.addEventListener("input", () => {
  localStorage.setItem("instructions", instructionsBox.value);
  instrStatus.textContent = "Saved";
  instrStatus.className = "text-green-600";
  setTimeout(() => instrStatus.textContent = "", 700);
});

// NEW — auto apply mode rules
modeSelect.addEventListener("change", () => {
  const baseInstr = getModeInstructions();
  let existing = instructionsBox.value || "";

  // remove old mode instructions
  Object.values(MODE_INSTRUCTIONS).forEach(m => {
    existing = existing.replace(m, "").trim();
  });

  const final = baseInstr + "\n" + existing;
  instructionsBox.value = final;
  localStorage.setItem("instructions", final);

  instrStatus.textContent = "Mode applied";
  instrStatus.className = "text-green-600";
  setTimeout(() => instrStatus.textContent = "", 700);
});

function getEffectiveInstructions() {
  return (instructionsBox.value || "").trim();
}

//--------------------------------------------------------------
// Resume Upload
//--------------------------------------------------------------
resumeInput?.addEventListener("change", async () => {
  const file = resumeInput.files?.[0];
  if (!file) return;

  resumeStatus.textContent = "Processing…";

  const fd = new FormData();
  fd.append("file", file);

  const res = await apiFetch("resume/extract", { method: "POST", body: fd }, false);
  const data = await res.json().catch(() => ({}));

  resumeTextMem = (data.text || "").trim();

  if (!resumeTextMem) resumeStatus.textContent = "Resume extracted: empty";
  else resumeStatus.textContent = `Resume extracted (${resumeTextMem.length} chars)`;
});

//--------------------------------------------------------------
// MIC
//--------------------------------------------------------------
function stopMicOnly() { try { recognition?.stop(); } catch{} }

function startMic() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    setStatus(audioStatus, "SpeechRecognition not supported", "text-red-600");
    return false;
  }

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
      if (r.isFinal) addToTimeline(text);
      else interim = text;
    }

    if (interim) {
      const base = timeline.map(t => t.text).join(" ");
      promptBox.value = (base + " " + interim).trim();
    }
  };

  recognition.onerror = () => {
    micLangIndex = (micLangIndex + 1) % MIC_LANGS.length;
  };

  recognition.onend = () => {
    if (!isRunning) return;
    try { recognition.start(); } catch {}
  };

  try { recognition.start(); } catch {}
  return true;
}

//--------------------------------------------------------------
// SYSTEM AUDIO
//--------------------------------------------------------------
function pickBestMimeType() {
  const c = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
    "audio/ogg"
  ];
  return c.find(t => MediaRecorder.isTypeSupported(t)) || "";
}

function stopSystemAudioOnly() {
  try { sysAbort?.abort(); } catch {}
  sysAbort = null;

  if (sysSegmentTimer) clearInterval(sysSegmentTimer);
  sysSegmentTimer = null;

  try { sysRecorder?.stop(); } catch{}
  sysRecorder = null;

  sysSegmentChunks = [];
  sysQueue = [];
  sysInFlight = 0;

  if (sysStream) {
    try { sysStream.getTracks().forEach(t => t.stop()); } catch{}
  }
  sysStream = null;
  sysTrack = null;
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
  } catch (e) {
    setStatus(audioStatus, "System audio denied", "text-red-600");
    return;
  }

  sysTrack = sysStream.getAudioTracks()[0];
  if (!sysTrack) {
    setStatus(audioStatus, "No system audio found", "text-red-600");
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
    setStatus(audioStatus, "MediaRecorder failed", "text-red-600");
    return;
  }

  sysRecorder.ondataavailable = e => {
    if (!isRunning) return;
    if (e.data?.size) sysSegmentChunks.push(e.data);
  };

  sysRecorder.onstop = () => {
    if (!isRunning) return;

    const blob = new Blob(sysSegmentChunks, { type: sysRecorder.mimeType });
    sysSegmentChunks = [];

    if (blob.size >= SYS_MIN_BYTES) {
      sysQueue.push(blob);
      drainSysQueue();
    }

    if (isRunning && sysTrack && sysTrack.readyState === "live") {
      startSystemSegmentRecorder();
    }
  };

  try { sysRecorder.start(); } catch (e) {
    console.error(e);
    return;
  }

  if (sysSegmentTimer) clearInterval(sysSegmentTimer);
  sysSegmentTimer = setInterval(() => {
    try { sysRecorder?.stop(); } catch{}
  }, SYS_SEGMENT_MS);
}

function drainSysQueue() {
  if (!isRunning) return;

  while (sysInFlight < SYS_MAX_CONCURRENT && sysQueue.length) {
    const blob = sysQueue.shift();
    sysInFlight++;

    transcribeSysBlob(blob)
      .finally(() => {
        sysInFlight--;
        drainSysQueue();
      });
  }
}

function dedupeSystemText(txt) {
  const t = normalize(txt);
  if (!t) return "";

  if (!lastSysTail) {
    lastSysTail = t.split(" ").slice(-12).join(" ");
    return t;
  }

  const tailWords = lastSysTail.split(" ");
  const newWords = t.split(" ");
  let best = 0;

  for (let k = Math.min(10, tailWords.length, newWords.length); k >= 3; k--) {
    const tailPart = tailWords.slice(-k).join(" ").toLowerCase();
    const newPart = newWords.slice(0, k).join(" ").toLowerCase();
    if (tailPart === newPart) { best = k; break; }
  }

  const cleaned = best ? newWords.slice(best).join(" ") : t;
  const merged = (lastSysTail + " " + cleaned).trim();
  lastSysTail = merged.split(" ").slice(-12).join(" ");

  return normalize(cleaned);
}

async function transcribeSysBlob(blob) {
  const fd = new FormData();
  const type = (blob.type || "").toLowerCase();
  fd.append("file", blob, type.includes("ogg") ? "sys.ogg" : "sys.webm");
  fd.append("prompt", WHISPER_BIAS_PROMPT);

  const res = await apiFetch("transcribe", { method: "POST", body: fd }, false);
  if (!res.ok) return;

  const data = await res.json().catch(() => ({}));
  const raw = (data.text || "").trim();

  const bad = ["i can't wait to see you", "unable to transcribe", "subscribe"];
  const s = raw.toLowerCase();
  if (!raw || bad.some(b => s.includes(b))) return;

  const cleaned = dedupeSystemText(raw);
  if (cleaned) addToTimelineTypewriter(cleaned);
}

//--------------------------------------------------------------
// Credits
//--------------------------------------------------------------
async function deductCredits(delta) {
  const res = await apiFetch(
    "user/deduct",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ delta })
    },
    true
  );

  const data = await res.json();
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

    const batch = elapsedSec - (elapsedSec % CREDIT_BATCH_SEC);
    const delta = batch * CREDITS_PER_SEC;
    lastCreditAt += batch * 1000;

    try {
      const out = await deductCredits(delta);
      if (out.remaining <= 0) {
        stopAll();
        showBanner("No more credits left.");
        return;
      }
      await loadUserProfile();
    } catch (e) {
      console.error(e);
    }
  }, 500);
}

//--------------------------------------------------------------
// Chat Streaming
//--------------------------------------------------------------
function abortChatStreamOnly() {
  try { chatAbort?.abort(); } catch{}
  chatStreamActive = false;
}

function pushHistory(role, content) {
  const c = normalize(content);
  if (!c) return;

  chatHistory.push({ role, content: c });
  if (chatHistory.length > 50) chatHistory = chatHistory.slice(-50);
}

function compactHistoryForRequest() {
  return chatHistory.slice(-MAX_HISTORY_MESSAGES).map(m => ({
    role: m.role,
    content: String(m.content).slice(0, MAX_HISTORY_CHARS_EACH)
  }));
}

async function startChatStreaming(prompt) {
  abortChatStreamOnly();

  chatAbort = new AbortController();
  chatStreamActive = true;
  const seq = ++chatStreamSeq;

  responseBox.textContent = "";
  setStatus(sendStatus, "Sending…", "text-orange-600");

  pushHistory("user", prompt);

  const body = {
    prompt,
    history: compactHistoryForRequest(),
    instructions: getEffectiveInstructions(),
    resumeText: resumeTextMem || ""
  };

  let pending = "";
  let finalAnswer = "";

  const flush = () => {
    if (pending) {
      responseBox.textContent += pending;
      finalAnswer += pending;
      pending = "";
    }
  };

  try {
    const res = await apiFetch("chat/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: chatAbort.signal
    }, false);

    if (!res.ok) {
      setStatus(sendStatus, "Failed", "text-red-600");
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();

    const flushTimer = setInterval(() => {
      if (chatStreamActive && seq === chatStreamSeq) flush();
    }, 40);

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!chatStreamActive || seq !== chatStreamSeq) break;
      pending += decoder.decode(value);
    }

    clearInterval(flushTimer);
    flush();
    pushHistory("assistant", finalAnswer);
    setStatus(sendStatus, "Done", "text-green-600");

  } catch (e) {
    setStatus(sendStatus, "Interrupted", "text-orange-600");
  }
}

//--------------------------------------------------------------
// START / STOP
//--------------------------------------------------------------
async function startAll() {
  hideBanner();
  if (isRunning) return;

  await apiFetch("chat/reset", { method: "POST" }, false).catch(() => {});

  timeline = [];
  updateTranscript();

  isRunning = true;

  startBtn.disabled = true;
  stopBtn.disabled = false;
  sysBtn.disabled = false;
  sendBtn.disabled = false;

  micLangIndex = 0;
  const ok = startMic();
  if (!ok) setStatus(audioStatus, "Mic unavailable", "text-orange-600");
  else setStatus(audioStatus, "Mic active. System audio optional.", "text-green-600");

  startCreditTicking();
}

function stopAll() {
  isRunning = false;

  stopMicOnly();
  stopSystemAudioOnly();

  if (creditTimer) clearInterval(creditTimer);

  startBtn.disabled = false;
  stopBtn.disabled = true;
  sysBtn.disabled = true;
  sendBtn.disabled = true;

  setStatus(audioStatus, "Stopped", "text-orange-600");
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
  promptBox.value = "";
  updateTranscript();

  await startChatStreaming(msg);
};

clearBtn.onclick = () => {
  timeline = [];
  promptBox.value = "";
  updateTranscript();
  setStatus(sendStatus, "Transcript cleared", "text-green-600");
};

resetBtn.onclick = async () => {
  abortChatStreamOnly();
  responseBox.textContent = "";
  await apiFetch("chat/reset", { method: "POST" }, false);
  setStatus(sendStatus, "Response reset", "text-green-600");
};

//--------------------------------------------------------------
// LOGOUT
//--------------------------------------------------------------
document.getElementById("logoutBtn").onclick = () => {
  chatHistory = [];
  resumeTextMem = "";
  abortChatStreamOnly();
  stopAll();
  localStorage.removeItem("session");
  window.location.href = "/auth?tab=login";
};

//--------------------------------------------------------------
// PAGE LOAD
//--------------------------------------------------------------
window.addEventListener("load", async () => {
  session = JSON.parse(localStorage.getItem("session") || "null");
  if (!session) return (window.location.href = "/auth?tab=login");

  if (!session.refresh_token) {
    localStorage.removeItem("session");
    return (window.location.href = "/auth?tab=login");
  }

  chatHistory = [];
  resumeTextMem = "";
  if (resumeStatus) resumeStatus.textContent = "Resume cleared (refresh).";

  await loadUserProfile();
  await apiFetch("chat/reset", { method: "POST" }, false);

  timeline = [];
  updateTranscript();

  stopBtn.disabled = true;
  sysBtn.disabled = true;
  sendBtn.disabled = true;

  // NEW — apply mode instructions on load
  modeSelect.dispatchEvent(new Event("change"));
});

//--------------------------------------------------------------
// Bind Buttons
//--------------------------------------------------------------
startBtn.onclick = startAll;
stopBtn.onclick = stopAll;

// VERY IMPORTANT — direct user gesture for window picker
sysBtn.onclick = () => enableSystemAudio();
