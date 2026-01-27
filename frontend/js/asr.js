/* ==========================================================================
 * asr.js — realtime ASR finalize behavior (sys completed -> typewriter)
 * Fixes:
 *  - sys-final transcript after stopping system audio rendered one word at a time
 * ========================================================================== */

(function () {
  window.ANU = window.ANU || {};
  const ANU = window.ANU;

  const t = () => ANU.transcript;
  const c = () => ANU.core;

  // Expected to be provided by your core/app modules
  const cfg = {
    REALTIME_INTENT_URL: "wss://api.openai.com/v1/realtime?intent=transcription",
    REALTIME_ASR_MODEL: "gpt-4o-mini-transcribe",
    ASR_SEND_EVERY_MS: 40,
    ASR_TARGET_RATE: 24000,
    SYS_TYPE_MS_PER_WORD: 18,

    // Your existing prompt (kept identical)
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
    micAsr: null,
    sysAsr: null
  };

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
    // This expected your existing endpoint and session handling.
    // It delegated to core if you already had it there.
    if (c()?.getRealtimeClientSecretCached) return c().getRealtimeClientSecretCached();
    throw new Error("Missing getRealtimeClientSecretCached in ANU.core");
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
        prompt:
          cfg.TRANSCRIBE_PROMPT +
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
            format: { type: "audio/pcm", rate: cfg.ASR_TARGET_RATE },
            transcription: {
              model: cfg.REALTIME_ASR_MODEL,
              language: "en-IN",
              prompt:
                cfg.TRANSCRIBE_PROMPT +
                " Speaker has an Indian English accent. " +
                "Use Indian pronunciation and spelling."
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
    const s = which === "mic" ? state.micAsr : state.sysAsr;
    if (!s) return;

    const now = Date.now();
    if (!s.itemText[itemId]) s.itemText[itemId] = "";
    s.itemText[itemId] += String(deltaText || "");

    const cur = c().normalize(s.itemText[itemId]);
    if (!cur) return;

    const role = which === "sys" ? "interviewer" : "candidate";

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

  // ---------------------------
  // IMPACTED: finalize behavior
  // ---------------------------
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

    const final = c().normalize(transcript || draftText);
    if (!final) return;

    if (which === "sys") {
      // FIX: sys-final after stopping share audio rendered one word at a time
      t().addFinalSpeechTypewriter(final, "interviewer", cfg.SYS_TYPE_MS_PER_WORD);
    } else {
      t().addFinalSpeech(final, "candidate");
    }
  }

  async function startStreamingAsr(which, mediaStream) {
    if (!ANU.state?.isRunning) return false;

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

    const asrState = {
      ws, ctx, src, proc, gain, queue,
      sendTimer: null,
      itemText: {},
      itemEntry: {},
      sawConfigError: false
    };

    if (which === "mic") state.micAsr = asrState;
    else state.sysAsr = asrState;

    proc.onaudioprocess = (e) => {
      if (!ANU.state?.isRunning) return;
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

      asrState.sendTimer = setInterval(() => {
        if (!ANU.state?.isRunning) return;
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
    };

    ws.onmessage = (msg) => {
      let ev = null;
      try { ev = JSON.parse(msg.data); } catch { return; }
      if (!ev?.type) return;

      if (ev.type === "error") {
        const m = String(ev?.error?.message || ev?.message || "");
        if (!asrState.sawConfigError && m.toLowerCase().includes("transcription_session.update")) {
          asrState.sawConfigError = true;
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

  ANU.asr = {
    state,
    cfg,
    startStreamingAsr,
    stopAsrSession
  };
})();
