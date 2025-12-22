/**
 * ChatTok Game Builder API (Render)
 * Goals:
 * - Stable CORS + preflight (GitHub Pages -> Render)
 * - /health fast + no-cache
 * - /api/plan exists (detailed plan/spec for builder Step 2)
 * - /api/generate exists (html/css/js stages + bundle)
 * - JS generation ONLY touches AI_REGION inside game.template.js
 * - NO secrets shipped to GitHub Pages (keys only via env vars)
 *
 * NOTE: Do NOT change tiktok-client.js (platform-provided).
 */

const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

const app = express();
app.use(express.json({ limit: "10mb" }));

const PORT = Number(process.env.PORT || 8787);

// --------------------------------------------
// 0) Safety headers: no caching for API/health
// --------------------------------------------
app.use((req, res, next) => {
  const p = req.path || "";
  if (p === "/health" || p === "/api/health" || p.startsWith("/api/")) {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    res.setHeader("Surrogate-Control", "no-store");
  }
  next();
});

// --------------------------------------------
// 1) CORS (never throws) + preflight
// --------------------------------------------
const defaultAllowed = new Set([
  "https://ogdeig.github.io",
  "http://localhost:3000",
  "http://localhost:5173",
  "http://127.0.0.1:5500",
  "http://localhost:5500",
]);

const envAllowed = String(process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

for (const o of envAllowed) defaultAllowed.add(o);

const corsOptions = {
  origin: (origin, cb) => {
    // Non-browser requests (Render health checks, curl) often have no origin.
    if (!origin) return cb(null, true);
    if (defaultAllowed.has(origin)) return cb(null, true);
    // IMPORTANT: do not throw here
    return cb(null, false);
  },
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  maxAge: 86400,
};

app.use(cors(corsOptions));
app.options("*", cors(corsOptions));

// --------------------------------------------
// 2) Rate limit (cheap protection)
// --------------------------------------------
app.use(
  "/api/",
  rateLimit({
    windowMs: 60 * 1000,
    max: Number(process.env.RATE_LIMIT_PER_MIN || 60),
    standardHeaders: true,
    legacyHeaders: false,
  })
);

// Node 18+ required for global fetch (OpenAI)
if (typeof fetch !== "function") {
  console.error("ERROR: global fetch is missing. Use Node 18+.");
  process.exit(1);
}

// --------------------------------------------
// Helpers
// --------------------------------------------
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

function escapeHtml(s) {
  return String(s || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
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

  // remove trailing commas
  s = s.replace(/,\s*([}\]])/g, "$1");

  try {
    return { ok: true, value: JSON.parse(s) };
  } catch (e) {
    return { ok: false, error: e?.message || "JSON.parse failed" };
  }
}

// --------------------------------------------
// Templates
// --------------------------------------------
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

// --------------------------------------------
// Theme injection (CSS ONLY)
// --------------------------------------------
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

  // CSS template uses these:
  replaceVar("pink", th.primary);
  replaceVar("aqua", th.secondary);
  replaceVar("bg", th.background);

  return out;
}

// --------------------------------------------
// OpenAI (Responses API)
// --------------------------------------------
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

// --------------------------------------------
// Plan/Spec generation (LOW COST, HIGH QUALITY)
// --------------------------------------------
async function generatePlanSpec({ apiKey, model, idea, templateId }) {
  const prompt = [
    "Return ONLY valid JSON. No markdown. No extra text.",
    "You are generating a Plan+Spec for a TikTok LIVE interactive game.",
    "This builder will later generate index.html, style.css, and game.js from templates.",
    "",
    "HARD REQUIREMENTS:",
    "- Game must show visible action immediately (entities + motion + HUD) even before TikTok connect.",
    "- Define meaningful TikTok interactions for: chat, like, gift, join, and (optionally) share.",
    "- If your gameplay needs a chat command keyword, make it a SETTINGS FIELD the host can change.",
    "- If you include a chat-command action, also include a SETTINGS FIELD toggle to allow shares to trigger the same action (optional).",
    "- Keep output compact (low tokens). No long essays.",
    "",
    "JSON shape:",
    "{",
    '  "planText":"string (detailed but compact: what appears on screen + gameplay loop + TikTok actions + what host does)",',
    '  "title":"string",',
    '  "subtitle":"string",',
    '  "oneSentence":"string",',
    '  "howToPlay":["string","string","string"],',
    '  "defaultSettings":{"roundSeconds":number,"winGoal":number},',
    '  "settingsFields":[',
    '     {"key":"string","label":"string","type":"text|number|checkbox|select","default":any,"options":[{"label":"x","value":"y"}] }',
    "  ],",
    '  "uses":{"chatCommand":boolean,"share":boolean,"flags":boolean}',
    "}",
    "",
    `Template hint: ${templateId}`,
    "",
    "Game idea:",
    idea,
  ].join("\n");

  const raw = await callOpenAIResponses({
    apiKey,
    model,
    maxOutputTokens: Number(process.env.OPENAI_MAX_OUTPUT_TOKENS_PLAN || 850),
    prompt,
  });

  let parsed = parseJsonLoose(extractAssistantText(raw));
  if (!parsed.ok) {
    const repair = "Fix into valid JSON only. No extra text.\n\n" + extractAssistantText(raw);
    const raw2 = await callOpenAIResponses({
      apiKey,
      model,
      maxOutputTokens: Number(process.env.OPENAI_MAX_OUTPUT_TOKENS_PLAN || 850),
      prompt: repair,
    });
    parsed = parseJsonLoose(extractAssistantText(raw2));
  }
  assert(parsed.ok, "Plan generation failed (invalid JSON).");

  const spec = parsed.value || {};

  // Normalize (strict + safe)
  spec.title = String(spec.title || "ChatTok Live Game").trim();
  spec.subtitle = String(spec.subtitle || "Live Interactive").trim();
  spec.oneSentence = String(spec.oneSentence || "Chat, likes, and gifts power up the action.").trim();

  spec.planText = String(spec.planText || "").trim();
  if (!spec.planText) {
    spec.planText =
      "On-screen: a 9:16 arcade scene with moving targets, a score HUD, and animated effects.\n" +
      "Gameplay: viewers compete to score points; action is visible immediately.\n" +
      "TikTok: chat triggers actions, likes charge a meter, gifts trigger power-ups, joins spawn a player.\n" +
      "Host: enters LIVE ID and presses Connect & Start; can adjust settings before starting.";
  }

  spec.howToPlay = Array.isArray(spec.howToPlay) ? spec.howToPlay.map((x) => String(x || "")) : [];
  if (!spec.howToPlay.length) spec.howToPlay = ["Chat to interact.", "Likes charge power.", "Gifts trigger boosts."];

  spec.defaultSettings = spec.defaultSettings && typeof spec.defaultSettings === "object" ? spec.defaultSettings : {};
  spec.defaultSettings.roundSeconds = Number(spec.defaultSettings.roundSeconds || 20);
  spec.defaultSettings.winGoal = Number(spec.defaultSettings.winGoal || 100);

  spec.uses = spec.uses && typeof spec.uses === "object" ? spec.uses : {};
  spec.uses.chatCommand = Boolean(spec.uses.chatCommand);
  spec.uses.share = Boolean(spec.uses.share);
  spec.uses.flags = spec.uses.flags === undefined ? true : Boolean(spec.uses.flags);

  // Settings fields (optional)
  spec.settingsFields = Array.isArray(spec.settingsFields) ? spec.settingsFields : [];
  // Always keep roundSeconds + winGoal in settings (host-editable baseline)
  // (Template will already include these two fields; we keep extras here.)
  spec.settingsFields = spec.settingsFields
    .filter((f) => f && typeof f === "object")
    .slice(0, 10)
    .map((f) => ({
      key: String(f.key || "").trim(),
      label: String(f.label || "").trim(),
      type: String(f.type || "text").trim(),
      default: f.default,
      options: Array.isArray(f.options) ? f.options.slice(0, 12) : undefined,
    }))
    .filter((f) => f.key && f.label);

  return spec;
}

// --------------------------------------------
// AI_REGION generation (template-safe)
// --------------------------------------------
function fallbackAiRegion() {
  return `
function aiInit(ctx){
  renderBase();
  renderMeters();
  ctx.ui.flag({ who:"SYSTEM", msg:"Demo running — connect to TikTok to go live.", pfp:"" });
}

function aiOnChat(ctx, chat){
  if (!chat || !chat.text) return;
  const t = String(chat.text).toLowerCase();
  if (t.includes("boom")) ctx.ui.flag({ who: chat.nickname || "viewer", msg:"💥 BOOM!", pfp: chat.pfp || "" });
}

function aiOnLike(ctx, like){
  if ((ctx.state.counters.likes % 50) === 0) ctx.ui.flag({ who:"SYSTEM", msg:"Likes power rising ⚡", pfp:"" });
}

function aiOnGift(ctx, gift){
  ctx.ui.flag({ who: gift.nickname || "viewer", msg:"Power-up activated 🎁", pfp: gift.pfp || "" });
}
  `.trim();
}

function sanitizeAiRegion(code) {
  const c = String(code || "").trim();
  if (!c) return { ok: false, reason: "empty" };

  const needs = ["function aiInit", "function aiOnChat", "function aiOnLike", "function aiOnGift"];
  for (const n of needs) {
    if (!c.includes(n)) return { ok: false, reason: `missing ${n}` };
  }

  if (/\bctx\.on\s*\(/.test(c)) return { ok: false, reason: "ctx.on() not allowed" };
  if (/\bonConnect\b/.test(c)) return { ok: false, reason: "onConnect not allowed" };
  if (/\brequire\s*\(/.test(c) || /\bimport\s+/.test(c)) return { ok: false, reason: "require/import not allowed" };

  return { ok: true, code: c };
}

async function generateAiRegion({ apiKey, model, idea, spec, templateId, changeRequest }) {
  const prompt = [
    "Return ONLY JavaScript code. No markdown. No code fences.",
    "Generate ONLY the code that goes inside AI_REGION of game.template.js.",
    "You MUST define these functions exactly:",
    "- aiInit(ctx)",
    "- aiOnChat(ctx, chat)",
    "- aiOnLike(ctx, like)",
    "- aiOnGift(ctx, gift)",
    "",
    "Critical rules:",
    "- Do NOT call ctx.on(...). ctx is NOT an event emitter.",
    "- Do NOT reference onConnect or ctx.onConnect.",
    "- You MAY call: renderBase(), renderMeters(), ctx.ui.flag(...), ctx.ui.card(...), ctx.ui.setStatus(...).",
    "- Must create visible game action immediately (spawns/motion/effects).",
    "",
    `Template hint: ${templateId}`,
    "",
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

// --------------------------------------------
// Template injection
// --------------------------------------------
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

function enforceLockedTikTokAndConnectFirst(jsText) {
  let out = String(jsText || "");

  // Token rule: only call setAccessToken if token exists and non-empty.
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

  // CONNECT-FIRST: prevent hiding overlay before connected
  out = out.replace(/\n\s*hideOverlay\(\)\s*;\s*\n/g, "\n      // CONNECT-FIRST: keep overlay open until 'connected'\n");

  if (!out.includes("CONNECT-FIRST: hide overlay on connected")) {
    out = out.replace(
      /ctx\.connected\s*=\s*true\s*;\s*\n/g,
      (m) => m + "    // CONNECT-FIRST: hide overlay on connected\n    try { hideOverlay(); } catch {}\n"
    );
  }

  return out;
}

// --------------------------------------------
// HTML rendering
// --------------------------------------------
function renderExtraSettingsFieldsHtml(spec) {
  const fields = Array.isArray(spec?.settingsFields) ? spec.settingsFields : [];
  if (!fields.length) return "";

  const html = [];
  for (const f of fields) {
    const key = String(f.key || "").trim();
    const label = String(f.label || "").trim();
    const type = String(f.type || "text").trim();

    if (!key || !label) continue;

    if (type === "checkbox") {
      const checked = f.default ? "checked" : "";
      html.push(`
<label class="field">
  <span class="field-label">${escapeHtml(label)}</span>
  <input data-setting="${escapeHtml(key)}" type="checkbox" ${checked} />
</label>`.trim());
      continue;
    }

    if (type === "select") {
      const options = Array.isArray(f.options) ? f.options : [];
      const def = f.default;
      html.push(`
<label class="field">
  <span class="field-label">${escapeHtml(label)}</span>
  <select data-setting="${escapeHtml(key)}">
    ${options
      .map((o) => {
        const v = String(o?.value ?? "").trim();
        const l = String(o?.label ?? v).trim();
        const sel = String(def ?? "") === v ? "selected" : "";
        return `<option value="${escapeHtml(v)}" ${sel}>${escapeHtml(l)}</option>`;
      })
      .join("\n")}
  </select>
</label>`.trim());
      continue;
    }

    // number/text
    const inputType = type === "number" ? "number" : "text";
    const defVal = f.default === undefined || f.default === null ? "" : String(f.default);
    html.push(`
<label class="field">
  <span class="field-label">${escapeHtml(label)}</span>
  <input data-setting="${escapeHtml(key)}" type="${inputType}" value="${escapeHtml(defVal)}" />
</label>`.trim());
  }

  return html.join("\n\n").trim();
}

function renderSettingsFieldsHtml(spec) {
  const round = Number(spec?.defaultSettings?.roundSeconds || 20);
  const goal = Number(spec?.defaultSettings?.winGoal || 100);

  // Baseline settings always present:
  const base = `
<label class="field">
  <span class="field-label">Round seconds</span>
  <input data-setting="roundSeconds" type="number" min="5" max="300" value="${round}" />
</label>

<label class="field">
  <span class="field-label">Win goal</span>
  <input data-setting="winGoal" type="number" min="1" max="999" value="${goal}" />
</label>
`.trim();

  const extra = renderExtraSettingsFieldsHtml(spec);
  return extra ? base + "\n\n" + extra : base;
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

// --------------------------------------------
// Validations (cheap + strict)
// --------------------------------------------
function validateGeneratedHtml(html) {
  const requiredIds = ["setupOverlay", "startGameBtn", "liveIdInput", "gameRoot"];
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
    throw new Error("game.js violates token rule (unsafe setAccessToken usage)");
  }
}

// --------------------------------------------
// Routes
// --------------------------------------------

// Root: avoid confusing 404s
app.get("/", (_req, res) => {
  res.json({ ok: true, service: "chattok-builder-api", hint: "Use /health and /api/*" });
});

app.get("/favicon.ico", (_req, res) => res.status(204).end());

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "builder-api",
    endpoints: [
      "GET /",
      "GET /health",
      "POST /api/plan",
      "POST /api/generate",
      "POST /api/edit",
    ],
    models: {
      plan: process.env.OPENAI_MODEL_PLAN || process.env.OPENAI_MODEL_SPEC || "gpt-4o-mini",
      js: process.env.OPENAI_MODEL_JS || process.env.OPENAI_MODEL_AI || "gpt-4o-mini",
    },
    templates: {
      index: !!TEMPLATES.index,
      css: !!TEMPLATES.css,
      game: !!TEMPLATES.game,
    },
    allowedOrigins: Array.from(defaultAllowed),
  });
});

// Alias health (some clients prefer /api/health)
app.get("/api/health", (req, res) => {
  // forward
  req.url = "/health";
  return app._router.handle(req, res);
});

/**
 * POST /api/plan
 * Returns: { ok:true, spec, planText }
 * (Back-compat: fixes your reported /api/plan 404.)
 */
app.post("/api/plan", async (req, res) => {
  try {
    const idea = pickIdea(req.body);
    assert(idea, "Missing idea text.");

    const templateId = String(req.body?.templateId || req.body?.template || "auto").trim().toLowerCase();

    const apiKey = process.env.OPENAI_API_KEY;
    assert(String(apiKey || "").trim(), "OPENAI_API_KEY is missing/blank in Render environment variables.");

    const modelPlan = String(process.env.OPENAI_MODEL_PLAN || process.env.OPENAI_MODEL_SPEC || "gpt-4o-mini").trim();
    const spec = await generatePlanSpec({ apiKey, model: modelPlan, idea, templateId });

    return res.json({ ok: true, spec, planText: spec.planText });
  } catch (err) {
    console.error("/api/plan error:", err);
    return res.status(err.status || 500).json({
      ok: false,
      error: err?.message || String(err),
      details: err.details || null,
    });
  }
});

/**
 * POST /api/generate
 * Stages:
 * - html: returns rendered index.html AND context.spec (and context.planText)
 * - css: theme injection only
 * - js: injects spec JSON + AI_REGION into game.template.js
 * - bundle: if stage is omitted
 */
app.post("/api/generate", async (req, res) => {
  try {
    const stage = normalizeStage(req.body?.stage);
    const wantBundle = !stage;

    const idea = pickIdea(req.body);
    assert(idea || wantBundle, "Missing idea text.");

    const templateId = String(req.body?.templateId || req.body?.template || "auto").trim().toLowerCase();
    const theme = req.body?.theme || req.body?.colors || {};

    const ctx = req.body?.context && typeof req.body.context === "object" ? req.body.context : {};
    const ctxSpec = ctx.spec || null;

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

    // OpenAI needed for html/js
    const apiKey = process.env.OPENAI_API_KEY;
    assert(String(apiKey || "").trim(), "OPENAI_API_KEY is missing/blank in Render environment variables.");

    const modelPlan = String(process.env.OPENAI_MODEL_PLAN || process.env.OPENAI_MODEL_SPEC || "gpt-4o-mini").trim();
    const modelJs = String(process.env.OPENAI_MODEL_JS || process.env.OPENAI_MODEL_AI || "gpt-4o-mini").trim();

    // HTML stage (also acts as PLAN step for current builder)
    if (!wantBundle && stage === "html") {
      const spec = await generatePlanSpec({ apiKey, model: modelPlan, idea, templateId });
      const html = renderIndexHtml(TEMPLATES.index, spec);
      validateGeneratedHtml(html);
      return res.json({
        ok: true,
        stage,
        file: { name: "index.html", content: html },
        context: { spec, planText: spec.planText, templateId },
      });
    }

    // JS stage
    if (!wantBundle && stage === "js") {
      const spec = ctxSpec || (await generatePlanSpec({ apiKey, model: modelPlan, idea, templateId }));
      const changeRequest = String(req.body?.changeRequest || "").trim();

      const aiCode = await generateAiRegion({
        apiKey,
        model: modelJs,
        idea,
        spec,
        templateId,
        changeRequest: changeRequest || "",
      });

      let js = injectSpecIntoGameJs(TEMPLATES.game, spec);
      js = replaceBetweenMarkers(js, "// === AI_REGION_START ===", "// === AI_REGION_END ===", aiCode);
      js = enforceLockedTikTokAndConnectFirst(js);
      validateGeneratedJs(js);

      return res.json({
        ok: true,
        stage,
        file: { name: "game.js", content: js },
        context: { spec, planText: spec.planText, templateId },
      });
    }

    // Bundle mode
    const spec = ctxSpec || (await generatePlanSpec({ apiKey, model: modelPlan, idea, templateId }));
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
      context: { spec, planText: spec.planText, templateId },
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

/**
 * POST /api/edit
 * - Safe edits: only AI_REGION (or theme reinjection)
 */
app.post("/api/edit", async (req, res) => {
  try {
    const remaining = Number(req.body?.remainingEdits ?? 0);
    assert(remaining > 0, "No edits remaining.");

    const changeRequest = String(req.body?.changeRequest || "").trim();
    assert(changeRequest, "Missing changeRequest.");

    const currentFiles = req.body?.currentFiles && typeof req.body.currentFiles === "object" ? req.body.currentFiles : {};
    const currentJs = String(currentFiles["game.js"] || "");

    const templateId = String(req.body?.templateId || "auto").trim().toLowerCase();
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
    assert(String(apiKey || "").trim(), "OPENAI_API_KEY is missing/blank in Render environment variables.");

    // Recover spec from const SPEC = {...}
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
        oneSentence: "Chat, likes, and gifts power up the action.",
        planText: "",
        howToPlay: ["Chat to interact.", "Likes charge power.", "Gifts trigger boosts."],
        defaultSettings: { roundSeconds: 20, winGoal: 100 },
        settingsFields: [],
        uses: { chatCommand: false, share: false, flags: true },
      };
    }

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
    newJs = enforceLockedTikTokAndConnectFirst(newJs);
    validateGeneratedJs(newJs);

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

// --------------------------------------------
// Listen (exactly once)
// --------------------------------------------
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Builder API running on :${PORT}`);
});
