/* ==========================================================================
 * app.core.js
 * Core: util/ui/dom/state/transcript/questions/api + wiring
 * Fixes:
 *  - 3s pause blocks work (deltas never update lastSpeechAt)
 *  - internal duplicate collapse (paragraph/sentence repeats)
 * ========================================================================== */
(() => {
  "use strict";

  const A = (window.ANU_APP = window.ANU_APP || {});
  A.util = A.util || {};
  A.ui = A.ui || {};
  A.dom = A.dom || {};
  A.state = A.state || {};
  A.api = A.api || {};
  A.transcript = A.transcript || {};
  A.q = A.q || {};

  const S = A.state;

  /* -------------------------------------------------------------------------- */
  /* CONSTANTS (shared)                                                         */
  /* -------------------------------------------------------------------------- */
  A.const = {
    PAUSE_NEWLINE_MS: 3000,

    MIC_SEGMENT_MS: 1200,
    MIC_MIN_BYTES: 1800,
    MIC_MAX_CONCURRENT: 2,

    SYS_SEGMENT_MS: 2800,
    SYS_MIN_BYTES: 6000,
    SYS_MAX_CONCURRENT: 1,
    SYS_TYPE_MS_PER_WORD: 18,

    SYS_ERR_MAX: 3,
    SYS_ERR_BACKOFF_MS: 10000,

    CREDIT_BATCH_SEC: 5,
    CREDITS_PER_SEC: 1,

    MIC_LANGS: ["en-IN", "en-GB", "en-US"],

    TRANSCRIBE_PROMPT:
      "Transcribe only English as spoken with an Indian English accent. " +
      "STRICTLY ignore and OMIT any Urdu, Arabic, Hindi, or other non-English words. " +
      "If a word is not English, drop it completely. " +
      "Use Indian English pronunciation and spelling. " +
      "Do NOT Americanize words. " +
      "Do NOT translate. " +
      "Do NOT add new words. Do NOT repeat phrases. " +
      "Keep punctuation minimal. If uncertain, omit."
  };

  /* -------------------------------------------------------------------------- */
  /* STATE (single source of truth)                                             */
  /* -------------------------------------------------------------------------- */
  Object.assign(S, {
    session: null,
    isRunning: false,

    hiddenInstructions: "",
    micMuted: false,

    // transcript
    timeline: [],
    micInterimEntry: null,
    lastSpeechAt: 0,       // FINAL commit time only
    sentCursor: 0,
    pinnedTop: true,
    transcriptEpoch: 0,

    // dedupe tails
    lastSysTail: "",
    lastMicTail: "",
    lastSysPrinted: "",
    lastSysPrintedAt: 0,

    // system immediate guard
    lastSysTypeKey: "",
    lastSysTypeAt: 0,

    // mic SR preview
    recognition: null,
    blockMicUntil: 0,
    lastMicResultAt: 0,
    micWatchdog: null,
    micLangIndex: 0,

    // audio recorder + queues
    micStream: null,
    micTrack: null,
    micRecorder: null,
    micSegmentChunks: [],
    micQueue: [],
    micAbort: null,
    micInFlight: 0,

    sysStream: null,
    sysTrack: null,
    sysRecorder: null,
    sysSegmentChunks: [],
    sysQueue: [],
    sysAbort: null,
    sysInFlight: 0,
    sysErrCount: 0,
    sysErrBackoffUntil: 0,

    // chat
    chatAbort: null,
    chatStreamActive: false,
    chatStreamSeq: 0,
    chatHistory: [],
    resumeTextMem: "",
    creditTimer: null,
    lastCreditAt: 0,

    // intent/topic
    activeIntent: null,
    activeTech: null,
    recentTopics: []
  });

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

  A.util.normalize = normalize;
  A.util.escapeHtml = escapeHtml;

  /* -------------------------------------------------------------------------- */
  /* CANON + INTERNAL REPEAT COLLAPSE                                           */
  /* -------------------------------------------------------------------------- */
  function canonKey(s) {
    return normalize(String(s || ""))
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, "")
      .replace(/\s+/g, " ")
      .trim();
  }
  A.util.canonKey = canonKey;

  function collapseInternalRepeats(raw) {
    const s0 = normalize(raw);
    if (!s0) return "";

    // consecutive sentence collapse
    const parts = s0
      .replace(/\s+/g, " ")
      .split(/(?<=[.!?])\s+/)
      .map(x => normalize(x))
      .filter(Boolean);

    const out = [];
    let last = "";
    for (const p of parts) {
      const k = canonKey(p);
      if (!k) continue;
      if (k === canonKey(last)) continue;
      out.push(p);
      last = p;
    }

    let s1 = out.join(" ").trim() || s0;

    // exact double-copy collapse (A == B)
    const w = s1.split(" ").filter(Boolean);
    if (w.length >= 24 && w.length % 2 === 0) {
      const mid = w.length / 2;
      const a = w.slice(0, mid).join(" ");
      const b = w.slice(mid).join(" ");
      if (canonKey(a) && canonKey(a) === canonKey(b)) return normalize(a);
    }

    // immediate repeated window collapse
    const ww = s1.split(" ").filter(Boolean);
    if (ww.length >= 30) {
      const kept = [];
      for (let i = 0; i < ww.length; i++) {
        if (i >= 10 && i + 10 <= ww.length) {
          const prev10 = ww.slice(i - 10, i).join(" ");
          const next10 = ww.slice(i, i + 10).join(" ");
          if (canonKey(prev10) === canonKey(next10)) {
            i += 9;
            continue;
          }
        }
        kept.push(ww[i]);
      }
      return normalize(kept.join(" "));
    }

    return normalize(s1);
  }
  A.util.collapseInternalRepeats = collapseInternalRepeats;

  /* -------------------------------------------------------------------------- */
  /* SIMPLE MARKDOWN (fallback)                                                 */
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
  A.util.renderMarkdownLite = renderMarkdownLite;

  /* -------------------------------------------------------------------------- */
  /* UI HELPERS                                                                  */
  /* -------------------------------------------------------------------------- */
  function showBanner(msg) {
    if (!A.dom.bannerTop) return;
    A.dom.bannerTop.textContent = msg;
    A.dom.bannerTop.classList.remove("hidden");
    A.dom.bannerTop.classList.add("bg-red-600");
  }

  function hideBanner() {
    if (!A.dom.bannerTop) return;
    A.dom.bannerTop.classList.add("hidden");
    A.dom.bannerTop.textContent = "";
  }

  function setStatus(el, text, cls = "") {
    if (!el) return;
    el.textContent = text;
    el.className = cls;
  }

  A.ui.showBanner = showBanner;
  A.ui.hideBanner = hideBanner;
  A.ui.setStatus = setStatus;

  /* -------------------------------------------------------------------------- */
  /* DOM INIT                                                                     */
  /* -------------------------------------------------------------------------- */
  function initCore() {
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

    // pinned-top behavior
    if (A.dom.liveTranscript) {
      const TH = 40;
      A.dom.liveTranscript.addEventListener(
        "scroll",
        () => { S.pinnedTop = A.dom.liveTranscript.scrollTop <= TH; },
        { passive: true }
      );
    }
  }
  A._initCore = initCore;

  /* -------------------------------------------------------------------------- */
  /* TRANSCRIPT RENDER                                                           */
  /* -------------------------------------------------------------------------- */
  function getAllBlocksNewestFirst() {
    return S.timeline
      .slice()
      .sort((a, b) => (b.t || 0) - (a.t || 0))
      .map(x => String(x.text || "").trim())
      .filter(Boolean);
  }

  function getFreshInterviewerBlocksText() {
    return S.timeline
      .slice(S.sentCursor)
      .filter(x => x && x !== S.micInterimEntry && x.role === "interviewer")
      .map(x => String(x.text || "").trim())
      .filter(Boolean)
      .join("\n\n")
      .trim();
  }

  function updateTranscript() {
    if (!A.dom.liveTranscript) return;
    A.dom.liveTranscript.innerText = getAllBlocksNewestFirst().join("\n\n").trim();
    if (S.pinnedTop) requestAnimationFrame(() => (A.dom.liveTranscript.scrollTop = 0));
  }

  function removeInterimIfAny() {
    if (!S.micInterimEntry) return;
    const idx = S.timeline.indexOf(S.micInterimEntry);
    if (idx >= 0) S.timeline.splice(idx, 1);
    S.micInterimEntry = null;
  }

  A.transcript.updateTranscript = updateTranscript;
  A.transcript.removeInterimIfAny = removeInterimIfAny;
  A.transcript.getFreshInterviewerBlocksText = getFreshInterviewerBlocksText;

  /* -------------------------------------------------------------------------- */
  /* OVERLAP TRIM (role-safe)                                                   */
  /* -------------------------------------------------------------------------- */
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
  A.transcript.trimOverlapWords = trimOverlapWords;

  const lastCommittedByRole = {
    interviewer: { key: "", at: 0, raw: "" },
    candidate:   { key: "", at: 0, raw: "" }
  };

  function resetRoleCommitState() {
    lastCommittedByRole.interviewer = { key: "", at: 0, raw: "" };
    lastCommittedByRole.candidate = { key: "", at: 0, raw: "" };
  }
  A.transcript.resetRoleCommitState = resetRoleCommitState;

  function addFinalSpeech(txt, role) {
    const cleanedRaw = collapseInternalRepeats(txt);
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

    const gap = now - (S.lastSpeechAt || 0);
    if (!S.timeline.length || gap >= A.const.PAUSE_NEWLINE_MS) {
      S.timeline.push({ t: now, text: trimmedRaw, role: r });
    } else {
      const last = S.timeline[S.timeline.length - 1];
      if (last.role && last.role !== r) {
        S.timeline.push({ t: now, text: trimmedRaw, role: r });
      } else {
        last.text = normalize((last.text || "") + " " + trimmedRaw);
        last.t = now;
        last.role = r;
      }
    }

    // IMPORTANT: final commits only
    S.lastSpeechAt = now;
    updateTranscript();
  }
  A.transcript.addFinalSpeech = addFinalSpeech;

  function addTypewriterSpeech(txt, msPerWord = A.const.SYS_TYPE_MS_PER_WORD, role = "interviewer") {
    const cleaned = collapseInternalRepeats(txt);
    if (!cleaned) return;

    removeInterimIfAny();

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
        if (entry.text) entry.text = normalize(entry.text) + " ";
        entry.t = now;
        entry.role = role;
      }
    }

    // IMPORTANT: treat typewriter start as final commit boundary
    S.lastSpeechAt = now;

    const words = cleaned.split(" ");
    let i = 0;

    const timer = setInterval(() => {
      if (!S.isRunning) return clearInterval(timer);
      if (i >= words.length) return clearInterval(timer);
      entry.text += (entry.text && !entry.text.endsWith(" ") ? " " : "") + words[i++];
      updateTranscript();
    }, msPerWord);
  }
  A.transcript.addTypewriterSpeech = addTypewriterSpeech;

  /* -------------------------------------------------------------------------- */
  /* DEDUPE UTIL (tail-based)                                                   */
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
  A.util.dedupeByTail = dedupeByTail;

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
  A.util.looksLikeWhisperHallucination = looksLikeWhisperHallucination;

  /* -------------------------------------------------------------------------- */
  /* QUESTION HELPERS                                                            */
  /* -------------------------------------------------------------------------- */
  function updateTopicMemory(text) {
    const low = (text || "").toLowerCase();
    const topics = [];

    if (low.match(/sql|tableau|powerbi|dataset|analytics|data|kpi|warehouse/)) topics.push("data");
    if (low.match(/java|python|code|string|reverse|algorithm|loop|array|function|character/)) topics.push("code");
    if (low.match(/selenium|playwright|bdd|test|automation|flaky/)) topics.push("testing");
    if (low.match(/role|responsibility|project|experience|team|stakeholder/)) topics.push("experience");

    S.recentTopics = [...new Set([...S.recentTopics, ...topics])].slice(-3);
  }
  A.q.updateTopicMemory = updateTopicMemory;

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
    let out = (s || "").toLowerCase();
    for (const k in map) out = out.replace(new RegExp("\\b" + k + "\\b", "gi"), map[k]);
    return out;
  }

  function isNewTopic(text) {
    const s = (text || "").toLowerCase().trim();
    if (/^(hi|hello|hey|thanks|thank you|cheers|okay|cool|alright)\b/.test(s)) return true;
    if (/tell me about|your project|your role|responsibilities|experience|walk me through|about your/i.test(s)) return true;

    const codeVerbs = ["reverse","count","sort","find","validate","check","convert","parse","remove","merge"];
    const hasCode = codeVerbs.some(v => s.includes(v));
    if (!hasCode && s.split(" ").length > 4) return true;
    return false;
  }

  function buildDraftQuestion(spoken) {
    let s = normalizeSpokenText(normalize(spoken))
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

    const CODE_VERBS = ["reverse","count","sort","find","check","validate","convert","remove","replace","merge"];
    const CODE_NOUNS = ["string","number","array","list","digits","vowels","palindrome","json","api"];

    const hasVerb = CODE_VERBS.some(v => low.includes(v));
    const hasNoun = CODE_NOUNS.some(n => low.includes(n));

    if (!hasVerb && S.activeIntent === "code" && S.activeTech) {
      return `Q: Write ${S.activeTech} code for the previous problem and explain the logic.`;
    }

    if (hasVerb && hasNoun) {
      S.activeIntent = "code";
      return `Q: Write ${S.activeTech || "a"} program to ${s} and explain the logic`;
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
  }
  A.q.buildDraftQuestion = buildDraftQuestion;

  function extractPriorQuestions() {
    const qs = [];
    for (const m of S.chatHistory.slice(-30)) {
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

  function buildInterviewQuestionPrompt(currentTextOnly) {
    const base = normalize(currentTextOnly);
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

FORMATTING:
- Use Markdown lightly.
- Short paragraphs preferred.
- Bullets ONLY if they genuinely improve clarity.
- Bold ONLY key technologies, tools, patterns, or measurable outcomes.

CONTEXT:
- Prefer topics aligned with this domain bias: ${domainBias || "software engineering"}.
- Avoid repeating previously asked questions:
${priorQs.length ? priorQs.map(q => "- " + q).join("\n") : "- (none)"}

INTERVIEWER QUESTION:
${base}
`.trim();
  }
  A.q.buildInterviewQuestionPrompt = buildInterviewQuestionPrompt;

  /* -------------------------------------------------------------------------- */
  /* MODE INSTRUCTIONS                                                           */
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

  function applyModeInstructions() {
    const mode = A.dom.modeSelect?.value || "interview";
    S.hiddenInstructions = MODE_INSTRUCTIONS[mode] || "";

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

  function getEffectiveInstructions() {
    const mode = A.dom.modeSelect?.value || "interview";
    if (mode === "interview" || mode === "sales") return S.hiddenInstructions;
    const live = (A.dom.instructionsBox?.value || "").trim();
    if (live) return live;
    return (localStorage.getItem("instructions") || "").trim();
  }
  A.util.getEffectiveInstructions = getEffectiveInstructions;

  /* -------------------------------------------------------------------------- */
  /* AUTH + API                                                                  */
  /* -------------------------------------------------------------------------- */
  function authHeaders() {
    const token = S.session?.access_token;
    return token ? { Authorization: `Bearer ${token}` } : {};
  }

  function isTokenNearExpiry() {
    const exp = Number(S.session?.expires_at || 0);
    if (!exp) return false;
    const now = Math.floor(Date.now() / 1000);
    return exp - now < 60;
  }

  async function refreshAccessToken() {
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
  A.api.apiFetch = apiFetch;

  /* -------------------------------------------------------------------------- */
  /* APP INIT + ACTIONS (wiring)                                                */
  /* -------------------------------------------------------------------------- */
  async function init() {
    initCore();

    // mode wiring
    if (A.dom.modeSelect) {
      A.dom.modeSelect.addEventListener("change", applyModeInstructions);
      A.dom.modeSelect.value = A.dom.modeSelect.value || "interview";
      applyModeInstructions();
    }

    // audio + chat modules added later
    // (no-op here)

    // page load (kept behavior)
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

      // chat module will supply loadUserProfile + reset
      if (A.chat?.loadUserProfile) await A.chat.loadUserProfile();
      await apiFetch("chat/reset", { method: "POST" }, false).catch(() => {});

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
      resetRoleCommitState();

      if (A.audio?.stopAsrSession) {
        A.audio.stopAsrSession("mic");
        A.audio.stopAsrSession("sys");
      }

      updateTranscript();

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

      setStatus(A.dom.audioStatus, "Stopped", "text-orange-600");

      if (A.audio?.updateMicMuteUI) A.audio.updateMicMuteUI();
    });
  }

  A.init = init;
})();
