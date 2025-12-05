export const config = { runtime: "edge" };

import { supabaseAdmin } from "../../_utils/supabaseClient.js";

export default async function handler(req) {
  const token = req.headers.get("authorization");

  if (!token?.includes("ADMIN_STATIC_TOKEN")) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 403 });
  }

  const supabase = supabaseAdmin();

  const { data } = await supabase
    .from("user_profiles")
    .select("*")
    .order("created_at", { ascending: false });

  return new Response(JSON.stringify(data), { status: 200 });
}
