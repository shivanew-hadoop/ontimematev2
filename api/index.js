import Busboy from "busboy/lib/types/index.js";
import OpenAI from "openai";
import { supabaseAnon, supabaseAdmin } from "../_utils/supabaseClient.js";
import { requireAdmin } from "../_utils/adminAuth.js";

export const config = { runtime: "nodejs" };


const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// -------------------------
// helpers
// -------------------------
function setCors(req, res) {
  const origin = req.headers.origin || "*";
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function readMultipart(req) {
  return new Promise((resolve, reject) => {
    const bb = Busboy({ headers: req.headers });
    const fields = {};
    let file = null;

    bb.on("field", (name, val) => (fields[name] = val));

    bb.on("file", (name, stream, info) => {
      const chunks = [];
      stream.on("data", (d) => chunks.push(d));
      stream.on("end", () => {
        file = {
          field: name,
          filename: info.filename,
          mime: info.mimeType,
          buffer: Buffer.concat(chunks)
        };
      });
    });

    bb.on("finish", () => resolve({ fields, file }));
    bb.on("error", reject);
    req.pipe(bb);
  });
}

function originFromReq(req) {
  // Vercel gives host + proto headers
  const proto = req.headers["x-forwarded-proto"] || "https";
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  if (!host) return process.env.PUBLIC_SITE_URL || "https://thoughtmatters-ai.vercel.app";
  return `${proto}://${host}`;
}

function ymd(d) {
  const dt = new Date(d);
  const yyyy = dt.getFullYear();
  const mm = String(dt.getMonth() + 1).padStart(2, "0");
  const dd = String(dt.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

async function getUserFromBearer(req) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) return { ok: false, error: "Missing token" };

  // Admin token is handled separately
  if (token.startsWith("ADMIN::")) return { ok: false, error: "Admin token not valid for user endpoints" };

  const sb = supabaseAnon();
  const { data, error } = await sb.auth.getUser(token);
  if (error) return { ok: false, error: error.message };
  const user = data?.user;
  if (!user) return { ok: false, error: "Invalid session" };
  return { ok: true, user, access_token: token };
}

// -------------------------
// main router
// -------------------------
export default async function handler(req, res) {
  try {
    setCors(req, res);

    if (req.method === "OPTIONS") return res.status(200).end();

    const url = new URL(req.url, "http://localhost");
    const path = (url.searchParams.get("path") || "").replace(/^\/+/, "");

    // ---------------
    // health/env
    // ---------------
    if (req.method === "GET" && (path === "" || path === "healthcheck")) {
      return res.status(200).json({ ok: true, service: "api", time: new Date().toISOString() });
    }

    if (req.method === "GET" && path === "envcheck") {
      return res.status(200).json({
        hasSUPABASE_URL: !!process.env.SUPABASE_URL,
        hasSUPABASE_ANON_KEY: !!process.env.SUPABASE_ANON_KEY,
        hasSUPABASE_SERVICE_ROLE_KEY: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
        hasOPENAI_API_KEY: !!process.env.OPENAI_API_KEY,
        hasADMIN_EMAIL: !!process.env.ADMIN_EMAIL,
        hasADMIN_PASSWORD: !!process.env.ADMIN_PASSWORD
      });
    }

    // -------------------------
    // AUTH: signup/login/logout/forgot
    // -------------------------
    if (path === "auth/signup") {
      if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

      const body = await readJson(req);
      const { name, phone, email, password } = body || {};
      if (!name || !email || !password) return res.status(400).json({ error: "Missing required fields" });

      const sb = supabaseAnon();
      const redirectTo = `${originFromReq(req)}/auth?tab=login`;

      const { data, error } = await sb.auth.signUp({
        email,
        password,
        options: { emailRedirectTo: redirectTo }
      });
      if (error) return res.status(400).json({ error: error.message });

      const userId = data?.user?.id;
      if (!userId) return res.status(400).json({ error: "Signup failed (no user id)" });

      const admin = supabaseAdmin();
      const { error: insertErr } = await admin.from("user_profiles").insert({
        id: userId,
        name,
        phone: phone || "",
        email,
        approved: false,
        credits: 0,
        created_at: new Date().toISOString()
      });

      if (insertErr) return res.status(400).json({ error: insertErr.message });

      return res.status(200).json({
        ok: true,
        message: "Account created. Check your email to verify. After verification, wait for admin approval."
      });
    }

    if (path === "auth/login") {
      if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
      const body = await readJson(req);
      const { email, password } = body || {};
      if (!email || !password) return res.status(400).json({ error: "Missing email/password" });

      // ✅ admin login using env creds (no Supabase)
      const adminEmail = (process.env.ADMIN_EMAIL || "").toLowerCase().trim();
      const adminPass = (process.env.ADMIN_PASSWORD || "").trim();
      if (email.toLowerCase().trim() === adminEmail && password === adminPass) {
        const token = `ADMIN::${adminEmail}::${Math.random().toString(36).slice(2)}`;
        return res.status(200).json({
          ok: true,
          session: {
            is_admin: true,
            token,
            user: { id: "admin", email: adminEmail }
          }
        });
      }

      // normal user
      const sb = supabaseAnon();
      const { data, error } = await sb.auth.signInWithPassword({ email, password });
      if (error) return res.status(401).json({ error: error.message });

      const access_token = data?.session?.access_token;
      const user = data?.user;

      // enforce email verification
      if (!user?.email_confirmed_at) {
        return res.status(403).json({ error: "Email not verified. Please verify using the email link first." });
      }

      // enforce approval
      const admin = supabaseAdmin();
      const { data: prof, error: pErr } = await admin
        .from("user_profiles")
        .select("approved")
        .eq("id", user.id)
        .single();

      if (pErr) return res.status(400).json({ error: pErr.message });
      if (!prof?.approved) return res.status(403).json({ error: "Not approved yet. Please wait for admin approval." });

      return res.status(200).json({
        ok: true,
        user,
        session: {
          is_admin: false,
          access_token,
          user: { id: user.id, email: user.email }
        }
      });
    }

    if (path === "auth/logout") {
      // frontend just clears localStorage; keep for compatibility
      return res.status(200).json({ ok: true });
    }

    if (path === "auth/forgot") {
      if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
      const body = await readJson(req);
      const { email } = body || {};
      if (!email) return res.status(400).json({ error: "Missing email" });

      const sb = supabaseAnon();
      const redirectTo = `${originFromReq(req)}/auth?tab=login`;
      const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo });
      if (error) return res.status(400).json({ error: error.message });

      return res.status(200).json({ ok: true });
    }

    // -------------------------
    // USER: profile + credits + credit per second
    // -------------------------
    if (path === "user/profile") {
      if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

      const gate = await getUserFromBearer(req);
      if (!gate.ok) return res.status(401).json({ error: gate.error });

      const admin = supabaseAdmin();
      const { data, error } = await admin
        .from("user_profiles")
        .select("id,name,email,phone,approved,credits,created_at")
        .eq("id", gate.user.id)
        .single();

      if (error) return res.status(400).json({ error: error.message });

      return res.status(200).json({
        ok: true,
        user: {
          ...data,
          is_admin: false,
          created_ymd: ymd(data.created_at)
        }
      });
    }

    if (path === "user/credits/set") {
      if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

      const gate = requireAdmin(req);
      if (!gate.ok) return res.status(401).json({ error: gate.error });

      const body = await readJson(req);
      const { user_id, credits } = body || {};
      const n = Number(credits);

      if (!user_id || !Number.isFinite(n)) return res.status(400).json({ error: "user_id and credits(number) required" });

      const sb = supabaseAdmin();
      const { data, error } = await sb
        .from("user_profiles")
        .update({ credits: Math.max(0, Math.floor(n)) })
        .eq("id", user_id)
        .select()
        .single();

      if (error) return res.status(400).json({ error: error.message });
      return res.status(200).json({ ok: true, user: data });
    }

    if (path === "user/credits/deductSecond") {
      if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

      const gate = await getUserFromBearer(req);
      if (!gate.ok) return res.status(401).json({ error: gate.error });

      const sb = supabaseAdmin();

      const { data: row, error: e1 } = await sb
        .from("user_profiles")
        .select("credits")
        .eq("id", gate.user.id)
        .single();

      if (e1) return res.status(400).json({ error: e1.message });

      const current = Number(row?.credits ?? 0);
      const next = Math.max(0, current - 1);

      const { data, error: e2 } = await sb
        .from("user_profiles")
        .update({ credits: next })
        .eq("id", gate.user.id)
        .select("credits")
        .single();

      if (e2) return res.status(400).json({ error: e2.message });

      return res.status(200).json({ ok: true, credits: data.credits });
    }

    // -------------------------
    // ADMIN: users list + approve + add credits
    // -------------------------
    if (path === "admin/users") {
      if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

      const gate = requireAdmin(req);
      if (!gate.ok) return res.status(401).json({ error: gate.error });

      const sb = supabaseAdmin();
      const { data, error } = await sb
        .from("user_profiles")
        .select("id,name,email,phone,approved,credits,created_at")
        .order("created_at", { ascending: false });

      if (error) return res.status(400).json({ error: error.message });

      return res.status(200).json({ users: data });
    }

    if (path === "admin/approve") {
      if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

      const gate = requireAdmin(req);
      if (!gate.ok) return res.status(401).json({ error: gate.error });

      const body = await readJson(req);
      const { user_id, approved } = body || {};
      if (!user_id || typeof approved !== "boolean") return res.status(400).json({ error: "user_id and approved(boolean) required" });

      const sb = supabaseAdmin();
      const { data, error } = await sb
        .from("user_profiles")
        .update({ approved })
        .eq("id", user_id)
        .select()
        .single();

      if (error) return res.status(400).json({ error: error.message });
      return res.status(200).json({ ok: true, user: data });
    }

    if (path === "admin/credits") {
      if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

      const gate = requireAdmin(req);
      if (!gate.ok) return res.status(401).json({ error: gate.error });

      const body = await readJson(req);
      const { user_id, delta } = body || {};
      const n = Number(delta);
      if (!user_id || !Number.isFinite(n)) return res.status(400).json({ error: "user_id and delta(number) required" });

      const sb = supabaseAdmin();

      const { data: row, error: e1 } = await sb
        .from("user_profiles")
        .select("credits")
        .eq("id", user_id)
        .single();

      if (e1) return res.status(400).json({ error: e1.message });

      const newCredits = Math.max(0, Number(row?.credits ?? 0) + n);

      const { data, error: e2 } = await sb
        .from("user_profiles")
        .update({ credits: newCredits })
        .eq("id", user_id)
        .select()
        .single();

      if (e2) return res.status(400).json({ error: e2.message });

      return res.status(200).json({ ok: true, user: data, credits: data.credits });
    }

    // -------------------------
    // RESUME: extract (txt only safe)
    // -------------------------
    if (path === "resume/extract") {
      if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

      const { file } = await readMultipart(req);
      if (!file?.buffer) return res.status(200).json({ text: "" });

      // safe minimal: treat as text
      const text = file.buffer.toString("utf8");
      return res.status(200).json({ text });
    }

    // -------------------------
    // TRANSCRIBE: OpenAI audio transcribe (wav/webm)
    // -------------------------
    if (path === "transcribe") {
      if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

      const { file } = await readMultipart(req);
      if (!file?.buffer || file.buffer.length < 2000) return res.status(200).json({ text: "" });

      // Vercel Node: OpenAI SDK supports File via Blob in node 18+
      const blob = new Blob([file.buffer], { type: file.mime || "application/octet-stream" });

      const out = await openai.audio.transcriptions.create({
        file: blob,
        model: "gpt-4o-transcribe",
        language: "en",
        response_format: "json",
        temperature: 0
      });

      return res.status(200).json({ text: out?.text || "" });
    }

    // -------------------------
    // CHAT: send (stream) + reset
    // -------------------------
    if (path === "chat/reset") {
      // stateless in Vercel; kept for compatibility
      return res.status(200).json({ ok: true });
    }

    if (path === "chat/send") {
      if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

      const body = await readJson(req);
      const { prompt, instructions, resumeText } = body || {};
      if (!prompt) return res.status(400).json({ error: "Missing prompt" });

      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");

      const messages = [
        { role: "system", content: (instructions || "").slice(0, 4000) || "You are a helpful assistant." }
      ];

      if (resumeText) {
        messages.push({ role: "system", content: `RESUME:\n${String(resumeText).slice(0, 12000)}` });
      }

      messages.push({ role: "user", content: prompt });

      const stream = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        stream: true,
        temperature: 0.2,
        max_tokens: 900,
        messages
      });

      for await (const chunk of stream) {
        const t = chunk.choices?.[0]?.delta?.content || "";
        if (t) res.write(t);
      }
      return res.end();
    }

    // -------------------------
    // fallback
    // -------------------------
    return res.status(404).json({ error: `No route: /api/${path}` });
  } catch (e) {
    return res.status(500).json({ error: e?.message || String(e) });
  }
}
