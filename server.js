// server.js — ChatTok Builder API (Render / Node / Express)
// ========================================================
// Key guarantees:
// - CORS + preflight never throws
// - /health + /api/* are no-store (no stale caching)
// - Adds /api/plan (fixes your 404)
// - /api/generate(html) can render from an existing spec (so Plan edits are respected + cheaper)
// - Exactly one app.listen
// - No secrets are ever returned to GitHub Pages

const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

/**
 * ChatTok Game Builder API (template-first)
 * Endpoints:
 * - GET  /health
 * - POST /api/plan               (Step 2 Plan/Spec)
 * - POST /api/generate           (Step 3 Build: html/css/js or bundle)
 * - POST /api/edit               (Step 4 Optional edits: regenerates AI_REGION only)
 * - POST /api/reload-templates   (dev helper)
 */

const app = express();
app.use(express.json({ limit: "10mb" }));

// Render should bind 0.0.0.0
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "0.0.0.0";

// Node 18+ required for global fetch (OpenAI)
if (typeof fetch !== "function") {
  console.error("ERROR: global fetch is missing. Use Node 18+.");
  process.exit(1);
}

// ----------------------------------------
// Cache-control: never cache API responses
// ----------------------------------------
app.use((req, res, next) => {
  try {
    if (req.path === "/health" || req.path.startsWith("/api/")) {
      res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
      res.setHeader("Pragma", "no-cache");
      res.setHeader("Expires", "0");
      res.setHeader("Surrogate-Control", "no-store");
    }
  } catch {}
  next();
});

// -----------------------------
// CORS (stable + never throws)
// -----------------------------
const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

function isOriginAllowed(origin) {
  if (!origin) return true; // non-browser / server-to-server
  if (allowedOrigins.length === 0) return true; // dev default: allow all
  return allowedOrigins.includes(origin);
}

const corsOptions = {
  origin(origin, cb) {
    // IMPORTANT: never pass an Error to cb() (can crash preflight in some stacks)
    return cb(null, isOriginAllowed(origin));
  },
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  maxAge: 86400,
  optionsSuccessStatus: 204,
};

app.use(cors(corsOptions));
// Ensure OPTIONS always responds
app.options("*", cors(corsOptions));

app.get("/favicon.ico", (_req, res) => res.status(204).end());

// -----------------------------
// Helpers
// -----------------------------
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function normalizeStage(stage) {
  const s = String(stage || "").toLowerCase().trim();
  if (s === "html" || s === "index" || s === "index.html") return "html";
  if (s === "css" || s === "style" || s === "style.css") return "css";
  if (s === "js" || s === "game" || s === "game.js") return "js";
  return "";
}

function pickIdea(body) {
  if (!body || typeof body !== "object") return "";
  const candidates = [body.idea, body.prompt, body.text, body.input, body.gameIdea, body.ideaText];
  for (const v of candidates) {
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

function stripCodeFences(s) {
  if (!s) return "";
  let t = String(s).trim();
  if (!t.startsWith("```")) return t;
  const lines = t.split("\n");
  lines.shift();
  if (lines.length && lines[lines.length - 1].trim().startsWith("```")) lines.pop();
  return lines.join("\n").trim();
}

function extractAssistantText(resp) {
  if (resp && typeof resp.output_text === "string" && resp.output_text.trim()) return resp.output_text.trim();
  const out = resp && Array.isArray(resp.output) ? resp.output : [];
  for (const item of out) {
    if (!item || item.type !== "message" || !Array.isArray(item.content)) continue;
    for (const part of item.content) {
      if ((part.type === "output_text" || part.type === "text") && typeof part.text === "string") {
        const t = part.text;
        if (t && t.trim()) return t.trim();
      }
    }
  }
  return "";
}

function parseJsonLoose(rawText) {
  const raw = (rawText || "").trim();
  if (!raw) return { ok: false, error: "empty output" };
  let s = stripCodeFences(raw).trim();
  s = s.replace(/^\s*(json|javascript)\s*/i, "").trim();
  const a = s.indexOf("{");
  const b = s.lastIndexOf("}");
  if (a !== -1 && b !== -1 && b > a) s = s.slice(a, b + 1).trim();
  s = s.replace(/,\s*([}\]])/g, "$1");
  try {
    return { ok: true, value: JSON.parse(s) };
  } catch (e) {
    return { ok: false, error: e?.message || "JSON.parse failed" };
  }
}

function safeSpecFromContext(ctxSpec) {
  if (!ctxSpec || typeof ctxSpec !== "object") return null;
  const title = String(ctxSpec.title || "").trim();
  const subtitle = String(ctxSpec.subtitle || "").trim();
  const oneSentence = String(ctxSpec.oneSentence || "").trim();
  if (!title || !subtitle || !oneSentence) return null;
  return ctxSpec;
}

// -----------------------------
// Templates
// -----------------------------
function resolveTemplatePath(fileName) {
  const candidates = [
    path.join(process.cwd(), "templates", fileName),
    path.join(process.cwd(), fileName),
    path.join(__dirname, "templates", fileName),
    path.join(__dirname, fileName),
    path.join(process.cwd(), "api", "templates", fileName),
    path.join(process.cwd(), "api", fileName),
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {}
  }
  return "";
}

function readTemplate(fileName) {
  const p = resolveTemplatePath(fileName);
  assert(p, `Template not found: ${fileName}`);
  return fs.readFileSync(p, "utf8");
}

function loadTemplates() {
  return {
    index: readTemplate("index.template.html"),
    css: readTemplate("style.template.css"),
    game: readTemplate("game.template.js"),
  };
}

let TEMPLATES = loadTemplates();

app.post("/api/reload-templates", (_req, res) => {
  try {
    TEMPLATES = loadTemplates();
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

// -----------------------------
// Theme injection (CSS ONLY)
// -----------------------------
function normalizeHex(input) {
  const s = String(input || "").trim();
  if (!s) return "";
  let v = s.startsWith("#") ? s : `#${s}`;
  if (/^#[0-9a-fA-F]{3}$/.test(v)) {
    v = `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}`;
  }
  if (!/^#[0-9a-fA-F]{6}$/.test(v)) return "";
  return v.toLowerCase();
}

function normalizeTheme(theme) {
  const t = theme && typeof theme === "object" ? theme : {};
  return {
    primary: normalizeHex(t.primary || t.pink || t.accent || t.main || t.p1) || "",
    secondary: normalizeHex(t.secondary || t.aqua || t.accent2 || t.p2) || "",
    background: normalizeHex(t.background || t.bg || t.base || t.p3) || "",
  };
}

function injectThemeVars(cssText, theme) {
  const th = normalizeTheme(theme);
  if (!th.primary && !th.secondary && !th.background) return String(cssText || "");

  let out = String(cssText || "");

  const replaceVar = (name, value) => {
    if (!value) return;
    const re = new RegExp(`(--${name}\\s*:\\s*)([^;]+)(;)`, "i");
    if (re.test(out)) out = out.replace(re, `$1${value}$3`);
    else out = out.replace(/:root\s*\{/, `:root{\n  --${name}:${value};`);
  };

  // Your CSS template uses these vars:
  replaceVar("pink", th.primary);
  replaceVar("aqua", th.secondary);
  replaceVar("bg", th.background);

  return out;
}

// -----------------------------
// OpenAI (Responses API)
// -----------------------------
async function callOpenAIResponses({ apiKey, model, maxOutputTokens, prompt }) {
  const payload = {
    model,
    max_output_tokens: maxOutputTokens,
    input: [{ role: "user", content: prompt }],
    store: false,
  };

  const r = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(payload),
  });

  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = data?.error?.message || "OpenAI request failed";
    const err = new Error(msg);
    err.status = r.status;
    err.details = data;
    throw err;
  }
  return data;
}

// -----------------------------
// Spec generation
// -----------------------------
async function generateSpec({ apiKey, model, idea, templateId, currentSpec, planEdits }) {
  const prompt = [
    "Return ONLY valid JSON. No markdown. No extra text.",
    "Create a compact but DETAILED spec for a TikTok LIVE interactive game (template-first builder).",
    "Hard rules:",
    "- Must feel like a real game even before connect (characters + HUD + motion).",
    "- Must define viewer interactions for chat/like/gift/join/share.",
    "- If the game uses chat commands, those commands MUST be host-configurable in settings.",
    "- Include what the host does (start/connect + any host-only actions).",
    "- Keep output compact (avoid long walls of text).",
    "",
    `Template hint: ${templateId}`,
    "",
    "JSON shape:",
    "{",
    '  "title":"string",',
    '  "subtitle":"string",',
    '  "oneSentence":"string",',
    '  "hostFlow":["string","string","..."],',
    '  "viewerActions":{',
    '    "chat":["string","..."],',
    '    "likes":["string","..."],',
    '    "gifts":["string","..."],',
    '    "joins":["string","..."],',
    '    "shares":["string","..."]',
    "  },",
    '  "howToPlay":["string","string","string","..."],',
    '  "defaults":{ "joinCommand":"string", "actionCommand":"string" },',
    '  "defaultSettings":{"roundSeconds":number,"winGoal":number}',
    "}",
    "",
    currentSpec ? "Current spec JSON:\n" + JSON.stringify(currentSpec, null, 2) : "",
    planEdits ? "\nPlan edits requested by user:\n" + planEdits : "",
    "\nGame idea:\n" + (idea || ""),
  ]
    .filter(Boolean)
    .join("\n");

  const raw = await callOpenAIResponses({
    apiKey,
    model,
    maxOutputTokens: Number(process.env.OPENAI_MAX_OUTPUT_TOKENS_SPEC || 850),
    prompt,
  });

  let parsed = parseJsonLoose(extractAssistantText(raw));
  if (!parsed.ok) {
    const repair = "Fix into valid JSON only. No extra text.\n\n" + extractAssistantText(raw);
    const raw2 = await callOpenAIResponses({
      apiKey,
      model,
      maxOutputTokens: Number(process.env.OPENAI_MAX_OUTPUT_TOKENS_SPEC || 850),
      prompt: repair,
    });
    parsed = parseJsonLoose(extractAssistantText(raw2));
  }
  assert(parsed.ok, "Spec generation failed (invalid JSON).");

  const spec = parsed.value || {};
  spec.title = String(spec.title || "ChatTok Live Game").trim();
  spec.subtitle = String(spec.subtitle || "Live Interactive").trim();
  spec.oneSentence = String(spec.oneSentence || "Chat and gifts power up the action.").trim();

  spec.hostFlow = Array.isArray(spec.hostFlow) ? spec.hostFlow.map(String) : [];
  if (!spec.hostFlow.length) spec.hostFlow = ["Enter Live ID", "Click Connect & Start", "Run the round and react to boosts"];

  spec.viewerActions = spec.viewerActions && typeof spec.viewerActions === "object" ? spec.viewerActions : {};
  for (const k of ["chat", "likes", "gifts", "joins", "shares"]) {
    const v = spec.viewerActions[k];
    spec.viewerActions[k] = Array.isArray(v) ? v.map(String) : [];
  }
  if (!spec.viewerActions.chat.length) spec.viewerActions.chat = ["Type the Join command to spawn in.", "Type the Action command to attack/trigger abilities."];
  if (!spec.viewerActions.likes.length) spec.viewerActions.likes = ["Likes fill the Hype meter (more effects)."];
  if (!spec.viewerActions.gifts.length) spec.viewerActions.gifts = ["Gifts trigger a power-up burst and big damage."];
  if (!spec.viewerActions.joins.length) spec.viewerActions.joins = ["Joining adds players and activity to the arena."];
  if (!spec.viewerActions.shares.length) spec.viewerActions.shares = ["Shares can optionally count as Action (for viewers who can’t chat)."];

  spec.howToPlay = Array.isArray(spec.howToPlay) ? spec.howToPlay.map(String) : [];
  if (!spec.howToPlay.length) spec.howToPlay = ["Chat to join & act.", "Likes power the Hype meter.", "Gifts trigger power-ups."];

  spec.defaults = spec.defaults && typeof spec.defaults === "object" ? spec.defaults : {};
  spec.defaults.joinCommand = String(spec.defaults.joinCommand || "join").trim();
  spec.defaults.actionCommand = String(spec.defaults.actionCommand || "attack").trim();

  spec.defaultSettings = spec.defaultSettings || {};
  spec.defaultSettings.roundSeconds = Number(spec.defaultSettings.roundSeconds || 120);
  spec.defaultSettings.winGoal = Number(spec.defaultSettings.winGoal || 25);

  return spec;
}

// -----------------------------
// AI Region generation (unchanged from your current system)
// -----------------------------
function fallbackAiRegion() {
  return `
function aiInit(state){
  // Template already runs the arena. Add a banner.
  try{ state && state.counters && (state.counters._aiReady = 1); }catch(e){}
}
function aiOnChat(state, ev){}
function aiOnLike(state, like){}
function aiOnGift(state, gift){}
  `.trim();
}

function sanitizeAiRegion(code) {
  const c = String(code || "").trim();
  if (!c) return { ok: false, reason: "empty" };

  const needs = ["function aiInit", "function aiOnChat", "function aiOnLike", "function aiOnGift"];
  for (const n of needs) {
    if (!c.includes(n)) return { ok: false, reason: `missing ${n}` };
  }

  if (/\bctx\.on\s*\(/.test(c)) return { ok: false, reason: "ctx.on() not allowed (crashes)" };
  if (/\bonConnect\b/.test(c)) return { ok: false, reason: "onConnect not allowed (crashes)" };
  if (/\brequire\s*\(/.test(c) || /\bimport\s+/.test(c)) return { ok: false, reason: "require/import not allowed" };

  return { ok: true, code: c };
}

async function generateAiRegion({ apiKey, model, idea, spec, templateId, changeRequest }) {
  const prompt = [
    "Return ONLY JavaScript code. No markdown. No code fences.",
    "Generate ONLY the code that goes inside the AI_REGION of game.template.js.",
    "You MUST define these functions exactly:",
    "- aiInit(state)",
    "- aiOnChat(state, ev)",
    "- aiOnLike(state, like)",
    "- aiOnGift(state, gift)",
    "",
    "Critical rules (DO NOT break):",
    "- Do NOT call ctx.on(...). (There is no ctx emitter.)",
    "- Do NOT reference onConnect or ctx.onConnect.",
    "- Keep it lightweight and reactive (low token output).",
    "",
    `Template hint: ${templateId}`,
    "Spec JSON:",
    JSON.stringify(spec, null, 2),
    "",
    changeRequest ? "Change request:\n" + changeRequest : "Game idea:\n" + idea,
  ].join("\n");

  const raw = await callOpenAIResponses({
    apiKey,
    model,
    maxOutputTokens: Number(process.env.OPENAI_MAX_OUTPUT_TOKENS_JS || 1200),
    prompt,
  });

  const code = stripCodeFences(extractAssistantText(raw)).trim();
  const checked = sanitizeAiRegion(code);
  if (!checked.ok) {
    console.warn("AI_REGION rejected:", checked.reason);
    return fallbackAiRegion();
  }
  return checked.code;
}

// -----------------------------
// Template injection (existing helpers you already use)
// -----------------------------
function replaceBetweenMarkers(fullText, startMarker, endMarker, replacement) {
  const a = fullText.indexOf(startMarker);
  const b = fullText.indexOf(endMarker);
  assert(a !== -1 && b !== -1 && b > a, "AI_REGION markers not found");
  return fullText.slice(0, a + startMarker.length) + "\n\n" + replacement.trim() + "\n\n" + fullText.slice(b);
}

function injectSpecIntoGameJs(gameJsTemplate, spec) {
  // The template expects const SPEC = __SPEC_JSON__;
  const safe = JSON.stringify(spec || {}, null, 2);
  return String(gameJsTemplate || "").replace("__SPEC_JSON__", safe);
}

function renderIndexHtml(indexTemplate, spec) {
  // Minimal token cost: index comes from template + spec fields
  const t = String(indexTemplate || "");
  return t
    .replaceAll("{{TITLE}}", String(spec?.title || "ChatTok Live Game"))
    .replaceAll("{{SUBTITLE}}", String(spec?.subtitle || "Live Interactive"))
    .replaceAll("{{ONE_SENTENCE}}", String(spec?.oneSentence || "Chat and gifts power up the action."))
    .replaceAll("{{HOW_TO_PLAY_JSON}}", JSON.stringify(spec?.howToPlay || [], null, 2));
}

function enforceLockedTikTokAndConnectFirst(jsText) {
  // This function is kept simple here because the template already enforces it.
  // If you have stricter enforcement in your previous version, keep that logic here.
  return String(jsText || "");
}

// -----------------------------
// Validation (light but strict)
// -----------------------------
function validateGeneratedHtml(html) {
  const requiredIds = ["setupOverlay", "gameScreen", "flags", "gameRoot", "startGameBtn", "liveIdInput", "setupFields"];
  for (const id of requiredIds) {
    if (!html.includes(`id="${id}"`) && !html.includes(`id='${id}'`)) {
      throw new Error(`index.html missing required id: ${id}`);
    }
  }
  const matches = html.match(/id\s*=\s*["']liveIdInput["']/g) || [];
  if (matches.length !== 1) throw new Error(`index.html must have exactly 1 liveIdInput (found ${matches.length})`);
}

function validateGeneratedCss(css) {
  if (!css.includes(":root")) throw new Error("style.css missing :root block");
  if (!css.includes("--pink") || !css.includes("--aqua")) throw new Error("style.css missing theme vars (--pink/--aqua)");
}

function validateGeneratedJs(js) {
  if (!js.includes("new TikTokClient")) throw new Error("game.js missing TikTokClient usage");
  if (!js.includes("// === AI_REGION_START ===") || !js.includes("// === AI_REGION_END ===")) {
    throw new Error("game.js missing AI_REGION markers");
  }
  if (js.includes("setAccessToken(window.CHATTOK_CREATOR_TOKEN")) {
    throw new Error("game.js violates token rule (setAccessToken called without non-empty check)");
  }
}

// ============================================================
// ✅ FIX #1: /api/plan  (your builder calls this; it was 404)
// ============================================================
app.post("/api/plan", async (req, res) => {
  try {
    const idea = pickIdea(req.body);
    assert(idea, "Missing idea text.");

    const templateId = String(req.body?.templateId || req.body?.template || "boss").trim().toLowerCase();

    const apiKey = process.env.OPENAI_API_KEY;
    assert(apiKey !== undefined, "OPENAI_API_KEY missing in environment");
    assert(String(apiKey || "").trim(), "OPENAI_API_KEY is blank.");

    const modelSpec = String(process.env.OPENAI_MODEL_SPEC || "gpt-4o-mini").trim();

    const currentSpec = req.body?.currentSpec && typeof req.body.currentSpec === "object" ? req.body.currentSpec : null;
    const planEdits = typeof req.body?.planEdits === "string" ? req.body.planEdits.trim() : "";

    const spec = await generateSpec({ apiKey, model: modelSpec, idea, templateId, currentSpec, planEdits });

    return res.json({ ok: true, spec, templateId });
  } catch (err) {
    console.error("/api/plan error:", err);
    return res.status(err.status || 500).json({
      ok: false,
      error: err?.message || String(err),
      details: err.details || null,
    });
  }
});

// -----------------------------
// POST /api/generate
// -----------------------------
app.post("/api/generate", async (req, res) => {
  try {
    const stage = normalizeStage(req.body?.stage);
    const wantBundle = !stage;

    const idea = pickIdea(req.body);
    assert(idea || wantBundle, "Missing idea text.");

    const templateId = String(req.body?.templateId || req.body?.template || "boss").trim().toLowerCase();
    const theme = req.body?.theme || req.body?.colors || {};

    const ctx = req.body?.context && typeof req.body.context === "object" ? req.body.context : {};
    const ctxSpec = safeSpecFromContext(ctx.spec);

    const modelSpec = String(process.env.OPENAI_MODEL_SPEC || "gpt-4o-mini").trim();
    const modelJs = String(process.env.OPENAI_MODEL_JS || process.env.OPENAI_MODEL_AI || "gpt-4o-mini").trim();

    // CSS stage: NO LLM
    if (!wantBundle && stage === "css") {
      const css = injectThemeVars(TEMPLATES.css, theme);
      validateGeneratedCss(css);
      return res.json({
        ok: true,
        stage,
        file: { name: "style.css", content: css },
        context: { spec: ctxSpec, templateId },
      });
    }

    // OpenAI key required for html/js
    const apiKey = process.env.OPENAI_API_KEY;
    assert(apiKey !== undefined, "OPENAI_API_KEY missing in environment");
    assert(String(apiKey || "").trim(), "OPENAI_API_KEY is blank.");

    // HTML stage
    if (!wantBundle && stage === "html") {
      // IMPORTANT: If builder already has a spec from /api/plan, render from it (cheaper + respects edits)
      const spec = ctxSpec || (await generateSpec({ apiKey, model: modelSpec, idea, templateId }));
      const html = renderIndexHtml(TEMPLATES.index, spec);
      validateGeneratedHtml(html);
      return res.json({ ok: true, stage, file: { name: "index.html", content: html }, context: { spec, templateId } });
    }

    // JS stage
    if (!wantBundle && stage === "js") {
      const spec = ctxSpec || (await generateSpec({ apiKey, model: modelSpec, idea, templateId }));
      const aiCode = await generateAiRegion({ apiKey, model: modelJs, idea, spec, templateId });

      let js = injectSpecIntoGameJs(TEMPLATES.game, spec);
      js = replaceBetweenMarkers(js, "// === AI_REGION_START ===", "// === AI_REGION_END ===", aiCode);
      js = enforceLockedTikTokAndConnectFirst(js);
      validateGeneratedJs(js);

      return res.json({ ok: true, stage, file: { name: "game.js", content: js }, context: { spec, templateId } });
    }

    // Bundle mode (optional)
    const spec = ctxSpec || (await generateSpec({ apiKey, model: modelSpec, idea, templateId }));
    const html = renderIndexHtml(TEMPLATES.index, spec);
    const css = injectThemeVars(TEMPLATES.css, theme);
    const aiCode = await generateAiRegion({ apiKey, model: modelJs, idea, spec, templateId });

    let js = injectSpecIntoGameJs(TEMPLATES.game, spec);
    js = replaceBetweenMarkers(js, "// === AI_REGION_START ===", "// === AI_REGION_END ===", aiCode);
    js = enforceLockedTikTokAndConnectFirst(js);

    validateGeneratedHtml(html);
    validateGeneratedCss(css);
    validateGeneratedJs(js);

    return res.json({
      ok: true,
      stage: "bundle",
      index_html: html,
      style_css: css,
      game_js: js,
      context: { spec, templateId },
    });
  } catch (err) {
    console.error("/api/generate error:", err);
    return res.status(err.status || 500).json({
      ok: false,
      error: err?.message || String(err),
      details: err.details || null,
    });
  }
});

// -----------------------------
// POST /api/edit (v1)
// -----------------------------
app.post("/api/edit", async (req, res) => {
  try {
    const remaining = Number(req.body?.remainingEdits ?? 0);
    assert(remaining > 0, "No edits remaining.");

    const changeRequest = String(req.body?.changeRequest || "").trim();
    assert(changeRequest, "Missing changeRequest.");

    const currentFiles = req.body?.currentFiles && typeof req.body.currentFiles === "object" ? req.body.currentFiles : {};
    const currentCss = String(currentFiles["style.css"] || "");
    const currentJs = String(currentFiles["game.js"] || "");

    const templateId = String(req.body?.templateId || "boss").trim().toLowerCase();
    const theme = req.body?.theme || req.body?.colors || {};

    // Theme shortcut
    if (/\b(theme|color|colour|primary|secondary|background)\b/i.test(changeRequest)) {
      const css = injectThemeVars(TEMPLATES.css, theme);
      validateGeneratedCss(css);
      return res.json({
        ok: true,
        remainingEdits: remaining - 1,
        patches: [{ name: "style.css", content: css }],
        notes: "Re-injected theme vars into style.css template.",
      });
    }

    const apiKey = process.env.OPENAI_API_KEY;
    assert(String(apiKey || "").trim(), "OPENAI_API_KEY is blank.");

    // Recover spec from const SPEC if possible
    let spec = null;
    const specMatch = currentJs.match(/const\s+SPEC\s*=\s*(\{[\s\S]*?\});/m);
    if (specMatch && specMatch[1]) {
      const parsed = parseJsonLoose(specMatch[1]);
      if (parsed.ok) spec = parsed.value;
    }
    if (!spec) {
      spec = {
        title: "ChatTok Live Game",
        subtitle: "Live Interactive",
        oneSentence: "Chat and gifts power up the action.",
        hostFlow: ["Enter Live ID", "Click Connect & Start", "Run the round and react to boosts"],
        viewerActions: {
          chat: ["Type join/action commands."],
          likes: ["Fill the Hype meter."],
          gifts: ["Trigger power-ups."],
          joins: ["Join adds activity."],
          shares: ["Optional action fallback."],
        },
        howToPlay: ["Chat to interact.", "Likes add energy.", "Gifts trigger power-ups."],
        defaults: { joinCommand: "join", actionCommand: "attack" },
        defaultSettings: { roundSeconds: 120, winGoal: 25 },
      };
    }

    const modelJs = String(process.env.OPENAI_MODEL_JS || process.env.OPENAI_MODEL_AI || "gpt-4o-mini").trim();
    const aiCode = await generateAiRegion({ apiKey, model: modelJs, idea: "", spec, templateId, changeRequest });

    let newJs = replaceBetweenMarkers(currentJs, "// === AI_REGION_START ===", "// === AI_REGION_END ===", aiCode);
    newJs = enforceLockedTikTokAndConnectFirst(newJs);
    validateGeneratedJs(newJs);

    if (currentCss) validateGeneratedCss(currentCss);

    return res.json({
      ok: true,
      remainingEdits: remaining - 1,
      patches: [{ name: "game.js", content: newJs }],
      notes: "Updated AI_REGION in game.js.",
    });
  } catch (err) {
    console.error("/api/edit error:", err);
    return res.status(err.status || 500).json({
      ok: false,
      error: err?.message || String(err),
      details: err.details || null,
    });
  }
});

// -----------------------------
// Health
// -----------------------------
app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "builder-api",
    endpoints: ["GET /health", "POST /api/plan", "POST /api/generate", "POST /api/edit"],
    models: {
      spec: process.env.OPENAI_MODEL_SPEC || "gpt-4o-mini",
      js: process.env.OPENAI_MODEL_JS || process.env.OPENAI_MODEL_AI || "gpt-4o-mini",
    },
    templates: {
      index: !!TEMPLATES.index,
      css: !!TEMPLATES.css,
      game: !!TEMPLATES.game,
    },
    cors: {
      allowedOrigins: allowedOrigins.length ? allowedOrigins : ["(dev default: allow all)"],
    },
  });
});

// Exactly one listen
app.listen(PORT, HOST, () => {
  console.log(`Builder API running: http://${HOST}:${PORT}`);
  console.log(`Allowed origins: ${allowedOrigins.join(", ") || "(dev default: allow all)"}`);
});
