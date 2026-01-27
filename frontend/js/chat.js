/* chat.js - mode instructions + prompt building + chat streaming + resume */
(function () {
  window.ANU = window.ANU || {};
  const ANU = window.ANU;
  const { normalize, renderMarkdownLite, apiFetch, setStatus } = ANU.core;

  const state = {
    instructionsBox: null,
    instrStatus: null,
    resumeInput: null,
    resumeStatus: null,
    modeSelect: null,
    responseBox: null,
    sendStatus: null,

    hiddenInstructions: "",
    chatAbort: null,
    chatStreamActive: false,
    chatStreamSeq: 0,

    chatHistory: [],
    resumeTextMem: "",

    aiRawBuffer: ""
  };

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

  function init(refs) {
    state.instructionsBox = refs.instructionsBox;
    state.instrStatus = refs.instrStatus;
    state.resumeInput = refs.resumeInput;
    state.resumeStatus = refs.resumeStatus;
    state.modeSelect = refs.modeSelect;
    state.responseBox = refs.responseBox;
    state.sendStatus = null; // wired by app.js through setSendStatusEl

    applyModeInstructions();

    if (state.modeSelect) {
      state.modeSelect.addEventListener("change", applyModeInstructions);
      state.modeSelect.value = state.modeSelect.value || "interview";
      applyModeInstructions();
    }

    if (state.resumeInput) {
      state.resumeInput.addEventListener("change", onResumeSelected);
    }
  }

  function setSendStatusEl(el) {
    state.sendStatus = el || null;
  }

  function applyModeInstructions() {
    const mode = state.modeSelect?.value || "interview";
    state.hiddenInstructions = MODE_INSTRUCTIONS[mode] || "";

    if (!state.instructionsBox || !state.instrStatus) return;

    if (mode === "general") {
      state.instructionsBox.disabled = false;
      state.instrStatus.textContent = "You can enter custom instructions.";
    } else {
      state.instructionsBox.disabled = true;
      state.instructionsBox.value = "";
      state.instrStatus.textContent = `${mode.charAt(0).toUpperCase() + mode.slice(1)} mode selected. Custom instructions disabled.`;
    }
    setTimeout(() => (state.instrStatus.textContent = ""), 900);
  }

  function getEffectiveInstructions() {
    const mode = state.modeSelect?.value || "interview";
    if (mode === "interview" || mode === "sales") return state.hiddenInstructions;
    const live = (state.instructionsBox?.value || "").trim();
    if (live) return live;
    return (localStorage.getItem("instructions") || "").trim();
  }

  function pushHistory(role, content) {
    const c = normalize(content);
    if (!c) return;
    state.chatHistory.push({ role, content: c });
    if (state.chatHistory.length > 80) state.chatHistory.splice(0, state.chatHistory.length - 80);
  }

  function compactHistoryForRequest() {
    return state.chatHistory.slice(-12).map(m => ({
      role: m.role,
      content: String(m.content || "").slice(0, 1600)
    }));
  }

  function extractPriorQuestions() {
    const qs = [];
    for (const m of state.chatHistory.slice(-30)) {
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
    const domainBias = guessDomainBias((state.resumeTextMem || "") + "\n" + base);

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
${priorQs.length ? priorQs.map(q => "- " + q).join("\n") : "- (none)"}

INTERVIEWER QUESTION:
${base}
`.trim();
  }

  function abortChatStreamOnly(silent = true) {
    try { state.chatAbort?.abort(); } catch {}
    state.chatAbort = null;
    if (silent) setStatus(state.sendStatus, "Canceled (new request)", "text-orange-600");
    state.chatStreamActive = false;
  }

  async function startChatStreaming(prompt, userTextForHistory) {
    abortChatStreamOnly(true);

    state.chatAbort = new AbortController();
    state.chatStreamActive = true;
    const mySeq = ++state.chatStreamSeq;

    if (userTextForHistory) pushHistory("user", userTextForHistory);

    let raw = "";
    let flushTimer = null;
    let sawFirstChunk = false;

    if (state.responseBox) state.responseBox.innerHTML = `<span class="text-gray-500 text-sm">Receiving…</span>`;
    setStatus(state.sendStatus, "Connecting…", "text-orange-600");

    const body = {
      prompt,
      history: compactHistoryForRequest(),
      instructions: getEffectiveInstructions(),
      resumeText: state.resumeTextMem || ""
    };

    const render = () => {
      if (state.responseBox) state.responseBox.innerHTML = renderMarkdownLite(raw);
    };

    try {
      const res = await apiFetch(
        "chat/send",
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "text/plain" },
          body: JSON.stringify(body),
          signal: state.chatAbort.signal
        },
        false
      );

      if (!res.ok) throw new Error(await res.text());
      if (!res.body) throw new Error("No stream body");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();

      flushTimer = setInterval(() => {
        if (mySeq !== state.chatStreamSeq) return;
        if (!sawFirstChunk) return;
        render();
      }, 30);

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        if (mySeq !== state.chatStreamSeq) return;

        raw += decoder.decode(value, { stream: true });

        if (!sawFirstChunk) {
          sawFirstChunk = true;
          if (state.responseBox) state.responseBox.innerHTML = "";
          setStatus(state.sendStatus, "Receiving…", "text-orange-600");
        }

        if (raw.length < 1800) render();
      }

      if (mySeq === state.chatStreamSeq) {
        render();
        setStatus(state.sendStatus, "Done", "text-green-600");
        pushHistory("assistant", raw);
      }
    } catch (e) {
      if (e?.name === "AbortError" || state.chatAbort?.signal?.aborted) return;

      console.error(e);
      setStatus(state.sendStatus, "Failed", "text-red-600");
      if (state.responseBox) {
        state.responseBox.innerHTML =
          `<span class="text-red-600 text-sm">Failed. Check backend /chat/send streaming.</span>`;
      }
    } finally {
      if (flushTimer) clearInterval(flushTimer);
      if (mySeq === state.chatStreamSeq) state.chatStreamActive = false;
    }
  }

  async function onResumeSelected() {
    const file = state.resumeInput?.files?.[0];
    if (!file) return;

    if (state.resumeStatus) state.resumeStatus.textContent = "Processing…";

    const fd = new FormData();
    fd.append("file", file);

    const res = await apiFetch("resume/extract", { method: "POST", body: fd }, false);

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      state.resumeTextMem = "";
      if (state.resumeStatus) state.resumeStatus.textContent = `Resume extract failed (${res.status}): ${errText.slice(0, 160)}`;
      return;
    }

    const data = await res.json().catch(() => ({}));
    state.resumeTextMem = String(data.text || "").trim();

    if (state.resumeStatus) {
      state.resumeStatus.textContent = state.resumeTextMem
        ? `Resume extracted (${state.resumeTextMem.length} chars)`
        : "Resume extracted: empty";
    }
  }

  function clearResume() {
    state.resumeTextMem = "";
    if (state.resumeStatus) state.resumeStatus.textContent = "Resume cleared.";
  }

  ANU.chat = {
    state,
    init,
    setSendStatusEl,
    getEffectiveInstructions,
    buildInterviewQuestionPrompt,
    abortChatStreamOnly,
    startChatStreaming,
    pushHistory,
    clearResume
  };
})();
