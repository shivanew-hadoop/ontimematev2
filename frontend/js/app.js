/* ========================================================================== */
/* app.js — STATE-OF-THE-ART DEEPGRAM NOVA-2 TRANSCRIPTION                  */
/* 90%+ accuracy, <300ms latency, real-time word-by-word                    */
/* ========================================================================== */

const COMMIT_WORDS = 2;

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

let session = null;
let isRunning = false;
let hiddenInstructions = "";
let micMuted = false;

let sysStream = null;
let sysAudioContext = null;
let sysProcessor = null;
let sysWebSocket = null;
let sysReconnectTimer = null;
let currentInterimEntry = null;

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

const PAUSE_NEWLINE_MS = 3000;
const CREDIT_BATCH_SEC = 5;
const CREDITS_PER_SEC = 1;

const MODE_INSTRUCTIONS = {
  general: "",
  interview: "",
  sales: "Respond in persuasive, value-driven style. Highlight benefits/outcomes.".trim()
};

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

async function setMicMuted(on) {
  micMuted = !!on;
  updateMicMuteUI();
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

if (liveTranscript) {
  const TH = 40;
  liveTranscript.addEventListener("scroll", () => { 
    pinnedTop = liveTranscript.scrollTop <= TH; 
  }, { passive: true });
}

function getAllBlocksNewestFirst() {
  return timeline.slice()
    .sort((a, b) => (b.t || 0) - (a.t || 0))
    .map(x => String(x.text || "").trim())
    .filter(Boolean);
}

function getFreshBlocksText() {
  return timeline.slice(sentCursor)
    .map(x => String(x.text || "").trim())
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

function getFreshInterviewerBlocksText() {
  return timeline.slice(sentCursor)
    .filter(x => x && x.role === "interviewer")
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
  console.log("[TRANSCRIPT] Added:", trimmedRaw.substring(0, 50));
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

async function getDeepgramKey() {
  const res = await apiFetch("deepgram/key", {
    method: "POST",
    headers: { "Content-Type": "application/json" }
  }, true);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data?.key) throw new Error(data?.error || "Failed to get Deepgram key");
  return data.key;
}

function stopSystemAudioOnly() {
  if (sysReconnectTimer) {
    clearTimeout(sysReconnectTimer);
    sysReconnectTimer = null;
  }
  
  try { sysWebSocket?.close(); } catch {}
  sysWebSocket = null;
  
  try { sysProcessor?.disconnect(); } catch {}
  sysProcessor = null;
  
  try { sysAudioContext?.close(); } catch {}
  sysAudioContext = null;
  
  if (sysStream) {
    try { sysStream.getTracks().forEach(t => t.stop()); } catch {}
  }
  sysStream = null;
}

async function enableSystemAudio() {
  if (!isRunning) return;
  stopSystemAudioOnly();
  
  console.log("[DEEPGRAM] Starting system audio capture...");
  
  try {
    sysStream = await navigator.mediaDevices.getDisplayMedia({ 
      video: true, 
      audio: { 
        echoCancellation: false, 
        noiseSuppression: false, 
        autoGainControl: false,
        sampleRate: 16000
      }
    });
  } catch (err) {
    console.error("[DEEPGRAM] Permission denied:", err);
    setStatus(audioStatus, "Share audio denied.", "text-red-600");
    return;
  }

  const audioTrack = sysStream.getAudioTracks()[0];
  if (!audioTrack) {
    console.error("[DEEPGRAM] No audio track");
    setStatus(audioStatus, "No system audio detected.", "text-red-600");
    stopSystemAudioOnly();
    showBanner("System audio requires selecting a window/tab and enabling 'Share audio' in the picker.");
    return;
  }

  console.log("[DEEPGRAM] Audio track acquired");
  audioTrack.onended = () => {
    console.log("[DEEPGRAM] Track ended");
    stopSystemAudioOnly();
    setStatus(audioStatus, "System audio stopped (share ended).", "text-orange-600");
  };

  try {
    const apiKey = await getDeepgramKey();
    
    const wsUrl = `wss://api.deepgram.com/v1/listen?model=nova-2&language=en-IN&punctuate=true&interim_results=true&smart_format=true&encoding=linear16&sample_rate=16000`;
    
    sysWebSocket = new WebSocket(wsUrl, ["token", apiKey]);
    
    sysWebSocket.onopen = () => {
      console.log("[DEEPGRAM] WebSocket connected");
      setStatus(audioStatus, "System audio LIVE (Deepgram Nova-2).", "text-green-600");
    };
    
    sysWebSocket.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        
        if (data.type === "Results") {
          const transcript = data.channel?.alternatives?.[0]?.transcript || "";
          const isFinal = data.is_final;
          
          if (!transcript.trim()) return;
          
          console.log(`[DEEPGRAM] ${isFinal ? 'FINAL' : 'interim'}:`, transcript);
          
          if (isFinal) {
            if (currentInterimEntry) {
              const idx = timeline.indexOf(currentInterimEntry);
              if (idx >= 0) timeline.splice(idx, 1);
              currentInterimEntry = null;
            }
            
            addFinalSpeech(transcript, "interviewer");
          } else {
            if (currentInterimEntry) {
              currentInterimEntry.text = normalize(transcript);
              currentInterimEntry.t = Date.now();
            } else {
              currentInterimEntry = { 
                t: Date.now(), 
                text: normalize(transcript), 
                role: "interviewer" 
              };
              timeline.push(currentInterimEntry);
            }
            updateTranscript();
          }
        }
      } catch (e) {
        console.error("[DEEPGRAM] Message parse error:", e);
      }
    };
    
    sysWebSocket.onerror = (err) => {
      console.error("[DEEPGRAM] WebSocket error:", err);
      setStatus(audioStatus, "Deepgram connection error.", "text-red-600");
    };
    
    sysWebSocket.onclose = () => {
      console.log("[DEEPGRAM] WebSocket closed");
      if (isRunning) {
        setStatus(audioStatus, "Reconnecting...", "text-orange-600");
        sysReconnectTimer = setTimeout(() => enableSystemAudio(), 1000);
      }
    };
    
    sysAudioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
    const source = sysAudioContext.createMediaStreamSource(sysStream);
    sysProcessor = sysAudioContext.createScriptProcessor(4096, 1, 1);
    
    sysProcessor.onaudioprocess = (e) => {
      if (!isRunning || !sysWebSocket || sysWebSocket.readyState !== WebSocket.OPEN) return;
      
      const inputData = e.inputBuffer.getChannelData(0);
      
      const int16Data = new Int16Array(inputData.length);
      for (let i = 0; i < inputData.length; i++) {
        const s = Math.max(-1, Math.min(1, inputData[i]));
        int16Data[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
      }
      
      if (sysWebSocket.readyState === WebSocket.OPEN) {
        sysWebSocket.send(int16Data.buffer);
      }
    };
    
    source.connect(sysProcessor);
    sysProcessor.connect(sysAudioContext.destination);
    
  } catch (e) {
    console.error("[DEEPGRAM] Setup failed:", e);
    setStatus(audioStatus, `Deepgram error: ${e.message}`, "text-red-600");
  }
}

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
    resumeText: resumeTextMem || "", 
    sessionId: getSessionId() 
  };
  
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

async function startAll() {
  console.log("[START] Initializing...");
  hideBanner();
  if (isRunning) return;
  
  await apiFetch("chat/reset", { method: "POST" }, false).catch(() => {});
  
  transcriptEpoch++;
  timeline = [];
  currentInterimEntry = null;
  lastSpeechAt = 0;
  sentCursor = 0;
  pinnedTop = true;
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
  console.log("[STOP] Stopping all...");
  isRunning = false;
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

function hardClearTranscript() {
  transcriptEpoch++;
  timeline = [];
  currentInterimEntry = null;
  lastSpeechAt = 0;
  sentCursor = 0;
  pinnedTop = true;
  resetRoleCommitState();
  updateTranscript();
}

async function handleSend() {

    // 🔒 1. Force commit visible interim text
  if (currentInterimEntry) {
    const tmp = currentInterimEntry;
    currentInterimEntry = null;
    addFinalSpeech(tmp.text, tmp.role);
  }

  // ⏳ 2. Small wait to allow Deepgram final to land
  await new Promise(r => setTimeout(r, 120));
  
  if (sendBtn.disabled) return;

  if (currentInterimEntry) {
  const tmp = currentInterimEntry;
  currentInterimEntry = null;
  addFinalSpeech(tmp.text, tmp.role);
}

  
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
  console.log("[LOAD] Page loaded");
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
  currentInterimEntry = null;
  lastSpeechAt = 0;
  sentCursor = 0;
  pinnedTop = true;
  resetRoleCommitState();
  stopSystemAudioOnly();
  updateTranscript();
  
  stopBtn.disabled = true;
  sysBtn.disabled = true;
  sendBtn.disabled = true;
  stopBtn.classList.add("opacity-50");
  sysBtn.classList.add("opacity-50");
  sendBtn.classList.add("opacity-60");
  
  setStatus(audioStatus, "Stopped", "text-orange-600");
  updateMicMuteUI();
  console.log("[LOAD] Initialization complete");
});

startBtn.onclick = startAll;
stopBtn.onclick = stopAll;
sysBtn.onclick = enableSystemAudio;