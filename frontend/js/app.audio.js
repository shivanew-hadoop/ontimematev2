/* ==========================================================================
 * app.audio.js
 * Audio pipelines:
 *  - Streaming ASR (realtime) for mic/system
 *  - Legacy MediaRecorder -> /transcribe fallback
 *
 * Fixes:
 *  - Immediate transcript while speaking (legacy uses timeslice chunks)
 *  - 3s pause blocks work (deltas DO NOT touch lastSpeechAt)
 *  - Duplicate collapse applied on final + system prints
 * ========================================================================== */
(() => {
  "use strict";

  const A = (window.ANU_APP = window.ANU_APP || {});
  A.audio = A.audio || {};
  const S = A.state;
  const C = A.const;

  /* -------------------------------------------------------------------------- */
  /* FLAGS                                                                       */
  /* -------------------------------------------------------------------------- */
  const USE_STREAMING_ASR_SYS = true;     // keep true for immediate sys transcript
  const USE_BROWSER_SR = false;           // your current startAll used micOk=false; keep off
  const USE_STREAMING_ASR_MIC_FALLBACK = false;

  /* -------------------------------------------------------------------------- */
  /* STREAMING ASR (Realtime)                                                    */
  /* -------------------------------------------------------------------------- */
  const REALTIME_INTENT_URL = "wss://api.openai.com/v1/realtime?intent=transcription";
  const REALTIME_ASR_MODEL = "gpt-4o-mini-transcribe";
  const ASR_SEND_EVERY_MS = 40;
  const ASR_TARGET_RATE = 24000;

  let realtimeSecretCache = null;
  let micAsr = null;
  let sysAsr = null;

  const COMMIT_WORDS = 18; // keep your auto finalize behavior

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

  function stopAsrSession(which) {
    const st = which === "mic" ? micAsr : sysAsr;
    if (!st) return;

    try { st.ws?.close?.(); } catch {}
    try { st.sendTimer && clearInterval(st.sendTimer); } catch {}
    try { st.proc && (st.proc.onaudioprocess = null); } catch {}

    try { st.src && st.src.disconnect(); } catch {}
    try { st.proc && st.proc.disconnect(); } catch {}
    try { st.gain && st.gain.disconnect(); } catch {}
    try { st.ctx && st.ctx.close && st.ctx.close(); } catch {}

    if (which === "mic") micAsr = null;
    else sysAsr = null;
  }

  function sendAsrConfig(ws) {
    const cfgA = {
      type: "transcription_session.update",
      input_audio_format: "pcm16",
      input_audio_transcription: {
        model: REALTIME_ASR_MODEL,
        language: "en-IN",
        prompt:
          C.TRANSCRIBE_PROMPT +
          " Speaker has an Indian English accent. Prefer Indian pronunciation and spelling. Do not normalize to US English."
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
            format: { type: "audio/pcm", rate: ASR_TARGET_RATE },
            transcription: {
              model: REALTIME_ASR_MODEL,
              language: "en-IN",
              prompt: C.TRANSCRIBE_PROMPT + " Speaker has an Indian English accent. Use Indian pronunciation and spelling."
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
    const st = which === "mic" ? micAsr : sysAsr;
    if (!st) return;

    const now = Date.now();
    if (!st.itemText[itemId]) st.itemText[itemId] = "";
    st.itemText[itemId] += String(deltaText || "");

    // auto-finalize if long enough
    const words = A.util.normalize(st.itemText[itemId]).split(" ");
    if (words.length >= COMMIT_WORDS) {
      asrFinalizeItem(which, itemId, st.itemText[itemId]);
      return;
    }

    const cur = A.util.normalize(st.itemText[itemId]);
    if (!cur) return;

    const role = (which === "sys") ? "interviewer" : "candidate";

    if (!st.itemEntry[itemId]) {
      const entry = { t: now, text: cur, role };
      st.itemEntry[itemId] = entry;
      S.timeline.push(entry);
    } else {
      st.itemEntry[itemId].text = cur;
      st.itemEntry[itemId].t = now;
      st.itemEntry[itemId].role = role;
    }

    // IMPORTANT FIX:
    // Do NOT update S.lastSpeechAt on deltas.
    // Otherwise 3s pause rule never triggers a new block.
    A.transcript.updateTranscript();
  }

  function asrFinalizeItem(which, itemId, transcript) {
    const st = which === "mic" ? micAsr : sysAsr;
    if (!st) return;

    const entry = st.itemEntry[itemId];
    let draftText = "";

    if (entry) {
      draftText = entry.text || "";
      const idx = S.timeline.indexOf(entry);
      if (idx >= 0) S.timeline.splice(idx, 1);
    }

    delete st.itemEntry[itemId];
    delete st.itemText[itemId];

    const final = A.util.collapseInternalRepeats(transcript || draftText);
    if (!final) return;

    const role = (which === "sys") ? "interviewer" : "candidate";
    A.transcript.addFinalSpeech(final, role);
  }

  async function startStreamingAsr(which, mediaStream) {
    if (!S.isRunning) return false;
    if (which === "mic" && S.micMuted) return false;

    stopAsrSession(which);

    const secret = await getRealtimeClientSecretCached();

    const ws = new WebSocket(REALTIME_INTENT_URL, [
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

    if (which === "mic") micAsr = st;
    else sysAsr = st;

    proc.onaudioprocess = (e) => {
      if (!S.isRunning) return;
      if (which === "mic" && S.micMuted) return;
      if (ws.readyState !== 1) return;

      const ch0 = e.inputBuffer.getChannelData(0);
      const inRate = ctx.sampleRate || 48000;

      const resampled = resampleFloat32(ch0, inRate, ASR_TARGET_RATE);
      const bytes = floatToInt16Bytes(resampled);
      if (bytes.length) queue.push(bytes);
    };

    src.connect(proc);
    proc.connect(gain);
    gain.connect(ctx.destination);

    ws.onopen = () => {
      sendAsrConfig(ws);

      st.sendTimer = setInterval(() => {
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
      }, ASR_SEND_EVERY_MS);

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

    ws.onerror = () => {
      // keep quiet, fallback handled by caller
    };

    return true;
  }

  /* -------------------------------------------------------------------------- */
  /* MIC MUTE UI                                                                 */
  /* -------------------------------------------------------------------------- */
  function updateMicMuteUI() {
    if (!A.dom.micMuteBtn) return;

    if (S.micMuted) {
      A.dom.micMuteBtn.textContent = "Mic: OFF";
      A.dom.micMuteBtn.classList.remove("bg-gray-700");
      A.dom.micMuteBtn.classList.add("bg-gray-900");
    } else {
      A.dom.micMuteBtn.textContent = "Mic: ON";
      A.dom.micMuteBtn.classList.remove("bg-gray-900");
      A.dom.micMuteBtn.classList.add("bg-gray-700");
    }
  }

  async function setMicMuted(on) {
    S.micMuted = !!on;
    updateMicMuteUI();

    if (!S.isRunning) return;

    if (S.micMuted) {
      stopMicPipelinesOnly();
      A.ui.setStatus(A.dom.audioStatus, "Mic muted (user OFF). System audio continues.", "text-orange-600");
      return;
    }

    // mic SR is disabled; start streaming ASR immediately
    try {
      const ms = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      S.micStream = ms;
      S.micTrack = ms.getAudioTracks()[0] || null;
      await startStreamingAsr("mic", ms);
      A.ui.setStatus(A.dom.audioStatus, "Mic unmuted (streaming ASR).", "text-green-600");
    } catch {
      A.ui.setStatus(A.dom.audioStatus, "Mic permission denied.", "text-red-600");
    }
  }

  function stopMicPipelinesOnly() {
    stopAsrSession("mic");
    stopMicRecorderOnly();
    A.transcript.removeInterimIfAny();
  }

  /* -------------------------------------------------------------------------- */
  /* LEGACY RECORDER HELPERS (IMMEDIATE CHUNKS)                                  */
  /* -------------------------------------------------------------------------- */
  function pickBestMimeType() {
    const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/ogg"];
    for (const t of candidates) if (MediaRecorder.isTypeSupported(t)) return t;
    return "";
  }

  function stopMicRecorderOnly() {
    try { S.micAbort?.abort(); } catch {}
    S.micAbort = null;

    try { S.micRecorder?.stop(); } catch {}
    S.micRecorder = null;

    S.micSegmentChunks = [];
    S.micQueue = [];
    S.micInFlight = 0;

    if (S.micStream) {
      try { S.micStream.getTracks().forEach(t => t.stop()); } catch {}
    }
    S.micStream = null;
    S.micTrack = null;
  }

  async function enableMicRecorderFallback() {
    if (!S.isRunning) return;
    if (S.micMuted) return;
    if (S.micStream) return;

    try {
      S.micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    } catch {
      A.ui.setStatus(A.dom.audioStatus, "Mic permission denied for fallback recorder.", "text-red-600");
      return;
    }

    S.micTrack = S.micStream.getAudioTracks()[0];
    if (!S.micTrack) {
      A.ui.setStatus(A.dom.audioStatus, "No mic track detected for fallback recorder.", "text-red-600");
      stopMicRecorderOnly();
      return;
    }

    S.micAbort = new AbortController();
    A.ui.setStatus(A.dom.audioStatus, "Mic active (fallback recorder).", "text-green-600");

    startMicChunkRecorder();
  }

  function startMicChunkRecorder() {
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

    // IMMEDIATE CHUNK MODE:
    // MediaRecorder.start(timeslice) emits dataavailable every timeslice without needing stop()
    S.micRecorder.ondataavailable = (ev) => {
      if (!S.isRunning) return;
      if (S.micMuted) return;
      if (!ev.data || !ev.data.size) return;

      // push each chunk directly (fast feedback)
      if (ev.data.size >= C.MIC_MIN_BYTES) {
        S.micQueue.push(ev.data);
        drainMicQueue();
      }
    };

    S.micRecorder.onerror = () => {};
    try { S.micRecorder.start(C.MIC_SEGMENT_MS); } catch {}
  }

  function drainMicQueue() {
    if (!S.isRunning) return;
    if (S.micMuted) return;

    while (S.micInFlight < C.MIC_MAX_CONCURRENT && S.micQueue.length) {
      const blobPart = S.micQueue.shift();
      const myEpoch = S.transcriptEpoch;
      S.micInFlight++;

      // blobPart is a Blob already
      transcribeMicBlob(new Blob([blobPart], { type: blobPart.type || "" }), myEpoch)
        .catch(() => {})
        .finally(() => {
          S.micInFlight--;
          drainMicQueue();
        });
    }
  }

  async function transcribeMicBlob(blob, myEpoch) {
    const fd = new FormData();
    const type = (blob.type || "").toLowerCase();
    const ext = type.includes("ogg") ? "ogg" : "webm";
    fd.append("file", blob, `mic.${ext}`);
    fd.append("prompt", C.TRANSCRIBE_PROMPT);

    const res = await A.api.apiFetch("transcribe", {
      method: "POST",
      body: fd,
      signal: S.micAbort?.signal
    }, false);

    if (myEpoch !== S.transcriptEpoch) return;
    if (S.micMuted) return;
    if (!res.ok) return;

    const data = await res.json().catch(() => ({}));
    const raw0 = String(data.text || "");
    if (A.util.looksLikeWhisperHallucination(raw0)) return;

    const raw = A.util.collapseInternalRepeats(raw0);

    const cleaned = A.util.dedupeByTail(raw, {
      get value() { return S.lastMicTail; },
      set value(v) { S.lastMicTail = v; }
    });

    if (cleaned) A.transcript.addFinalSpeech(cleaned, "candidate");
  }

  /* -------------------------------------------------------------------------- */
  /* SYSTEM AUDIO                                                                */
  /* -------------------------------------------------------------------------- */
  function stopSystemAudioOnly() {
    try { S.sysAbort?.abort(); } catch {}
    S.sysAbort = null;

    try { S.sysRecorder?.stop(); } catch {}
    S.sysRecorder = null;

    S.sysSegmentChunks = [];
    S.sysQueue = [];
    S.sysInFlight = 0;

    stopAsrSession("sys");

    if (S.sysStream) {
      try { S.sysStream.getTracks().forEach(t => t.stop()); } catch {}
    }

    S.sysStream = null;
    S.sysTrack = null;

    S.sysErrCount = 0;
    S.sysErrBackoffUntil = 0;
  }

  async function enableSystemAudioLegacy() {
    if (!S.isRunning) return;

    stopSystemAudioOnly();

    try {
      S.sysStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    } catch {
      A.ui.setStatus(A.dom.audioStatus, "Share audio denied.", "text-red-600");
      return;
    }

    S.sysTrack = S.sysStream.getAudioTracks()[0];
    if (!S.sysTrack) {
      A.ui.setStatus(A.dom.audioStatus, "No system audio detected.", "text-red-600");
      stopSystemAudioOnly();
      A.ui.showBanner("System audio requires selecting a window/tab and enabling “Share audio” in the picker.");
      return;
    }

    S.sysTrack.onended = () => {
      stopSystemAudioOnly();
      A.ui.setStatus(A.dom.audioStatus, "System audio stopped (share ended).", "text-orange-600");
    };

    S.sysAbort = new AbortController();
    startSystemChunkRecorder();
    A.ui.setStatus(A.dom.audioStatus, "System audio enabled (legacy chunks).", "text-green-600");
  }

  async function enableSystemAudioStreaming() {
    if (!S.isRunning) return;

    stopSystemAudioOnly();

    try {
      S.sysStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    } catch {
      A.ui.setStatus(A.dom.audioStatus, "Share audio denied.", "text-red-600");
      return;
    }

    S.sysTrack = S.sysStream.getAudioTracks()[0];
    if (!S.sysTrack) {
      A.ui.setStatus(A.dom.audioStatus, "No system audio detected.", "text-red-600");
      stopSystemAudioOnly();
      A.ui.showBanner("System audio requires selecting a window/tab and enabling “Share audio” in the picker.");
      return;
    }

    S.sysTrack.onended = () => {
      stopSystemAudioOnly();
      A.ui.setStatus(A.dom.audioStatus, "System audio stopped (share ended).", "text-orange-600");
    };

    try {
      const ok = await startStreamingAsr("sys", S.sysStream);
      if (!ok) throw new Error("ASR start failed");
    } catch (e) {
      console.error(e);
      A.ui.setStatus(A.dom.audioStatus, "Streaming ASR failed. Falling back to legacy chunks…", "text-orange-600");
      await enableSystemAudioLegacy();
    }
  }

  async function enableSystemAudio() {
    if (USE_STREAMING_ASR_SYS) return enableSystemAudioStreaming();
    return enableSystemAudioLegacy();
  }

  function startSystemChunkRecorder() {
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

    // IMMEDIATE CHUNK MODE:
    // Emit dataavailable every SYS_SEGMENT_MS so transcription happens while audio continues
    S.sysRecorder.ondataavailable = (ev) => {
      if (!S.isRunning) return;
      if (!ev.data || !ev.data.size) return;

      if (ev.data.size >= C.SYS_MIN_BYTES) {
        S.sysQueue.push(ev.data);
        drainSysQueue();
      }
    };

    try { S.sysRecorder.start(C.SYS_SEGMENT_MS); } catch {}
  }

  function drainSysQueue() {
    if (!S.isRunning) return;
    if (Date.now() < S.sysErrBackoffUntil) return;

    while (S.sysInFlight < C.SYS_MAX_CONCURRENT && S.sysQueue.length) {
      const part = S.sysQueue.shift();
      const myEpoch = S.transcriptEpoch;
      S.sysInFlight++;

      transcribeSysBlob(new Blob([part], { type: part.type || "" }), myEpoch)
        .catch(() => {})
        .finally(() => {
          S.sysInFlight--;
          drainSysQueue();
        });
    }
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
    fd.append("prompt", C.TRANSCRIBE_PROMPT);

    const res = await A.api.apiFetch("transcribe", {
      method: "POST",
      body: fd,
      signal: S.sysAbort?.signal
    }, false);

    if (myEpoch !== S.transcriptEpoch) return;

    if (!res.ok) {
      S.sysErrCount++;
      const errText = await res.text().catch(() => "");
      A.ui.setStatus(A.dom.audioStatus, `System transcribe failed (${res.status}). ${errText.slice(0, 160)}`, "text-red-600");

      if (S.sysErrCount >= C.SYS_ERR_MAX) {
        S.sysErrBackoffUntil = Date.now() + C.SYS_ERR_BACKOFF_MS;
        stopSystemAudioOnly();
        A.ui.setStatus(A.dom.audioStatus, "System audio stopped (backend errors). Fix /transcribe.", "text-red-600");
      }
      return;
    }

    S.sysErrCount = 0;
    S.sysErrBackoffUntil = 0;

    const data = await res.json().catch(() => ({}));
    const raw0 = String(data.text || "");
    if (A.util.looksLikeWhisperHallucination(raw0)) return;

    const raw = A.util.collapseInternalRepeats(raw0);

    const cleaned = A.util.dedupeByTail(raw, {
      get value() { return S.lastSysTail; },
      set value(v) { S.lastSysTail = v; }
    });
    if (!cleaned) return;

    const now = Date.now();
    const text = A.util.normalize(cleaned);

    const trimmed0 = trimOverlap(S.lastSysPrinted, text);
    const trimmed = A.util.collapseInternalRepeats(trimmed0);
    if (!trimmed) return;

    // system double-print guard
    const k = A.util.canonKey(trimmed);
    if (k && k === S.lastSysTypeKey && (now - S.lastSysTypeAt) < 3500) return;
    S.lastSysTypeKey = k;
    S.lastSysTypeAt = now;

    S.lastSysPrinted = A.util.normalize((S.lastSysPrinted + " " + trimmed).trim());
    S.lastSysPrintedAt = now;

    A.transcript.addTypewriterSpeech(trimmed, C.SYS_TYPE_MS_PER_WORD, "interviewer");
  }

  /* -------------------------------------------------------------------------- */
  /* START/STOP HELPERS                                                          */
  /* -------------------------------------------------------------------------- */
  async function startMicStreamingForStartAll() {
    if (S.micMuted) return;
    try {
      const ms = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      S.micStream = ms;
      S.micTrack = ms.getAudioTracks()[0] || null;
      await startStreamingAsr("mic", ms);
    } catch {
      // if streaming mic fails, allow legacy fallback later
    }
  }

  /* -------------------------------------------------------------------------- */
  /* EXPORTS                                                                     */
  /* -------------------------------------------------------------------------- */
  A.audio.stopAsrSession = stopAsrSession;
  A.audio.startStreamingAsr = startStreamingAsr;

  A.audio.updateMicMuteUI = updateMicMuteUI;
  A.audio.setMicMuted = setMicMuted;

  A.audio.stopMicRecorderOnly = stopMicRecorderOnly;
  A.audio.enableMicRecorderFallback = enableMicRecorderFallback;

  A.audio.stopSystemAudioOnly = stopSystemAudioOnly;
  A.audio.enableSystemAudio = enableSystemAudio;

  // Used by core/actions
  A.audio.startMicStreamingForStartAll = startMicStreamingForStartAll;
  A.audio.stopMicPipelinesOnly = stopMicPipelinesOnly;

  // SR health placeholders (kept signatures to not break wiring)
  A.audio.micSrIsHealthy = () => false;
  A.audio.stopMicOnly = () => {};
})();
