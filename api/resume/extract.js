export const config = { runtime: "edge" };

import OpenAI from "openai";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export default async function handler(req) {
  const form = await req.formData();
  const file = form.get("file");

  const result = await client.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: "Extract useful resume text." }],
    file
  });

  return new Response(JSON.stringify({ text: result.choices[0].message.content }));
}
