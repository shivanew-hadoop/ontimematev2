export const config = { runtime: "edge" };

import { supabaseAdmin } from "../../_utils/supabaseClient.js";

/**
 * @param {Request} req
 */
export default async function handler(req) {
  try {
    const body = await req.json();
    const { user_id } = body;

    const supabase = supabaseAdmin();

    const { data, error } = await supabase
      .from("user_profiles")
      .select("*")
      .eq("id", user_id)
      .single();

    return new Response(JSON.stringify({ data }), { status: 200 });

  } catch (e) {
    return new Response(
      JSON.stringify({ error: "Unexpected error", details: e.message }),
      { status: 500 }
    );
  }
}
