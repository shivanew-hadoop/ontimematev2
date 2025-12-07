// /api/admin/approve.js
import { supabaseAdmin } from "../_utils/supabaseClient.js";
import { requireAdmin } from "../_utils/adminAuth.js";

export const config = { runtime: "nodejs" };

export default async function handler(req, res) {
  if (req.method !== "POST")
    return res.status(405).json({ error: "Method not allowed" });

  const gate = requireAdmin(req);
  if (!gate.ok) return res.status(401).json({ error: gate.error });

  const { user_id, approved } = req.body || {};
  if (!user_id) return res.status(400).json({ error: "Missing user_id" });

  const sb = supabaseAdmin();
  const { data, error } = await sb
    .from("user_profiles")
    .update({ approved })
    .eq("id", user_id)
    .select()
    .single();

  if (error) return res.status(400).json({ error: error.message });

  res.json({ ok: true, user: data });
}
