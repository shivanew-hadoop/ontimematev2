import { supabaseAdmin } from "../../_utils/supabaseClient.js";

export const config = { runtime: "nodejs" };

export default async function handler(req, res) {
  try {
    if (req.method !== "POST")
      return res.status(405).json({ error: "Method not allowed" });

    const { user_id, credits } = req.body || {};

    if (!user_id || credits < 0)
      return res.status(400).json({ error: "user_id and credits required" });

    const sb = supabaseAdmin();

    const { data, error } = await sb
      .from("user_profiles")
      .update({ credits })
      .eq("id", user_id)
      .select()
      .single();

    if (error) return res.status(400).json({ error: error.message });

    return res.json({ ok: true, credits: data.credits });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
