import { supabaseAnon } from "../../_utils/supabaseClient.js";

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: "Missing email/password" });

    const sb = supabaseAnon();
    const { data, error } = await sb.auth.signInWithPassword({ email, password });

    if (error) return res.status(401).json({ error: error.message });

    return res.status(200).json({ user: data.user, session: data.session });
  } catch (e) {
    return res.status(500).json({ error: e.message || "Login crashed" });
  }
}
