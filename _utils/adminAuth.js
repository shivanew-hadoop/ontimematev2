// api/_utils/adminAuth.js
export function requireAdmin(req) {
  const auth = req.headers.authorization || "";
  const token = auth.replace("Bearer ", "").trim();

  if (!token) return { ok: false, error: "Missing admin token" };
  if (!token.startsWith("ADMIN_")) return { ok: false, error: "Invalid admin token" };

  return { ok: true };
}
