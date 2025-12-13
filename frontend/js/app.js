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
// CONSTANTS
//--------------------------------------------------------------
const PAUSE_NEWLINE_MS = 3000;

const CREDIT_BATCH_SEC = 5;
const CREDITS_PER_SEC = 1;

// Strong transcription prompt to reduce hallucinations/repeats
const TRANSCRIBE_PROMPT =
  "Transcribe exactly what is spoken. Do NOT add new words. Do NOT repeat phrases. Do NOT translate. Keep punctuation minimal. If uncertain, omit.";

// Realtime streaming ASR settings
const RT_SAMPLE_RATE = 24000;           // required for pcm16 in realtime transcription :contentReference[oaicite:5]{index=5}
const RT_FRAME_MS = 50;                 // 20–50ms is typical; 50ms is stable in browsers
const RT_FRAME_SAMPLES = Math.round((RT_SAMPLE_RATE * RT_FRAME_MS) / 1000);

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
    .slice(sentCursor)
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

function addOrAppendLine(text) {
  const cleaned = normalize(text);
  if (!cleaned) return;

  const now = Date.now();
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
// REALTIME STREAMING ASR (Mic + System) — FIXES CHROME
//--------------------------------------------------------------
function floatToPcm16Bytes(f32) {
  const out = new Uint8Array(f32.length * 2);
  let o = 0;
  for (let i = 0; i < f32.length; i++) {
    let s = Math.max(-1, Math.min(1, f32[i]));
    const v = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
    out[o++] = v & 0xff;
    out[o++] = (v >> 8) & 0xff;
  }
  return out;
}

function downsampleTo24k(inputF32, inputRate) {
  if (inputRate === RT_SAMPLE_RATE) return inputF32;

  const ratio = inputRate / RT_SAMPLE_RATE;
  const newLen = Math.max(1, Math.round(inputF32.length / ratio));
  const out = new Float32Array(newLen);

  let inPos = 0;
  for (let i = 0; i < newLen; i++) {
    const nextInPos = Math.round((i + 1) * ratio);
    let sum = 0;
    let cnt = 0;
    for (let j = inPos; j < nextInPos && j < inputF32.length; j++) {
      sum += inputF32[j];
      cnt++;
    }
    out[i] = cnt ? sum / cnt : 0;
    inPos = nextInPos;
  }
  return out;
}

function bytesToBase64(bytes) {
  // bytes is Uint8Array
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    const sub = bytes.subarray(i, i + chunk);
    bin += String.fromCharCode.apply(null, sub);
  }
  return btoa(bin);
}

async function getRealtimeTranscriptionToken() {
  const res = await apiFetch("realtime/transcription_token", { method: "POST" }, true);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Token mint failed");
  if (!data?.token) throw new Error("Missing realtime token");
  return data.token;
}

class RealtimeTranscriber {
  constructor(label) {
    this.label = label;
    this.ws = null;
    this.audioCtx = null;
    this.source = null;
    this.proc = null;
    this.stream = null;

    this.queue = [];          // array of Uint8Array
    this.queueBytes = 0;

    this.itemMap = new Map(); // item_id -> { entry, raw }
    this.closed = false;
    this.epoch = transcriptEpoch;
  }

  async startFromStream(stream) {
    this.stop();
    this.epoch = transcriptEpoch;
    this.stream = stream;

    const token = await getRealtimeTranscriptionToken();

    // Realtime transcription websocket :contentReference[oaicite:6]{index=6}
    const url = "wss://api.openai.com/v1/realtime?intent=transcription";

    // Browser auth uses subprotocols; the server accepts a key via subprotocol string. :contentReference[oaicite:7]{index=7}
    this.ws = new WebSocket(url, ["realtime", "openai-insecure-api-key." + token]);

    this.ws.onopen = () => {
      const cfg = {
        type: "transcription_session.update",
        input_audio_format: "pcm16",
        input_audio_transcription: {
          model: "gpt-4o-transcribe",
          prompt: TRANSCRIBE_PROMPT,
          language: "en"
        },
        turn_detection: {
          type: "server_vad",
          threshold: 0.5,
          prefix_padding_ms: 300,
          silence_duration_ms: 350
        },
        input_audio_noise_reduction: { type: "near_field" }
      };
      try { this.ws.send(JSON.stringify(cfg)); } catch {}
      setStatus(audioStatus, `${this.label} active (streaming ASR).`, "text-green-600");
    };

    this.ws.onmessage = (ev) => {
      if (!isRunning) return;
      if (this.closed) return;
      if (this.epoch !== transcriptEpoch) return;

      let msg = null;
      try { msg = JSON.parse(ev.data); } catch { return; }

      // The key events for streaming transcript are delta + completed :contentReference[oaicite:8]{index=8}
      if (msg.type === "conversation.item.input_audio_transcription.delta") {
        const itemId = msg.item_id || "no_item";
        const delta = String(msg.delta || "");
        if (!delta) return;

        let rec = this.itemMap.get(itemId);
        if (!rec) {
          const entry = { t: Date.now(), text: "" };
          timeline.push(entry);
          rec = { entry, raw: "" };
          this.itemMap.set(itemId, rec);
        }
        rec.raw += delta;
        rec.entry.text = normalize(rec.raw);
        rec.entry.t = Date.now();
        updateTranscript();
        return;
      }

      if (msg.type === "conversation.item.input_audio_transcription.completed") {
        const itemId = msg.item_id || "no_item";
        const transcript = normalize(msg.transcript || "");
        if (!transcript) return;

        let rec = this.itemMap.get(itemId);
        if (!rec) {
          const entry = { t: Date.now(), text: transcript };
          timeline.push(entry);
          rec = { entry, raw: transcript };
          this.itemMap.set(itemId, rec);
        } else {
          rec.raw = transcript;
          rec.entry.text = transcript;
          rec.entry.t = Date.now();
        }

        lastSpeechAt = Date.now();
        updateTranscript();
        return;
      }

      if (msg.type === "error") {
        const e = msg?.error?.message || "Realtime error";
        setStatus(audioStatus, `${this.label} ASR error: ${e}`, "text-red-600");
      }
    };

    this.ws.onclose = () => {
      if (this.closed) return;
      setStatus(audioStatus, `${this.label} streaming closed.`, "text-orange-600");
    };

    this.ws.onerror = () => {
      setStatus(audioStatus, `${this.label} streaming failed (WebSocket).`, "text-red-600");
    };

    // Audio capture -> script processor -> downsample -> pcm16 -> send append
    this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const track = stream.getAudioTracks?.()[0];
    if (!track) throw new Error("No audio track");

    this.source = this.audioCtx.createMediaStreamSource(new MediaStream([track]));
    this.proc = this.audioCtx.createScriptProcessor(4096, 1, 1);
    this.source.connect(this.proc);
    this.proc.connect(this.audioCtx.destination);

    this.proc.onaudioprocess = (e) => {
      if (!isRunning) return;
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      if (this.epoch !== transcriptEpoch) return;

      const input = e.inputBuffer.getChannelData(0);
      const down = downsampleTo24k(input, this.audioCtx.sampleRate);
      const bytes = floatToPcm16Bytes(down);

      this.queue.push(bytes);
      this.queueBytes += bytes.length;

      const targetBytes = RT_FRAME_SAMPLES * 2;

      while (this.queueBytes >= targetBytes) {
        const frame = new Uint8Array(targetBytes);
        let written = 0;
        while (written < targetBytes && this.queue.length) {
          const head = this.queue[0];
          const need = targetBytes - written;
          if (head.length <= need) {
            frame.set(head, written);
            written += head.length;
            this.queue.shift();
            this.queueBytes -= head.length;
          } else {
            frame.set(head.subarray(0, need), written);
            this.queue[0] = head.subarray(need);
            written += need;
            this.queueBytes -= need;
          }
        }

        const b64 = bytesToBase64(frame);
        const payload = { type: "input_audio_buffer.append", audio: b64 }; // :contentReference[oaicite:9]{index=9}
        try { this.ws.send(JSON.stringify(payload)); } catch {}
      }
    };

    return true;
  }

  stop() {
    this.closed = true;

    try { this.proc && (this.proc.onaudioprocess = null); } catch {}
    try { this.source && this.source.disconnect(); } catch {}
    try { this.proc && this.proc.disconnect(); } catch {}

    try { this.audioCtx && this.audioCtx.close(); } catch {}

    try { this.ws && this.ws.close(); } catch {}

    if (this.stream) {
      try { this.stream.getTracks().forEach(t => t.stop()); } catch {}
    }

    this.ws = null;
    this.audioCtx = null;
    this.source = null;
    this.proc = null;
    this.stream = null;

    this.queue = [];
    this.queueBytes = 0;
    this.itemMap.clear();

    this.closed = false;
  }
}

let rtMic = null;
let rtSys = null;

//--------------------------------------------------------------
// QUESTION RELEVANCE HELPERS (unchanged)
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
- First line must be: "Q: ..."
- Then answer in two sections only:
1) Quick Answer (Interview Style)
2) Real-Time Project Example
`.trim();
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
// CHAT STREAMING — FIX ABORT => NO "FAILED" UI
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
  // Abort old request first, but do NOT allow its catch() to overwrite new UI
  abortChatStreamOnly();

  chatAbort = new AbortController();
  chatStreamActive = true;
  const mySeq = ++chatStreamSeq;

  if (userTextForHistory) pushHistory("user", userTextForHistory);

  // Always wipe previous response immediately (your requirement)
  responseBox.innerHTML = "";
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
    // KEY FIX: if aborted intentionally or superseded, do nothing (no "Failed...")
    const aborted = chatAbort?.signal?.aborted || e?.name === "AbortError" || String(e?.message || "").toLowerCase().includes("aborted");
    if (aborted || mySeq !== chatStreamSeq) return;

    console.error(e);
    setStatus(sendStatus, "Failed", "text-red-600");
    // Keep responseBox empty (your requirement)
    responseBox.innerHTML = "";
  } finally {
    if (flushTimer) clearInterval(flushTimer);
    if (mySeq === chatStreamSeq) chatStreamActive = false;
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
// START / STOP — NOW USE STREAMING ASR
//--------------------------------------------------------------
async function startAll() {
  hideBanner();
  if (isRunning) return;

  await apiFetch("chat/reset", { method: "POST" }, false).catch(() => {});

  transcriptEpoch++;
  timeline = [];
  lastSpeechAt = 0;
  sentCursor = 0;
  pinnedTop = true;
  updateTranscript();

  isRunning = true;

  startBtn.disabled = true;
  stopBtn.disabled = false;
  sysBtn.disabled = false;
  sendBtn.disabled = false;

  stopBtn.classList.remove("opacity-50");
  sysBtn.classList.remove("opacity-50");
  sendBtn.classList.remove("opacity-60");

  // Mic streaming ASR (primary)
  try {
    rtMic = new RealtimeTranscriber("Mic");
    const micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    await rtMic.startFromStream(micStream);
  } catch (e) {
    console.error(e);
    setStatus(audioStatus, "Mic streaming failed. Check realtime token route.", "text-red-600");
    showBanner("Mic streaming failed. Check /api?path=realtime/transcription_token and browser console.");
  }

  startCreditTicking();
}

function stopAll() {
  isRunning = false;

  try { rtMic?.stop(); } catch {}
  try { rtSys?.stop(); } catch {}
  rtMic = null;
  rtSys = null;

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
// SYSTEM AUDIO — STREAMING ASR
//--------------------------------------------------------------
async function enableSystemAudio() {
  if (!isRunning) return;

  try { rtSys?.stop(); } catch {}
  rtSys = null;

  let sysStream = null;
  try {
    // Chrome will only include audio if the user selects a source that supports it
    // (often "Chrome Tab" + checkbox "Share tab audio").
    sysStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
  } catch {
    setStatus(audioStatus, "System audio permission denied.", "text-red-600");
    return;
  }

  const sysTrack = sysStream.getAudioTracks?.()[0];
  if (!sysTrack) {
    sysStream.getTracks().forEach(t => t.stop());
    setStatus(audioStatus, "No system audio track. Select Chrome Tab + enable 'Share tab audio'.", "text-red-600");
    showBanner("System audio needs Chrome Tab selection + 'Share tab audio' enabled.");
    return;
  }

  sysTrack.onended = () => {
    try { rtSys?.stop(); } catch {}
    rtSys = null;
    setStatus(audioStatus, "System audio stopped (share ended).", "text-orange-600");
  };

  try {
    rtSys = new RealtimeTranscriber("System");
    await rtSys.startFromStream(new MediaStream([sysTrack]));
  } catch (e) {
    console.error(e);
    setStatus(audioStatus, "System streaming failed. Check realtime token route.", "text-red-600");
  }
}

//--------------------------------------------------------------
// HARD CLEAR (stop late results + clear everything visible)
//--------------------------------------------------------------
function hardClearTranscript() {
  transcriptEpoch++;

  timeline = [];
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

  // Stop streaming response and immediately accept the new prompt (no failed message)
  abortChatStreamOnly();

  const manual = normalize(manualQuestion?.value || "");
  const fresh = normalize(getFreshBlocksText());
  const base = manual || fresh;
  if (!base) return;

  // move cursor (do NOT clear transcript)
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
  lastSpeechAt = 0;
  sentCursor = 0;
  pinnedTop = true;
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
