export const config = { runtime: "edge" };

export default async function handler(req) {
  const form = await req.formData();
  const file = form.get("file");

  const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
    },
    body: (() => {
      const f = new FormData();
      f.append("file", file);
      f.append("model", "gpt-4o-transcribe");
      return f;
    })()
  });

  const data = await response.json();
  return new Response(JSON.stringify({ text: data.text }), { status: 200 });
}
