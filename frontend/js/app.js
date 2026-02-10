/* ========================================================================== */
/* app.js — PATCHED (drop-in replacement)                                      */
/* FIXES APPLIED:                                                              */
/*  1) USE_BROWSER_SR defined (was undefined → ReferenceError)                 */
/*  2) startAll() used hardcoded `const micOk = false` → now calls startMic() */
/*  3) handleEnterToSend never attached to manualQuestion → now attached       */
/*  4) Mic fully disabled — only system audio per user requirement             */
/* ========================================================================== */

/* ★ FEATURE FLAGS — defined ONCE at top */
const USE_BROWSER_SR               = false;  // FIX #1 + #4: mic OFF entirely
const USE_STREAMING_ASR_SYS        = true;
const USE_STREAMING_ASR_MIC_FALLBACK = false;

/* -------------------------------------------------------------------------- */
/* BASIC TEXT HELPERS                                                          */
/* -------------------------------------------------------------------------- */
function normalize(s) { return (s || "").replace(/\s+/g, " ").trim(); }

function escapeHtml(s) {
  return String(s || "")
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#039;");
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

function renderMarkdownLite(md) {
  if (!md) return "";
  let safe = String(md).replace(/<br\s*\/?>/gi, "\n");
  safe = fixSpacingOutsideCodeBlocks(safe);
  safe = escapeHtml(safe);
  safe = safe.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
  safe = safe.replace(/\r\n/g, "\n").replace(/\n\s*\n/g, "<br><br>").replace(/\n/g, "<br>");
  return safe.trim();
}

/* -------------------------------------------------------------------------- */
/* MARKDOWN / CODE BLOCKS                                                      */
/* -------------------------------------------------------------------------- */
let aiRawBuffer = "";

function setupMarkdownRenderer() {
  if (!window.marked || !window.hljs || !window.DOMPurify) return;
  marked.setOptions({
    gfm: true, breaks: true,
    highlight: (code, lang) => {
      try {
        if (lang && hljs.getLanguage(lang)) return hljs.highlight(code, { language: lang }).value;
        return hljs.highlightAuto(code).value;
      } catch { return code; }
    }
  });
}

function renderMarkdownSafe(mdText) {
  if (!window.marked || !window.DOMPurify) return renderMarkdownLite(mdText);
  return DOMPurify.sanitize(marked.parse(mdText || ""));
}

function enhanceCodeBlocks(containerEl) {
  if (!containerEl) return;
  containerEl.querySelectorAll("pre").forEach((pre) => {
    if (pre.querySelector(".code-actions")) return;
    const toolbar = document.createElement("div");
    toolbar.className = "code-actions";
    const btn = document.createElement("button");
    btn.className = "code-btn"; btn.type = "button"; btn.textContent = "Copy";
    btn.addEventListener("click", async () => {
      const text = (pre.querySelector("code") || pre).innerText;
      try { await navigator.clipboard.writeText(text); btn.textContent = "Copied"; }
      catch { btn.textContent = "Failed"; }
      setTimeout(() => (btn.textContent = "Copy"), 900);
    });
    toolbar.appendChild(btn); pre.appendChild(toolbar);
  });
}

function finalizeRenderedResponse() {
  responseBox.innerHTML = renderMarkdownSafe(aiRawBuffer);
  if (window.hljs) responseBox.querySelectorAll("pre code").forEach(b => { try { hljs.highlightElement(b); } catch {} });
  enhanceCodeBlocks(responseBox);
}

document.addEventListener("DOMContentLoaded", setupMarkdownRenderer);

/* -------------------------------------------------------------------------- */
/* DOM REFS                                                                    */
/* -------------------------------------------------------------------------- */
const userInfo        = document.getElementById("userInfo");
const instructionsBox = document.getElementById("instructionsBox");
const instrStatus     = document.getElementById("instrStatus");
const resumeInput     = document.getElementById("resumeInput");
const resumeStatus    = document.getElementById("resumeStatus");
const liveTranscript  = document.getElementById("liveTranscript");
const manualQuestion  = document.getElementById("manualQuestion");
const responseBox     = document.getElementById("responseBox");
const startBtn        = document.getElementById("startBtn");
const stopBtn         = document.getElementById("stopBtn");
const sysBtn          = document.getElementById("sysBtn");
const clearBtn        = document.getElementById("clearBtn");
const resetBtn        = document.getElementById("resetBtn");
const audioStatus     = document.getElementById("audioStatus");
const sendBtn         = document.getElementById("sendBtn");
const sendStatus      = document.getElementById("sendStatus");
const bannerTop       = document.getElementById("bannerTop");
const modeSelect      = document.getElementById("modeSelect");
const micMuteBtn      = document.getElementById("micMuteBtn");

/* -------------------------------------------------------------------------- */
/* STATE                                                                       */
/* -------------------------------------------------------------------------- */
let session = null, isRunning = false, hiddenInstructions = "";

// Mic always muted — vars kept so nothing crashes
let micMuted = true, recognition = null, blockMicUntil = 0;
let micInterimEntry = null, lastMicResultAt = 0, micWatchdog = null;
let micStream = null, micTrack = null, micRecorder = null;
let micSegmentChunks = [], micSegmentTimer = null, micQueue = [], micAbort = null, micInFlight = 0;

// System audio
let sysStream = null, sysTrack = null, sysRecorder = null;
let sysSegmentChunks = [], sysSegmentTimer = null, sysQueue = [], sysAbort = null, sysInFlight = 0;
let sysErrCount = 0, sysErrBackoffUntil = 0;

// Dedupe
let lastSysTail = "", lastMicTail = "", lastSysPrinted = "", lastSysPrintedAt = 0;

// Timeline
let timeline = [], lastSpeechAt = 0, sentCursor = 0, pinnedTop = true;

// Credits
let creditTimer = null, lastCreditAt = 0;

// Chat
let chatAbort = null, chatStreamActive = false, chatStreamSeq = 0;
let chatHistory = [], resumeTextMem = "", transcriptEpoch = 0;

/* -------------------------------------------------------------------------- */
/* CONSTANTS                                                                   */
/* -------------------------------------------------------------------------- */
const PAUSE_NEWLINE_MS     = 3000;
const MIC_SEGMENT_MS       = 1200;
const MIC_MIN_BYTES        = 1800;
const MIC_MAX_CONCURRENT   = 2;
const SYS_SEGMENT_MS       = 2800;
const SYS_MIN_BYTES        = 6000;
const SYS_MAX_CONCURRENT   = 1;
const SYS_TYPE_MS_PER_WORD = 18;
const SYS_ERR_MAX          = 3;
const SYS_ERR_BACKOFF_MS   = 10000;
const CREDIT_BATCH_SEC     = 5;
const CREDITS_PER_SEC      = 1;
const MIC_LANGS = ["en-IN", "en-GB", "en-US"];
let micLangIndex = 0;

const TRANSCRIBE_PROMPT = `Transcribe English accurately for both Indian and American accents.
CRITICAL: Listen carefully and transcribe EXACTLY what is spoken.
ACCENT HANDLING:
- Indian English: "shed-yool" (schedule), "vit-amin" (vitamin), "al-go-rithm" (algorithm)
- American English: Standard pronunciations
TECHNICAL VOCABULARY (MUST RECOGNIZE ACCURATELY):
Software Testing: BDD (Behavior Driven Development), TDD, Selenium, Playwright, Cucumber, Robot Framework, pytest, JUnit
Microservices/Backend: orchestrator, gRPC, REST API, circuit breaker, Kafka, Redis, PostgreSQL, MongoDB, Cassandra, API Gateway, Lambda, JWT, OAuth, SAML
Frontend/General: React, Angular, Vue, TypeScript, JavaScript, Docker, Kubernetes, Jenkins, CI/CD, AWS, Azure, GCP
STRICT ANTI-HALLUCINATION RULES:
- Do NOT add: "Thanks for watching", "Subscribe", "Please like"
- Do NOT translate Hindi/Telugu/Tamil - drop non-English completely
- Do NOT repeat phrases or sentences
- Do NOT add words not spoken
- Do NOT guess unclear words - omit them
- If very uncertain, output empty string rather than wrong words
DUPLICATE PREVENTION: Do NOT output the same sentence twice.
Indian names are valid: Chetan, Shiva, Rahul, Priya, Aditya, Manne, Kumar, Singh
TRANSCRIBE EXACTLY WHAT IS SPOKEN. ACCURACY OVER SPEED.`;

/* -------------------------------------------------------------------------- */
/* STREAMING ASR                                                               */
/* -------------------------------------------------------------------------- */
const REALTIME_INTENT_URL = "wss://api.openai.com/v1/realtime?intent=transcription";
const REALTIME_ASR_MODEL  = "gpt-4o-mini-transcribe";
const ASR_SEND_EVERY_MS   = 40;
const ASR_TARGET_RATE     = 24000;
let realtimeSecretCache = null, micAsr = null, sysAsr = null;

/* -------------------------------------------------------------------------- */
/* MODE INSTRUCTIONS                                                           */
/* -------------------------------------------------------------------------- */
const MODE_INSTRUCTIONS = {
  general: "", interview: "",
  sales: "Respond in persuasive, value-driven style.\nHighlight benefits/outcomes."
};

/* -------------------------------------------------------------------------- */
/* UI HELPERS                                                                  */
/* -------------------------------------------------------------------------- */
function showBanner(msg) { if (!bannerTop) return; bannerTop.textContent = msg; bannerTop.classList.remove("hidden"); bannerTop.classList.add("bg-red-600"); }
function hideBanner()    { if (!bannerTop) return; bannerTop.classList.add("hidden"); bannerTop.textContent = ""; }
function setStatus(el, text, cls = "") { if (!el) return; el.textContent = text; el.className = cls; }
function authHeaders()   { const t = session?.access_token; return t ? { Authorization: `Bearer ${t}` } : {}; }

/* -------------------------------------------------------------------------- */
/* MIC MUTE UI — always OFF, button inert (system-audio-only mode)            */
/* -------------------------------------------------------------------------- */
function updateMicMuteUI() {
  if (!micMuteBtn) return;
  micMuteBtn.textContent = "Mic: OFF";
  micMuteBtn.classList.remove("bg-gray-700");
  micMuteBtn.classList.add("bg-gray-900");
  micMuteBtn.title = "Mic disabled — system audio only";
}
function stopMicPipelinesOnly() {
  try { recognition?.stop(); } catch {} recognition = null;
  if (micWatchdog) clearInterval(micWatchdog); micWatchdog = null;
  stopAsrSession("mic"); stopMicRecorderOnly(); removeInterimIfAny();
}
// FIX #4: mic toggle is a no-op
async function setMicMuted(on) { micMuted = true; updateMicMuteUI(); }
if (micMuteBtn) { micMuteBtn.addEventListener("click", () => {}); updateMicMuteUI(); }

/* -------------------------------------------------------------------------- */
/* MODE APPLY                                                                  */
/* -------------------------------------------------------------------------- */
function applyModeInstructions() {
  const mode = modeSelect?.value || "interview";
  hiddenInstructions = MODE_INSTRUCTIONS[mode] || "";
  if (!instructionsBox || !instrStatus) return;
  if (mode === "general") {
    instructionsBox.disabled = false;
    instrStatus.textContent = "You can enter custom instructions.";
  } else {
    instructionsBox.disabled = true; instructionsBox.value = "";
    instrStatus.textContent = `${mode.charAt(0).toUpperCase() + mode.slice(1)} mode selected. Custom instructions disabled.`;
  }
  setTimeout(() => (instrStatus.textContent = ""), 900);
}
if (modeSelect) { modeSelect.addEventListener("change", applyModeInstructions); modeSelect.value = modeSelect.value || "interview"; applyModeInstructions(); }
function getEffectiveInstructions() {
  const mode = modeSelect?.value || "interview";
  if (mode === "interview" || mode === "sales") return hiddenInstructions;
  return (instructionsBox?.value || "").trim() || (localStorage.getItem("instructions") || "").trim();
}

/* -------------------------------------------------------------------------- */
/* TRANSCRIPT RENDER                                                           */
/* -------------------------------------------------------------------------- */
if (liveTranscript) liveTranscript.addEventListener("scroll", () => { pinnedTop = liveTranscript.scrollTop <= 40; }, { passive: true });

function getAllBlocksNewestFirst() {
  return timeline.slice().sort((a, b) => (b.t || 0) - (a.t || 0)).map(x => String(x.text || "").trim()).filter(Boolean);
}
function getFreshBlocksText() {
  return timeline.slice(sentCursor).filter(x => x && x !== micInterimEntry).map(x => String(x.text || "").trim()).filter(Boolean).join("\n\n").trim();
}
function getFreshInterviewerBlocksText() {
  return timeline.slice(sentCursor).filter(x => x && x.role === "interviewer").map(x => String(x.text || "").trim()).filter(Boolean).join("\n\n").trim();
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
/* DEDUPE / OVERLAP TRIM                                                       */
/* -------------------------------------------------------------------------- */
function canonKey(s) {
  return normalize(String(s || "")).toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, "").replace(/\s+/g, " ").trim();
}
function trimOverlapWords(prevRaw, nextRaw) {
  if (!prevRaw || !nextRaw) return nextRaw;
  const pWords = canonKey(prevRaw).split(" "), nWords = canonKey(nextRaw).split(" ");
  const max = Math.min(14, pWords.length, nWords.length);
  for (let k = max; k >= 3; k--) {
    if (pWords.slice(-k).join(" ") === nWords.slice(0, k).join(" "))
      return normalize(nextRaw).split(" ").slice(k).join(" ").trim();
  }
  return nextRaw;
}
const lastCommittedByRole = { interviewer: { key: "", at: 0, raw: "" }, candidate: { key: "", at: 0, raw: "" } };
function resetRoleCommitState() { lastCommittedByRole.interviewer = { key: "", at: 0, raw: "" }; lastCommittedByRole.candidate = { key: "", at: 0, raw: "" }; }

function addFinalSpeech(txt, role) {
  const cleanedRaw = normalize(txt); if (!cleanedRaw) return;
  const r = role === "interviewer" ? "interviewer" : "candidate";
  const now = Date.now(), prev = lastCommittedByRole[r];
  const trimmedRaw = prev.raw ? trimOverlapWords(prev.raw, cleanedRaw) : cleanedRaw;
  const trimmedKey = canonKey(trimmedRaw); if (!trimmedKey) return;
  if (trimmedKey === (prev.key || "") && now - (prev.at || 0) < 3000) return;
  prev.key = trimmedKey; prev.raw = trimmedRaw; prev.at = now;
  removeInterimIfAny();
  const gap = now - (lastSpeechAt || 0);
  if (!timeline.length || gap >= PAUSE_NEWLINE_MS) {
    timeline.push({ t: now, text: trimmedRaw, role: r });
  } else {
    const last = timeline[timeline.length - 1];
    if (last.role && last.role !== r) timeline.push({ t: now, text: trimmedRaw, role: r });
    else { last.text = normalize((last.text || "") + " " + trimmedRaw); last.t = now; last.role = r; }
  }
  lastSpeechAt = now; updateTranscript();
}

function addTypewriterSpeech(txt, msPerWord = SYS_TYPE_MS_PER_WORD, role = "interviewer") {
  const cleaned = normalize(txt); if (!cleaned) return;
  removeInterimIfAny();
  const now = Date.now(), gap = now - (lastSpeechAt || 0);
  let entry;
  if (!timeline.length || gap >= PAUSE_NEWLINE_MS) { entry = { t: now, text: "", role }; timeline.push(entry); }
  else {
    entry = timeline[timeline.length - 1];
    if (entry.role && entry.role !== role) { entry = { t: now, text: "", role }; timeline.push(entry); }
    else { if (entry.text) entry.text = normalize(entry.text) + " "; entry.t = now; entry.role = role; }
  }
  lastSpeechAt = now;
  const words = cleaned.split(" "); let i = 0;
  const timer = setInterval(() => {
    if (!isRunning) return clearInterval(timer);
    if (i >= words.length) return clearInterval(timer);
    entry.text += (entry.text && !entry.text.endsWith(" ") ? " " : "") + words[i++];
    updateTranscript();
  }, msPerWord);
}

/* -------------------------------------------------------------------------- */
/* QUESTION HELPERS                                                            */
/* -------------------------------------------------------------------------- */
let recentTopics = [];
function updateTopicMemory(text) {
  const low = text.toLowerCase(), topics = [];
  if (low.match(/sql|tableau|powerbi|dataset|analytics|data|kpi|warehouse/)) topics.push("data");
  if (low.match(/java|python|code|string|reverse|algorithm|loop|array|function|character/)) topics.push("code");
  if (low.match(/selenium|playwright|bdd|test|automation|flaky/)) topics.push("testing");
  if (low.match(/role|responsibility|project|experience|team|stakeholder/)) topics.push("experience");
  recentTopics = [...new Set([...recentTopics, ...topics])].slice(-3);
}
function extractPriorQuestions() {
  const qs = [];
  for (const m of chatHistory.slice(-30)) {
    if (m.role !== "assistant") continue;
    const m1 = String(m.content || "").match(/(?:^|\n)Q:\s*([^\n<]+)/i);
    if (m1?.[1]) qs.push(normalize(m1[1]).slice(0, 240));
  }
  return Array.from(new Set(qs)).slice(-8);
}
function isWellFormedQuestion(text) {
  const t = text.trim();
  if (/^(can you|could you|would you|how do|how does|what is|what are|why|when|where|which|who)\b/i.test(t)) return true;
  if (t.endsWith('?') && t.split(' ').length >= 5) return true;
  return false;
}
function detectQuestionIntent(text) {
  const low = text.toLowerCase();
  if (/after .+ then|step by step|process|workflow|flow/.test(low))            return { type: 'workflow' };
  if (/how .+ work|how .+ communicate|how .+ handle|how .+ manage/.test(low))  return { type: 'mechanism' };
  if (/difference|compare|versus|vs\b|better than/.test(low))                  return { type: 'comparison' };
  if (/error|issue|problem|fail|timeout|bug|not working/.test(low))            return { type: 'debug' };
  if (/architect|design|structure|pattern|approach/.test(low))                 return { type: 'design' };
  if (/circuit breaker|retry|cache|queue|orchestrat|grpc|rest api|kafka|redis|postgres/.test(low)) return { type: 'implementation' };
  if (/write|code|program|implement|function|algorithm/.test(low))             return { type: 'code' };
  if (/what is|what are|define|meaning of/.test(low))                          return { type: 'definition' };
  if (/your project|your work|your role|your experience|you did|you worked/.test(low)) return { type: 'experience' };
  return { type: 'general' };
}
function detectTech(text) {
  const low = text.toLowerCase();
  const techs = { Java:/\bjava\b/, Python:/\bpython\b/, JavaScript:/\b(javascript|js|node)\b/, TypeScript:/\btypescript\b/, SQL:/\bsql\b/, React:/\breact\b/, Spring:/\bspring\b/ };
  for (const [n, p] of Object.entries(techs)) if (p.test(low)) return n;
  return null;
}
function extractCore(text) {
  return text.trim()
    .replace(/^(so|like|basically|uh|um|well|okay|alright|yeah)\b,?\s*/gi, '')
    .replace(/\s+(right|okay|you know|like that|basically|sort of)$/gi, '')
    .replace(/\blike,?\s+/gi, ' ')
    .replace(/we did the hand with\s+/gi, '').replace(/we have\s+/gi, '').replace(/you have\s+/gi, '')
    .replace(/\s+/g, ' ').trim();
}
function formatAsQuestion(text) {
  let q = text.trim();
  q = q.charAt(0).toUpperCase() + q.slice(1);
  if (!q.endsWith('?')) q += '?';
  if (!q.startsWith('Q:')) q = 'Q: ' + q;
  return q;
}
function frameQuestion(text, intent) {
  const core = extractCore(text);
  switch (intent.type) {
    case 'workflow':       return `Q: Walk me through ${core}`;
    case 'mechanism':      return /^how /i.test(text) ? formatAsQuestion(text) : `Q: How does ${core} work?`;
    case 'comparison':     return `Q: What's ${core}?`;
    case 'debug':          return `Q: How would you troubleshoot ${core}?`;
    case 'design':         return `Q: What ${core} did you design and why?`;
    case 'implementation': return `Q: How did you implement ${core}?`;
    case 'code':           const tech = detectTech(text); return `Q: Write ${tech ? tech + ' code' : 'a program'} to ${core}`;
    case 'definition':     return formatAsQuestion(text);
    case 'experience':     return `Q: Can you describe ${core}?`;
    default:
      if (detectTech(core)) return `Q: How did you work with ${core}?`;
      if (core.split(' ').length <= 3) return `Q: What is ${core}?`;
      return `Q: Can you describe ${core}?`;
  }
}
function buildDraftQuestion(spoken) {
  const cleaned = normalize(spoken).replace(/\s+/g, " ").trim();
  if (!cleaned) return "Q: Can you walk me through your current project?";
  if (isWellFormedQuestion(cleaned)) return formatAsQuestion(cleaned);
  return frameQuestion(cleaned, detectQuestionIntent(cleaned));
}
function buildInterviewQuestionPrompt(currentTextOnly) {
  const base = normalize(currentTextOnly); if (!base) return "";
  const priorQs = extractPriorQuestions();
  return priorQs.length ? `Previously asked:\n${priorQs.map(q => "- " + q).join("\n")}\n\n${base}` : base;
}

/* -------------------------------------------------------------------------- */
/* PROFILE                                                                     */
/* -------------------------------------------------------------------------- */
async function loadUserProfile() {
  try {
    const res = await apiFetch("user/profile", {}, true), data = await res.json().catch(() => ({}));
    if (!res.ok || !data?.user) { userInfo.innerHTML = `<span class='text-red-600 text-sm'>Unable to load profile</span>`; return; }
    const u = data.user;
    userInfo.innerHTML = `<div class="text-sm text-gray-800 truncate"><b>${u.email || "N/A"}</b><span class="ml-3">Credits: <b>${u.credits ?? 0}</b></span></div>`;
  } catch { userInfo.innerHTML = `<span class='text-red-600 text-sm'>Error loading profile</span>`; }
}

/* -------------------------------------------------------------------------- */
/* TOKEN + API                                                                 */
/* -------------------------------------------------------------------------- */
function isTokenNearExpiry() { const exp = Number(session?.expires_at || 0); return exp && Math.floor(Date.now() / 1000) > exp - 60; }
async function refreshAccessToken() {
  const rt = session?.refresh_token; if (!rt) throw new Error("Missing refresh_token");
  const res = await fetch("/api?path=auth/refresh", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ refresh_token: rt }) });
  const data = await res.json().catch(() => ({})); if (!res.ok) throw new Error(data.error || "Refresh failed");
  session.access_token = data.session.access_token; session.refresh_token = data.session.refresh_token; session.expires_at = data.session.expires_at;
  localStorage.setItem("session", JSON.stringify(session));
}
async function apiFetch(path, opts = {}, needAuth = true) {
  if (needAuth && isTokenNearExpiry()) { try { await refreshAccessToken(); } catch {} }
  const headers = { ...(opts.headers || {}) }; if (needAuth) Object.assign(headers, authHeaders());
  const res = await fetch(`/api?path=${encodeURIComponent(path)}`, { ...opts, headers, cache: "no-store" });
  if (needAuth && res.status === 401) {
    const t = await res.text().catch(() => "");
    if (t.includes("token is expired") || t.includes("invalid JWT") || t.includes("Missing token")) {
      await refreshAccessToken();
      return fetch(`/api?path=${encodeURIComponent(path)}`, { ...opts, headers: { ...(opts.headers || {}), ...authHeaders() }, cache: "no-store" });
    }
  }
  return res;
}

/* -------------------------------------------------------------------------- */
/* DEDUPE UTIL (tail)                                                          */
/* -------------------------------------------------------------------------- */
function dedupeByTail(text, tailRef) {
  const t = normalize(text); if (!t) return "";
  const tail = tailRef.value || "";
  if (!tail) { tailRef.value = t.split(" ").slice(-12).join(" "); return t; }
  if (t.length <= 180 && tail.toLowerCase().includes(t.toLowerCase())) return "";
  const tW = tail.split(" "), nW = t.split(" "); let best = 0;
  for (let k = Math.min(10, tW.length, nW.length); k >= 3; k--) {
    if (tW.slice(-k).join(" ").toLowerCase() === nW.slice(0, k).join(" ").toLowerCase()) { best = k; break; }
  }
  const cleaned = best ? nW.slice(best).join(" ") : t;
  tailRef.value = (tail + " " + cleaned).trim().split(" ").slice(-12).join(" ");
  return normalize(cleaned);
}
function looksLikeWhisperHallucination(t) {
  const s = normalize(t).toLowerCase(); if (!s) return true;
  const noise = ["thanks for watching","thank you for watching","subscribe","please like and subscribe","transcribe clearly in english","handle indian","i don't know","i dont know","this is microphone speech"];
  if (s.length < 40 && (s.endsWith("i don't know.") || s.endsWith("i dont know"))) return true;
  return noise.some(p => s.includes(p));
}

/* -------------------------------------------------------------------------- */
/* STREAMING ASR HELPERS                                                       */
/* -------------------------------------------------------------------------- */
function base64FromBytes(u8) {
  let bin = ""; const chunk = 0x8000;
  for (let i = 0; i < u8.length; i += chunk) bin += String.fromCharCode(...u8.subarray(i, i + chunk));
  return btoa(bin);
}
function floatToInt16Bytes(f32) {
  const out = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i++) { const s = Math.max(-1, Math.min(1, f32[i])); out[i] = s < 0 ? s * 0x8000 : s * 0x7fff; }
  return new Uint8Array(out.buffer);
}
function resampleFloat32(inp, inR, outR) {
  if (!inp?.length) return new Float32Array(0); if (inR === outR) return inp;
  const ratio = inR / outR, len = Math.max(1, Math.floor(inp.length / ratio)), out = new Float32Array(len);
  for (let i = 0; i < len; i++) { const idx = i * ratio, i0 = Math.floor(idx), i1 = Math.min(i0 + 1, inp.length - 1), f = idx - i0; out[i] = inp[i0] * (1 - f) + inp[i1] * f; }
  return out;
}
async function getRealtimeClientSecretCached() {
  const now = Math.floor(Date.now() / 1000);
  if (realtimeSecretCache?.value && (realtimeSecretCache.expires_at || 0) - now > 30) return realtimeSecretCache.value;
  const res = await apiFetch("realtime/client_secret", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ttl_sec: 600 }) }, true);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data?.value) throw new Error(data?.error || "Failed to get realtime client secret");
  realtimeSecretCache = { value: data.value, expires_at: data.expires_at || 0 };
  return data.value;
}
function stopAsrSession(which) {
  const s = which === "mic" ? micAsr : sysAsr; if (!s) return;
  try { s.ws?.close?.(); } catch {} try { s.sendTimer && clearInterval(s.sendTimer); } catch {}
  try { s.proc && (s.proc.onaudioprocess = null); } catch {}
  try { s.src?.disconnect(); } catch {} try { s.proc?.disconnect(); } catch {}
  try { s.gain?.disconnect(); } catch {} try { s.ctx?.close?.(); } catch {}
  if (which === "mic") micAsr = null; else sysAsr = null;
}
function normalizeAudioBuffer(f32) {
  let max = 0; for (let i = 0; i < f32.length; i++) { const a = Math.abs(f32[i]); if (a > max) max = a; }
  if (max > 0 && max < 0.15) {
    const boost = Math.min(0.6 / max, 10), out = new Float32Array(f32.length);
    for (let i = 0; i < f32.length; i++) out[i] = Math.max(-1, Math.min(1, f32[i] * boost));
    return out;
  }
  return f32;
}
function sendAsrConfig(ws) {
  try { ws.send(JSON.stringify({ type: "transcription_session.update", input_audio_format: "pcm16", input_audio_transcription: { model: REALTIME_ASR_MODEL, language: "en", prompt: TRANSCRIBE_PROMPT + " CRITICAL: Speaker may have Indian or American accent. Technical terms like BDD, TDD, gRPC, Kafka, Selenium are common.", temperature: 0.1 }, turn_detection: { type: "server_vad", threshold: 0.35, prefix_padding_ms: 500, silence_duration_ms: 600 }, input_audio_noise_reduction: { type: "far_field" } })); } catch {}
}
function sendAsrConfigFallbackSessionUpdate(ws) {
  try { ws.send(JSON.stringify({ type: "session.update", session: { type: "transcription", audio: { input: { format: { type: "audio/pcm", rate: ASR_TARGET_RATE }, transcription: { model: REALTIME_ASR_MODEL, language: "en", prompt: TRANSCRIBE_PROMPT, temperature: 0.1 }, noise_reduction: { type: "far_field" }, turn_detection: { type: "server_vad", threshold: 0.35, prefix_padding_ms: 500, silence_duration_ms: 600 } } } } })); } catch {}
}
function asrUpsertDelta(which, itemId, deltaText) {
  const s = which === "mic" ? micAsr : sysAsr; if (!s) return;
  const now = Date.now();
  if (!s.itemText[itemId])      s.itemText[itemId] = "";
  if (!s.itemCommitted)         s.itemCommitted = {};
  if (!s.itemCommitted[itemId]) s.itemCommitted[itemId] = "";
  s.itemText[itemId] += String(deltaText || "");
  if (which === "sys") {
    const fullText = normalize(s.itemText[itemId]), already = s.itemCommitted[itemId];
    const newText = fullText.slice(already.length).trim();
    if (newText) {
      const words = newText.split(/\s+/);
      if (words.length > 1 || /[.!?,;:\n]$/.test(newText)) {
        const toCommit = words.length > 1 ? words.slice(0, -1).join(" ") + " " : newText;
        if (toCommit.trim()) { addTypewriterSpeech(toCommit, 0, "interviewer"); s.itemCommitted[itemId] = already + toCommit; }
      }
    }
  }
  const cur = normalize(s.itemText[itemId]); if (!cur) return;
  const role = (which === "sys") ? "interviewer" : "candidate";
  if (!s.itemEntry[itemId]) { const entry = { t: now, text: cur, role }; s.itemEntry[itemId] = entry; timeline.push(entry); }
  else { s.itemEntry[itemId].text = cur; s.itemEntry[itemId].t = now; s.itemEntry[itemId].role = role; }
  lastSpeechAt = now; updateTranscript();
}
function asrFinalizeItem(which, itemId, transcript) {
  const s = which === "mic" ? micAsr : sysAsr; if (!s) return;
  const entry = s.itemEntry[itemId]; let draftText = "";
  if (entry) { draftText = entry.text || ""; const idx = timeline.indexOf(entry); if (idx >= 0) timeline.splice(idx, 1); }
  delete s.itemEntry[itemId]; delete s.itemText[itemId]; if (s.itemShown) delete s.itemShown[itemId];
  const final = normalize(transcript || draftText); if (!final) return;
  addFinalSpeech(final, (which === "sys") ? "interviewer" : "candidate");
}
async function startStreamingAsr(which, mediaStream) {
  if (!isRunning) return false; if (which === "mic" && micMuted) return false;
  stopAsrSession(which);
  const secret = await getRealtimeClientSecretCached();
  const ws = new WebSocket(REALTIME_INTENT_URL, ["realtime", "openai-insecure-api-key." + secret]);
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const src = ctx.createMediaStreamSource(mediaStream);
  const gain = ctx.createGain(); gain.gain.value = (which === "sys") ? 4.5 : 3.0;
  const proc = ctx.createScriptProcessor(4096, 1, 1), queue = [];
  const state = { ws, ctx, src, proc, gain, queue, sendTimer: null, itemText: {}, itemEntry: {}, sawConfigError: false };
  if (which === "mic") micAsr = state; else sysAsr = state;
  proc.onaudioprocess = (e) => {
    if (!isRunning || ws.readyState !== 1) return;
    if (which === "mic" && micMuted) return;
    const norm = normalizeAudioBuffer(e.inputBuffer.getChannelData(0));
    const bytes = floatToInt16Bytes(resampleFloat32(norm, ctx.sampleRate || 48000, ASR_TARGET_RATE));
    if (bytes.length) queue.push(bytes);
  };
  src.connect(proc); proc.connect(gain); gain.connect(ctx.destination);
  ws.onopen = () => {
    sendAsrConfig(ws);
    state.sendTimer = setInterval(() => {
      if (!isRunning || ws.readyState !== 1 || !queue.length) return;
      if (which === "mic" && micMuted) return;
      let len = 0; const parts = [];
      while (queue.length && len < 9600) { const b = queue.shift(); len += b.length; parts.push(b); }
      if (!parts.length) return;
      const merged = new Uint8Array(len); let off = 0; for (const p of parts) { merged.set(p, off); off += p.length; }
      try { ws.send(JSON.stringify({ type: "input_audio_buffer.append", audio: base64FromBytes(merged) })); } catch {}
    }, ASR_SEND_EVERY_MS);
    setStatus(audioStatus, which === "sys" ? "System audio (streaming ASR) enabled." : "Mic (streaming ASR) enabled.", "text-green-600");
  };
  ws.onmessage = (msg) => {
    let ev; try { ev = JSON.parse(msg.data); } catch { return; } if (!ev?.type) return;
    if (ev.type === "error") { const m = String(ev?.error?.message || ""); if (!state.sawConfigError && m.toLowerCase().includes("transcription_session.update")) { state.sawConfigError = true; sendAsrConfigFallbackSessionUpdate(ws); } return; }
    if (ev.type === "conversation.item.input_audio_transcription.delta") { asrUpsertDelta(which, ev.item_id, ev.delta || ""); return; }
    if (ev.type === "conversation.item.input_audio_transcription.completed") { asrFinalizeItem(which, ev.item_id, ev.transcript || ""); return; }
  };
  return true;
}

/* -------------------------------------------------------------------------- */
/* MIC — all stubs (disabled, system-audio-only)                              */
/* -------------------------------------------------------------------------- */
function micSrIsHealthy() { return false; }
function stopMicOnly() { try { recognition?.stop(); } catch {} recognition = null; if (micWatchdog) clearInterval(micWatchdog); micWatchdog = null; }
function startMic() { return false; }                    // FIX #2: always false = no SR
async function enableMicStreamingFallback() { /* disabled */ }
function stopMicRecorderOnly() {
  try { micAbort?.abort(); } catch {} micAbort = null;
  if (micSegmentTimer) clearInterval(micSegmentTimer); micSegmentTimer = null;
  try { micRecorder?.stop(); } catch {} micRecorder = null;
  micSegmentChunks = []; micQueue = []; micInFlight = 0;
  if (micStream) { try { micStream.getTracks().forEach(t => t.stop()); } catch {} } micStream = null; micTrack = null;
}
function pickBestMimeType() {
  for (const t of ["audio/webm;codecs=opus","audio/webm","audio/ogg;codecs=opus","audio/ogg"]) if (MediaRecorder.isTypeSupported(t)) return t;
  return "";
}
async function enableMicRecorderFallback() { /* disabled */ }
function startMicSegmentRecorder() { /* disabled */ }
function drainMicQueue() { /* disabled */ }

/* -------------------------------------------------------------------------- */
/* SYSTEM AUDIO                                                                */
/* -------------------------------------------------------------------------- */
function stopSystemAudioOnly() {
  try { sysAbort?.abort(); } catch {} sysAbort = null;
  if (sysSegmentTimer) clearInterval(sysSegmentTimer); sysSegmentTimer = null;
  try { sysRecorder?.stop(); } catch {} sysRecorder = null;
  sysSegmentChunks = []; sysQueue = []; sysInFlight = 0;
  stopAsrSession("sys");
  if (sysStream) { try { sysStream.getTracks().forEach(t => t.stop()); } catch {} } sysStream = null; sysTrack = null;
  sysErrCount = 0; sysErrBackoffUntil = 0;
}
async function enableSystemAudioLegacy() {
  if (!isRunning) return;
  stopSystemAudioOnly();
  try { sysStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true }); }
  catch { setStatus(audioStatus, "Share audio denied.", "text-red-600"); return; }
  sysTrack = sysStream.getAudioTracks()[0];
  if (!sysTrack) { setStatus(audioStatus, "No system audio detected.", "text-red-600"); stopSystemAudioOnly(); showBanner("System audio requires selecting a window/tab and enabling "Share audio" in the picker."); return; }
  sysTrack.onended = () => { stopSystemAudioOnly(); setStatus(audioStatus, "System audio stopped (share ended).", "text-orange-600"); };
  sysAbort = new AbortController(); startSystemSegmentRecorder();
  setStatus(audioStatus, "System audio enabled (legacy).", "text-green-600");
}
async function enableSystemAudioStreaming() {
  if (!isRunning) return;
  stopSystemAudioOnly();
  try { sysStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true }); }
  catch { setStatus(audioStatus, "Share audio denied.", "text-red-600"); return; }
  sysTrack = sysStream.getAudioTracks()[0];
  if (!sysTrack) { setStatus(audioStatus, "No system audio detected.", "text-red-600"); stopSystemAudioOnly(); showBanner("System audio requires selecting a window/tab and enabling "Share audio" in the picker."); return; }
  sysTrack.onended = () => { stopSystemAudioOnly(); setStatus(audioStatus, "System audio stopped (share ended).", "text-orange-600"); };
  try { const ok = await startStreamingAsr("sys", sysStream); if (!ok) throw new Error("ASR start failed"); }
  catch (e) { console.error(e); setStatus(audioStatus, "Streaming ASR failed. Falling back to legacy…", "text-orange-600"); await enableSystemAudioLegacy(); }
}
async function enableSystemAudio() { return USE_STREAMING_ASR_SYS ? enableSystemAudioStreaming() : enableSystemAudioLegacy(); }
function startSystemSegmentRecorder() {
  if (!sysTrack) return;
  const mime = pickBestMimeType(); sysSegmentChunks = [];
  try { sysRecorder = new MediaRecorder(new MediaStream([sysTrack]), mime ? { mimeType: mime } : undefined); }
  catch { setStatus(audioStatus, "System audio start failed.", "text-red-600"); return; }
  sysRecorder.ondataavailable = (ev) => { if (!isRunning) return; if (ev.data.size) sysSegmentChunks.push(ev.data); };
  sysRecorder.onstop = () => {
    if (!isRunning) return;
    const blob = new Blob(sysSegmentChunks, { type: sysRecorder?.mimeType || "" }); sysSegmentChunks = [];
    if (blob.size >= SYS_MIN_BYTES) { sysQueue.push(blob); drainSysQueue(); }
    if (isRunning && sysTrack && sysTrack.readyState === "live") startSystemSegmentRecorder();
  };
  try { sysRecorder.start(); } catch {}
  if (sysSegmentTimer) clearInterval(sysSegmentTimer);
  sysSegmentTimer = setInterval(() => { if (!isRunning) return; try { sysRecorder?.stop(); } catch {} }, SYS_SEGMENT_MS);
}
function drainSysQueue() {
  if (!isRunning || Date.now() < sysErrBackoffUntil) return;
  while (sysInFlight < SYS_MAX_CONCURRENT && sysQueue.length) {
    const blob = sysQueue.shift(), myEpoch = transcriptEpoch; sysInFlight++;
    transcribeSysBlob(blob, myEpoch).catch(() => {}).finally(() => { sysInFlight--; drainSysQueue(); });
  }
}
function trimOverlap(prev, next) {
  if (!prev || !next) return next;
  const pW = normalize(prev).toLowerCase().split(" "), nW = normalize(next).toLowerCase().split(" ");
  for (let k = Math.min(12, pW.length, nW.length); k >= 3; k--) {
    if (pW.slice(-k).join(" ") === nW.slice(0, k).join(" ")) return nW.slice(k).join(" ");
  }
  return next;
}
async function transcribeSysBlob(blob, myEpoch) {
  if (Date.now() < sysErrBackoffUntil) return;
  const fd = new FormData(); const ext = (blob.type || "").includes("ogg") ? "ogg" : "webm";
  fd.append("file", blob, `sys.${ext}`); fd.append("prompt", TRANSCRIBE_PROMPT);
  const res = await apiFetch("transcribe", { method: "POST", body: fd, signal: sysAbort?.signal }, false);
  if (myEpoch !== transcriptEpoch) return;
  if (!res.ok) {
    sysErrCount++; const errText = await res.text().catch(() => "");
    setStatus(audioStatus, `System transcribe failed (${res.status}). ${errText.slice(0, 160)}`, "text-red-600");
    if (sysErrCount >= SYS_ERR_MAX) { sysErrBackoffUntil = Date.now() + SYS_ERR_BACKOFF_MS; stopSystemAudioOnly(); setStatus(audioStatus, "System audio stopped (backend errors).", "text-red-600"); }
    return;
  }
  sysErrCount = 0; sysErrBackoffUntil = 0;
  const data = await res.json().catch(() => ({})), raw = String(data.text || "");
  if (looksLikeWhisperHallucination(raw)) return;
  const cleaned = dedupeByTail(raw, { get value() { return lastSysTail; }, set value(v) { lastSysTail = v; } });
  if (!cleaned) return;
  const now = Date.now(), text = normalize(cleaned), trimmed = trimOverlap(lastSysPrinted, text);
  if (!trimmed) return;
  lastSysPrinted = normalize((lastSysPrinted + " " + trimmed).trim()); lastSysPrintedAt = now;
  addTypewriterSpeech(trimmed, SYS_TYPE_MS_PER_WORD, "interviewer");
}

/* -------------------------------------------------------------------------- */
/* CREDITS                                                                     */
/* -------------------------------------------------------------------------- */
async function deductCredits(delta) {
  const res = await apiFetch("user/deduct", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ delta }) }, true);
  const data = await res.json().catch(() => ({})); if (!res.ok) throw new Error(data.error || "Deduct failed"); return data;
}
function startCreditTicking() {
  if (creditTimer) clearInterval(creditTimer); lastCreditAt = Date.now();
  creditTimer = setInterval(async () => {
    if (!isRunning) return;
    const sec = Math.floor((Date.now() - lastCreditAt) / 1000); if (sec < CREDIT_BATCH_SEC) return;
    const billable = sec - (sec % CREDIT_BATCH_SEC); lastCreditAt += billable * 1000;
    try { const out = await deductCredits(billable * CREDITS_PER_SEC); if (out.remaining <= 0) { stopAll(); showBanner("No credits remaining."); return; } await loadUserProfile(); } catch {}
  }, 500);
}

/* -------------------------------------------------------------------------- */
/* CHAT STREAMING                                                              */
/* -------------------------------------------------------------------------- */
function abortChatStreamOnly(silent = true) {
  try { chatAbort?.abort(); } catch {} chatAbort = null;
  if (silent) setStatus(sendStatus, "Canceled (new request)", "text-orange-600");
  chatStreamActive = false;
}
function pushHistory(role, content) {
  const c = normalize(content); if (!c) return;
  chatHistory.push({ role, content: c }); if (chatHistory.length > 80) chatHistory.splice(0, chatHistory.length - 80);
}
function compactHistoryForRequest() { return chatHistory.slice(-12).map(m => ({ role: m.role, content: String(m.content || "").slice(0, 1600) })); }
async function startChatStreaming(prompt, userTextForHistory) {
  abortChatStreamOnly(true); chatAbort = new AbortController(); chatStreamActive = true;
  const mySeq = ++chatStreamSeq; if (userTextForHistory) pushHistory("user", userTextForHistory);
  aiRawBuffer = ""; responseBox.innerHTML = `<span class="text-gray-500 text-sm">Receiving…</span>`; setStatus(sendStatus, "Connecting…", "text-orange-600");
  const body = { prompt, history: compactHistoryForRequest(), instructions: getEffectiveInstructions(), resumeText: resumeTextMem || "" };
  let raw = "", flushTimer = null, sawFirstChunk = false;
  const render = () => { responseBox.innerHTML = renderMarkdownLite(raw); };
  try {
    const res = await apiFetch("chat/send", { method: "POST", headers: { "Content-Type": "application/json", Accept: "text/plain" }, body: JSON.stringify(body), signal: chatAbort.signal }, false);
    if (!res.ok) throw new Error(await res.text()); if (!res.body) throw new Error("No stream body");
    const reader = res.body.getReader(), dec = new TextDecoder();
    flushTimer = setInterval(() => { if (mySeq !== chatStreamSeq || !sawFirstChunk) return; render(); }, 30);
    while (true) {
      const { done, value } = await reader.read(); if (done) break; if (mySeq !== chatStreamSeq) return;
      raw += dec.decode(value, { stream: true });
      if (!sawFirstChunk) { sawFirstChunk = true; responseBox.innerHTML = ""; setStatus(sendStatus, "Receiving…", "text-orange-600"); }
      if (raw.length < 1800) render();
    }
    if (mySeq === chatStreamSeq) { render(); setStatus(sendStatus, "Done", "text-green-600"); pushHistory("assistant", raw); }
  } catch (e) {
    if (e?.name === "AbortError" || chatAbort?.signal?.aborted) return;
    console.error(e); setStatus(sendStatus, "Failed", "text-red-600");
    responseBox.innerHTML = `<span class="text-red-600 text-sm">Failed. Check backend /chat/send streaming.</span>`;
  } finally { if (flushTimer) clearInterval(flushTimer); if (mySeq === chatStreamSeq) chatStreamActive = false; }
}

/* -------------------------------------------------------------------------- */
/* RESUME UPLOAD                                                               */
/* -------------------------------------------------------------------------- */
resumeInput?.addEventListener("change", async () => {
  const file = resumeInput.files?.[0]; if (!file) return;
  if (resumeStatus) resumeStatus.textContent = "Processing…";
  const fd = new FormData(); fd.append("file", file);
  const res = await apiFetch("resume/extract", { method: "POST", body: fd }, false);
  if (!res.ok) { const e = await res.text().catch(() => ""); resumeTextMem = ""; if (resumeStatus) resumeStatus.textContent = `Resume extract failed (${res.status}): ${e.slice(0, 160)}`; return; }
  const data = await res.json().catch(() => ({})); resumeTextMem = String(data.text || "").trim();
  if (resumeStatus) resumeStatus.textContent = resumeTextMem ? `Resume extracted (${resumeTextMem.length} chars)` : "Resume extracted: empty";
});

/* -------------------------------------------------------------------------- */
/* START / STOP                                                                */
/* -------------------------------------------------------------------------- */
async function startAll() {
  hideBanner(); if (isRunning) return;
  await apiFetch("chat/reset", { method: "POST" }, false).catch(() => {});
  transcriptEpoch++; timeline = []; micInterimEntry = null; lastSpeechAt = 0; sentCursor = 0; pinnedTop = true;
  lastSysTail = ""; lastMicTail = ""; lastSysPrinted = ""; lastSysPrintedAt = 0; resetRoleCommitState();
  stopAsrSession("mic"); stopAsrSession("sys"); updateTranscript();
  isRunning = true;
  startBtn.disabled = true;
  stopBtn.disabled = false; stopBtn.classList.remove("opacity-50");
  sysBtn.disabled = false;  sysBtn.classList.remove("opacity-50");
  sendBtn.disabled = false; sendBtn.classList.remove("opacity-60");
  // FIX #2: no micOk = false hack — mic is simply disabled
  setStatus(audioStatus, "Ready. Press 'System Audio' to start capturing.", "text-blue-600");
  startCreditTicking();
}
function stopAll() {
  isRunning = false; stopMicOnly(); stopMicRecorderOnly(); stopSystemAudioOnly(); stopAsrSession("mic"); stopAsrSession("sys");
  if (creditTimer) clearInterval(creditTimer);
  startBtn.disabled = false;
  stopBtn.disabled = true;  stopBtn.classList.add("opacity-50");
  sysBtn.disabled = true;   sysBtn.classList.add("opacity-50");
  sendBtn.disabled = true;  sendBtn.classList.add("opacity-60");
  setStatus(audioStatus, "Stopped", "text-orange-600");
}

/* -------------------------------------------------------------------------- */
/* HARD CLEAR                                                                  */
/* -------------------------------------------------------------------------- */
function hardClearTranscript() {
  transcriptEpoch++; try { micAbort?.abort(); } catch {} try { sysAbort?.abort(); } catch {}
  micQueue = []; sysQueue = []; micSegmentChunks = []; sysSegmentChunks = [];
  lastSysTail = ""; lastMicTail = ""; lastSysPrinted = ""; lastSysPrintedAt = 0; resetRoleCommitState();
  if (micAsr) { micAsr.itemText = {}; micAsr.itemEntry = {}; } if (sysAsr) { sysAsr.itemText = {}; sysAsr.itemEntry = {}; }
  timeline = []; micInterimEntry = null; lastSpeechAt = 0; sentCursor = 0; pinnedTop = true; updateTranscript();
}

/* -------------------------------------------------------------------------- */
/* SEND                                                                        */
/* -------------------------------------------------------------------------- */
async function handleSend() {
  if (sendBtn.disabled) return;
  const manual = normalize(manualQuestion?.value || ""), freshInterviewer = normalize(getFreshInterviewerBlocksText());
  const base = manual || freshInterviewer; updateTopicMemory(base);
  const question = buildDraftQuestion(base); if (!base) return;
  if (manualQuestion) manualQuestion.value = "";
  abortChatStreamOnly(true); blockMicUntil = Date.now() + 700; removeInterimIfAny();
  sentCursor = timeline.length; pinnedTop = true; updateTranscript();
  responseBox.innerHTML = renderMarkdownLite(`${question}\n\n_Generating answer…_`);
  setStatus(sendStatus, "Queued…", "text-orange-600");
  const mode = modeSelect?.value || "interview";
  const promptToSend = mode === "interview" ? buildInterviewQuestionPrompt(question.replace(/^Q:\s*/i, "")) : question;
  await startChatStreaming(promptToSend, base);
}

sendBtn.onclick = handleSend;

/* -------------------------------------------------------------------------- */
/* FIX #3: Enter key — global (skip if inside manualQuestion)                 */
/* -------------------------------------------------------------------------- */
document.addEventListener("keydown", (e) => {
  if (e.target === manualQuestion) return;   // handled separately below
  if (e.key !== "Enter" || e.shiftKey) return;
  e.preventDefault(); handleSend();
});

/* FIX #3: Attach Enter to manualQuestion (was defined but NEVER attached)    */
if (manualQuestion) {
  manualQuestion.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); if (sendBtn && !sendBtn.disabled) handleSend(); }
    // Shift+Enter → newline (default behavior, no preventDefault)
  });
}

/* -------------------------------------------------------------------------- */
/* CLEAR / RESET                                                               */
/* -------------------------------------------------------------------------- */
clearBtn.onclick = () => {
  hardClearTranscript(); if (manualQuestion) manualQuestion.value = "";
  setStatus(sendStatus, "Transcript cleared", "text-green-600");
  setStatus(audioStatus, isRunning ? "Listening…" : "Stopped", isRunning ? "text-green-600" : "text-orange-600");
};
resetBtn.onclick = async () => {
  responseBox.innerHTML = ""; setStatus(sendStatus, "Response reset", "text-green-600");
  await apiFetch("chat/reset", { method: "POST" }, false).catch(() => {});
};

/* -------------------------------------------------------------------------- */
/* LOGOUT                                                                      */
/* -------------------------------------------------------------------------- */
document.getElementById("logoutBtn").onclick = () => {
  chatHistory = []; resumeTextMem = ""; stopAll();
  localStorage.removeItem("session"); window.location.href = "/auth?tab=login";
};

/* -------------------------------------------------------------------------- */
/* PAGE LOAD                                                                   */
/* -------------------------------------------------------------------------- */
window.addEventListener("load", async () => {
  session = JSON.parse(localStorage.getItem("session") || "null");
  if (!session) return (window.location.href = "/auth?tab=login");
  if (!session.refresh_token) { localStorage.removeItem("session"); return (window.location.href = "/auth?tab=login"); }
  chatHistory = []; resumeTextMem = ""; if (resumeStatus) resumeStatus.textContent = "Resume cleared.";
  await loadUserProfile(); await apiFetch("chat/reset", { method: "POST" }, false).catch(() => {});
  transcriptEpoch++; timeline = []; micInterimEntry = null; lastSpeechAt = 0; sentCursor = 0; pinnedTop = true;
  lastSysTail = ""; lastMicTail = ""; lastSysPrinted = ""; lastSysPrintedAt = 0; resetRoleCommitState();
  stopAsrSession("mic"); stopAsrSession("sys"); updateTranscript();
  stopBtn.disabled = true; stopBtn.classList.add("opacity-50");
  sysBtn.disabled = true;  sysBtn.classList.add("opacity-50");
  sendBtn.disabled = true; sendBtn.classList.add("opacity-60");
  setStatus(audioStatus, "Stopped", "text-orange-600"); updateMicMuteUI();
});

/* -------------------------------------------------------------------------- */
/* BUTTON WIRING                                                               */
/* -------------------------------------------------------------------------- */
startBtn.onclick = startAll;
stopBtn.onclick  = stopAll;
sysBtn.onclick   = enableSystemAudio;