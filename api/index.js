import Busboy from "busboy";
import OpenAI from "openai";
import { toFile } from "openai/uploads";
import { supabaseAnon, supabaseAdmin } from "../_utils/supabaseClient.js";
import { requireAdmin } from "../_utils/adminAuth.js";

// NEW — STATIC IMPORTS REQUIRED BY VERCEL
import mammoth from "mammoth";
import pdfParse from "pdf-parse";
import crypto from "crypto";

/**
 * CRITICAL:
 * - bodyParser MUST be false for multipart/form-data
 * - otherwise Busboy sees a drained stream -> "Unexpected end of form"
 */
export const config = {
  runtime: "nodejs",
  api: {
    bodyParser: false,
    responseLimit: false,
    externalResolver: true
  }
};

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// In-memory cache (per warm lambda) to avoid re-summarizing the same resume
const RESUME_SUMMARY_CACHE = new Map(); // sha256(resumeText) -> summary
const SESSION_CACHE = new Map();

/* -------------------------------------------------------------------------- */
/* HELPERS                                                                    */
/* -------------------------------------------------------------------------- */

function setCors(req, res) {
  const origin = req.headers.origin || "*";
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, Accept, X-Requested-With"
  );
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

function sha256(s = "") {
  return crypto.createHash("sha256").update(String(s)).digest("hex");
}

/* -------------------------------------------------------------------------- */
/* RESUME SUMMARY — FIXED                                                      */
/* Preserves exact project names, client names, tools, and measurable wins.   */
/* Old version compressed everything into keywords → model had nothing to cite */
/* -------------------------------------------------------------------------- */
async function getResumeSummary(resumeTextRaw = "") {
  const resumeText = String(resumeTextRaw || "").trim();
  if (!resumeText) return "";

  // If already short enough, use it directly
  if (resumeText.length <= 2500) return resumeText.slice(0, 2500);

  const key = sha256(resumeText);
  const cached = RESUME_SUMMARY_CACHE.get(key);
  if (cached) return cached;

  // FIX: Extract specifics, NOT a keyword summary.
  // The old prompt produced "Core Skills: Selenium, TestNG..." which gives the model
  // zero ammunition to answer "how did YOU handle X" — it falls back to generic answers.
  // This prompt preserves the exact details the model needs to ground answers in the candidate's reality.
  const summaryPrompt = `
Extract a precise interview-ready technical profile from this resume.
CRITICAL RULES:
- Preserve EXACT client names, project names, tools, versions, and measurable outcomes verbatim.
- DO NOT generalize. "Used Selenium" is useless. "Built ThreadLocal WebDriver + TestNG RetryAnalyzer hybrid framework for Citizens Bank CPM project" is correct.
- DO NOT invent anything. Extract only what is explicitly written.
- If numbers are present (%, ms, count), keep them exactly.

Output ONLY in this format — no other text:

**Role:** [Job title] | [Total years of experience] | [Primary domain: Banking/Healthcare/Payments/etc]

**Projects:**
- [Client name] ([dates]): [Role] — [Specific tools/frameworks used] — [Specific responsibility or achievement, verbatim if measurable]
(repeat for every project listed, max 5)

**Technical Depth:**
- [Tool/Framework]: [Exact usage — not "used X" but HOW it was used, what problem it solved, what was built with it]
(6–10 entries, only tools explicitly described with context)

**Quantified Results:** [Only real numbers/metrics from resume. Skip this section entirely if none found.]

Keep total output under 2000 characters. Never invent. Never generalize.

Resume:
${resumeText.slice(0, 20000)}
`.trim();

  try {
    const r = await openai.chat.completions.create({
      model: "gpt-4o",
      temperature: 0,
      max_tokens: 420, // was 260 — not enough for structured project extraction with specifics
      messages: [
        { role: "system", content: "Extract facts only. Preserve exact names, tools, numbers. Do not generalize or add assumptions." },
        { role: "user", content: summaryPrompt }
      ]
    });

    const summary = String(r?.choices?.[0]?.message?.content || "").trim();
    const finalSummary = summary || resumeText.slice(0, 2500);
    RESUME_SUMMARY_CACHE.set(key, finalSummary);
    return finalSummary;
  } catch {
    return resumeText.slice(0, 2500);
  }
}

/* -------------------------------------------------------------------------- */
/* EXTRACT PROJECT NAMES — HELPER FOR RESUME INJECTION                        */
/* Pulls client/project names for explicit reinforcement in the system prompt  */
/* -------------------------------------------------------------------------- */
function extractProjectNames(summary = "") {
  const matches = summary.match(/[-•]\s+([A-Z][A-Za-z0-9\s&]+?)\s+\(/g) || [];
  const names = matches
    .map(m => m.replace(/[-•\s(]/g, "").trim())
    .filter(n => n.length > 2)
    .slice(0, 5);

  if (!names.length) {
    // Fallback: look for bold project-like patterns
    const bold = summary.match(/\*\*([^*]+)\*\*/g) || [];
    return bold.map(b => b.replace(/\*\*/g, "").trim()).slice(0, 5).join(", ") || "projects in resume";
  }
  return names.join(", ");
}

/**
 * Hardened multipart reader:
 * - waits for file stream completion
 * - handles aborted/limit/error
 * - avoids "finish" resolving before file end in edge cases
 */
function readMultipart(req) {
  return new Promise((resolve, reject) => {
    const headers = req.headers || {};
    const ct = String(headers["content-type"] || "");

    if (!ct.toLowerCase().includes("multipart/form-data")) {
      return reject(new Error("Expected multipart/form-data"));
    }

    const bb = Busboy({
      headers,
      limits: { fileSize: 25 * 1024 * 1024 } // 25MB
    });

    const fields = {};
    let file = null;
    let fileDone = Promise.resolve();

    bb.on("field", (name, val) => (fields[name] = val));

    bb.on("file", (name, stream, info) => {
      const chunks = [];

      fileDone = new Promise((resDone, rejDone) => {
        stream.on("data", d => chunks.push(d));
        stream.on("limit", () => rejDone(new Error("File too large")));
        stream.on("error", rejDone);
        stream.on("end", () => {
          file = {
            field: name,
            filename: info?.filename || "upload.bin",
            mime: info?.mimeType || "application/octet-stream",
            buffer: Buffer.concat(chunks)
          };
          resDone();
        });
      });
    });

    bb.on("error", reject);

    bb.on("finish", async () => {
      try {
        await fileDone;
        resolve({ fields, file });
      } catch (e) {
        reject(e);
      }
    });

    req.on("aborted", () => reject(new Error("Request aborted")));
    req.on("error", reject);

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

async function getUserFromBearer(req) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) return { ok: false, error: "Missing token" };
  if (token.startsWith("ADMIN::")) return { ok: false, error: "Admin token not valid for user" };

  const sb = supabaseAnon();
  const { data, error } = await sb.auth.getUser(token);
  if (error) return { ok: false, error: error.message };
  if (!data?.user) return { ok: false, error: "Invalid session" };

  return { ok: true, user: data.user, access_token: token };
}

function safeHistory(history) {
  if (!Array.isArray(history)) return [];
  const out = [];
  for (const m of history.slice(-8)) {
    const role = m?.role;
    const content = typeof m?.content === "string" ? m.content : "";
    if ((role === "user" || role === "assistant") && content.trim()) {
      out.push({ role, content: content.slice(0, 1200) });
    }
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* LIGHTWEIGHT CODE-INTENT DETECTION                                          */
/* -------------------------------------------------------------------------- */

function looksLikeCodeText(s = "") {
  if (!s) return false;
  const t = String(s);
  if (t.includes("```")) return true;
  const tokenHits =
    (t.match(/[{}();]/g)?.length || 0) +
    (t.match(/\b(for|while|if|else|switch|case|return|class|public|static|void|def|function)\b/gi)?.length || 0);
  return tokenHits >= 6;
}

function isFollowUpPrompt(q = "") {
  const s = normalizeQ(q);
  if (!s) return false;

  const followTokens = [
    "then", "so", "but", "that", "this", "it", "same", "why", "how come",
    "as you said", "you said", "earlier", "previous", "follow up", "based on that"
  ];

  const hasRef = followTokens.some(t => s.includes(t));
  const isShort = s.length <= 160;
  return hasRef || isShort;
}

function buildContextPack(hist = []) {
  const pairs = [];
  let lastUser = null;

  for (const m of hist) {
    if (m.role === "user") {
      lastUser = m.content;
    } else if (m.role === "assistant" && lastUser) {
      pairs.push({ q: lastUser, a: m.content });
      lastUser = null;
    }
  }

  const tail = pairs.slice(-5);
  if (!tail.length) return "";

  const lines = ["PRIOR CONTEXT (reference only if question is a follow-up):"];
  tail.forEach((p, i) => {
    const q = String(p.q || "").replace(/\s+/g, " ").trim().slice(0, 180);
    const a = String(p.a || "").replace(/\s+/g, " ").trim().slice(0, 200);
    lines.push(`${i + 1}) Q: ${q}`);
    lines.push(`   A: ${a}`);
  });

  return lines.join("\n");
}

function normalizeQ(q = "") {
  return String(q || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function isExplanationQuestion(q = "") {
  const s = normalizeQ(q);

  const explainStarts = [
    "explain", "what is", "how does", "why", "describe", "define",
    "difference between", "compare", "advantages", "disadvantages", "pros and cons"
  ];

  const explainTopics = [
    "architecture", "design", "lifecycle", "internals", "jvm", "garbage collector",
    "class loader", "multithreading", "deadlock", "solid", "oops", "normalization"
  ];

  return (
    explainStarts.some(p => s.startsWith(p)) ||
    explainTopics.some(t => s.includes(t))
  );
}

function isCodeQuestion(q = "") {
  const s = normalizeQ(q);

  const explicitCode = [
    "code", "program", "snippet", "implementation", "source code",
    "write a function", "write a program", "give me code", "show me code"
  ];

  const taskVerbs = [
    "write", "implement", "create", "build", "develop", "program", "solve",
    "print", "return", "calculate", "count", "find", "check", "validate",
    "reverse", "sort", "remove", "replace", "convert"
  ];

  const algoKeywords = [
    "vowel", "vowels", "palindrome", "anagram", "fibonacci", "prime", "factorial",
    "string", "array", "hashmap", "hash set", "linked list", "stack", "queue",
    "binary search", "time complexity", "space complexity"
  ];

  const codeSignals = ["()", "{}", "[]", "for(", "while(", "if(", "public static", "def ", "class "];

  const wantsExample = /\b(example|sample|demo)\b/.test(s);
  const mentionsLanguage = /\b(java|python|javascript|typescript|c\+\+|c#|sql)\b/.test(s);

  let score = 0;
  if (explicitCode.some(x => s.includes(x))) score += 4;
  if (codeSignals.some(x => s.includes(x))) score += 4;
  if (taskVerbs.some(v => new RegExp(`\\b${v}\\b`).test(s))) score += 2;
  if (algoKeywords.some(k => s.includes(k))) score += 2;
  if (wantsExample) score += 1;
  if (mentionsLanguage) score += 1;

  return score >= 3;
}

/* -------------------------------------------------------------------------- */
/* RESUME EXTRACTION — FINAL VERSION (STATIC IMPORTS)                         */
/* -------------------------------------------------------------------------- */

function guessExtAndMime(file) {
  const name = (file?.filename || "").toLowerCase();
  const mime = (file?.mime || "").toLowerCase();

  if (name.endsWith(".pdf") || mime.includes("pdf"))
    return { ext: "pdf", mime: "application/pdf" };

  if (name.endsWith(".docx") || mime.includes("wordprocessingml"))
    return {
      ext: "docx",
      mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    };

  if (name.endsWith(".txt") || mime.includes("text/plain"))
    return { ext: "txt", mime: "text/plain" };

  return { ext: "bin", mime: "application/octet-stream" };
}

async function extractResumeText(file) {
  if (!file?.buffer || file.buffer.length < 20) return "";

  const { ext } = guessExtAndMime(file);

  if (ext === "txt") return file.buffer.toString("utf8");

  if (ext === "docx") {
    try {
      const out = await mammoth.extractRawText({ buffer: file.buffer });
      return String(out?.value || "");
    } catch (e) {
      return `[DOCX error during extraction] ${e?.message || ""}`;
    }
  }

  if (ext === "pdf") {
    try {
      const out = await pdfParse(file.buffer);
      return String(out?.text || "");
    } catch (e) {
      return `[PDF error during extraction] ${e?.message || ""}`;
    }
  }

  return file.buffer.toString("utf8");
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

    /* ------------------------------------------------------- */
    /* HEALTH                                                  */
    /* ------------------------------------------------------- */
    if (req.method === "GET" && (path === "" || path === "healthcheck")) {
      return res.status(200).json({ ok: true, time: new Date().toISOString() });
    }

    /* ------------------------------------------------------- */
    /* ENV CHECK                                               */
    /* ------------------------------------------------------- */
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

    /* ------------------------------------------------------- */
    /* AUTH — SIGNUP                                           */
    /* ------------------------------------------------------- */
    if (path === "auth/signup") {
      if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

      const { name, phone, email, password } = await readJson(req);
      if (!name || !email || !password) return res.status(400).json({ error: "Missing fields" });

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

      return res.json({ ok: true, message: "Account created. Verify email + wait for approval." });
    }

    /* ------------------------------------------------------- */
    /* AUTH — LOGIN                                            */
    /* ------------------------------------------------------- */
    if (path === "auth/login") {
      if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

      const { email, password } = await readJson(req);

      const adminEmail = (process.env.ADMIN_EMAIL || "").toLowerCase().trim();
      const adminPass = (process.env.ADMIN_PASSWORD || "").trim();
      if (email.toLowerCase().trim() === adminEmail && password === adminPass) {
        const token = `ADMIN::${adminEmail}::${Math.random().toString(36).slice(2)}`;
        return res.json({
          ok: true,
          session: { is_admin: true, token, user: { id: "admin", email: adminEmail } }
        });
      }

      const sb = supabaseAnon();
      const { data, error } = await sb.auth.signInWithPassword({ email, password });
      if (error) return res.status(401).json({ error: error.message });

      const user = data.user;
      if (!user.email_confirmed_at) return res.status(403).json({ error: "Email not verified yet" });

      const profile = await supabaseAdmin()
        .from("user_profiles")
        .select("approved")
        .eq("id", user.id)
        .single();

      if (!profile.data?.approved)
        return res.status(403).json({ error: "Admin has not approved your account yet" });

      return res.json({
        ok: true,
        session: {
          is_admin: false,
          access_token: data.session.access_token,
          refresh_token: data.session.refresh_token,
          expires_at: data.session.expires_at,
          user: { id: user.id, email: user.email }
        }
      });
    }

    /* ------------------------------------------------------- */
    /* AUTH — REFRESH TOKEN                                    */
    /* ------------------------------------------------------- */
    if (path === "auth/refresh") {
      if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

      const { refresh_token } = await readJson(req);
      if (!refresh_token) return res.status(400).json({ error: "Missing refresh_token" });

      const sb = supabaseAnon();
      const { data, error } = await sb.auth.refreshSession({ refresh_token });
      if (error) return res.status(401).json({ error: error.message });

      return res.json({
        ok: true,
        session: {
          access_token: data.session.access_token,
          refresh_token: data.session.refresh_token,
          expires_at: data.session.expires_at
        }
      });
    }

    /* ------------------------------------------------------- */
    /* AUTH — FORGOT PASSWORD                                  */
    /* ------------------------------------------------------- */
    if (path === "auth/forgot") {
      const { email } = await readJson(req);
      const redirectTo = `${originFromReq(req)}/auth?tab=login`;
      await supabaseAnon().auth.resetPasswordForEmail(email, { redirectTo });
      return res.json({ ok: true });
    }

    /* ------------------------------------------------------- */
    /* USER PROFILE                                            */
    /* ------------------------------------------------------- */
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

    /* ------------------------------------------------------- */
    /* USER — CREDIT DEDUCTION                                 */
    /* ------------------------------------------------------- */
    if (path === "user/deduct") {
      if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

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

    /* ------------------------------------------------------- */
    /* REALTIME — CLIENT SECRET                                */
    /* ------------------------------------------------------- */
    if (path === "realtime/client_secret") {
      if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

      const gate = await getUserFromBearer(req);
      if (!gate.ok) return res.status(401).json({ error: gate.error });

      const { data: row } = await supabaseAdmin()
        .from("user_profiles")
        .select("credits")
        .eq("id", gate.user.id)
        .single();

      const credits = Number(row?.credits || 0);
      if (credits <= 0) return res.status(403).json({ error: "No credits remaining" });

      const body = await readJson(req).catch(() => ({}));
      const ttl = Math.max(60, Math.min(900, Number(body?.ttl_sec || 600)));

      const payload = {
        expires_after: { anchor: "created_at", seconds: ttl },
        session: {
          type: "transcription",
          audio: {
            input: {
              format: { type: "audio/pcm", rate: 24000 },
              transcription: {
                model: "gpt-4o-mini-transcribe",
                language: "en",
                prompt:
                  "Transcribe exactly what is spoken. Do NOT add new words. Do NOT repeat phrases. Do NOT translate. Keep punctuation minimal. If uncertain, omit."
              },
              noise_reduction: { type: "far_field" },
              turn_detection: {
                type: "server_vad",
                threshold: 0.5,
                prefix_padding_ms: 300,
                silence_duration_ms: 350
              }
            }
          }
        }
      };

      const r = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload)
      });

      const out = await r.json().catch(() => ({}));
      if (!r.ok) {
        return res.status(r.status).json({
          error: out?.error?.message || out?.error || "Failed to create client secret"
        });
      }

      return res.json({ value: out.value, expires_at: out.expires_at || 0 });
    }

    /* ------------------------------------------------------- */
    /* DEEPGRAM — API KEY                                      */
    /* ------------------------------------------------------- */
    if (path === "deepgram/key") {
      if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

      const gate = await getUserFromBearer(req);
      if (!gate.ok) return res.status(401).json({ error: gate.error });

      const { data: row } = await supabaseAdmin()
        .from("user_profiles")
        .select("credits")
        .eq("id", gate.user.id)
        .single();

      const credits = Number(row?.credits || 0);
      if (credits <= 0) return res.status(403).json({ error: "No credits remaining" });

      const apiKey = process.env.DEEPGRAM_API_KEY;
      if (!apiKey) {
        return res.status(500).json({ error: "Deepgram API key not configured" });
      }

      return res.json({ key: apiKey });
    }

    /* ------------------------------------------------------- */
    /* RESUME EXTRACTION                                       */
    /* ------------------------------------------------------- */
    if (path === "resume/extract") {
      if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

      const { file } = await readMultipart(req);
      if (!file?.buffer) return res.json({ text: "" });

      const text = await extractResumeText(file);
      return res.json({ text: String(text || "") });
    }

    /* ------------------------------------------------------- */
    /* TRANSCRIBE (mic/system audio)                           */
    /* ------------------------------------------------------- */
    if (path === "transcribe") {
      if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

      const { fields, file } = await readMultipart(req);
      if (!file?.buffer || file.buffer.length < 2500) return res.json({ text: "" });

      try {
        const filename = file.filename || "audio.webm";
        const mime = (file.mime || "audio/webm").split(";")[0];
        const audioFile = await toFile(file.buffer, filename, { type: mime });

        const basePrompt =
          "Transcribe EXACTLY what is spoken in English. " +
          "Do NOT translate. Do NOT add filler words. Do NOT invent speakers. " +
          "Do NOT repeat earlier sentences. If silence/no speech, return empty.";

        const userPrompt = String(fields?.prompt || "").slice(0, 500);
        const finalPrompt = (basePrompt + (userPrompt ? "\n\nContext:\n" + userPrompt : "")).slice(0, 800);

        const out = await openai.audio.transcriptions.create({
          file: audioFile,
          model: "gpt-4o-transcribe",
          language: "en",
          temperature: 0,
          response_format: "json",
          prompt: finalPrompt
        });

        return res.json({ text: out.text || "" });
      } catch (e) {
        const status = e?.status || e?.response?.status || 500;
        return res.status(status).json({ error: e?.message || String(e) });
      }
    }

    /* ------------------------------------------------------- */
    /* CHAT SEND                                               */
    /* ------------------------------------------------------- */
    if (path === "chat/send") {
      if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

      const { prompt, instructions, resumeText, history, sessionId } = await readJson(req);

      if (!prompt) return res.status(400).json({ error: "Missing prompt" });

      // Flush headers immediately to eliminate blank-screen latency
      res.setHeader("Content-Type", "text/markdown; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("Transfer-Encoding", "chunked");
      res.flushHeaders?.();
      res.write("\u200B");

      const messages = [];

      // ============================================================
      // BASE SYSTEM — FIXED
      // Root cause of generic answers: old prompt said "if resume provided → use it"
      // which the model treated as optional. New prompt makes it NON-NEGOTIABLE with
      // explicit rules and violation labels.
      // ============================================================
      const baseSystem = `
You are a senior QA/SDET engineer with 10+ years of production experience being interviewed.
You answer from YOUR OWN shipped experience — not from documentation, not from theory.

═══════════════════════════════════════════════════════════
SECTION 1 — YOUR DIRECT ANSWER (always first, always sharp)
═══════════════════════════════════════════════════════════
Q: [restate the question exactly as asked]

**[2–3 sentences. Answer as if YOU personally solved this. Name every specific tool, technique,
framework, or pattern you actually used. Reference your domain (banking, healthcare, payments, etc.).
MANDATORY RULE: If candidate background is provided below, your answer MUST name their actual
client, project, or tool stack. Saying "In our project" without naming it = RULE VIOLATION.]**

═══════════════════════════════════════════════════════════
SECTION 2 — CONCEPT BREAKDOWN
═══════════════════════════════════════════════════════════
For EVERY distinct concept, tool, or technique named in Section 1 — write one ## block.
Minimum 4 bullets. Never merge two concepts into one block. Never skip a concept.

## [Exact concept name from Section 1]
- **The failure it prevented**: [specific production failure mode — not a textbook definition.
  Example: "WebDriverWait replaced Thread.sleep because our Angular login had async token validation
  taking 200–800ms — sleep was either too short (flaky) or too long (slow suite)"]
- **What I did in [Client/Project name]**: [MANDATORY if candidate background provided — cite their
  exact client, project name, and tool. Example: "In the Citizens Bank CPM project, I implemented
  ThreadLocal<WebDriver> so each TestNG parallel thread got its own isolated driver instance —
  without this, 3 threads sharing one driver caused random NoSuchSessionException failures."]
  [If NO resume context → use a named real-world reference: "At a fintech running 400+ nightly
  Selenium tests, we saw 12% flaky rate traced to..."]
- **Exact implementation**: [specific class, annotation, config value, or design decision.
  Why THIS approach over the obvious alternative.]
- **Outcome**: [hard number or operational result REQUIRED.
  "Flaky rate dropped from 12% to 1.8%." / "Zero NoSuchSession failures across 6 parallel threads."
  Saying "improved stability" without a number = RULE VIOLATION.]
- \`[copy-pasteable code snippet, exact CLI command, or config — inline comment on every non-obvious line]\`

[Repeat ## block for every concept in Section 1. Zero exceptions.]

═══════════════════════════════════════════════════════════
SECTION 3 — WAR STORY (the one fix that mattered most)
═══════════════════════════════════════════════════════════
Pick the single most impactful concept. Prove it happened.

**Project**: [MANDATORY if resume provided → exact client + project name. No resume → named real system]
**Stack**: [exact tools and versions if known]
**Scale**: [test count, execution frequency, team size, CI environment]
**What was breaking**: [specific symptom with frequency — "Login test failing 1-in-5 runs in Jenkins nightly"]
**Root cause**: [actual diagnosis — not "timing issues" but "Angular form emitting (ngModelChange)
  before HTTP token response arrived, so next step hit stale DOM"]
**Fix applied**: [step by step — tools chosen, why, trade-offs considered]

\`\`\`java
// [One-line: what this class/method solves]
// [Why THIS approach — what alternatives were rejected and why]
[Production-quality code. Comment every non-obvious line. No pseudocode.]
\`\`\`

**Result**: [One sentence. Hard number. "Flaky rate: 12% → 1.8%. Zero false CI failures for 6 months."]

═══════════════════════════════════════════════════════════
NON-NEGOTIABLE RULES — BREAKING ANY = INVALID ANSWER
═══════════════════════════════════════════════════════════
1. If candidate background is injected → EVERY "What I did" bullet MUST name their actual client or project. "In our project" with no name = VIOLATION.
2. Section 2 must have exactly one ## block per distinct concept from Section 1. No merging. No skipping.
3. Outcome bullets must contain a number or a concrete operational result. "Improved stability" = VIOLATION.
4. Never write "It is important to...", "Best practice is...", "One should..." — bookish filler = VIOLATION.
5. Code in Section 3 must be copy-pasteable with inline comments. Pseudocode = VIOLATION.
6. War story in Section 3 must feel like a real incident debrief — not a case study template.
`.trim();

      const CODE_FIRST_SYSTEM = `You are a senior engineer. Answer coding questions with working code, inline comments on every critical line, and sample I/O.

MANDATORY FORMAT:

\`\`\`[language]
// Brief one-line description of what this does

[code with inline comment on every non-trivial line]
\`\`\`

**Input:** [sample input]
**Output:** [sample output]`.trim();

      const forceCode =
        /\b(java|python|javascript|code|program)\b/i.test(prompt) &&
        /\b(count|find|occurrence|write|implement|create|solve)\b/i.test(prompt);

      const codeMode = forceCode || isCodeQuestion(prompt);

      messages.push({
        role: "system",
        content: codeMode ? CODE_FIRST_SYSTEM : baseSystem
      });

      if (!codeMode && instructions?.trim()) {
        messages.push({ role: "system", content: instructions.trim().slice(0, 3000) });
      }

      // ============================================================
      // RESUME CONTEXT INJECTION — FIXED
      // Old: "Candidate background (use to personalize answers):" — soft suggestion, model ignores it
      // New: Explicit contract with named projects + hard rule that forces citation
      // ============================================================
      let resumeSummary = "";

      if (resumeText?.trim()) {
        resumeSummary = await getResumeSummary(resumeText);
        if (sessionId) {
          SESSION_CACHE.set(sessionId, { resumeSummary });
        }
      } else if (sessionId && SESSION_CACHE.has(sessionId)) {
        resumeSummary = SESSION_CACHE.get(sessionId).resumeSummary;
      }

      if (resumeSummary) {
        const projectNames = extractProjectNames(resumeSummary);
        messages.push({
          role: "system",
          content: `
THIS IS THE CANDIDATE BEING INTERVIEWED. THIS IS NOT A HYPOTHETICAL PERSON.
All "What I did" bullets in Section 2 MUST reference the specific projects and tools below.
Using generic examples when this context is available = RULE VIOLATION.

Known projects to reference by name: ${projectNames}

CANDIDATE PROFILE:
${resumeSummary}

ENFORCEMENT: Every answer in Section 2 must tie back to at least one named project above.
If the question topic matches something in this profile, reference it directly and specifically.
If no direct match exists, use the candidate's closest relevant experience from this profile.
`.trim()
        });
      }

      const hist = safeHistory(history);

      if (!codeMode && hist.length && isFollowUpPrompt(String(prompt || ""))) {
        const ctx = buildContextPack(hist);
        if (ctx) messages.push({ role: "system", content: ctx });
      }

      for (const m of hist) messages.push(m);

      messages.push({
        role: "user",
        content: String(prompt).slice(0, 7000).trim()
      });

      const stream = await openai.chat.completions.create({
        model: "gpt-4o",
        stream: true,
        temperature: 0.4,
        max_tokens: 900,  // Increased from 650 — structured 3-section answer needs headroom
        messages
      });

      try {
        for await (const chunk of stream) {
          const t = chunk?.choices?.[0]?.delta?.content || "";
          if (t) res.write(t);
        }
      } catch {}

      return res.end();
    }

    /* ------------------------------------------------------- */
    /* CHAT RESET                                              */
    /* ------------------------------------------------------- */
    if (path === "chat/reset") return res.json({ ok: true });

    /* ------------------------------------------------------- */
    /* ADMIN — USER LIST                                       */
    /* ------------------------------------------------------- */
    if (path === "admin/users") {
      const gate = requireAdmin(req);
      if (!gate.ok) return res.status(401).json({ error: gate.error });

      const { data } = await supabaseAdmin()
        .from("user_profiles")
        .select("id,name,email,phone,approved,credits,created_at")
        .order("created_at", { ascending: false });

      return res.json({ users: data });
    }

    /* ------------------------------------------------------- */
    /* ADMIN — APPROVE USER                                    */
    /* ------------------------------------------------------- */
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

    /* ------------------------------------------------------- */
    /* ADMIN — UPDATE CREDITS                                  */
    /* ------------------------------------------------------- */
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

    return res.status(404).json({ error: `No route: /api/${path}` });
  } catch (err) {
    const msg = String(err?.message || err);

    if (msg.toLowerCase().includes("unexpected end of form")) {
      return res.status(400).json({
        error: "Unexpected end of form (multipart stream was consumed or interrupted)."
      });
    }

    return res.status(500).json({ error: msg });
  }
}