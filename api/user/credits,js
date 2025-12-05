export const config = { runtime: "edge" };

import { supabaseAdmin } from "../../_utils/supabaseClient.js";

export default async function handler(req) {
  const { user_id } = await req.json();

  const supabase = supabaseAdmin();

  // subtract 1 credit
  await supabase.rpc("decrement_credit", { uid: user_id });

  const { data } = await supabase
    .from("user_profiles")
    .select("credits")
    .eq("id", user_id)
    .single();

  return new Response(JSON.stringify({ credits: data.credits }), { status: 200 });
}
