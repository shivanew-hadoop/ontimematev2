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

// Resume summary: summarize once, reuse many times (cuts tokens + latency)
async function getResumeSummary(resumeTextRaw = "") {
  const resumeText = String(resumeTextRaw || "").trim();
  if (!resumeText) return "";

  // If already short, keep it (hard cap)
  if (resumeText.length <= 2500) return resumeText.slice(0, 2500);

  const key = sha256(resumeText);
  const cached = RESUME_SUMMARY_CACHE.get(key);
  if (cached) return cached;

  const summaryPrompt = `
Extract ALL key facts from this resume into a structured summary for interview coaching.
Return ONLY this exact structure in Markdown:

**Name:** [full name]
**Current Role:** [title at current company]
**Current Company:** [company name]
**Years Experience:** [total years]
**Domain:** [e.g., Retail POS, E-commerce, Banking]

**Companies (newest first):**
- [Company] | [Role] | [Dates] — [2-3 key achievements with tools used]
- [repeat for each]

**Core Tech Stack:**
- Automation: [list tools]
- Languages: [list]
- API/Backend: [list]
- Mobile: [list]
- CI/CD: [list]
- Databases: [list]
- Other: [list]

**Key Domain Knowledge:**
[3-5 bullets of specific domain expertise — POS, payments, Kafka, etc.]

**Standout Projects/Achievements:**
[3-5 bullets with numbers and specific tools]

Resume:
${resumeText.slice(0, 20000)}
`.trim();

  try {
    const r = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0,
      max_tokens: 600,
      messages: [
        { role: "system", content: "Extract ONLY facts from the resume. Do not invent or assume anything." },
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

/**
 * Hardened multipart reader
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
      limits: { fileSize: 25 * 1024 * 1024 }
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
/* INTENT DETECTION                                                            */
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
  return String(q || "").toLowerCase().replace(/\s+/g, " ").trim();
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
/* RESUME EXTRACTION                                                           */
/* -------------------------------------------------------------------------- */

function guessExtAndMime(file) {
  const name = (file?.filename || "").toLowerCase();
  const mime = (file?.mime || "").toLowerCase();
  if (name.endsWith(".pdf") || mime.includes("pdf"))
    return { ext: "pdf", mime: "application/pdf" };
  if (name.endsWith(".docx") || mime.includes("wordprocessingml"))
    return { ext: "docx", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" };
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
      const { data, error } = await sb.auth.signUp({ email, password, options: { emailRedirectTo: redirectTo } });
      if (error) return res.status(400).json({ error: error.message });
      await supabaseAdmin().from("user_profiles").insert({
        id: data?.user?.id, name, phone: phone || "", email,
        approved: false, credits: 0, created_at: new Date().toISOString()
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
        return res.json({ ok: true, session: { is_admin: true, token, user: { id: "admin", email: adminEmail } } });
      }
      const sb = supabaseAnon();
      const { data, error } = await sb.auth.signInWithPassword({ email, password });
      if (error) return res.status(401).json({ error: error.message });
      const user = data.user;
      if (!user.email_confirmed_at) return res.status(403).json({ error: "Email not verified yet" });
      const profile = await supabaseAdmin().from("user_profiles").select("approved").eq("id", user.id).single();
      if (!profile.data?.approved) return res.status(403).json({ error: "Admin has not approved your account yet" });
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
      return res.json({ ok: true, user: { ...profile.data, created_ymd: ymd(profile.data.created_at) } });
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
      const { data: row, error: e1 } = await sb.from("user_profiles").select("credits").eq("id", gate.user.id).single();
      if (e1) return res.status(400).json({ error: e1.message });
      const current = Number(row?.credits || 0);
      const remaining = Math.max(0, current - d);
      const { error: e2 } = await sb.from("user_profiles").update({ credits: remaining }).eq("id", gate.user.id);
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
      const { data: row } = await supabaseAdmin().from("user_profiles").select("credits").eq("id", gate.user.id).single();
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
                model: "gpt-4o-mini-transcribe", language: "en",
                prompt: "Transcribe exactly what is spoken. Do NOT add new words. Do NOT repeat phrases. Do NOT translate. Keep punctuation minimal. If uncertain, omit."
              },
              noise_reduction: { type: "far_field" },
              turn_detection: { type: "server_vad", threshold: 0.5, prefix_padding_ms: 300, silence_duration_ms: 350 }
            }
          }
        }
      };
      const r = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
        method: "POST",
        headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      const out = await r.json().catch(() => ({}));
      if (!r.ok) return res.status(r.status).json({ error: out?.error?.message || out?.error || "Failed to create client secret" });
      return res.json({ value: out.value, expires_at: out.expires_at || 0 });
    }

    /* ------------------------------------------------------- */
    /* DEEPGRAM — API KEY                                      */
    /* ------------------------------------------------------- */
    if (path === "deepgram/key") {
      if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
      const gate = await getUserFromBearer(req);
      if (!gate.ok) return res.status(401).json({ error: gate.error });
      const { data: row } = await supabaseAdmin().from("user_profiles").select("credits").eq("id", gate.user.id).single();
      const credits = Number(row?.credits || 0);
      if (credits <= 0) return res.status(403).json({ error: "No credits remaining" });
      const apiKey = process.env.DEEPGRAM_API_KEY;
      if (!apiKey) return res.status(500).json({ error: "Deepgram API key not configured" });
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
          file: audioFile, model: "gpt-4o-transcribe", language: "en",
          temperature: 0, response_format: "json", prompt: finalPrompt
        });
        return res.json({ text: out.text || "" });
      } catch (e) {
        const status = e?.status || e?.response?.status || 500;
        return res.status(status).json({ error: e?.message || String(e) });
      }
    }

    /* ------------------------------------------------------- */
    /* CHAT SEND — HIGH-QUALITY PERSONALIZED RESPONSES         */
    /* ------------------------------------------------------- */
    if (path === "chat/send") {
      if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

      const { prompt, instructions, resumeText, history, sessionId } = await readJson(req);
      if (!prompt) return res.status(400).json({ error: "Missing prompt" });

      // Send headers immediately to eliminate blank-screen wait
      res.setHeader("Content-Type", "text/markdown; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("Transfer-Encoding", "chunked");
      res.flushHeaders?.();
      res.write("\u200B");

      const messages = [];

      // ============================================================
      // SYSTEM PROMPTS — UPGRADED FOR PERSONALIZED DEPTH
      // ============================================================

      const baseSystem = `You are an expert interview coach. The candidate has provided their resume. Your job is to answer every interview question AS IF YOU ARE THE CANDIDATE — using THEIR actual experience, companies, tools, and projects from the resume.

CRITICAL RULES:
- ALWAYS reference the candidate's actual companies (e.g., "At Albertsons...", "When I was at Kroger...")
- ALWAYS use their actual tools and technologies from the resume
- ALWAYS mention specific achievements or responsibilities from their background
- Make answers feel like a real person sharing real experience, not a textbook
- Be specific: use tool names, metric values, real scenarios they would have faced

MANDATORY FORMAT for every non-code answer:

Q: [restate the question]

**[One-sentence bottom-line answer referencing their actual role/domain]**

Here's how I handle it in production:

1️⃣ [Step title — verb-first]
* [Specific action — what THEY did at THEIR company]
* [Tool or technology THEY actually used]
* \`actual command, config, or code snippet if relevant\`

2️⃣ [Next step]
* [Specific action with their real context]
* [Real tool from their stack]

3️⃣ [Next step]
* [Specific action]
* \`code/config if useful\`

[Add more steps only if genuinely needed]

**[Bold closing statement — outcome they achieved or guarantee with real numbers if available]**

FORMAT RULES:
- "Here's how I handle it in production:" is ALWAYS the transition line
- Every step: emoji number 1️⃣ 2️⃣ 3️⃣ 4️⃣ 5️⃣
- Sub-bullets: * (not •), specific actions not definitions
- Inline \`code\` for real commands, queries, configs
- End with bold result statement
- NO generic textbook answers — every answer must feel personalized to THEIR background
- Include real values: retry counts, thresholds, latency numbers, test counts
- For architecture: show call chain → UI → Gateway → Service → DB
- For tools they use: explain HOW they used it, not just what it is`.trim();

       const CODE_FIRST_SYSTEM = `You are a senior engineer. For coding, provide TWO blocks:

**BLOCK 1: Simple Logic (Core algorithm only)**
\`\`\`[language]
// Core logic - what interviewer initially asks for
// Inline comment on EVERY line explaining the step

[Only essential algorithm/logic - minimal, focused]
\`\`\`

**BLOCK 2: Complete Implementation (If they ask for full solution)**
\`\`\`[language]
// Complete solution with edge cases
// Inline comment on every non-trivial line

[Full implementation with validation, edge cases, main method]
\`\`\`

**Input:** [sample]
**Output:** [sample]`.trim();

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

      // Resume context — the KEY to personalized answers
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
        messages.push({
          role: "system",
          content: `CANDIDATE PROFILE — USE THIS TO PERSONALIZE EVERY ANSWER:
${resumeSummary}

INSTRUCTION: Answer as this specific candidate. Reference their actual companies, tools, projects, and achievements. Do not give generic answers.`
        });
      } else {
        // No resume — still give a good answer but note it
        messages.push({
          role: "system",
          content: "No resume provided. Give a thorough, production-grade answer as a senior QA/SDET engineer with 10+ years experience in retail POS, automation frameworks, API testing, and mobile testing."
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

      // Increased tokens for richer answers — 1200 matches ChatGPT depth
      const stream = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        stream: true,
        temperature: 0.35,  // Slightly lower = more consistent, structured answers
        max_tokens: 1200,   // Was 650 — this is why answers were getting cut short
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
      const { data } = await supabaseAdmin().from("user_profiles").update({ approved }).eq("id", user_id).select().single();
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
      const { data: row } = await sb.from("user_profiles").select("credits").eq("id", user_id).single();
      const newCredits = Math.max(0, Number(row.credits) + Number(delta));
      const { data } = await sb.from("user_profiles").update({ credits: newCredits }).eq("id", user_id).select().single();
      return res.json({ ok: true, credits: data.credits });
    }

    return res.status(404).json({ error: `No route: /api/${path}` });
  } catch (err) {
    const msg = String(err?.message || err);
    if (msg.toLowerCase().includes("unexpected end of form")) {
      return res.status(400).json({ error: "Unexpected end of form (multipart stream was consumed or interrupted)." });
    }
    return res.status(500).json({ error: msg });
  }
}