// /api/user/profile.js
import { supabaseAdmin } from "../../_utils/supabaseClient.js";
import jwt from "@tsndr/cloudflare-worker-jwt";

export const config = { runtime: "nodejs" };

export default async function handler(req, res) {
  try {
    if (req.method !== "GET") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    // session token from frontend
    const token = req.headers.authorization?.replace("Bearer ", "");

    if (!token) {
      return res.status(401).json({ error: "Missing session token" });
    }

    // Decode JWT to extract user ID
    const decoded = await jwt.decode(token);
    const user_id = decoded?.sub;

    if (!user_id) {
      return res.status(401).json({ error: "Invalid token" });
    }

    // Admin user bypass
    const adminEmail = (process.env.ADMIN_EMAIL || "").toLowerCase().trim();
    if (decoded.email?.toLowerCase() === adminEmail) {
      return res.json({
        ok: true,
        user: {
          id: "admin",
          email: adminEmail,
          name: "Administrator",
          credits: 999999,
          approved: true,
          created_at: new Date().toISOString(),
          status: "admin",
          is_admin: true
        }
      });
    }

    const sb = supabaseAdmin();

    const { data, error } = await sb
      .from("user_profiles")
      .select("id, name, email, phone, approved, credits, created_at, status")
      .eq("id", user_id)
      .single();

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    return res.json({
      ok: true,
      user: {
        ...data,
        is_admin: false
      }
    });

  } catch (e) {
    return res
      .status(500)
      .json({ error: e.message || "Profile fetch crashed" });
  }
}
