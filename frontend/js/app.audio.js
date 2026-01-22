/* ==========================================================================
   app.audio.js
   - Mic SR + recorder fallback
   - System audio capture (legacy + streaming)
   - Realtime ASR helper pipeline (WebSocket)
   ========================================================================== */

(() => {
  "use strict";

  const A = window.ANU_APP;
  const S = A.state;

  A.audio = A.audio || {};

  // Realtime secret cache
  let realtimeSecretCache = null;

  // streaming session holders
  S.micAsr = null;
  S.sysAsr = null;

  // ------------------------------------------------------------
  // DEDUPE UTIL
  // ------------------------------------------------------------
  function dedupeByTail(text, tailRef) {
    const t = A.util.normalize(text);
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
    return A.util.normalize(cleaned);
  }

  function looksLikeWhisperHallucination(t) {
    const s = A.util.normalize(t).toLowerCase();
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
    return noise.some((p) => s.includes(p));
  }

  // ------------------------------------------------------------
  // STREAMING ASR HELPERS
  // ------------------------------------------------------------
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

    const res = await A.api.apiFetch(
      "realtime/client_secret",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ttl_sec: 600 })
      },
      true
    );

    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data?.value) throw new Error(data?.error || "Failed to get realtime client secret");

    realtimeSecretCache = { value: data.value, expires_at: data.expires_at || 0 };
    return data.value;
  }

  A.audio.stopAsrSession = function stopAsrSession(which) {
    const s = which === "mic" ? S.micAsr : S.sysAsr;
    if (!s) return;

    try { s.ws?.close?.(); } catch {}
    try { s.sendTimer && clearInterval(s.sendTimer); } catch {}
    try { s.proc && (s.proc.onaudioprocess = null); } catch {}

    try { s.src && s.src.disconnect(); } catch {}
    try { s.proc && s.proc.disconnect(); } catch {}
    try { s.gain && s.gain.disconnect(); } catch {}
    try { s.ctx && s.ctx.close && s.ctx.close(); } catch {}

    if (which === "mic") S.micAsr = null;
    else S.sysAsr = null;
  };

  function sendAsrConfig(ws) {
    const cfgA = {
      type: "transcription_session.update",
      input_audio_format: "pcm16",
      input_audio_transcription: {
        model: A.const.REALTIME_ASR_MODEL,
        language: "en-IN",
        prompt:
          A.const.TRANSCRIBE_PROMPT +
          " Speaker has an Indian English accent. " +
          "Prefer Indian pronunciation and spelling. " +
          "Do not normalize to US English."
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
            format: { type: "audio/pcm", rate: A.const.ASR_TARGET_RATE },
            transcription: {
              model: A.const.REALTIME_ASR_MODEL,
              language: "en-IN",
              prompt: A.const.TRANSCRIBE_PROMPT + " Speaker has an Indian English accent. Use Indian pronunciation and spelling."
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

  function asrUpsertDelta(which, itemId, deltaText) {
    const s = which === "mic" ? S.micAsr : S.sysAsr;
    if (!s) return;

    const now = Date.now();
    if (!s.itemText[itemId]) s.itemText[itemId] = "";
    s.itemText[itemId] += String(deltaText || "");

    const words = A.util.normalize(s.itemText[itemId]).split(" ");
    if (words.length >= A.const.COMMIT_WORDS) {
      asrFinalizeItem(which, itemId, s.itemText[itemId]);
    }

    const cur = A.util.normalize(s.itemText[itemId]);
    if (!cur) return;

    const role = which === "sys" ? "interviewer" : "candidate";

    if (!s.itemEntry[itemId]) {
      const entry = { t: now, text: cur, role };
      s.itemEntry[itemId] = entry;
      S.timeline.push(entry);
    } else {
      s.itemEntry[itemId].text = cur;
      s.itemEntry[itemId].t = now;
      s.itemEntry[itemId].role = role;
    }

    S.lastSpeechAt = now;
    A.transcript.updateTranscript();
  }

  function asrFinalizeItem(which, itemId, transcript) {
    const s = which === "mic" ? S.micAsr : S.sysAsr;
    if (!s) return;

    const entry = s.itemEntry[itemId];
    let draftText = "";

    if (entry) {
      draftText = entry.text || "";
      const idx = S.timeline.indexOf(entry);
      if (idx >= 0) S.timeline.splice(idx, 1);
    }

    delete s.itemEntry[itemId];
    delete s.itemText[itemId];

    const final = A.util.normalize(transcript || draftText);
    if (!final) return;

    const role = which === "sys" ? "interviewer" : "candidate";
    A.transcript.addFinalSpeech(final, role);
  }

  A.audio.startStreamingAsr = async function startStreamingAsr(which, mediaStream) {
    if (!S.isRunning) return false;
    if (which === "mic" && S.micMuted) return false;

    A.audio.stopAsrSession(which);

    const secret = await getRealtimeClientSecretCached();

    const ws = new WebSocket(A.const.REALTIME_INTENT_URL, [
      "realtime",
      "openai-insecure-api-key." + secret
    ]);

    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const src = ctx.createMediaStreamSource(mediaStream);

    const gain = ctx.createGain();
    gain.gain.value = 0;

    const proc = ctx.createScriptProcessor(4096, 1, 1);
    const queue = [];

    const state = {
      ws, ctx, src, proc, gain, queue,
      sendTimer: null,
      itemText: {},
      itemEntry: {},
      sawConfigError: false
    };

    if (which === "mic") S.micAsr = state;
    else S.sysAsr = state;

    proc.onaudioprocess = (e) => {
      if (!S.isRunning) return;
      if (which === "mic" && S.micMuted) return;
      if (ws.readyState !== 1) return;

      const ch0 = e.inputBuffer.getChannelData(0);
      const inRate = ctx.sampleRate || 48000;

      const resampled = resampleFloat32(ch0, inRate, A.const.ASR_TARGET_RATE);
      const bytes = floatToInt16Bytes(resampled);
      if (bytes.length) queue.push(bytes);
    };

    src.connect(proc);
    proc.connect(gain);
    gain.connect(ctx.destination);

    ws.onopen = () => {
      sendAsrConfig(ws);

      state.sendTimer = setInterval(() => {
        if (!S.isRunning) return;
        if (which === "mic" && S.micMuted) return;
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
      }, A.const.ASR_SEND_EVERY_MS);

      A.ui.setStatus(
        A.dom.audioStatus,
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
  };

  // ------------------------------------------------------------
  // MIC SR + fallback
  // ------------------------------------------------------------
  A.audio.micSrIsHealthy = function micSrIsHealthy() {
    return Date.now() - (S.lastMicResultAt || 0) < 1800;
  };

  A.audio.stopMicOnly = function stopMicOnly() {
    try { S.recognition?.stop(); } catch {}
    S.recognition = null;
    S.micInterimEntry = null;
    if (S.micWatchdog) clearInterval(S.micWatchdog);
    S.micWatchdog = null;
  };

  function pickBestMimeType() {
    const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/ogg"];
    for (const t of candidates) if (MediaRecorder.isTypeSupported(t)) return t;
    return "";
  }

  A.audio.stopMicRecorderOnly = function stopMicRecorderOnly() {
    try { S.micAbort?.abort(); } catch {}
    S.micAbort = null;

    if (S.micSegmentTimer) clearInterval(S.micSegmentTimer);
    S.micSegmentTimer = null;

    try { S.micRecorder?.stop(); } catch {}
    S.micRecorder = null;

    S.micSegmentChunks = [];
    S.micQueue = [];
    S.micInFlight = 0;

    if (S.micStream) {
      try { S.micStream.getTracks().forEach((t) => t.stop()); } catch {}
    }
    S.micStream = null;
    S.micTrack = null;
  };

  async function transcribeMicBlob(blob, myEpoch) {
    const fd = new FormData();
    const type = (blob.type || "").toLowerCase();
    const ext = type.includes("ogg") ? "ogg" : "webm";
    fd.append("file", blob, `mic.${ext}`);
    fd.append("prompt", A.const.TRANSCRIBE_PROMPT);

    const res = await A.api.apiFetch(
      "transcribe",
      { method: "POST", body: fd, signal: S.micAbort?.signal },
      false
    );

    if (myEpoch !== S.transcriptEpoch) return;
    if (S.micMuted) return;
    if (!res.ok) return;

    // If SR became healthy or streaming ASR active, drop recorder results
    if (A.audio.micSrIsHealthy()) return;
    if (S.micAsr) return;

    const data = await res.json().catch(() => ({}));
    const raw = String(data.text || "");
    if (looksLikeWhisperHallucination(raw)) return;

    const cleaned = dedupeByTail(raw, {
      get value() { return S.lastMicTail; },
      set value(v) { S.lastMicTail = v; }
    });

    if (cleaned) A.transcript.addFinalSpeech(cleaned, "candidate");
  }

  function drainMicQueue() {
    if (!S.isRunning) return;
    if (S.micMuted) return;

    while (S.micInFlight < A.const.MIC_MAX_CONCURRENT && S.micQueue.length) {
      const blob = S.micQueue.shift();
      const myEpoch = S.transcriptEpoch;
      S.micInFlight++;

      transcribeMicBlob(blob, myEpoch)
        .catch(() => {})
        .finally(() => {
          S.micInFlight--;
          drainMicQueue();
        });
    }
  }

  function startMicSegmentRecorder() {
    if (!S.micTrack) return;

    const audioOnly = new MediaStream([S.micTrack]);
    const mime = pickBestMimeType();
    S.micSegmentChunks = [];

    try {
      S.micRecorder = new MediaRecorder(audioOnly, mime ? { mimeType: mime } : undefined);
    } catch {
      A.ui.setStatus(A.dom.audioStatus, "Mic recorder start failed.", "text-red-600");
      return;
    }

    S.micRecorder.ondataavailable = (ev) => {
      if (!S.isRunning) return;
      if (S.micMuted) return;
      if (ev.data.size) S.micSegmentChunks.push(ev.data);
    };

    S.micRecorder.onstop = () => {
      if (!S.isRunning) return;
      if (S.micMuted) return;

      const blob = new Blob(S.micSegmentChunks, { type: S.micRecorder?.mimeType || "" });
      S.micSegmentChunks = [];

      if (blob.size >= A.const.MIC_MIN_BYTES) {
        S.micQueue.push(blob);
        drainMicQueue();
      }

      if (S.isRunning && S.micTrack && S.micTrack.readyState === "live") startMicSegmentRecorder();
    };

    try { S.micRecorder.start(); } catch {}

    if (S.micSegmentTimer) clearInterval(S.micSegmentTimer);
    S.micSegmentTimer = setInterval(() => {
      if (!S.isRunning) return;
      if (S.micMuted) return;
      try { S.micRecorder?.stop(); } catch {}
    }, A.const.MIC_SEGMENT_MS);
  }

  A.audio.enableMicRecorderFallback = async function enableMicRecorderFallback() {
    if (!S.isRunning) return;
    if (S.micMuted) return;
    if (S.micStream) return;
    if (A.audio.micSrIsHealthy()) return;

    try {
      S.micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    } catch {
      A.ui.setStatus(A.dom.audioStatus, "Mic permission denied for fallback recorder.", "text-red-600");
      return;
    }

    S.micTrack = S.micStream.getAudioTracks()[0];
    if (!S.micTrack) {
      A.ui.setStatus(A.dom.audioStatus, "No mic track detected for fallback recorder.", "text-red-600");
      A.audio.stopMicRecorderOnly();
      return;
    }

    S.micAbort = new AbortController();
    A.ui.setStatus(A.dom.audioStatus, "Mic active (fallback recorder).", "text-green-600");

    startMicSegmentRecorder();
  };

  // Mic mute UI
  A.audio.updateMicMuteUI = function updateMicMuteUI() {
    const btn = A.dom.micMuteBtn;
    if (!btn) return;

    if (S.micMuted) {
      btn.textContent = "Mic: OFF";
      btn.classList.remove("bg-gray-700");
      btn.classList.add("bg-gray-900");
    } else {
      btn.textContent = "Mic: ON";
      btn.classList.remove("bg-gray-900");
      btn.classList.add("bg-gray-700");
    }
  };

  function stopMicPipelinesOnly() {
    try { S.recognition?.stop(); } catch {}
    S.recognition = null;

    if (S.micWatchdog) clearInterval(S.micWatchdog);
    S.micWatchdog = null;

    A.audio.stopAsrSession("mic");
    A.audio.stopMicRecorderOnly();
    A.transcript.removeInterimIfAny();
  }

  A.audio.setMicMuted = async function setMicMuted(on) {
    S.micMuted = !!on;
    A.audio.updateMicMuteUI();

    if (!S.isRunning) return;

    if (S.micMuted) {
      stopMicPipelinesOnly();
      A.ui.setStatus(A.dom.audioStatus, "Mic muted (user OFF). System audio continues.", "text-orange-600");
      return;
    }

    // When unmuted: resume streaming asr (your current behavior)
    try {
      const micStreamTmp = await navigator.mediaDevices.getUserMedia({ audio: true });
      await A.audio.startStreamingAsr("mic", micStreamTmp);
      A.ui.setStatus(A.dom.audioStatus, "Mic unmuted.", "text-green-600");
    } catch {
      A.ui.setStatus(A.dom.audioStatus, "Mic unmuted but streaming ASR failed. Using fallback recorder…", "text-orange-600");
      await A.audio.enableMicRecorderFallback().catch(() => {});
    }
  };

  // ------------------------------------------------------------
  // SYSTEM AUDIO
  // ------------------------------------------------------------
  A.audio.stopSystemAudioOnly = function stopSystemAudioOnly() {
    try { S.sysAbort?.abort(); } catch {}
    S.sysAbort = null;

    if (S.sysSegmentTimer) clearInterval(S.sysSegmentTimer);
    S.sysSegmentTimer = null;

    try { S.sysRecorder?.stop(); } catch {}
    S.sysRecorder = null;

    S.sysSegmentChunks = [];
    S.sysQueue = [];
    S.sysInFlight = 0;

    A.audio.stopAsrSession("sys");

    if (S.sysStream) {
      try { S.sysStream.getTracks().forEach((t) => t.stop()); } catch {}
    }

    S.sysStream = null;
    S.sysTrack = null;

    S.sysErrCount = 0;
    S.sysErrBackoffUntil = 0;
  };

  function startSystemSegmentRecorder() {
    if (!S.sysTrack) return;

    const audioOnly = new MediaStream([S.sysTrack]);
    const mime = pickBestMimeType();
    S.sysSegmentChunks = [];

    try {
      S.sysRecorder = new MediaRecorder(audioOnly, mime ? { mimeType: mime } : undefined);
    } catch {
      A.ui.setStatus(A.dom.audioStatus, "System audio start failed.", "text-red-600");
      return;
    }

    S.sysRecorder.ondataavailable = (ev) => {
      if (!S.isRunning) return;
      if (ev.data.size) S.sysSegmentChunks.push(ev.data);
    };

    S.sysRecorder.onstop = () => {
      if (!S.isRunning) return;

      const blob = new Blob(S.sysSegmentChunks, { type: S.sysRecorder?.mimeType || "" });
      S.sysSegmentChunks = [];

      if (blob.size >= A.const.SYS_MIN_BYTES) {
        S.sysQueue.push(blob);
        drainSysQueue();
      }

      if (S.isRunning && S.sysTrack && S.sysTrack.readyState === "live") startSystemSegmentRecorder();
    };

    try { S.sysRecorder.start(); } catch {}

    if (S.sysSegmentTimer) clearInterval(S.sysSegmentTimer);
    S.sysSegmentTimer = setInterval(() => {
      if (!S.isRunning) return;
      try { S.sysRecorder?.stop(); } catch {}
    }, A.const.SYS_SEGMENT_MS);
  }

  function trimOverlap(prev, next) {
    if (!prev || !next) return next;

    const p = A.util.normalize(prev).toLowerCase();
    const n = A.util.normalize(next).toLowerCase();

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
    if (Date.now() < S.sysErrBackoffUntil) return;

    const fd = new FormData();
    const type = (blob.type || "").toLowerCase();
    const ext = type.includes("ogg") ? "ogg" : "webm";
    fd.append("file", blob, `sys.${ext}`);
    fd.append("prompt", A.const.TRANSCRIBE_PROMPT);

    const res = await A.api.apiFetch(
      "transcribe",
      { method: "POST", body: fd, signal: S.sysAbort?.signal },
      false
    );

    if (myEpoch !== S.transcriptEpoch) return;

    if (!res.ok) {
      S.sysErrCount++;
      const errText = await res.text().catch(() => "");
      A.ui.setStatus(A.dom.audioStatus, `System transcribe failed (${res.status}). ${errText.slice(0, 160)}`, "text-red-600");

      if (S.sysErrCount >= A.const.SYS_ERR_MAX) {
        S.sysErrBackoffUntil = Date.now() + A.const.SYS_ERR_BACKOFF_MS;
        A.audio.stopSystemAudioOnly();
        A.ui.setStatus(A.dom.audioStatus, "System audio stopped (backend errors). Retry after fixing /transcribe.", "text-red-600");
      }
      return;
    }

    S.sysErrCount = 0;
    S.sysErrBackoffUntil = 0;

    const data = await res.json().catch(() => ({}));
    const raw = String(data.text || "");
    if (looksLikeWhisperHallucination(raw)) return;

    const cleaned = dedupeByTail(raw, {
      get value() { return S.lastSysTail; },
      set value(v) { S.lastSysTail = v; }
    });

    if (!cleaned) return;

    const text = A.util.normalize(cleaned);

    // compute trimmed BEFORE overwriting lastSysPrinted
    const trimmed = trimOverlap(S.lastSysPrinted, text);
    if (!trimmed) return;

    S.lastSysPrinted = A.util.normalize((S.lastSysPrinted + " " + trimmed).trim());
    S.lastSysPrintedAt = Date.now();

    A.transcript.addTypewriterSpeech(trimmed, A.const.SYS_TYPE_MS_PER_WORD, "interviewer");
  }

  function drainSysQueue() {
    if (!S.isRunning) return;
    if (Date.now() < S.sysErrBackoffUntil) return;

    while (S.sysInFlight < A.const.SYS_MAX_CONCURRENT && S.sysQueue.length) {
      const blob = S.sysQueue.shift();
      const myEpoch = S.transcriptEpoch;
      S.sysInFlight++;

      transcribeSysBlob(blob, myEpoch)
        .catch(() => {})
        .finally(() => {
          S.sysInFlight--;
          drainSysQueue();
        });
    }
  }

  async function enableSystemAudioLegacy() {
    if (!S.isRunning) return;

    A.audio.stopSystemAudioOnly();

    try {
      S.sysStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    } catch {
      A.ui.setStatus(A.dom.audioStatus, "Share audio denied.", "text-red-600");
      return;
    }

    S.sysTrack = S.sysStream.getAudioTracks()[0];
    if (!S.sysTrack) {
      A.ui.setStatus(A.dom.audioStatus, "No system audio detected.", "text-red-600");
      A.audio.stopSystemAudioOnly();
      A.ui.showBanner("System audio requires selecting a window/tab and enabling “Share audio” in the picker.");
      return;
    }

    S.sysTrack.onended = () => {
      A.audio.stopSystemAudioOnly();
      A.ui.setStatus(A.dom.audioStatus, "System audio stopped (share ended).", "text-orange-600");
    };

    S.sysAbort = new AbortController();
    startSystemSegmentRecorder();
    A.ui.setStatus(A.dom.audioStatus, "System audio enabled (legacy).", "text-green-600");
  }

  async function enableSystemAudioStreaming() {
    if (!S.isRunning) return;

    A.audio.stopSystemAudioOnly();

    try {
      S.sysStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    } catch {
      A.ui.setStatus(A.dom.audioStatus, "Share audio denied.", "text-red-600");
      return;
    }

    S.sysTrack = S.sysStream.getAudioTracks()[0];
    if (!S.sysTrack) {
      A.ui.setStatus(A.dom.audioStatus, "No system audio detected.", "text-red-600");
      A.audio.stopSystemAudioOnly();
      A.ui.showBanner("System audio requires selecting a window/tab and enabling “Share audio” in the picker.");
      return;
    }

    S.sysTrack.onended = () => {
      A.audio.stopSystemAudioOnly();
      A.ui.setStatus(A.dom.audioStatus, "System audio stopped (share ended).", "text-orange-600");
    };

    try {
      const ok = await A.audio.startStreamingAsr("sys", S.sysStream);
      if (!ok) throw new Error("ASR start failed");
    } catch (e) {
      console.error(e);
      A.ui.setStatus(A.dom.audioStatus, "Streaming ASR failed. Falling back to legacy system transcription…", "text-orange-600");
      await enableSystemAudioLegacy();
    }
  }

  A.audio.enableSystemAudio = async function enableSystemAudio() {
    if (A.const.USE_STREAMING_ASR_SYS) return enableSystemAudioStreaming();
    return enableSystemAudioLegacy();
  };
})();
