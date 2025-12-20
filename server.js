const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const fs = require("fs");
const path = require("path");

// Local dev only; Render uses Environment Variables
try { require("dotenv").config(); } catch {}

const app = express();
app.set("trust proxy", 1);

// -----------------------------
// CORS (must be early)
// -----------------------------
const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

const corsOptions = {
  origin(origin, cb) {
    // allow curl / server-to-server
    if (!origin) return cb(null, true);

    // DEV fallback: if no allowlist, allow all
    if (allowedOrigins.length === 0) return cb(null, true);

    if (allowedOrigins.includes(origin)) return cb(null, true);

    return cb(new Error(`CORS blocked origin: ${origin}`), false);
  },
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type"],
  optionsSuccessStatus: 204,
};

app.use(cors(corsOptions));
app.options("*", cors(corsOptions));

// -----------------------------
// Middleware
// -----------------------------
app.use(express.json({ limit: "10mb" }));

app.use(
  rateLimit({
    windowMs: 60 * 1000,
    limit: 120,
    standardHeaders: true,
    legacyHeaders: false,
  })
);

app.get("/favicon.ico", (_req, res) => res.status(204).end());

// Node 18+ required for global fetch
if (typeof fetch !== "function") {
  console.error("ERROR: global fetch is missing. Use Node 18+.");
  process.exit(1);
}

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
// Templates (ROOT of ChatOck-Builder-API)
// -----------------------------
function resolveTemplatePath(fileName) {
  // Your repo root is ChatOck-Builder-API, server.js is in root.
  // We support both:
  // - /index.template.html (root)
  // - /templates/index.template.html
  const cwd = process.cwd();
  const dir = __dirname;

  const candidates = [
    // cwd
    path.join(cwd, fileName),
    path.join(cwd, "templates", fileName),

    // script dir
    path.join(dir, fileName),
    path.join(dir, "templates", fileName),

    // if Render root directory is set to a subfolder, allow one-up
    path.join(cwd, "..", fileName),
    path.join(cwd, "..", "templates", fileName),
    path.join(dir, "..", fileName),
    path.join(dir, "..", "templates", fileName),
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

  // Your css template uses --pink, --aqua, --bg
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
// Spec + AI region generation
// -----------------------------
async function generateSpec({ apiKey, model, idea, templateId }) {
  const prompt = [
    "Return ONLY valid JSON. No markdown. No extra text.",
    "Create a compact spec for a TikTok LIVE interactive game (template-first builder).",
    "Hard rules:",
    "- Must feel like a real game even before connect (characters + HUD + motion).",
    "- Define viewer interactions for chat/like/gift/join.",
    "- Keep settings minimal: roundSeconds and winGoal only.",
    "",
    `Template hint: ${templateId}`,
    "",
    "JSON shape:",
    "{",
    '  "title":"string",',
    '  "subtitle":"string",',
    '  "oneSentence":"string",',
    '  "howToPlay":["string","string","string","..."],',
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
  spec.title = String(spec.title || "ChatTok Live Game").trim();
  spec.subtitle = String(spec.subtitle || "Live Interactive").trim();
  spec.oneSentence = String(spec.oneSentence || "Chat and gifts power up the action.").trim();
  spec.howToPlay = Array.isArray(spec.howToPlay) ? spec.howToPlay.map(String) : [];
  if (!spec.howToPlay.length) spec.howToPlay = ["Chat to interact.", "Likes add energy.", "Gifts trigger power-ups."];

  spec.defaultSettings = spec.defaultSettings || {};
  spec.defaultSettings.roundSeconds = Number(spec.defaultSettings.roundSeconds || 20);
  spec.defaultSettings.winGoal = Number(spec.defaultSettings.winGoal || 100);
  return spec;
}

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
    "- You can call: renderBase(), renderMeters(), ctx.ui.flag(...), ctx.ui.card(...), ctx.ui.setStatus(...).",
    "- Keep it visually reactive + game-like.",
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
  if (!checked.ok) return fallbackAiRegion();
  return checked.code;
}

// -----------------------------
// Template injection
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

function enforceLockedTikTokAndConnectFirst(jsText) {
  let out = String(jsText || "");

  // token safety
  out = out.replace(
    /client\.setAccessToken\(\s*window\.CHATTOK_CREATOR_TOKEN\s*\|\|\s*""\s*\)\s*;?/g,
    `
  const token = (typeof CHATTOK_CREATOR_TOKEN !== "undefined"
    ? CHATTOK_CREATOR_TOKEN
    : (window && window.CHATTOK_CREATOR_TOKEN)) || "";
  if (token && String(token).trim()) {
    client.setAccessToken(String(token).trim());
  }
`.trim()
  );

  // CONNECT-FIRST: keep overlay until connected event (template-dependent)
  out = out.replace(
    /\n\s*hideOverlay\(\)\s*;\s*\n/g,
    "\n      // CONNECT-FIRST: keep overlay open until 'connected'\n"
  );

  if (!out.includes("CONNECT-FIRST: hide overlay on connected")) {
    out = out.replace(
      /ctx\.connected\s*=\s*true\s*;\s*\n/g,
      (m) =>
        m +
        "    // CONNECT-FIRST: hide overlay on connected\n" +
        "    try { hideOverlay(); } catch {}\n"
    );
  }

  return out;
}

// -----------------------------
// HTML rendering (index.template.html)
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
// Validations
// -----------------------------
function validateGeneratedCss(css) {
  if (!css.includes(":root")) throw new Error("style.css missing :root block");
  if (!css.includes("--pink") || !css.includes("--aqua")) throw new Error("style.css missing theme vars (--pink/--aqua)");
}

function validateGeneratedHtml(html) {
  const requiredIds = ["setupOverlay", "startGameBtn", "liveIdInput", "gameRoot", "flags"];
  for (const id of requiredIds) {
    if (!html.includes(`id="${id}"`) && !html.includes(`id='${id}'`)) {
      throw new Error(`index.html missing required id: ${id}`);
    }
  }
}

function validateGeneratedJs(js) {
  if (!js.includes("new TikTokClient")) throw new Error("game.js missing TikTokClient usage");
  if (!js.includes("// === AI_REGION_START ===") || !js.includes("// === AI_REGION_END ===")) {
    throw new Error("game.js missing AI_REGION markers");
  }
  if (js.includes("setAccessToken(window.CHATTOK_CREATOR_TOKEN")) {
    throw new Error("game.js violates token rule");
  }
}

// -----------------------------
// POST /api/generate (STAGED)
// -----------------------------
app.post("/api/generate", async (req, res) => {
  try {
    const stage = normalizeStage(req.body?.stage);
    assert(stage, "Missing stage. Use html, css, or js.");

    const templateId = String(req.body?.templateId || req.body?.template || "boss").trim().toLowerCase();
    const theme = req.body?.theme || req.body?.colors || {};
    const ctx = req.body?.context && typeof req.body.context === "object" ? req.body.context : {};
    const ctxSpec = ctx.spec || null;

    // ✅ CSS stage does NOT require idea or OpenAI key
    if (stage === "css") {
      const css = injectThemeVars(TEMPLATES.css, theme);
      validateGeneratedCss(css);
      return res.json({
        ok: true,
        stage,
        file: { name: "style.css", content: css },
        context: { spec: ctxSpec, templateId },
      });
    }

    // HTML/JS stages need idea
    const idea = pickIdea(req.body);
    assert(idea, "Missing idea text.");

    // OpenAI key required for html/js
    const apiKey = process.env.OPENAI_API_KEY;
    assert(String(apiKey || "").trim(), "OPENAI_API_KEY is blank. Set it in Render Environment Variables.");

    const modelSpec = String(process.env.OPENAI_MODEL_SPEC || "gpt-4o-mini").trim();
    const modelJs = String(process.env.OPENAI_MODEL_JS || process.env.OPENAI_MODEL_AI || "gpt-4o-mini").trim();

    if (stage === "html") {
      const spec = await generateSpec({ apiKey, model: modelSpec, idea, templateId });
      const html = renderIndexHtml(TEMPLATES.index, spec);
      validateGeneratedHtml(html);
      return res.json({
        ok: true,
        stage,
        file: { name: "index.html", content: html },
        context: { spec, templateId },
      });
    }

    if (stage === "js") {
      const spec = ctxSpec || (await generateSpec({ apiKey, model: modelSpec, idea, templateId }));
      const aiCode = await generateAiRegion({ apiKey, model: modelJs, idea, spec, templateId });

      let js = injectSpecIntoGameJs(TEMPLATES.game, spec);
      js = replaceBetweenMarkers(js, "// === AI_REGION_START ===", "// === AI_REGION_END ===", aiCode);
      js = enforceLockedTikTokAndConnectFirst(js);
      validateGeneratedJs(js);

      return res.json({
        ok: true,
        stage,
        file: { name: "game.js", content: js },
        context: { spec, templateId },
      });
    }

    throw new Error("Invalid stage. Use html, css, or js.");
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
// POST /api/edit (AI_REGION only)
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
    assert(currentJs.trim(), "Missing current game.js");

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
        notes: "Theme updated.",
      });
    }

    const apiKey = process.env.OPENAI_API_KEY;
    assert(String(apiKey || "").trim(), "OPENAI_API_KEY is blank. Set it in Render Environment Variables.");

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
        howToPlay: ["Chat to interact.", "Likes add energy.", "Gifts trigger power-ups."],
        defaultSettings: { roundSeconds: 20, winGoal: 100 },
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
// GET /health
// -----------------------------
app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "builder-api",
    endpoints: ["GET /health", "POST /api/generate", "POST /api/edit", "POST /api/reload-templates"],
    templates: { index: !!TEMPLATES.index, css: !!TEMPLATES.css, game: !!TEMPLATES.game },
    allowedOrigins: allowedOrigins.length ? allowedOrigins : "(dev: allow all)",
  });
});

// -----------------------------
// Start server (ONLY ONCE)
// -----------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Builder API running on port ${PORT}`);
  console.log(`Allowed origins: ${allowedOrigins.join(", ") || "(dev default: allow all)"}`);
});
