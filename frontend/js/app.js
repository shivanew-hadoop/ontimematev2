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

// SpeechRecognition (fastest live words) - kept as fallback
let recognition = null;
let blockMicUntil = 0;
let lastMicResultAt = 0;
let micWatchdog = null;

// Mic fallback (MediaRecorder -> /transcribe)
let micStream = null;
let micTrack = null;
let micRecorder = null;
let micSegmentChunks = [];
let micSegmentTimer = null;
let micQueue = [];
let micAbort = null;
let micInFlight = 0;

// System audio legacy
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

// DEDUPE STATE
let lastSysTail = "";
let lastMicTail = "";
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

// HARD CLEAR TOKEN
let transcriptEpoch = 0;

//--------------------------------------------------------------
// REALTIME (WebRTC data channel + PCM append) - NEW
//--------------------------------------------------------------
let rtMic = null; // { pc, dc, ctx, src, proc, buf, itemText, source }
let rtSys = null;

const REALTIME_PCM_RATE = 24000;
const REALTIME_MODEL = "gpt-realtime"; // connect target for WebRTC

//--------------------------------------------------------------
// CONSTANTS
//--------------------------------------------------------------
const PAUSE_NEWLINE_MS = 3000;

// Mic fallback chunking
const MIC_SEGMENT_MS = 1200;
const MIC_MIN_BYTES = 1800;
const MIC_MAX_CONCURRENT = 2;

const SYS_SEGMENT_MS = 2800;
const SYS_MIN_BYTES = 6000;
const SYS_MAX_CONCURRENT = 2;

const SYS_ERR_MAX = 3;
const SYS_ERR_BACKOFF_MS = 10000;

const CREDIT_BATCH_SEC = 5;
const CREDITS_PER_SEC = 1;

const MIC_LANGS = ["en-IN", "en-GB", "en-US"];
let micLangIndex = 0;

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
// TRANSCRIPT RENDER
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

// Realtime interim entries (separate)
let micInterimEntry = null;
let sysInterimEntry = null;

function getAllBlocksNewestFirst() {
  return timeline
    .slice()
    .sort((a, b) => (b.t || 0) - (a.t || 0))
    .map(x => String(x.text || "").trim())
    .filter(Boolean);
}

function isInterimEntry(x) {
  return x === micInterimEntry || x === sysInterimEntry;
}

function getFreshBlocksText() {
  return timeline
    .slice(sentCursor)
    .filter(x => x && !isInterimEntry(x))
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

function removeInterim(source) {
  const ref = source === "sys" ? sysInterimEntry : micInterimEntry;
  if (!ref) return;
  const idx = timeline.indexOf(ref);
  if (idx >= 0) timeline.splice(idx, 1);
  if (source === "sys") sysInterimEntry = null;
  else micInterimEntry = null;
}

function setInterim(source, text) {
  const cleaned = normalize(text);
  if (!cleaned) return;

  if (source === "sys") {
    if (!sysInterimEntry) {
      sysInterimEntry = { t: Date.now(), text: cleaned };
      timeline.push(sysInterimEntry);
    } else {
      sysInterimEntry.t = Date.now();
      sysInterimEntry.text = cleaned;
    }
  } else {
    if (!micInterimEntry) {
      micInterimEntry = { t: Date.now(), text: cleaned };
      timeline.push(micInterimEntry);
    } else {
      micInterimEntry.t = Date.now();
      micInterimEntry.text = cleaned;
    }
  }
  updateTranscript();
}

// HARD dedupe at final stage
function addFinalSpeech(txt, source = "mic") {
  const cleaned = normalize(txt);
  if (!cleaned) return;

  const now = Date.now();
  if (
    cleaned.toLowerCase() === (lastFinalText || "").toLowerCase() &&
    now - (lastFinalAt || 0) < 1200
  ) return;

  lastFinalText = cleaned;
  lastFinalAt = now;

  removeInterim(source === "sys" ? "sys" : "mic");

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

//--------------------------------------------------------------
// PROFILE + TOKEN + API
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
// DEDUPE UTIL
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
// REALTIME HELPERS (NEW)
//--------------------------------------------------------------
function b64FromBytes(bytes) {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function floatTo16BitPCM(float32Array) {
  const out = new Int16Array(float32Array.length);
  for (let i = 0; i < float32Array.length; i++) {
    let s = Math.max(-1, Math.min(1, float32Array[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

function downsampleBuffer(input, inRate, outRate) {
  if (outRate === inRate) return input;
  const ratio = inRate / outRate;
  const newLen = Math.floor(input.length / ratio);
  const result = new Float32Array(newLen);
  let offset = 0;
  for (let i = 0; i < newLen; i++) {
    const nextOffset = Math.floor((i + 1) * ratio);
    let sum = 0;
    let count = 0;
    for (let j = offset; j < nextOffset && j < input.length; j++) {
      sum += input[j];
      count++;
    }
    result[i] = count ? sum / count : 0;
    offset = nextOffset;
  }
  return result;
}

async function getRealtimeToken(ttlSec = 600) {
  const res = await apiFetch(
    "realtime/transcription_token",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ttl_sec: ttlSec })
    },
    true
  );

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || `Token route failed (${res.status})`);
  const token = data?.value || data?.token;
  if (!token) throw new Error("Missing realtime token");
  return token;
}


async function connectRealtimePeer(ephemeralKey) {
  const pc = new RTCPeerConnection();
  const dc = pc.createDataChannel("oai-events");

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  // Client connects directly to OpenAI with ephemeral key (browser-safe)
  const r = await fetch(`https://api.openai.com/v1/realtime?model=${encodeURIComponent(REALTIME_MODEL)}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ephemeralKey}`,
      "Content-Type": "application/sdp"
    },
    body: offer.sdp
  });

  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`Realtime connect failed (${r.status}): ${t.slice(0, 180)}`);
  }

  const answerSdp = await r.text();
  await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });

  return { pc, dc };
}

function sendRt(dc, obj) {
  if (!dc || dc.readyState !== "open") return;
  try { dc.send(JSON.stringify(obj)); } catch {}
}

async function startRealtimeTranscriber(source /* "mic"|"sys" */) {
  if (!isRunning) return null;

  // stop existing
  await stopRealtimeTranscriber(source);

  const key = await getRealtimeToken(600);

  const { pc, dc } = await connectRealtimePeer(key);

  const rt = {
    source,
    pc,
    dc,
    ctx: null,
    src: null,
    proc: null,
    itemText: {}
  };

  const handleEvent = (evt) => {
    let msg = null;
    try { msg = JSON.parse(evt.data); } catch { return; }
    const type = msg?.type || "";

    // Delta transcript
    if (type === "conversation.item.input_audio_transcription.delta") {
      const itemId = msg?.item_id || "x";
      const delta = String(msg?.delta || "");
      rt.itemText[itemId] = (rt.itemText[itemId] || "") + delta;

      // Show partial immediately (no “disappear” flicker)
      setInterim(source === "sys" ? "sys" : "mic", rt.itemText[itemId]);
    }

    // Completed transcript
    if (type === "conversation.item.input_audio_transcription.completed") {
      const itemId = msg?.item_id || "x";
      const text = String(msg?.transcript || "");
      delete rt.itemText[itemId];
      if (text) addFinalSpeech(text, source === "sys" ? "sys" : "mic");
    }

    // Errors
    if (type === "error") {
      const m = msg?.error?.message || "Realtime error";
      setStatus(audioStatus, `${source.toUpperCase()} realtime error: ${m}`, "text-red-600");
    }
  };

  dc.addEventListener("message", handleEvent);

  // When channel opens, configure session (already mostly set on token mint)
  const opened = await new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error("Realtime data channel open timeout")), 8000);
    dc.onopen = () => { clearTimeout(to); resolve(true); };
    dc.onerror = () => { clearTimeout(to); reject(new Error("Realtime data channel error")); };
  });

  if (!opened) throw new Error("Realtime channel not open");

  // Small session update (safe)
  sendRt(dc, {
    type: "session.update",
    session: {
      type: "transcription",
      audio: {
        input: {
          format: { type: "audio/pcm", rate: 24000 },
          transcription: {
            model: "gpt-4o-mini-transcribe",
            language: "en",
            prompt: TRANSCRIBE_PROMPT
          }
        }
      }
    }
  });

  // Start audio capture for source
  let media;
  if (source === "mic") {
    media = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    setStatus(audioStatus, "Mic (realtime) enabled.", "text-green-600");
  } else {
    // Still requires user selection (browser security)
    media = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
    setStatus(audioStatus, "System audio (realtime) enabled. Ensure 'Share tab audio' is ON.", "text-green-600");
  }

  const track = media.getAudioTracks()[0];
  if (!track) throw new Error("No audio track found");

  track.onended = () => {
    if (source === "sys") setStatus(audioStatus, "System audio stopped (share ended).", "text-orange-600");
    stopRealtimeTranscriber(source).catch(() => {});
  };

  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const src = ctx.createMediaStreamSource(new MediaStream([track]));

  // ScriptProcessor for broad browser support (works in Chrome/Edge)
  const proc = ctx.createScriptProcessor(2048, 1, 1);
  proc.onaudioprocess = (e) => {
    if (!isRunning) return;
    if (!dc || dc.readyState !== "open") return;

    const input = e.inputBuffer.getChannelData(0);
    const down = downsampleBuffer(input, ctx.sampleRate, REALTIME_PCM_RATE);
    const pcm16 = floatTo16BitPCM(down);

    const bytes = new Uint8Array(pcm16.buffer);
    const audioB64 = b64FromBytes(bytes);

    sendRt(dc, { type: "input_audio_buffer.append", audio: audioB64 });
  };

  src.connect(proc);
  proc.connect(ctx.destination); // keep processor alive

  rt.ctx = ctx;
  rt.src = src;
  rt.proc = proc;
  rt.media = media;

  if (source === "mic") rtMic = rt;
  else rtSys = rt;

  return rt;
}

async function stopRealtimeTranscriber(source) {
  const rt = source === "mic" ? rtMic : rtSys;
  if (!rt) return;

  try { sendRt(rt.dc, { type: "input_audio_buffer.commit" }); } catch {}

  try { rt.proc && rt.proc.disconnect(); } catch {}
  try { rt.src && rt.src.disconnect(); } catch {}
  try { rt.ctx && rt.ctx.close(); } catch {}
  try { rt.dc && rt.dc.close(); } catch {}
  try { rt.pc && rt.pc.close(); } catch {}
  try { rt.media && rt.media.getTracks().forEach(t => t.stop()); } catch {}

  if (source === "mic") {
    rtMic = null;
    removeInterim("mic");
  } else {
    rtSys = null;
    removeInterim("sys");
  }
}

//--------------------------------------------------------------
// MIC — SpeechRecognition (kept as fallback only)
//--------------------------------------------------------------
function micSrIsHealthy() {
  return (Date.now() - (lastMicResultAt || 0)) < 1800;
}

function stopMicOnly() {
  try { recognition?.stop(); } catch {}
  recognition = null;
  if (micWatchdog) clearInterval(micWatchdog);
  micWatchdog = null;
}

function startMicFallbackSR() {
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

  recognition.onstart = () => setStatus(audioStatus, "Mic active (SR fallback).", "text-green-600");

  recognition.onresult = (ev) => {
    if (!isRunning) return;
    if (Date.now() < blockMicUntil) return;

    lastMicResultAt = Date.now();

    let latestInterim = "";
    for (let i = ev.resultIndex; i < ev.results.length; i++) {
      const r = ev.results[i];
      const text = normalize(r[0].transcript || "");
      if (r.isFinal) addFinalSpeech(text, "mic");
      else latestInterim = text;
    }

    if (latestInterim) setInterim("mic", latestInterim);
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

  if (micWatchdog) clearInterval(micWatchdog);
  micWatchdog = setInterval(() => {
    if (!isRunning) return;
    if (micSrIsHealthy()) {
      if (micRecorder || micStream) stopMicRecorderOnly();
      return;
    }
  }, 800);

  try { recognition.start(); } catch {}
  return true;
}

// ---- Mic fallback recorder (unchanged) ----
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

  if (myEpoch !== transcriptEpoch) return;

  if (!res.ok) return;

  const data = await res.json().catch(() => ({}));
  const raw = String(data.text || "");
  if (looksLikeWhisperHallucination(raw)) return;

  const cleaned = dedupeByTail(raw, {
    get value() { return lastMicTail; },
    set value(v) { lastMicTail = v; }
  });

  if (cleaned) addFinalSpeech(cleaned, "mic");
}

//--------------------------------------------------------------
// SYSTEM AUDIO LEGACY (kept as fallback)
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
      setStatus(audioStatus, "System audio stopped (backend errors).", "text-red-600");
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

  if (cleaned) addFinalSpeech(cleaned, "sys");
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
// CHAT STREAMING (FIXED: abort no longer shows "Failed")
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

  const render = () => {
    // Only render if this request is still the active one
    if (!chatStreamActive || mySeq !== chatStreamSeq) return;
    responseBox.innerHTML = renderMarkdown(raw);
  };

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
    // Abort is expected when user clicks Send again — do NOT show failure
    const msg = String(e?.message || e || "");
    const isAbort = e?.name === "AbortError" || msg.toLowerCase().includes("aborted");
    if (isAbort || mySeq !== chatStreamSeq) return;

    console.error(e);
    setStatus(sendStatus, "Failed", "text-red-600");
    responseBox.innerHTML = `<span class="text-red-600 text-sm">Failed. Check backend /chat/send streaming.</span>`;
  } finally {
    if (flushTimer) clearInterval(flushTimer);
  }
}

//--------------------------------------------------------------
// RESUME UPLOAD (unchanged)
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

  transcriptEpoch++;
  timeline = [];
  micInterimEntry = null;
  sysInterimEntry = null;
  lastSpeechAt = 0;
  sentCursor = 0;
  pinnedTop = true;

  lastSysTail = "";
  lastMicTail = "";
  lastFinalText = "";
  lastFinalAt = 0;

  updateTranscript();

  isRunning = true;

  startBtn.disabled = true;
  stopBtn.disabled = false;
  sysBtn.disabled = false;
  sendBtn.disabled = false;

  stopBtn.classList.remove("opacity-50");
  sysBtn.classList.remove("opacity-50");
  sendBtn.classList.remove("opacity-60");

  // 1) Try REALTIME mic first
  try {
    await startRealtimeTranscriber("mic");
  } catch (e) {
    // 2) Fallback to SR (your existing behavior)
    console.warn("Mic realtime failed, using fallback:", e);
    setStatus(audioStatus, "Mic realtime failed. Using SR fallback…", "text-orange-600");
    const ok = startMicFallbackSR();
    if (!ok) await enableMicRecorderFallback().catch(() => {});
  }

  startCreditTicking();
}

function stopAll() {
  isRunning = false;

  // Stop realtime first
  stopRealtimeTranscriber("mic").catch(() => {});
  stopRealtimeTranscriber("sys").catch(() => {});

  // Stop fallbacks
  stopMicOnly();
  stopMicRecorderOnly();
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
  sysInterimEntry = null;
  lastSpeechAt = 0;
  sentCursor = 0;
  pinnedTop = true;

  updateTranscript();
}

//--------------------------------------------------------------
// QUESTION HELPERS (unchanged from your file)
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
// SEND / CLEAR / RESET
//--------------------------------------------------------------
sendBtn.onclick = async () => {
  if (sendBtn.disabled) return;

  // Abort current stream, but old aborted request can’t overwrite UI anymore
  abortChatStreamOnly();

  const manual = normalize(manualQuestion?.value || "");
  const fresh = normalize(getFreshBlocksText());
  const base = manual || fresh;
  if (!base) return;

  blockMicUntil = Date.now() + 700;

  sentCursor = timeline.length;
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
  sysInterimEntry = null;
  lastSpeechAt = 0;
  sentCursor = 0;
  pinnedTop = true;

  lastSysTail = "";
  lastMicTail = "";
  lastFinalText = "";
  lastFinalAt = 0;

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

// System Audio button: try realtime first, fallback to legacy
sysBtn.onclick = async () => {
  if (!isRunning) return;
  try {
    await startRealtimeTranscriber("sys");
  } catch (e) {
    console.warn("System realtime failed, using legacy:", e);
    setStatus(audioStatus, "System realtime failed. Using legacy segment transcribe…", "text-orange-600");
    await enableSystemAudioLegacy();
  }
};
