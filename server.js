// server.js — ChatTok Game Builder API (production-ready)
// =======================================================
// Goals (non-negotiables):
// - Reliable CORS + preflight for GitHub Pages -> Render (never crash on CORS)
// - Exactly ONE app.listen()
// - Cache-proof /health + /api responses (no stale generation)
// - Low-cost generation: Spec is compact; CSS stage is template-only; JS stage edits AI_REGION only
// - DO NOT edit tiktok-client.js (platform-provided)
// - Proto contract handled in generated HTML/JS (server supports it by producing robust templates)
//
// Endpoints:
// - GET  /health
// - POST /api/spec        (Step 2: plan/spec generation + revisions)
// - POST /api/generate    (Step 3: html/css/js build; stage-locked)
// - POST /api/edit        (Step 4: limited edits; updates AI_REGION only)
// - POST /api/reload-templates (optional; token-guarded if RELOAD_TEMPLATES_TOKEN set)

const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

// -----------------------------
// App setup
// -----------------------------
const app = express();
app.disable("x-powered-by");

// Render runs behind a proxy; this ensures correct IP/rate-limit behavior.
app.set("trust proxy", 1);

// Keep request size sane
app.use(express.json({ limit: "2mb" }));

// Node 18+ required for global fetch (OpenAI)
if (typeof fetch !== "function") {
  console.error("ERROR: global fetch is missing. Use Node 18+.");
  process.exit(1);
}

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "0.0.0.0";

// -----------------------------
// Cache-proof responses (critical for rapid testing)
// -----------------------------
app.use((req, res, next) => {
  // No caching anywhere (builder tests cause lots of "why didn't it update" confusion)
  res.setHeader("Cache-Control", "no-store, max-age=0, must-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  next();
});

// -----------------------------
// CORS (robust, never throws)
// -----------------------------
function parseAllowedOrigins() {
  const env = String(process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  // Safe defaults if env is not provided
  if (env.length) return env;

  return [
    "https://ogdeig.github.io",
    "http://localhost:3000",
    "http://localhost:5173",
    "http://localhost:5500",
    "http://localhost:8080",
    "http://127.0.0.1:3000",
    "http://127.0.0.1:5173",
    "http://127.0.0.1:5500",
    "http://127.0.0.1:8080",
  ];
}

const allowedOrigins = parseAllowedOrigins();

function isOriginAllowed(origin) {
  if (!origin) return true; // non-browser clients
  if (!allowedOrigins || allowedOrigins.length === 0) return true;
  return allowedOrigins.includes(origin);
}

const corsOptions = {
  origin(origin, cb) {
    // IMPORTANT: Never throw here. Returning an error can become a 500 and look like instability.
    if (isOriginAllowed(origin)) return cb(null, true);
    return cb(null, false); // browser will block; server stays stable
  },
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With"],
  maxAge: 86400,
  optionsSuccessStatus: 204,
};

app.use(cors(corsOptions));
app.options("*", cors(corsOptions));

app.get("/favicon.ico", (_req, res) => res.status(204).end());

// If CORS blocks a browser, it will simply not expose the response.
// For non-browser / debugging, return a friendly 403 for API routes.
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (req.path.startsWith("/api/") && origin && !isOriginAllowed(origin)) {
    return res.status(403).json({ ok: false, error: "CORS origin not allowed" });
  }
  next();
});

// -----------------------------
// Rate limiting (keeps cost low / prevents accidental spam)
// -----------------------------
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: Number(process.env.RATE_LIMIT_PER_MINUTE || 60),
  standardHeaders: true,
  legacyHeaders: false,
});
app.use("/api/", apiLimiter);

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

function safeInt(n, def, min, max) {
  const v = Number(n);
  if (!isFinite(v)) return def;
  return Math.max(min, Math.min(max, Math.round(v)));
}

// -----------------------------
// Templates
// -----------------------------
function resolveTemplatePath(fileName) {
  // templates are typically in /templates in the Render repo
  const candidates = [
    path.join(process.cwd(), "templates", fileName),
    path.join(process.cwd(), fileName),
    path.join(__dirname, "templates", fileName),
    path.join(__dirname, fileName),
    // if launched from repo root where api/ exists:
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

app.post("/api/reload-templates", (req, res) => {
  try {
    const tokenRequired = String(process.env.RELOAD_TEMPLATES_TOKEN || "").trim();
    if (tokenRequired) {
      const got = String(req.headers["x-reload-templates-token"] || "").trim();
      if (got !== tokenRequired) {
        return res.status(403).json({ ok: false, error: "Forbidden" });
      }
    }
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
    if (re.test(out)) {
      out = out.replace(re, `$1${value}$3`);
    } else {
      out = out.replace(/:root\s*\{/, `:root{\n  --${name}:${value};`);
    }
  };

  // Your CSS template uses these:
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
// Spec generation (Step 2)
// -----------------------------
function sanitizeSpec(spec) {
  const s = spec && typeof spec === "object" ? spec : {};

  const out = {
    title: String(s.title || "ChatTok Live Game").trim(),
    subtitle: String(s.subtitle || "Live Interactive").trim(),
    oneSentence: String(s.oneSentence || "Chat and gifts power up the action.").trim(),
    howToPlay: Array.isArray(s.howToPlay) ? s.howToPlay.map((x) => String(x || "")) : [],
    // Step 2: detailed plan text (what it builds, host does, TikTok actions)
    plan: String(s.plan || "").trim(),
    tiktokActions: s.tiktokActions && typeof s.tiktokActions === "object" ? s.tiktokActions : {},
    defaultSettings: s.defaultSettings && typeof s.defaultSettings === "object" ? s.defaultSettings : {},
  };

  if (!out.howToPlay.length) {
    out.howToPlay = ["Chat to interact.", "Likes add energy.", "Gifts trigger power-ups."];
  }

  out.defaultSettings.roundSeconds = safeInt(out.defaultSettings.roundSeconds, 30, 10, 300);
  out.defaultSettings.winGoal = safeInt(out.defaultSettings.winGoal, 50, 1, 9999);

  // Ensure action lists exist (builder uses these to display “what will happen”)
  const a = out.tiktokActions || {};
  out.tiktokActions = {
    join: Array.isArray(a.join) ? a.join.map(String).slice(0, 6) : ["JOIN spawns your player orb into the arena."],
    chat: Array.isArray(a.chat) ? a.chat.map(String).slice(0, 8) : ["SHOOT fires a blast.", "SHIELD adds a temporary shield.", "BOMB spends energy to clear enemies."],
    like: Array.isArray(a.like) ? a.like.map(String).slice(0, 6) : ["Likes fill the Energy meter to power stronger actions."],
    gift: Array.isArray(a.gift) ? a.gift.map(String).slice(0, 6) : ["Small gifts: rapid fire.", "Medium gifts: shield boost.", "Big gifts: boss spawn / nuke."],
    host: Array.isArray(a.host) ? a.host.map(String).slice(0, 6) : ["Host enters LIVE ID and starts the game.", "Host can encourage viewers to type JOIN / SHOOT / SHIELD / BOMB."],
  };

  if (!out.plan) {
    out.plan =
      "This builds a fast arcade ‘Orb Arena’ game with a 9:16 stage, moving enemies, visible projectiles, and a live Energy meter. " +
      "Viewers type JOIN to enter the arena and chat commands like SHOOT/SHIELD/BOMB to trigger actions. " +
      "Likes fill Energy (stronger/faster actions), and gifts trigger tiered power-ups including boss events. " +
      "The host starts the connection and hypes the audience to drive the action in real time.";
  }

  return out;
}

async function generateSpec({ apiKey, model, idea, templateId, baseSpec, revisionText }) {
  // Keep prompt compact to control cost
  const prompt = [
    "Return ONLY valid JSON. No markdown. No extra text.",
    "You are generating a SPEC/PLAN for a TikTok LIVE interactive game builder.",
    "Hard rules:",
    "- Must be a real game immediately on load: visible entities + motion + HUD (even before TikTok connects).",
    "- Must clearly describe what will be built and exactly how TikTok actions map to gameplay.",
    "- Keep it concise but specific. No fluff.",
    "",
    "JSON shape:",
    "{",
    '  "title":"string",',
    '  "subtitle":"string",',
    '  "oneSentence":"string",',
    '  "plan":"string (detailed but compact; what will be built + host actions + TikTok actions)",',
    '  "howToPlay":["string","string","string","..."],',
    '  "tiktokActions":{"join":["..."],"chat":["..."],"like":["..."],"gift":["..."],"host":["..."]},',
    '  "defaultSettings":{"roundSeconds":number,"winGoal":number}',
    "}",
    "",
    `Template hint: ${templateId}`,
    "",
    baseSpec ? "Existing spec to revise:\n" + JSON.stringify(baseSpec) : "",
    revisionText ? "\nUser revision request:\n" + revisionText : "",
    !baseSpec && !revisionText ? "\nGame idea:\n" + idea : "",
  ]
    .filter(Boolean)
    .join("\n");

  const raw = await callOpenAIResponses({
    apiKey,
    model,
    maxOutputTokens: Number(process.env.OPENAI_MAX_OUTPUT_TOKENS_SPEC || 900),
    prompt,
  });

  let parsed = parseJsonLoose(extractAssistantText(raw));
  if (!parsed.ok) {
    const repair = "Fix into valid JSON only. No extra text.\n\n" + extractAssistantText(raw);
    const raw2 = await callOpenAIResponses({
      apiKey,
      model,
      maxOutputTokens: Number(process.env.OPENAI_MAX_OUTPUT_TOKENS_SPEC || 900),
      prompt: repair,
    });
    parsed = parseJsonLoose(extractAssistantText(raw2));
  }
  assert(parsed.ok, "Spec generation failed (invalid JSON).");
  return sanitizeSpec(parsed.value || {});
}

// Step 2 endpoint
app.post("/api/spec", async (req, res) => {
  try {
    const idea = pickIdea(req.body);
    const templateId = String(req.body?.templateId || req.body?.template || "orb").trim().toLowerCase();

    const baseSpec = req.body?.baseSpec && typeof req.body.baseSpec === "object" ? req.body.baseSpec : null;
    const revisionText = String(req.body?.revisionText || req.body?.planEdits || "").trim();

    assert(idea || baseSpec, "Missing idea text (or baseSpec).");

    const apiKey = String(process.env.OPENAI_API_KEY || "").trim();
    assert(apiKey, "OPENAI_API_KEY is missing/blank in Render environment variables.");

    const modelSpec = String(process.env.OPENAI_MODEL_SPEC || "gpt-4o-mini").trim();

    const spec = await generateSpec({
      apiKey,
      model: modelSpec,
      idea: idea || "",
      templateId,
      baseSpec: baseSpec || null,
      revisionText: revisionText || "",
    });

    return res.json({ ok: true, spec, context: { spec, templateId } });
  } catch (err) {
    console.error("/api/spec error:", err);
    return res.status(err.status || 500).json({
      ok: false,
      error: err?.message || String(err),
      details: err.details || null,
    });
  }
});

// -----------------------------
// AI_REGION generation for Orb Arena template
// The snippet MUST execute at load and must extend handlers safely.
// -----------------------------
function fallbackAiRegion() {
  // Safe: extends chat with 1 extra command, no assumptions, no crashes
  return `
(function(){
  try{
    const _chat = (typeof orbOnChatMessage === "function") ? orbOnChatMessage : null;
    if (_chat){
      orbOnChatMessage = function(data){
        try{ _chat(data); } catch(e){ console.error("orig chat error", e); }
        try{
          const msg = data || {};
          const text = (typeof getChatTextFromMessage === "function") ? getChatTextFromMessage(msg) : "";
          const user = (typeof getUserFromMessage === "function") ? getUserFromMessage(msg) : { nickname:"Viewer", userId:"viewer", profilePictureUrl:"" };
          const t = String(text||"").trim().toLowerCase();
          if (!t) return;

          // Extra command: "WAVE" spawns enemies (visible reaction)
          if (t === "wave" || t === "!wave" || t.includes(" wave")){
            if (typeof addEnemy === "function"){
              addEnemy(2); addEnemy(2); addEnemy(3);
            }
            if (typeof pushFlag === "function"){
              pushFlag("chat", user, "WAVE spawned!", "tint-pink");
            }
            if (typeof burst === "function" && typeof GAME === "object"){
              burst(GAME.w*0.5, GAME.h*0.42, 1.8);
            }
          }
        }catch(e){ console.error("ai chat error", e); }
      };
    }
  }catch(e){
    console.error("AI_REGION init error", e);
  }
})();`.trim();
}

function sanitizeAiRegion(code) {
  const c = String(code || "").trim();
  if (!c) return { ok: false, reason: "empty" };

  // Basic safety: no require/import, no eval/new Function
  if (/\brequire\s*\(/.test(c) || /\bimport\s+/.test(c)) return { ok: false, reason: "require/import not allowed" };
  if (/\beval\s*\(/.test(c) || /new\s+Function\s*\(/.test(c)) return { ok: false, reason: "eval not allowed" };

  // Must reference at least one handler so it actually changes behavior
  if (!/orbOnChatMessage|orbOnGiftMessage|orbOnLikeMessage/.test(c)) {
    return { ok: false, reason: "must extend at least one Orb handler" };
  }

  // Encourage try/catch to avoid hard crashes
  if (!/\btry\s*\{/.test(c)) return { ok: false, reason: "missing try/catch" };

  return { ok: true, code: c };
}

async function generateAiRegion({ apiKey, model, idea, spec, templateId, changeRequest }) {
  const prompt = [
    "Return ONLY JavaScript code. No markdown. No code fences.",
    "You are generating a SMALL snippet for the AI_REGION inside game.template.js.",
    "Context: The base game is an 'Orb Arena' arcade game that already supports JOIN/SHOOT/SHIELD/BOMB.",
    "",
    "Hard rules:",
    "- Your code runs at load time. Wrap in an IIFE: (function(){ ... })();",
    "- Safely EXTEND the game by wrapping at least one handler: orbOnChatMessage, orbOnGiftMessage, orbOnLikeMessage.",
    "- Always call the original handler first (inside try/catch) so baseline commands keep working.",
    "- Add 2–4 NEW chat commands that create visible actions (spawns, bursts, meteors, dash, slow-mo, etc.).",
    "- Use only existing helpers if present: pushFlag, burst, addEnemy, ensurePlayer, shootFromPlayer, applyLikeImpulse, applyGiftPower, GAME.",
    "- Do NOT use require/import/eval.",
    "- Keep it short and safe (no long code).",
    "",
    `Template hint: ${templateId}`,
    "Spec JSON:",
    JSON.stringify(spec),
    "",
    changeRequest ? "Change request:\n" + changeRequest : "Game idea:\n" + idea,
  ].join("\n");

  const raw = await callOpenAIResponses({
    apiKey,
    model,
    maxOutputTokens: Number(process.env.OPENAI_MAX_OUTPUT_TOKENS_JS || 700),
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

// Only enforce token safety if someone introduces unsafe patterns later.
// (Do NOT modify overlay behavior; the template already hides overlay on "connected".)
function enforceTokenSafety(jsText) {
  let out = String(jsText || "");

  // Replace unsafe direct calls if they appear.
  // Example unsafe: client.setAccessToken(CHATTOK_CREATOR_TOKEN);
  out = out.replace(
    /client\.setAccessToken\(\s*(CHATTOK_CREATOR_TOKEN|window\.CHATTOK_CREATOR_TOKEN)\s*\)\s*;?/g,
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

  return out;
}

// -----------------------------
// HTML rendering (index.template.html)
// -----------------------------
function renderSettingsFieldsHtml(spec) {
  const round = safeInt(spec?.defaultSettings?.roundSeconds, 30, 10, 300);
  const goal = safeInt(spec?.defaultSettings?.winGoal, 50, 1, 9999);

  // index.template.html already wraps in .form-grid
  return `
<label class="field">
  <span class="field-label">Round seconds</span>
  <input data-setting="roundSeconds" type="number" min="10" max="300" value="${round}" />
</label>

<label class="field">
  <span class="field-label">Win goal</span>
  <input data-setting="winGoal" type="number" min="1" max="9999" value="${goal}" />
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
// Validations (cheap + strict)
// -----------------------------
function validateGeneratedHtml(html) {
  const requiredIds = ["setupOverlay", "startGameBtn", "liveIdInput", "gameRoot", "flags"];
  for (const id of requiredIds) {
    if (!html.includes(`id="${id}"`) && !html.includes(`id='${id}'`)) {
      throw new Error(`index.html missing required id: ${id}`);
    }
  }
  // Ensure only one liveIdInput
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
  // Token rule must be respected (no direct unsafe access)
  if (js.includes("setAccessToken(window.CHATTOK_CREATOR_TOKEN ||")) {
    throw new Error("game.js violates token rule (setAccessToken called with unsafe fallback)");
  }
}

// -----------------------------
// POST /api/generate (Step 3 builds)
// -----------------------------
app.post("/api/generate", async (req, res) => {
  try {
    const stage = normalizeStage(req.body?.stage);
    const wantBundle = !stage;

    const idea = pickIdea(req.body);
    assert(idea || wantBundle || req.body?.context?.spec, "Missing idea text.");

    const templateId = String(req.body?.templateId || req.body?.template || "orb").trim().toLowerCase();
    const theme = req.body?.theme || req.body?.colors || {};

    const ctx = req.body?.context && typeof req.body.context === "object" ? req.body.context : {};
    const ctxSpec = ctx.spec && typeof ctx.spec === "object" ? ctx.spec : null;

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

    // OpenAI key required for spec/html/js
    const apiKey = String(process.env.OPENAI_API_KEY || "").trim();
    assert(apiKey, "OPENAI_API_KEY is missing/blank in Render environment variables.");

    const modelSpec = String(process.env.OPENAI_MODEL_SPEC || "gpt-4o-mini").trim();
    const modelJs = String(process.env.OPENAI_MODEL_JS || process.env.OPENAI_MODEL_AI || "gpt-4o-mini").trim();

    // HTML stage (uses spec -> index.html)
    if (!wantBundle && stage === "html") {
      const spec = sanitizeSpec(ctxSpec || (await generateSpec({ apiKey, model: modelSpec, idea, templateId })));
      const html = renderIndexHtml(TEMPLATES.index, spec);
      validateGeneratedHtml(html);
      return res.json({
        ok: true,
        stage,
        file: { name: "index.html", content: html },
        context: { spec, templateId },
      });
    }

    // JS stage (inject spec + AI_REGION)
    if (!wantBundle && stage === "js") {
      const spec = sanitizeSpec(ctxSpec || (await generateSpec({ apiKey, model: modelSpec, idea, templateId })));
      const aiCode = await generateAiRegion({ apiKey, model: modelJs, idea, spec, templateId });

      let js = injectSpecIntoGameJs(TEMPLATES.game, spec);
      js = replaceBetweenMarkers(js, "// === AI_REGION_START ===", "// === AI_REGION_END ===", aiCode);
      js = enforceTokenSafety(js);
      validateGeneratedJs(js);

      return res.json({
        ok: true,
        stage,
        file: { name: "game.js", content: js },
        context: { spec, templateId },
      });
    }

    // Bundle (optional)
    const spec = sanitizeSpec(ctxSpec || (await generateSpec({ apiKey, model: modelSpec, idea, templateId })));
    const html = renderIndexHtml(TEMPLATES.index, spec);
    const css = injectThemeVars(TEMPLATES.css, theme);
    const aiCode = await generateAiRegion({ apiKey, model: modelJs, idea, spec, templateId });

    let js = injectSpecIntoGameJs(TEMPLATES.game, spec);
    js = replaceBetweenMarkers(js, "// === AI_REGION_START ===", "// === AI_REGION_END ===", aiCode);
    js = enforceTokenSafety(js);

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
// POST /api/edit (Step 4 limited edits)
// - Regenerates ONLY AI_REGION in current game.js (safe)
// - Theme-only edits re-inject CSS vars from template
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

    const templateId = String(req.body?.templateId || "orb").trim().toLowerCase();
    const theme = req.body?.theme || req.body?.colors || {};

    // Theme shortcut (cheap)
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

    const apiKey = String(process.env.OPENAI_API_KEY || "").trim();
    assert(apiKey, "OPENAI_API_KEY is missing/blank in Render environment variables.");

    // Recover spec from const SPEC if possible
    let spec = null;
    const specMatch = currentJs.match(/const\s+SPEC\s*=\s*(\{[\s\S]*?\});/m);
    if (specMatch && specMatch[1]) {
      const parsed = parseJsonLoose(specMatch[1]);
      if (parsed.ok) spec = parsed.value;
    }
    spec = sanitizeSpec(spec || {
      title: "ChatTok Live Game",
      subtitle: "Live Interactive",
      oneSentence: "Chat and gifts power up the action.",
      plan: "",
      howToPlay: ["Chat to interact.", "Likes add energy.", "Gifts trigger power-ups."],
      tiktokActions: {},
      defaultSettings: { roundSeconds: 30, winGoal: 50 },
    });

    const modelJs = String(process.env.OPENAI_MODEL_JS || process.env.OPENAI_MODEL_AI || "gpt-4o-mini").trim();
    const aiCode = await generateAiRegion({
      apiKey,
      model: modelJs,
      idea: "",
      spec,
      templateId,
      changeRequest,
    });

    let newJs = replaceBetweenMarkers(currentJs, "// === AI_REGION_START ===", "// === AI_REGION_END ===", aiCode);
    newJs = enforceTokenSafety(newJs);
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
    endpoints: ["GET /health", "POST /api/spec", "POST /api/generate", "POST /api/edit"],
    origins: allowedOrigins,
    models: {
      spec: process.env.OPENAI_MODEL_SPEC || "gpt-4o-mini",
      js: process.env.OPENAI_MODEL_JS || process.env.OPENAI_MODEL_AI || "gpt-4o-mini",
    },
    templates: {
      index: !!TEMPLATES.index,
      css: !!TEMPLATES.css,
      game: !!TEMPLATES.game,
    },
  });
});

// -----------------------------
// JSON parse error handler (stability)
// -----------------------------
app.use((err, _req, res, _next) => {
  if (err && err.type === "entity.parse.failed") {
    return res.status(400).json({ ok: false, error: "Invalid JSON body." });
  }
  return res.status(500).json({ ok: false, error: "Server error." });
});

// -----------------------------
// Listen (exactly one)
// -----------------------------
app.listen(PORT, HOST, () => {
  console.log(`Builder API running: http://${HOST}:${PORT}`);
  console.log(`Allowed origins: ${allowedOrigins.join(", ")}`);
});
