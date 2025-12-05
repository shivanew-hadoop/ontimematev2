export const config = { runtime: "edge" };

import { supabaseAdmin } from "../_utils/supabaseClient.js";

export default async function handler(req) {
  const body = await req.json();
  const { email, password } = body;

  // Admin login
  if (email === process.env.ADMIN_EMAIL && password === process.env.ADMIN_PASSWORD) {
    return new Response(JSON.stringify({
      admin: true,
      token: "admin-static-token"
    }), { status: 200 });
  }

  const supabase = supabaseAdmin();

  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password
  });

  if (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 400 });
  }

  return new Response(JSON.stringify({
    admin: false,
    session: data.session
  }), { status: 200 });
}
