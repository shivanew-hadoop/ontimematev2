import { supabaseAdmin } from "../_utils/supabaseClient.js";
import { requireAdmin } from "../_utils/adminAuth.js";

export const config = { runtime: "nodejs" };

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

    const gate = requireAdmin(req);
    if (!gate.ok) return res.status(401).json({ error: gate.error });

    const { user_id, delta } = req.body || {};
    const n = Number(delta);

    if (!user_id || !Number.isFinite(n)) {
      return res.status(400).json({ error: "user_id and delta(number) required" });
    }

    const sb = supabaseAdmin();

    const { data: row, error: e1 } = await sb
      .from("user_profiles")
      .select("credits")
      .eq("user_id", user_id)
      .single();

    if (e1) return res.status(400).json({ error: e1.message });

    const newCredits = Math.max(0, (row?.credits ?? 0) + n);

    const { data, error: e2 } = await sb
      .from("user_profiles")
      .update({ credits: newCredits })
      .eq("user_id", user_id)
      .select()
      .single();

    if (e2) return res.status(400).json({ error: e2.message });

    return res.json({ ok: true, credits: data.credits, user: data });
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
}
