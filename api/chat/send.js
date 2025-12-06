// /api/chat/send.js
import OpenAI from "openai";
import jwt from "@tsndr/cloudflare-worker-jwt";

export const config = { runtime: "nodejs" };

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

export default async function handler(req, res) {
  try {
    if (req.method !== "POST")
      return res.status(405).json({ error: "Method not allowed" });

    // JWT user session
    const token = req.headers.authorization?.replace("Bearer ", "");
    if (!token) return res.status(401).json({ error: "Missing session" });

    const decoded = await jwt.decode(token);
    if (!decoded?.sub) return res.status(401).json({ error: "Invalid session" });

    // Payload from frontend
    const { prompt, instructions, resume } = req.body || {};

    if (!prompt) return res.status(400).json({ error: "Missing prompt" });

    // Combine custom instructions + resume
    const systemPrompt =
      (instructions || "") +
      (resume ? `\n\n[USER RESUME]\n${resume}` : "");

    // SSE headers
    res.writeHead(200, {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no"
    });

    const stream = await client.chat.completions.create({
      model: "gpt-4o-mini",
      stream: true,
      messages: [
        { role: "system", content: systemPrompt || "You are a helpful AI assistant." },
        { role: "user", content: prompt }
      ]
    });

    for await (const chunk of stream) {
      const text = chunk.choices?.[0]?.delta?.content || "";
      if (text) res.write(text);
    }

    res.end();
  } catch (e) {
    console.error("Chat error:", e);
    try { res.end(); } catch {}
  }
}
