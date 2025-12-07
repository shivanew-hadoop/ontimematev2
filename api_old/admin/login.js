export const config = { runtime: "nodejs" };

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") 
      return res.status(405).json({ error: "Method not allowed" });

    const { email, password } = req.body || {};

    const adminEmail = (process.env.ADMIN_EMAIL || "").toLowerCase().trim();
    const adminPass  = (process.env.ADMIN_PASSWORD || "").trim();

    if (!email || !password)
      return res.status(400).json({ error: "Missing email or password" });

    // Admin authentication
    if (email.toLowerCase().trim() !== adminEmail || password !== adminPass) {
      return res.status(401).json({ error: "Invalid admin credentials" });
    }

    const token = "ADMIN_" + Math.random().toString(36).slice(2);

    return res.json({
      ok: true,
      session: {
        is_admin: true,
        user: { id: "admin", email: adminEmail },
        token
      }
    });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
