// /api/chat/reset.js
export const config = { runtime: "nodejs" };

export default async function handler(req, res) {
  try {
    if (req.method !== "POST")
      return res.status(405).json({ error: "Method not allowed" });

    // No DB interaction. Simply reset session memory.
    // Frontend clears timeline, this is just API placeholder.
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: e.message || "Reset failed" });
  }
}
