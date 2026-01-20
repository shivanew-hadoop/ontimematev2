// =============================================================
// DROP‑IN REALTIME BACKEND — /api/realtime/ws.js
// PURPOSE:
// - Parakeet‑style low‑latency streaming
// - Persistent OpenAI Realtime session per login
// - Load system + resume ONCE
// - Append ONLY user messages
// - Destroy context on logout / refresh
// =============================================================

import WebSocket from "ws";
import http from "http";
import OpenAI from "openai";
import { supabaseAdmin } from "../_utils/supabaseClient.js";

// -------------------------------------------------------------
// CONFIG
// -------------------------------------------------------------

const PORT = 3001; // can change if needed
const MODEL = "gpt-4o-realtime-preview";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// -------------------------------------------------------------
// IN‑MEMORY SESSION STORE
// NOTE: replace with Redis in prod
// -------------------------------------------------------------

const sessions = new Map();
// sessionId -> { clientWs, aiWs, userId }

// -------------------------------------------------------------
// HTTP SERVER (WS UPGRADE ONLY)
// -------------------------------------------------------------

const server = http.createServer();

const wss = new WebSocket.Server({ server });

// -------------------------------------------------------------
// MAIN WS HANDLER
// -------------------------------------------------------------

wss.on("connection", async (clientWs, req) => {
  try {
    // ---------------------------------------------------------
    // AUTH (Bearer token from query)
    // ws://host:3001?token=SUPABASE_JWT
    // ---------------------------------------------------------

    const url = new URL(req.url, "http://localhost");
    const token = url.searchParams.get("token");

    if (!token) {
      clientWs.close();
      return;
    }

    // Validate Supabase session
    const { data, error } = await supabaseAdmin().auth.getUser(token);
    if (error || !data?.user) {
      clientWs.close();
      return;
    }

    const userId = data.user.id;

    // ---------------------------------------------------------
    // OPENAI REALTIME WS
    // ---------------------------------------------------------

    const aiWs = new WebSocket(
      `wss://api.openai.com/v1/realtime?model=${MODEL}`,
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          "OpenAI-Beta": "realtime=v1"
        }
      }
    );

    sessions.set(userId, { clientWs, aiWs, userId });

    // ---------------------------------------------------------
    // ON OPENAI SESSION READY — LOAD CONTEXT ONCE
    // ---------------------------------------------------------

    aiWs.on("open", () => {
      aiWs.send(
        JSON.stringify({
          type: "session.update",
          session: {
            instructions: `You are answering live technical interview questions.
Speak like a senior engineer.
Be direct, confident, and practical.
Do not use academic or coaching tone.`,
            temperature: 0.2
          }
        })
      );
    });

    // ---------------------------------------------------------
    // STREAM TOKENS → CLIENT
    // ---------------------------------------------------------

    aiWs.on("message", data => {
      const msg = JSON.parse(data.toString());

      if (msg.type === "response.output_text.delta") {
        clientWs.send(
          JSON.stringify({ type: "token", value: msg.delta })
        );
      }

      if (msg.type === "response.completed") {
        clientWs.send(JSON.stringify({ type: "done" }));
      }
    });

    // ---------------------------------------------------------
    // CLIENT → OPENAI (USER INPUT ONLY)
    // ---------------------------------------------------------

    clientWs.on("message", raw => {
      const msg = JSON.parse(raw.toString());

      if (msg.type === "user_input") {
        aiWs.send(
          JSON.stringify({
            type: "input_text",
            text: msg.text
          })
        );

        aiWs.send(JSON.stringify({ type: "response.create" }));
      }
    });

    // ---------------------------------------------------------
    // CLEANUP ON CLOSE (LOGOUT / REFRESH)
    // ---------------------------------------------------------

    clientWs.on("close", () => {
      try { aiWs.close(); } catch {}
      sessions.delete(userId);
    });

  } catch (e) {
    try { clientWs.close(); } catch {}
  }
});

// -------------------------------------------------------------
// START SERVER
// -------------------------------------------------------------

server.listen(PORT, () => {
  console.log(`Realtime WS running on ws://localhost:${PORT}`);
});
