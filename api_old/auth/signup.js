import { supabaseAnon, supabaseAdmin } from "../../_utils/supabaseClient.js";

export default async function handler(req, res) {
  const { name, phone, email, password } = req.body;

  const sb = supabaseAnon();

  const { data, error } = await sb.auth.signUp({
    email,
    password,
    options: {
      emailRedirectTo: "https://thoughtmatters-ai.vercel.app/auth"
    }
  });

  if (error) return res.status(400).json({ error: error.message });

  const admin = supabaseAdmin();
  await admin.from("user_profiles").insert({
    id: data.user.id,
    name,
    phone,
    email,
    approved: false,
    credits: 0
  });

  return res.json({
    ok: true,
    message: "Account created. Please verify email and wait for admin approval."
  });
}
