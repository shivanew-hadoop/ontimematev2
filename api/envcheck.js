export const config = { runtime: "nodejs" };

export default function handler(req, res) {
  res.status(200).json({
    hasSUPABASE_URL: !!process.env.SUPABASE_URL,
    hasSUPABASE_ANON_KEY: !!process.env.SUPABASE_ANON_KEY,
    hasSUPABASE_SERVICE_ROLE_KEY: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
  });
}
