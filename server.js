// server.js — ChatTok Game Builder API (template-first, multi-engine game.template.js)
//
// ✅ Works with templates in ROOT (same folder as server.js) OR in ./templates
// ✅ Fixes double-listen + undefined HOST bugs
// ✅ Fixes CORS for GitHub Pages (ogdeig.github.io + any *.github.io by default)
// ✅ Allows CSS stage WITHOUT idea text (prevents “Missing idea text” on Build CSS)
// ✅ Ensures spec.templateId is set so game.template.js can auto-select engine
// ✅ Keeps your staged flow: HTML -> CSS -> JS (and optional bundle)
//
// NOTE: dotenv is OPTIONAL — we won’t crash if it isn’t installed.

const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const rateLimit = require("express-rate-limit");

// Optional dotenv (don’t require package.json change)
try {
  // eslint-disable-next-line import/no-extraneous-dependencies
  require("dotenv").config();
} catch (_) {
  // ignore
}

const app = express();
app.use(express.json({ limit: "10mb" }));

// Basic rate limiting (safe defaults)
app.use(
  rateLimit({
    windowMs: 60 * 1000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
  })
);

const HOST = process.env.HOST || "0.0.0.0";
const PORT = Number(process.env.PORT || 3000);

// Node 18+ required for global fetch
if (typeof fetch !== "function") {
  console.error("ERROR: global fetch is missing. Use Node 18+.");
  process.exit(1);
}

// -----------------------------
// CORS (GitHub Pages friendly)
// -----------------------------
const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// Always allow common dev origins + github pages by default
function isGithubPages(origin) {
  try {
    const u = new URL(origin);
    return u.hostname === "ogdeig.github.io" || u.hostname.endsWith(".github.io");
  } catch {
    return false;
  }
}

function isLocalhost(origin) {
  try {
    const u = new URL(origin);
    return (
      u.hostname === "localhost" ||
      u.hostname === "127.0.0.1" ||
      u.hostname.endsWith(".local")
    );
  } catch {
    return false;
  }
}

app.use(
  cors({
    origin(origin, cb) {
      // allow same-origin / curl / server-to-server
      if (!origin) return cb(null, true);

      // If env list is provided, use it (plus github pages/local dev)
      if (allowedOrigins.length > 0) {
        if (
          allowedOrigins.includes(origin) ||
          isGithubPages(origin) ||
          isLocalhost(origin)
        ) {
          return cb(null, true);
        }
        return cb(null, false);
      }

      // If no env list, be dev-friendly:
      // allow all + github pages + localhost
      return cb(null, true);
    },
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

// Make sure preflight always succeeds
app.options("*", cors());

app.get("/favicon.ico", (_req, res) => res.status(204).end());

app.get("/", (_req, res) => {
  res.type("text").send("ChatTok Builder API is running. Use /health and /api/generate.");
});

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
  const candidates = [
    body.idea,
    body.prompt,
    body.text,
    body.input,
    body.gameIdea,
    body.ideaText,
  ];
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

function escapeHtml(s) {
  return String(s || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function extractAssistantText(resp) {
  if (resp && typeof resp.output_text === "string" && resp.output_text.trim()) {
    return resp.output_text.trim();
  }
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

// -----------------------------
// Template loading (ROOT or ./templates)
// -----------------------------
function resolveTemplatePath(fileName) {
  // server.js directory is safest anchor on Render
  const base = __dirname;

  const candidates = [
    // ROOT (same folder as server.js)
    path.join(base, fileName),
    // /templates (flat)
    path.join(base, "templates", fileName),
    // /api/templates legacy
    path.join(base, "api", "templates", fileName),
    // process.cwd fallbacks
    path.join(process.cwd(), fileName),
    path.join(process.cwd(), "templates", fileName),
    path.join(process.cwd(), "api", "templates", fileName),
  ];

  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {
      // ignore
    }
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

let TEMPLATES = null;
function ensureTemplatesLoaded() {
  if (!TEMPLATES) TEMPLATES = loadTemplates();
  return TEMPLATES;
}

app.post("/api/reload-templates", (_req, res) => {
  try {
    TEMPLATES = loadTemplates();
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

// -----------------------------
// Theme injection (CSS only)
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

  replaceVar("pink", th.primary);
  replaceVar("aqua", th.secondary);
  replaceVar("bg", th.background);

  return out;
}

// -----------------------------
// TemplateId auto-pick (FREE)
// -----------------------------
function autoPickTemplateFromIdeaOrSpec(text) {
  const t = String(text || "").toLowerCase();

  if (/(asteroid|meteor|mete(or|orite)|spaceship|space ship|spacecraft|space|ship|ufo|galaxy|cosmic)/.test(t))
    return "asteroids";
  if (/(runner|endless|lane|jump|slide|obstacle|dodge|dash)/.test(t)) return "runner";
  if (/(trivia|question|answer|quiz|multiple choice|true\/false)/.test(t)) return "trivia";
  if (/(wheel|spin|spinner|raffle|lottery|giveaway)/.test(t)) return "wheel";
  if (/(boss|raid|health bar|phase|damage|dps)/.test(t)) return "bossraid";
  if (/(arena|battle|brawl|wave|enemy|monsters|survive)/.test(t)) return "arena";

  return "asteroids";
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
// Spec + AI region generation
// -----------------------------
async function generateSpec({ apiKey, model, idea, templateId }) {
  const prompt = [
    "Return ONLY valid JSON. No markdown. No extra text.",
    "Create a compact spec for a TikTok LIVE interactive game (template-first builder).",
    "Hard rules:",
    "- Must feel like a real game even before connect (motion + HUD + effects).",
    "- Define viewer interactions for chat/like/gift/join.",
    "- Keep settings minimal: roundSeconds and winGoal only.",
    "- IMPORTANT: include templateId in the JSON (string). Use the hint if it fits.",
    "",
    `Template hint: ${templateId}`,
    "",
    "JSON shape:",
    "{",
    '  "templateId":"string",',
    '  "title":"string",',
    '  "subtitle":"string",',
    '  "oneSentence":"string",',
    '  "howToPlay":["string","string","string"],',
    '  "defaultSettings":{"roundSeconds":number,"winGoal":number}',
    "}",
    "",
    "Game idea:",
    idea,
  ].join("\n");

  const raw = await callOpenAIResponses({
    apiKey,
    model,
    maxOutputTokens: Number(process.env.OPENAI_MAX_OUTPUT_TOKENS_SPEC || 700),
    prompt,
  });

  let parsed = parseJsonLoose(extractAssistantText(raw));
  if (!parsed.ok) {
    const repair = "Fix into valid JSON only. No extra text.\n\n" + extractAssistantText(raw);
    const raw2 = await callOpenAIResponses({
      apiKey,
      model,
      maxOutputTokens: Number(process.env.OPENAI_MAX_OUTPUT_TOKENS_SPEC || 700),
      prompt: repair,
    });
    parsed = parseJsonLoose(extractAssistantText(raw2));
  }
  assert(parsed.ok, "Spec generation failed (invalid JSON).");

  const spec = parsed.value || {};
  spec.templateId = String(spec.templateId || templateId || "").trim().toLowerCase() || "asteroids";
  spec.title = String(spec.title || "ChatTok Live Game").trim();
  spec.subtitle = String(spec.subtitle || "Live Interactive").trim();
  spec.oneSentence = String(spec.oneSentence || "Chat and gifts power up the action.").trim();
  spec.howToPlay = Array.isArray(spec.howToPlay) ? spec.howToPlay.map(String) : [];
  if (!spec.howToPlay.length) {
    spec.howToPlay = ["Chat to interact.", "Likes add energy.", "Gifts trigger power-ups."];
  }
  spec.defaultSettings = spec.defaultSettings || {};
  spec.defaultSettings.roundSeconds = Number(spec.defaultSettings.roundSeconds || 20);
  spec.defaultSettings.winGoal = Number(spec.defaultSettings.winGoal || 100);

  return spec;
}

function fallbackAiRegion() {
  return `
function aiInit(ctx){
  ctx.ui.renderBase();
  ctx.ui.renderMeters();
  ctx.ui.flag({ who:"SYSTEM", msg:"Demo running — connect to TikTok to go live.", pfp:"" });
}

function aiOnChat(ctx, chat){
  if (!chat || !chat.text) return;
  const t = String(chat.text).toLowerCase();
  if (t.includes("boom") && ctx.actions && ctx.actions.spawnAsteroids) {
    ctx.actions.spawnAsteroids(6, "ring");
    ctx.ui.flag({ who: chat.nickname || "viewer", msg: "💥 BOOM!", pfp: chat.pfp || "" });
  }
}

function aiOnLike(ctx, like){
  // core default mapping handled by template; keep light
}

function aiOnGift(ctx, gift){
  // core default mapping handled by template; keep light
}
`.trim();
}

function sanitizeAiRegion(code) {
  const c = String(code || "").trim();
  if (!c) return { ok: false, reason: "empty" };

  const needs = ["function aiInit", "function aiOnChat", "function aiOnLike", "function aiOnGift"];
  for (const n of needs) if (!c.includes(n)) return { ok: false, reason: `missing ${n}` };

  if (/\bctx\.on\s*\(/.test(c)) return { ok: false, reason: "ctx.on() not allowed" };
  if (/\bonConnect\b/.test(c)) return { ok: false, reason: "onConnect not allowed" };
  if (/\brequire\s*\(/.test(c) || /\bimport\s+/.test(c)) return { ok: false, reason: "require/import not allowed" };

  return { ok: true, code: c };
}

async function generateAiRegion({ apiKey, model, idea, spec, templateId, changeRequest }) {
  const prompt = [
    "Return ONLY JavaScript code. No markdown. No code fences.",
    "Generate ONLY the code that goes inside the AI_REGION of game.template.js.",
    "You MUST define these functions exactly:",
    "- aiInit(ctx)",
    "- aiOnChat(ctx, chat)",
    "- aiOnLike(ctx, like)",
    "- aiOnGift(ctx, gift)",
    "",
    "Critical rules (DO NOT break):",
    "- Do NOT call ctx.on(...). ctx is NOT an event emitter.",
    "- Do NOT reference onConnect or ctx.onConnect.",
    "- You can call: ctx.ui.flag(...), ctx.ui.card(...), ctx.ui.setStatus(...), and you may use ctx.actions.* if present.",
    "- Keep it visually reactive + game-like, but DO NOT rewrite the core engine.",
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
    maxOutputTokens: Number(process.env.OPENAI_MAX_OUTPUT_TOKENS_JS || 1400),
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
// Template injection helpers
// -----------------------------
function replaceBetweenMarkers(fullText, startMarker, endMarker, replacement) {
  const a = fullText.indexOf(startMarker);
  const b = fullText.indexOf(endMarker);
  assert(a !== -1 && b !== -1 && b > a, `Missing markers: ${startMarker} / ${endMarker}`);
  const before = fullText.slice(0, a + startMarker.length);
  const after = fullText.slice(b);
  return `${before}\n\n${replacement.trim()}\n\n${after}`;
}

function injectSpecIntoGameJs(gameTemplate, spec) {
  const json = JSON.stringify(spec, null, 2);
  return String(gameTemplate || "").replace("__SPEC_JSON__", json);
}

/**
 * Enforce LOCKED TikTok token rule + CONNECT-FIRST in template JS
 * without relying on the LLM.
 */
function enforceLockedTikTokAndConnectFirst(jsText) {
  let out = String(jsText || "");

  // Token: only call setAccessToken if non-empty
  out = out.replace(
    /client\.setAccessToken\(\s*window\.CHATTOK_CREATOR_TOKEN\s*\|\|\s*""\s*\)\s*;?/g,
    `
  // ChatTok injects CHATTOK_CREATOR_TOKEN globally.
  const token = (typeof CHATTOK_CREATOR_TOKEN !== "undefined"
    ? CHATTOK_CREATOR_TOKEN
    : (window && window.CHATTOK_CREATOR_TOKEN)) || "";
  if (token && String(token).trim()) {
    client.setAccessToken(String(token).trim());
  }
`.trim()
  );

  // CONNECT-FIRST: prevent hiding overlay in Start click handler
  out = out.replace(/\n\s*hideOverlay\(\)\s*;\s*\n/g, "\n      // CONNECT-FIRST: keep overlay open until 'connected' event\n");

  // When connected fires, hide overlay
  if (!out.includes("CONNECT-FIRST: hide overlay on connected")) {
    out = out.replace(
      /ctx\.connected\s*=\s*true\s*;\s*\n/g,
      (m) => m + "    // CONNECT-FIRST: hide overlay on connected\n    try { hideOverlay(); } catch {}\n"
    );
  }

  return out;
}

// -----------------------------
// HTML render from index.template.html
// -----------------------------
function renderSettingsFieldsHtml(spec) {
  const round = Number(spec?.defaultSettings?.roundSeconds || 20);
  const goal = Number(spec?.defaultSettings?.winGoal || 100);

  return `
<label class="field">
  <span class="field-label">Round seconds</span>
  <input data-setting="roundSeconds" type="number" min="5" max="300" value="${round}" />
</label>

<label class="field">
  <span class="field-label">Win goal</span>
  <input data-setting="winGoal" type="number" min="1" max="999" value="${goal}" />
</label>
`.trim();
}

function renderHowToLi(spec) {
  const items = Array.isArray(spec?.howToPlay) ? spec.howToPlay : [];
  return items
    .slice(0, 10)
    .map((x) => `<li>${escapeHtml(String(x || ""))}</li>`)
    .join("\n");
}

function renderIndexHtml(indexTemplate, spec) {
  let html = String(indexTemplate || "");
  html = html.replaceAll("{{TITLE}}", escapeHtml(spec.title || "ChatTok Live Game"));
  html = html.replaceAll("{{SUBTITLE}}", escapeHtml(spec.subtitle || "Live Interactive"));
  html = html.replaceAll("{{ONE_SENTENCE}}", escapeHtml(spec.oneSentence || ""));
  html = html.replaceAll("{{HOW_TO_PLAY_LI}}", renderHowToLi(spec));
  html = html.replaceAll("{{SETTINGS_FIELDS_HTML}}", renderSettingsFieldsHtml(spec));
  return html;
}

// -----------------------------
// Validations (strict but helpful)
// -----------------------------
function validateGeneratedHtml(html) {
  const requiredIds = ["setupOverlay", "startGameBtn", "liveIdInput", "gameRoot", "flags"];
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
  if (!js.includes("// === AI_REGION_START ===") || !js.includes("// === AI_REGION_END ===")) {
    throw new Error("game.js missing AI_REGION markers");
  }
  if (!js.includes("new TikTokClient")) throw new Error("game.js missing TikTokClient usage");
  if (js.includes("setAccessToken(window.CHATTOK_CREATOR_TOKEN")) {
    throw new Error("game.js violates token rule (unsafe setAccessToken call)");
  }
}

// -----------------------------
// POST /api/generate (staged)
// -----------------------------
app.post("/api/generate", async (req, res) => {
  try {
    const stage = normalizeStage(req.body?.stage);
    const wantBundle = !stage;

    const theme = req.body?.theme || req.body?.colors || {};
    const ctxObj = req.body?.context && typeof req.body.context === "object" ? req.body.context : {};
    const ctxSpec = ctxObj.spec || null;

    // TEMPLATE selection:
    // - Respect request templateId if provided
    // - Else auto-pick from idea text (FREE)
    // - Else (bundle without idea) fallback
    const idea = pickIdea(req.body);
    const requestedTemplateId = String(req.body?.templateId || req.body?.template || "").trim().toLowerCase();
    const templateId = requestedTemplateId || autoPickTemplateFromIdeaOrSpec(idea || "") || "asteroids";

    // CSS stage should NOT require idea text
    if (!wantBundle && stage === "css") {
      const templates = ensureTemplatesLoaded();
      const css = injectThemeVars(templates.css, theme);
      validateGeneratedCss(css);
      return res.json({
        ok: true,
        stage,
        file: { name: "style.css", content: css },
        context: { spec: ctxSpec, templateId },
      });
    }

    // HTML/JS stages require idea
    assert(idea || wantBundle, "Missing idea text.");

    // OpenAI key required for html/js
    const apiKey = process.env.OPENAI_API_KEY;
    assert(apiKey !== undefined, "OPENAI_API_KEY missing in env (can be blank, but then html/js will fail)");
    assert(String(apiKey || "").trim(), "OPENAI_API_KEY is blank. Add it in Render Environment.");

    const modelSpec = String(process.env.OPENAI_MODEL_SPEC || "gpt-4o-mini").trim();
    const modelJs = String(process.env.OPENAI_MODEL_JS || process.env.OPENAI_MODEL_AI || "gpt-4o-mini").trim();

    const templates = ensureTemplatesLoaded();

    // HTML stage
    if (!wantBundle && stage === "html") {
      const spec = await generateSpec({ apiKey, model: modelSpec, idea, templateId });
      // Ensure templateId always set (critical for multi-engine game.template.js)
      spec.templateId = String(spec.templateId || templateId || "asteroids").trim().toLowerCase();

      const html = renderIndexHtml(templates.index, spec);
      validateGeneratedHtml(html);

      return res.json({
        ok: true,
        stage,
        file: { name: "index.html", content: html },
        context: { spec, templateId: spec.templateId },
      });
    }

    // JS stage
    if (!wantBundle && stage === "js") {
      const spec = ctxSpec || (await generateSpec({ apiKey, model: modelSpec, idea, templateId }));
      spec.templateId = String(spec.templateId || templateId || "asteroids").trim().toLowerCase();

      const aiCode = await generateAiRegion({ apiKey, model: modelJs, idea, spec, templateId: spec.templateId });

      let js = injectSpecIntoGameJs(templates.game, spec);
      js = replaceBetweenMarkers(js, "// === AI_REGION_START ===", "// === AI_REGION_END ===", aiCode);
      js = enforceLockedTikTokAndConnectFirst(js);
      validateGeneratedJs(js);

      return res.json({
        ok: true,
        stage,
        file: { name: "game.js", content: js },
        context: { spec, templateId: spec.templateId },
      });
    }

    // Bundle mode
    const spec = ctxSpec || (await generateSpec({ apiKey, model: modelSpec, idea, templateId }));
    spec.templateId = String(spec.templateId || templateId || "asteroids").trim().toLowerCase();

    const html = renderIndexHtml(templates.index, spec);
    const css = injectThemeVars(templates.css, theme);
    const aiCode = await generateAiRegion({ apiKey, model: modelJs, idea, spec, templateId: spec.templateId });

    let js = injectSpecIntoGameJs(templates.game, spec);
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
      context: { spec, templateId: spec.templateId },
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
// POST /api/edit (safe AI_REGION-only edits)
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

    const theme = req.body?.theme || req.body?.colors || {};
    const templates = ensureTemplatesLoaded();

    // Theme shortcut
    if (/\b(theme|color|colour|primary|secondary|background)\b/i.test(changeRequest)) {
      const css = injectThemeVars(templates.css, theme);
      validateGeneratedCss(css);
      return res.json({
        ok: true,
        remainingEdits: remaining - 1,
        patches: [{ name: "style.css", content: css }],
        notes: "Re-injected theme vars into style.css template.",
      });
    }

    const apiKey = process.env.OPENAI_API_KEY;
    assert(String(apiKey || "").trim(), "OPENAI_API_KEY is blank. Add it in Render Environment.");

    // Recover spec from const SPEC if possible
    let spec = null;
    const specMatch = currentJs.match(/const\s+SPEC\s*=\s*(\{[\s\S]*?\});/m);
    if (specMatch && specMatch[1]) {
      const parsed = parseJsonLoose(specMatch[1]);
      if (parsed.ok) spec = parsed.value;
    }
    if (!spec) {
      spec = {
        templateId: "asteroids",
        title: "ChatTok Live Game",
        subtitle: "Live Interactive",
        oneSentence: "Chat and gifts power up the action.",
        howToPlay: ["Chat to interact.", "Likes add energy.", "Gifts trigger power-ups."],
        defaultSettings: { roundSeconds: 20, winGoal: 100 },
      };
    }

    // Ensure templateId exists (for multi-engine selection)
    spec.templateId = String(spec.templateId || req.body?.templateId || "asteroids").trim().toLowerCase();

    const modelJs = String(process.env.OPENAI_MODEL_JS || process.env.OPENAI_MODEL_AI || "gpt-4o-mini").trim();
    const aiCode = await generateAiRegion({
      apiKey,
      model: modelJs,
      idea: "",
      spec,
      templateId: spec.templateId,
      changeRequest,
    });

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
  let templatesOk = { index: false, css: false, game: false };
  try {
    const t = ensureTemplatesLoaded();
    templatesOk = { index: !!t.index, css: !!t.css, game: !!t.game };
  } catch (e) {
    templatesOk = { index: false, css: false, game: false, error: e?.message || String(e) };
  }

  res.json({
    ok: true,
    service: "builder-api",
    endpoints: ["GET /health", "POST /api/generate", "POST /api/edit", "POST /api/reload-templates"],
    cors: {
      allowedOriginsEnv: allowedOrigins,
      note: "If ALLOWED_ORIGINS is empty, CORS allows all (dev-friendly).",
    },
    models: {
      spec: process.env.OPENAI_MODEL_SPEC || "gpt-4o-mini",
      js: process.env.OPENAI_MODEL_JS || process.env.OPENAI_MODEL_AI || "gpt-4o-mini",
    },
    templates: templatesOk,
  });
});

// -----------------------------
// Listen (ONLY ONCE)
// -----------------------------
app.listen(PORT, HOST, () => {
  console.log(`Builder API running: http://${HOST}:${PORT}`);
  console.log(`Allowed origins env: ${allowedOrigins.join(", ") || "(none; allowing all by default)"}`);
});
