// /api/admin/credits.js
import { supabaseAdmin } from "../_utils/supabaseClient.js";
import { requireAdmin } from "../_utils/adminAuth.js";

export const config = { runtime: "nodejs" };

export default async function handler(req, res) {
  if (req.method !== "POST")
    return res.status(405).json({ error: "Method not allowed" });

  const gate = requireAdmin(req);
  if (!gate.ok) return res.status(401).json({ error: gate.error });

  const { user_id, delta } = req.body || {};

  const sb = supabaseAdmin();

  const { data: row, error: e1 } = await sb
    .from("user_profiles")
    .select("credits")
    .eq("id", user_id)
    .single();

  if (e1) return res.status(400).json({ error: e1.message });

  const newCredits = Math.max(0, (row.credits || 0) + Number(delta));

  const { data, error: e2 } = await sb
    .from("user_profiles")
    .update({ credits: newCredits })
    .eq("id", user_id)
    .select()
    .single();

  if (e2) return res.status(400).json({ error: e2.message });

  res.json({ ok: true, credits: data.credits });
}
