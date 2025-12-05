export const config = { runtime: "edge" };

import { supabaseAdmin } from "../_utils/supabaseClient.js";

export default async function handler(req) {
  const body = await req.json();
  const { email, password, name, phone } = body;

  const supabase = supabaseAdmin();

  // 1. Create user in auth.users
  const { data: signUpData, error: signUpErr } = await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true
  });

  if (signUpErr) {
    return new Response(JSON.stringify({ error: signUpErr.message }), { status: 400 });
  }

  const userId = signUpData.user.id;

  // 2. Insert into user_profiles
  const { error: profileErr } = await supabase
    .from("user_profiles")
    .insert({
      id: userId,
      name,
      phone,
      status: "pending",
      credits: 100   // give default credits if needed
    });

  if (profileErr) {
    return new Response(
      JSON.stringify({ error: profileErr.message }),
      { status: 400 }
    );
  }

  return new Response(JSON.stringify({ success: true }), { status: 200 });
}
