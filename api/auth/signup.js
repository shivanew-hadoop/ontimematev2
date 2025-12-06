import { supabaseAnon, supabaseAdmin } from "../../_utils/supabaseClient.js";

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

    const { email, password, name, phone } = req.body || {};
    if (!email || !password || !name || !phone) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const origin = req.headers.origin || "https://thoughtmatters-ai.vercel.app";

    const sb = supabaseAnon();
    const { data, error } = await sb.auth.signUp({
      email,
      password,
      options: {
        data: { name, phone },
        emailRedirectTo: `${origin}/auth?tab=login`
      }
    });

    if (error) return res.status(400).json({ error: error.message });

    const user = data?.user || null;
    const session = data?.session || null;

    // create user_profiles row (service role)
    if (user?.id) {
      const admin = supabaseAdmin();
      const { error: upsertErr } = await admin
        .from("user_profiles")
        .upsert(
          {
            id: user.id,
            name,
            phone,
            credits: 0,
            approved: false
          },
          { onConflict: "id" }
        );

      if (upsertErr) {
        // still allow signup; but return error to fix schema/policy
        return res.status(500).json({ error: `user_profiles upsert failed: ${upsertErr.message}` });
      }
    }

    return res.status(200).json({ user, session });
  } catch (e) {
    return res.status(500).json({ error: e.message || "Signup crashed" });
  }
}
