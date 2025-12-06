// /api/user/credits.js
import { supabaseAdmin } from "../../_utils/supabaseClient.js";
import jwt from "@tsndr/cloudflare-worker-jwt";

export const config = { runtime: "nodejs" };

export default async function handler(req, res) {
  try {
    const token = req.headers.authorization?.replace("Bearer ", "");
    if (!token) return res.status(401).json({ error: "Missing token" });

    const decoded = await jwt.decode(token);
    const user_id = decoded?.sub;

    const sb = supabaseAdmin();
    const { data, error } = await sb
      .from("user_profiles")
      .select("credits")
      .eq("id", user_id)
      .single();

    if (error) return res.status(400).json({ error: error.message });

    return res.json({ credits: data?.credits ?? 0 });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
