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
  const safe = escapeHtml(md);
  return safe
    .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
    .replace(/\n{2,}/g, "<br><br>")
    .replace(/\n/g, "<br>");
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
let sentCursor = 0;

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
// STREAMING ASR (Realtime) — NEW
//--------------------------------------------------------------
const USE_STREAMING_ASR_SYS = true;     // system audio -> realtime transcription
const USE_STREAMING_ASR_MIC_FALLBACK = true; // if SpeechRecognition missing/weak -> realtime transcription

const REALTIME_INTENT_URL = "wss://api.openai.com/v1/realtime?intent=transcription";

// prefer cheaper/fast model for deltas
const REALTIME_ASR_MODEL = "gpt-4o-mini-transcribe"; // supported per docs :contentReference[oaicite:5]{index=5}

// audio frames cadence
const ASR_SEND_EVERY_MS = 40; // ~2–3 words cadence depends on speaker + VAD; 40ms keeps deltas responsive
const ASR_TARGET_RATE = 24000; // session examples use 24k PCM :contentReference[oaicite:6]{index=6}

let realtimeSecretCache = null; // { value, expires_at }

// separate sessions for mic vs system
let micAsr = null; // { ws, ctx, src, proc, gain, sendTimer, queue, itemText, itemEntry, lastItemId }
let sysAsr = null;

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

// Strong transcription prompt to reduce hallucinations/repeats
const TRANSCRIBE_PROMPT =
  "Transcribe exactly what is spoken. Do NOT add new words. Do NOT repeat phrases. Do NOT translate. Keep punctuation minimal. If uncertain, omit.";

//--------------------------------------------------------------
// MODE INSTRUCTIONS
//--------------------------------------------------------------
const MODE_INSTRUCTIONS = {
  general: "",
  interview: `
Answer in TWO sections only:
1) Quick Answer (Interview Style)
2) Real-Time Project Example
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
    .slice(sentCursor)
    .filter(x => x && x !== micInterimEntry)
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

// pause-aware append
function removeInterimIfAny() {
  if (!micInterimEntry) return;
  const idx = timeline.indexOf(micInterimEntry);
  if (idx >= 0) timeline.splice(idx, 1);
  micInterimEntry = null;
}

// HARD dedupe at final stage
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
    timeline.push({ t: now, text: cleaned });
  } else {
    const last = timeline[timeline.length - 1];
    last.text = normalize((last.text || "") + " " + cleaned);
    last.t = now;
  }

  lastSpeechAt = now;
  updateTranscript();
}

function addTypewriterSpeech(txt, msPerWord = SYS_TYPE_MS_PER_WORD) {
  const cleaned = normalize(txt);
  if (!cleaned) return;

  removeInterimIfAny();

  const now = Date.now();
  const gap = now - (lastSpeechAt || 0);

  let entry;
  if (!timeline.length || gap >= PAUSE_NEWLINE_MS) {
    entry = { t: now, text: "" };
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

// instant local “draft question”
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
- Do NOT output the question.
- Output EXACTLY two sections, and start immediately with:

Quick Answer (Interview Style)
- 4–6 bullets

Real-Time Project Example
- 2–4 bullets (Problem → Action → Result)

- No extra headings, no "Q:", no preface text.

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
    "i don't know",
    "i dont know",
    "this is microphone speech",
    "this is the microphone speech"
  ];

  if (s.length < 40 && (s.endsWith("i don't know.") || s.endsWith("i dont know"))) return true;
  return noise.some(p => s.includes(p));
}

//--------------------------------------------------------------
// STREAMING ASR HELPERS — NEW
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

// general resample (linear)
function resampleFloat32(input, inRate, outRate) {
  if (!input || !input.length) return new Float32Array(0);
  if (inRate === outRate) return input;

  const ratio = inRate / outRate;
  const newLen = Math.max(1, Math.floor(input.length / ratio));
  const output = new Float32Array(newLen);

  let pos = 0;
  for (let i = 0; i < newLen; i++) {
    const idx = i * ratio;
    const i0 = Math.floor(idx);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const frac = idx - i0;
    output[i] = input[i0] * (1 - frac) + input[i1] * frac;
    pos = idx;
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
    body: JSON.stringify({
      // keep minimal; server sets config
      ttl_sec: 600
    })
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
  try { s.proc && (s.proc.onaudioprocess = null); } catch {}

  try { s.src && s.src.disconnect(); } catch {}
  try { s.proc && s.proc.disconnect(); } catch {}
  try { s.gain && s.gain.disconnect(); } catch {}
  try { s.ctx && s.ctx.close && s.ctx.close(); } catch {}

  if (which === "mic") micAsr = null;
  else sysAsr = null;
}

// create/update a partial line in timeline for a given item_id
function asrUpsertDelta(which, itemId, deltaText) {
  const s = which === "mic" ? micAsr : sysAsr;
  if (!s) return;

  const now = Date.now();
  if (!s.itemText[itemId]) s.itemText[itemId] = "";
  s.itemText[itemId] += String(deltaText || "");

  const cur = normalize(s.itemText[itemId]);
  if (!cur) return;

  if (!s.itemEntry[itemId]) {
    const entry = { t: now, text: cur };
    s.itemEntry[itemId] = entry;
    timeline.push(entry);
  } else {
    s.itemEntry[itemId].text = cur;
    s.itemEntry[itemId].t = now;
  }

  // keep UI consistent with your pin-to-top behavior
  lastSpeechAt = now;
  updateTranscript();
}

function asrFinalizeItem(which, itemId, transcript) {
  const s = which === "mic" ? micAsr : sysAsr;
  if (!s) return;

  // remove the interim entry for this item_id (if present)
  const entry = s.itemEntry[itemId];
  if (entry) {
    const idx = timeline.indexOf(entry);
    if (idx >= 0) timeline.splice(idx, 1);
  }
  delete s.itemEntry[itemId];
  delete s.itemText[itemId];

  const final = normalize(transcript);
  if (!final) return;

  // use your final pipeline to keep PAUSE_NEWLINE_MS + dedupe consistent
  addFinalSpeech(final);
}

function sendAsrConfig(ws) {
  // Try the "transcription_session.update" shape (speech-to-text guide) :contentReference[oaicite:7]{index=7}
  const cfgA = {
    type: "transcription_session.update",
    input_audio_format: "pcm16",
    input_audio_transcription: {
      model: REALTIME_ASR_MODEL,
      prompt: TRANSCRIBE_PROMPT,
      language: "en"
    },
    turn_detection: {
      type: "server_vad",
      threshold: 0.5,
      prefix_padding_ms: 300,
      silence_duration_ms: 350
    },
    input_audio_noise_reduction: { type: "far_field" }
  };

  try { ws.send(JSON.stringify(cfgA)); } catch {}
}

function sendAsrConfigFallbackSessionUpdate(ws) {
  // Fallback to "session.update" shape (realtime client events) :contentReference[oaicite:8]{index=8}
  const cfgB = {
    type: "session.update",
    session: {
      type: "transcription",
      audio: {
        input: {
          format: { type: "audio/pcm", rate: ASR_TARGET_RATE },
          transcription: {
            model: REALTIME_ASR_MODEL,
            language: "en",
            prompt: TRANSCRIBE_PROMPT
          },
          noise_reduction: { type: "far_field" },
          turn_detection: {
            type: "server_vad",
            threshold: 0.5,
            prefix_padding_ms: 300,
            silence_duration_ms: 350
          }
        }
      }
    }
  };

  try { ws.send(JSON.stringify(cfgB)); } catch {}
}

async function startStreamingAsr(which, mediaStream) {
  if (!isRunning) return false;

  // stop any existing session
  stopAsrSession(which);

  const secret = await getRealtimeClientSecretCached();

  // Browser WebSocket auth uses subprotocols (openai-insecure-api-key.*) :contentReference[oaicite:9]{index=9}
  const ws = new WebSocket(REALTIME_INTENT_URL, [
    "realtime",
    "openai-insecure-api-key." + secret
  ]);

  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const src = ctx.createMediaStreamSource(mediaStream);

  // silence output
  const gain = ctx.createGain();
  gain.gain.value = 0;

  // ScriptProcessor is widely supported (AudioWorklet is better but heavier)
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
    itemText: {},
    itemEntry: {},
    lastItemId: null,
    sawConfigError: false
  };

  if (which === "mic") micAsr = state;
  else sysAsr = state;

  proc.onaudioprocess = (e) => {
    if (!isRunning) return;
    if (ws.readyState !== 1) return;

    const ch0 = e.inputBuffer.getChannelData(0);
    const inRate = ctx.sampleRate || 48000;

    const resampled = resampleFloat32(ch0, inRate, ASR_TARGET_RATE);
    const bytes = floatToInt16Bytes(resampled);
    if (bytes.length) queue.push(bytes);
  };

  // connect nodes
  src.connect(proc);
  proc.connect(gain);
  gain.connect(ctx.destination);

  ws.onopen = () => {
    // Configure transcription session
    sendAsrConfig(ws);

    // send loop
    state.sendTimer = setInterval(() => {
      if (!isRunning) return;
      if (ws.readyState !== 1) return;
      if (!queue.length) return;

      // merge a few buffers to reduce message overhead
      let mergedLen = 0;
      const parts = [];
      while (queue.length && mergedLen < 4800 * 2) { // ~100ms at 24k
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

      const evt = {
        type: "input_audio_buffer.append",
        audio: base64FromBytes(merged)
      };
      try { ws.send(JSON.stringify(evt)); } catch {}
    }, ASR_SEND_EVERY_MS);

    setStatus(
      audioStatus,
      which === "sys" ? "System audio (streaming ASR) enabled." : "Mic (streaming ASR) enabled.",
      "text-green-600"
    );
  };

  ws.onmessage = (msg) => {
    let ev = null;
    try { ev = JSON.parse(msg.data); } catch { return; }
    if (!ev?.type) return;

    // If server says unknown config event, fallback to session.update
    if (ev.type === "error") {
      const m = String(ev?.error?.message || ev?.message || "");
      if (!state.sawConfigError && m.toLowerCase().includes("transcription_session.update")) {
        state.sawConfigError = true;
        sendAsrConfigFallbackSessionUpdate(ws);
      }
      return;
    }

    // Deltas (incremental hypotheses) :contentReference[oaicite:10]{index=10}
    if (ev.type === "conversation.item.input_audio_transcription.delta") {
      asrUpsertDelta(which, ev.item_id, ev.delta || "");
      return;
    }

    // Completed turn :contentReference[oaicite:11]{index=11}
    if (ev.type === "conversation.item.input_audio_transcription.completed") {
      asrFinalizeItem(which, ev.item_id, ev.transcript || "");
      return;
    }
  };

  ws.onerror = () => {
    // Let caller decide fallback
  };

  ws.onclose = () => {
    // If user still running, we can fallback to legacy
  };

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
    if (Date.now() < blockMicUntil) return;

    lastMicResultAt = Date.now();

    let latestInterim = "";
    for (let i = ev.resultIndex; i < ev.results.length; i++) {
      const r = ev.results[i];
      const text = normalize(r[0].transcript || "");
      if (r.isFinal) addFinalSpeech(text);
      else latestInterim = text;
    }

    // LIVE: show interim instantly
    if (latestInterim) {
      removeInterimIfAny();
      micInterimEntry = { t: Date.now(), text: latestInterim };
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
    setTimeout(() => {
      if (!isRunning) return;
      try { recognition.start(); } catch {}
    }, 150);
  };

  lastMicResultAt = Date.now();

  // Watchdog: if SR works -> STOP fallback. If SR idle -> start fallback.
  if (micWatchdog) clearInterval(micWatchdog);
  micWatchdog = setInterval(() => {
    if (!isRunning) return;

    if (micSrIsHealthy()) {
      if (micRecorder || micStream) stopMicRecorderOnly();
      if (micAsr) stopAsrSession("mic");
      return;
    }

    const idle = Date.now() - (lastMicResultAt || 0);
    if (idle > 2500) {
      // try streaming ASR first (NEW), then legacy recorder
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
  if (micStream) return;
  if (micSrIsHealthy()) return; // CRITICAL: do not run fallback if SR is alive

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
    if (ev.data.size) micSegmentChunks.push(ev.data);
  };

  micRecorder.onstop = () => {
    if (!isRunning) return;

    const blob = new Blob(micSegmentChunks, { type: micRecorder?.mimeType || "" });
    micSegmentChunks = [];

    if (blob.size >= MIC_MIN_BYTES) {
      micQueue.push(blob);
      drainMicQueue();
    }

    if (isRunning && micTrack && micTrack.readyState === "live") startMicSegmentRecorder();
  };

  try { micRecorder.start(); } catch {}

  if (micSegmentTimer) clearInterval(micSegmentTimer);
  micSegmentTimer = setInterval(() => {
    if (!isRunning) return;
    try { micRecorder?.stop(); } catch {}
  }, MIC_SEGMENT_MS);
}

function drainMicQueue() {
  if (!isRunning) return;
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

  if (myEpoch !== transcriptEpoch) return; // ignore late results after Clear

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    setStatus(audioStatus, `Mic transcribe failed (${res.status}). ${errText.slice(0, 120)}`, "text-red-600");
    return;
  }

  const data = await res.json().catch(() => ({}));
  const raw = String(data.text || "");
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

  // stop streaming ASR session if active (NEW)
  stopAsrSession("sys");

  if (sysStream) {
    try { sysStream.getTracks().forEach(t => t.stop()); } catch {}
  }

  sysStream = null;
  sysTrack = null;

  sysErrCount = 0;
  sysErrBackoffUntil = 0;
}

// Legacy (your existing) system audio recorder pipeline
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

// NEW: streaming ASR system audio.
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
    showingFixHint();
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
    // fallback to your old chunking
    await enableSystemAudioLegacy();
  }
}

function showingFixHint() {
  // minimal hint without changing your UI layout
  showBanner("System audio requires selecting a window/tab and enabling “Share audio” in the picker.");
}

async function enableSystemAudio() {
  if (USE_STREAMING_ASR_SYS) return enableSystemAudioStreaming();
  return enableSystemAudioLegacy();
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

  if (myEpoch !== transcriptEpoch) return; // ignore late results after Clear

  if (!res.ok) {
    sysErrCount++;
    const errText = await res.text().catch(() => "");
    setStatus(audioStatus, `System transcribe failed (${res.status}). ${errText.slice(0, 160)}`, "text-red-600");

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
  const raw = String(data.text || "");
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
// START / STOP
//--------------------------------------------------------------
async function startAll() {
  hideBanner();
  if (isRunning) return;

  await apiFetch("chat/reset", { method: "POST" }, false).catch(() => {});

  // Hard reset transcript state
  transcriptEpoch++;
  timeline = [];
  micInterimEntry = null;
  lastSpeechAt = 0;
  sentCursor = 0;
  pinnedTop = true;

  lastSysTail = "";
  lastMicTail = "";
  lastFinalText = "";
  lastFinalAt = 0;

  // reset streaming ASR session state
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

  // Start SR mic immediately
  const micOk = startMic();
  if (!micOk) {
    // iOS/Chrome etc: no SpeechRecognition. Prefer streaming ASR, fallback to legacy recorder.
    setStatus(audioStatus, "Mic SR not available. Trying streaming ASR…", "text-orange-600");
    if (USE_STREAMING_ASR_MIC_FALLBACK) {
      await enableMicStreamingFallback().catch(() => {});
    }
    if (!micAsr && !micStream) {
      setStatus(audioStatus, "Mic streaming ASR not available. Using fallback recorder…", "text-orange-600");
      await enableMicRecorderFallback().catch(() => {});
    }
  }

  // If SR gives nothing in ~2s, try streaming ASR fallback, then recorder fallback
  setTimeout(() => {
    if (!isRunning) return;
    if (micSrIsHealthy()) return;

    if (USE_STREAMING_ASR_MIC_FALLBACK && !micAsr && !micStream) {
      enableMicStreamingFallback().catch(() => {});
      return;
    }
    if (!micStream) enableMicRecorderFallback().catch(() => {});
  }, 2000);

  startCreditTicking();
}

function stopAll() {
  isRunning = false;

  stopMicOnly();
  stopMicRecorderOnly();
  stopSystemAudioOnly();

  // Ensure ASR sessions closed
  stopAsrSession("mic");
  stopAsrSession("sys");

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
// HARD CLEAR (stop late results + clear everything visible)
//--------------------------------------------------------------
function hardClearTranscript() {
  transcriptEpoch++; // ignore any in-flight transcribe responses

  // Cancel in-flight transcribe immediately
  try { micAbort?.abort(); } catch {}
  try { sysAbort?.abort(); } catch {}

  // Clear queues and buffers
  micQueue = [];
  sysQueue = [];
  micSegmentChunks = [];
  sysSegmentChunks = [];

  lastSysTail = "";
  lastMicTail = "";
  lastFinalText = "";
  lastFinalAt = 0;

  // also clear live streaming ASR interim blocks
  if (micAsr) { micAsr.itemText = {}; micAsr.itemEntry = {}; }
  if (sysAsr) { sysAsr.itemText = {}; sysAsr.itemEntry = {}; }

  timeline = [];
  micInterimEntry = null;
  lastSpeechAt = 0;
  sentCursor = 0;
  pinnedTop = true;

  updateTranscript();
}

//--------------------------------------------------------------
// SEND / CLEAR / RESET
//--------------------------------------------------------------
sendBtn.onclick = async () => {
  if (sendBtn.disabled) return;

  // If a response is streaming, STOP it and accept the new prompt immediately
  abortChatStreamOnly();

  const manual = normalize(manualQuestion?.value || "");
  const fresh = normalize(getFreshBlocksText());
  const base = manual || fresh;
  if (!base) return;

  blockMicUntil = Date.now() + 700;
  removeInterimIfAny();

  // move cursor (do NOT clear transcript)
  sentCursor = timeline.length;
  pinnedTop = true;
  updateTranscript();

  if (manualQuestion) manualQuestion.value = "";

  // Instant feedback
  const draftQ = buildDraftQuestion(base);
  responseBox.innerHTML = renderMarkdown(`${draftQ}\n\n**Generating answer…**`);
  setStatus(sendStatus, "Queued…", "text-orange-600");

  const mode = modeSelect?.value || "interview";
  const promptToSend = (mode === "interview") ? buildInterviewQuestionPrompt(base) : base;

  await startChatStreaming(promptToSend, base);
};

clearBtn.onclick = () => {
  // HARD STOP clear: wipe and prevent old text from coming back
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
  sentCursor = 0;
  pinnedTop = true;

  lastSysTail = "";
  lastMicTail = "";
  lastFinalText = "";
  lastFinalAt = 0;

  // close any leaked streaming sessions
  stopAsrSession("mic");
  stopAsrSession("sys");

  updateTranscript();

  stopBtn.disabled = true;
  sysBtn.disabled = true;
  sendBtn.disabled = true;

  stopBtn.classList.add("opacity-50");
  sysBtn.classList.add("opacity-50");
  sendBtn.classList.add("opacity-60");

  setStatus(audioStatus, "Stopped", "text-orange-600");
});

//--------------------------------------------------------------
// BUTTONS
//--------------------------------------------------------------
startBtn.onclick = startAll;
stopBtn.onclick = stopAll;
sysBtn.onclick = enableSystemAudio;