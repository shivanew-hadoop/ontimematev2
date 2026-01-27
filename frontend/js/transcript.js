/* transcript.js - timeline + role-safe merge + dedupe + question draft helpers */
(function () {
  window.ANU = window.ANU || {};
  const ANU = window.ANU;
  const { normalize } = ANU.core;

  const state = {
    liveTranscriptEl: null,
    pinnedTop: true,

    timeline: [],
    micInterimEntry: null,

    lastSpeechAt: 0,
    sentCursor: 0,

    lastSysTail: "",
    lastMicTail: "",

    lastSysPrinted: "",
    lastSysPrintedAt: 0,

    lastQuickInterviewerAt: 0,

    transcriptEpoch: 0,

    activeIntent: null,
    activeTech: null,
    recentTopics: [],

    lastCommittedByRole: {
      interviewer: { key: "", at: 0, raw: "" },
      candidate: { key: "", at: 0, raw: "" }
    }
  };

  const PAUSE_NEWLINE_MS = 3000;
  const SYS_TYPE_MS_PER_WORD = 18;

  function init(liveTranscriptEl) {
    state.liveTranscriptEl = liveTranscriptEl || null;

    if (state.liveTranscriptEl) {
      const TH = 40;
      state.liveTranscriptEl.addEventListener(
        "scroll",
        () => { state.pinnedTop = state.liveTranscriptEl.scrollTop <= TH; },
        { passive: true }
      );
    }
  }

  function getAllBlocksNewestFirst() {
    return state.timeline
      .slice()
      .sort((a, b) => (b.t || 0) - (a.t || 0))
      .map(x => String(x.text || "").trim())
      .filter(Boolean);
  }

  function updateTranscript() {
    if (!state.liveTranscriptEl) return;
    state.liveTranscriptEl.innerText = getAllBlocksNewestFirst().join("\n\n").trim();
    if (state.pinnedTop) requestAnimationFrame(() => (state.liveTranscriptEl.scrollTop = 0));
  }

  function removeInterimIfAny() {
    if (!state.micInterimEntry) return;
    const idx = state.timeline.indexOf(state.micInterimEntry);
    if (idx >= 0) state.timeline.splice(idx, 1);
    state.micInterimEntry = null;
  }

  function getFreshInterviewerBlocksText() {
    return state.timeline
      .slice(state.sentCursor)
      .filter(x => x && x.role === "interviewer")
      .map(x => String(x.text || "").trim())
      .filter(Boolean)
      .join("\n\n")
      .trim();
  }

  function getQuickInterviewerSnapshot() {
    for (let i = state.timeline.length - 1; i >= 0; i--) {
      const b = state.timeline[i];
      if (
        b?.role === "interviewer" &&
        b.text &&
        b.text.length > 8 &&
        b.t > state.lastQuickInterviewerAt
      ) {
        return { text: normalize(b.text), at: b.t };
      }
    }
    return null;
  }

  // ---------------- DEDUPE ----------------
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

  function resetRoleCommitState() {
    state.lastCommittedByRole.interviewer = { key: "", at: 0, raw: "" };
    state.lastCommittedByRole.candidate = { key: "", at: 0, raw: "" };
  }

  function addFinalSpeech(txt, role) {
    const cleanedRaw = normalize(txt);
    if (!cleanedRaw) return;

    const r = role === "interviewer" ? "interviewer" : "candidate";
    const now = Date.now();
    const prev = state.lastCommittedByRole[r];

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

    const gap = now - (state.lastSpeechAt || 0);

    if (!state.timeline.length || gap >= PAUSE_NEWLINE_MS) {
      state.timeline.push({ t: now, text: trimmedRaw, role: r });
    } else {
      const last = state.timeline[state.timeline.length - 1];

      if (last.role && last.role !== r) {
        state.timeline.push({ t: now, text: trimmedRaw, role: r });
      } else {
        last.text = normalize((last.text || "") + " " + trimmedRaw);
        last.t = now;
        last.role = r;
      }
    }

    state.lastSpeechAt = now;
    updateTranscript();
  }

  function addTypewriterSpeech(txt, msPerWord = SYS_TYPE_MS_PER_WORD, role = "interviewer") {
    const cleaned = normalize(txt);
    if (!cleaned) return;

    removeInterimIfAny();

    const now = Date.now();
    const gap = now - (state.lastSpeechAt || 0);

    let entry;
    if (!state.timeline.length || gap >= PAUSE_NEWLINE_MS) {
      entry = { t: now, text: "", role };
      state.timeline.push(entry);
    } else {
      entry = state.timeline[state.timeline.length - 1];

      if (entry.role && entry.role !== role) {
        entry = { t: now, text: "", role };
        state.timeline.push(entry);
      } else {
        if (entry.text) entry.text = normalize(entry.text) + " ";
        entry.t = now;
        entry.role = role;
      }
    }

    state.lastSpeechAt = now;

    const words = cleaned.split(" ");
    let i = 0;

    const timer = setInterval(() => {
      if (!ANU.state?.isRunning) return clearInterval(timer);
      if (i >= words.length) return clearInterval(timer);
      entry.text += (entry.text && !entry.text.endsWith(" ") ? " " : "") + words[i++];
      updateTranscript();
    }, msPerWord);
  }

  // ---------------- QUESTION DRAFT ----------------
  function updateTopicMemory(text) {
    const low = String(text || "").toLowerCase();
    const topics = [];

    if (low.match(/sql|tableau|powerbi|dataset|analytics|data|kpi|warehouse/)) topics.push("data");
    if (low.match(/java|python|code|string|reverse|algorithm|loop|array|function|character/)) topics.push("code");
    if (low.match(/selenium|playwright|bdd|test|automation|flaky/)) topics.push("testing");
    if (low.match(/role|responsibility|project|experience|team|stakeholder/)) topics.push("experience");

    state.recentTopics = [...new Set([...state.recentTopics, ...topics])].slice(-3);
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

    let out = String(s || "").toLowerCase();
    for (const k in map) out = out.replace(new RegExp("\\b" + k + "\\b", "gi"), map[k]);
    return out;
  }

  function isNewTopic(text) {
    const s = String(text || "").toLowerCase().trim();

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
      state.activeIntent = null;
      state.activeTech = null;
    }

    if (!s) return "Q: Can you explain your current project end-to-end?";

    const low = s.toLowerCase();

    const techMatch = /(java|python|c\+\+|javascript|sql|selenium|playwright|bdd)/i.exec(low);
    if (techMatch) state.activeTech = techMatch[1].toLowerCase();

    const CODE_VERBS = ["reverse","count","sort","find","check","validate","convert","remove","replace","merge"];
    const CODE_NOUNS = ["string","number","array","list","digits","vowels","palindrome","json","api"];

    const hasVerb = CODE_VERBS.some(v => low.includes(v));
    const hasNoun = CODE_NOUNS.some(n => low.includes(n));

    if (!hasVerb && state.activeIntent === "code" && state.activeTech) {
      return `Q: Write ${state.activeTech} code for the previous problem and explain the logic.`;
    }

    if (hasVerb && hasNoun) {
      state.activeIntent = "code";
      return `Q: Write ${state.activeTech || "a"} program to ${s} and explain the logic`;
    }

    if (/error|issue|not working|failed|bug|timeout/.test(low)) {
      state.activeIntent = "debug";
      return `Q: How would you debug ${s} and what steps did you take in production?`;
    }

    if (/architecture|design|flow|system|microservice|pattern/.test(low)) {
      state.activeIntent = "design";
      return `Q: Explain the ${s} you designed and why this architecture was chosen.`;
    }

    if (/what is|explain|define|theory/.test(low)) {
      state.activeIntent = "theory";
      return `Q: Can you explain ${s} with a real-world example?`;
    }

    if (state.activeIntent === "code") {
      return `Q: Write ${state.activeTech || "a"} program related to ${s} and explain it.`;
    }

    return `Q: Can you explain ${s} with a real project example?`;
  }

  function hardClearTranscript() {
    state.transcriptEpoch++;

    state.lastSysTail = "";
    state.lastMicTail = "";
    state.lastSysPrinted = "";
    state.lastSysPrintedAt = 0;
    resetRoleCommitState();

    state.timeline = [];
    state.micInterimEntry = null;
    state.lastSpeechAt = 0;
    state.sentCursor = 0;
    state.pinnedTop = true;

    updateTranscript();
  }

  ANU.transcript = {
    state,
    init,
    updateTranscript,
    removeInterimIfAny,
    resetRoleCommitState,
    addFinalSpeech,
    addTypewriterSpeech,
    getFreshInterviewerBlocksText,
    getQuickInterviewerSnapshot,
    updateTopicMemory,
    buildDraftQuestion,
    hardClearTranscript
  };
})();
