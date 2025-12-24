/**
 * ChatTok Builder API (Render)
 * - Endpoints: /health, /api/plan, /api/generate, /api/edit
 * - Uses OpenAI Responses API with Structured Outputs. If OpenAI fails or times out,
 *   returns a safe, polished baseline from our templates (no blank screens).
 *
 * Security: No secrets leak to clients. CORS restricted via env.
 */

const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
require("dotenv").config();

const app = express();
app.use(express.json({ limit: "1mb" }));

// ---------------------------
// 1) CORS (stable + preflight)
// ---------------------------
const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const corsOptions = {
  origin: function (origin, cb) {
    if (!origin) return cb(null, true);
    if (allowedOrigins.length === 0) return cb(null, true);
    if (allowedOrigins.includes(origin)) return cb(null, true);
    return cb(new Error("CORS blocked: " + origin));
  },
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  optionsSuccessStatus: 204
};

app.use(cors(corsOptions));
app.options("*", cors(corsOptions));

// ---------------------------
// 2) Config
// ---------------------------
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL_DEFAULT = process.env.OPENAI_MODEL || "gpt-4o-mini";
const OPENAI_TIMEOUT_MS = Number.parseInt(process.env.OPENAI_TIMEOUT_MS || "35000", 10);

function assert(cond, msg) { if (!cond) throw new Error(msg || "Assertion failed"); }

function safeJson(obj) {
  try { return JSON.stringify(obj); } catch { return '"[unserializable]"'; }
}

// ---------------------------
// 3) OpenAI (Responses API)
// ---------------------------
function extractAssistantText(respJson) {
  if (!respJson) return "";
  if (typeof respJson.output_text === "string") return respJson.output_text;

  const out = respJson.output;
  if (!Array.isArray(out)) return "";
  const texts = [];
  for (const item of out) {
    if (!item || item.type !== "message") continue;
    const content = item.content;
    if (!Array.isArray(content)) continue;
    for (const c of content) {
      if (c && c.type === "output_text" && typeof c.text === "string") texts.push(c.text);
    }
  }
  return texts.join("\n").trim();
}

function parseJsonLoose(text) {
  if (typeof text !== "string") return null;
  const t = text.trim();
  if (!t) return null;

  const fenceMatch = t.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const candidate = fenceMatch ? fenceMatch[1].trim() : t;

  try { return JSON.parse(candidate); }
  catch {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try { return JSON.parse(candidate.slice(start, end + 1)); } catch { return null; }
    }
    return null;
  }
}

async function callOpenAIResponses({ apiKey, model, maxOutputTokens = 900, temperature = 0.2, prompt, schemaName, schema }) {
  const key = apiKey || OPENAI_API_KEY;
  if (!key) { const err = new Error("OPENAI_API_KEY is missing on the server"); err.status = 503; throw err; }

  const endpoint = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1/responses").trim();

  const body = {
    model: model || OPENAI_MODEL_DEFAULT,
    store: false,
    temperature,
    max_output_tokens: maxOutputTokens,
    input: [{ role: "user", content: String(prompt || "") }]
  };

  if (schema) {
    body.text = {
      format: { type: "json_schema", name: schemaName || "structured_output", strict: true, schema }
    };
  }

  const controller = new AbortController();
  const to = setTimeout(() => controller.abort(), OPENAI_TIMEOUT_MS);

  let r;
  try {
    r = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      signal: controller.signal
    });
  } catch (e) {
    const err = new Error(e && e.name === "AbortError"
      ? `OpenAI request timed out after ${OPENAI_TIMEOUT_MS}ms`
      : "OpenAI request failed (network/transport error)");
    err.status = e && e.name === "AbortError" ? 504 : 502;
    err.cause = e;
    throw err;
  } finally {
    clearTimeout(to);
  }

  let json;
  try { json = await r.json(); }
  catch (e) { const err = new Error("OpenAI response was not valid JSON"); err.status = 502; err.cause = e; throw err; }

  if (!r.ok) { const err = new Error("OpenAI error"); err.status = r.status; err.details = json; throw err; }
  return json;
}

// ---------------------------
// 4) Templates
// ---------------------------
function resolveTemplatePath(filename) {
  const base = process.env.TEMPLATE_DIR ? path.resolve(process.env.TEMPLATE_DIR) : path.resolve(__dirname);
  return path.join(base, filename);
}
function readTemplate(filename) {
  const p = resolveTemplatePath(filename);
  assert(fs.existsSync(p), `Template not found: ${filename} at ${p}`);
  return fs.readFileSync(p, "utf8");
}
let TPL_INDEX = "", TPL_STYLE = "", TPL_GAME = "";
function loadTemplates() {
  TPL_INDEX = readTemplate("index.template.html");
  TPL_STYLE = readTemplate("style.template.css");
  TPL_GAME = readTemplate("game.template.js");
}
loadTemplates();

// ---------------------------
// 5) Schemas
// ---------------------------
const PLAN_SCHEMA = {
  type: "object", additionalProperties: false,
  properties: {
    title: { type: "string" },
    genre: { type: "string" },
    oneLiner: { type: "string" },
    coreLoop: { type: "string" },
    entities: { type: "array", items: { type: "string" } },
    controls: {
      type: "object", additionalProperties: false,
      properties: {
        chat: { type: "string" }, gifts: { type: "string" }, likes: { type: "string" }, joins: { type: "string" }
      }, required: ["chat", "gifts", "likes", "joins"]
    },
    ui: {
      type: "object", additionalProperties: false,
      properties: { theme: { type: "string" }, hud: { type: "string" }, feedback: { type: "string" } },
      required: ["theme", "hud", "feedback"]
    },
    safety: {
      type: "object", additionalProperties: false,
      properties: {
        noExternalSecrets: { type: "boolean" }, noProtoBundle: { type: "boolean" }, notes: { type: "string" }
      }, required: ["noExternalSecrets", "noProtoBundle", "notes"]
    }
  },
  required: ["title", "genre", "oneLiner", "coreLoop", "entities", "controls", "ui", "safety"]
};

const FILE_PACKAGE_SCHEMA = {
  type: "object", additionalProperties: false,
  properties: { indexHtml: { type: "string" }, styleCss: { type: "string" }, gameJs: { type: "string" } },
  required: ["indexHtml", "styleCss", "gameJs"]
};

const EDIT_SCHEMA = {
  type: "object", additionalProperties: false,
  properties: { indexHtml: { type: "string" }, styleCss: { type: "string" }, gameJs: { type: "string" }, notes: { type: "string" } },
  required: ["indexHtml", "styleCss", "gameJs", "notes"]
};

// ---------------------------
// 6) Validation helpers
// ---------------------------
function normalizePlan(plan) {
  assert(plan && typeof plan === "object", "Plan must be an object");
  assert(typeof plan.title === "string" && plan.title.trim(), "Plan.title required");
  assert(typeof plan.coreLoop === "string" && plan.coreLoop.trim(), "Plan.coreLoop required");
  assert(Array.isArray(plan.entities), "Plan.entities must be array");
  return plan;
}
function validatePlan(maybePlan) { return normalizePlan(maybePlan); }
function validateFilePackage(pkg) {
  assert(pkg && typeof pkg === "object", "Package must be an object");
  assert(typeof pkg.indexHtml === "string" && pkg.indexHtml.length > 10, "indexHtml missing");
  assert(typeof pkg.styleCss === "string" && pkg.styleCss.length > 10, "styleCss missing");
  assert(typeof pkg.gameJs === "string" && pkg.gameJs.length > 10, "gameJs missing");
  return pkg;
}

// ---------------------------
// 7) Rendering helpers (fallbacks + theming)
// ---------------------------
function applyThemeVars(css, theme) {
  const t = theme || {};
  const primary = t.primary || "#ff0050";
  const secondary = t.secondary || "#00f2ea";
  const background = t.background || "#050b17";
  return String(css)
    .replaceAll("__THEME_PRIMARY__", primary)
    .replaceAll("__THEME_SECONDARY__", secondary)
    .replaceAll("__THEME_BACKGROUND__", background);
}

function renderIndex(spec, theme) {
  const s = spec || {};
  const howTo = Array.isArray(s.howTo) ? s.howTo : [
    "Type JOIN to enter the match.",
    "Use chat commands to act. Likes charge power, gifts trigger boosts."
  ];
  const li = howTo.map(item => `<li>${String(item)}</li>`).join("\n");

  return TPL_INDEX
    .replaceAll("{{TITLE}}", String(s.title || "ChatTok Game"))
    .replaceAll("{{ONE_SENTENCE}}", String(s.oneLiner || "Fast-paced TikTok LIVE game."))
    .replaceAll("{{SUBTITLE}}", String(s.coreLoop || "Play via chat. Likes power up, gifts trigger boosts."))
    .replaceAll("{{HOW_TO_PLAY_LI}}", li)
    .replaceAll("{{MODE_BADGE}}", "LIVE");
}

function renderStyle(theme) {
  return applyThemeVars(TPL_STYLE, theme);
}

function renderGame(spec) {
  const specJson = safeJson(spec || {});
  return TPL_GAME.replace("__SPEC_JSON__", specJson);
}

function sanitizeCss(css) {
  // Minimal pragmatic sanitizer for known corruption shapes
  let out = String(css || "");
  out = out.replace(/body\s*\{[^}]*body\s*\{/gi, "body {");
  out = out.replace(/:root\s*\{([^}]*)\}:root\s*\{/gi, ":root{$1}");
  // best-effort balance (truncate trailing unmatched brace runs)
  const open = (out.match(/\{/g) || []).length;
  const close = (out.match(/\}/g) || []).length;
  if (close > open) {
    // drop extra trailing braces
    let extra = close - open;
    out = out.replace(/\}$/g, m => (extra-- > 0 ? "" : m));
  }
  return out;
}

// ---------------------------
// 8) Routes
// ---------------------------
app.get("/health", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json({
    ok: true,
    service: "chattok-builder-api",
    modelDefault: OPENAI_MODEL_DEFAULT,
    hasOpenAIKey: Boolean(OPENAI_API_KEY),
    templatesLoaded: Boolean(TPL_INDEX && TPL_STYLE && TPL_GAME)
  });
});

app.get("/api/plan", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json({ ok: true, message: "POST your prompt to /api/plan" });
});

app.post("/api/plan", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  try {
    const { prompt, theme } = req.body || {};
    assert(typeof prompt === "string" && prompt.trim(), "Missing prompt");

    const planPrompt = `
You are generating a plan/spec for a TikTok LIVE interactive HTML5 game.
Keep it concise but very actionable, and ensure the game is NOT a blank screen.

User prompt:
${prompt}

Theme preference (optional):
${theme || "none"}

Rules:
- Must be 9:16 mobile-first.
- Must work even without TikTok connected (demo loop locally).
- Generated games will connect using a provided tiktok-client.js (DO NOT reference editing it).
- Avoid external secrets. No API keys in output.
- Avoid requesting proto.bundle.js. Assume platform provides what it provides; game must fail gracefully if TikTok isn't available.

Return JSON matching the schema exactly.
`.trim();

    let plan;
    try {
      const resp = await callOpenAIResponses({
        prompt: planPrompt,
        schemaName: "game_plan",
        schema: PLAN_SCHEMA,
        maxOutputTokens: 650,
        temperature: 0.2
      });
      const text = extractAssistantText(resp);
      const parsed = parseJsonLoose(text) || resp.output_parsed || null;
      plan = validatePlan(parsed);
    } catch (e) {
      // Fallback minimal plan to avoid 500s
      plan = validatePlan({
        title: "ChatTok Arena",
        genre: "Arcade",
        oneLiner: "Join via chat, fire with a command; likes charge power, gifts trigger boosts.",
        coreLoop: "Players join and use commands to attack targets while likes/gifts influence power-ups.",
        entities: ["player", "meteor", "shot", "explosion"],
        controls: { chat: "join + action commands", gifts: "power boosts", likes: "charge meter", joins: "create player" },
        ui: { theme: "dark neon", hud: "score/players/likes/gifts", feedback: "pops + flags" },
        safety: { noExternalSecrets: true, noProtoBundle: true, notes: "No external libs, no secrets" }
      });
    }

    res.json({ ok: true, plan });
  } catch (err) {
    console.error("/api/plan error:", err?.message || err, err?.details || "");
    res.status(err.status || 500).json({ ok: false, error: err.message || "Server error", details: err.details || null });
  }
});

app.post("/api/generate", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  try {
    const { prompt, plan, theme } = req.body || {};
    assert(typeof prompt === "string" && prompt.trim(), "Missing prompt");
    assert(plan && typeof plan === "object", "Missing plan (object)");

    const generationPrompt = `
You are generating a complete, production-ready 3-file HTML game package:
- index.html
- style.css
- game.js

Context:
- The game will run inside ChatTokGaming preview/live environment.
- DO NOT include any secrets.
- Do NOT edit or assume contents of tiktok-client.js. It will be injected by the platform.
- Use window.CHATTOK_CREATOR_TOKEN if present when connecting.
- Must render a real game instantly (entities visible, motion, HUD).
- Must be 9:16 mobile-first and look good in a TikTok LIVE overlay.

User prompt:
${prompt}

Theme preference:
${theme || "none"}

Plan/spec:
${safeJson(plan)}

You must embed clear, short instructions inside the UI (non-blocking), and implement meaningful gameplay mapping:
- chat: player actions (join/aim/attack/vote/etc)
- likes: meter/charge/spawn
- gifts: powerups or effects
- join: creates/updates player entity

Return JSON with three strings: indexHtml, styleCss, gameJs.
`.trim();

    let pkg;
    try {
      const resp = await callOpenAIResponses({
        prompt: generationPrompt,
        schemaName: "file_package",
        schema: FILE_PACKAGE_SCHEMA,
        maxOutputTokens: 2400,
        temperature: 0.25
      });
      const text = extractAssistantText(resp);
      const parsed = parseJsonLoose(text) || resp.output_parsed || null;
      pkg = validateFilePackage(parsed);
      // Guardrail CSS
      pkg.styleCss = sanitizeCss(pkg.styleCss);
    } catch (e) {
      // Guaranteed baseline fallback (templates)
      pkg = {
        indexHtml: renderIndex(plan, theme),
        styleCss: renderStyle(theme),
        gameJs: renderGame(plan)
      };
    }

    // Basic hardening
    assert(pkg.indexHtml.includes("<html") || pkg.indexHtml.includes("<!doctype"), "indexHtml seems invalid");
    assert(pkg.styleCss.includes("{") || pkg.styleCss.includes(":root"), "styleCss seems invalid");
    assert(pkg.gameJs.includes("function") || pkg.gameJs.includes("const"), "gameJs seems invalid");

    res.json({ ok: true, files: pkg });
  } catch (err) {
    console.error("/api/generate error:", err?.message || err, err?.details || "");
    // As a last-resort, still try to return the baseline if plan exists
    try {
      const { plan, theme } = req.body || {};
      if (plan && typeof plan === "object") {
        const pkg = {
          indexHtml: renderIndex(plan, theme),
          styleCss: renderStyle(theme),
          gameJs: renderGame(plan)
        };
        return res.status(200).json({ ok: true, files: pkg });
      }
    } catch {}
    res.status(err.status || 500).json({ ok: false, error: err.message || "Server error", details: err.details || null });
  }
});

app.post("/api/edit", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  try {
    const { prompt, currentFiles } = req.body || {};
    assert(typeof prompt === "string" && prompt.trim(), "Missing edit prompt");
    assert(currentFiles && typeof currentFiles === "object", "Missing currentFiles");

    const { indexHtml, styleCss, gameJs } = currentFiles;
    assert(typeof indexHtml === "string", "currentFiles.indexHtml missing");
    assert(typeof styleCss === "string", "currentFiles.styleCss missing");
    assert(typeof gameJs === "string", "currentFiles.gameJs missing");

    const editPrompt = `
You are editing a 3-file HTML5 game package for ChatTokGaming.
Make ONLY the requested improvements. Keep the TikTok connection example pattern intact if present.
Do NOT add external dependencies. Do NOT add secrets.

Edit request:
${prompt}

Current index.html:
<<<
${indexHtml}
>>>

Current style.css:
<<<
${styleCss}
>>>

Current game.js:
<<<
${gameJs}
>>>

Return JSON with updated: indexHtml, styleCss, gameJs, and a short notes string describing what changed.
`.trim();

    let parsed;
    try {
      const resp = await callOpenAIResponses({
        prompt: editPrompt,
        schemaName: "edit_package",
        schema: EDIT_SCHEMA,
        maxOutputTokens: 2400,
        temperature: 0.2
      });
      const text = extractAssistantText(resp);
      parsed = parseJsonLoose(text) || resp.output_parsed || null;

      assert(parsed && typeof parsed === "object", "Edit response not parsed");
      assert(typeof parsed.indexHtml === "string", "Edited indexHtml missing");
      assert(typeof parsed.styleCss === "string", "Edited styleCss missing");
      assert(typeof parsed.gameJs === "string", "Edited gameJs missing");
      assert(typeof parsed.notes === "string", "Edited notes missing");
      parsed.styleCss = sanitizeCss(parsed.styleCss);
    } catch (e) {
      // Safe no-op: return the same files with a note if edit AI fails
      parsed = { indexHtml, styleCss: sanitizeCss(styleCss), gameJs, notes: "No changes (edit AI failed)."};
    }

    res.json({ ok: true, files: parsed });
  } catch (err) {
    console.error("/api/edit error:", err?.message || err, err?.details || "");
    res.status(err.status || 500).json({ ok: false, error: err.message || "Server error", details: err.details || null });
  }
});

// ---------------------------
// 9) Start server (ONE listen)
// ---------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`ChatTok Builder API listening on :${PORT}`);
  console.log(`CORS allowedOrigins: ${allowedOrigins.join(", ") || "(dev default: allow all)"}`);
});
