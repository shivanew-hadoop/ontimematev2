/* ==========================================================================
 * transcript.js — transcript state + rendering + dedupe + typewriter commit
 * Fixes:
 *  - consecutive duplicate sentences inside a single transcript string
 *  - sys-final commits typing one word at a time (used by ASR finalize)
 * ========================================================================== */

(function () {
  window.ANU = window.ANU || {};
  const ANU = window.ANU;

  // Expect ANU.core.normalize() to exist; fallback was kept to avoid hard crash.
  function normalize(s) {
    const n = ANU.core?.normalize;
    return n ? n(s) : String(s || "").replace(/\s+/g, " ").trim();
  }

  // --- State owned by this module ---
  const state = {
    timeline: [],
    micInterimEntry: null,
    lastSpeechAt: 0,
    pinnedTop: true,
    refs: {
      liveTranscript: null
    },

    // Per-role last commit
    lastCommittedByRole: {
      interviewer: { key: "", at: 0, raw: "" },
      candidate: { key: "", at: 0, raw: "" }
    }
  };

  // Constants (kept aligned with your original file)
  const PAUSE_NEWLINE_MS = 3000;

  // ------------------------------------------------------------------------
  // Canon + overlap helpers (unchanged semantics)
  // ------------------------------------------------------------------------
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

  // ------------------------------------------------------------------------
  // NEW: collapse consecutive duplicate sentences/phrases in the SAME string
  // ------------------------------------------------------------------------
  function collapseConsecutiveDuplicateSentences(raw) {
    const s = normalize(raw);
    if (!s) return "";

    // sentence-ish chunks; kept punctuation attached
    const chunks = s.match(/[^.!?]+[.!?]?/g) || [s];

    const out = [];
    let prevKey = "";

    for (const c of chunks) {
      const part = normalize(c);
      if (!part) continue;

      const k = canonKey(part);
      if (k && k === prevKey) continue; // dropped consecutive duplicates
      prevKey = k;
      out.push(part);
    }

    return normalize(out.join(" "));
  }

  // ------------------------------------------------------------------------
  // Timeline rendering (newest on top) – expected to be wired by app.js
  // ------------------------------------------------------------------------
  function setRefs(refs) {
    state.refs.liveTranscript = refs?.liveTranscript || state.refs.liveTranscript;
  }

  function setPinnedTop(on) {
    state.pinnedTop = !!on;
  }

  function getAllBlocksNewestFirst() {
    return state.timeline
      .slice()
      .sort((a, b) => (b.t || 0) - (a.t || 0))
      .map((x) => String(x.text || "").trim())
      .filter(Boolean);
  }

  function updateTranscript() {
    const liveTranscript = state.refs.liveTranscript;
    if (!liveTranscript) return;

    liveTranscript.innerText = getAllBlocksNewestFirst().join("\n\n").trim();
    if (state.pinnedTop) requestAnimationFrame(() => (liveTranscript.scrollTop = 0));
  }

  function removeInterimIfAny() {
    if (!state.micInterimEntry) return;
    const idx = state.timeline.indexOf(state.micInterimEntry);
    if (idx >= 0) state.timeline.splice(idx, 1);
    state.micInterimEntry = null;
  }

  function resetRoleCommitState() {
    state.lastCommittedByRole.interviewer = { key: "", at: 0, raw: "" };
    state.lastCommittedByRole.candidate = { key: "", at: 0, raw: "" };
  }

  // ------------------------------------------------------------------------
  // Final commit (role-safe) – UPDATED to use collapseConsecutiveDuplicateSentences
  // ------------------------------------------------------------------------
  function addFinalSpeech(txt, role) {
    const cleanedRaw = collapseConsecutiveDuplicateSentences(txt);
    if (!cleanedRaw) return;

    const r = role === "interviewer" ? "interviewer" : "candidate";
    const now = Date.now();
    const prev = state.lastCommittedByRole[r];

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

    const gap = now - (state.lastSpeechAt || 0);

    if (!state.timeline.length || gap >= PAUSE_NEWLINE_MS) {
      state.timeline.push({ t: now, text: trimmedRaw, role: r });
    } else {
      const last = state.timeline[state.timeline.length - 1];

      // Merge only if same role; else new block
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

  // ------------------------------------------------------------------------
  // Typewriter commit (existing behavior) – UPDATED to collapse duplicates
  // ------------------------------------------------------------------------
  function addTypewriterSpeech(txt, msPerWord, role) {
    const cleaned = collapseConsecutiveDuplicateSentences(txt);
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

      // Merge only if same role
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
      entry.t = Date.now();
      updateTranscript();
    }, msPerWord);
  }

  // ------------------------------------------------------------------------
  // NEW: Final commit but typed one-word-at-a-time (for sys-final after stop)
  // ------------------------------------------------------------------------
  function addFinalSpeechTypewriter(txt, role, msPerWord) {
    const cleanedRaw = collapseConsecutiveDuplicateSentences(txt);
    if (!cleanedRaw) return;

    const r = role === "interviewer" ? "interviewer" : "candidate";
    const now = Date.now();
    const prev = state.lastCommittedByRole[r];

    // Same trimming + dedupe gates as addFinalSpeech()
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

    let entry;
    if (!state.timeline.length || gap >= PAUSE_NEWLINE_MS) {
      entry = { t: now, text: "", role: r };
      state.timeline.push(entry);
    } else {
      entry = state.timeline[state.timeline.length - 1];
      if (entry.role && entry.role !== r) {
        entry = { t: now, text: "", role: r };
        state.timeline.push(entry);
      } else {
        if (entry.text) entry.text = normalize(entry.text) + " ";
        entry.t = now;
        entry.role = r;
      }
    }

    state.lastSpeechAt = now;

    const words = trimmedRaw.split(" ");
    let i = 0;

    const timer = setInterval(() => {
      if (!ANU.state?.isRunning) return clearInterval(timer);
      if (i >= words.length) return clearInterval(timer);
      entry.text += (entry.text && !entry.text.endsWith(" ") ? " " : "") + words[i++];
      entry.t = Date.now();
      updateTranscript();
    }, msPerWord || 18);
  }

  // ------------------------------------------------------------------------
  // Public API
  // ------------------------------------------------------------------------
  ANU.transcript = {
    state,
    setRefs,
    setPinnedTop,
    updateTranscript,
    removeInterimIfAny,
    resetRoleCommitState,

    // helpers
    canonKey,
    trimOverlapWords,
    collapseConsecutiveDuplicateSentences,

    // commits
    addFinalSpeech,
    addTypewriterSpeech,
    addFinalSpeechTypewriter
  };
})();
