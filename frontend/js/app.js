/* ========================================================================== */
/* app.js — SYSTEM AUDIO WORD-BY-WORD TRANSCRIPTION                          */
/* ========================================================================== */

const COMMIT_WORDS = 2; // Commit every 2 words for faster display

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

function getSessionId() {
  let id = sessionStorage.getItem("chatSessionId");
  if (!id) {
    id = crypto.randomUUID();
    sessionStorage.setItem("chatSessionId", id);
  }
  return id;
}

/* -------------------------------------------------------------------------- */
/* SIMPLE MARKDOWN (fallback)                                                   */
/* -------------------------------------------------------------------------- */
function renderMarkdownLite(md) {
  if (!md) return "";
  let text = String(md).replace(/<br\s*\/?>/gi, "\n").replace(/\r\n/g, "\n");
  text = text.replace(/(Q:[^\n]+?)(\s+\*\*[A-Z])/g, "$1\n$2");
  text = text.replace(/([^\n])(Here's how I handle it in production:?)/gi, "$1\n$2");
  text = text.replace(/([^\n])([1-9]️⃣)/g, "$1\n$2");
  
  const preParts = text.split(/(```[\s\S]*?```)/g);
  for (let i = 0; i < preParts.length; i++) {
    if (i % 2 === 0) preParts[i] = preParts[i].replace(/ \* /g, "\n* ");
  }
  text = preParts.join("");
  text = text.replace(/([^\n])(\*\*[A-Z][^*\n]{15,}\*\*)(\s*)$/gm, "$1\n$2$3");

  const parts = text.split(/(```[\s\S]*?```)/g);
  const processedParts = parts.map((part, i) => {
    if (i % 2 === 1) {
      const fenceMatch = part.match(/^```(\w*)\n?([\s\S]*?)```$/);
      const lang = fenceMatch?.[1] || "";
      const code = fenceMatch?.[2] ?? part.replace(/^```\w*\n?/, "").replace(/```$/, "");
      const escapedCode = code.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
      return `<pre><code class="language-${lang}">${escapedCode}</code></pre>`;
    }

    let s = part;
    s = s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
    s = s.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
    s = s.replace(/`([^`]+)`/g, "<code>$1</code>");

    const lines = s.split("\n");
    const htmlLines = lines.map(line => {
      const trimmed = line.trim();
      if (/^[1-9]️⃣/.test(trimmed)) return `<div style="margin-top:12px;margin-bottom:4px;font-weight:600">${trimmed}</div>`;
      if (/^\*\s+/.test(trimmed)) {
        const content = trimmed.replace(/^\*\s+/, "");
        return `<div style="margin-left:18px;margin-top:3px;line-height:1.55">• ${content}</div>`;
      }
      if (/^Q:\s/.test(trimmed)) return `<div style="margin-bottom:8px;font-weight:600">${trimmed}</div>`;
      if (/^here'?s how i handle it in production/i.test(trimmed)) return `<div style="margin-top:8px;margin-bottom:6px;font-style:italic">${trimmed}</div>`;
      if (!trimmed) return `<div style="height:6px"></div>`;
      return `<div style="line-height:1.6">${trimmed}</div>`;
    });
    return htmlLines.join("");
  });
  return processedParts.join("");
}

let aiRawBuffer = "";

function setupMarkdownRenderer() {
  if (!window.marked || !window.hljs || !window.DOMPurify) return;
  marked.setOptions({
    gfm: true,
    breaks: true,
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
let micMuted = false;

let recognition = null;
let blockMicUntil = 0;
let micInterimEntry = null;
let lastMicResultAt = 0;
let micWatchdog = null;

let micStream = null;
let micTrack = null;
let micRecorder = null;
let micSegmentChunks = [];
let micSegmentTimer = null;
let micQueue = [];
let micAbort = null;
let micInFlight = 0;

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

let lastSysTail = "";
let lastMicTail = "";
let lastSysPrinted = "";
let lastSysPrintedAt = 0;

let timeline = [];
let lastSpeechAt = 0;
let sentCursor = 0;
let pinnedTop = true;

let creditTimer = null;
let lastCreditAt = 0;

let chatAbort = null;
let chatStreamActive = false;
let chatStreamSeq = 0;
let chatHistory = [];
let resumeTextMem = "";
let transcriptEpoch = 0;

/* -------------------------------------------------------------------------- */
/* CONSTANTS                                                                    */
/* -------------------------------------------------------------------------- */
const PAUSE_NEWLINE_MS = 3000;
const MIC_SEGMENT_MS = 1200;
const MIC_MIN_BYTES = 1800;
const MIC_MAX_CONCURRENT = 2;
const SYS_SEGMENT_MS = 800;
const SYS_MIN_BYTES = 2000;
const SYS_MAX_CONCURRENT = 2;
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
  "Do NOT Americanize words. Do NOT translate. Do NOT add new words. Do NOT repeat phrases. " +
  "Keep punctuation minimal. If uncertain, omit.";

const USE_STREAMING_ASR_SYS = true;
const USE_STREAMING_ASR_MIC_FALLBACK = false;
const REALTIME_INTENT_URL = "wss://api.openai.com/v1/realtime?intent=transcription";
const REALTIME_ASR_MODEL = "gpt-4o-mini-transcribe";
const ASR_SEND_EVERY_MS = 40;
const ASR_TARGET_RATE = 24000;

let realtimeSecretCache = null;
let micAsr = null;
let sysAsr = null;

const MODE_INSTRUCTIONS = {
  general: "",
  interview: "",
  sales: "Respond in persuasive, value-driven style. Highlight benefits/outcomes.".trim()
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
    if (!isRunning || micMuted || micSrIsHealthy()) return;
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
/* TRANSCRIPT RENDER                                                            */
/* -------------------------------------------------------------------------- */
if (liveTranscript) {
  const TH = 40;
  liveTranscript.addEventListener("scroll", () => { pinnedTop = liveTranscript.scrollTop <= TH; }, { passive: true });
}

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
/* DEDUPE + OVERLAP TRIM                                                        */
/* -------------------------------------------------------------------------- */
function canonKey(s) {
  return normalize(String(s || "")).toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, "").replace(/\s+/g, " ").trim();
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

const lastCommittedByRole = {
  interviewer: { key: "", at: 0, raw: "" },
  candidate: { key: "", at: 0, raw: "" }
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
  const trimmedRaw = prev.raw ? trimOverlapWords(prev.raw, cleanedRaw) : cleanedRaw;
  const trimmedKey = canonKey(trimmedRaw);
  if (!trimmedKey) return;
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

/* -------------------------------------------------------------------------- */
/* QUESTION HELPERS                                                             */
/* -------------------------------------------------------------------------- */
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

function buildDraftQuestion(spoken) {
  const cleaned = normalize(spoken).replace(/\s+/g, " ").trim();
  if (!cleaned) return "Q: Can you walk me through your current project?";
  return "Q: " + cleaned.charAt(0).toUpperCase() + cleaned.slice(1) + (cleaned.endsWith("?") ? "" : "?");
}

function buildInterviewQuestionPrompt(currentTextOnly) {
  const base = normalize(currentTextOnly);
  if (!base) return "";
  const priorQs = extractPriorQuestions();
  let prompt = base;
  if (priorQs.length) prompt = `Previously asked:\n${priorQs.map(q => "- " + q).join("\n")}\n\n${prompt}`;
  return prompt;
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
    userInfo.innerHTML = `<div class="text-sm text-gray-800 truncate"><b>${u.email || "N/A"}</b><span class="ml-3">Credits: <b>${u.credits ?? 0}</b></span></div>`;
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
  const res = await fetch(`/api?path=${encodeURIComponent(path)}`, { ...opts, headers, cache: "no-store" });
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
/* DEDUPE UTIL                                                                  */
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
  const noise = ["thanks for watching", "thank you for watching", "subscribe", "please like and subscribe"];
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
    return;
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
      prompt: TRANSCRIBE_PROMPT + " Speaker has an Indian English accent. Prefer Indian pronunciation and spelling. Do not normalize to US English."
    },
    turn_detection: { type: "server_vad", threshold: 0.5, prefix_padding_ms: 300, silence_duration_ms: 350 },
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
            prompt: TRANSCRIBE_PROMPT + " Speaker has an Indian English accent. Use Indian pronunciation and spelling."
          },
          noise_reduction: { type: "far_field" },
          turn_detection: { type: "server_vad", threshold: 0.5, prefix_padding_ms: 300, silence_duration_ms: 350 }
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
  const ws = new WebSocket(REALTIME_INTENT_URL, ["realtime", "openai-insecure-api-key." + secret]);
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const src = ctx.createMediaStreamSource(mediaStream);
  const gain = ctx.createGain();
  gain.gain.value = 0;
  const proc = ctx.createScriptProcessor(4096, 1, 1);
  const queue = [];
  const state = { ws, ctx, src, proc, gain, queue, sendTimer: null, itemText: {}, itemEntry: {}, sawConfigError: false };
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
    setStatus(audioStatus, which === "sys" ? "System audio LIVE (word-by-word)." : "Mic (streaming ASR) enabled.", "text-green-600");
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
/* MIC (not needed for your use case, but kept for completeness)               */
/* -------------------------------------------------------------------------- */
function micSrIsHealthy() { return false; }
function stopMicOnly() {}
function startMic() { return false; }
async function enableMicStreamingFallback() {}
function stopMicRecorderOnly() {}
async function enableMicRecorderFallback() {}

/* -------------------------------------------------------------------------- */
/* SYSTEM AUDIO - STREAMING ASR                                                 */
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

async function enableSystemAudio() {
  if (!isRunning) return;
  stopSystemAudioOnly();
  
  try {
    sysStream = await navigator.mediaDevices.getDisplayMedia({ 
      video: true, 
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
    });
  } catch (err) {
    setStatus(audioStatus, "Share audio denied.", "text-red-600");
    return;
  }

  sysTrack = sysStream.getAudioTracks()[0];
  if (!sysTrack) {
    setStatus(audioStatus, "No system audio detected.", "text-red-600");
    stopSystemAudioOnly();
    showBanner("System audio requires selecting a window/tab and enabling "Share audio" in the picker.");
    return;
  }

  sysTrack.onended = () => {
    stopSystemAudioOnly();
    setStatus(audioStatus, "System audio stopped (share ended).", "text-orange-600");
  };

  try {
    const ok = await startStreamingAsr("sys", sysStream);
    if (ok) return;
  } catch (e) {
    console.error("Streaming ASR failed:", e);
  }

  setStatus(audioStatus, "Streaming ASR unavailable. System audio disabled.", "text-red-600");
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
  return chatHistory.slice(-12).map(m => ({ role: m.role, content: String(m.content || "").slice(0, 1600) }));
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
  const body = { prompt, history: compactHistoryForRequest(), instructions: getEffectiveInstructions(), resumeText: resumeTextMem || "", sessionId: getSessionId() };
  let raw = "";
  let flushTimer = null;
  let sawFirstChunk = false;
  const render = () => { responseBox.innerHTML = renderMarkdownLite(raw); };
  try {
    const res = await apiFetch("chat/send", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/plain" },
      body: JSON.stringify(body),
      signal: chatAbort.signal
    }, false);
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
      render();
    }
    if (mySeq === chatStreamSeq) {
      render();
      setStatus(sendStatus, "Done", "text-green-600");
      pushHistory("assistant", raw);
      resumeTextMem = "";
    }
  } catch (e) {
    if (e?.name === "AbortError" || chatAbort?.signal?.aborted) return;
    console.error(e);
    setStatus(sendStatus, "Failed", "text-red-600");
    responseBox.innerHTML = `<span class="text-red-600 text-sm">Failed. Check backend /chat/send streaming.</span>`;
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
    resumeStatus.textContent = resumeTextMem ? `Resume extracted (${resumeTextMem.length} chars)` : "Resume extracted: empty";
  }
});

/* -------------------------------------------------------------------------- */
/* START / STOP                                                                 */
/* -------------------------------------------------------------------------- */
async function startAll() {
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
  updateTranscript();
  isRunning = true;
  startBtn.disabled = true;
  stopBtn.disabled = false;
  sysBtn.disabled = false;
  sendBtn.disabled = false;
  stopBtn.classList.remove("opacity-50");
  sysBtn.classList.remove("opacity-50");
  sendBtn.classList.remove("opacity-60");
  setStatus(audioStatus, "Starting system audio capture...", "text-orange-600");
  setTimeout(async () => { await enableSystemAudio(); }, 300);
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
async function handleSend() {
  if (sendBtn.disabled) return;
  const manual = normalize(manualQuestion?.value || "");
  const freshInterviewer = normalize(getFreshInterviewerBlocksText());
  const freshAll = normalize(getFreshBlocksText());
  const base = manual || freshAll || freshInterviewer;
  if (!base) {
    setStatus(sendStatus, "Nothing to send", "text-orange-600");
    return;
  }
  const question = buildDraftQuestion(base);
  if (manualQuestion) manualQuestion.value = "";
  abortChatStreamOnly(true);
  blockMicUntil = Date.now() + 700;
  removeInterimIfAny();
  sentCursor = timeline.length;
  pinnedTop = true;
  updateTranscript();
  const draftQ = question;
  responseBox.innerHTML = renderMarkdownLite(`${draftQ}\n\n_Generating answer…_`);
  setStatus(sendStatus, "Queued…", "text-orange-600");
  const mode = modeSelect?.value || "interview";
  const promptToSend = mode === "interview" ? buildInterviewQuestionPrompt(question.replace(/^Q:\s*/i, "")) : question;
  await startChatStreaming(promptToSend, base);
  setTimeout(() => { sentCursor = timeline.length; }, 100);
}

sendBtn.onclick = handleSend;

document.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" || e.shiftKey) return;
  e.preventDefault();
  handleSend();
});

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

document.getElementById("logoutBtn").onclick = () => {
  chatHistory = [];
  resumeTextMem = "";
  stopAll();
  localStorage.removeItem("session");
  window.location.href = "/auth?tab=login";
};

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

startBtn.onclick = startAll;
stopBtn.onclick = stopAll;
sysBtn.onclick = enableSystemAudio;