export const config = { runtime: "edge" };

export default async function handler(req) {
  const form = await req.formData();
  const file = form.get("file");

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "user",
          content: [
            { type: "input_text", text: "Extract resume content cleanly." },
            { type: "input_file", file_id: file }
          ]
        }
      ]
    })
  });

  const data = await response.json();

  return new Response(JSON.stringify({ text: data.choices[0].message }), {
    status: 200
  });
}
