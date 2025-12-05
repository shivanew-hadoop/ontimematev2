export const config = { runtime: "edge" };

import { supabaseAdmin } from "../../_utils/supabaseClient.js";

export default async function handler(req) {
  const token = req.headers.get("authorization");

  if (!token?.includes("ADMIN_STATIC_TOKEN")) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 403 });
  }

  const body = await req.json();
  const { id } = body;

  const supabase = supabaseAdmin();

  await supabase
    .from("user_profiles")
    .update({ status: "approved" })
    .eq("id", id);

  return new Response(JSON.stringify({ success: true }), { status: 200 });
}
