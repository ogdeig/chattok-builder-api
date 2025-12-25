/* =========================================================
   ChatTok Gaming — AI Game Builder API (Render)
   server.js — Production-ready, template-first

   Fixes included:
   - Render proxy + express-rate-limit validation (trust proxy)
   - /health now returns endpoints so builder contract auto-detect works
   - Spec generation is template-aware (arena/trivia/wheel/boss) and NOT forced into "!fire A4"
   - Adds temperature + nonce to avoid “same spec every time” feel
   - Reliability: OpenAI timeouts + safe fallbacks (never return empty files)

   ENV (Render):
   - OPENAI_API_KEY
   - OPENAI_MODEL_SPEC (optional, default gpt-4o-mini)
   - OPENAI_TIMEOUT_MS (optional, default 25000)
   - OPENAI_TEMPERATURE (optional, default 1.0)
   - ALLOWED_ORIGINS (optional CSV)
========================================================= */
"use strict";

const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
require("dotenv").config();

const app = express();

// ✅ Render/proxy fix (required for express-rate-limit when X-Forwarded-For exists)
app.set("trust proxy", 1);

// -----------------------------
// Basic middleware
// -----------------------------
app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));

// Rate limit (safe defaults; adjust as needed)
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120, // per IP per minute
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(limiter);

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
  "https://chattokgaming.com",
  "http://localhost:3000",
  "http://localhost:5173",
  "http://localhost:8080",
  "http://127.0.0.1:8080",
]);
function listRoutes(app) {
  const routes = [];
  app._router?.stack?.forEach((layer) => {
    if (layer.route && layer.route.path) {
      const methods = Object.keys(layer.route.methods || {}).map(m => m.toUpperCase());
      routes.push({ path: layer.route.path, methods });
    } else if (layer.name === "router" && layer.handle?.stack) {
      layer.handle.stack.forEach((l2) => {
        if (l2.route && l2.route.path) {
          const methods = Object.keys(l2.route.methods || {}).map(m => m.toUpperCase());
          routes.push({ path: l2.route.path, methods });
        }
      });
    }
  });
  return routes;
}

console.log("ROUTES:", listRoutes(app));

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

app.options("*", cors());

// -----------------------------
// Template loading
// -----------------------------
const TPL_DIR = __dirname;

function readTemplate(file) {
  const p = path.join(TPL_DIR, file);
  return fs.readFileSync(p, "utf8");
}

function loadTemplates() {
  return {
    index: readTemplate("index.template.html"),
    css: readTemplate("style.template.css"),
    js: readTemplate("game.template.js"),
  };
}

let TEMPLATES = loadTemplates();

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
    howLis || "<li>Type !join to join.</li><li>Follow the on-screen prompt to play.</li>"
  );
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
  if (s.length > maxLen) return JSON.stringify(obj);
  return s;
}

// Try to parse JSON even if the model adds stray text
function safeJsonParseMaybe(txt) {
  const raw = String(txt || "").trim().replace(/^\uFEFF/, "");
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {}
  const first = raw.indexOf("{");
  const last = raw.lastIndexOf("}");
  if (first >= 0 && last > first) {
    const slice = raw.slice(first, last + 1);
    try {
      return JSON.parse(slice);
    } catch {}
  }
  return null;
}

function extractSpecFromGameJs(jsText) {
  const s = String(jsText || "");
  const m = s.match(/const\s+SPEC\s*=\s*({[\s\S]*?})\s*;\s*\/\*__SPEC_END__\*\//);
  if (!m) return null;
  return safeJsonParseMaybe(m[1]);
}

// -----------------------------
// Spec defaults by templateId
// -----------------------------
function baseSpecForTemplate(templateId) {
  const t = String(templateId || "arena").toLowerCase();

  if (t === "trivia") {
    return {
      archetype: "trivia-rounds",
      title: "Trivia Rush",
      subtitle: "Fast Questions. Loud Chat.",
      oneSentence: "Viewers join teams and answer in chat while the host keeps the pace.",
      howToPlay: [
        "Type !join to enter.",
        "Answer by typing A, B, C, or D.",
        "Correct answers score points instantly.",
        "Gifts can trigger double-points or a bonus question.",
      ],
      defaultSettings: { roundSeconds: 20, questionsPerRound: 7, winGoal: 50 },
      commands: { join: "!join", answer: "A / B / C / D" },
      visuals: { correctEmoji: "✅", wrongEmoji: "❌", hypeEmoji: "🔥" },
    };
  }

  if (t === "wheel") {
    return {
      archetype: "spin-wheel",
      title: "Spin Frenzy",
      subtitle: "Chat Joins. Wheel Decides.",
      oneSentence: "Viewers type a keyword to join the wheel — host spins for chaos and prizes.",
      howToPlay: [
        "Type !join to enter the wheel.",
        "Host spins — winner pops with their profile picture.",
        "Likes add speed. Gifts add wedges or multipliers.",
      ],
      defaultSettings: { spinCooldown: 12, maxPlayers: 60, winGoal: 10 },
      commands: { join: "!join", spin: "!spin" },
      visuals: { winEmoji: "🎉", joinEmoji: "🌀", boostEmoji: "⚡" },
    };
  }

  if (t === "boss") {
    return {
      archetype: "boss-fight",
      title: "Raid Boss Live",
      subtitle: "Team Up. Break the Boss.",
      oneSentence: "Chat joins a raid party and attacks the boss in real-time with commands, likes, and gifts.",
      howToPlay: [
        "Type !join to enlist.",
        "Type !atk or !heal when prompted.",
        "Boss fights back on a timer.",
        "Big gifts trigger ultimates or shields.",
      ],
      defaultSettings: { bossHp: 5000, roundSeconds: 45, winGoal: 3 },
      commands: { join: "!join", attack: "!atk", heal: "!heal" },
      visuals: { hitEmoji: "💥", healEmoji: "💚", bossEmoji: "👹" },
    };
  }

  // arena (default)
  return {
    archetype: "arena-action",
    title: "Arena Assault",
    subtitle: "Survive the Chaos in Chat!",
    oneSentence: "Pilot the action while viewers spawn hazards, buffs, and chaos through chat.",
    howToPlay: [
      "Type !join to spawn into the arena.",
      "Chat triggers events with keywords shown on-screen.",
      "Likes charge power. Gifts unleash big attacks.",
    ],
    defaultSettings: { roundSeconds: 35, winGoal: 25, difficulty: 2 },
    commands: { join: "!join", action: "!drop / !buff / !boom" },
    visuals: { hitEmoji: "💥", missEmoji: "💨", powerEmoji: "⚡" },
  };
}

function fallbackSpecFromIdea(idea, templateId) {
  const base = baseSpecForTemplate(templateId);
  const titleHint = safeStr(idea, 50);
  const out = { ...base };

  // Small “uniqueness” tweak even in fallback mode
  if (titleHint && titleHint.length >= 6) {
    out.title = titleHint.slice(0, 40).replace(/^[^a-z0-9]+/i, "").trim() || out.title;
  }

  return out;
}

// -----------------------------
// OpenAI (Responses API) with timeout + fallbacks
// -----------------------------
function getTimeoutMs() {
  const n = Number(process.env.OPENAI_TIMEOUT_MS || 25000);
  return Number.isFinite(n) && n >= 5000 ? Math.floor(n) : 25000;
}

function getTemperature() {
  const t = Number(process.env.OPENAI_TEMPERATURE ?? 1.0);
  if (!Number.isFinite(t)) return 1.0;
  return Math.max(0, Math.min(2, t));
}

async function callOpenAIResponses({ apiKey, model, maxOutputTokens, prompt, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const payload = {
    model,
    max_output_tokens: maxOutputTokens,
    temperature: getTemperature(), // ✅ supported by Responses API docs
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

async function generateSpec({ apiKey, model, idea, templateId }) {
  const t = String(templateId || "arena").toLowerCase();
  const base = baseSpecForTemplate(t);

  // ✅ nonce makes requests feel “fresh” even with similar prompts
  const nonce = crypto.randomUUID();

  const prompt = [
    "Return ONLY valid JSON. No markdown.",
    "Create a compact game spec for a TikTok LIVE interactive game.",
    "",
    `TEMPLATE FLAVOR: ${t}`,
    `NONCE: ${nonce}`,
    "",
    "Rules:",
    "- The spec MUST match the user's idea (do NOT default to asteroids unless the idea is asteroids).",
    "- MUST be playable from chat (join + 1-3 core actions).",
    "- MUST look alive immediately on load (HUD + motion) even before connect.",
    "- MUST NOT reuse the same title/subtitle from earlier runs unless the idea clearly requests it.",
    "- Keep it compact (short arrays, practical defaults).",
    "",
    "Output JSON keys required (same shape as this example, but values should match the idea/template):",
    stableJson(
      {
        title: base.title,
        subtitle: base.subtitle,
        oneSentence: base.oneSentence,
        howToPlay: base.howToPlay,
        defaultSettings: base.defaultSettings,
        commands: base.commands,
        visuals: base.visuals,
        archetype: base.archetype,
      },
      12000
    ),
    "",
    "Game idea:",
    safeStr(idea, 1800),
  ].join("\n");

  const timeoutMs = getTimeoutMs();
  const resp = await callOpenAIResponses({
    apiKey,
    model,
    maxOutputTokens: Number(process.env.OPENAI_MAX_OUTPUT_TOKENS_SPEC || 750),
    prompt,
    timeoutMs,
  });

  const txt = extractTextFromResponses(resp).trim();
  const parsed = safeJsonParseMaybe(txt);

  const out = fallbackSpecFromIdea(idea, t);
  if (isObj(parsed)) Object.assign(out, parsed);

  // Hard safety normalization
  if (!Array.isArray(out.howToPlay)) out.howToPlay = base.howToPlay;
  if (!isObj(out.defaultSettings)) out.defaultSettings = base.defaultSettings;
  if (!isObj(out.commands)) out.commands = base.commands;
  if (!isObj(out.visuals)) out.visuals = base.visuals;

  out.title = safeStr(out.title || base.title, 80) || base.title;
  out.subtitle = safeStr(out.subtitle || base.subtitle, 120) || base.subtitle;
  out.oneSentence = safeStr(out.oneSentence || base.oneSentence, 200) || base.oneSentence;
  out.archetype = safeStr(out.archetype || base.archetype, 40) || base.archetype;

  return out;
}

async function editSpecWithOpenAI({ apiKey, model, spec, changeRequest }) {
  const nonce = crypto.randomUUID();

  const prompt = [
    "Return ONLY valid JSON. No markdown.",
    "You will receive an existing spec JSON and an edit request.",
    "Output the FULL updated spec JSON (same keys), making ONLY the requested changes.",
    "Keep it compact; do not add huge text blocks.",
    "",
    `NONCE: ${nonce}`,
    "",
    "Edit request:",
    safeStr(changeRequest, 800),
    "",
    "Existing spec JSON:",
    stableJson(spec, 30000),
  ].join("\n");

  const timeoutMs = getTimeoutMs();
  const resp = await callOpenAIResponses({
    apiKey,
    model,
    maxOutputTokens: Number(process.env.OPENAI_MAX_OUTPUT_TOKENS_SPEC || 750),
    prompt,
    timeoutMs,
  });

  const txt = extractTextFromResponses(resp).trim();
  const edited = safeJsonParseMaybe(txt);
  if (!isObj(edited)) return spec;
  return edited;
}

// -----------------------------
// Routes
// -----------------------------
function listEndpoints() {
  // This is only to help the builder detect contract mode.
  return [
    "GET /health",
    "GET /api/models",
    "POST /api/plan",
    "POST /api/generate",
    "POST /api/build",
    "POST /api/edit",
  ];
}

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "chattok-game-builder-api",
    uptimeSec: Math.round(process.uptime()),
    time: new Date().toISOString(),
    endpoints: listEndpoints(), // ✅ builder contract detection needs this
  });
});

app.get("/api/models", (_req, res) => {
  res.json({
    ok: true,
    models: { spec: process.env.OPENAI_MODEL_SPEC || "gpt-4o-mini" },
    timeoutMs: getTimeoutMs(),
    temperature: getTemperature(),
  });
});

// /api/plan
app.post("/api/plan", noStore, async (req, res) => {
  const requestId = crypto.randomUUID();
  try {
    const prompt = safeStr(req.body?.prompt || req.body?.idea || req.body?.text || "");
    assert(prompt, "Missing prompt");

    const templateId = safeStr(req.body?.templateId || req.body?.template || "arena", 50).toLowerCase();
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
          templateId,
        });
      } catch (e) {
        console.warn(`[${requestId}] Plan OpenAI failed; using fallback:`, e?.message || e);
        spec = fallbackSpecFromIdea(prompt, templateId);
        usedFallback = true;
      }
    } else {
      spec = fallbackSpecFromIdea(prompt, templateId);
      usedFallback = true;
    }

    return res.json({
      ok: true,
      requestId,
      spec,
      usedFallback,
      planText: usedFallback
        ? "Fallback plan used (OpenAI unavailable). Spec is a safe default you can still build from."
        : "Plan generated successfully.",
      context: { spec, templateId, theme },
    });
  } catch (err) {
    const status = err.status || 500;
    return res.status(status).json({
      ok: false,
      requestId,
      error: err.message || "Plan failed",
    });
  }
});

// -----------------------------
// game.js builder (template-first, spec-driven)
// -----------------------------
function buildGameJs({ spec }) {
  const s = isObj(spec) ? spec : fallbackSpecFromIdea("", "arena");
  let js = String(TEMPLATES.js || "");
  const specJson = stableJson(s, 50000);
  js = js.replaceAll("__SPEC_JSON__", specJson);
  return js;
}

async function generateHandler(req, res) {
  const requestId = crypto.randomUUID();
  try {
    const stage = safeStr(req.body?.stage || "bundle", 20).toLowerCase();
    const templateId = safeStr(req.body?.templateId || req.body?.template || "arena", 50).toLowerCase();
    const theme = normalizeTheme(req.body?.theme || req.body?.colors || {});
    const prompt = safeStr(req.body?.prompt || req.body?.idea || "");

    const ctx = isObj(req.body?.context) ? req.body.context : {};
    const specFromCtx = isObj(ctx.spec) ? ctx.spec : null;
    const specFromTop = isObj(req.body?.spec) ? req.body.spec : null;
    const planObj = isObj(req.body?.plan) ? req.body.plan : null;
    const specFromPlan = isObj(planObj?.spec) ? planObj.spec : (isObj(planObj) ? planObj : null);

    let spec = specFromCtx || specFromTop || specFromPlan;

    if (!spec) {
      assert(prompt, "Missing plan/spec/context OR prompt");
      const apiKey = String(process.env.OPENAI_API_KEY || "").trim();
      if (apiKey) {
        try {
          spec = await generateSpec({
            apiKey,
            model: String(process.env.OPENAI_MODEL_SPEC || "gpt-4o-mini").trim(),
            idea: prompt,
            templateId,
          });
        } catch (e) {
          console.warn(`[${requestId}] Spec OpenAI failed; using fallback:`, e?.message || e);
          spec = fallbackSpecFromIdea(prompt, templateId);
        }
      } else {
        spec = fallbackSpecFromIdea(prompt, templateId);
      }
    }

    if (stage === "css") {
      const css = injectThemeTokens(TEMPLATES.css, theme);
      validateNoPlaceholders(css, "style.css");
      return res.json({
        ok: true,
        requestId,
        stage: "css",
        file: { name: "style.css", content: css },
        context: { spec, templateId },
      });
    }

    if (stage === "html") {
      const html = renderIndexHtml({ spec, theme });
      return res.json({
        ok: true,
        requestId,
        stage: "html",
        file: { name: "index.html", content: html },
        context: { spec, templateId },
      });
    }

    if (stage === "js") {
      const js = buildGameJs({ spec });
      return res.json({
        ok: true,
        requestId,
        stage: "js",
        file: { name: "game.js", content: js },
        context: { spec, templateId },
      });
    }

    // bundle
    const html = renderIndexHtml({ spec, theme });
    const css = injectThemeTokens(TEMPLATES.css, theme);
    validateNoPlaceholders(css, "style.css");
    const js = buildGameJs({ spec });

    return res.json({
      ok: true,
      requestId,
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
      requestId,
      error: err.message || "Build failed",
    });
  }
}

app.post("/api/generate", noStore, generateHandler);
app.post("/api/build", noStore, generateHandler);

// Apply limited edits (builder expects patches[])
app.post("/api/edit", noStore, async (req, res) => {
  const requestId = crypto.randomUUID();
  try {
    const remainingEdits = Number(req.body?.remainingEdits ?? 0);
    assert(Number.isFinite(remainingEdits) && remainingEdits > 0, "No edits remaining");

    const changeRequest = safeStr(req.body?.changeRequest || "");
    assert(changeRequest, "Missing changeRequest");

    const theme = normalizeTheme(req.body?.theme || req.body?.colors || {});
    const templateId = safeStr(req.body?.templateId || "arena", 50).toLowerCase();
    const currentFiles = isObj(req.body?.currentFiles) ? req.body.currentFiles : {};
    const currentJs = String(currentFiles["game.js"] || "");
    const currentSpec = extractSpecFromGameJs(currentJs);

    let spec = currentSpec || fallbackSpecFromIdea(changeRequest, templateId);

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
        console.warn(`[${requestId}] Edit OpenAI failed; keeping existing spec:`, e?.message || e);
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
      requestId,
      patches,
      remainingEdits: Math.max(0, remainingEdits - 1),
      context: { spec, templateId },
    });
  } catch (err) {
    const status = err.status || 500;
    return res.status(status).json({ ok: false, requestId, error: err.message || "Edit failed" });
  }
});

// -----------------------------
// Startup (exactly one listen)
// -----------------------------
const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, () => {
  console.log(`ChatTok Builder API listening on ${PORT}`);
});
