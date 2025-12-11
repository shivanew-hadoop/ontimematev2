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
const modeSelect = document.getElementById("modeSelect");

//--------------------------------------------------------------
// STATE + HIDDEN MODE INSTRUCTIONS
//--------------------------------------------------------------
let session = null;
let isRunning = false;

let hiddenInstructions = ""; // Internal only (Option A)

//--------------------------------------------------------------
// INTERNAL MODE INSTRUCTIONS (Interview/Sales/General)
//--------------------------------------------------------------
const INTERNAL_MODE_INSTRUCTIONS = {
  general: "",

  interview: `
Always answer in two parts:

1) Quick Answer (Interview Style)
   - Short bullet points
   - Direct, no fluff
   - Use domain terminology based on the question
   - Highlight challenges, decisions, solutions

2) Real-Time Project Example
   - 2–4 bullets showing real scenario
   - Explain action taken and impact created

Question Expansion Rule:
If the user provides a short transcript, keyword, or fragment 
(e.g., 'Triggers in data warehouse', 'Page Object Model', 'Singleton pattern'),
automatically expand it into a complete interview-style question before answering.

Use formats such as:
- "What is ... ?"
- "How does ... work?"
- "How did you use ... in your project?"
- "Explain the role of ..."
- "What challenges arise when using ... ?"

Never answer a raw fragment directly. Always rewrite it into a proper question, 
then answer using Interview Mode.

Rules:
- No ChatGPT tone, no textbook definitions
- No repeating the question
- Use user's resume/project context when available
- For behavioral questions: fast STAR format
- For technical questions: identify core challenge + mitigation
`,

  sales: `
Give responses in a persuasive, human-friendly tone focusing on clarity and value.
Avoid jargon unless asked.
Use short, confident statements.
Include one short real-world customer scenario example.
`
};

//--------------------------------------------------------------
// APPLY MODE INSTRUCTIONS + UI BEHAVIOR
//--------------------------------------------------------------
function applyModeInstructions() {
  const mode = modeSelect.value;

  if (mode === "general") {
    hiddenInstructions = "";
    instructionsBox.removeAttribute("disabled");
    instructionsBox.value = localStorage.getItem("instructions") || "";
    instrStatus.textContent = "General mode active";
    instrStatus.className = "text-green-600";
  }

  if (mode === "interview") {
    hiddenInstructions = INTERNAL_MODE_INSTRUCTIONS.interview.trim();
    instructionsBox.value = "Interview mode instructions loaded";
    instructionsBox.setAttribute("disabled", "disabled");
    instrStatus.textContent = "Interview mode active";
    instrStatus.className = "text-green-600";
  }

  if (mode === "sales") {
    hiddenInstructions = INTERNAL_MODE_INSTRUCTIONS.sales.trim();
    instructionsBox.value = "Sales mode instructions loaded";
    instructionsBox.setAttribute("disabled", "disabled");
    instrStatus.textContent = "Sales mode active";
    instrStatus.className = "text-green-600";
  }

  setTimeout(() => (instrStatus.textContent = ""), 900);
}

modeSelect.addEventListener("change", applyModeInstructions);

//--------------------------------------------------------------
// EFFECTIVE INSTRUCTIONS SENT TO BACKEND
//--------------------------------------------------------------
function getEffectiveInstructions() {
  const mode = modeSelect.value;

  // Interview & Sales use hidden instructions only
  if (mode === "interview" || mode === "sales") {
    return hiddenInstructions;
  }

  // General mode uses user-defined custom instructions
  const live = (instructionsBox?.value || "").trim();
  if (live && !live.includes("mode instructions loaded")) return live;

  return (localStorage.getItem("instructions") || "").trim();
}

//--------------------------------------------------------------
// SAVE CUSTOM INSTRUCTIONS (General mode only)
//--------------------------------------------------------------
instructionsBox.value = localStorage.getItem("instructions") || "";

instructionsBox.addEventListener("input", () => {
  if (modeSelect.value !== "general") return;
  localStorage.setItem("instructions", instructionsBox.value);
  instrStatus.textContent = "Saved";
  instrStatus.className = "text-green-600";
  setTimeout(() => (instrStatus.textContent = ""), 600);
});

//--------------------------------------------------------------
// FIXED loadUserProfile() — SHOW USER + CREDITS + JOINED DATE
//--------------------------------------------------------------
async function loadUserProfile() {
  try {
    const res = await apiFetch("user/profile", {}, true);
    const data = await res.json().catch(() => ({}));

    if (!res.ok || !data?.user) {
      userInfo.innerHTML = `<span class='text-red-600 text-sm'>Unable to load profile</span>`;
      return;
    }

    const u = data.user;

    userInfo.innerHTML = `
      <div class="text-sm text-gray-800">
        <b>User:</b> ${u.email || "N/A"}<br>
        <b>Credits:</b> ${u.credits ?? 0}<br>
        <b>Joined:</b> ${u.created_ymd || ""}
      </div>
    `;
  } catch (err) {
    userInfo.innerHTML = `<span class='text-red-600 text-sm'>Error loading profile</span>`;
  }
}

//--------------------------------------------------------------
// REMAINING VARIABLES (UNCHANGED)
//--------------------------------------------------------------
let recognition = null;
let blockMicUntil = 0;
let micInterimEntry = null;

let sysStream = null;
let sysTrack = null;
let sysRecorder = null;
let sysSegmentChunks = [];
let sysSegmentTimer = null;
let sysQueue = [];
let sysAbort = null;
let sysInFlight = 0;

let timeline = [];
let creditTimer = null;
let lastCreditAt = 0;

let chatAbort = null;
let chatStreamActive = false;
let chatStreamSeq = 0;

let chatHistory = [];
const MAX_HISTORY_MESSAGES = 8;
const MAX_HISTORY_CHARS_EACH = 1500;

let resumeTextMem = "";
let lastSysTail = "";

const SYS_SEGMENT_MS = 2800;
const SYS_MIN_BYTES = 6000;
const SYS_MAX_CONCURRENT = 2;
const SYS_TYPE_MS_PER_WORD = 18;

const CREDIT_BATCH_SEC = 5;
const CREDITS_PER_SEC = 1;

const MIC_LANGS = ["en-IN", "en-GB", "en-US"];
let micLangIndex = 0;

//--------------------------------------------------------------
// HELPERS (UNCHANGED)
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

function addToTimelineTypewriter(txt, msPerWord = SYS_TYPE_MS_PER_WORD) {
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
  }, msPerWord);
}
//--------------------------------------------------------------
// TOKEN REFRESH — UNCHANGED
//--------------------------------------------------------------
function isTokenNearExpiry() {
  const exp = Number(session?.expires_at || 0);
  if (!exp) return false;
  const now = Math.floor(Date.now() / 1000);
  return exp - now < 60;
}

async function refreshAccessToken() {
  const refresh_token = session?.refresh_token;
  if (!refresh_token) throw new Error("Missing refresh_token. Please login again.");

  const res = await fetch("/api?path=auth/refresh", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refresh_token })
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Refresh failed");

  session.access_token = data.session.access_token;
  session.refresh_token = data.session.refresh_token;
  session.expires_at = data.session.expires_at;

  localStorage.setItem("session", JSON.stringify(session));
}

async function apiFetch(path, opts = {}, needAuth = true) {
  if (needAuth && isTokenNearExpiry()) {
    try { await refreshAccessToken(); } catch (e) { console.error(e); }
  }

  const headers = { ...(opts.headers || {}) };
  if (needAuth) Object.assign(headers, authHeaders());

  const res = await fetch(`/api?path=${encodeURIComponent(path)}`, { ...opts, headers });

  if (needAuth && res.status === 401) {
    const t = await res.text().catch(() => "");
    const looksExpired =
      t.includes("token is expired") ||
      t.includes("invalid JWT") ||
      t.includes("Missing token");

    if (looksExpired) {
      await refreshAccessToken();
      const headers2 = { ...(opts.headers || {}), ...authHeaders() };
      return fetch(`/api?path=${encodeURIComponent(path)}`, { ...opts, headers: headers2 });
    }
  }

  return res;
}

//--------------------------------------------------------------
// MIC — SpeechRecognition
//--------------------------------------------------------------
function stopMicOnly() {
  try { recognition?.stop(); } catch {}
  recognition = null;
  micInterimEntry = null;
}

function startMic() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    setStatus(audioStatus, "SpeechRecognition not supported.", "text-red-600");
    return false;
  }

  stopMicOnly();
  recognition = new SR();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = MIC_LANGS[micLangIndex] || "en-US";

  recognition.onresult = (ev) => {
    if (!isRunning) return;
    if (Date.now() < blockMicUntil) return;

    let latestInterim = "";

    for (let i = ev.resultIndex; i < ev.results.length; i++) {
      const r = ev.results[i];
      const text = normalize(r[0].transcript || "");

      if (r.isFinal) {
        if (micInterimEntry) {
          const idx = timeline.indexOf(micInterimEntry);
          if (idx >= 0) timeline.splice(idx, 1);
          micInterimEntry = null;
        }
        addToTimeline(text);
      } else {
        latestInterim = text;
      }
    }

    if (latestInterim) {
      if (!micInterimEntry) {
        micInterimEntry = { t: Date.now(), text: latestInterim };
        timeline.push(micInterimEntry);
      } else {
        micInterimEntry.text = latestInterim;
      }
      updateTranscript();
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
// SYSTEM AUDIO — MediaRecorder + Segments
//--------------------------------------------------------------
function pickBestMimeType() {
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
    "audio/ogg"
  ];
  for (const t of candidates) {
    if (MediaRecorder.isTypeSupported(t)) return t;
  }
  return "";
}

function stopSystemAudioOnly() {
  try { sysAbort?.abort(); } catch {}
  sysAbort = null;

  if (sysSegmentTimer) clearInterval(sysSegmentTimer);
  sysSegmentTimer = null;

  try { sysRecorder?.stop(); } catch {}
  sysRecorder = null;

  sysSegmentChunks = [];
  sysQueue = [];
  sysInFlight = 0;

  if (sysStream) {
    try { sysStream.getTracks().forEach(t => t.stop()); } catch {}
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
  } catch {
    setStatus(audioStatus, "Share audio denied.", "text-red-600");
    return;
  }

  sysTrack = sysStream.getAudioTracks()[0];
  if (!sysTrack) {
    setStatus(audioStatus, "No system audio detected.", "text-red-600");
    stopSystemAudioOnly();
    return;
  }

  sysAbort = new AbortController();
  startSystemSegmentRecorder();
  setStatus(audioStatus, "System audio enabled.", "text-green-600");
}

function startSystemSegmentRecorder() {
  if (!sysTrack) return;

  const audioOnly = new MediaStream([sysTrack]);
  const mime = pickBestMimeType();

  sysSegmentChunks = [];

  try {
    sysRecorder = new MediaRecorder(audioOnly, mime ? { mimeType: mime } : undefined);
  } catch {
    setStatus(audioStatus, "System audio start failed.", "text-red-600");
    return;
  }

  sysRecorder.ondataavailable = (ev) => {
    if (!isRunning) return;
    if (ev.data.size) sysSegmentChunks.push(ev.data);
  };

  sysRecorder.onstop = () => {
    if (!isRunning) return;

    const blob = new Blob(sysSegmentChunks, { type: sysRecorder?.mimeType || "" });
    sysSegmentChunks = [];

    if (blob.size >= SYS_MIN_BYTES) {
      sysQueue.push(blob);
      drainSysQueue();
    }

    if (isRunning && sysTrack.readyState === "live") startSystemSegmentRecorder();
  };

  try { sysRecorder.start(); } catch {}

  if (sysSegmentTimer) clearInterval(sysSegmentTimer);

  sysSegmentTimer = setInterval(() => {
    if (!isRunning) return;
    try { sysRecorder?.stop(); } catch {}
  }, SYS_SEGMENT_MS);
}

function drainSysQueue() {
  if (!isRunning) return;

  while (sysInFlight < SYS_MAX_CONCURRENT && sysQueue.length) {
    const blob = sysQueue.shift();
    sysInFlight++;

    transcribeSysBlob(blob)
      .catch(err => console.error("sys transcribe error", err))
      .finally(() => {
        sysInFlight--;
        drainSysQueue();
      });
  }
}

//--------------------------------------------------------------
// SYSTEM AUDIO — Deduping + Hallucination Filter
//--------------------------------------------------------------
function dedupeSystemText(text) {
  const t = normalize(text);
  if (!t) return "";

  if (t.length <= 180 && lastSysTail && lastSysTail.toLowerCase().includes(t.toLowerCase())) {
    return "";
  }

  const tail = lastSysTail || "";
  if (!tail) {
    lastSysTail = t.split(" ").slice(-12).join(" ");
    return t;
  }

  const tailWords = tail.split(" ");
  const newWords = t.split(" ");

  let bestMatch = 0;
  const maxCheck = Math.min(10, tailWords.length, newWords.length);

  for (let k = maxCheck; k >= 3; k--) {
    const endTail = tailWords.slice(-k).join(" ").toLowerCase();
    const startNew = newWords.slice(0, k).join(" ").toLowerCase();
    if (endTail === startNew) {
      bestMatch = k;
      break;
    }
  }

  const cleaned = bestMatch ? newWords.slice(bestMatch).join(" ") : t;
  lastSysTail = (tail + " " + cleaned).trim().split(" ").slice(-12).join(" ");
  return normalize(cleaned);
}

function looksLikeWhisperHallucination(t) {
  const s = normalize(t).toLowerCase();
  if (!s) return true;

  const noise = [
    "thanks for watching",
    "thank you for watching",
    "subscribe",
    "i'm sorry",
    "i am sorry",
    "please like and subscribe",
    "transcribe clearly in english",
    "keep proper nouns and numbers",
    "handle indian",
    "i don't know",
    "i dont know"
  ];

  if (s.length < 40 && (s.endsWith("i don't know.") || s.endsWith("i dont know"))) {
    return true;
  }

  return noise.some(p => s.includes(p));
}

//--------------------------------------------------------------
// TRANSCRIBE BLOB → Whisper Endpoint
//--------------------------------------------------------------
async function transcribeSysBlob(blob) {
  const fd = new FormData();
  const type = (blob.type || "").toLowerCase();
  const ext = type.includes("ogg") ? "ogg" : "webm";

  fd.append("file", blob, `sys.${ext}`);

  const res = await apiFetch("transcribe", {
    method: "POST",
    body: fd,
    signal: sysAbort?.signal
  }, false);

  if (!res.ok) return;

  const data = await res.json().catch(() => ({}));
  const raw = String(data.text || "");

  if (looksLikeWhisperHallucination(raw)) return;

  const cleaned = dedupeSystemText(raw);
  if (cleaned) addToTimelineTypewriter(cleaned);
}

//--------------------------------------------------------------
// CREDITS — Already auto-refreshes every 5 seconds
//--------------------------------------------------------------
async function deductCredits(delta) {
  const res = await apiFetch("user/deduct", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ delta })
  }, true);

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Deduct failed");
  return data;
}

function startCreditTicking() {
  if (creditTimer) clearInterval(creditTimer);
  lastCreditAt = Date.now();

  creditTimer = setInterval(async () => {
    if (!isRunning) return;

    const now = Date.now();
    const sec = Math.floor((now - lastCreditAt) / 1000);
    if (sec < CREDIT_BATCH_SEC) return;

    const billableSec = sec - (sec % CREDIT_BATCH_SEC);
    const delta = billableSec * CREDITS_PER_SEC;

    lastCreditAt += billableSec * 1000;

    try {
      const out = await deductCredits(delta);
      if (out.remaining <= 0) {
        stopAll();
        showBanner("No credits remaining.");
        return;
      }

      // refresh UI credits every 5 sec
      await loadUserProfile();

    } catch (err) {
      console.error(err);
    }
  }, 500);
}
//--------------------------------------------------------------
// CHAT STREAMING — UNCHANGED LOGIC
//--------------------------------------------------------------
function abortChatStreamOnly() {
  try { chatAbort?.abort(); } catch {}
  chatAbort = null;
  chatStreamActive = false;
}

function pushHistory(role, content) {
  const c = normalize(content);
  if (!c) return;
  chatHistory.push({ role, content: c });
  if (chatHistory.length > 50) chatHistory.splice(0, chatHistory.length - 50);
}

function compactHistoryForRequest() {
  return chatHistory.slice(-MAX_HISTORY_MESSAGES).map(m => ({
    role: m.role,
    content: String(m.content || "").slice(0, MAX_HISTORY_CHARS_EACH)
  }));
}

async function startChatStreaming(prompt) {
  abortChatStreamOnly();

  chatAbort = new AbortController();
  chatStreamActive = true;
  const mySeq = ++chatStreamSeq;

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
  let flushTimer = null;

  const flush = () => {
    if (!pending) return;
    responseBox.textContent += pending;
    finalAnswer += pending;
    pending = "";
  };

  try {
    const res = await apiFetch("chat/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: chatAbort.signal
    }, false);

    if (!res.ok) throw new Error(await res.text());

    const reader = res.body.getReader();
    const decoder = new TextDecoder();

    flushTimer = setInterval(() => {
      if (!chatStreamActive || mySeq !== chatStreamSeq) return;
      flush();
    }, 40);

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!chatStreamActive || mySeq !== chatStreamSeq) break;
      pending += decoder.decode(value);
    }

    if (chatStreamActive && mySeq === chatStreamSeq) {
      flush();
      setStatus(sendStatus, "Done", "text-green-600");
      pushHistory("assistant", finalAnswer);
    }

  } catch (e) {
    setStatus(sendStatus, "Failed", "text-red-600");
  } finally {
    if (flushTimer) clearInterval(flushTimer);
  }
}

//--------------------------------------------------------------
// START / STOP LOGIC
//--------------------------------------------------------------
async function startAll() {
  hideBanner();
  if (isRunning) return;

  await apiFetch("chat/reset", { method: "POST" }, false).catch(() => {});

  timeline = [];
  micInterimEntry = null;
  updateTranscript();

  isRunning = true;

  startBtn.disabled = true;
  stopBtn.disabled = false;
  sysBtn.disabled = false;
  sendBtn.disabled = false;

  stopBtn.classList.remove("opacity-50");
  sysBtn.classList.remove("opacity-50");
  sendBtn.classList.remove("opacity-60");

  const micOk = startMic();
  if (!micOk) {
    setStatus(audioStatus, "Mic not available.", "text-orange-600");
  } else {
    setStatus(audioStatus, "Mic active. System audio optional.", "text-green-600");
  }

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

  stopBtn.classList.add("opacity-50");
  sysBtn.classList.add("opacity-50");
  sendBtn.classList.add("opacity-60");

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
  setStatus(sendStatus, "Transcript cleared", "text-green-600");
};

resetBtn.onclick = async () => {
  abortChatStreamOnly();
  responseBox.textContent = "";
  setStatus(sendStatus, "Response reset", "text-green-600");
  await apiFetch("chat/reset", { method: "POST" }, false).catch(() => {});
};

//--------------------------------------------------------------
// RESUME UPLOAD — UNCHANGED
//--------------------------------------------------------------
resumeInput?.addEventListener("change", async () => {
  const file = resumeInput.files?.[0];
  if (!file) return;

  resumeStatus.textContent = "Processing…";

  const fd = new FormData();
  fd.append("file", file);

  const res = await apiFetch("resume/extract", { method: "POST", body: fd }, false);
  const data = await res.json().catch(() => ({}));

  resumeTextMem = String(data.text || "").trim();

  if (!resumeTextMem) {
    resumeStatus.textContent = "Resume extracted: empty";
  } else if (resumeTextMem.startsWith("[Resume upload received")) {
    resumeStatus.textContent = resumeTextMem;
  } else {
    resumeStatus.textContent = `Resume extracted (${resumeTextMem.length} chars)`;
  }
});

//--------------------------------------------------------------
// LOGOUT BUTTON
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
// PAGE LOAD INITIALIZER
//--------------------------------------------------------------
window.addEventListener("load", async () => {
  session = JSON.parse(localStorage.getItem("session") || "null");

  // No session → go to login
  if (!session) return (window.location.href = "/auth?tab=login");

  // Missing refresh_token (old sessions)
  if (!session.refresh_token) {
    localStorage.removeItem("session");
    return (window.location.href = "/auth?tab=login");
  }

  chatHistory = [];
  resumeTextMem = "";
  if (resumeStatus) resumeStatus.textContent = "Resume cleared.";

  // Load profile (credits, email, joined date)
  await loadUserProfile();

  // Clear chat history on backend
  await apiFetch("chat/reset", { method: "POST" }, false).catch(() => {});

  // Reset transcript UI
  timeline = [];
  micInterimEntry = null;
  updateTranscript();

  // Disable buttons until start
  stopBtn.disabled = true;
  sysBtn.disabled = true;
  sendBtn.disabled = true;

  stopBtn.classList.add("opacity-50");
  sysBtn.classList.add("opacity-50");
  sendBtn.classList.add("opacity-60");
});

//--------------------------------------------------------------
// BUTTON BINDINGS
//--------------------------------------------------------------
startBtn.onclick = startAll;
stopBtn.onclick = stopAll;
sysBtn.onclick = enableSystemAudio;
