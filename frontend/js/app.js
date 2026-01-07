//--------------------------------------------------------------
// MARKDOWN → HTML (stream-safe bold + spacing fix)
//--------------------------------------------------------------
function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function fixSpacingOutsideCodeBlocks(text) {
  if (!text) return "";
  const parts = String(text).split("```");
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 1) continue;
    parts[i] = parts[i]
      .replace(/([,.;:!?])([A-Za-z0-9])/g, "$1 $2")
      .replace(/([\)\]])([A-Za-z0-9])/g, "$1 $2")
      .replace(/[ \t]{2,}/g, " ")
      .replace(/(\S)(\?|\!|\.)(\S)/g, "$1$2 $3");
  }
  return parts.join("```");
}

function renderMarkdown(md) {
  if (!md) return "";
  let safe = String(md).replace(/<br\s*\/?>/gi, "\n");
  safe = fixSpacingOutsideCodeBlocks(safe);
  safe = escapeHtml(safe);
  safe = safe.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
  safe = safe
    .replace(/\r\n/g, "\n")
    .replace(/\n\s*\n/g, "<br><br>")
    .replace(/\n/g, "<br>");
  return safe.trim();
}

//--------------------------------------------------------------
// DOM
//--------------------------------------------------------------
const userInfo = document.getElementById("userInfo");
const instructionsBox = document.getElementById("instructionsBox");
const instrStatus = document.getElementById("instrStatus");
const resumeInput = document.getElementById("resumeInput");
const resumeStatus = document.getElementById("resumeStatus");

const liveTranscript = document.getElementById("liveTranscript");
const manualQuestion = document.getElementById("manualQuestion");

const responseBox = document.getElementById("responseBox");
const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const sysBtn = document.getElementById("sysBtn");
const micBtn = document.getElementById("micBtn"); // Mic toggle
const clearBtn = document.getElementById("clearBtn");
const resetBtn = document.getElementById("resetBtn");
const audioStatus = document.getElementById("audioStatus");
const sendBtn = document.getElementById("sendBtn");
const sendStatus = document.getElementById("sendStatus");
const bannerTop = document.getElementById("bannerTop");
const modeSelect = document.getElementById("modeSelect");

//--------------------------------------------------------------
// SESSION + STATE
//--------------------------------------------------------------
let session = null;
let isRunning = false;

let hiddenInstructions = "";

// Mic toggle (OFF by default)
let micEnabled = false;

// SpeechRecognition (fastest live words)
let recognition = null;
let blockMicUntil = 0;
let micInterimEntry = null;
let lastMicResultAt = 0;
let micWatchdog = null;

// Mic fallback (MediaRecorder -> /transcribe) if SR doesn’t produce results
let micStream = null;
let micTrack = null;
let micRecorder = null;
let micSegmentChunks = [];
let micSegmentTimer = null;
let micQueue = [];
let micAbort = null;
let micInFlight = 0;

// System audio
let sysStream = null;
let sysTrack = null;
let sysRecorder = null;
let sysSegmentChunks = [];
let sysSegmentTimer = null;
let sysQueue = [];
let sysAbort = null;
let sysInFlight = 0;

let sysErrCount = 0;
let sysErrBackoffUntil = 0;

// DEDUPE STATE (separate mic vs system)
let lastSysTail = "";
let lastMicTail = "";

// final-level dedupe across pipelines
let lastFinalText = "";
let lastFinalAt = 0;

// Transcript blocks
let timeline = [];
let lastSpeechAt = 0;

// Stable cursoring
let timelineSeq = 0;
let sentSeq = 0;

// “pin to top” behavior
let pinnedTop = true;

// Credits
let creditTimer = null;
let lastCreditAt = 0;

// Chat streaming
let chatAbort = null;
let chatStreamActive = false;
let chatStreamSeq = 0;

let chatHistory = [];
let resumeTextMem = "";

// HARD CLEAR TOKEN (ignore late transcribe responses)
let transcriptEpoch = 0;

//--------------------------------------------------------------
// STREAMING ASR (Realtime)
//--------------------------------------------------------------
const USE_STREAMING_ASR_SYS = true;     // system audio -> realtime transcription
const USE_STREAMING_ASR_MIC_FALLBACK = true; // if SpeechRecognition missing/weak -> realtime transcription

const REALTIME_INTENT_URL = "wss://api.openai.com/v1/realtime?intent=transcription";
const REALTIME_ASR_MODEL = "gpt-4o-mini-transcribe";

// audio frames cadence
const ASR_SEND_EVERY_MS = 40;
const ASR_TARGET_RATE = 24000;

let realtimeSecretCache = null; // { value, expires_at }

// sessions
let micAsr = null;
let sysAsr = null;

// SYSTEM streaming behavior
const SYS_ASR_MANUAL_COMMIT = true;
const SYS_ASR_COMMIT_EVERY_MS = 450;
const SYS_ASR_MIN_VOICED_MS = 160;

// CRITICAL FIX: Gate commits by voice energy (prevents garbage output)
const SYS_RMS_THRESHOLD = 0.007; // tune 0.005–0.012 if needed
const SYS_SILENCE_CLEAR_MS = 1600; // if mostly silence for this long -> clear buffer (no commit)

// safer prompt for MIC only; SYSTEM uses no prompt to reduce leakage
const REALTIME_TRANSCRIBE_PROMPT = "Verbatim transcript. No added words. No translation.";

// boilerplate/leak phrases
const DROP_TRANSCRIPT_PHRASES = [
  "additional context/instructions",
  "you will receive additional context",
  "transcribe exactly",
  "do not translate",
  "system prompt",
  "developer message",
  "assistant:",
  "user:",
  "instructions:"
];

//--------------------------------------------------------------
// CONSTANTS
//--------------------------------------------------------------
const PAUSE_NEWLINE_MS = 3000;

// Mic fallback chunking (legacy)
const MIC_SEGMENT_MS = 1200;
const MIC_MIN_BYTES = 1800;
const MIC_MAX_CONCURRENT = 2;

const SYS_SEGMENT_MS = 2800;
const SYS_MIN_BYTES = 6000;
const SYS_MAX_CONCURRENT = 2;
const SYS_TYPE_MS_PER_WORD = 18;

const SYS_ERR_MAX = 3;
const SYS_ERR_BACKOFF_MS = 10000;

const CREDIT_BATCH_SEC = 5;
const CREDITS_PER_SEC = 1;

const MIC_LANGS = ["en-IN", "en-GB", "en-US"];
let micLangIndex = 0;

// Legacy transcribe prompt (kept as-is)
const TRANSCRIBE_PROMPT =
  "Transcribe exactly what is spoken. Do NOT add new words. Do NOT repeat phrases. Do NOT translate. Keep punctuation minimal. If uncertain, omit.";

//--------------------------------------------------------------
// MODE INSTRUCTIONS
//--------------------------------------------------------------
const MODE_INSTRUCTIONS = {
  general: "",
  interview: `
OUTPUT FORMAT RULE:
Do NOT use HTML tags. Use clean Markdown with **bold**, lists, and blank lines.
Always answer in TWO SECTIONS ONLY:

1) Quick Answer (Interview Style)
- 4–6 crisp bullet points
- Direct, domain-specific, no fluff

2) Real-Time Project Example
- 2–4 bullets from practical experience (Problem → Action → Impact)

QUESTION EXPANSION RULE:
If user gives only keyword/fragment, convert into a full interview question.
Never answer raw fragment.
`.trim(),
  sales: `
Respond in persuasive, value-driven style.
Highlight benefits/outcomes.
`.trim()
};

//--------------------------------------------------------------
// UI HELPERS
//--------------------------------------------------------------
function showBanner(msg) {
  if (!bannerTop) return;
  bannerTop.textContent = msg;
  bannerTop.classList.remove("hidden");
  bannerTop.classList.add("bg-red-600");
}
function hideBanner() {
  if (!bannerTop) return;
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
function authHeaders() {
  const token = session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

//--------------------------------------------------------------
// MODE APPLY
//--------------------------------------------------------------
function applyModeInstructions() {
  const mode = modeSelect?.value || "interview";
  hiddenInstructions = MODE_INSTRUCTIONS[mode] || "";

  if (!instructionsBox || !instrStatus) return;

  if (mode === "general") {
    instructionsBox.disabled = false;
    instrStatus.textContent = "You can enter custom instructions.";
  } else {
    instructionsBox.disabled = true;
    instructionsBox.value = "";
    instrStatus.textContent = `${mode.charAt(0).toUpperCase() + mode.slice(1)} mode selected. Custom instructions disabled.`;
  }
  setTimeout(() => (instrStatus.textContent = ""), 900);
}

if (modeSelect) {
  modeSelect.addEventListener("change", applyModeInstructions);
  modeSelect.value = modeSelect.value || "interview";
  applyModeInstructions();
}

function getEffectiveInstructions() {
  const mode = modeSelect?.value || "interview";
  if (mode === "interview" || mode === "sales") return hiddenInstructions;
  const live = (instructionsBox?.value || "").trim();
  if (live) return live;
  return (localStorage.getItem("instructions") || "").trim();
}

//--------------------------------------------------------------
// TRANSCRIPT RENDER (newest on top, pinned unless user scrolls)
//--------------------------------------------------------------
if (liveTranscript) {
  const TH = 40;
  liveTranscript.addEventListener(
    "scroll",
    () => {
      pinnedTop = liveTranscript.scrollTop <= TH;
    },
    { passive: true }
  );
}

function getAllBlocksNewestFirst() {
  return timeline
    .slice()
    .sort((a, b) => (b.t || 0) - (a.t || 0))
    .map(x => String(x.text || "").trim())
    .filter(Boolean);
}

function getFreshBlocksText() {
  return timeline
    .filter(x => x && x.seq > sentSeq && x !== micInterimEntry)
    .sort((a, b) => (a.seq || 0) - (b.seq || 0))
    .map(x => String(x.text || "").trim())
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

function updateTranscript() {
  if (!liveTranscript) return;
  liveTranscript.innerText = getAllBlocksNewestFirst().join("\n\n").trim();
  if (pinnedTop) requestAnimationFrame(() => (liveTranscript.scrollTop = 0));
}

function removeInterimIfAny() {
  if (!micInterimEntry) return;
  const idx = timeline.indexOf(micInterimEntry);
  if (idx >= 0) timeline.splice(idx, 1);
  micInterimEntry = null;
}

// Mic SR + Mic fallback final pipeline
function addFinalSpeech(txt) {
  const cleaned = normalize(txt);
  if (!cleaned) return;

  const now = Date.now();
  if (
    cleaned.toLowerCase() === (lastFinalText || "").toLowerCase() &&
    now - (lastFinalAt || 0) < 1200
  ) {
    return;
  }
  lastFinalText = cleaned;
  lastFinalAt = now;

  removeInterimIfAny();

  const gap = now - (lastSpeechAt || 0);

  if (!timeline.length || gap >= PAUSE_NEWLINE_MS) {
    timeline.push({ t: now, text: cleaned, seq: ++timelineSeq });
  } else {
    const last = timeline[timeline.length - 1];
    last.text = normalize((last.text || "") + " " + cleaned);
    last.t = now;
  }

  lastSpeechAt = now;
  updateTranscript();
}

// System “word-by-word”
function addTypewriterSpeech(txt, msPerWord = SYS_TYPE_MS_PER_WORD) {
  const cleaned = normalize(txt);
  if (!cleaned) return;

  removeInterimIfAny();

  const now = Date.now();
  const gap = now - (lastSpeechAt || 0);

  let entry;
  if (!timeline.length || gap >= PAUSE_NEWLINE_MS) {
    entry = { t: now, text: "", seq: ++timelineSeq };
    timeline.push(entry);
  } else {
    entry = timeline[timeline.length - 1];
    if (entry.text) entry.text = normalize(entry.text) + " ";
    entry.t = now;
  }

  lastSpeechAt = now;

  const words = cleaned.split(" ");
  let i = 0;

  const timer = setInterval(() => {
    if (!isRunning) return clearInterval(timer);
    if (i >= words.length) return clearInterval(timer);
    entry.text += (entry.text && !entry.text.endsWith(" ") ? " " : "") + words[i++];
    entry.t = Date.now();
    updateTranscript();
  }, msPerWord);
}

//--------------------------------------------------------------
// QUESTION RELEVANCE HELPERS
//--------------------------------------------------------------
function extractPriorQuestions() {
  const qs = [];
  for (const m of chatHistory.slice(-30)) {
    if (m.role !== "assistant") continue;
    const c = String(m.content || "");
    const m1 = c.match(/(?:^|\n)Q:\s*([^\n<]+)/i);
    if (m1?.[1]) qs.push(normalize(m1[1]).slice(0, 240));
  }
  return Array.from(new Set(qs)).slice(-8);
}

function guessDomainBias(text) {
  const s = (text || "").toLowerCase();
  const hits = [];
  if (s.includes("selenium") || s.includes("cucumber") || s.includes("bdd") || s.includes("playwright")) hits.push("test automation");
  if (s.includes("page object") || s.includes("pom") || s.includes("singleton") || s.includes("factory")) hits.push("automation design patterns");
  if (s.includes("trigger") || s.includes("sql") || s.includes("database") || s.includes("data model") || s.includes("fact") || s.includes("dimension")) hits.push("data modeling / databases");
  if (s.includes("api") || s.includes("postman") || s.includes("rest")) hits.push("api testing / integration");
  if (s.includes("supabase") || s.includes("jwt") || s.includes("auth") || s.includes("token")) hits.push("auth / backend");
  return hits.slice(0, 3).join(", ");
}

function extractAnchorKeywords(text) {
  const s = (text || "").toLowerCase();
  const stop = new Set(["the","a","an","and","or","but","to","of","in","on","for","with","is","are","was","were",
    "about","explain","tell","me","please","your","my","current","project","can","could","this","that","it","as","at","by","from","into","over","how","what","why","when","where"]);
  return s.replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(w => w.length >= 4 && !stop.has(w)).slice(0, 8);
}

function isGenericProjectAsk(text) {
  const s = (text || "").toLowerCase().trim();
  return s.includes("current project") || s.includes("explain your current project") || s.includes("explain about your current project");
}

function buildDraftQuestion(base) {
  if (!base) return "Q: Can you walk me through your current project end-to-end (architecture, modules, APIs, data flow, and biggest challenges)?";
  if (isGenericProjectAsk(base)) {
    return "Q: Walk me through your current project end-to-end: architecture, key modules, APIs, data flow, and the hardest issue you solved (with impact).";
  }
  const kws = extractAnchorKeywords(base);
  if (kws.length) {
    return `Q: Can you explain ${kws[0]} in the context of what you just said, including how it works and how you used it in your project?`;
  }
  return `Q: Can you explain what you meant by "${base}" and how it maps to your real project work?`;
}

function buildInterviewQuestionPrompt(currentTextOnly) {
  const base = normalize(currentTextOnly);
  if (!base) return "";

  const anchor = extractAnchorKeywords(base);
  const priorQs = extractPriorQuestions();
  const domainBias = guessDomainBias((resumeTextMem || "") + "\n" + base);

  return `
You are generating ONE interview question from CURRENT_TRANSCRIPT and then answering it.

STRICT GROUNDING RULES:
- The question MUST be derived from CURRENT_TRANSCRIPT only.
- Do NOT switch to unrelated topics unless CURRENT_TRANSCRIPT explicitly mentions them.
- Ensure at least 2–4 ANCHOR_KEYWORDS appear in the question (if provided).

If CURRENT_TRANSCRIPT is a generic "current project" ask:
- Ask a deep project question using RESUME_TEXT (architecture, modules, APIs, data flow, challenges, impact).
- Do NOT ask general methodology questions.

ANCHOR_KEYWORDS: ${anchor.length ? anchor.join(", ") : "(none)"}
Domain bias (hint): ${domainBias || "software engineering"}

Previously asked questions/topics:
${priorQs.length ? priorQs.map(q => "- " + q).join("\n") : "- (none)"}

RESUME_TEXT (optional):
${resumeTextMem ? resumeTextMem.slice(0, 4500) : "(none)"}

CURRENT_TRANSCRIPT:
${base}

Output requirements:
- First line must be: "Q: ..."
- Then answer in two sections only:
1) Quick Answer (Interview Style)
2) Real-Time Project Example
`.trim();
}

//--------------------------------------------------------------
// PROFILE
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
      <div class="text-sm text-gray-800 truncate">
        <b>${u.email || "N/A"}</b>
        <span class="ml-3">Credits: <b>${u.credits ?? 0}</b></span>
      </div>
    `;
  } catch {
    userInfo.innerHTML = `<span class='text-red-600 text-sm'>Error loading profile</span>`;
  }
}

//--------------------------------------------------------------
// TOKEN + API
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
    try { await refreshAccessToken(); } catch {}
  }

  const headers = { ...(opts.headers || {}) };
  if (needAuth) Object.assign(headers, authHeaders());

  const res = await fetch(`/api?path=${encodeURIComponent(path)}`, {
    ...opts,
    headers,
    cache: "no-store"
  });

  if (needAuth && res.status === 401) {
    const t = await res.text().catch(() => "");
    const looksExpired = t.includes("token is expired") || t.includes("invalid JWT") || t.includes("Missing token");
    if (looksExpired) {
      await refreshAccessToken();
      const headers2 = { ...(opts.headers || {}), ...authHeaders() };
      return fetch(`/api?path=${encodeURIComponent(path)}`, { ...opts, headers: headers2, cache: "no-store" });
    }
  }

  return res;
}

//--------------------------------------------------------------
// DEDUPE UTIL (tail-based)
//--------------------------------------------------------------
function dedupeByTail(text, tailRef) {
  const t = normalize(text);
  if (!t) return "";

  const tail = tailRef.value || "";
  if (!tail) {
    tailRef.value = t.split(" ").slice(-12).join(" ");
    return t;
  }

  if (t.length <= 180 && tail.toLowerCase().includes(t.toLowerCase())) return "";

  const tailWords = tail.split(" ");
  const newWords = t.split(" ");
  let bestMatch = 0;
  const maxCheck = Math.min(10, tailWords.length, newWords.length);

  for (let k = maxCheck; k >= 3; k--) {
    const endTail = tailWords.slice(-k).join(" ").toLowerCase();
    const startNew = newWords.slice(0, k).join(" ").toLowerCase();
    if (endTail === startNew) { bestMatch = k; break; }
  }

  const cleaned = bestMatch ? newWords.slice(bestMatch).join(" ") : t;
  tailRef.value = (tail + " " + cleaned).trim().split(" ").slice(-12).join(" ");
  return normalize(cleaned);
}

//--------------------------------------------------------------
// SANITIZE (fix “additional context / do not translate / mixed junk”)
//--------------------------------------------------------------
function sanitizeTranscriptText(raw) {
  let s = normalize(String(raw || ""));
  if (!s) return "";

  const lc = s.toLowerCase();

  // Count phrase hits
  let hits = 0;
  for (const p of DROP_TRANSCRIPT_PHRASES) if (lc.includes(p)) hits++;

  // Ratio of non-basic chars (helps drop the mixed-script garbage when it contains leak phrases)
  const basic = /[A-Za-z0-9\s.,!?'"():;\-]/;
  let nonBasic = 0;
  for (const ch of s) if (!basic.test(ch)) nonBasic++;
  const nonBasicRatio = nonBasic / Math.max(1, s.length);

  // If it smells like leakage, drop hard
  if (hits >= 2) return "";
  if (hits >= 1 && (s.length < 240 || nonBasicRatio > 0.18)) return "";

  // Otherwise remove those phrases if embedded
  let out = s;
  for (const p of DROP_TRANSCRIPT_PHRASES) {
    const re = new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "ig");
    out = out.replace(re, " ");
  }
  out = normalize(out);

  // Drop tiny leftovers
  if (!out || out.length < 2) return "";
  return out;
}

function looksLikeWhisperHallucination(t) {
  const s = normalize(t).toLowerCase();
  if (!s) return true;

  const noise = [
    "thanks for watching",
    "thank you for watching",
    "subscribe",
    "please like and subscribe",
    "transcribe clearly in english",
    "handle indian",
    "this is microphone speech",
    "this is the microphone speech"
  ];

  return noise.some(p => s.includes(p));
}

//--------------------------------------------------------------
// STREAMING ASR HELPERS
//--------------------------------------------------------------
function base64FromBytes(u8) {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < u8.length; i += chunk) {
    binary += String.fromCharCode(...u8.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function floatToInt16Bytes(float32) {
  const out = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    let s = float32[i];
    s = Math.max(-1, Math.min(1, s));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return new Uint8Array(out.buffer);
}

function resampleFloat32(input, inRate, outRate) {
  if (!input || !input.length) return new Float32Array(0);
  if (inRate === outRate) return input;

  const ratio = inRate / outRate;
  const newLen = Math.max(1, Math.floor(input.length / ratio));
  const output = new Float32Array(newLen);

  for (let i = 0; i < newLen; i++) {
    const idx = i * ratio;
    const i0 = Math.floor(idx);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const frac = idx - i0;
    output[i] = input[i0] * (1 - frac) + input[i1] * frac;
  }
  return output;
}

async function getRealtimeClientSecretCached() {
  const nowSec = Math.floor(Date.now() / 1000);
  if (realtimeSecretCache?.value && (realtimeSecretCache.expires_at || 0) - nowSec > 30) {
    return realtimeSecretCache.value;
  }

  const res = await apiFetch("realtime/client_secret", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ttl_sec: 600 })
  }, true);

  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data?.value) throw new Error(data?.error || "Failed to get realtime client secret");

  realtimeSecretCache = { value: data.value, expires_at: data.expires_at || 0 };
  return data.value;
}

function stopAsrSession(which) {
  const s = which === "mic" ? micAsr : sysAsr;
  if (!s) return;

  try { s.ws?.close?.(); } catch {}
  try { s.sendTimer && clearInterval(s.sendTimer); } catch {}
  try { s.commitTimer && clearInterval(s.commitTimer); } catch {}
  try { s.proc && (s.proc.onaudioprocess = null); } catch {}

  try { s.src && s.src.disconnect(); } catch {}
  try { s.proc && s.proc.disconnect(); } catch {}
  try { s.gain && s.gain.disconnect(); } catch {}
  try { s.ctx && s.ctx.close && s.ctx.close(); } catch {}

  if (which === "mic") micAsr = null;
  else sysAsr = null;
}

// MIC delta display (optional)
function asrUpsertDeltaMic(itemId, deltaText) {
  const s = micAsr;
  if (!s) return;

  const now = Date.now();
  if (!s.itemText[itemId]) s.itemText[itemId] = "";
  s.itemText[itemId] += String(deltaText || "");

  const cur = normalize(s.itemText[itemId]);
  if (!cur) return;

  if (!s.itemEntry[itemId]) {
    const entry = { t: now, text: cur, seq: ++timelineSeq };
    s.itemEntry[itemId] = entry;
    timeline.push(entry);
  } else {
    s.itemEntry[itemId].text = cur;
    s.itemEntry[itemId].t = now;
  }

  lastSpeechAt = now;
  updateTranscript();
}

// session.update: SYSTEM omits prompt + omits turn_detection (manual commit)
function sendAsrSessionUpdate(ws, which) {
  const transcription = {
    model: REALTIME_ASR_MODEL,
    language: "en"
  };

  // MIC can have a short prompt; SYSTEM should not (reduces leakage)
  if (which !== "sys") transcription.prompt = REALTIME_TRANSCRIBE_PROMPT;

  const input = {
    format: { type: "audio/pcm", rate: ASR_TARGET_RATE },
    noise_reduction: { type: "far_field" },
    transcription
  };

  // Only include turn_detection for MIC (SYSTEM manual commit = no VAD)
  if (!(which === "sys" && SYS_ASR_MANUAL_COMMIT)) {
    input.turn_detection = {
      type: "server_vad",
      threshold: 0.5,
      prefix_padding_ms: 300,
      silence_duration_ms: 350
    };
  }

  const sessionUpdate = {
    type: "session.update",
    session: { audio: { input } }
  };

  try { ws.send(JSON.stringify(sessionUpdate)); } catch {}
}

async function startStreamingAsr(which, mediaStream) {
  if (!isRunning) return false;

  stopAsrSession(which);

  const secret = await getRealtimeClientSecretCached();

  const ws = new WebSocket(REALTIME_INTENT_URL, [
    "realtime",
    "openai-insecure-api-key." + secret
  ]);

  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const src = ctx.createMediaStreamSource(mediaStream);

  const gain = ctx.createGain();
  gain.gain.value = 0;

  const proc = ctx.createScriptProcessor(4096, 1, 1);
  const queue = [];

  const state = {
    ws,
    ctx,
    src,
    proc,
    gain,
    queue,
    sendTimer: null,
    commitTimer: null,
    audioMsSinceCommit: 0,
    voicedMsSinceCommit: 0,
    itemText: {},
    itemEntry: {}
  };

  if (which === "mic") micAsr = state;
  else sysAsr = state;

  proc.onaudioprocess = (e) => {
    if (!isRunning) return;
    if (ws.readyState !== 1) return;

    const ch0 = e.inputBuffer.getChannelData(0);
    const inRate = ctx.sampleRate || 48000;

    // Voice energy gate (SYSTEM only)
    if (which === "sys") {
      let sum = 0;
      for (let i = 0; i < ch0.length; i++) sum += ch0[i] * ch0[i];
      const rms = Math.sqrt(sum / Math.max(1, ch0.length));
      const frameMs = (ch0.length / inRate) * 1000;

      state.audioMsSinceCommit += frameMs;
      if (rms >= SYS_RMS_THRESHOLD) state.voicedMsSinceCommit += frameMs;
    }

    const resampled = resampleFloat32(ch0, inRate, ASR_TARGET_RATE);
    const bytes = floatToInt16Bytes(resampled);
    if (bytes.length) queue.push(bytes);
  };

  src.connect(proc);
  proc.connect(gain);
  gain.connect(ctx.destination);

  ws.onopen = () => {
    sendAsrSessionUpdate(ws, which);

    state.sendTimer = setInterval(() => {
      if (!isRunning) return;
      if (ws.readyState !== 1) return;
      if (!queue.length) return;

      let mergedLen = 0;
      const parts = [];
      while (queue.length && mergedLen < 4800 * 2) {
        const b = queue.shift();
        mergedLen += b.length;
        parts.push(b);
      }
      if (!parts.length) return;

      const merged = new Uint8Array(mergedLen);
      let off = 0;
      for (const p of parts) {
        merged.set(p, off);
        off += p.length;
      }

      const evt = { type: "input_audio_buffer.append", audio: base64FromBytes(merged) };
      try { ws.send(JSON.stringify(evt)); } catch {}
    }, ASR_SEND_EVERY_MS);

    // SYSTEM: manual commit ONLY when voiced audio exists.
    // If long silence, clear buffer WITHOUT commit (prevents garbage output).
    if (which === "sys" && SYS_ASR_MANUAL_COMMIT) {
      state.commitTimer = setInterval(() => {
        if (!isRunning) return;
        if (ws.readyState !== 1) return;

        // If mostly silence for long time, discard buffer (NO commit)
        if (state.audioMsSinceCommit >= SYS_SILENCE_CLEAR_MS && state.voicedMsSinceCommit < 40) {
          try { ws.send(JSON.stringify({ type: "input_audio_buffer.clear" })); } catch {}
          state.audioMsSinceCommit = 0;
          state.voicedMsSinceCommit = 0;
          return;
        }

        // Commit only when we have enough voiced audio
        if (state.voicedMsSinceCommit < SYS_ASR_MIN_VOICED_MS) return;

        try { ws.send(JSON.stringify({ type: "input_audio_buffer.commit" })); } catch {}
        try { ws.send(JSON.stringify({ type: "input_audio_buffer.clear" })); } catch {}

        state.audioMsSinceCommit = 0;
        state.voicedMsSinceCommit = 0;
      }, SYS_ASR_COMMIT_EVERY_MS);
    }

    setStatus(
      audioStatus,
      which === "sys" ? "System audio (streaming) enabled." : "Mic (streaming) enabled.",
      "text-green-600"
    );
  };

  ws.onmessage = (msg) => {
    let ev = null;
    try { ev = JSON.parse(msg.data); } catch { return; }
    if (!ev?.type) return;

    if (ev.type === "error") return;

    // MIC streaming: show deltas (optional)
    if (ev.type === "conversation.item.input_audio_transcription.delta" && which === "mic") {
      asrUpsertDeltaMic(ev.item_id, ev.delta || "");
      return;
    }

    if (ev.type === "conversation.item.input_audio_transcription.completed") {
      let transcript = sanitizeTranscriptText(ev.transcript || "");
      if (!transcript) return;
      if (looksLikeWhisperHallucination(transcript)) return;

      if (which === "sys") {
        const cleaned = dedupeByTail(transcript, {
          get value() { return lastSysTail; },
          set value(v) { lastSysTail = v; }
        });
        if (cleaned) addTypewriterSpeech(cleaned);
      } else {
        const cleaned = dedupeByTail(transcript, {
          get value() { return lastMicTail; },
          set value(v) { lastMicTail = v; }
        });
        if (cleaned) addFinalSpeech(cleaned);
      }
      return;
    }
  };

  ws.onerror = () => {};
  ws.onclose = () => {};

  return true;
}

//--------------------------------------------------------------
// MIC — SpeechRecognition (fast) + fallback (recorder)
//--------------------------------------------------------------
function micSrIsHealthy() {
  return (Date.now() - (lastMicResultAt || 0)) < 1800;
}

function stopMicOnly() {
  try { recognition?.stop(); } catch {}
  recognition = null;
  micInterimEntry = null;
  if (micWatchdog) clearInterval(micWatchdog);
  micWatchdog = null;
}

function startMic() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    setStatus(audioStatus, "SpeechRecognition not supported in this browser.", "text-red-600");
    return false;
  }

  stopMicOnly();

  recognition = new SR();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.maxAlternatives = 1;
  recognition.lang = MIC_LANGS[micLangIndex] || "en-US";

  recognition.onstart = () => {
    setStatus(audioStatus, "Mic active (fast preview).", "text-green-600");
  };

  recognition.onresult = (ev) => {
    if (!isRunning) return;
    if (!micEnabled) return;
    if (Date.now() < blockMicUntil) return;

    lastMicResultAt = Date.now();

    let latestInterim = "";
    for (let i = ev.resultIndex; i < ev.results.length; i++) {
      const r = ev.results[i];
      const text = normalize(r[0].transcript || "");
      if (r.isFinal) addFinalSpeech(text);
      else latestInterim = text;
    }

    if (latestInterim) {
      removeInterimIfAny();
      micInterimEntry = { t: Date.now(), text: latestInterim, seq: ++timelineSeq };
      timeline.push(micInterimEntry);
      updateTranscript();
    }
  };

  recognition.onerror = (e) => {
    micLangIndex = (micLangIndex + 1) % MIC_LANGS.length;
    setStatus(audioStatus, `Mic SR error: ${e?.error || "unknown"}. Retrying…`, "text-orange-600");
  };

  recognition.onend = () => {
    if (!isRunning) return;
    if (!micEnabled) return;
    setTimeout(() => {
      if (!isRunning) return;
      if (!micEnabled) return;
      try { recognition.start(); } catch {}
    }, 150);
  };

  lastMicResultAt = Date.now();

  if (micWatchdog) clearInterval(micWatchdog);
  micWatchdog = setInterval(() => {
    if (!isRunning) return;
    if (!micEnabled) return;

    if (micSrIsHealthy()) {
      if (micRecorder || micStream) stopMicRecorderOnly();
      if (micAsr) stopAsrSession("mic");
      return;
    }

    const idle = Date.now() - (lastMicResultAt || 0);
    if (idle > 2500) {
      if (USE_STREAMING_ASR_MIC_FALLBACK && !micAsr && !micStream) {
        enableMicStreamingFallback().catch(() => {});
      } else if (!micRecorder && !micStream && !micAsr) {
        enableMicRecorderFallback().catch(() => {});
      }
    }
  }, 800);

  try { recognition.start(); } catch {}
  return true;
}

async function enableMicStreamingFallback() {
  if (!isRunning) return;
  if (!micEnabled) return;
  if (micAsr) return;
  if (micSrIsHealthy()) return;

  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  } catch {
    setStatus(audioStatus, "Mic permission denied for streaming ASR.", "text-red-600");
    return;
  }

  micTrack = micStream.getAudioTracks()[0];
  if (!micTrack) {
    setStatus(audioStatus, "No mic track detected for streaming ASR.", "text-red-600");
    stopMicRecorderOnly();
    return;
  }

  await startStreamingAsr("mic", micStream);
}

// ---- Mic fallback (MediaRecorder -> /transcribe) ----
function stopMicRecorderOnly() {
  try { micAbort?.abort(); } catch {}
  micAbort = null;

  if (micSegmentTimer) clearInterval(micSegmentTimer);
  micSegmentTimer = null;

  try { micRecorder?.stop(); } catch {}
  micRecorder = null;

  micSegmentChunks = [];
  micQueue = [];
  micInFlight = 0;

  if (micStream) {
    try { micStream.getTracks().forEach(t => t.stop()); } catch {}
  }
  micStream = null;
  micTrack = null;
}

function pickBestMimeType() {
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/ogg"];
  for (const t of candidates) if (MediaRecorder.isTypeSupported(t)) return t;
  return "";
}

async function enableMicRecorderFallback() {
  if (!isRunning) return;
  if (!micEnabled) return;
  if (micStream) return;
  if (micSrIsHealthy()) return;

  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  } catch {
    setStatus(audioStatus, "Mic permission denied for fallback recorder.", "text-red-600");
    return;
  }

  micTrack = micStream.getAudioTracks()[0];
  if (!micTrack) {
    setStatus(audioStatus, "No mic track detected for fallback recorder.", "text-red-600");
    stopMicRecorderOnly();
    return;
  }

  micAbort = new AbortController();
  setStatus(audioStatus, "Mic active (fallback recorder).", "text-green-600");

  startMicSegmentRecorder();
}

function startMicSegmentRecorder() {
  if (!micTrack) return;

  const audioOnly = new MediaStream([micTrack]);
  const mime = pickBestMimeType();
  micSegmentChunks = [];

  try {
    micRecorder = new MediaRecorder(audioOnly, mime ? { mimeType: mime } : undefined);
  } catch {
    setStatus(audioStatus, "Mic recorder start failed.", "text-red-600");
    return;
  }

  micRecorder.ondataavailable = (ev) => {
    if (!isRunning) return;
    if (!micEnabled) return;
    if (ev.data.size) micSegmentChunks.push(ev.data);
  };

  micRecorder.onstop = () => {
    if (!isRunning) return;
    if (!micEnabled) return;

    const blob = new Blob(micSegmentChunks, { type: micRecorder?.mimeType || "" });
    micSegmentChunks = [];

    if (blob.size >= MIC_MIN_BYTES) {
      micQueue.push(blob);
      drainMicQueue();
    }

    if (isRunning && micEnabled && micTrack && micTrack.readyState === "live") startMicSegmentRecorder();
  };

  try { micRecorder.start(); } catch {}

  if (micSegmentTimer) clearInterval(micSegmentTimer);
  micSegmentTimer = setInterval(() => {
    if (!isRunning) return;
    if (!micEnabled) return;
    try { micRecorder?.stop(); } catch {}
  }, MIC_SEGMENT_MS);
}

function drainMicQueue() {
  if (!isRunning) return;
  if (!micEnabled) return;
  while (micInFlight < MIC_MAX_CONCURRENT && micQueue.length) {
    const blob = micQueue.shift();
    const myEpoch = transcriptEpoch;
    micInFlight++;
    transcribeMicBlob(blob, myEpoch)
      .catch(() => {})
      .finally(() => {
        micInFlight--;
        drainMicQueue();
      });
  }
}

async function transcribeMicBlob(blob, myEpoch) {
  const fd = new FormData();
  const type = (blob.type || "").toLowerCase();
  const ext = type.includes("ogg") ? "ogg" : "webm";
  fd.append("file", blob, `mic.${ext}`);
  fd.append("prompt", TRANSCRIBE_PROMPT);

  const res = await apiFetch("transcribe", {
    method: "POST",
    body: fd,
    signal: micAbort?.signal
  }, false);

  if (myEpoch !== transcriptEpoch) return;
  if (!res.ok) return;

  const data = await res.json().catch(() => ({}));
  let raw = String(data.text || "");
  raw = sanitizeTranscriptText(raw);
  if (!raw) return;
  if (looksLikeWhisperHallucination(raw)) return;

  const cleaned = dedupeByTail(raw, {
    get value() { return lastMicTail; },
    set value(v) { lastMicTail = v; }
  });

  if (cleaned) addFinalSpeech(cleaned);
}

//--------------------------------------------------------------
// SYSTEM AUDIO
//--------------------------------------------------------------
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

  stopAsrSession("sys");

  if (sysStream) {
    try { sysStream.getTracks().forEach(t => t.stop()); } catch {}
  }

  sysStream = null;
  sysTrack = null;

  sysErrCount = 0;
  sysErrBackoffUntil = 0;
}

async function enableSystemAudioLegacy() {
  if (!isRunning) return;

  stopSystemAudioOnly();

  try {
    sysStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
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

  sysTrack.onended = () => {
    stopSystemAudioOnly();
    setStatus(audioStatus, "System audio stopped (share ended).", "text-orange-600");
  };

  sysAbort = new AbortController();
  startSystemSegmentRecorder();
  setStatus(audioStatus, "System audio enabled (legacy).", "text-green-600");
}

async function enableSystemAudioStreaming() {
  if (!isRunning) return;

  stopSystemAudioOnly();

  try {
    sysStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
  } catch {
    setStatus(audioStatus, "Share audio denied.", "text-red-600");
    return;
  }

  sysTrack = sysStream.getAudioTracks()[0];
  if (!sysTrack) {
    setStatus(audioStatus, "No system audio detected.", "text-red-600");
    stopSystemAudioOnly();
    showBanner("System audio requires selecting a window/tab and enabling “Share audio” in the picker.");
    return;
  }

  sysTrack.onended = () => {
    stopSystemAudioOnly();
    setStatus(audioStatus, "System audio stopped (share ended).", "text-orange-600");
  };

  try {
    const ok = await startStreamingAsr("sys", sysStream);
    if (!ok) throw new Error("ASR start failed");
  } catch (e) {
    console.error(e);
    setStatus(audioStatus, "Streaming ASR failed. Falling back to legacy system transcription…", "text-orange-600");
    await enableSystemAudioLegacy();
  }
}

async function enableSystemAudio() {
  if (USE_STREAMING_ASR_SYS) return enableSystemAudioStreaming();
  return enableSystemAudioLegacy();
}

// Legacy system recorder pipeline
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

    if (isRunning && sysTrack && sysTrack.readyState === "live") startSystemSegmentRecorder();
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
  if (Date.now() < sysErrBackoffUntil) return;

  while (sysInFlight < SYS_MAX_CONCURRENT && sysQueue.length) {
    const blob = sysQueue.shift();
    const myEpoch = transcriptEpoch;
    sysInFlight++;

    transcribeSysBlob(blob, myEpoch)
      .catch(() => {})
      .finally(() => {
        sysInFlight--;
        drainSysQueue();
      });
  }
}

async function transcribeSysBlob(blob, myEpoch) {
  if (Date.now() < sysErrBackoffUntil) return;

  const fd = new FormData();
  const type = (blob.type || "").toLowerCase();
  const ext = type.includes("ogg") ? "ogg" : "webm";
  fd.append("file", blob, `sys.${ext}`);
  fd.append("prompt", TRANSCRIBE_PROMPT);

  const res = await apiFetch("transcribe", {
    method: "POST",
    body: fd,
    signal: sysAbort?.signal
  }, false);

  if (myEpoch !== transcriptEpoch) return;

  if (!res.ok) {
    sysErrCount++;
    if (sysErrCount >= SYS_ERR_MAX) {
      sysErrBackoffUntil = Date.now() + SYS_ERR_BACKOFF_MS;
      stopSystemAudioOnly();
      setStatus(audioStatus, "System audio stopped (backend errors). Retry after fixing /transcribe.", "text-red-600");
    }
    return;
  }

  sysErrCount = 0;
  sysErrBackoffUntil = 0;

  const data = await res.json().catch(() => ({}));
  let raw = String(data.text || "");
  raw = sanitizeTranscriptText(raw);
  if (!raw) return;
  if (looksLikeWhisperHallucination(raw)) return;

  const cleaned = dedupeByTail(raw, {
    get value() { return lastSysTail; },
    set value(v) { lastSysTail = v; }
  });

  if (cleaned) addTypewriterSpeech(cleaned);
}

//--------------------------------------------------------------
// CREDITS
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
      await loadUserProfile();
    } catch {}
  }, 500);
}

//--------------------------------------------------------------
// CHAT STREAMING
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
  if (chatHistory.length > 80) chatHistory.splice(0, chatHistory.length - 80);
}

function compactHistoryForRequest() {
  return chatHistory.slice(-12).map(m => ({
    role: m.role,
    content: String(m.content || "").slice(0, 1600)
  }));
}

async function startChatStreaming(prompt, userTextForHistory) {
  abortChatStreamOnly();

  chatAbort = new AbortController();
  chatStreamActive = true;
  const mySeq = ++chatStreamSeq;

  if (userTextForHistory) pushHistory("user", userTextForHistory);

  responseBox.innerHTML = `<span class="text-gray-500 text-sm">Receiving…</span>`;
  setStatus(sendStatus, "Connecting…", "text-orange-600");

  const body = {
    prompt,
    history: compactHistoryForRequest(),
    instructions: getEffectiveInstructions(),
    resumeText: resumeTextMem || ""
  };

  let raw = "";
  let flushTimer = null;
  let sawFirstChunk = false;

  const render = () => { responseBox.innerHTML = renderMarkdown(raw); };

  try {
    const res = await apiFetch("chat/send", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "text/plain" },
      body: JSON.stringify(body),
      signal: chatAbort.signal
    }, false);

    if (!res.ok) throw new Error(await res.text());
    if (!res.body) throw new Error("No stream body (backend buffering).");

    const reader = res.body.getReader();
    const decoder = new TextDecoder();

    flushTimer = setInterval(() => {
      if (!chatStreamActive || mySeq !== chatStreamSeq) return;
      if (!sawFirstChunk) return;
      render();
    }, 30);

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!chatStreamActive || mySeq !== chatStreamSeq) break;

      raw += decoder.decode(value, { stream: true });

      if (!sawFirstChunk) {
        sawFirstChunk = true;
        responseBox.innerHTML = "";
        setStatus(sendStatus, "Receiving…", "text-orange-600");
      }

      if (raw.length < 1800) render();
    }

    if (chatStreamActive && mySeq === chatStreamSeq) {
      render();
      setStatus(sendStatus, "Done", "text-green-600");
      pushHistory("assistant", raw);
    }
  } catch (e) {
    console.error(e);
    setStatus(sendStatus, "Failed", "text-red-600");
    responseBox.innerHTML = `<span class="text-red-600 text-sm">Failed. Check backend /chat/send streaming.</span>`;
  } finally {
    if (flushTimer) clearInterval(flushTimer);
  }
}

//--------------------------------------------------------------
// RESUME UPLOAD
//--------------------------------------------------------------
resumeInput?.addEventListener("change", async () => {
  const file = resumeInput.files?.[0];
  if (!file) return;

  if (resumeStatus) resumeStatus.textContent = "Processing…";

  const fd = new FormData();
  fd.append("file", file);

  const res = await apiFetch("resume/extract", { method: "POST", body: fd }, false);

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    resumeTextMem = "";
    if (resumeStatus) resumeStatus.textContent = `Resume extract failed (${res.status}): ${errText.slice(0, 160)}`;
    return;
  }

  const data = await res.json().catch(() => ({}));
  resumeTextMem = String(data.text || "").trim();

  if (resumeStatus) {
    resumeStatus.textContent = resumeTextMem
      ? `Resume extracted (${resumeTextMem.length} chars)`
      : "Resume extracted: empty";
  }
});

//--------------------------------------------------------------
// MIC TOGGLE
//--------------------------------------------------------------
function updateMicBtnUI() {
  if (!micBtn) return;

  micBtn.textContent = micEnabled ? "Mic: ON" : "Mic: OFF";
  micBtn.classList.remove("bg-gray-700", "bg-green-700", "opacity-50");
  micBtn.classList.add(micEnabled ? "bg-green-700" : "bg-gray-700");

  if (!isRunning) {
    micBtn.disabled = true;
    micBtn.classList.add("opacity-50");
  } else {
    micBtn.disabled = false;
  }
}

async function enableMicCapture() {
  micEnabled = true;
  updateMicBtnUI();

  const micOk = startMic();
  if (!micOk) {
    setStatus(audioStatus, "Mic SR not available. Trying streaming ASR…", "text-orange-600");
    if (USE_STREAMING_ASR_MIC_FALLBACK) {
      await enableMicStreamingFallback().catch(() => {});
    }
    if (!micAsr && !micStream) {
      setStatus(audioStatus, "Mic streaming ASR not available. Using fallback recorder…", "text-orange-600");
      await enableMicRecorderFallback().catch(() => {});
    }
  }

  setTimeout(() => {
    if (!isRunning) return;
    if (!micEnabled) return;
    if (micSrIsHealthy()) return;

    if (USE_STREAMING_ASR_MIC_FALLBACK && !micAsr && !micStream) {
      enableMicStreamingFallback().catch(() => {});
      return;
    }
    if (!micStream) enableMicRecorderFallback().catch(() => {});
  }, 2000);
}

function disableMicCapture() {
  micEnabled = false;
  updateMicBtnUI();

  stopMicOnly();
  stopMicRecorderOnly();
  stopAsrSession("mic");

  removeInterimIfAny();
  setStatus(audioStatus, "Mic muted (OFF). System audio continues.", "text-orange-600");
}

micBtn && (micBtn.onclick = async () => {
  if (!isRunning) return;
  if (micEnabled) disableMicCapture();
  else await enableMicCapture();
});

//--------------------------------------------------------------
// START / STOP
//--------------------------------------------------------------
async function startAll() {
  hideBanner();
  if (isRunning) return;

  await apiFetch("chat/reset", { method: "POST" }, false).catch(() => {});

  transcriptEpoch++;
  timeline = [];
  micInterimEntry = null;
  lastSpeechAt = 0;

  timelineSeq = 0;
  sentSeq = 0;

  pinnedTop = true;

  lastSysTail = "";
  lastMicTail = "";
  lastFinalText = "";
  lastFinalAt = 0;

  stopAsrSession("mic");
  stopAsrSession("sys");

  updateTranscript();

  isRunning = true;

  startBtn.disabled = true;
  stopBtn.disabled = false;
  sysBtn.disabled = false;
  sendBtn.disabled = false;

  stopBtn.classList.remove("opacity-50");
  sysBtn.classList.remove("opacity-50");
  sendBtn.classList.remove("opacity-60");

  // Mic OFF by default
  micEnabled = false;
  updateMicBtnUI();

  setStatus(audioStatus, "Started. Mic is OFF by default. Turn Mic ON only if needed.", "text-green-600");

  startCreditTicking();
}

function stopAll() {
  isRunning = false;

  stopMicOnly();
  stopMicRecorderOnly();
  stopAsrSession("mic");

  stopSystemAudioOnly();
  stopAsrSession("sys");

  if (creditTimer) clearInterval(creditTimer);

  startBtn.disabled = false;
  stopBtn.disabled = true;
  sysBtn.disabled = true;
  sendBtn.disabled = true;

  stopBtn.classList.add("opacity-50");
  sysBtn.classList.add("opacity-50");
  sendBtn.classList.add("opacity-60");

  micEnabled = false;
  updateMicBtnUI();

  setStatus(audioStatus, "Stopped", "text-orange-600");
}

//--------------------------------------------------------------
// HARD CLEAR
//--------------------------------------------------------------
function hardClearTranscript() {
  transcriptEpoch++;

  try { micAbort?.abort(); } catch {}
  try { sysAbort?.abort(); } catch {}

  micQueue = [];
  sysQueue = [];
  micSegmentChunks = [];
  sysSegmentChunks = [];

  lastSysTail = "";
  lastMicTail = "";
  lastFinalText = "";
  lastFinalAt = 0;

  timeline = [];
  micInterimEntry = null;
  lastSpeechAt = 0;

  timelineSeq = 0;
  sentSeq = 0;

  pinnedTop = true;

  updateTranscript();
}

//--------------------------------------------------------------
// SEND / CLEAR / RESET
//--------------------------------------------------------------
sendBtn.onclick = async () => {
  if (sendBtn.disabled) return;

  abortChatStreamOnly();

  const manual = normalize(manualQuestion?.value || "");
  const fresh = normalize(getFreshBlocksText());
  const base = manual || fresh;
  if (!base) return;

  blockMicUntil = Date.now() + 700;
  removeInterimIfAny();

  // cursor advance (do NOT clear transcript)
  sentSeq = timelineSeq;
  pinnedTop = true;
  updateTranscript();

  if (manualQuestion) manualQuestion.value = "";

  const draftQ = buildDraftQuestion(base);
  responseBox.innerHTML = renderMarkdown(`${draftQ}\n\n**Generating answer…**`);
  setStatus(sendStatus, "Queued…", "text-orange-600");

  const mode = modeSelect?.value || "interview";
  const promptToSend = (mode === "interview") ? buildInterviewQuestionPrompt(base) : base;

  await startChatStreaming(promptToSend, base);
};

clearBtn.onclick = () => {
  hardClearTranscript();
  if (manualQuestion) manualQuestion.value = "";
  setStatus(sendStatus, "Transcript cleared", "text-green-600");
  setStatus(audioStatus, isRunning ? "Listening…" : "Stopped", isRunning ? "text-green-600" : "text-orange-600");
};

resetBtn.onclick = async () => {
  abortChatStreamOnly();
  responseBox.innerHTML = "";
  setStatus(sendStatus, "Response reset", "text-green-600");
  await apiFetch("chat/reset", { method: "POST" }, false).catch(() => {});
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
  if (resumeStatus) resumeStatus.textContent = "Resume cleared.";

  await loadUserProfile();
  await apiFetch("chat/reset", { method: "POST" }, false).catch(() => {});

  transcriptEpoch++;
  timeline = [];
  micInterimEntry = null;
  lastSpeechAt = 0;

  timelineSeq = 0;
  sentSeq = 0;

  pinnedTop = true;

  lastSysTail = "";
  lastMicTail = "";
  lastFinalText = "";
  lastFinalAt = 0;

  stopAsrSession("mic");
  stopAsrSession("sys");

  updateTranscript();

  stopBtn.disabled = true;
  sysBtn.disabled = true;
  sendBtn.disabled = true;

  stopBtn.classList.add("opacity-50");
  sysBtn.classList.add("opacity-50");
  sendBtn.classList.add("opacity-60");

  micEnabled = false;
  updateMicBtnUI();

  setStatus(audioStatus, "Stopped", "text-orange-600");
});

//--------------------------------------------------------------
// BUTTONS
//--------------------------------------------------------------
startBtn.onclick = startAll;
stopBtn.onclick = stopAll;
sysBtn.onclick = enableSystemAudio;
