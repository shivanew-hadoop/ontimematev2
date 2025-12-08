export function requireAdmin(req) {
  const auth = req.headers.authorization || "";
  const token = auth.replace("Bearer ", "").trim();

  if (!token) return { ok: false, error: "Missing admin token" };

  // FIXED: Use ADMIN::
  if (!token.startsWith("ADMIN::"))
    return { ok: false, error: "Invalid admin token" };

  return { ok: true };
}
