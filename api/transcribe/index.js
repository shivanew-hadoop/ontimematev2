export const config = { runtime: "edge" };

import OpenAI from "openai";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export default async function handler(req) {
  const form = await req.formData();
  const file = form.get("file");

  const result = await client.audio.transcriptions.create({
    file,
    model: "gpt-4o-transcribe"
  });

  return new Response(JSON.stringify({ text: result.text }), { status: 200 });
}
