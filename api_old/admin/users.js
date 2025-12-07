// /api/admin/users.js
import { supabaseAdmin } from "../../_utils/supabaseClient.js";
import { requireAdmin } from "../../_utils/adminAuth.js";

export const config = { runtime: "nodejs" };

export default async function handler(req, res) {
  const gate = requireAdmin(req);
  if (!gate.ok) return res.status(401).json({ error: gate.error });

  const sb = supabaseAdmin();

  const { data, error } = await sb
    .from("user_profiles")
    .select("id, name, email, phone, approved, credits, created_at")
    .order("created_at", { ascending: false });

  if (error) return res.status(400).json({ error: error.message });

  return res.json({ users: data });
}
