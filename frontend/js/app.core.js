/* ==========================================================================
   app.core.js
   - Creates window.ANU_APP namespace
   - Holds: state, util, ui, api, dom refs, transcript, question builders
   - DOES NOT start audio or chat; those live in app.audio.js/app.chat.js
   ========================================================================== */

(() => {
  "use strict";

  // ------------------------------------------------------------
  // Namespace + State
  // ------------------------------------------------------------
  const A = (window.ANU_APP = window.ANU_APP || {});
  const S = (A.state = A.state || {});

  // Session + state
  S.session = null;
  S.isRunning = false;

  // Instructions
  S.hiddenInstructions = "";

  // Mic mute
  S.micMuted = false;

  // SR state (kept for compatibility even if disabled)
  S.recognition = null;
  S.blockMicUntil = 0;
  S.micInterimEntry = null;
  S.lastMicResultAt = 0;
  S.micWatchdog = null;

  // Mic fallback recorder
  S.micStream = null;
  S.micTrack = null;
  S.micRecorder = null;
  S.micSegmentChunks = [];
  S.micSegmentTimer = null;
  S.micQueue = [];
  S.micAbort = null;
  S.micInFlight = 0;

  // System audio
  S.sysStream = null;
  S.sysTrack = null;
  S.sysRecorder = null;
  S.sysSegmentChunks = [];
  S.sysSegmentTimer = null;
  S.sysQueue = [];
  S.sysAbort = null;
  S.sysInFlight = 0;

  S.sysErrCount = 0;
  S.sysErrBackoffUntil = 0;

  // Dedupe tails
  S.lastSysTail = "";
  S.lastMicTail = "";

  // Sys overlap memory
  S.lastSysPrinted = "";
  S.lastSysPrintedAt = 0;

  // Intent/topic memory
  S.activeIntent = null; // "code" | "debug" | "design" | "theory"
  S.activeTech = null;
  S.recentTopics = [];

  // Transcript blocks
  S.timeline = [];
  S.lastSpeechAt = 0;
  S.sentCursor = 0;
  S.pinnedTop = true;

  // Credits
  S.creditTimer = null;
  S.lastCreditAt = 0;

  // Chat streaming
  S.chatAbort = null;
  S.chatStreamActive = false;
  S.chatStreamSeq = 0;

  S.chatHistory = [];
  S.resumeTextMem = "";

  // Hard clear token
  S.transcriptEpoch = 0;

  // DOM handles
  A.dom = A.dom || {};

  // ------------------------------------------------------------
  // Constants (shared)
  // ------------------------------------------------------------
  A.const = A.const || {};

  A.const.PAUSE_NEWLINE_MS = 3000;

  A.const.MIC_SEGMENT_MS = 1200;
  A.const.MIC_MIN_BYTES = 1800;
  A.const.MIC_MAX_CONCURRENT = 2;

  A.const.SYS_SEGMENT_MS = 2800;
  A.const.SYS_MIN_BYTES = 6000;
  A.const.SYS_MAX_CONCURRENT = 1;
  A.const.SYS_TYPE_MS_PER_WORD = 18;

  A.const.SYS_ERR_MAX = 3;
  A.const.SYS_ERR_BACKOFF_MS = 10000;

  A.const.CREDIT_BATCH_SEC = 5;
  A.const.CREDITS_PER_SEC = 1;

  A.const.MIC_LANGS = ["en-IN", "en-GB", "en-US"];
  S.micLangIndex = 0;

  // If you had it elsewhere, it now lived here:
  A.const.USE_BROWSER_SR = false; // matches your current behavior (you hard-coded micOk=false)
  A.const.USE_STREAMING_ASR_SYS = true;
  A.const.USE_STREAMING_ASR_MIC_FALLBACK = false;

  A.const.REALTIME_INTENT_URL = "wss://api.openai.com/v1/realtime?intent=transcription";
  A.const.REALTIME_ASR_MODEL = "gpt-4o-mini-transcribe";
  A.const.ASR_SEND_EVERY_MS = 40;
  A.const.ASR_TARGET_RATE = 24000;

  // This constant was referenced but not shown in your paste; I defined it safely.
  A.const.COMMIT_WORDS = 22;

  A.const.TRANSCRIBE_PROMPT =
    "Transcribe only English as spoken with an Indian English accent. " +
    "STRICTLY ignore and OMIT any Urdu, Arabic, Hindi, or other non-English words. " +
    "If a word is not English, drop it completely. " +
    "Use Indian English pronunciation and spelling. " +
    "Do NOT Americanize words. " +
    "Do NOT translate. " +
    "Do NOT add new words. Do NOT repeat phrases. " +
    "Keep punctuation minimal. If uncertain, omit.";

  // Mode instructions
  A.const.MODE_INSTRUCTIONS = {
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

  // ------------------------------------------------------------
  // UTIL
  // ------------------------------------------------------------
  A.util = A.util || {};

  A.util.normalize = function normalize(s) {
    return (s || "").replace(/\s+/g, " ").trim();
  };

  A.util.escapeHtml = function escapeHtml(s) {
    return String(s || "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  };

  A.util.fixSpacingOutsideCodeBlocks = function fixSpacingOutsideCodeBlocks(text) {
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
  };

  A.util.renderMarkdownLite = function renderMarkdownLite(md) {
    if (!md) return "";
    let safe = String(md).replace(/<br\s*\/?>/gi, "\n");
    safe = A.util.fixSpacingOutsideCodeBlocks(safe);
    safe = A.util.escapeHtml(safe);
    safe = safe.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
    safe = safe
      .replace(/\r\n/g, "\n")
      .replace(/\n\s*\n/g, "<br><br>")
      .replace(/\n/g, "<br>");
    return safe.trim();
  };

  S.aiRawBuffer = "";

  A.util.setupMarkdownRenderer = function setupMarkdownRenderer() {
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
  };

  A.util.renderMarkdownSafe = function renderMarkdownSafe(mdText) {
    if (!window.marked || !window.DOMPurify) {
      return A.util.renderMarkdownLite(mdText);
    }
    const html = marked.parse(mdText || "");
    return DOMPurify.sanitize(html);
  };

  A.util.enhanceCodeBlocks = function enhanceCodeBlocks(containerEl) {
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
  };

  A.util.appendStreamChunk = function appendStreamChunk(chunkText) {
    S.aiRawBuffer += chunkText;
    // streaming view: keep it fast & stable
    if (A.dom.responseBox) A.dom.responseBox.textContent = S.aiRawBuffer;
  };

  A.util.finalizeRenderedResponse = function finalizeRenderedResponse() {
    if (!A.dom.responseBox) return;
    A.dom.responseBox.innerHTML = A.util.renderMarkdownSafe(S.aiRawBuffer);

    if (window.hljs) {
      A.dom.responseBox.querySelectorAll("pre code").forEach((block) => {
        try { hljs.highlightElement(block); } catch {}
      });
    }
    A.util.enhanceCodeBlocks(A.dom.responseBox);
  };

  document.addEventListener("DOMContentLoaded", () => {
    A.util.setupMarkdownRenderer();
  });

  // ------------------------------------------------------------
  // UI
  // ------------------------------------------------------------
  A.ui = A.ui || {};

  A.ui.showBanner = function showBanner(msg) {
    const el = A.dom.bannerTop;
    if (!el) return;
    el.textContent = msg;
    el.classList.remove("hidden");
    el.classList.add("bg-red-600");
  };

  A.ui.hideBanner = function hideBanner() {
    const el = A.dom.bannerTop;
    if (!el) return;
    el.classList.add("hidden");
    el.textContent = "";
  };

  A.ui.setStatus = function setStatus(el, text, cls = "") {
    if (!el) return;
    el.textContent = text;
    el.className = cls;
  };

  // ------------------------------------------------------------
  // API
  // ------------------------------------------------------------
  A.api = A.api || {};

  A.api.authHeaders = function authHeaders() {
    const token = S.session?.access_token;
    return token ? { Authorization: `Bearer ${token}` } : {};
  };

  A.api.isTokenNearExpiry = function isTokenNearExpiry() {
    const exp = Number(S.session?.expires_at || 0);
    if (!exp) return false;
    const now = Math.floor(Date.now() / 1000);
    return exp - now < 60;
  };

  A.api.refreshAccessToken = async function refreshAccessToken() {
    const refresh_token = S.session?.refresh_token;
    if (!refresh_token) throw new Error("Missing refresh_token. Please login again.");

    const res = await fetch("/api?path=auth/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token })
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Refresh failed");

    S.session.access_token = data.session.access_token;
    S.session.refresh_token = data.session.refresh_token;
    S.session.expires_at = data.session.expires_at;

    localStorage.setItem("session", JSON.stringify(S.session));
  };

  A.api.apiFetch = async function apiFetch(path, opts = {}, needAuth = true) {
    if (needAuth && A.api.isTokenNearExpiry()) {
      try { await A.api.refreshAccessToken(); } catch {}
    }

    const headers = { ...(opts.headers || {}) };
    if (needAuth) Object.assign(headers, A.api.authHeaders());

    const res = await fetch(`/api?path=${encodeURIComponent(path)}`, {
      ...opts,
      headers,
      cache: "no-store"
    });

    if (needAuth && res.status === 401) {
      const t = await res.text().catch(() => "");
      const looksExpired =
        t.includes("token is expired") ||
        t.includes("invalid JWT") ||
        t.includes("Missing token");
      if (looksExpired) {
        await A.api.refreshAccessToken();
        const headers2 = { ...(opts.headers || {}), ...A.api.authHeaders() };
        return fetch(`/api?path=${encodeURIComponent(path)}`, {
          ...opts,
          headers: headers2,
          cache: "no-store"
        });
      }
    }

    return res;
  };

  // ------------------------------------------------------------
  // TRANSCRIPT (role-safe)
  // ------------------------------------------------------------
  A.transcript = A.transcript || {};

  function canonKey(s) {
    return A.util.normalize(String(s || ""))
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
        const origWords = A.util.normalize(nextRaw).split(" ");
        return origWords.slice(k).join(" ").trim();
      }
    }
    return nextRaw;
  }

  const lastCommittedByRole = {
    interviewer: { key: "", at: 0, raw: "" },
    candidate: { key: "", at: 0, raw: "" }
  };

  A.transcript.resetRoleCommitState = function resetRoleCommitState() {
    lastCommittedByRole.interviewer = { key: "", at: 0, raw: "" };
    lastCommittedByRole.candidate = { key: "", at: 0, raw: "" };
  };

  A.transcript.getAllBlocksNewestFirst = function getAllBlocksNewestFirst() {
    return S.timeline
      .slice()
      .sort((a, b) => (b.t || 0) - (a.t || 0))
      .map((x) => String(x.text || "").trim())
      .filter(Boolean);
  };

  A.transcript.getFreshBlocksText = function getFreshBlocksText() {
    return S.timeline
      .slice(S.sentCursor)
      .filter((x) => x && x !== S.micInterimEntry)
      .map((x) => String(x.text || "").trim())
      .filter(Boolean)
      .join("\n\n")
      .trim();
  };

  A.transcript.getFreshInterviewerBlocksText = function getFreshInterviewerBlocksText() {
    return S.timeline
      .slice(S.sentCursor)
      .filter((x) => x && x.role === "interviewer")
      .map((x) => String(x.text || "").trim())
      .filter(Boolean)
      .join("\n\n")
      .trim();
  };

  A.transcript.updateTranscript = function updateTranscript() {
    if (!A.dom.liveTranscript) return;
    A.dom.liveTranscript.innerText = A.transcript.getAllBlocksNewestFirst().join("\n\n").trim();
    if (S.pinnedTop) requestAnimationFrame(() => (A.dom.liveTranscript.scrollTop = 0));
  };

  A.transcript.removeInterimIfAny = function removeInterimIfAny() {
    if (!S.micInterimEntry) return;
    const idx = S.timeline.indexOf(S.micInterimEntry);
    if (idx >= 0) S.timeline.splice(idx, 1);
    S.micInterimEntry = null;
  };

  A.transcript.addFinalSpeech = function addFinalSpeech(txt, role) {
    const cleanedRaw = A.util.normalize(txt);
    if (!cleanedRaw) return;

    const r = role === "interviewer" ? "interviewer" : "candidate";
    const now = Date.now();

    const prev = lastCommittedByRole[r];

    // Overlap trim vs prior final (same role)
    const trimmedRaw = prev.raw ? trimOverlapWords(prev.raw, cleanedRaw) : cleanedRaw;
    const trimmedKey = canonKey(trimmedRaw);
    if (!trimmedKey) return;

    // Strong dedupe
    const tooSoon = now - (prev.at || 0) < 3000;
    const sameKey = trimmedKey === (prev.key || "");
    if (sameKey && tooSoon) return;

    prev.key = trimmedKey;
    prev.raw = trimmedRaw;
    prev.at = now;

    A.transcript.removeInterimIfAny();

    const gap = now - (S.lastSpeechAt || 0);

    if (!S.timeline.length || gap >= A.const.PAUSE_NEWLINE_MS) {
      S.timeline.push({ t: now, text: trimmedRaw, role: r });
    } else {
      const last = S.timeline[S.timeline.length - 1];
      if (last.role && last.role !== r) {
        S.timeline.push({ t: now, text: trimmedRaw, role: r });
      } else {
        last.text = A.util.normalize((last.text || "") + " " + trimmedRaw);
        last.t = now;
        last.role = r;
      }
    }

    S.lastSpeechAt = now;
    A.transcript.updateTranscript();
  };

  A.transcript.addTypewriterSpeech = function addTypewriterSpeech(
    txt,
    msPerWord = A.const.SYS_TYPE_MS_PER_WORD,
    role = "interviewer"
  ) {
    const cleaned = A.util.normalize(txt);
    if (!cleaned) return;

    A.transcript.removeInterimIfAny();

    const now = Date.now();
    const gap = now - (S.lastSpeechAt || 0);

    let entry;
    if (!S.timeline.length || gap >= A.const.PAUSE_NEWLINE_MS) {
      entry = { t: now, text: "", role };
      S.timeline.push(entry);
    } else {
      entry = S.timeline[S.timeline.length - 1];
      if (entry.role && entry.role !== role) {
        entry = { t: now, text: "", role };
        S.timeline.push(entry);
      } else {
        if (entry.text) entry.text = A.util.normalize(entry.text) + " ";
        entry.t = now;
        entry.role = role;
      }
    }

    S.lastSpeechAt = now;

    const words = cleaned.split(" ");
    let i = 0;

    const timer = setInterval(() => {
      if (!S.isRunning) return clearInterval(timer);
      if (i >= words.length) return clearInterval(timer);
      entry.text += (entry.text && !entry.text.endsWith(" ") ? " " : "") + words[i++];
      A.transcript.updateTranscript();
    }, msPerWord);
  };

  // ------------------------------------------------------------
  // QUESTIONS
  // ------------------------------------------------------------
  A.q = A.q || {};

  A.q.updateTopicMemory = function updateTopicMemory(text) {
    const low = String(text || "").toLowerCase();
    const topics = [];

    if (low.match(/sql|tableau|powerbi|dataset|analytics|data|kpi|warehouse/)) topics.push("data");
    if (low.match(/java|python|code|string|reverse|algorithm|loop|array|function|character/)) topics.push("code");
    if (low.match(/selenium|playwright|bdd|test|automation|flaky/)) topics.push("testing");
    if (low.match(/role|responsibility|project|experience|team|stakeholder/)) topics.push("experience");

    S.recentTopics = [...new Set([...S.recentTopics, ...topics])].slice(-3);
  };

  function normalizeSpokenText(s) {
    const map = {
      kod: "code",
      coad: "code",
      carecter: "character",
      charactors: "characters",
      flacky: "flaky",
      analitics: "analytics",
      statics: "statistics"
    };

    let out = String(s || "").toLowerCase();
    for (const k in map) out = out.replace(new RegExp("\\b" + k + "\\b", "gi"), map[k]);
    return out;
  }

  function extractPriorQuestions() {
    const qs = [];
    for (const m of S.chatHistory.slice(-30)) {
      if (m.role !== "assistant") continue;
      const c = String(m.content || "");
      const m1 = c.match(/(?:^|\n)Q:\s*([^\n<]+)/i);
      if (m1?.[1]) qs.push(A.util.normalize(m1[1]).slice(0, 240));
    }
    return Array.from(new Set(qs)).slice(-8);
  }

  function guessDomainBias(text) {
    const s = String(text || "").toLowerCase();
    const hits = [];
    if (s.includes("selenium") || s.includes("cucumber") || s.includes("bdd") || s.includes("playwright")) hits.push("test automation");
    if (s.includes("page object") || s.includes("pom") || s.includes("singleton") || s.includes("factory")) hits.push("automation design patterns");
    if (s.includes("trigger") || s.includes("sql") || s.includes("database") || s.includes("data model") || s.includes("fact") || s.includes("dimension")) hits.push("data modeling / databases");
    if (s.includes("api") || s.includes("postman") || s.includes("rest")) hits.push("api testing / integration");
    if (s.includes("supabase") || s.includes("jwt") || s.includes("auth") || s.includes("token")) hits.push("auth / backend");
    return hits.slice(0, 3).join(", ");
  }

  function isNewTopic(text) {
    const s = String(text || "").toLowerCase().trim();
    if (/^(hi|hello|hey|thanks|thank you|cheers|okay|cool|alright)\b/.test(s)) return true;
    if (/tell me about|your project|your role|responsibilities|experience|walk me through|about your/i.test(s)) return true;

    const codeVerbs = ["reverse", "count", "sort", "find", "validate", "check", "convert", "parse", "remove", "merge"];
    const hasCode = codeVerbs.some((v) => s.includes(v));
    if (!hasCode && s.split(" ").length > 4) return true;

    return false;
  }

  A.q.buildDraftQuestion = function buildDraftQuestion(spoken) {
    let s = A.util
      .normalize(normalizeSpokenText(A.util.normalize(spoken)))
      .replace(/[^\x00-\x7F]/g, " ")
      .replace(/\b(how you can|you can|can you|how can)\b/gi, " ")
      .replace(/\s+/g, " ")
      .trim();

    if (isNewTopic(s)) {
      S.activeIntent = null;
      S.activeTech = null;
    }

    if (!s) return "Q: Can you explain your current project end-to-end?";

    const low = s.toLowerCase();

    const techMatch = /(java|python|c\+\+|javascript|sql|selenium|playwright|bdd)/i.exec(low);
    if (techMatch) S.activeTech = techMatch[1].toLowerCase();

    const CODE_VERBS = ["reverse", "count", "sort", "find", "check", "validate", "convert", "remove", "replace", "merge"];
    const CODE_NOUNS = ["string", "number", "array", "list", "digits", "vowels", "palindrome", "json", "api"];

    const hasVerb = CODE_VERBS.some((v) => low.includes(v));
    const hasNoun = CODE_NOUNS.some((n) => low.includes(n));

    if (!hasVerb && S.activeIntent === "code" && S.activeTech) {
      return `Q: Write ${S.activeTech} code for the previous problem and explain the logic.`;
    }

    if (hasVerb && hasNoun) {
      S.activeIntent = "code";
      return `Q: Write ${S.activeTech || "a"} program to ${s} and explain the logic `;
    }

    if (/error|issue|not working|failed|bug|timeout/.test(low)) {
      S.activeIntent = "debug";
      return `Q: How would you debug ${s} and what steps did you take in production?`;
    }

    if (/architecture|design|flow|system|microservice|pattern/.test(low)) {
      S.activeIntent = "design";
      return `Q: Explain the ${s} you designed and why this architecture was chosen.`;
    }

    if (/what is|explain|define|theory/.test(low)) {
      S.activeIntent = "theory";
      return `Q: Can you explain ${s} with a real-world example?`;
    }

    if (S.activeIntent === "code") {
      return `Q: Write ${S.activeTech || "a"} program related to ${s} and explain it.`;
    }

    return `Q: Can you explain ${s} with a real project example?`;
  };

  A.q.buildInterviewQuestionPrompt = function buildInterviewQuestionPrompt(currentTextOnly) {
    const base = A.util.normalize(currentTextOnly);
    if (!base) return "";

    const priorQs = extractPriorQuestions();
    const domainBias = guessDomainBias((S.resumeTextMem || "") + "\n" + base);

    return `
You are answering a real interview question spoken by an interviewer.

First, restate the interviewer’s question clearly in the format:
Q: <question>

Then answer it naturally, as a senior professional would explain verbally.

ANSWERING STYLE (MANDATORY):
- Sound confident, calm, and experienced.
- Start with a direct explanation before going deeper.
- Explain how and why, not textbook definitions.
- Speak like a human in an interview, not like documentation.

DEPTH RULES:
- Provide enough detail to demonstrate real understanding.
- If a tool, framework, or concept is mentioned, briefly explain how you used it.
- If leadership or decision-making is implied, explain impact and outcomes.

EXAMPLES:
- Naturally weave real project experience into the explanation.
- Do NOT label sections like "Quick Answer" or "Project Example".
- Do NOT use numbered sections or templates.

FORMATTING:
- Use Markdown lightly.
- Short paragraphs preferred.
- Bullets ONLY if they genuinely improve clarity.
- Bold ONLY key technologies, tools, patterns, or measurable outcomes.

CONTEXT:
- Stay grounded in the interviewer’s question.
- Prefer topics aligned with this domain bias: ${domainBias || "software engineering"}.
- Avoid repeating previously asked questions:
${priorQs.length ? priorQs.map((q) => "- " + q).join("\n") : "- (none)"}

INTERVIEWER QUESTION:
${base}
`.trim();
  };

  // ------------------------------------------------------------
  // MODE APPLY
  // ------------------------------------------------------------
  function applyModeInstructions() {
    const mode = A.dom.modeSelect?.value || "interview";
    S.hiddenInstructions = A.const.MODE_INSTRUCTIONS[mode] || "";

    if (!A.dom.instructionsBox || !A.dom.instrStatus) return;

    if (mode === "general") {
      A.dom.instructionsBox.disabled = false;
      A.dom.instrStatus.textContent = "You can enter custom instructions.";
    } else {
      A.dom.instructionsBox.disabled = true;
      A.dom.instructionsBox.value = "";
      A.dom.instrStatus.textContent = `${mode.charAt(0).toUpperCase() + mode.slice(1)} mode selected. Custom instructions disabled.`;
    }
    setTimeout(() => (A.dom.instrStatus.textContent = ""), 900);
  }

  A.util.getEffectiveInstructions = function getEffectiveInstructions() {
    const mode = A.dom.modeSelect?.value || "interview";
    if (mode === "interview" || mode === "sales") return S.hiddenInstructions;
    const live = (A.dom.instructionsBox?.value || "").trim();
    if (live) return live;
    return (localStorage.getItem("instructions") || "").trim();
  };

  // ------------------------------------------------------------
  // CORE INIT (DOM refs + listeners that must exist before wiring)
  // ------------------------------------------------------------
  function initCore() {
    // DOM
    A.dom.userInfo = document.getElementById("userInfo");
    A.dom.instructionsBox = document.getElementById("instructionsBox");
    A.dom.instrStatus = document.getElementById("instrStatus");
    A.dom.resumeInput = document.getElementById("resumeInput");
    A.dom.resumeStatus = document.getElementById("resumeStatus");

    A.dom.liveTranscript = document.getElementById("liveTranscript");
    A.dom.manualQuestion = document.getElementById("manualQuestion");

    A.dom.responseBox = document.getElementById("responseBox");
    A.dom.startBtn = document.getElementById("startBtn");
    A.dom.stopBtn = document.getElementById("stopBtn");
    A.dom.sysBtn = document.getElementById("sysBtn");
    A.dom.clearBtn = document.getElementById("clearBtn");
    A.dom.resetBtn = document.getElementById("resetBtn");
    A.dom.audioStatus = document.getElementById("audioStatus");
    A.dom.sendBtn = document.getElementById("sendBtn");
    A.dom.sendStatus = document.getElementById("sendStatus");
    A.dom.bannerTop = document.getElementById("bannerTop");
    A.dom.modeSelect = document.getElementById("modeSelect");
    A.dom.micMuteBtn = document.getElementById("micMuteBtn");
    A.dom.logoutBtn = document.getElementById("logoutBtn");

    // transcript pinned scroll
    if (A.dom.liveTranscript) {
      const TH = 40;
      A.dom.liveTranscript.addEventListener(
        "scroll",
        () => {
          S.pinnedTop = A.dom.liveTranscript.scrollTop <= TH;
        },
        { passive: true }
      );
    }

    // mode select
    if (A.dom.modeSelect) {
      A.dom.modeSelect.addEventListener("change", applyModeInstructions);
      A.dom.modeSelect.value = A.dom.modeSelect.value || "interview";
      applyModeInstructions();
    }
  }

  A._initCore = initCore;

  // ---- APP INIT + ACTIONS (paste at end of app.core.js) ----
  (() => {
    "use strict";
    const A = window.ANU_APP;
    const S = A.state;

    async function startAll() {
      A.ui.hideBanner();
      if (S.isRunning) return;

      // kept behavior: reset chat server state
      await A.api.apiFetch("chat/reset", { method: "POST" }, false).catch(() => {});

      // reset transcript
      S.transcriptEpoch++;
      S.timeline = [];
      S.micInterimEntry = null;
      S.lastSpeechAt = 0;
      S.sentCursor = 0;
      S.pinnedTop = true;

      S.lastSysTail = "";
      S.lastMicTail = "";
      S.lastSysPrinted = "";
      S.lastSysPrintedAt = 0;
      A.transcript.resetRoleCommitState();

      // stop old audio
      A.audio.stopAsrSession("mic");
      A.audio.stopAsrSession("sys");

      A.transcript.updateTranscript();

      S.isRunning = true;

      // buttons
      A.dom.startBtn && (A.dom.startBtn.disabled = true);
      A.dom.stopBtn && (A.dom.stopBtn.disabled = false);
      A.dom.sysBtn && (A.dom.sysBtn.disabled = false);
      A.dom.sendBtn && (A.dom.sendBtn.disabled = false);

      A.dom.stopBtn && A.dom.stopBtn.classList.remove("opacity-50");
      A.dom.sysBtn && A.dom.sysBtn.classList.remove("opacity-50");
      A.dom.sendBtn && A.dom.sendBtn.classList.remove("opacity-60");

      // Mic: kept same practical behavior you had:
      // - start streaming ASR first (no SR commit dependency)
      if (!S.micMuted) {
        try {
          const micStreamTmp = await navigator.mediaDevices.getUserMedia({ audio: true });
          await A.audio.startStreamingAsr("mic", micStreamTmp);
        } catch {}

        const micOk = false; // kept your current setting
        if (!micOk) {
          A.ui.setStatus(A.dom.audioStatus, "Mic SR not available. Trying streaming ASR…", "text-orange-600");
        }

        setTimeout(() => {
          if (!S.isRunning) return;
          if (S.micMuted) return;
          if (A.audio.micSrIsHealthy()) return;

          // if you later flip USE_BROWSER_SR back, these become relevant again
          if (!S.micStream) A.audio.enableMicRecorderFallback().catch(() => {});
        }, 2000);
      } else {
        A.ui.setStatus(A.dom.audioStatus, "Mic is OFF. Press System Audio to capture system audio.", "text-orange-600");
      }

      A.chat.startCreditTicking();
    }

    function stopAll() {
      S.isRunning = false;

      A.audio.stopMicOnly();
      A.audio.stopMicRecorderOnly();
      A.audio.stopSystemAudioOnly();

      A.audio.stopAsrSession("mic");
      A.audio.stopAsrSession("sys");

      if (S.creditTimer) clearInterval(S.creditTimer);

      A.dom.startBtn && (A.dom.startBtn.disabled = false);
      A.dom.stopBtn && (A.dom.stopBtn.disabled = true);
      A.dom.sysBtn && (A.dom.sysBtn.disabled = true);
      A.dom.sendBtn && (A.dom.sendBtn.disabled = true);

      A.dom.stopBtn && A.dom.stopBtn.classList.add("opacity-50");
      A.dom.sysBtn && A.dom.sysBtn.classList.add("opacity-50");
      A.dom.sendBtn && A.dom.sendBtn.classList.add("opacity-60");

      A.ui.setStatus(A.dom.audioStatus, "Stopped", "text-orange-600");
    }

    function hardClearTranscript() {
      S.transcriptEpoch++;

      try { S.micAbort?.abort(); } catch {}
      try { S.sysAbort?.abort(); } catch {}

      S.micQueue = [];
      S.sysQueue = [];
      S.micSegmentChunks = [];
      S.sysSegmentChunks = [];

      S.lastSysTail = "";
      S.lastMicTail = "";
      S.lastSysPrinted = "";
      S.lastSysPrintedAt = 0;
      A.transcript.resetRoleCommitState();

      S.timeline = [];
      S.micInterimEntry = null;
      S.lastSpeechAt = 0;
      S.sentCursor = 0;
      S.pinnedTop = true;

      A.transcript.updateTranscript();
    }

    async function onSend() {
      const sendBtn = A.dom.sendBtn;
      if (!sendBtn || sendBtn.disabled) return;

      const manual = A.util.normalize(A.dom.manualQuestion?.value || "");
      const freshInterviewer = A.util.normalize(A.transcript.getFreshInterviewerBlocksText());
      const base = manual || freshInterviewer;

      A.q.updateTopicMemory(base);

      const question = A.q.buildDraftQuestion(base);
      if (!base) return;

      if (A.dom.manualQuestion) A.dom.manualQuestion.value = "";

      A.chat.abortChatStreamOnly(true);

      S.blockMicUntil = Date.now() + 700;
      A.transcript.removeInterimIfAny();

      S.sentCursor = S.timeline.length;
      S.pinnedTop = true;
      A.transcript.updateTranscript();

      if (A.dom.responseBox) {
        A.dom.responseBox.innerHTML = A.util.renderMarkdownLite(`${question}\n\n_Generating answer…_`);
      }
      A.ui.setStatus(A.dom.sendStatus, "Queued…", "text-orange-600");

      const mode = A.dom.modeSelect?.value || "interview";
      const promptToSend =
        mode === "interview"
          ? A.q.buildInterviewQuestionPrompt(question.replace(/^Q:\s*/i, ""))
          : question;

      await A.chat.startChatStreaming(promptToSend, base);
    }

    async function init() {
      // core refs + listeners
      A._initCore();

      // wire resume upload
      A.chat.wireResumeUpload();

      // mic mute UI
      if (A.dom.micMuteBtn) {
        A.dom.micMuteBtn.addEventListener("click", () => A.audio.setMicMuted(!S.micMuted));
        A.audio.updateMicMuteUI();
      }

      // buttons
      A.dom.startBtn && (A.dom.startBtn.onclick = startAll);
      A.dom.stopBtn && (A.dom.stopBtn.onclick = stopAll);
      A.dom.sysBtn && (A.dom.sysBtn.onclick = A.audio.enableSystemAudio);
      A.dom.sendBtn && (A.dom.sendBtn.onclick = onSend);

      A.dom.clearBtn &&
        (A.dom.clearBtn.onclick = () => {
          hardClearTranscript();
          if (A.dom.manualQuestion) A.dom.manualQuestion.value = "";
          A.ui.setStatus(A.dom.sendStatus, "Transcript cleared", "text-green-600");
          A.ui.setStatus(
            A.dom.audioStatus,
            S.isRunning ? "Listening…" : "Stopped",
            S.isRunning ? "text-green-600" : "text-orange-600"
          );
        });

      A.dom.resetBtn &&
        (A.dom.resetBtn.onclick = async () => {
          if (A.dom.responseBox) A.dom.responseBox.innerHTML = "";
          A.ui.setStatus(A.dom.sendStatus, "Response reset", "text-green-600");
          await A.api.apiFetch("chat/reset", { method: "POST" }, false).catch(() => {});
        });

      A.dom.logoutBtn &&
        (A.dom.logoutBtn.onclick = () => {
          S.chatHistory = [];
          S.resumeTextMem = "";
          stopAll();
          localStorage.removeItem("session");
          window.location.href = "/auth?tab=login";
        });

      // page load (kept)
      window.addEventListener("load", async () => {
        S.session = JSON.parse(localStorage.getItem("session") || "null");
        if (!S.session) return (window.location.href = "/auth?tab=login");

        if (!S.session.refresh_token) {
          localStorage.removeItem("session");
          return (window.location.href = "/auth?tab=login");
        }

        S.chatHistory = [];
        S.resumeTextMem = "";
        if (A.dom.resumeStatus) A.dom.resumeStatus.textContent = "Resume cleared.";

        await A.chat.loadUserProfile();
        await A.api.apiFetch("chat/reset", { method: "POST" }, false).catch(() => {});

        S.transcriptEpoch++;
        S.timeline = [];
        S.micInterimEntry = null;
        S.lastSpeechAt = 0;
        S.sentCursor = 0;
        S.pinnedTop = true;

        S.lastSysTail = "";
        S.lastMicTail = "";
        S.lastSysPrinted = "";
        S.lastSysPrintedAt = 0;
        A.transcript.resetRoleCommitState();

        A.audio.stopAsrSession("mic");
        A.audio.stopAsrSession("sys");

        A.transcript.updateTranscript();

        if (A.dom.stopBtn) {
          A.dom.stopBtn.disabled = true;
          A.dom.stopBtn.classList.add("opacity-50");
        }
        if (A.dom.sysBtn) {
          A.dom.sysBtn.disabled = true;
          A.dom.sysBtn.classList.add("opacity-50");
        }
        if (A.dom.sendBtn) {
          A.dom.sendBtn.disabled = true;
          A.dom.sendBtn.classList.add("opacity-60");
        }

        A.ui.setStatus(A.dom.audioStatus, "Stopped", "text-orange-600");
        A.audio.updateMicMuteUI();
      });
    }

    A.actions = { startAll, stopAll, hardClearTranscript };
    A.init = init;
  })();
})();
