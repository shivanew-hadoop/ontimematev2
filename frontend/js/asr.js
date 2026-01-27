/* asr.js - mic SR + mic fallback + system audio + realtime ASR */
(function () {
  window.ANU = window.ANU || {};
  const ANU = window.ANU;
  const { normalize, apiFetch, setStatus, showBanner } = ANU.core;

  const t = () => ANU.transcript;

  const cfg = {
    USE_BROWSER_SR: true,

    USE_STREAMING_ASR_SYS: true,
    USE_STREAMING_ASR_MIC_FALLBACK: false,

    REALTIME_INTENT_URL: "wss://api.openai.com/v1/realtime?intent=transcription",
    REALTIME_ASR_MODEL: "gpt-4o-mini-transcribe",

    ASR_SEND_EVERY_MS: 40,
    ASR_TARGET_RATE: 24000,

    COMMIT_WORDS: 18,

    MIC_SEGMENT_MS: 1200,
    MIC_MIN_BYTES: 1800,
    MIC_MAX_CONCURRENT: 2,

    SYS_SEGMENT_MS: 2800,
    SYS_MIN_BYTES: 6000,
    SYS_MAX_CONCURRENT: 1,
    SYS_TYPE_MS_PER_WORD: 18,

    SYS_ERR_MAX: 3,
    SYS_ERR_BACKOFF_MS: 10000,

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

  const state = {
    audioStatusEl: null,

    micMuted: false,
    blockMicUntil: 0,
    lastMicResultAt: 0,
    micLangIndex: 0,

    recognition: null,
    micWatchdog: null,

    micStream: null,
    micTrack: null,
    micRecorder: null,
    micSegmentChunks: [],
    micSegmentTimer: null,
    micQueue: [],
    micAbort: null,
    micInFlight: 0,

    sysStream: null,
    sysTrack: null,
    sysRecorder: null,
    sysSegmentChunks: [],
    sysSegmentTimer: null,
    sysQueue: [],
    sysAbort: null,
    sysInFlight: 0,

    sysErrCount: 0,
    sysErrBackoffUntil: 0,

    realtimeSecretCache: null,
    micAsr: null,
    sysAsr: null
  };

  function init(refs) {
    state.audioStatusEl = refs.audioStatus || null;
  }

  // ---------- helpers ----------
  function micSrIsHealthy() {
    return (Date.now() - (state.lastMicResultAt || 0)) < 1800;
  }

  function looksLikeWhisperHallucination(txt) {
    const s = normalize(txt).toLowerCase();
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

  function dedupeByTail(text, getTail, setTail) {
    const t0 = normalize(text);
    if (!t0) return "";

    const tail = getTail() || "";
    if (!tail) {
      setTail(t0.split(" ").slice(-12).join(" "));
      return t0;
    }

    if (t0.length <= 180 && tail.toLowerCase().includes(t0.toLowerCase())) return "";

    const tailWords = tail.split(" ");
    const newWords = t0.split(" ");
    let bestMatch = 0;
    const maxCheck = Math.min(10, tailWords.length, newWords.length);

    for (let k = maxCheck; k >= 3; k--) {
      const endTail = tailWords.slice(-k).join(" ").toLowerCase();
      const startNew = newWords.slice(0, k).join(" ").toLowerCase();
      if (endTail === startNew) { bestMatch = k; break; }
    }

    const cleaned = bestMatch ? newWords.slice(bestMatch).join(" ") : t0;
    setTail((tail + " " + cleaned).trim().split(" ").slice(-12).join(" "));
    return normalize(cleaned);
  }

  function pickBestMimeType() {
    const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/ogg"];
    for (const typ of candidates) if (MediaRecorder.isTypeSupported(typ)) return typ;
    return "";
  }

  // ---------- realtime ASR ----------
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
    if (state.realtimeSecretCache?.value && (state.realtimeSecretCache.expires_at || 0) - nowSec > 30) {
      return state.realtimeSecretCache.value;
    }

    const res = await apiFetch("realtime/client_secret", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ttl_sec: 600 })
    }, true);

    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data?.value) throw new Error(data?.error || "Failed to get realtime client secret");

    state.realtimeSecretCache = { value: data.value, expires_at: data.expires_at || 0 };
    return data.value;
  }

  function stopAsrSession(which) {
    const s = which === "mic" ? state.micAsr : state.sysAsr;
    if (!s) return;

    try { s.ws?.close?.(); } catch {}
    try { s.sendTimer && clearInterval(s.sendTimer); } catch {}
    try { s.proc && (s.proc.onaudioprocess = null); } catch {}

    try { s.src && s.src.disconnect(); } catch {}
    try { s.proc && s.proc.disconnect(); } catch {}
    try { s.gain && s.gain.disconnect(); } catch {}
    try { s.ctx && s.ctx.close && s.ctx.close(); } catch {}

    if (which === "mic") state.micAsr = null;
    else state.sysAsr = null;
  }

  function sendAsrConfig(ws) {
    const cfgA = {
      type: "transcription_session.update",
      input_audio_format: "pcm16",
      input_audio_transcription: {
        model: cfg.REALTIME_ASR_MODEL,
        language: "en-IN",
        prompt: cfg.TRANSCRIBE_PROMPT +
          " Speaker has an Indian English accent. Prefer Indian pronunciation and spelling."
      },
      turn_detection: {
        type: "server_vad",
        threshold: 0.5,
        prefix_padding_ms: 300,
        silence_duration_ms: 350
      },
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
            format: { type: "audio/pcm", rate: cfg.ASR_TARGET_RATE },
            transcription: {
              model: cfg.REALTIME_ASR_MODEL,
              language: "en-IN",
              prompt: cfg.TRANSCRIBE_PROMPT + " Speaker has an Indian English accent."
            },
            noise_reduction: { type: "far_field" },
            turn_detection: {
              type: "server_vad",
              threshold: 0.5,
              prefix_padding_ms: 300,
              silence_duration_ms: 350
            }
          }
        }
      }
    };
    try { ws.send(JSON.stringify(cfgB)); } catch {}
  }

  function asrFinalizeItem(which, itemId, transcript) {
    const s = which === "mic" ? state.micAsr : state.sysAsr;
    if (!s) return;

    const entry = s.itemEntry[itemId];
    let draftText = "";

    if (entry) {
      draftText = entry.text || "";
      const idx = t().state.timeline.indexOf(entry);
      if (idx >= 0) t().state.timeline.splice(idx, 1);
    }

    delete s.itemEntry[itemId];
    delete s.itemText[itemId];

    const final = normalize(transcript || draftText);
    if (!final) return;

    const role = (which === "sys") ? "interviewer" : "candidate";
    t().addFinalSpeech(final, role);
  }

  function asrUpsertDelta(which, itemId, deltaText) {
    const s = which === "mic" ? state.micAsr : state.sysAsr;
    if (!s) return;

    const now = Date.now();
    if (!s.itemText[itemId]) s.itemText[itemId] = "";
    s.itemText[itemId] += String(deltaText || "");

    const words = normalize(s.itemText[itemId]).split(" ");
    if (words.length >= cfg.COMMIT_WORDS) {
      asrFinalizeItem(which, itemId, s.itemText[itemId]);
      return;
    }

    const cur = normalize(s.itemText[itemId]);
    if (!cur) return;

    const role = (which === "sys") ? "interviewer" : "candidate";

    if (!s.itemEntry[itemId]) {
      const entry = { t: now, text: cur, role };
      s.itemEntry[itemId] = entry;
      t().state.timeline.push(entry);
    } else {
      s.itemEntry[itemId].text = cur;
      s.itemEntry[itemId].t = now;
      s.itemEntry[itemId].role = role;
    }

    t().state.lastSpeechAt = now;
    t().updateTranscript();
  }

  async function startStreamingAsr(which, mediaStream) {
    if (!ANU.state?.isRunning) return false;
    if (which === "mic" && state.micMuted) return false;

    stopAsrSession(which);

    const secret = await getRealtimeClientSecretCached();

    const ws = new WebSocket(cfg.REALTIME_INTENT_URL, [
      "realtime",
      "openai-insecure-api-key." + secret
    ]);

    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const src = ctx.createMediaStreamSource(mediaStream);

    const gain = ctx.createGain();
    gain.gain.value = 0;

    const proc = ctx.createScriptProcessor(4096, 1, 1);
    const queue = [];

    const st = {
      ws, ctx, src, proc, gain, queue,
      sendTimer: null,
      itemText: {},
      itemEntry: {},
      sawConfigError: false
    };

    if (which === "mic") state.micAsr = st;
    else state.sysAsr = st;

    proc.onaudioprocess = (e) => {
      if (!ANU.state?.isRunning) return;
      if (which === "mic" && state.micMuted) return;
      if (ws.readyState !== 1) return;

      const ch0 = e.inputBuffer.getChannelData(0);
      const inRate = ctx.sampleRate || 48000;

      const resampled = resampleFloat32(ch0, inRate, cfg.ASR_TARGET_RATE);
      const bytes = floatToInt16Bytes(resampled);
      if (bytes.length) queue.push(bytes);
    };

    src.connect(proc);
    proc.connect(gain);
    gain.connect(ctx.destination);

    ws.onopen = () => {
      sendAsrConfig(ws);

      st.sendTimer = setInterval(() => {
        if (!ANU.state?.isRunning) return;
        if (which === "mic" && state.micMuted) return;
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
      }, cfg.ASR_SEND_EVERY_MS);

      setStatus(
        state.audioStatusEl,
        which === "sys" ? "System audio (streaming ASR) enabled." : "Mic (streaming ASR) enabled.",
        "text-green-600"
      );
    };

    ws.onmessage = (msg) => {
      let ev = null;
      try { ev = JSON.parse(msg.data); } catch { return; }
      if (!ev?.type) return;

      if (ev.type === "error") {
        const m = String(ev?.error?.message || ev?.message || "");
        if (!st.sawConfigError && m.toLowerCase().includes("transcription_session.update")) {
          st.sawConfigError = true;
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

  // ---------- mic SR ----------
  function stopMicOnly() {
    try { state.recognition?.stop(); } catch {}
    state.recognition = null;
    if (state.micWatchdog) clearInterval(state.micWatchdog);
    state.micWatchdog = null;
  }

  function startMic() {
    if (state.micMuted) return false;
    if (!cfg.USE_BROWSER_SR) return false;

    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      setStatus(state.audioStatusEl, "SpeechRecognition not supported in this browser.", "text-red-600");
      return false;
    }

    stopMicOnly();

    state.recognition = new SR();
    state.recognition.continuous = true;
    state.recognition.interimResults = true;
    state.recognition.maxAlternatives = 1;
    state.recognition.lang = "en-IN";

    state.recognition.onstart = () => {
      setStatus(state.audioStatusEl, "Mic active (fast preview).", "text-green-600");
    };

    state.recognition.onresult = (ev) => {
      if (!ANU.state?.isRunning) return;
      if (state.micMuted) return;
      if (Date.now() < state.blockMicUntil) return;

      state.lastMicResultAt = Date.now();

      let latestInterim = "";
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const r = ev.results[i];
        const text = normalize(r[0].transcript || "");
        if (r.isFinal) t().addFinalSpeech(text, "candidate");
        else latestInterim = text;
      }

      if (latestInterim) {
        t().removeInterimIfAny();
        t().state.micInterimEntry = { t: Date.now(), text: latestInterim, role: "candidate" };
        t().state.timeline.push(t().state.micInterimEntry);
        t().updateTranscript();
      }
    };

    state.recognition.onerror = (e) => {
      state.micLangIndex = (state.micLangIndex + 1) % cfg.MIC_LANGS.length;
      setStatus(state.audioStatusEl, `Mic SR error: ${e?.error || "unknown"}. Retrying…`, "text-orange-600");
    };

    state.recognition.onend = () => {
      if (!ANU.state?.isRunning) return;
      if (state.micMuted) return;
      setTimeout(() => {
        if (!ANU.state?.isRunning) return;
        if (state.micMuted) return;
        try { state.recognition.start(); } catch {}
      }, 150);
    };

    state.lastMicResultAt = Date.now();

    if (state.micWatchdog) clearInterval(state.micWatchdog);
    state.micWatchdog = setInterval(() => {
      if (!ANU.state?.isRunning) return;
      if (state.micMuted) return;

      if (micSrIsHealthy()) {
        if (state.micRecorder || state.micStream) stopMicRecorderOnly();
        if (state.micAsr) stopAsrSession("mic");
        return;
      }

      const idle = Date.now() - (state.lastMicResultAt || 0);
      if (idle > 2500) {
        if (cfg.USE_STREAMING_ASR_MIC_FALLBACK && !state.micAsr && !state.micStream) {
          enableMicStreamingFallback().catch(() => {});
        } else if (!state.micRecorder && !state.micStream && !state.micAsr) {
          enableMicRecorderFallback().catch(() => {});
        }
      }
    }, 800);

    try { state.recognition.start(); } catch {}
    return true;
  }

  // ---------- mic recorder fallback ----------
  function stopMicRecorderOnly() {
    try { state.micAbort?.abort(); } catch {}
    state.micAbort = null;

    if (state.micSegmentTimer) clearInterval(state.micSegmentTimer);
    state.micSegmentTimer = null;

    try { state.micRecorder?.stop(); } catch {}
    state.micRecorder = null;

    state.micSegmentChunks = [];
    state.micQueue = [];
    state.micInFlight = 0;

    if (state.micStream) {
      try { state.micStream.getTracks().forEach(tr => tr.stop()); } catch {}
    }
    state.micStream = null;
    state.micTrack = null;
  }

  async function enableMicStreamingFallback() {
    if (!ANU.state?.isRunning) return;
    if (state.micMuted) return;
    if (state.micAsr) return;
    if (micSrIsHealthy()) return;

    try {
      state.micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    } catch {
      setStatus(state.audioStatusEl, "Mic permission denied for streaming ASR.", "text-red-600");
      return;
    }

    state.micTrack = state.micStream.getAudioTracks()[0];
    if (!state.micTrack) {
      setStatus(state.audioStatusEl, "No mic track detected for streaming ASR.", "text-red-600");
      stopMicRecorderOnly();
      return;
    }

    await startStreamingAsr("mic", state.micStream);
  }

  async function enableMicRecorderFallback() {
    if (!ANU.state?.isRunning) return;
    if (state.micMuted) return;
    if (state.micStream) return;
    if (micSrIsHealthy()) return;

    try {
      state.micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    } catch {
      setStatus(state.audioStatusEl, "Mic permission denied for fallback recorder.", "text-red-600");
      return;
    }

    state.micTrack = state.micStream.getAudioTracks()[0];
    if (!state.micTrack) {
      setStatus(state.audioStatusEl, "No mic track detected for fallback recorder.", "text-red-600");
      stopMicRecorderOnly();
      return;
    }

    state.micAbort = new AbortController();
    setStatus(state.audioStatusEl, "Mic active (fallback recorder).", "text-green-600");

    startMicSegmentRecorder();
  }

  function startMicSegmentRecorder() {
    if (!state.micTrack) return;

    const audioOnly = new MediaStream([state.micTrack]);
    const mime = pickBestMimeType();
    state.micSegmentChunks = [];

    try {
      state.micRecorder = new MediaRecorder(audioOnly, mime ? { mimeType: mime } : undefined);
    } catch {
      setStatus(state.audioStatusEl, "Mic recorder start failed.", "text-red-600");
      return;
    }

    state.micRecorder.ondataavailable = (ev) => {
      if (!ANU.state?.isRunning) return;
      if (state.micMuted) return;
      if (ev.data.size) state.micSegmentChunks.push(ev.data);
    };

    state.micRecorder.onstop = () => {
      if (!ANU.state?.isRunning) return;
      if (state.micMuted) return;

      const blob = new Blob(state.micSegmentChunks, { type: state.micRecorder?.mimeType || "" });
      state.micSegmentChunks = [];

      if (blob.size >= cfg.MIC_MIN_BYTES) {
        state.micQueue.push(blob);
        drainMicQueue();
      }

      if (ANU.state?.isRunning && state.micTrack && state.micTrack.readyState === "live") startMicSegmentRecorder();
    };

    try { state.micRecorder.start(); } catch {}

    if (state.micSegmentTimer) clearInterval(state.micSegmentTimer);
    state.micSegmentTimer = setInterval(() => {
      if (!ANU.state?.isRunning) return;
      if (state.micMuted) return;
      try { state.micRecorder?.stop(); } catch {}
    }, cfg.MIC_SEGMENT_MS);
  }

  function drainMicQueue() {
    if (!ANU.state?.isRunning) return;
    if (state.micMuted) return;

    while (state.micInFlight < cfg.MIC_MAX_CONCURRENT && state.micQueue.length) {
      const blob = state.micQueue.shift();
      const myEpoch = t().state.transcriptEpoch;
      state.micInFlight++;

      transcribeMicBlob(blob, myEpoch)
        .catch(() => {})
        .finally(() => {
          state.micInFlight--;
          drainMicQueue();
        });
    }
  }

  async function transcribeMicBlob(blob, myEpoch) {
    const fd = new FormData();
    const type = (blob.type || "").toLowerCase();
    const ext = type.includes("ogg") ? "ogg" : "webm";
    fd.append("file", blob, `mic.${ext}`);
    fd.append("prompt", cfg.TRANSCRIBE_PROMPT);

    const res = await apiFetch("transcribe", {
      method: "POST",
      body: fd,
      signal: state.micAbort?.signal
    }, false);

    if (myEpoch !== t().state.transcriptEpoch) return;
    if (state.micMuted) return;
    if (!res.ok) return;

    if (micSrIsHealthy()) return;
    if (state.micAsr) return;

    const data = await res.json().catch(() => ({}));
    const raw = String(data.text || "");
    if (looksLikeWhisperHallucination(raw)) return;

    const cleaned = dedupeByTail(
      raw,
      () => t().state.lastMicTail,
      (v) => { t().state.lastMicTail = v; }
    );

    if (cleaned) t().addFinalSpeech(cleaned, "candidate");
  }

  // ---------- system audio ----------
  function stopSystemAudioOnly() {
    try { state.sysAbort?.abort(); } catch {}
    state.sysAbort = null;

    if (state.sysSegmentTimer) clearInterval(state.sysSegmentTimer);
    state.sysSegmentTimer = null;

    try { state.sysRecorder?.stop(); } catch {}
    state.sysRecorder = null;

    state.sysSegmentChunks = [];
    state.sysQueue = [];
    state.sysInFlight = 0;

    stopAsrSession("sys");

    if (state.sysStream) {
      try { state.sysStream.getTracks().forEach(tr => tr.stop()); } catch {}
    }

    state.sysStream = null;
    state.sysTrack = null;

    state.sysErrCount = 0;
    state.sysErrBackoffUntil = 0;
  }

  async function enableSystemAudioLegacy(refs) {
    if (!ANU.state?.isRunning) return;

    stopSystemAudioOnly();

    try {
      state.sysStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    } catch {
      setStatus(state.audioStatusEl, "Share audio denied.", "text-red-600");
      return;
    }

    state.sysTrack = state.sysStream.getAudioTracks()[0];
    if (!state.sysTrack) {
      setStatus(state.audioStatusEl, "No system audio detected.", "text-red-600");
      stopSystemAudioOnly();
      showBanner(refs, "System audio requires selecting a window/tab and enabling “Share audio” in the picker.");
      return;
    }

    state.sysTrack.onended = () => {
      stopSystemAudioOnly();
      setStatus(state.audioStatusEl, "System audio stopped (share ended).", "text-orange-600");
    };

    state.sysAbort = new AbortController();
    startSystemSegmentRecorder();
    setStatus(state.audioStatusEl, "System audio enabled (legacy).", "text-green-600");
  }

  async function enableSystemAudioStreaming(refs) {
    if (!ANU.state?.isRunning) return;

    stopSystemAudioOnly();

    try {
      state.sysStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    } catch {
      setStatus(state.audioStatusEl, "Share audio denied.", "text-red-600");
      return;
    }

    state.sysTrack = state.sysStream.getAudioTracks()[0];
    if (!state.sysTrack) {
      setStatus(state.audioStatusEl, "No system audio detected.", "text-red-600");
      stopSystemAudioOnly();
      showBanner(refs, "System audio requires selecting a window/tab and enabling “Share audio” in the picker.");
      return;
    }

    state.sysTrack.onended = () => {
      stopSystemAudioOnly();
      setStatus(state.audioStatusEl, "System audio stopped (share ended).", "text-orange-600");
    };

    try {
      const ok = await startStreamingAsr("sys", state.sysStream);
      if (!ok) throw new Error("ASR start failed");
    } catch (e) {
      console.error(e);
      setStatus(state.audioStatusEl, "Streaming ASR failed. Falling back to legacy system transcription…", "text-orange-600");
      await enableSystemAudioLegacy(refs);
    }
  }

  async function enableSystemAudio(refs) {
    if (cfg.USE_STREAMING_ASR_SYS) return enableSystemAudioStreaming(refs);
    return enableSystemAudioLegacy(refs);
  }

  function startSystemSegmentRecorder() {
    if (!state.sysTrack) return;

    const audioOnly = new MediaStream([state.sysTrack]);
    const mime = pickBestMimeType();
    state.sysSegmentChunks = [];

    try {
      state.sysRecorder = new MediaRecorder(audioOnly, mime ? { mimeType: mime } : undefined);
    } catch {
      setStatus(state.audioStatusEl, "System audio start failed.", "text-red-600");
      return;
    }

    state.sysRecorder.ondataavailable = (ev) => {
      if (!ANU.state?.isRunning) return;
      if (ev.data.size) state.sysSegmentChunks.push(ev.data);
    };

    state.sysRecorder.onstop = () => {
      if (!ANU.state?.isRunning) return;

      const blob = new Blob(state.sysSegmentChunks, { type: state.sysRecorder?.mimeType || "" });
      state.sysSegmentChunks = [];

      if (blob.size >= cfg.SYS_MIN_BYTES) {
        state.sysQueue.push(blob);
        drainSysQueue();
      }

      if (ANU.state?.isRunning && state.sysTrack && state.sysTrack.readyState === "live") startSystemSegmentRecorder();
    };

    try { state.sysRecorder.start(); } catch {}

    if (state.sysSegmentTimer) clearInterval(state.sysSegmentTimer);
    state.sysSegmentTimer = setInterval(() => {
      if (!ANU.state?.isRunning) return;
      try { state.sysRecorder?.stop(); } catch {}
    }, cfg.SYS_SEGMENT_MS);
  }

  function drainSysQueue() {
    if (!ANU.state?.isRunning) return;
    if (Date.now() < state.sysErrBackoffUntil) return;

    while (state.sysInFlight < cfg.SYS_MAX_CONCURRENT && state.sysQueue.length) {
      const blob = state.sysQueue.shift();
      const myEpoch = t().state.transcriptEpoch;
      state.sysInFlight++;

      transcribeSysBlob(blob, myEpoch)
        .catch(() => {})
        .finally(() => {
          state.sysInFlight--;
          drainSysQueue();
        });
    }
  }

  function trimOverlap(prev, next) {
    if (!prev || !next) return next;

    const p = normalize(prev).toLowerCase();
    const n = normalize(next).toLowerCase();

    const pWords = p.split(" ");
    const nWords = n.split(" ");

    const maxCheck = Math.min(12, pWords.length, nWords.length);

    for (let k = maxCheck; k >= 3; k--) {
      const pTail = pWords.slice(-k).join(" ");
      const nHead = nWords.slice(0, k).join(" ");
      if (pTail === nHead) return nWords.slice(k).join(" ");
    }
    return next;
  }

  async function transcribeSysBlob(blob, myEpoch) {
    if (Date.now() < state.sysErrBackoffUntil) return;

    const fd = new FormData();
    const type = (blob.type || "").toLowerCase();
    const ext = type.includes("ogg") ? "ogg" : "webm";
    fd.append("file", blob, `sys.${ext}`);
    fd.append("prompt", cfg.TRANSCRIBE_PROMPT);

    const res = await apiFetch("transcribe", {
      method: "POST",
      body: fd,
      signal: state.sysAbort?.signal
    }, false);

    if (myEpoch !== t().state.transcriptEpoch) return;

    if (!res.ok) {
      state.sysErrCount++;
      const errText = await res.text().catch(() => "");
      setStatus(state.audioStatusEl, `System transcribe failed (${res.status}). ${errText.slice(0, 160)}`, "text-red-600");

      if (state.sysErrCount >= cfg.SYS_ERR_MAX) {
        state.sysErrBackoffUntil = Date.now() + cfg.SYS_ERR_BACKOFF_MS;
        stopSystemAudioOnly();
        setStatus(state.audioStatusEl, "System audio stopped (backend errors). Retry after fixing /transcribe.", "text-red-600");
      }
      return;
    }

    state.sysErrCount = 0;
    state.sysErrBackoffUntil = 0;

    const data = await res.json().catch(() => ({}));
    const raw = String(data.text || "");
    if (looksLikeWhisperHallucination(raw)) return;

    const cleaned = dedupeByTail(
      raw,
      () => t().state.lastSysTail,
      (v) => { t().state.lastSysTail = v; }
    );
    if (!cleaned) return;

    const text = normalize(cleaned);

    const trimmed = trimOverlap(t().state.lastSysPrinted, text);
    if (!trimmed) return;

    t().state.lastSysPrinted = normalize((t().state.lastSysPrinted + " " + trimmed).trim());
    t().state.lastSysPrintedAt = Date.now();

    t().addTypewriterSpeech(trimmed, cfg.SYS_TYPE_MS_PER_WORD, "interviewer");
  }

  // ---------- exported lifecycles ----------
  async function bootstrapMicRealtime() {
    const micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    await startStreamingAsr("mic", micStream);
  }

  function stopAllAudio() {
    stopMicOnly();
    stopMicRecorderOnly();
    stopSystemAudioOnly();
    stopAsrSession("mic");
    stopAsrSession("sys");
  }

  ANU.asr = {
    cfg,
    state,
    init,
    startMic,
    stopMicOnly,
    stopMicRecorderOnly,
    stopSystemAudioOnly,
    enableSystemAudio,
    stopAsrSession,
    bootstrapMicRealtime,
    stopAllAudio
  };
})();
