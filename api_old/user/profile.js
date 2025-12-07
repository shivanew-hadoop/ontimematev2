// /api/user/profile.js
import { supabaseAdmin } from "../../_utils/supabaseClient.js";
import jwt from "@tsndr/cloudflare-worker-jwt";

export const config = { runtime: "nodejs" };

export default async function handler(req, res) {
  try {
    if (req.method !== "GET") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    const token = req.headers.authorization?.replace("Bearer ", "");
    if (!token) {
      return res.status(401).json({ error: "Missing session token" });
    }

    const decoded = await jwt.decode(token);
    if (!decoded) return res.status(401).json({ error: "Invalid token" });

    const user_id = decoded.sub;
    const user_email = (decoded.email || "").toLowerCase();

    // ADMIN short-circuit
    const adminEmail = (process.env.ADMIN_EMAIL || "").toLowerCase();
    if (user_email === adminEmail) {
      return res.json({
        ok: true,
        user: {
          id: "admin",
          email: adminEmail,
          name: "Administrator",
          credits: 999999,
          approved: true,
          is_admin: true,
          created_at: new Date().toISOString()
        }
      });
    }

    // Normal user
    const sb = supabaseAdmin();

    const { data, error } = await sb
      .from("user_profiles")
      .select("*")
      .eq("id", user_id)
      .single();

    if (error) return res.status(400).json({ error: error.message });

    if (!data.approved) {
      return res.status(403).json({
        error: "Account not yet approved by admin",
        approved: false
      });
    }

    return res.json({
      ok: true,
      user: {
        ...data,
        is_admin: false
      }
    });

  } catch (e) {
    return res.status(500).json({ error: e.message || "Profile fetch failed" });
  }
}
