import { createAdminToken } from "../_utils/adminAuth.js";

export const config = { runtime: "nodejs" };

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

    const { email, password } = req.body || {};
    const adminEmail = process.env.ADMIN_EMAIL;
    const adminPassword = process.env.ADMIN_PASSWORD;

    if (!adminEmail || !adminPassword) {
      return res.status(500).json({ error: "Admin env not configured" });
    }

    if (email !== adminEmail || password !== adminPassword) {
      return res.status(401).json({ error: "Invalid admin credentials" });
    }

    const token = createAdminToken();
    return res.json({ ok: true, token, adminEmail });
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
}
