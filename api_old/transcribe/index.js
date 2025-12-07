// /api/transcribe/index.js
import OpenAI from "openai";
export const config = { runtime: "nodejs" };

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

export default async function handler(req, res) {
  try {
    if (req.method !== "POST")
      return res.status(405).json({ error: "Method not allowed" });

    const form = await req.formData();
    const file = form.get("audio");

    if (!file) return res.status(400).json({ error: "Missing audio" });

    const result = await client.audio.transcriptions.create({
      file,
      model: "gpt-4o-transcribe",
      response_format: "json"
    });

    return res.json({ text: result.text || "" });
  } catch (e) {
    return res.status(500).json({
      error: "Transcription failed",
      details: e.message
    });
  }
}
