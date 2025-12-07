import { supabaseAnon } from "../../_utils/supabaseClient.js";

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

    const { email } = req.body || {};
    if (!email) return res.status(400).json({ error: "Missing email" });

    const origin = req.headers.origin || "https://thoughtmatters-ai.vercel.app";

    const sb = supabaseAnon();
    const { error } = await sb.auth.resetPasswordForEmail(email, {
      redirectTo: `${origin}/auth?tab=login`
    });

    if (error) return res.status(400).json({ error: error.message });

    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: e.message || "Forgot password crashed" });
  }
}
