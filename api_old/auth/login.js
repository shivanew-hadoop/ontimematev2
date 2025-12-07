import { supabaseAnon } from "../../_utils/supabaseClient.js";

export default async function handler(req, res) {
  const { email, password } = req.body;

  const adminEmail = process.env.ADMIN_EMAIL.toLowerCase();
  const adminPass = process.env.ADMIN_PASSWORD;

  if (email.toLowerCase() === adminEmail && password === adminPass) {
    return res.json({
      ok: true,
      session: {
        is_admin: true,
        token: "ADMIN_" + Math.random().toString(36),
        user: { id: "admin", email }
      }
    });
  }

  const sb = supabaseAnon();
  const { data, error } = await sb.auth.signInWithPassword({ email, password });

  if (error) return res.status(401).json({ error: error.message });

  return res.json({ ok: true, session: data.session });
}
