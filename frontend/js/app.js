/* ========================================================================== */
/* app.js — END TO END (Replace your complete app.js with this file)           */
/* Fixes:                                                                     */
/* 1) Duplicate lines / repeated phrases (SR + fallback + overlap)             */
/* 2) Role-safe transcript merging (interviewer vs candidate)                  */
/* 3) Correct system overlap trimming (bugfix order)                           */
/* 4) Strong final dedupe (punctuation/case-insensitive + overlap trim)        */
/* ========================================================================== */

/* -------------------------------------------------------------------------- */
/* BASIC TEXT HELPERS                                                          */
/* -------------------------------------------------------------------------- */
function normalize(s) {
  return (s || "").replace(/\s+/g, " ").trim();
}

function escapeHtml(s) {
  return String(s || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

/* -------------------------------------------------------------------------- */
/* SIMPLE MARKDOWN (fallback)                                                   */
/* -------------------------------------------------------------------------- */
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

function renderMarkdownLite(md) {
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

/* -------------------------------------------------------------------------- */
/* MARKDOWN RENDERING FOR responseBox (marked + DOMPurify if present)          */
/* -------------------------------------------------------------------------- */
let aiRawBuffer = "";

function setupMarkdownRenderer() {
  if (!window.marked || !window.hljs || !window.DOMPurify) return;

  marked.setOptions({
    gfm: true,
    breaks: true,
    highlight: (code, lang) => {
      try {
        if (lang && hljs.getLanguage(lang)) {
          return hljs.highlight(code, { language: lang }).value;
        }
        return hljs.highlightAuto(code).value;
      } catch {
        return code;
      }
    }
  });
}

function renderMarkdownSafe(mdText) {
  if (!window.marked || !window.DOMPurify) {
    return renderMarkdownLite(mdText);
  }
  const html = marked.parse(mdText || "");
  return DOMPurify.sanitize(html);
}

function enhanceCodeBlocks(containerEl) {
  if (!containerEl) return;
  const pres = containerEl.querySelectorAll("pre");
  pres.forEach((pre) => {
    if (pre.querySelector(".code-actions")) return;

    const toolbar = document.createElement("div");
    toolbar.className = "code-actions";

    const btn = document.createElement("button");
    btn.className = "code-btn";
    btn.type = "button";
    btn.textContent = "Copy";

    btn.addEventListener("click", async () => {
      const codeEl = pre.querySelector("code");
      const text = codeEl ? codeEl.innerText : pre.innerText;
      try {
        await navigator.clipboard.writeText(text);
        btn.textContent = "Copied";
        setTimeout(() => (btn.textContent = "Copy"), 900);
      } catch {
        btn.textContent = "Failed";
        setTimeout(() => (btn.textContent = "Copy"), 900);
      }
    });

    toolbar.appendChild(btn);
    pre.appendChild(toolbar);
  });
}

function appendStreamChunk(chunkText) {
  aiRawBuffer += chunkText;
  // streaming view: keep it fast & stable
  responseBox.textContent = aiRawBuffer;
}

function finalizeRenderedResponse() {
  responseBox.innerHTML = renderMarkdownSafe(aiRawBuffer);

  if (window.hljs) {
    responseBox.querySelectorAll("pre code").forEach((block) => {
      try { hljs.highlightElement(block); } catch {}
    });
  }
  enhanceCodeBlocks(responseBox);
}

document.addEventListener("DOMContentLoaded", () => {
  setupMarkdownRenderer();
});

/* -------------------------------------------------------------------------- */
/* DOM                                                                          */
/* -------------------------------------------------------------------------- */
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
const micMuteBtn = document.getElementById("micMuteBtn");

/* -------------------------------------------------------------------------- */
/* SESSION + STATE                                                              */
/* -------------------------------------------------------------------------- */
let session = null;
let isRunning = false;

let hiddenInstructions = "";

// MIC MUTE
let micMuted = false;

// SpeechRecognition (fast preview)
let recognition = null;
let blockMicUntil = 0;
let micInterimEntry = null;
let lastMicResultAt = 0;
let micWatchdog = null;
let lastQuickInterviewerAt = 0;


// Mic fallback (MediaRecorder -> /transcribe)
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

// DEDUPE STATE (tails)
let lastSysTail = "";
let lastMicTail = "";

// System overlap memory
let lastSysPrinted = "";
let lastSysPrintedAt = 0;

let activeIntent = null;   // "code" | "debug" | "design" | "theory"
let activeTech = null;    // "java" | "python" | ...

// Transcript blocks
let timeline = [];
let lastSpeechAt = 0;
let sentCursor = 0;

// “pin to top”
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

// HARD CLEAR TOKEN
let transcriptEpoch = 0;

/* -------------------------------------------------------------------------- */
/* CONSTANTS                                                                    */
/* -------------------------------------------------------------------------- */
const PAUSE_NEWLINE_MS = 3000;

const MIC_SEGMENT_MS = 1200;
const MIC_MIN_BYTES = 1800;
const MIC_MAX_CONCURRENT = 2;

const SYS_SEGMENT_MS = 2800;
const SYS_MIN_BYTES = 6000;
const SYS_MAX_CONCURRENT = 1;
const SYS_TYPE_MS_PER_WORD = 18;

const SYS_ERR_MAX = 3;
const SYS_ERR_BACKOFF_MS = 10000;

const CREDIT_BATCH_SEC = 5;
const CREDITS_PER_SEC = 1;

const MIC_LANGS = ["en-IN", "en-GB", "en-US"];
let micLangIndex = 0;

const TRANSCRIBE_PROMPT =
  "Transcribe only English as spoken with an Indian English accent. " +
  "STRICTLY ignore and OMIT any Urdu, Arabic, Hindi, or other non-English words. " +
  "If a word is not English, drop it completely. " +
  "Use Indian English pronunciation and spelling. " +
  "Do NOT Americanize words. " +
  "Do NOT translate. " +
  "Do NOT add new words. Do NOT repeat phrases. " +
  "Keep punctuation minimal. If uncertain, omit.";


/* -------------------------------------------------------------------------- */
/* STREAMING ASR (Realtime)                                                     */
/* -------------------------------------------------------------------------- */
// Force system audio to legacy MediaRecorder -> /transcribe
const USE_STREAMING_ASR_SYS = true;
// Allow mic streaming fallback when SR is weak
const USE_STREAMING_ASR_MIC_FALLBACK = false;

const REALTIME_INTENT_URL = "wss://api.openai.com/v1/realtime?intent=transcription";
const REALTIME_ASR_MODEL = "gpt-4o-mini-transcribe";

const ASR_SEND_EVERY_MS = 40;
const ASR_TARGET_RATE = 24000;

let realtimeSecretCache = null;

let micAsr = null;
let sysAsr = null;

/* -------------------------------------------------------------------------- */
/* MODE INSTRUCTIONS                                                            */
/* -------------------------------------------------------------------------- */
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

/* -------------------------------------------------------------------------- */
/* UI HELPERS                                                                   */
/* -------------------------------------------------------------------------- */
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

function authHeaders() {
  const token = session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/* -------------------------------------------------------------------------- */
/* MIC MUTE UI                                                                  */
/* -------------------------------------------------------------------------- */
function updateMicMuteUI() {
  if (!micMuteBtn) return;

  if (micMuted) {
    micMuteBtn.textContent = "Mic: OFF";
    micMuteBtn.classList.remove("bg-gray-700");
    micMuteBtn.classList.add("bg-gray-900");
  } else {
    micMuteBtn.textContent = "Mic: ON";
    micMuteBtn.classList.remove("bg-gray-900");
    micMuteBtn.classList.add("bg-gray-700");
  }
}

// Stop mic pipelines only (do not touch system)
function stopMicPipelinesOnly() {
  try { recognition?.stop(); } catch {}
  recognition = null;

  if (micWatchdog) clearInterval(micWatchdog);
  micWatchdog = null;

  stopAsrSession("mic");
  stopMicRecorderOnly();
  removeInterimIfAny();
}

async function setMicMuted(on) {
  micMuted = !!on;
  updateMicMuteUI();

  if (!isRunning) return;

  if (micMuted) {
    stopMicPipelinesOnly();
    setStatus(audioStatus, "Mic muted (user OFF). System audio continues.", "text-orange-600");
    return;
  }

  const micOk = startMic();
  if (!micOk) {
    setStatus(audioStatus, "Mic SR not available. Trying streaming ASR…", "text-orange-600");
    if (USE_STREAMING_ASR_MIC_FALLBACK) await enableMicStreamingFallback().catch(() => {});
    if (!micAsr && !micStream) {
      setStatus(audioStatus, "Mic streaming ASR not available. Using fallback recorder…", "text-orange-600");
      await enableMicRecorderFallback().catch(() => {});
    }
  } else {
    setStatus(audioStatus, "Mic unmuted.", "text-green-600");
  }

  setTimeout(() => {
    if (!isRunning) return;
    if (micMuted) return;
    if (micSrIsHealthy()) return;

    if (USE_STREAMING_ASR_MIC_FALLBACK && !micAsr && !micStream) {
      enableMicStreamingFallback().catch(() => {});
      return;
    }
    if (!micStream) enableMicRecorderFallback().catch(() => {});
  }, 2000);
}

if (micMuteBtn) {
  micMuteBtn.addEventListener("click", () => setMicMuted(!micMuted));
  updateMicMuteUI();
}

/* -------------------------------------------------------------------------- */
/* MODE APPLY                                                                   */
/* -------------------------------------------------------------------------- */
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

/* -------------------------------------------------------------------------- */
/* TRANSCRIPT RENDER (newest on top, pinned unless user scrolls)               */
/* -------------------------------------------------------------------------- */
if (liveTranscript) {
  const TH = 40;
  liveTranscript.addEventListener(
    "scroll",
    () => { pinnedTop = liveTranscript.scrollTop <= TH; },
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

function getFreshInterviewerBlocksText() {
  return timeline
    .slice(sentCursor)
    .filter(x => x && x.role === "interviewer")
    .map(x => String(x.text || "").trim())
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

function getQuickInterviewerSnapshot() {
  for (let i = timeline.length - 1; i >= 0; i--) {
    const b = timeline[i];
    if (
      b?.role === "interviewer" &&
      b.text &&
      b.text.length > 8 &&
      b.t > lastQuickInterviewerAt
    ) {
      return { text: normalize(b.text), at: b.t };
    }
  }
  return null;
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

/* -------------------------------------------------------------------------- */
/* HARD FINAL DEDUPE + OVERLAP TRIM (role-safe)                                */
/* -------------------------------------------------------------------------- */
function canonKey(s) {
  return normalize(String(s || ""))
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

function trimOverlapWords(prevRaw, nextRaw) {
  const p = canonKey(prevRaw);
  const n = canonKey(nextRaw);
  if (!p || !n) return nextRaw;

  const pWords = p.split(" ");
  const nextCanonWords = canonKey(nextRaw).split(" ");
  const maxCheck = Math.min(14, pWords.length, nextCanonWords.length);

  for (let k = maxCheck; k >= 3; k--) {
    const pTail = pWords.slice(-k).join(" ");
    const nHead = nextCanonWords.slice(0, k).join(" ");
    if (pTail === nHead) {
      const origWords = normalize(nextRaw).split(" ");
      return origWords.slice(k).join(" ").trim();
    }
  }
  return nextRaw;
}

// Per-role last commit
const lastCommittedByRole = {
  interviewer: { key: "", at: 0, raw: "" },
  candidate:   { key: "", at: 0, raw: "" }
};

function resetRoleCommitState() {
  lastCommittedByRole.interviewer = { key: "", at: 0, raw: "" };
  lastCommittedByRole.candidate = { key: "", at: 0, raw: "" };
}

function addFinalSpeech(txt, role) {
  const cleanedRaw = normalize(txt);
  if (!cleanedRaw) return;

  const r = role === "interviewer" ? "interviewer" : "candidate";
  const now = Date.now();

  const prev = lastCommittedByRole[r];

  // Overlap trim vs prior final (same role)
  const trimmedRaw = prev.raw ? trimOverlapWords(prev.raw, cleanedRaw) : cleanedRaw;
  const trimmedKey = canonKey(trimmedRaw);
  if (!trimmedKey) return;

  // Strong dedupe (punctuation/case-insensitive)
  const tooSoon = now - (prev.at || 0) < 3000;
  const sameKey = trimmedKey === (prev.key || "");

  if (sameKey && tooSoon) return;

  prev.key = trimmedKey;
  prev.raw = trimmedRaw;
  prev.at = now;

  removeInterimIfAny();

  const gap = now - (lastSpeechAt || 0);

  if (!timeline.length || gap >= PAUSE_NEWLINE_MS) {
    timeline.push({ t: now, text: trimmedRaw, role: r });
  } else {
    const last = timeline[timeline.length - 1];

    // Merge only if same role; else new block
    if (last.role && last.role !== r) {
      timeline.push({ t: now, text: trimmedRaw, role: r });
    } else {
      last.text = normalize((last.text || "") + " " + trimmedRaw);
      last.t = now;
      last.role = r;
    }
  }

  lastSpeechAt = now;
  updateTranscript();
}

function addTypewriterSpeech(txt, msPerWord = SYS_TYPE_MS_PER_WORD, role = "interviewer") {
  const cleaned = normalize(txt);
  if (!cleaned) return;

  removeInterimIfAny();

  const now = Date.now();
  const gap = now - (lastSpeechAt || 0);

  let entry;
  if (!timeline.length || gap >= PAUSE_NEWLINE_MS) {
    entry = { t: now, text: "", role };
    timeline.push(entry);
  } else {
    entry = timeline[timeline.length - 1];

    // Merge only if same role
    if (entry.role && entry.role !== role) {
      entry = { t: now, text: "", role };
      timeline.push(entry);
    } else {
      if (entry.text) entry.text = normalize(entry.text) + " ";
      entry.t = now;
      entry.role = role;
    }
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

/* -------------------------------------------------------------------------- */
/* QUESTION HELPERS                                                             */
/* -------------------------------------------------------------------------- */
let recentTopics = [];

function updateTopicMemory(text) {
  const low = text.toLowerCase();
  const topics = [];

  if (low.match(/sql|tableau|powerbi|dataset|analytics|data|kpi|warehouse/)) topics.push("data");
  if (low.match(/java|python|code|string|reverse|algorithm|loop|array|function|character/)) topics.push("code");
  if (low.match(/selenium|playwright|bdd|test|automation|flaky/)) topics.push("testing");
  if (low.match(/role|responsibility|project|experience|team|stakeholder/)) topics.push("experience");

  recentTopics = [...new Set([...recentTopics, ...topics])].slice(-3);
}

function normalizeSpokenText(s) {
  const map = {
    "kod": "code",
    "coad": "code",
    "carecter": "character",
    "charactors": "characters",
    "flacky": "flaky",
    "analitics": "analytics",
    "statics": "statistics"
  };

  let out = s.toLowerCase();
  for (const k in map) {
    out = out.replace(new RegExp("\\b" + k + "\\b", "gi"), map[k]);
  }
  return out;
}

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
  const stop = new Set([
    "the","a","an","and","or","but","to","of","in","on","for","with","is","are","was","were",
    "about","explain","tell","me","please","your","my","current","project","can","could","this","that","it","as","at","by","from","into","over","how","what","why","when","where"
  ]);
  return s
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(w => w.length >= 4 && !stop.has(w))
    .slice(0, 8);
}

function isGenericProjectAsk(text) {
  const s = (text || "").toLowerCase().trim();
  return s.includes("current project") || s.includes("explain your current project") || s.includes("explain about your current project");
}

function isNewTopic(text) {
  const s = (text || "").toLowerCase().trim();

  // Social / filler resets
  if (/^(hi|hello|hey|thanks|thank you|cheers|okay|cool|alright)\b/.test(s)) return true;

  // Interview soft switches
  if (/tell me about|your project|your role|responsibilities|experience|walk me through|about your/i.test(s)) return true;

  // If it's not a coding sentence and it's longer than a few words → topic change
  const codeVerbs = ["reverse","count","sort","find","validate","check","convert","parse","remove","merge"];
  const hasCode = codeVerbs.some(v => s.includes(v));
  if (!hasCode && s.split(" ").length > 4) return true;

  return false;
}

function buildDraftQuestion(spoken) {
  // 1️⃣ Hard cleanup (kills Arabic, junk, filler)
  spoken = spoken
  .split(/[?.]/)[0]        // take only the first semantic sentence
  .trim();

  let s = normalizeSpokenText(normalize(spoken))
    .replace(/[^\x00-\x7F]/g, " ")           // remove Arabic, unicode junk
    .replace(/\b(you know|like|actually|basically|kind of|sort of|is it|right)\b/gi, " ")
    .replace(/\b(can you|could you|would you|please|let us know)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
     if (isNewTopic(s)) {
    activeIntent = null;
    activeTech = null;
  }

  if (!s) return "Q: Can you explain your current project end-to-end?";

  const low = s.toLowerCase();

  // 2️⃣ Detect language
  const techMatch = /(java|python|c\+\+|javascript|sql|selenium|playwright|bdd)/i.exec(low);
  if (techMatch) activeTech = techMatch[1].toLowerCase();

  // 3️⃣ Coding signals
  const CODE_VERBS = ["reverse","count","sort","find","check","validate","convert","remove","replace","merge"];
  const CODE_NOUNS = ["string","number","array","list","digits","vowels","palindrome","json","api"];

  const hasVerb = CODE_VERBS.some(v => low.includes(v));
  const hasNoun = CODE_NOUNS.some(n => low.includes(n));

  // 4️⃣ If user just said "java" or "python"
  if (!hasVerb && activeIntent === "code" && activeTech) {
    return `Q: Write ${activeTech} code for the previous problem and explain the logic.`;
  }

  // 5️⃣ Lock coding intent
  if (hasVerb && hasNoun) {
    activeIntent = "code";
    return `Q: Write ${activeTech || "a"} program to ${s} and explain the logic `;
  }

  // 6️⃣ Debug
  if (/error|issue|not working|failed|bug|timeout/.test(low)) {
    activeIntent = "debug";
    return `Q: How would you debug ${s} and what steps did you take in production?`;
  }

  // 7️⃣ Design
  if (/architecture|design|flow|system|microservice|pattern/.test(low)) {
    activeIntent = "design";
    return `Q: Explain the ${s} you designed and why this architecture was chosen.`;
  }

  // 8️⃣ Theory
  if (/what is|explain|define|theory/.test(low)) {
    activeIntent = "theory";
    return `Q: Can you explain ${s} with a real-world example?`;
  }

  // 9️⃣ Fallback using previous intent
  if (activeIntent === "code") {
    return `Q: Write ${activeTech || "a"} program related to ${s} and explain it.`;
  }

  return capitalizeQuestion(
  `Can you explain ${spoken} with a real project example`
);
}



function capitalizeQuestion(q) {
  q = q.replace(/\s+/g, " ").trim();
  q = q.charAt(0).toUpperCase() + q.slice(1);
  if (!q.endsWith("?")) q += "?";
  return q;
}


function buildInterviewQuestionPrompt(currentTextOnly) {
  const base = normalize(currentTextOnly);
  if (!base) return "";

  const priorQs = extractPriorQuestions();
  const domainBias = guessDomainBias((resumeTextMem || "") + "\n" + base);

  return `
You are answering a real technical interview question spoken by an interviewer.

MANDATORY:
- The question MUST appear at the top exactly once.
- Answer must sound like real production work already done.
- No role intro, no company narration, no generic theory.

FORMAT (STRICT):

Q: ${base}

ANSWERING STYLE:
- Start answering immediately.
- First person, past tense.
- Senior, execution-focused tone.
- Use dense, real implementation keywords naturally.
- No essay or teaching tone.

CONTENT REQUIREMENTS:
- Clearly state the challenge faced.
- Explain exactly what you implemented.
- Mention tools, configs, selectors, retries, thresholds, pipelines.
- Call out failures, edge cases, or instability handled.
- Include measurable or observable outcomes when applicable.

AVOID COMPLETELY:
- “In my current role…”
- “I had the opportunity…”
- Background explanations or definitions
- Generic statements without implementation depth

FORMATTING:
- Short paragraphs preferred.
- Bullets only if they genuinely improve clarity.
- Bold ONLY real tools, frameworks, configs, or metrics.

CONTEXT BIAS:
- Prefer domain relevance: ${domainBias || "software engineering"}.
- Avoid repeating these previously asked questions:
${priorQs.length ? priorQs.map(q => "- " + q).join("\n") : "- (none)"}
`.trim();
}


/* -------------------------------------------------------------------------- */
/* PROFILE                                                                      */
/* -------------------------------------------------------------------------- */
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

/* -------------------------------------------------------------------------- */
/* TOKEN + API                                                                  */
/* -------------------------------------------------------------------------- */
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

/* -------------------------------------------------------------------------- */
/* DEDUPE UTIL (tail-based)                                                     */
/* -------------------------------------------------------------------------- */
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

/* -------------------------------------------------------------------------- */
/* STREAMING ASR HELPERS                                                        */
/* -------------------------------------------------------------------------- */
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
  try { s.proc && (s.proc.onaudioprocess = null); } catch {}

  try { s.src && s.src.disconnect(); } catch {}
  try { s.proc && s.proc.disconnect(); } catch {}
  try { s.gain && s.gain.disconnect(); } catch {}
  try { s.ctx && s.ctx.close && s.ctx.close(); } catch {}

  if (which === "mic") micAsr = null;
  else sysAsr = null;
}

function asrUpsertDelta(which, itemId, deltaText) {
  const s = which === "mic" ? micAsr : sysAsr;
  if (!s) return;

  const now = Date.now();
  if (!s.itemText[itemId]) s.itemText[itemId] = "";
  s.itemText[itemId] += String(deltaText || "");
 const words = normalize(s.itemText[itemId]).split(" ");
if (words.length >= COMMIT_WORDS) {
  asrFinalizeItem(which, itemId, s.itemText[itemId]);
}

  const cur = normalize(s.itemText[itemId]);
  if (!cur) return;

  const role = (which === "sys") ? "interviewer" : "candidate";

  if (!s.itemEntry[itemId]) {
    const entry = { t: now, text: cur, role };
    s.itemEntry[itemId] = entry;
    timeline.push(entry);
  } else {
    s.itemEntry[itemId].text = cur;
    s.itemEntry[itemId].t = now;
    s.itemEntry[itemId].role = role;
  }

  lastSpeechAt = now;
  updateTranscript();
}

function asrFinalizeItem(which, itemId, transcript) {
  const s = which === "mic" ? micAsr : sysAsr;
  if (!s) return;

  const entry = s.itemEntry[itemId];
let draftText = "";

if (entry) {
  draftText = entry.text || "";
  const idx = timeline.indexOf(entry);
  if (idx >= 0) timeline.splice(idx, 1);
}

delete s.itemEntry[itemId];
delete s.itemText[itemId];

const final = normalize(transcript || draftText);
if (!final) return;

const role = (which === "sys") ? "interviewer" : "candidate";
addFinalSpeech(final, role);

}

function sendAsrConfig(ws) {
  const cfgA = {
    type: "transcription_session.update",
    input_audio_format: "pcm16",
    input_audio_transcription: {
  model: REALTIME_ASR_MODEL,
  language: "en-IN",
  prompt: TRANSCRIBE_PROMPT + 
    " Speaker has an Indian English accent. " +
    "Prefer Indian pronunciation and spelling. " +
    "Do not normalize to US English."
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
  const cfgB = {
    type: "session.update",
    session: {
      type: "transcription",
      audio: {
        input: {
          format: { type: "audio/pcm", rate: ASR_TARGET_RATE },
          transcription: {
  model: REALTIME_ASR_MODEL,
  language: "en-IN",
  prompt:
    TRANSCRIBE_PROMPT +
    " Speaker has an Indian English accent. " +
    "Use Indian pronunciation and spelling."
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
  if (which === "mic" && micMuted) return false;

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
    ws, ctx, src, proc, gain, queue,
    sendTimer: null,
    itemText: {},
    itemEntry: {},
    sawConfigError: false
  };

  if (which === "mic") micAsr = state;
  else sysAsr = state;

  proc.onaudioprocess = (e) => {
    if (!isRunning) return;
    if (which === "mic" && micMuted) return;
    if (ws.readyState !== 1) return;

    const ch0 = e.inputBuffer.getChannelData(0);
    const inRate = ctx.sampleRate || 48000;

    const resampled = resampleFloat32(ch0, inRate, ASR_TARGET_RATE);
    const bytes = floatToInt16Bytes(resampled);
    if (bytes.length) queue.push(bytes);
  };

  src.connect(proc);
  proc.connect(gain);
  gain.connect(ctx.destination);

  ws.onopen = () => {
    sendAsrConfig(ws);

    state.sendTimer = setInterval(() => {
      if (!isRunning) return;
      if (which === "mic" && micMuted) return;
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

    if (ev.type === "error") {
      const m = String(ev?.error?.message || ev?.message || "");
      if (!state.sawConfigError && m.toLowerCase().includes("transcription_session.update")) {
        state.sawConfigError = true;
        sendAsrConfigFallbackSessionUpdate(ws);
      }
      return;
    }

    if (ev.type === "conversation.item.input_audio_transcription.delta") {
      asrUpsertDelta(which, ev.item_id, ev.delta || "");
      return;
    }

    if (ev.type === "conversation.item.input_audio_transcription.completed") {
      asrFinalizeItem(which, ev.item_id, ev.transcript || "");
      return;
    }
  };

  return true;
}

/* -------------------------------------------------------------------------- */
/* MIC — SpeechRecognition + fallback                                           */
/* -------------------------------------------------------------------------- */
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
  if (micMuted) return false;
  if (!USE_BROWSER_SR) return false;

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
  recognition.lang = "en-IN";


  recognition.onstart = () => {
    setStatus(audioStatus, "Mic active (fast preview).", "text-green-600");
  };

  recognition.onresult = (ev) => {
    if (!isRunning) return;
    if (micMuted) return;
    if (Date.now() < blockMicUntil) return;

    lastMicResultAt = Date.now();

    let latestInterim = "";
    for (let i = ev.resultIndex; i < ev.results.length; i++) {
      const r = ev.results[i];
      const text = normalize(r[0].transcript || "");

      // IMPORTANT: keep SR as FINAL (candidate) as you had.
      // If you want max accuracy, you can disable SR final commits and rely on OpenAI ASR.
      if (r.isFinal) addFinalSpeech(text, "candidate");
      else latestInterim = text;
    }

    if (latestInterim) {
      removeInterimIfAny();
      micInterimEntry = { t: Date.now(), text: latestInterim, role: "candidate" };
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
    if (micMuted) return;
    setTimeout(() => {
      if (!isRunning) return;
      if (micMuted) return;
      try { recognition.start(); } catch {}
    }, 150);
  };

  lastMicResultAt = Date.now();

  if (micWatchdog) clearInterval(micWatchdog);
  micWatchdog = setInterval(() => {
    if (!isRunning) return;
    if (micMuted) return;

    if (micSrIsHealthy()) {
      // If SR healthy, stop fallbacks
      if (micRecorder || micStream) stopMicRecorderOnly();
      if (micAsr) stopAsrSession("mic");
      if (!USE_BROWSER_SR) return;
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
  if (micMuted) return;
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
  if (micMuted) return;
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
    if (micMuted) return;
    if (ev.data.size) micSegmentChunks.push(ev.data);
  };

  micRecorder.onstop = () => {
    if (!isRunning) return;
    if (micMuted) return;

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
    if (micMuted) return;
    try { micRecorder?.stop(); } catch {}
  }, MIC_SEGMENT_MS);
}

function drainMicQueue() {
  if (!isRunning) return;
  if (micMuted) return;

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
  if (micMuted) return;

  if (!res.ok) return;

  // CRITICAL DUPLICATE FIX:
  // If SR became healthy or streaming ASR is active, drop recorder results.
  if (micSrIsHealthy()) return;
  if (micAsr) return;

  const data = await res.json().catch(() => ({}));
  const raw = String(data.text || "");
  if (looksLikeWhisperHallucination(raw)) return;

  const cleaned = dedupeByTail(raw, {
    get value() { return lastMicTail; },
    set value(v) { lastMicTail = v; }
  });

  if (cleaned) addFinalSpeech(cleaned, "candidate");
}

/* -------------------------------------------------------------------------- */
/* SYSTEM AUDIO                                                                 */
/* -------------------------------------------------------------------------- */
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

// Legacy system audio pipeline (MediaRecorder -> /transcribe)
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
    showBanner("System audio requires selecting a window/tab and enabling “Share audio” in the picker.");
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

function trimOverlap(prev, next) {
  if (!prev || !next) return next;

  const p = normalize(prev).toLowerCase();
  const n = normalize(next).toLowerCase();

  const pWords = p.split(" ");
  const nWords = n.split(" ");

  const maxCheck = Math.min(12, pWords.length, nWords.length);

  for (let k = maxCheck; k >= 3; k--) {
    const pTail = pWords.slice(-k).join(" ");
    const nHead = nWords.slice(0, k).join(" ");

    if (pTail === nHead) {
      return nWords.slice(k).join(" ");
    }
  }
  return next;
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

  if (!cleaned) return;

  const now = Date.now();
  const text = normalize(cleaned);

  // FIX: compute trimmed BEFORE overwriting lastSysPrinted
  const trimmed = trimOverlap(lastSysPrinted, text);
  if (!trimmed) return;

  // Maintain a growing reference so overlap trimming stays stable
  lastSysPrinted = normalize((lastSysPrinted + " " + trimmed).trim());
  lastSysPrintedAt = now;

  addTypewriterSpeech(trimmed, SYS_TYPE_MS_PER_WORD, "interviewer");
}

/* -------------------------------------------------------------------------- */
/* CREDITS                                                                      */
/* -------------------------------------------------------------------------- */
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

/* -------------------------------------------------------------------------- */
/* CHAT STREAMING                                                               */
/* -------------------------------------------------------------------------- */
function abortChatStreamOnly(silent = true) {
  try { chatAbort?.abort(); } catch {}
  chatAbort = null;

  if (silent) setStatus(sendStatus, "Canceled (new request)", "text-orange-600");
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
  abortChatStreamOnly(true);

  chatAbort = new AbortController();
  chatStreamActive = true;
  const mySeq = ++chatStreamSeq;

  if (userTextForHistory) pushHistory("user", userTextForHistory);

  aiRawBuffer = "";
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

  const render = () => {
    responseBox.innerHTML = renderMarkdownLite(raw);
  };

  try {
    const res = await apiFetch(
      "chat/send",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "text/plain" },
        body: JSON.stringify(body),
        signal: chatAbort.signal
      },
      false
    );

    if (!res.ok) throw new Error(await res.text());
    if (!res.body) throw new Error("No stream body");

    const reader = res.body.getReader();
    const decoder = new TextDecoder();

    flushTimer = setInterval(() => {
      if (mySeq !== chatStreamSeq) return;
      if (!sawFirstChunk) return;
      render();
    }, 30);

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      if (mySeq !== chatStreamSeq) return;

      raw += decoder.decode(value, { stream: true });

      if (!sawFirstChunk) {
        sawFirstChunk = true;
        responseBox.innerHTML = "";
        setStatus(sendStatus, "Receiving…", "text-orange-600");
      }

      if (raw.length < 1800) render();
    }

    if (mySeq === chatStreamSeq) {
      render();
      setStatus(sendStatus, "Done", "text-green-600");
      pushHistory("assistant", raw);
    }
  } catch (e) {
    if (e?.name === "AbortError" || chatAbort?.signal?.aborted) return;

    console.error(e);
    setStatus(sendStatus, "Failed", "text-red-600");
    responseBox.innerHTML =
      `<span class="text-red-600 text-sm">Failed. Check backend /chat/send streaming.</span>`;
  } finally {
    if (flushTimer) clearInterval(flushTimer);
    if (mySeq === chatStreamSeq) chatStreamActive = false;
  }
}

/* -------------------------------------------------------------------------- */
/* RESUME UPLOAD                                                                */
/* -------------------------------------------------------------------------- */
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

/* -------------------------------------------------------------------------- */
/* START / STOP                                                                 */
/* -------------------------------------------------------------------------- */
async function startAll() {
  const micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
await startStreamingAsr("mic", micStream);
  hideBanner();
  if (isRunning) return;

  await apiFetch("chat/reset", { method: "POST" }, false).catch(() => {});

  transcriptEpoch++;
  timeline = [];
  micInterimEntry = null;
  lastSpeechAt = 0;
  sentCursor = 0;
  pinnedTop = true;

  lastSysTail = "";
  lastMicTail = "";
  lastSysPrinted = "";
  lastSysPrintedAt = 0;
  resetRoleCommitState();

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

  if (!micMuted) {
    const micOk = false;
    if (!micOk) {
      setStatus(audioStatus, "Mic SR not available. Trying streaming ASR…", "text-orange-600");
      if (USE_STREAMING_ASR_MIC_FALLBACK) await enableMicStreamingFallback().catch(() => {});
      if (!micAsr && !micStream) {
        setStatus(audioStatus, "Mic streaming ASR not available. Using fallback recorder…", "text-orange-600");
        await enableMicRecorderFallback().catch(() => {});
      }
    }

    setTimeout(() => {
      if (!isRunning) return;
      if (micMuted) return;
      if (micSrIsHealthy()) return;

      if (USE_STREAMING_ASR_MIC_FALLBACK && !micAsr && !micStream) {
        enableMicStreamingFallback().catch(() => {});
        return;
      }
      if (!micStream) enableMicRecorderFallback().catch(() => {});
    }, 2000);
  } else {
    setStatus(audioStatus, "Mic is OFF. Press System Audio to capture system audio.", "text-orange-600");
  }

  startCreditTicking();
}

function stopAll() {
  isRunning = false;

  stopMicOnly();
  stopMicRecorderOnly();
  stopSystemAudioOnly();

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

/* -------------------------------------------------------------------------- */
/* HARD CLEAR                                                                   */
/* -------------------------------------------------------------------------- */
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
  lastSysPrinted = "";
  lastSysPrintedAt = 0;
  resetRoleCommitState();

  if (micAsr) { micAsr.itemText = {}; micAsr.itemEntry = {}; }
  if (sysAsr) { sysAsr.itemText = {}; sysAsr.itemEntry = {}; }

  timeline = [];
  micInterimEntry = null;
  lastSpeechAt = 0;
  sentCursor = 0;
  pinnedTop = true;

  updateTranscript();
}

/* -------------------------------------------------------------------------- */
/* SEND / CLEAR / RESET                                                        */
/* -------------------------------------------------------------------------- */
function looksCompleteQuestion(s) {
  if (!s) return false;
  if (s.length < 12) return false;
  if (!/[?.]$/.test(s)) return false;
  return true;
}
async function handleSend() {
  if (sendBtn.disabled) return;

  const manual = normalize(manualQuestion?.value || "");
  const quickSnap = getQuickInterviewerSnapshot();
  const freshInterviewer = normalize(
  timeline
    .filter(b => b.role === "interviewer")
    .slice(-2)                    // last 1–2 interviewer turns only
    .map(b => b.text)
    .join(" ")
);

  let base = "";

  if (manual) {
    base = manual;
  } else if (quickSnap) {
    base = quickSnap.text;
    lastQuickInterviewerAt = quickSnap.at; // 🔐 freshness gate
  } else {
    base = freshInterviewer;
  }

  if (!base) return; // ⛔ restores original “wait for new text” behavior
if (!looksCompleteQuestion(base)) return;
  updateTopicMemory(base);
  const question = buildDraftQuestion(base);

  if (manualQuestion) manualQuestion.value = "";

  // IMPORTANT: identical to click behavior
  abortChatStreamOnly(true);

  blockMicUntil = Date.now() + 700;
  removeInterimIfAny();

  sentCursor = timeline.length;
  pinnedTop = true;
  updateTranscript();

  const draftQ = question;
  responseBox.innerHTML = renderMarkdownLite(
    `${draftQ}\n\n_Generating answer…_`
  );
  setStatus(sendStatus, "Queued…", "text-orange-600");

  const mode = modeSelect?.value || "interview";
  const promptToSend =
    mode === "interview"
      ? buildInterviewQuestionPrompt(question.replace(/^Q:\s*/i, ""))
      : question;

  await startChatStreaming(promptToSend, base);
}


sendBtn.onclick = handleSend;
/* -------------------------------------------------------------------------- */
/* GLOBAL ENTER = SEND (page-wide)                                             */
/* -------------------------------------------------------------------------- */
/* -------------------------------------------------------------------------- */
/* GLOBAL ENTER = SEND (MATCHES CLICK 1:1)                                     */
/* -------------------------------------------------------------------------- */
document.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" || e.shiftKey) return;

  e.preventDefault();
  handleSend(); // direct call, no extra guards
});


/* -------------------------------------------------------------------------- */
/* ENTER KEY = SEND (manualQuestion)                                           */
/* -------------------------------------------------------------------------- */
/* -------------------------------------------------------------------------- */
/* ENTER KEY = SEND (manualQuestion + liveTranscript)                          */
/* -------------------------------------------------------------------------- */
function handleEnterToSend(e) {
  // Enter = Send, Shift+Enter = allow newline (where applicable)
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();

    if (sendBtn && !sendBtn.disabled) {
      sendBtn.click(); // single source of truth
    }
  }
}



clearBtn.onclick = () => {
  hardClearTranscript();
  if (manualQuestion) manualQuestion.value = "";
  setStatus(sendStatus, "Transcript cleared", "text-green-600");
  setStatus(audioStatus, isRunning ? "Listening…" : "Stopped", isRunning ? "text-green-600" : "text-orange-600");
};

resetBtn.onclick = async () => {
  responseBox.innerHTML = "";
  setStatus(sendStatus, "Response reset", "text-green-600");
  await apiFetch("chat/reset", { method: "POST" }, false).catch(() => {});
};

/* -------------------------------------------------------------------------- */
/* LOGOUT                                                                       */
/* -------------------------------------------------------------------------- */
document.getElementById("logoutBtn").onclick = () => {
  chatHistory = [];
  resumeTextMem = "";
  stopAll();
  localStorage.removeItem("session");
  window.location.href = "/auth?tab=login";
};

/* -------------------------------------------------------------------------- */
/* PAGE LOAD                                                                    */
/* -------------------------------------------------------------------------- */
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
  lastSysPrinted = "";
  lastSysPrintedAt = 0;
  resetRoleCommitState();

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

  updateMicMuteUI();
});

/* -------------------------------------------------------------------------- */
/* BUTTONS                                                                      */
/* -------------------------------------------------------------------------- */
startBtn.onclick = startAll;
stopBtn.onclick = stopAll;
sysBtn.onclick = enableSystemAudio;