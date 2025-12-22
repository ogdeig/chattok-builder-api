/* server.js — ChatTok Builder API (production hardened)
   Goals:
   - ✅ /api/plan exists (builder step 2)
   - ✅ /api/generate stable (no 500 loops)
   - ✅ AI_REGION markers enforced/auto-inserted to avoid "Missing markers" crashes
   - ✅ CORS + preflight reliable for GitHub Pages
   - ✅ No caching for api/health
   - ✅ Exactly one app.listen()
   - ✅ No secrets in frontend; OPENAI key only via env on Render
*/

const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const fs = require("fs");
const path = require("path");

// dotenv optional (Render injects env vars); helps local dev
try { require("dotenv").config(); } catch {}

const app = express();
app.set("trust proxy", 1);

const PORT = Number(process.env.PORT || 3000);

// -----------------------------
// Core middleware
// -----------------------------
app.use(express.json({
  limit: "10mb",
  verify: (req, _res, buf) => { req.rawBody = buf?.toString("utf8") || ""; }
}));

// Never cache API responses (prevents stale builds during rapid testing)
app.use((req, res, next) => {
  if (req.path.startsWith("/api") || req.path === "/health") {
    res.setHeader("Cache-Control", "no-store, max-age=0");
    res.setHeader("Pragma", "no-cache");
  }
  next();
});

// Node 18+ required for global fetch (Render Node 20+ is fine)
if (typeof fetch !== "function") {
  console.error("ERROR: global fetch is missing. Use Node 18+.");
  process.exit(1);
}

// -----------------------------
// Rate limit (light)
// -----------------------------
app.use(rateLimit({
  windowMs: 60 * 1000,
  max: 180,
  standardHeaders: true,
  legacyHeaders: false,
}));

// -----------------------------
// CORS (safe-by-default)
// -----------------------------
function buildAllowedOrigins() {
  const env = String(process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);

  if (env.length) return env;

  // Defaults
  return [
    "https://ogdeig.github.io",
    "http://localhost:3000",
    "http://localhost:5173",
    "http://localhost:5500",
    "http://127.0.0.1:5500",
    "http://127.0.0.1:3000",
  ];
}

const allowedOrigins = buildAllowedOrigins();

const corsOptions = {
  origin(origin, cb) {
    if (!origin) return cb(null, true); // curl / server-to-server
    if (allowedOrigins.includes(origin)) return cb(null, true);
    return cb(new Error(`CORS blocked origin: ${origin}`), false);
  },
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: [
    "Content-Type",
    "Authorization",
    "X-Requested-With",
    "Accept",
    "Origin",
    "Cache-Control",
    "Pragma"
  ],
  optionsSuccessStatus: 204,
  preflightContinue: false,
};

app.use(cors(corsOptions));
app.options("*", cors(corsOptions));

// Friendly JSON when CORS blocks
app.use((err, _req, res, next) => {
  if (err && String(err.message || "").startsWith("CORS blocked origin")) {
    return res.status(403).json({ ok: false, error: err.message });
  }
  return next(err);
});

// JSON parse errors
app.use((err, _req, res, next) => {
  if (err && err.type === "entity.parse.failed") {
    return res.status(400).json({
      ok: false,
      error: "Invalid JSON body.",
      hint: "Check trailing commas / quotes in your request payload.",
    });
  }
  return next(err);
});

app.get("/favicon.ico", (_req, res) => res.status(204).end());

// -----------------------------
// Helpers
// -----------------------------
function assert(cond, msg) { if (!cond) throw new Error(msg); }

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
  s = s.replace(/,\s*([}\]])/g, "$1");
  try {
    return { ok: true, value: JSON.parse(s) };
  } catch (e) {
    return { ok: false, error: e?.message || "JSON.parse failed" };
  }
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
    try { if (fs.existsSync(p)) return p; } catch {}
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

// optional (debug)
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
  let out = String(cssText || "");

  // defaults if missing
  if (!th.primary) th.primary = "#ff0050";
  if (!th.secondary) th.secondary = "#00f2ea";
  if (!th.background) th.background = "#050b17";

  const replaceVar = (name, value) => {
    const re = new RegExp(`(--${name}\\s*:\\s*)([^;]+)(;)`, "i");
    if (re.test(out)) {
      out = out.replace(re, `$1${value}$3`);
    } else {
      out = out.replace(/:root\s*\{/, `:root{\n  --${name}:${value};`);
    }
  };

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
// Spec generation (LOW COST)
// -----------------------------
async function generateSpec({ apiKey, model, idea, templateId }) {
  const prompt = [
    "Return ONLY valid JSON. No markdown. No extra text.",
    "Create a compact spec for a TikTok LIVE interactive game.",
    "Hard rules:",
    "- Must feel like a real game even before connect (characters + HUD + motion).",
    "- Define viewer interactions for chat/like/gift/join/share.",
    "- Keep it clear and implementable.",
    "",
    `Template hint: ${templateId}`,
    "",
    "JSON shape:",
    "{",
    '  "title":"string",',
    '  "subtitle":"string",',
    '  "oneSentence":"string",',
    '  "howToPlay":["string","string","string","..."],',
    '  "defaultSettings":{"roundSeconds":number,"winGoal":number,"joinCommand":"string","actionCommand":"string"}',
    "}",
    "",
    "Game idea:",
    idea,
  ].join("\n");

  const raw = await callOpenAIResponses({
    apiKey,
    model,
    maxOutputTokens: Number(process.env.OPENAI_MAX_OUTPUT_TOKENS_SPEC || 650),
    prompt,
  });

  let parsed = parseJsonLoose(extractAssistantText(raw));
  if (!parsed.ok) {
    const repair = "Fix into valid JSON only. No extra text.\n\n" + extractAssistantText(raw);
    const raw2 = await callOpenAIResponses({
      apiKey,
      model,
      maxOutputTokens: Number(process.env.OPENAI_MAX_OUTPUT_TOKENS_SPEC || 650),
      prompt: repair,
    });
    parsed = parseJsonLoose(extractAssistantText(raw2));
  }
  assert(parsed.ok, "Spec generation failed (invalid JSON).");

  const spec = parsed.value || {};
  spec.title = String(spec.title || "ChatTok Live Game").trim();
  spec.subtitle = String(spec.subtitle || "Live Interactive").trim();
  spec.oneSentence = String(spec.oneSentence || "Chat and gifts power up the action.").trim();
  spec.howToPlay = Array.isArray(spec.howToPlay) ? spec.howToPlay.map(String) : [];
  if (!spec.howToPlay.length) {
    spec.howToPlay = ["Type the join command to enter.", "Likes charge power.", "Gifts trigger big effects."];
  }
  spec.defaultSettings = spec.defaultSettings || {};
  spec.defaultSettings.roundSeconds = Number(spec.defaultSettings.roundSeconds || 90);
  spec.defaultSettings.winGoal = Number(spec.defaultSettings.winGoal || 25);
  spec.defaultSettings.joinCommand = String(spec.defaultSettings.joinCommand || "join");
  spec.defaultSettings.actionCommand = String(spec.defaultSettings.actionCommand || "pulse");
  return spec;
}

// -----------------------------
// Plan text (NO extra LLM call)
// -----------------------------
function buildPlanText(spec, templateId) {
  const s = spec || {};
  const ds = s.defaultSettings || {};
  const joinCmd = ds.joinCommand || "join";
  const actCmd = ds.actionCommand || "pulse";
  const round = ds.roundSeconds || 90;
  const goal = ds.winGoal || 25;

  // Deterministic, detailed, editable in builder UI
  return [
    `TITLE: ${s.title || "ChatTok Live Game"}`,
    `SUBTITLE: ${s.subtitle || "Live Interactive"}`,
    "",
    "WHAT WILL BE BUILT",
    "- A 9:16 vertical game screen with a visible arena, moving entities, HUD, and live event pop-outs.",
    "- The game is playable immediately (demo mode) so testing never shows a blank screen.",
    "",
    "CORE GAME LOOP",
    "- Viewers join the arena, then trigger the main action to score points.",
    `- First to ${goal} points wins (or the top score when ${round} seconds ends).`,
    "",
    "TIKTOK INPUTS (VIEWERS)",
    `- CHAT: Type “${joinCmd}” to join.`,
    `- CHAT: Type “${actCmd}” to trigger the main action (attack/ability/guess/etc depending on the game concept).`,
    "- LIKES: Increase a power/charge meter that makes actions stronger or faster.",
    "- GIFTS: Trigger major events (boss spawns, powerups, big score boosts, special effects).",
    "- SHARES (OPTIONAL): Can count as JOIN and/or ACTION for viewers whose chat is not visible.",
    "",
    "HOST CONTROLS (SETTINGS PANEL)",
    "- LIVE ID input + Connect button.",
    "- Round seconds + Win goal.",
    "- Join command keyword + Action command keyword (editable).",
    "- Toggles for whether shares count as join/action.",
    "- Notification mode (flags/on/off).",
    "",
    "NOTES",
    "- The game does NOT ship platform scripts (no tiktok-client.js edits).",
    "- In ChatTokGaming preview/live, platform injection provides TikTokClient + proto.",
    "- If those scripts are not injected (local testing), the game still runs in demo mode.",
  ].join("\n");
}

// -----------------------------
// AI region generation (safe)
// -----------------------------
function fallbackAiRegion() {
  return `
function aiInit(ctx){
  renderBase();
  renderMeters();
  ctx.ui.flag({ who:"SYSTEM", msg:"Demo running — connect to TikTok to go live.", pfp:"" });
}

function aiOnChat(ctx, chat){
  if (!chat || !chat.text) return;
  if (chat.text.toLowerCase().includes("boom")) {
    ctx.ui.flag({ who: chat.nickname || "viewer", msg: "💥 BOOM!", pfp: chat.pfp || "" });
  }
}

function aiOnLike(ctx, like){
  if ((ctx.state.counters.likes % 50) === 0) {
    ctx.ui.flag({ who:"SYSTEM", msg:"Likes power rising ⚡", pfp:"" });
  }
}

function aiOnGift(ctx, gift){
  ctx.ui.flag({ who: gift.nickname || "viewer", msg: "Gift power-up activated 🎁", pfp: gift.pfp || "" });
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
    "Generate ONLY code that goes inside the AI_REGION of game.template.js.",
    "You MUST define exactly:",
    "- aiInit(ctx)",
    "- aiOnChat(ctx, chat)",
    "- aiOnLike(ctx, like)",
    "- aiOnGift(ctx, gift)",
    "",
    "Rules:",
    "- Do NOT call ctx.on(...).",
    "- Do NOT reference onConnect.",
    "- Allowed helpers: renderBase(), renderMeters(), ctx.ui.flag(...), ctx.ui.card(...), ctx.ui.setStatus(...).",
    "- Keep it visually reactive, simple, and stable.",
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
  if (!checked.ok) return fallbackAiRegion();
  return checked.code;
}

// -----------------------------
// Marker helpers (IMPORTANT FIX)
// -----------------------------
const AI_START = "// === AI_REGION_START ===";
const AI_END = "// === AI_REGION_END ===";

function ensureAiMarkers(jsText) {
  const s = String(jsText || "");
  const hasStart = s.includes(AI_START);
  const hasEnd = s.includes(AI_END);
  if (hasStart && hasEnd) return s;

  // Auto-insert markers at end to prevent 500 loops if template is missing them
  return [
    s.trimEnd(),
    "",
    "",
    AI_START,
    "function aiInit(ctx){ renderBase(); renderMeters(); }",
    "function aiOnChat(ctx, chat){}",
    "function aiOnLike(ctx, like){}",
    "function aiOnGift(ctx, gift){}",
    AI_END,
    "",
  ].join("\n");
}

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

// -----------------------------
// HTML rendering
// -----------------------------
function renderSettingsFieldsHtml(spec) {
  const ds = spec?.defaultSettings || {};
  const round = Number(ds.roundSeconds || 90);
  const goal = Number(ds.winGoal || 25);
  const joinCmd = escapeHtml(String(ds.joinCommand || "join"));
  const actCmd = escapeHtml(String(ds.actionCommand || "pulse"));

  // IMPORTANT: return only fields (index.template wraps the grid)
  return `
<label class="field">
  <span class="field-label">Round seconds</span>
  <input id="roundSeconds" data-setting="roundSeconds" type="number" min="20" max="600" value="${round}" />
</label>

<label class="field">
  <span class="field-label">Win goal</span>
  <input id="winGoal" data-setting="winGoal" type="number" min="5" max="500" value="${goal}" />
</label>

<label class="field field-span">
  <span class="field-label">Chat command (Join)</span>
  <input id="joinCommand" data-setting="joinCommand" type="text" value="${joinCmd}" />
</label>

<label class="field field-span">
  <span class="field-label">Chat command (Action)</span>
  <input id="actionCommand" data-setting="actionCommand" type="text" value="${actCmd}" />
</label>

<label class="field field-span">
  <span class="field-label">Allow shares to count as JOIN</span>
  <select id="allowShareForJoin" data-setting="allowShareForJoin">
    <option value="yes" selected>Yes</option>
    <option value="no">No</option>
  </select>
</label>

<label class="field field-span">
  <span class="field-label">Allow shares to count as ACTION</span>
  <select id="allowShareForAction" data-setting="allowShareForAction">
    <option value="no" selected>No</option>
    <option value="yes">Yes</option>
  </select>
</label>

<label class="field field-span">
  <span class="field-label">Demo mode (offline)</span>
  <select id="demoMode" data-setting="demoMode">
    <option value="yes" selected>Yes</option>
    <option value="no">No</option>
  </select>
</label>

<label class="field field-span">
  <span class="field-label">Notifications</span>
  <select id="notifMode" data-setting="notifMode">
    <option value="auto" selected>Auto</option>
    <option value="flags">Flags</option>
    <option value="off">Off</option>
  </select>
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
// Validations
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
  if (!js.includes(AI_START) || !js.includes(AI_END)) {
    throw new Error("game.js missing AI_REGION markers");
  }
}

// -----------------------------
// Routes
// -----------------------------
app.get("/", (_req, res) => {
  res.json({ ok: true, name: "chattok-builder-api", routes: ["/health", "/api/plan", "/api/generate", "/api/edit"] });
});

app.get("/health", (_req, res) => {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.json({
    ok: true,
    uptime: Math.round(process.uptime()),
    templatesLoaded: {
      index: !!TEMPLATES.index,
      css: !!TEMPLATES.css,
      game: !!TEMPLATES.game,
    },
    allowedOrigins,
  });
});

// ✅ NEW: Plan endpoint (Step 2)
app.post("/api/plan", async (req, res) => {
  try {
    const idea = pickIdea(req.body);
    assert(idea, "Missing idea text.");

    const templateId = String(req.body?.templateId || req.body?.template || "arena").trim().toLowerCase();
    const modelSpec = String(process.env.OPENAI_MODEL_SPEC || "gpt-4o-mini").trim();

    const apiKey = process.env.OPENAI_API_KEY;
    assert(apiKey !== undefined, "OPENAI_API_KEY missing in env.");
    assert(String(apiKey || "").trim(), "OPENAI_API_KEY is blank.");

    const spec = await generateSpec({ apiKey, model: modelSpec, idea, templateId });
    const planText = buildPlanText(spec, templateId);

    return res.json({ ok: true, templateId, spec, planText });
  } catch (err) {
    console.error("/api/plan error:", err);
    return res.status(err.status || 500).json({ ok: false, error: err?.message || String(err), details: err.details || null });
  }
});

// Build endpoint (Step 3)
app.post("/api/generate", async (req, res) => {
  try {
    const stage = normalizeStage(req.body?.stage);
    assert(stage, "Missing stage. Use stage: html | css | js");

    const theme = req.body?.theme || req.body?.colors || {};
    const templateId = String(req.body?.templateId || req.body?.template || "arena").trim().toLowerCase();

    // Spec should come from /api/plan then user edits; allow fallback if missing
    const ctx = req.body?.context && typeof req.body.context === "object" ? req.body.context : {};
    let spec = ctx.spec || req.body?.spec || null;

    const idea = pickIdea(req.body);

    // CSS stage: NO LLM
    if (stage === "css") {
      const css = injectThemeVars(TEMPLATES.css, theme);
      validateGeneratedCss(css);
      return res.json({ ok: true, stage, file: { name: "style.css", content: css }, context: { spec, templateId } });
    }

    const apiKey = process.env.OPENAI_API_KEY;
    assert(apiKey !== undefined, "OPENAI_API_KEY missing in env.");
    assert(String(apiKey || "").trim(), "OPENAI_API_KEY is blank.");

    const modelSpec = String(process.env.OPENAI_MODEL_SPEC || "gpt-4o-mini").trim();
    const modelJs = String(process.env.OPENAI_MODEL_JS || "gpt-4o-mini").trim();

    // If no spec provided, generate it (fallback)
    if (!spec) {
      assert(idea, "Missing idea/spec. Provide spec from /api/plan or provide idea.");
      spec = await generateSpec({ apiKey, model: modelSpec, idea, templateId });
    }

    // HTML stage
    if (stage === "html") {
      const html = renderIndexHtml(TEMPLATES.index, spec);
      validateGeneratedHtml(html);
      return res.json({ ok: true, stage, file: { name: "index.html", content: html }, context: { spec, templateId } });
    }

    // JS stage
    if (stage === "js") {
      assert(spec, "Missing spec for JS build.");

      const aiCode = await generateAiRegion({ apiKey, model: modelJs, idea: idea || "", spec, templateId });
      let js = injectSpecIntoGameJs(TEMPLATES.game, spec);

      // ✅ critical fix: enforce markers even if template missing them
      js = ensureAiMarkers(js);

      js = replaceBetweenMarkers(js, AI_START, AI_END, aiCode);
      validateGeneratedJs(js);

      return res.json({ ok: true, stage, file: { name: "game.js", content: js }, context: { spec, templateId } });
    }

    throw new Error("Unknown stage.");
  } catch (err) {
    console.error("/api/generate error:", err);
    return res.status(err.status || 500).json({ ok: false, error: err?.message || String(err), details: err.details || null });
  }
});

// Optional: edit only regenerates AI_REGION (limited edits)
app.post("/api/edit", async (req, res) => {
  try {
    const remaining = Number(req.body?.remainingEdits ?? 0);
    assert(remaining > 0, "No edits remaining.");

    const changeRequest = String(req.body?.changeRequest || "").trim();
    assert(changeRequest, "Missing changeRequest.");

    const currentFiles = req.body?.currentFiles && typeof req.body.currentFiles === "object" ? req.body.currentFiles : {};
    const currentJs = String(currentFiles["game.js"] || "");
    assert(currentJs.trim(), "Missing current game.js.");

    const templateId = String(req.body?.templateId || "arena").trim().toLowerCase();
    const ctx = req.body?.context && typeof req.body.context === "object" ? req.body.context : {};
    const spec = ctx.spec || req.body?.spec || null;
    assert(spec, "Missing spec (send back context.spec from /api/plan).");

    const apiKey = process.env.OPENAI_API_KEY;
    assert(apiKey !== undefined, "OPENAI_API_KEY missing in env.");
    assert(String(apiKey || "").trim(), "OPENAI_API_KEY is blank.");

    const modelJs = String(process.env.OPENAI_MODEL_JS || "gpt-4o-mini").trim();

    // Regenerate region
    const aiCode = await generateAiRegion({
      apiKey,
      model: modelJs,
      idea: "",
      spec,
      templateId,
      changeRequest
    });

    let js = ensureAiMarkers(currentJs);
    js = replaceBetweenMarkers(js, AI_START, AI_END, aiCode);

    validateGeneratedJs(js);

    return res.json({
      ok: true,
      remainingEdits: remaining - 1,
      patches: [{ name: "game.js", content: js }],
      context: { spec, templateId }
    });
  } catch (err) {
    console.error("/api/edit error:", err);
    return res.status(err.status || 500).json({ ok: false, error: err?.message || String(err), details: err.details || null });
  }
});

// -----------------------------
// Start server (ONE LISTEN)
// -----------------------------
app.listen(PORT, () => {
  console.log(`ChatTok Builder API listening on :${PORT}`);
});
