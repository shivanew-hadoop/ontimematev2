import crypto from "crypto";

function b64url(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function b64urlJson(obj) {
  return b64url(JSON.stringify(obj));
}

function sign(data, secret) {
  return b64url(
    crypto.createHmac("sha256", secret).update(data).digest()
  );
}

export function createAdminToken() {
  const secret = process.env.ADMIN_JWT_SECRET;
  if (!secret) throw new Error("Missing ADMIN_JWT_SECRET");

  const header = { alg: "HS256", typ: "JWT" };
  const payload = {
    role: "admin",
    exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60, // 12h
  };

  const h = b64urlJson(header);
  const p = b64urlJson(payload);
  const s = sign(`${h}.${p}`, secret);

  return `${h}.${p}.${s}`;
}

export function requireAdmin(req) {
  const secret = process.env.ADMIN_JWT_SECRET;
  if (!secret) throw new Error("Missing ADMIN_JWT_SECRET");

  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) return { ok: false, error: "Missing admin token" };

  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, error: "Invalid token" };

  const [h, p, s] = parts;
  const expected = sign(`${h}.${p}`, secret);
  if (expected !== s) return { ok: false, error: "Bad token signature" };

  const payload = JSON.parse(Buffer.from(p.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
  if (!payload?.exp || payload.exp < Math.floor(Date.now() / 1000)) {
    return { ok: false, error: "Token expired" };
  }
  if (payload.role !== "admin") return { ok: false, error: "Not admin" };

  return { ok: true };
}
