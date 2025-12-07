// /api/user/deductSecond.js
import { supabaseAdmin } from "../../_utils/supabaseClient.js";
import jwt from "@tsndr/cloudflare-worker-jwt";

export const config = { runtime: "nodejs" };

// Ping every 1 sec
export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    const token = req.headers.authorization?.replace("Bearer ", "");
    if (!token) return res.status(401).json({ error: "No token" });

    const decoded = await jwt.decode(token);
    const user_id = decoded?.sub;
    const user_email = (decoded?.email || "").toLowerCase();

    const adminEmail = (process.env.ADMIN_EMAIL || "").toLowerCase();
    if (user_email === adminEmail) {
      // Admin unlimited credits
      return res.json({ credits: 999999 });
    }

    const sb = supabaseAdmin();

    // Fetch user current credits
    const { data: row, error: e1 } = await sb
      .from("user_profiles")
      .select("credits, approved")
      .eq("id", user_id)
      .single();

    if (e1) return res.status(400).json({ error: e1.message });

    if (!row.approved) {
      return res.status(403).json({ error: "Not approved" });
    }

    // If no credits left
    if ((row.credits || 0) <= 0) {
      return res.json({ credits: 0 });
    }

    let newCredits = Math.max(0, row.credits - 1);

    const { data, error: e2 } = await sb
      .from("user_profiles")
      .update({ credits: newCredits })
      .eq("id", user_id)
      .select()
      .single();

    if (e2) return res.status(400).json({ error: e2.message });

    return res.json({ credits: newCredits });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
