/* =========================================================
   ChatTok Gaming — AI Game Builder API (Render)
   server.js — Production-ready, template-first
   Key goals:
   - Stable builder/API contract (/api/plan + /api/generate + /api/edit)
   - No CSS corruption (CSS is template-only with token injection)
   - No missing DOM ids (templates are authoritative)
   - TikTok connection contract preserved (game.js template)
   - Reliability: OpenAI timeouts + safe fallbacks (never return empty files)

   ENV (Render):
   - OPENAI_API_KEY
   - OPENAI_MODEL_SPEC (optional, default gpt-4o-mini)
   - OPENAI_TIMEOUT_MS (optional, default 25000)
   - ALLOWED_ORIGINS (optional CSV)
========================================================= */
"use strict";

const path = require("path");
const fs = require("fs");
const express = require("express");
const cors = require("cors");
require("dotenv").config();

const app = express();

// -----------------------------
// Basic middleware
// -----------------------------
app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));

// No caching for generation endpoints
function noStore(_req, res, next) {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  next();
}

// -----------------------------
// CORS
// -----------------------------
const DEFAULT_ALLOWED = new Set([
  "https://ogdeig.github.io",
  "http://localhost:3000",
  "http://localhost:5173",
  "http://localhost:8080",
  "http://127.0.0.1:8080",
]);

function getAllowedOrigins() {
  const extra = String(process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return new Set([...DEFAULT_ALLOWED, ...extra]);
}

const allowedOrigins = getAllowedOrigins();

app.use(
  cors({
    origin: function (origin, cb) {
      // Allow non-browser tools (no Origin header)
      if (!origin) return cb(null, true);
      if (allowedOrigins.has(origin)) return cb(null, true);
      return cb(new Error("CORS: origin not allowed"), false);
    },
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: false,
    maxAge: 86400,
  })
);

// Preflight
app.options("*", cors());

// -----------------------------
// Template loading
// -----------------------------
const TPL_DIR = __dirname;
function readTemplate(file) {
  const p = path.join(TPL_DIR, file);
  return fs.readFileSync(p, "utf8");
}

let TEMPLATES = loadTemplates();

function loadTemplates() {
  return {
    index: readTemplate("index.template.html"),
    css: readTemplate("style.template.css"),
    js: readTemplate("game.template.js"),
  };
}

// -----------------------------
// Helpers
// -----------------------------
function assert(cond, msg) {
  if (!cond) {
    const e = new Error(msg || "Assertion failed");
    e.status = 400;
    throw e;
  }
}

function isObj(v) {
  return v && typeof v === "object" && !Array.isArray(v);
}

function safeStr(v, max = 5000) {
  return String(v || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function normalizeHex(s) {
  const t = String(s || "").trim();
  if (!t) return "";
  const x = t.startsWith("#") ? t : `#${t}`;
  return /^#[0-9a-fA-F]{6}$/.test(x) ? x.toLowerCase() : "";
}

function normalizeTheme(themeLike) {
  const th = isObj(themeLike) ? themeLike : {};
  const primary = normalizeHex(th.primary) || "#ff0050";
  const secondary = normalizeHex(th.secondary) || "#00f2ea";
  const background = normalizeHex(th.background) || "#050b17";
  return { primary, secondary, background };
}

function injectThemeTokens(css, themeLike) {
  const th = normalizeTheme(themeLike);
  let out = String(css || "");

  out = out.replaceAll("__THEME_PRIMARY__", th.primary);
  out = out.replaceAll("__THEME_SECONDARY__", th.secondary);
  out = out.replaceAll("__THEME_BACKGROUND__", th.background);

  return out;
}

function escapeHtml(s) {
  return String(s || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderIndexHtml({ spec, theme }) {
  const s = isObj(spec) ? spec : {};
  const how = Array.isArray(s.howToPlay) ? s.howToPlay : [];
  const howLis = how
    .slice(0, 6)
    .map((x) => `<li>${escapeHtml(String(x || "").trim())}</li>`)
    .join("\n");

  let html = String(TEMPLATES.index || "");
  html = html.replaceAll("{{TITLE}}", escapeHtml(safeStr(s.title || "ChatTok Live Game", 80)));
  html = html.replaceAll("{{SUBTITLE}}", escapeHtml(safeStr(s.subtitle || "Live Interactive", 120)));
  html = html.replaceAll(
    "{{ONE_SENTENCE}}",
    escapeHtml(safeStr(s.oneSentence || "Connect to TikTok LIVE and let chat control the action.", 180))
  );
  html = html.replaceAll(
    "{{HOW_TO_PLAY_LI}}",
    howLis || "<li>Type !join to join.</li><li>Type coordinates like A4 to play.</li>"
  );
  // Theme is applied in CSS; we still include as meta for future use
  html = html.replaceAll("{{THEME_PRIMARY}}", normalizeTheme(theme).primary);
  html = html.replaceAll("{{THEME_SECONDARY}}", normalizeTheme(theme).secondary);
  html = html.replaceAll("{{THEME_BACKGROUND}}", normalizeTheme(theme).background);
  return html;
}

function validateNoPlaceholders(text, label) {
  const s = String(text || "");
  if (s.includes("__THEME_PRIMARY__") || s.includes("__THEME_SECONDARY__") || s.includes("__THEME_BACKGROUND__")) {
    const e = new Error(`${label} still contains theme placeholders`);
    e.status = 500;
    throw e;
  }
}

function stableJson(obj, maxLen = 60000) {
  const s = JSON.stringify(obj, null, 2);
  if (s.length > maxLen) {
    // hard clamp to keep responses small
    return JSON.stringify(obj);
  }
  return s;
}

function extractSpecFromGameJs(jsText) {
  const s = String(jsText || "");
  const m = s.match(/const\s+SPEC\s*=\s*({[\s\S]*?})\s*;\s*\/\*__SPEC_END__\*\//);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

// -----------------------------
// OpenAI (Responses API) with timeout + fallbacks
// -----------------------------
function getTimeoutMs() {
  const n = Number(process.env.OPENAI_TIMEOUT_MS || 25000);
  return Number.isFinite(n) && n >= 5000 ? Math.floor(n) : 25000;
}

async function callOpenAIResponses({ apiKey, model, maxOutputTokens, prompt, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const payload = {
    model,
    max_output_tokens: maxOutputTokens,
    input: [{ role: "user", content: prompt }],
    store: false,
  };

  try {
    const r = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      signal: controller.signal,
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
  } finally {
    clearTimeout(timer);
  }
}

function extractTextFromResponses(resp) {
  if (!resp) return "";
  if (typeof resp.output_text === "string") return resp.output_text;
  const out = resp.output;
  if (!Array.isArray(out)) return "";
  let s = "";
  for (const item of out) {
    const content = item?.content;
    if (!Array.isArray(content)) continue;
    for (const c of content) {
      if (c?.type === "output_text" && typeof c.text === "string") s += c.text;
    }
  }
  return s;
}

function fallbackSpecFromIdea(idea) {
  const baseTitle = safeStr(idea, 40) || "ChatTok Live Game";
  const title = baseTitle.length <= 3 ? "ChatTok Live Game" : baseTitle;
  return {
    title,
    subtitle: "Live Interactive",
    oneSentence: "Connect to TikTok LIVE and let chat fire coordinates to find hidden targets.",
    howToPlay: [
      "Type !join to join.",
      "Type a coordinate like A4 to fire.",
      "Hits score points. Misses show an emoji.",
      "Likes charge a power scan. Gifts trigger a special strike.",
    ],
    defaultSettings: { roundSeconds: 30, winGoal: 20, gridSize: 10 },
    commands: { join: "!join", fire: "!fire A4" },
    visuals: { hitEmoji: "💥", missEmoji: "🌊", scanEmoji: "🔎" },
    archetype: "grid-strike",
  };
}

async function generateSpec({ apiKey, model, idea }) {
  const prompt = [
    "Return ONLY valid JSON. No markdown.",
    "Create a compact game spec for a TikTok LIVE interactive game.",
    "Constraints:",
    "- MUST be playable from chat (join + main action).",
    "- MUST look alive immediately on load (HUD + motion) even before connect.",
    "- Keep settings small and practical.",
    "",
    "JSON keys required:",
    `{"title":"","subtitle":"","oneSentence":"","howToPlay":[""],"defaultSettings":{"roundSeconds":30,"winGoal":20,"gridSize":10},"commands":{"join":"!join","fire":"!fire A4"},"visuals":{"hitEmoji":"💥","missEmoji":"🌊","scanEmoji":"🔎"},"archetype":"grid-strike"}`,
    "",
    "Game idea:",
    safeStr(idea, 1800),
  ].join("\n");

  const timeoutMs = getTimeoutMs();
  const resp = await callOpenAIResponses({
    apiKey,
    model,
    maxOutputTokens: Number(process.env.OPENAI_MAX_OUTPUT_TOKENS_SPEC || 650),
    prompt,
    timeoutMs,
  });

  const txt = extractTextFromResponses(resp).trim();
  const jsonText = txt.replace(/^\uFEFF/, "");
  const spec = JSON.parse(jsonText);

  const out = fallbackSpecFromIdea(idea);
  if (isObj(spec)) Object.assign(out, spec);
  if (!Array.isArray(out.howToPlay)) out.howToPlay = fallbackSpecFromIdea(idea).howToPlay;
  if (!isObj(out.defaultSettings)) out.defaultSettings = fallbackSpecFromIdea(idea).defaultSettings;
  if (!isObj(out.commands)) out.commands = fallbackSpecFromIdea(idea).commands;
  if (!isObj(out.visuals)) out.visuals = fallbackSpecFromIdea(idea).visuals;
  out.archetype = safeStr(out.archetype || "grid-strike", 40) || "grid-strike";
  return out;
}

async function editSpecWithOpenAI({ apiKey, model, spec, changeRequest }) {
  const prompt = [
    "Return ONLY valid JSON. No markdown.",
    "You will receive an existing spec JSON and an edit request.",
    "Output the FULL updated spec JSON (same keys), making ONLY the requested changes.",
    "Keep it compact; do not add huge text blocks.",
    "",
    "Edit request:",
    safeStr(changeRequest, 600),
    "",
    "Existing spec JSON:",
    stableJson(spec, 30000),
  ].join("\n");

  const timeoutMs = getTimeoutMs();
  const resp = await callOpenAIResponses({
    apiKey,
    model,
    maxOutputTokens: Number(process.env.OPENAI_MAX_OUTPUT_TOKENS_SPEC || 650),
    prompt,
    timeoutMs,
  });

  const txt = extractTextFromResponses(resp).trim();
  const jsonText = txt.replace(/^\uFEFF/, "");
  const edited = JSON.parse(jsonText);
  if (!isObj(edited)) return spec;
  return edited;
}

// -----------------------------
// Routes
// -----------------------------
app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "chattok-game-builder-api",
    uptimeSec: Math.round(process.uptime()),
    time: new Date().toISOString(),
  });
});

app.get("/api/models", (_req, res) => {
  res.json({
    ok: true,
    models: {
      spec: process.env.OPENAI_MODEL_SPEC || "gpt-4o-mini",
    },
    timeoutMs: getTimeoutMs(),
  });
});

// /api/plan (builder step 1)
app.post("/api/plan", noStore, async (req, res) => {
  try {
    const prompt = safeStr(req.body?.prompt || req.body?.idea || req.body?.text || "");
    assert(prompt, "Missing prompt");

    const templateId = safeStr(req.body?.templateId || req.body?.template || "default", 50).toLowerCase();
    const theme = normalizeTheme(req.body?.theme || req.body?.colors || {});
    const apiKey = String(process.env.OPENAI_API_KEY || "").trim();

    let spec;
    let usedFallback = false;

    if (apiKey) {
      try {
        spec = await generateSpec({
          apiKey,
          model: String(process.env.OPENAI_MODEL_SPEC || "gpt-4o-mini").trim(),
          idea: prompt,
        });
      } catch (e) {
        console.warn("Plan OpenAI failed; using fallback:", e?.message || e);
        spec = fallbackSpecFromIdea(prompt);
        usedFallback = true;
      }
    } else {
      spec = fallbackSpecFromIdea(prompt);
      usedFallback = true;
    }

    const planText = usedFallback
      ? "Fallback plan used (OpenAI unavailable). Spec is a safe default you can still build from."
      : "Plan generated successfully.";

    return res.json({
      ok: true,
      spec,
      planText,
      context: { spec, templateId, theme },
    });
  } catch (err) {
    const status = err.status || 500;
    return res.status(status).json({
      ok: false,
      error: err.message || "Plan failed",
    });
  }
});

// -----------------------------
// game.js builder (template-first, spec-driven)
// -----------------------------
function buildGameJs({ spec }) {
  const s = isObj(spec) ? spec : fallbackSpecFromIdea("");
  let js = String(TEMPLATES.js || "");

  const specJson = stableJson(s, 50000);
  js = js.replaceAll("__SPEC_JSON__", specJson);

  return js;
}

async function generateHandler(req, res) {
  try {
    const stage = safeStr(req.body?.stage || "bundle", 20).toLowerCase();
    const templateId = safeStr(req.body?.templateId || req.body?.template || "default", 50).toLowerCase();
    const theme = normalizeTheme(req.body?.theme || req.body?.colors || {});

    const prompt = safeStr(req.body?.prompt || req.body?.idea || "");
    const ctx = isObj(req.body?.context) ? req.body.context : {};
    const specFromCtx = isObj(ctx.spec) ? ctx.spec : null;
    const specFromTop = isObj(req.body?.spec) ? req.body.spec : null;
    const planObj = isObj(req.body?.plan) ? req.body.plan : null;
    const specFromPlan = isObj(planObj?.spec) ? planObj.spec : (isObj(planObj) ? planObj : null);

    let spec = specFromCtx || specFromTop || specFromPlan;

    if (!spec) {
      assert(prompt, "Missing plan (object) or prompt");
      const apiKey = String(process.env.OPENAI_API_KEY || "").trim();
      if (apiKey) {
        try {
          spec = await generateSpec({
            apiKey,
            model: String(process.env.OPENAI_MODEL_SPEC || "gpt-4o-mini").trim(),
            idea: prompt,
          });
        } catch (e) {
          console.warn("Spec OpenAI failed; using fallback:", e?.message || e);
          spec = fallbackSpecFromIdea(prompt);
        }
      } else {
        spec = fallbackSpecFromIdea(prompt);
      }
    }

    if (stage === "css") {
      const css = injectThemeTokens(TEMPLATES.css, theme);
      validateNoPlaceholders(css, "style.css");
      return res.json({ ok: true, stage: "css", file: { name: "style.css", content: css }, context: { spec, templateId } });
    }

    if (stage === "html") {
      const html = renderIndexHtml({ spec, theme });
      return res.json({ ok: true, stage: "html", file: { name: "index.html", content: html }, context: { spec, templateId } });
    }

    if (stage === "js") {
      const js = buildGameJs({ spec });
      return res.json({ ok: true, stage: "js", file: { name: "game.js", content: js }, context: { spec, templateId } });
    }

    const html = renderIndexHtml({ spec, theme });
    const css = injectThemeTokens(TEMPLATES.css, theme);
    validateNoPlaceholders(css, "style.css");
    const js = buildGameJs({ spec });

    return res.json({
      ok: true,
      stage: "bundle",
      index_html: html,
      style_css: css,
      game_js: js,
      context: { spec, templateId },
    });
  } catch (err) {
    const status = err.status || 500;
    return res.status(status).json({
      ok: false,
      error: err.message || "Build failed",
    });
  }
}

// Builder build endpoint(s)
app.post("/api/generate", noStore, generateHandler);
app.post("/api/build", noStore, generateHandler);

// Apply limited edits (builder expects patches[])
app.post("/api/edit", noStore, async (req, res) => {
  try {
    const remainingEdits = Number(req.body?.remainingEdits ?? 0);
    assert(Number.isFinite(remainingEdits) && remainingEdits > 0, "No edits remaining");

    const changeRequest = safeStr(req.body?.changeRequest || "");
    assert(changeRequest, "Missing changeRequest");

    const theme = normalizeTheme(req.body?.theme || req.body?.colors || {});
    const templateId = safeStr(req.body?.templateId || "default", 50).toLowerCase();
    const currentFiles = isObj(req.body?.currentFiles) ? req.body.currentFiles : {};
    const currentJs = String(currentFiles["game.js"] || "");
    const currentSpec = extractSpecFromGameJs(currentJs);

    let spec = currentSpec || fallbackSpecFromIdea(changeRequest);

    const apiKey = String(process.env.OPENAI_API_KEY || "").trim();
    if (apiKey && currentSpec) {
      try {
        spec = await editSpecWithOpenAI({
          apiKey,
          model: String(process.env.OPENAI_MODEL_SPEC || "gpt-4o-mini").trim(),
          spec,
          changeRequest,
        });
      } catch (e) {
        console.warn("Edit OpenAI failed; keeping existing spec:", e?.message || e);
        spec = currentSpec;
      }
    }

    const patches = [];
    patches.push({ name: "index.html", content: renderIndexHtml({ spec, theme }) });

    const css = injectThemeTokens(TEMPLATES.css, theme);
    validateNoPlaceholders(css, "style.css");
    patches.push({ name: "style.css", content: css });

    patches.push({ name: "game.js", content: buildGameJs({ spec }) });

    return res.json({
      ok: true,
      patches,
      remainingEdits: Math.max(0, remainingEdits - 1),
      context: { spec, templateId },
    });
  } catch (err) {
    const status = err.status || 500;
    return res.status(status).json({ ok: false, error: err.message || "Edit failed" });
  }
});

// -----------------------------
// Startup (exactly one listen)
// -----------------------------
const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, () => {
  console.log(`ChatTok Builder API listening on ${PORT}`);
});
