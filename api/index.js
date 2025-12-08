import Busboy from "busboy";
import OpenAI from "openai";
import { toFile } from "openai/uploads";
import { supabaseAnon, supabaseAdmin } from "../_utils/supabaseClient.js";
import { requireAdmin } from "../_utils/adminAuth.js";

export const config = { runtime: "nodejs" };

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/* -------------------------------------------------------------------------- */
/* HELPERS                                                                    */
/* -------------------------------------------------------------------------- */

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
    req.on("data", c => (body += c));
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
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
      stream.on("data", d => chunks.push(d));
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
  const proto = req.headers["x-forwarded-proto"] || "https";
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  if (!host)
    return process.env.PUBLIC_SITE_URL || "https://thoughtmatters-ai.vercel.app";
  return `${proto}://${host}`;
}

function ymd(dateStr) {
  const dt = new Date(dateStr);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(
    dt.getDate()
  ).padStart(2, "0")}`;
}

/* -------------------------------------------------------------------------- */
/* USER SESSION HELPER                                                        */
/* -------------------------------------------------------------------------- */

async function getUserFromBearer(req) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) return { ok: false, error: "Missing token" };

  if (token.startsWith("ADMIN::")) {
    return { ok: false, error: "Admin token not valid for user" };
  }

  const sb = supabaseAnon();
  const { data, error } = await sb.auth.getUser(token);

  if (error) return { ok: false, error: error.message };
  if (!data?.user) return { ok: false, error: "Invalid session" };

  return { ok: true, user: data.user, access_token: token };
}

/* -------------------------------------------------------------------------- */
/* MAIN HANDLER                                                               */
/* -------------------------------------------------------------------------- */

export default async function handler(req, res) {
  try {
    setCors(req, res);
    if (req.method === "OPTIONS") return res.status(200).end();

    const url = new URL(req.url, "http://localhost");
    const path = (url.searchParams.get("path") || "").replace(/^\/+/, "");

    /* ---------------------------------------------------------------------- */
    /* HEALTH CHECK                                                           */
    /* ---------------------------------------------------------------------- */
    if (req.method === "GET" && (path === "" || path === "healthcheck")) {
      return res.status(200).json({
        ok: true,
        service: "api",
        time: new Date().toISOString()
      });
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

    /* ---------------------------------------------------------------------- */
    /* AUTH: SIGNUP                                                           */
    /* ---------------------------------------------------------------------- */
    if (path === "auth/signup") {
      if (req.method !== "POST")
        return res.status(405).json({ error: "Method not allowed" });

      const { name, phone, email, password } = await readJson(req);
      if (!name || !email || !password)
        return res.status(400).json({ error: "Missing fields" });

      const sb = supabaseAnon();
      const redirectTo = `${originFromReq(req)}/auth?tab=login`;

      const { data, error } = await sb.auth.signUp({
        email,
        password,
        options: { emailRedirectTo: redirectTo }
      });
      if (error) return res.status(400).json({ error: error.message });

      await supabaseAdmin().from("user_profiles").insert({
        id: data?.user?.id,
        name,
        phone: phone || "",
        email,
        approved: false,
        credits: 0,
        created_at: new Date().toISOString()
      });

      return res.json({
        ok: true,
        message: "Account created. Verify email + wait for approval."
      });
    }

    /* ---------------------------------------------------------------------- */
    /* AUTH: LOGIN (Admin + User)                                             */
    /* ---------------------------------------------------------------------- */
    if (path === "auth/login") {
      if (req.method !== "POST")
        return res.status(405).json({ error: "Method not allowed" });

      const { email, password } = await readJson(req);

      // Admin
      const adminEmail = (process.env.ADMIN_EMAIL || "").toLowerCase().trim();
      const adminPass = (process.env.ADMIN_PASSWORD || "").trim();

      if (email.toLowerCase().trim() === adminEmail && password === adminPass) {
        const token = `ADMIN::${adminEmail}::${Math.random().toString(36).slice(2)}`;
        return res.json({
          ok: true,
          session: {
            is_admin: true,
            token,
            user: { id: "admin", email: adminEmail }
          }
        });
      }

      // Normal user login
      const sb = supabaseAnon();
      const { data, error } = await sb.auth.signInWithPassword({ email, password });
      if (error) return res.status(401).json({ error: error.message });

      const user = data.user;

      if (!user.email_confirmed_at)
        return res.status(403).json({ error: "Email not verified yet" });

      const profile = await supabaseAdmin()
        .from("user_profiles")
        .select("approved")
        .eq("id", user.id)
        .single();

      if (!profile.data?.approved) {
        return res
          .status(403)
          .json({ error: "Admin has not approved your account yet" });
      }

      return res.json({
        ok: true,
        session: {
          is_admin: false,
          access_token: data.session.access_token,
          user: { id: user.id, email: user.email }
        }
      });
    }

    /* ---------------------------------------------------------------------- */
    /* AUTH: LOGOUT                                                           */
    /* ---------------------------------------------------------------------- */
    if (path === "auth/logout") return res.json({ ok: true });

    /* ---------------------------------------------------------------------- */
    /* AUTH: FORGOT PASSWORD                                                  */
    /* ---------------------------------------------------------------------- */
    if (path === "auth/forgot") {
      const { email } = await readJson(req);
      const redirectTo = `${originFromReq(req)}/auth?tab=login`;

      await supabaseAnon().auth.resetPasswordForEmail(email, { redirectTo });
      return res.json({ ok: true });
    }

    /* ---------------------------------------------------------------------- */
    /* USER: PROFILE                                                          */
    /* ---------------------------------------------------------------------- */
    if (path === "user/profile") {
      const gate = await getUserFromBearer(req);
      if (!gate.ok) return res.status(401).json({ error: gate.error });

      const profile = await supabaseAdmin()
        .from("user_profiles")
        .select("id,name,email,phone,approved,credits,created_at")
        .eq("id", gate.user.id)
        .single();

      if (!profile.data) return res.status(404).json({ error: "Profile not found" });

      return res.json({
        ok: true,
        user: { ...profile.data, created_ymd: ymd(profile.data.created_at) }
      });
    }

    /* ---------------------------------------------------------------------- */
    /* USER: DEDUCT (BATCH)                                                   */
    /* Body: { delta: number }                                                */
    /* ---------------------------------------------------------------------- */
    if (path === "user/deduct") {
      if (req.method !== "POST")
        return res.status(405).json({ error: "Method not allowed" });

      const gate = await getUserFromBearer(req);
      if (!gate.ok) return res.status(401).json({ error: gate.error });

      const { delta } = await readJson(req);
      const d = Math.max(0, Math.floor(Number(delta || 0)));
      if (!d) return res.json({ ok: true, remaining: null });

      const sb = supabaseAdmin();

      const { data: row, error: e1 } = await sb
        .from("user_profiles")
        .select("credits")
        .eq("id", gate.user.id)
        .single();

      if (e1) return res.status(400).json({ error: e1.message });

      const current = Number(row?.credits || 0);
      const remaining = Math.max(0, current - d);

      const { error: e2 } = await sb
        .from("user_profiles")
        .update({ credits: remaining })
        .eq("id", gate.user.id);

      if (e2) return res.status(400).json({ error: e2.message });

      return res.json({ ok: remaining > 0, remaining });
    }

    /* ---------------------------------------------------------------------- */
    /* ADMIN: LIST USERS                                                      */
    /* ---------------------------------------------------------------------- */
    if (path === "admin/users") {
      const gate = requireAdmin(req);
      if (!gate.ok) return res.status(401).json({ error: gate.error });

      const { data } = await supabaseAdmin()
        .from("user_profiles")
        .select("id,name,email,phone,approved,credits,created_at")
        .order("created_at", { ascending: false });

      return res.json({ users: data });
    }

    /* ---------------------------------------------------------------------- */
    /* ADMIN: APPROVE USER                                                    */
    /* ---------------------------------------------------------------------- */
    if (path === "admin/approve") {
      const gate = requireAdmin(req);
      if (!gate.ok) return res.status(401).json({ error: gate.error });

      const { user_id, approved } = await readJson(req);

      const { data } = await supabaseAdmin()
        .from("user_profiles")
        .update({ approved })
        .eq("id", user_id)
        .select()
        .single();

      return res.json({ ok: true, user: data });
    }

    /* ---------------------------------------------------------------------- */
    /* ADMIN: MODIFY CREDITS                                                  */
    /* ---------------------------------------------------------------------- */
    if (path === "admin/credits") {
      const gate = requireAdmin(req);
      if (!gate.ok) return res.status(401).json({ error: gate.error });

      const { user_id, delta } = await readJson(req);

      const sb = supabaseAdmin();
      const { data: row } = await sb
        .from("user_profiles")
        .select("credits")
        .eq("id", user_id)
        .single();

      const newCredits = Math.max(0, Number(row.credits) + Number(delta));

      const { data } = await sb
        .from("user_profiles")
        .update({ credits: newCredits })
        .eq("id", user_id)
        .select()
        .single();

      return res.json({ ok: true, credits: data.credits });
    }

    /* ---------------------------------------------------------------------- */
    /* RESUME EXTRACT                                                         */
    /* ---------------------------------------------------------------------- */
    if (path === "resume/extract") {
      const { file } = await readMultipart(req);
      return res.json({ text: file?.buffer?.toString("utf8") || "" });
    }

    /* ---------------------------------------------------------------------- */
    /* TRANSCRIBE (SYSTEM AUDIO)                                              */
    /* - Node-safe upload via toFile                                          */
    /* - Silence reject to stop hallucinations + reduce cost                  */
    /* ---------------------------------------------------------------------- */
    if (path === "transcribe") {
      const { file } = await readMultipart(req);

      if (!file?.buffer || file.buffer.length < 2000)
        return res.json({ text: "" });

      // Silence reject (WAV PCM16 typical)
      try {
        const buf = file.buffer;
        if ((file.mime || "").includes("wav") && buf.length > 60) {
          const start = 44; // wav header
          let sumAbs = 0;
          let count = 0;

          // sample every 10th sample for speed
          for (let i = start; i + 1 < buf.length; i += 20) {
            const v = buf.readInt16LE(i);
            sumAbs += Math.abs(v);
            count++;
          }

          const avgAbs = sumAbs / Math.max(1, count);

          // Tune 80–250. Higher => stricter silence rejection
          if (avgAbs < 140) {
            return res.json({ text: "" });
          }
        }
      } catch {
        // ignore silence check failures
      }

      try {
        const audioFile = await toFile(
          file.buffer,
          file.filename || "audio.wav",
          { type: file.mime || "audio/wav" }
        );

        const out = await openai.audio.transcriptions.create({
          file: audioFile,
          model: "gpt-4o-transcribe",
          language: "en",
          response_format: "json",
          temperature: 0
        });

        return res.json({ text: out.text || "" });
      } catch (e) {
        return res.status(500).json({ error: e?.message || String(e) });
      }
    }

    /* ---------------------------------------------------------------------- */
    /* CHAT SEND (STREAM)                                                     */
    /* ---------------------------------------------------------------------- */
    if (path === "chat/send") {
      const { prompt, instructions, resumeText } = await readJson(req);
      if (!prompt) return res.status(400).json({ error: "Missing prompt" });

      res.setHeader("Content-Type", "text/plain; charset=utf-8");

      const messages = [
        { role: "system", content: String(instructions || "").slice(0, 4000) }
      ];

      if (resumeText) {
        messages.push({
          role: "system",
          content: `RESUME:\n${String(resumeText).slice(0, 12000)}`
        });
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
        const t = chunk?.choices?.[0]?.delta?.content || "";
        if (t) res.write(t);
      }

      return res.end();
    }

    /* ---------------------------------------------------------------------- */
    /* CHAT RESET                                                             */
    /* ---------------------------------------------------------------------- */
    if (path === "chat/reset") {
      return res.json({ ok: true, message: "chat reset" });
    }

    /* ---------------------------------------------------------------------- */
    /* FALLBACK                                                               */
    /* ---------------------------------------------------------------------- */
    return res.status(404).json({ error: `No route: /api/${path}` });
  } catch (err) {
    return res.status(500).json({ error: err.message || String(err) });
  }
}
