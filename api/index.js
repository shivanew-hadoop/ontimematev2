import Busboy from "busboy";
import OpenAI from "openai";
import { toFile } from "openai/uploads";
import { supabaseAnon, supabaseAdmin } from "../_utils/supabaseClient.js";
import { requireAdmin } from "../_utils/adminAuth.js";

import mammoth from "mammoth";
import pdfParse from "pdf-parse";
import crypto from "crypto";

export const config = {
  runtime: "nodejs",
  api: {
    bodyParser: false,
    responseLimit: false,
    externalResolver: true
  }
};

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const RESUME_SUMMARY_CACHE = new Map();
const SESSION_CACHE = new Map();

/* -------------------------------------------------------------------------- */
/* HELPERS                                                                    */
/* -------------------------------------------------------------------------- */

function setCors(req, res) {
  const origin = req.headers.origin || "*";
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Accept, X-Requested-With");
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", c => (body += c));
    req.on("end", () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch { reject(new Error("Invalid JSON")); }
    });
    req.on("error", reject);
  });
}

function sha256(s = "") {
  return crypto.createHash("sha256").update(String(s)).digest("hex");
}

async function getResumeSummary(resumeTextRaw = "") {
  const resumeText = String(resumeTextRaw || "").trim();
  if (!resumeText) return "";
  if (resumeText.length <= 8000) return resumeText;

  const key = sha256(resumeText);
  const cached = RESUME_SUMMARY_CACHE.get(key);
  if (cached) return cached;

  const summaryPrompt = `
Extract ALL key facts from this resume. Be EXHAUSTIVE — do not compress or omit specifics.
Return EXACTLY this structure:

**Name:** [full name]
**Current Role:** [exact title]
**Current Company:** [company]
**Total Experience:** [X years]
**Domain:** [primary domain e.g. Retail POS, E-commerce]

**Work History (newest first — include ALL companies):**
- [Company] | [Role] | [Start–End]
  * [Specific achievement with tool]
  * [Specific achievement with number if present]

**Full Tech Stack (list every tool mentioned):**
- Automation Frameworks: ...
- Languages: ...
- API/Backend: ...
- CI/CD: ...
- Databases: ...
- Cloud/Other: ...

**Key Achievements with Numbers:**
* [List ALL quantified or notable achievements]

Resume:
${resumeText.slice(0, 20000)}
`.trim();

  try {
    const r = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0,
      max_tokens: 1100,
      messages: [
        { role: "system", content: "Extract ONLY facts verbatim from the resume. Preserve all numbers and technical details exactly." },
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

function readMultipart(req) {
  return new Promise((resolve, reject) => {
    const headers = req.headers || {};
    const ct = String(headers["content-type"] || "");
    if (!ct.toLowerCase().includes("multipart/form-data")) return reject(new Error("Expected multipart/form-data"));

    const bb = Busboy({ headers, limits: { fileSize: 25 * 1024 * 1024 } });
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
          file = { field: name, filename: info?.filename || "upload.bin", mime: info?.mimeType || "application/octet-stream", buffer: Buffer.concat(chunks) };
          resDone();
        });
      });
    });
    bb.on("error", reject);
    bb.on("finish", async () => { try { await fileDone; resolve({ fields, file }); } catch (e) { reject(e); } });
    req.on("aborted", () => reject(new Error("Request aborted")));
    req.on("error", reject);
    req.pipe(bb);
  });
}

function originFromReq(req) {
  const proto = req.headers["x-forwarded-proto"] || "https";
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  if (!host) return process.env.PUBLIC_SITE_URL || "https://thoughtmatters-ai.vercel.app";
  return `${proto}://${host}`;
}

function ymd(dateStr) {
  const dt = new Date(dateStr);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
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
/* DYNAMIC INTENT DETECTION ENGINE                                            */
/* -------------------------------------------------------------------------- */

function normalizeQ(q = "") {
  return String(q || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function isFollowUpPrompt(q = "") {
  const s = normalizeQ(q);
  const followTokens = ["then", "so", "but", "that", "this", "it", "same", "why", "how come", "as you said", "you said", "earlier", "previous", "follow up", "based on that"];
  return followTokens.some(t => s.includes(t)) || s.length <= 160;
}

function buildContextPack(hist = []) {
  const pairs = [];
  let lastUser = null;
  for (const m of hist) {
    if (m.role === "user") lastUser = m.content;
    else if (m.role === "assistant" && lastUser) { pairs.push({ q: lastUser, a: m.content }); lastUser = null; }
  }
  const tail = pairs.slice(-5);
  if (!tail.length) return "";
  const lines = ["PRIOR CONTEXT (reference only if question is a follow-up):"];
  tail.forEach((p, i) => {
    lines.push(`${i + 1}) Q: ${String(p.q || "").replace(/\s+/g, " ").trim().slice(0, 180)}`);
    lines.push(`   A: ${String(p.a || "").replace(/\s+/g, " ").trim().slice(0, 200)}`);
  });
  return lines.join("\n");
}

/**
 * DYNAMIC QUESTION TYPE CLASSIFIER
 * Returns one of: "code" | "sql" | "experience" | "concept" | "debug" | "behavioral" | "quick"
 */
function classifyQuestion(q = "") {
  const s = normalizeQ(q);

  // CODE: explicit coding task in a programming language
  const explicitCode = ["write a function", "write a program", "give me code", "show me code", "code for", "implement", "write code", "snippet"];
  const codeSignals = ["()", "{}", "for(", "while(", "public static", "def ", "class ", "async ", "=>"];
  const algoKeywords = ["palindrome", "fibonacci", "prime", "factorial", "anagram", "linked list", "binary search", "recursion", "dynamic programming", "sorting"];
  const programmingLang = /\b(java|kotlin|python|javascript|typescript|golang|go|rust|ruby|php|swift|scala|c\+\+|c#|bash|shell)\b/i.test(s);

  let codeScore = 0;
  if (explicitCode.some(x => s.includes(x))) codeScore += 4;
  if (codeSignals.some(x => s.includes(x))) codeScore += 4;
  if (algoKeywords.some(k => s.includes(k))) codeScore += 2;
  if (programmingLang && /\b(write|implement|create|build|program|solve|count|find|print|return|calculate|reverse|sort)\b/.test(s)) codeScore += 2;
  if (codeScore >= 3) return "code";

  // SQL: query writing tasks
  const sqlKeywords = ["select", "query", "sql", "join", "group by", "window function", "cte", "with clause", "row_number", "partition by", "snowflake query", "write a query", "give me a query"];
  if (sqlKeywords.some(k => s.includes(k)) && /\b(write|show|give|how|what|fetch|get|find)\b/.test(s)) return "sql";

  // EXPERIENCE: asking about past work, projects, challenges
  const experienceSignals = [
    "you worked on", "you have worked", "what complex", "most complex", "challenging project",
    "give me an example", "tell me about a time", "walk me through", "describe a situation",
    "what did you do", "how did you handle", "what was your approach", "real example",
    "in your experience", "in your project", "have you ever", "did you work on",
    "optimization you did", "problem you solved", "issue you faced", "you implemented"
  ];
  if (experienceSignals.some(k => s.includes(k))) return "experience";

  // BEHAVIORAL: HR/soft skill questions
  const behavioralSignals = [
    "tell me about yourself", "greatest strength", "greatest weakness", "why should we hire",
    "where do you see yourself", "conflict with", "team situation", "disagreement", "how do you handle pressure",
    "what motivates you", "why did you leave", "career goal", "self introduction", "introduce yourself"
  ];
  if (behavioralSignals.some(k => s.includes(k))) return "behavioral";

  // DEBUG: troubleshooting, failure investigation
  const debugSignals = [
    "pipeline failed", "build failed", "error", "exception", "not working", "issue", "bug",
    "troubleshoot", "debug", "root cause", "why is it failing", "what could go wrong",
    "potential reason", "investigate", "fix this", "what went wrong"
  ];
  if (debugSignals.some(k => s.includes(k))) return "debug";

  // QUICK: short/factual questions
  if (s.length < 60 && /^(what|who|when|where|which|is|are|do|does|can|how many|how much)/.test(s)) return "quick";

  // CONCEPT: default for explanation questions
  return "concept";
}

function normalizeRoleType(roleType = "", roleText = "") {
  const rt = String(roleType || "").toLowerCase().trim();
  if (rt) return rt;
  const s = String(roleText || "").toLowerCase().trim();
  if (!s) return "";
  if (s.includes("qa") || s.includes("automation") || s.includes("test")) return "qa-automation";
  if (s.includes("data engineer") || s.includes("etl") || s.includes("databricks") || s.includes("snowflake")) return "data-engineer";
  if (s.includes("genai") || s.includes("llm") || s.includes("rag")) return "genai";
  if (s.includes("cloud") || s.includes("architect")) return "cloud-architect";
  if (s.includes("java") || s.includes("spring") || s.includes("backend")) return "java-backend";
  return "generic";
}

/* -------------------------------------------------------------------------- */
/* DYNAMIC SYSTEM PROMPT BUILDER                                              */
/* -------------------------------------------------------------------------- */

/**
 * Returns the RIGHT system prompt for the detected question type.
 * Each template mirrors the ChatGPT 5.2 style seen in the screenshots.
 */
function buildDynamicSystemPrompt(questionType) {
  switch (questionType) {

    case "code":
      return `You are a senior engineer being asked a coding question in a live interview.

Always produce TWO blocks:

**BLOCK 1 — Core Logic (simple, minimal)**
\`\`\`[language]
// Core algorithm only — what the interviewer initially asks
// Inline comment on EVERY line explaining the step
\`\`\`

**BLOCK 2 — Complete Implementation (production-grade)**
\`\`\`[language]
// Full solution: edge cases, validation, main method
// Inline comment on every non-trivial line
\`\`\`

**Input:** [sample input]
**Output:** [sample output]

**Time Complexity:** O(?) | **Space Complexity:** O(?)

Then briefly explain the approach in 2–3 sentences — no padding.`;

    case "sql":
      return `You are a senior data engineer answering a SQL/query question in a live interview.

Format:

First, state your approach in 1 sentence — which technique you'll use and why.

Then show the query:

\`\`\`sql
-- Comment explaining what each clause does
SELECT ...
FROM ...
\`\`\`

What this does:
- [clause] → [what it achieves]
- [clause] → [what it achieves]

If multiple approaches exist (e.g. IS_CURRENT flag vs window function), show both with a one-line tradeoff note.
Do not add filler. Be direct and practical.`;

    case "experience":
      return `You are a senior engineer sharing a real project story in a live interview.

Open with ONE strong hook sentence — the result first (e.g. "One of the most complex X I worked on was Y — it was doing Z, and I reduced/improved/solved it by doing W.").

Then say "Let me explain clearly." and break it down:

**The original problem had:**
- [specific issue 1]
- [specific issue 2]
- [specific issue 3]

**What I identified:**
1. [Root cause or key finding]
2. [Second finding]

**What I did:**
- [Specific action + tool used]
- [Specific action + why I chose that approach]
- [Specific action + what it solved]

**Result:**
- [Metric: time/cost/reliability improvement]
- [Business impact if relevant]

Use real tools, real numbers, real decisions. Sound like someone who actually did this. No generic filler.`;

    case "concept":
      return `You are a senior engineer explaining a technical concept in a live interview.

Format:

Open with 1–2 sentences: direct definition + why it matters in production. Do NOT start with "Great question" or preamble.

Then explain clearly — use plain language first, then go technical.

If the concept has types or variants, explain each with:
- What it does
- When to use it
- A concrete example (table, scenario, or diagram if helpful)

Then pivot to your real-world experience:
"In my projects, I used/handled this by..."
- [Specific tool or approach you used]
- [What problem it solved]
- [Result or trade-off]

End with a 1-sentence summary of the core insight.

Do NOT use rigid section headers like "Short Answer:" or "Technical Depth:". Write naturally like a real explanation.`;

    case "debug":
      return `You are a senior engineer debugging a production issue in a live interview.

Format:

Open with 1 sentence identifying the most likely failure category (don't guess randomly — reason from context).

Then walk through your investigation process step by step:

**1️⃣ [First thing to check]**
[Why you check this first]
- [Specific action: command, log, tool]
- [What you look for]

**2️⃣ [Second investigation step]**
[Reasoning]
- [Specific action]
- [What it reveals]

**3️⃣ [Third step if relevant]**

**Root cause categories to rule out:**
- [Category 1]: [how to confirm]
- [Category 2]: [how to confirm]

**How I would fix it:**
- [Fix 1]
- [Fix 2]

Sound methodical, not guessing. Reference real tools (git, logs, CI dashboards, DB explain plans, etc.).`;

    case "behavioral":
      return `You are answering a behavioral/HR interview question using the Situation–Action–Result structure.

Format:

**Situation:** [2–3 sentences — context, team size, what was at stake]

**Action:**
- [What I specifically did — not "we"]
- [Tool or method I used]
- [Why I chose that approach]
- [How I handled pushback or challenge if any]

**Result:**
- [Measurable outcome]
- [What I learned or improved]

Keep it authentic, confident, and concise. First-person. No filler phrases like "That's a great question" or "I am a team player."`;

    case "quick":
      return `You are a senior engineer answering a quick technical question in an interview.

Give a direct, confident answer in 2–4 sentences first.

If useful, add a brief "In practice..." note with a real-world example or trade-off.

Do not over-explain. Do not use headers or bullet points unless there are genuinely multiple distinct items to compare.`;

    default:
      return `You are a senior engineer answering in a live technical interview.

Lead with a 1–2 sentence direct answer — no preamble.

Then explain with appropriate depth based on what the question needs:
- Concepts → definition + real-world use + your experience
- Experience → story format with problem → action → result
- Code → working code first, then explanation
- Debug → investigation steps + root cause reasoning

Use specific tools, real numbers, and practical trade-offs. Sound like someone who has actually done this work.`;
  }
}

/* -------------------------------------------------------------------------- */
/* RESUME EXTRACTION                                                          */
/* -------------------------------------------------------------------------- */

function guessExtAndMime(file) {
  const name = (file?.filename || "").toLowerCase();
  const mime = (file?.mime || "").toLowerCase();
  if (name.endsWith(".pdf") || mime.includes("pdf")) return { ext: "pdf", mime: "application/pdf" };
  if (name.endsWith(".docx") || mime.includes("wordprocessingml")) return { ext: "docx", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" };
  if (name.endsWith(".txt") || mime.includes("text/plain")) return { ext: "txt", mime: "text/plain" };
  return { ext: "bin", mime: "application/octet-stream" };
}

async function extractResumeText(file) {
  if (!file?.buffer || file.buffer.length < 20) return "";
  const { ext } = guessExtAndMime(file);
  if (ext === "txt") return file.buffer.toString("utf8");
  if (ext === "docx") {
    try { const out = await mammoth.extractRawText({ buffer: file.buffer }); return String(out?.value || ""); }
    catch (e) { return `[DOCX error] ${e?.message || ""}`; }
  }
  if (ext === "pdf") {
    try { const out = await pdfParse(file.buffer); return String(out?.text || ""); }
    catch (e) { return `[PDF error] ${e?.message || ""}`; }
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

    if (req.method === "GET" && (path === "" || path === "healthcheck")) {
      return res.status(200).json({ ok: true, time: new Date().toISOString() });
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

    if (path === "auth/signup") {
      if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
      const { name, phone, email, password } = await readJson(req);
      if (!name || !email || !password) return res.status(400).json({ error: "Missing fields" });
      const sb = supabaseAnon();
      const redirectTo = `${originFromReq(req)}/auth?tab=login`;
      const { data, error } = await sb.auth.signUp({ email, password, options: { emailRedirectTo: redirectTo } });
      if (error) return res.status(400).json({ error: error.message });
      await supabaseAdmin().from("user_profiles").insert({ id: data?.user?.id, name, phone: phone || "", email, approved: false, credits: 0, created_at: new Date().toISOString() });
      return res.json({ ok: true, message: "Account created. Verify email + wait for approval." });
    }

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
      return res.json({ ok: true, session: { is_admin: false, access_token: data.session.access_token, refresh_token: data.session.refresh_token, expires_at: data.session.expires_at, user: { id: user.id, email: user.email } } });
    }

    if (path === "auth/refresh") {
      if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
      const { refresh_token } = await readJson(req);
      if (!refresh_token) return res.status(400).json({ error: "Missing refresh_token" });
      const sb = supabaseAnon();
      const { data, error } = await sb.auth.refreshSession({ refresh_token });
      if (error) return res.status(401).json({ error: error.message });
      return res.json({ ok: true, session: { access_token: data.session.access_token, refresh_token: data.session.refresh_token, expires_at: data.session.expires_at } });
    }

    if (path === "auth/forgot") {
      const { email } = await readJson(req);
      const redirectTo = `${originFromReq(req)}/auth?tab=login`;
      await supabaseAnon().auth.resetPasswordForEmail(email, { redirectTo });
      return res.json({ ok: true });
    }

    if (path === "user/profile") {
      const gate = await getUserFromBearer(req);
      if (!gate.ok) return res.status(401).json({ error: gate.error });
      const profile = await supabaseAdmin().from("user_profiles").select("id,name,email,phone,approved,credits,created_at").eq("id", gate.user.id).single();
      if (!profile.data) return res.status(404).json({ error: "Profile not found" });
      return res.json({ ok: true, user: { ...profile.data, created_ymd: ymd(profile.data.created_at) } });
    }

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
              transcription: { model: "gpt-4o-mini-transcribe", language: "en", prompt: "Transcribe exactly what is spoken. Do NOT add new words. Do NOT repeat phrases. Do NOT translate. Keep punctuation minimal. If uncertain, omit." },
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

    if (path === "resume/extract") {
      if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
      const { file } = await readMultipart(req);
      if (!file?.buffer) return res.json({ text: "" });
      const text = await extractResumeText(file);
      return res.json({ text: String(text || "") });
    }

    if (path === "transcribe") {
      if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
      const { fields, file } = await readMultipart(req);
      if (!file?.buffer || file.buffer.length < 2500) return res.json({ text: "" });
      try {
        const filename = file.filename || "audio.webm";
        const mime = (file.mime || "audio/webm").split(";")[0];
        const audioFile = await toFile(file.buffer, filename, { type: mime });
        const basePrompt = "Transcribe EXACTLY what is spoken in English. Do NOT translate. Do NOT add filler words. Do NOT invent speakers. Do NOT repeat earlier sentences. If silence/no speech, return empty.";
        const userPrompt = String(fields?.prompt || "").slice(0, 500);
        const finalPrompt = (basePrompt + (userPrompt ? "\n\nContext:\n" + userPrompt : "")).slice(0, 800);
        const out = await openai.audio.transcriptions.create({ file: audioFile, model: "gpt-4o-transcribe", language: "en", temperature: 0, response_format: "json", prompt: finalPrompt });
        return res.json({ text: out.text || "" });
      } catch (e) {
        const status = e?.status || e?.response?.status || 500;
        return res.status(status).json({ error: e?.message || String(e) });
      }
    }

    /* ------------------------------------------------------- */
    /* CHAT SEND — DYNAMIC TEMPLATE ENGINE                     */
    /* ------------------------------------------------------- */
    if (path === "chat/send") {
      if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

      const { prompt, instructions, resumeText, history, sessionId, roleType, roleText, yearsExp } = await readJson(req);
      if (!prompt) return res.status(400).json({ error: "Missing prompt" });

      // Stream headers
      res.setHeader("Content-Type", "text/markdown; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("Transfer-Encoding", "chunked");
      res.flushHeaders?.();
      res.write("\u200B");

      const messages = [];

      // ── STEP 1: Classify the question to pick the right response template ──
      const questionType = classifyQuestion(prompt);

      // ── STEP 2: Apply the dynamic system prompt for this question type ──
      messages.push({
        role: "system",
        content: buildDynamicSystemPrompt(questionType)
      });

      // ── STEP 3: Optional caller instructions (only for non-code/sql) ──
      const isStructuredType = questionType === "code" || questionType === "sql";
      if (!isStructuredType && instructions?.trim()) {
        messages.push({ role: "system", content: instructions.trim().slice(0, 3000) });
      }

      // ── STEP 4: Role-specific overlay ──
      const normalizedRoleType = normalizeRoleType(roleType, roleText);
      if (!isStructuredType) {
        const roleOverlays = {
          "java-backend": "Interview focus: Java backend / Spring Boot / microservices. Prioritize Spring ecosystem, REST APIs, Kafka, Redis caching, DB indexing, thread pools, performance, resilience (timeouts/circuit breaker), and production debugging.",
          "data-engineer": "Interview focus: Data Engineering. Prioritize ETL pipelines, ingestion, partitioning, parallel processing, data quality, orchestration, warehouse optimization (Snowflake/Databricks), batch vs streaming trade-offs.",
          "qa-automation": "Interview focus: QA Automation. Prioritize framework design, UI/API automation strategy, CI/CD integration, flaky test reduction, environment issues, test data management, coverage metrics, release validation.",
          "cloud-architect": "Interview focus: Cloud / Solution Architecture. Prioritize AWS/Azure architecture, scalability, IAM/security, high availability, observability, cost-performance trade-offs, migration decisions.",
          "genai": "Interview focus: GenAI / LLM systems. Prioritize RAG architecture, embeddings, retrieval quality, latency, prompt orchestration, evaluation, hallucination controls, and production reliability."
        };
        if (roleOverlays[normalizedRoleType]) {
          messages.push({ role: "system", content: roleOverlays[normalizedRoleType] });
        }
      }

      // ── STEP 5: Years of experience context ──
      const yrs = Number(yearsExp || 0);
      if (!isStructuredType && Number.isFinite(yrs) && yrs > 0) {
        messages.push({ role: "system", content: `Candidate positioning: answer at the depth and ownership expected from a ${yrs}-year experienced engineer.` });
      }

      // ── STEP 6: Free-text role hint ──
      if (!isStructuredType && String(roleText || "").trim()) {
        messages.push({ role: "system", content: `Target interview role: ${String(roleText).trim().slice(0, 120)}. Bias examples toward this role when relevant.` });
      }

      // ── STEP 7: Resume personalization ──
      let resumeSummary = "";
      if (resumeText?.trim()) {
        resumeSummary = await getResumeSummary(resumeText);
        if (sessionId) SESSION_CACHE.set(sessionId, { resumeSummary });
      } else if (sessionId && SESSION_CACHE.has(sessionId)) {
        resumeSummary = SESSION_CACHE.get(sessionId).resumeSummary;
      }

      if (resumeSummary) {
        messages.push({
          role: "system",
          content: `══════════════════════════════════════════
CANDIDATE RESUME CONTEXT
══════════════════════════════════════════
${resumeSummary}
══════════════════════════════════════════

Use this resume when the question relates to the candidate's experience:
- Use their actual companies, projects, tools, and achievements.
- Use exact technologies from the resume — no substitutions.
- Use real metrics/numbers from the resume if they fit.
- If the question is unrelated to resume, answer generically but senior-level.
- Do NOT invent companies, projects, or achievements not in the resume.`
        });
      } else {
        messages.push({ role: "system", content: "No resume provided. Give senior-level answers with practical production examples, real tools, trade-offs, and measurable impact." });
      }

      // ── STEP 8: Conversation history ──
      const hist = safeHistory(history);
      if (!isStructuredType && hist.length && isFollowUpPrompt(String(prompt || ""))) {
        const ctx = buildContextPack(hist);
        if (ctx) messages.push({ role: "system", content: ctx });
      }
      for (const m of hist) messages.push(m);

      // ── STEP 9: User prompt ──
      messages.push({ role: "user", content: String(prompt).slice(0, 7000).trim() });

      // ── STEP 10: Stream response ──
      const stream = await openai.chat.completions.create({
        model: "gpt-4o",
        stream: true,
        temperature: questionType === "code" || questionType === "sql" ? 0.1 : 0.35,
        max_tokens: questionType === "experience" ? 1800 : 1600,
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

    if (path === "chat/reset") return res.json({ ok: true });

    if (path === "admin/users") {
      const gate = requireAdmin(req);
      if (!gate.ok) return res.status(401).json({ error: gate.error });
      const { data } = await supabaseAdmin().from("user_profiles").select("id,name,email,phone,approved,credits,created_at").order("created_at", { ascending: false });
      return res.json({ users: data });
    }

    if (path === "admin/approve") {
      const gate = requireAdmin(req);
      if (!gate.ok) return res.status(401).json({ error: gate.error });
      const { user_id, approved } = await readJson(req);
      const { data } = await supabaseAdmin().from("user_profiles").update({ approved }).eq("id", user_id).select().single();
      return res.json({ ok: true, user: data });
    }

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