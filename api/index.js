import Busboy from "busboy";
import OpenAI from "openai";
import { toFile } from "openai/uploads";
import { supabaseAnon, supabaseAdmin } from "../_utils/supabaseClient.js";
import { requireAdmin } from "../_utils/adminAuth.js";

// STATIC IMPORTS (Vercel-safe)
import mammoth from "mammoth";
import pdfParse from "pdf-parse";

/* -------------------------------------------------------------------------- */
/* CONFIG                                                                     */
/* -------------------------------------------------------------------------- */
export const config = {
  runtime: "nodejs",
  api: {
    bodyParser: false,
    responseLimit: false,
    externalResolver: true
  }
};

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/* -------------------------------------------------------------------------- */
/* QUESTION INTENT DETECTION (BACKEND AUTHORITY)                               */
/* -------------------------------------------------------------------------- */

function isExplanationQuestion(q = "") {
  const s = q.toLowerCase().trim();
  return (
    s.startsWith("explain") ||
    s.startsWith("what is") ||
    s.startsWith("how does") ||
    s.startsWith("why") ||
    s.includes("architecture") ||
    s.includes("design") ||
    s.includes("lifecycle") ||
    s.includes("internals") ||
    s.includes("class loader")
  );
}

function isCodeQuestion(q = "") {
  const s = q.toLowerCase();
  if (isExplanationQuestion(s)) return false;

  const verbs = [
    "write",
    "implement",
    "create",
    "build",
    "program",
    "show code",
    "give code",
    "example program"
  ];

  const signals = [
    "code",
    "algorithm",
    "function",
    "method",
    "()",
    "{}",
    "for(",
    "while(",
    "if("
  ];

  return verbs.some(v => s.includes(v)) || signals.some(v => s.includes(v));
}

/* -------------------------------------------------------------------------- */
/* SYSTEM PROMPTS (GLOBAL — DO NOT MOVE INSIDE HANDLER)                        */
/* -------------------------------------------------------------------------- */

const baseSystem = `
You are answering a REAL technical interview question.

Your response MUST sound like a senior professional speaking confidently in an interview.

MANDATORY OPENING (NON-NEGOTIABLE):
- The first sentence MUST clearly take a position.
- Examples:
  - "Yes, I’ve worked extensively with..."
  - "I’ve primarily been responsible for..."
  - "I’ve worked with both, but most of my experience is in..."
- Do NOT start with phrases like:
  "I believe", "I’ve had the opportunity", "In my experience", "Generally".

ANSWERING STYLE:
- Speak in first person.
- Sound direct, confident, and practical.
- Avoid academic or essay-style language.
- Avoid filler or polite hedging.

DEPTH RULES:
- After the opening, explain HOW and WHY.
- If you mention a tool, framework, or pattern, explain how you actually used it.
- If scale or leadership is implied, explain scope or impact briefly.

EXAMPLES (CRITICAL):
- Embed real project experience naturally.
- Do NOT label examples.
- Do NOT narrate chronologically.
- Focus on relevance, not storytelling.

HIGHLIGHTING RULES:
- Bold ONLY:
  - tools (e.g., **Selenium**, **Playwright**)
  - patterns (e.g., **POM**, **data-driven testing**)
  - scale or metrics (e.g., **40% reduction**, **10+ years**)
- Never bold full sentences or soft phrases.

FORMATTING:
- Question must appear once at the top as:
  Q: <expanded interview question>
- Use short paragraphs.
- Bullets only if they improve clarity.

STRICTLY AVOID:
- Section headers
- Numbered formats
- Coaching tone
- Generic claims not grounded in experience

Your goal is to sound like a real candidate answering live — clear, decisive, and experienced.
`.trim();

const CODE_FIRST_SYSTEM = `
You are answering a coding interview question.

MANDATORY OUTPUT ORDER:
1. FULL working code first
2. Inline comments for critical logic
3. Example input and output
4. Brief explanation after code

STRICT RULES:
- Never explain before showing code
- No essay-style answers
- Code must compile/run
- Use realistic variable names

FORMAT:
- Use fenced code blocks
- Explanation only after code
`.trim();

/* -------------------------------------------------------------------------- */
/* GENERIC HELPERS                                                             */
/* -------------------------------------------------------------------------- */

function setCors(req, res) {
  const origin = req.headers.origin || "*";
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", c => (body += c));
    req.on("end", () => resolve(body ? JSON.parse(body) : {}));
    req.on("error", reject);
  });
}

function safeHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .slice(-12)
    .filter(m => m?.role && typeof m?.content === "string")
    .map(m => ({ role: m.role, content: m.content.slice(0, 2000) }));
}

/* -------------------------------------------------------------------------- */
/* MAIN HANDLER                                                                */
/* -------------------------------------------------------------------------- */

export default async function handler(req, res) {
  try {
    setCors(req, res);
    if (req.method === "OPTIONS") return res.status(200).end();

    const url = new URL(req.url, "http://localhost");
    const path = (url.searchParams.get("path") || "").replace(/^\/+/, "");

    /* ------------------------------------------------------- */
    /* CHAT SEND                                              */
    /* ------------------------------------------------------- */
    if (path === "chat/send") {
      if (req.method !== "POST") {
        return res.status(405).json({ error: "Method not allowed" });
      }

      const { prompt, instructions, resumeText, history } = await readJson(req);
      if (!prompt) return res.status(400).json({ error: "Missing prompt" });

      // STREAM-SAFE HEADERS
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("Transfer-Encoding", "chunked");
      res.flushHeaders?.();
      res.write(" ");

      const codeMode = isCodeQuestion(prompt);
      const messages = [];

      // 🔒 EXACTLY ONE SYSTEM PROMPT
      messages.push({
        role: "system",
        content: codeMode ? CODE_FIRST_SYSTEM : baseSystem
      });

      // Custom instructions ONLY for non-code
      if (!codeMode && instructions?.trim()) {
        messages.push({
          role: "system",
          content: instructions.trim().slice(0, 4000)
        });
      }

      if (resumeText?.trim()) {
        messages.push({
          role: "system",
          content:
            "Use this resume context when answering. Do not invent details.\n\n" +
            resumeText.trim().slice(0, 12000)
        });
      }

      for (const m of safeHistory(history)) messages.push(m);
      messages.push({ role: "user", content: prompt.slice(0, 8000) });

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

    return res.status(404).json({ error: `No route: /api/${path}` });
  } catch (err) {
    return res.status(500).json({ error: String(err?.message || err) });
  }
}
