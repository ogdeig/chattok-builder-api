/* =========================================================
   ChatTok Builder API — server.js (Render)

   Non-negotiables honored:
   - No secrets in GitHub Pages (API keys only via Render env)
   - CORS + preflight never crash
   - Exactly ONE app.listen()
   - No caching on /api + /health
   - TikTok platform scripts are NOT shipped by the builder
     (tiktok-client.js / proto bundle are injected by ChatTokGaming)

   Endpoints:
   - GET  /health
   - POST /api/plan      -> returns spec JSON
   - POST /api/generate  -> stage: html|css|js|plan|bundle
   - POST /api/edit      -> regenerates ONLY AI_REGION (optional)
========================================================= */

const fs = require("fs");
const path = require("path");

const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");

require("dotenv").config();

// -----------------------------
// Config
// -----------------------------

const PORT = Number(process.env.PORT || 3000);

// IMPORTANT: Render requires binding on 0.0.0.0
const LISTEN_HOST = "0.0.0.0";

// Only allow known frontends; never throw on mismatch.
const ALLOWED_ORIGINS = new Set(
  String(
    process.env.ALLOWED_ORIGINS ||
      [
        "https://ogdeig.github.io",
        "https://chattokgaming.com",
        "http://localhost:5173",
        "http://localhost:5500",
        "http://127.0.0.1:5500",
      ].join(",")
  )
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
);

function isAllowedOrigin(origin) {
  if (!origin) return false;
  if (ALLOWED_ORIGINS.has(origin)) return true;

  // Allow any subdomain of chattokgaming.com (optional)
  try {
    const u = new URL(origin);
    if (u.hostname === "chattokgaming.com") return true;
    if (u.hostname.endsWith(".chattokgaming.com")) return true;
  } catch {
    // ignore
  }
  return false;
}

const corsDelegate = (req, cb) => {
  const origin = req.header("Origin");

  // No Origin header (curl/server-to-server) -> allow
  if (!origin) {
    return cb(null, {
      origin: false,
      methods: ["GET", "POST", "OPTIONS"],
      allowedHeaders: ["Content-Type"],
      optionsSuccessStatus: 204,
      maxAge: 86400,
    });
  }

  return cb(null, {
    origin: isAllowedOrigin(origin),
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type"],
    optionsSuccessStatus: 204,
    maxAge: 86400,
  });
};

// -----------------------------
// App
// -----------------------------

const app = express();
app.set("trust proxy", 1);

app.use(express.json({ limit: "1mb" }));

// CORS must be BEFORE routes
app.use(cors(corsDelegate));
app.options("*", cors(corsDelegate));

// No-store for API + health (avoid stale tests)
app.use((req, res, next) => {
  const p = req.path || "";
  if (p === "/health" || p.startsWith("/api/")) {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    res.setHeader("Surrogate-Control", "no-store");
  }
  next();
});

// Rate limit (cheap safety)
app.use(
  "/api/",
  rateLimit({
    windowMs: 60_000,
    max: Number(process.env.RATE_LIMIT_PER_MIN || 60),
    standardHeaders: true,
    legacyHeaders: false,
  })
);

// -----------------------------
// Templates
// -----------------------------

function mustRead(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

const TPL_DIR = path.join(__dirname);
const TEMPLATES = {
  index: mustRead(path.join(TPL_DIR, "index.template.html")),
  css: mustRead(path.join(TPL_DIR, "style.template.css")),
  game: mustRead(path.join(TPL_DIR, "game.template.js")),
};

// -----------------------------
// Helpers
// -----------------------------

function httpError(status, message, details) {
  const err = new Error(message || "Error");
  err.status = status;
  if (details) err.details = details;
  return err;
}

function assert(cond, msg) {
  if (!cond) throw httpError(400, msg);
}

function escapeHtml(s) {
  return String(s || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function stripCodeFences(s) {
  const t = String(s || "").trim();
  if (!t.startsWith("```")) return t;
  return t
    .replace(/^```[a-zA-Z]*\s*/m, "")
    .replace(/```\s*$/m, "")
    .trim();
}

function extractAssistantText(openaiResponseJson) {
  // Response API: output_text is easiest; but handle fallback
  try {
    if (openaiResponseJson && typeof openaiResponseJson.output_text === "string") return openaiResponseJson.output_text;
    const out = openaiResponseJson?.output || [];
    const parts = [];
    for (const item of out) {
      const content = item?.content || [];
      for (const c of content) {
        if (c?.type === "output_text" && typeof c.text === "string") parts.push(c.text);
      }
    }
    return parts.join("\n");
  } catch {
    return "";
  }
}

function parseJsonLoose(text) {
  try {
    const s = String(text || "").trim();
    return { ok: true, value: JSON.parse(s) };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

function normalizeStage(s) {
  const v = String(s || "").trim().toLowerCase();
  if (!v) return "";
  if (["plan", "html", "css", "js", "bundle"].includes(v)) return v;
  return "";
}

function pickIdea(body) {
  const idea = String(body?.idea || body?.prompt || body?.description || "").trim();
  return idea;
}

// -----------------------------
// OpenAI (Responses API)
// -----------------------------

async function callOpenAIResponses({ apiKey, model, maxOutputTokens, prompt }) {
  const r = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_output_tokens: maxOutputTokens,
      input: prompt,
    }),
  });

  const txt = await r.text();
  let json = {};
  try {
    json = JSON.parse(txt);
  } catch {
    // ignore
  }

  if (!r.ok) {
    const msg = json?.error?.message || `OpenAI error (${r.status})`;
    throw httpError(500, msg);
  }
  return json;
}

// -----------------------------
// Plan / Spec
// -----------------------------

function heuristicUses(idea) {
  const t = String(idea || "").toLowerCase();
  return {
    chatCommand: /\b(keyword|command|type|guess|vote|answer|join)\b/.test(t),
    shareTrigger: /\bshare\b/.test(t),
    flags: /\b(flag|banner|toast|notification)\b/.test(t),
  };
}

async function generateSpec({ apiKey, model, idea }) {
  const h = heuristicUses(idea);
  const prompt = [
    "Return ONLY valid JSON. No markdown. No extra text.",
    "You are writing a concise but detailed game PLAN for a TikTok LIVE interactive HTML5 game.",
    "The game must be playable immediately even offline (demo mode), with visible motion + HUD.",
    "Keep it short (low tokens) but specific.",
    "",
    "JSON schema:",
    "{",
    '  "title": "string",',
    '  "subtitle": "string",',
    '  "oneSentence": "string",',
    '  "buildSummary": "short paragraph explaining what the game is and what players see",',
    '  "hostSteps": ["step", "step", "..."],',
    '  "tiktokActions": {',
    '     "chat": "what chat does (include command examples if any)",',
    '     "likes": "what likes do",',
    '     "gifts": "what gifts do",',
    '     "joins": "what join events do",',
    '     "shares": "what shares do (or say not used)"',
    "  },",
    '  "uses": {"chatCommand": true/false, "shareTrigger": true/false, "flags": true/false},',
    '  "commands": {"primary": "string"},',
    '  "howToPlay": ["bullet", "bullet", "bullet"],',
    '  "defaultSettings": {"roundSeconds": number, "winGoal": number}',
    "}",
    "",
    "Heuristic (you may adjust but stay sensible):",
    JSON.stringify(h),
    "",
    "Game idea:",
    idea,
  ].join("\n");

  const raw = await callOpenAIResponses({
    apiKey,
    model,
    maxOutputTokens: Number(process.env.OPENAI_MAX_OUTPUT_TOKENS_SPEC || 520),
    prompt,
  });

  let parsed = parseJsonLoose(extractAssistantText(raw));
  if (!parsed.ok) {
    // one quick repair attempt
    const repair = ["Fix into VALID JSON ONLY. No extra words.", extractAssistantText(raw)].join("\n\n");
    const raw2 = await callOpenAIResponses({
      apiKey,
      model,
      maxOutputTokens: Number(process.env.OPENAI_MAX_OUTPUT_TOKENS_SPEC || 520),
      prompt: repair,
    });
    parsed = parseJsonLoose(extractAssistantText(raw2));
  }
  if (!parsed.ok) throw httpError(500, "Spec generation failed (invalid JSON)");

  const spec = parsed.value || {};

  // hard defaults + cleanup
  spec.title = String(spec.title || "ChatTok Live Game").trim();
  spec.subtitle = String(spec.subtitle || "Live Interactive").trim();
  spec.oneSentence = String(spec.oneSentence || "Chat + Likes + Gifts drive the action.").trim();
  spec.buildSummary = String(
    spec.buildSummary ||
      "A fast, visible arcade game you can play instantly — chat and gifts trigger real actions on screen."
  ).trim();

  spec.hostSteps = Array.isArray(spec.hostSteps) ? spec.hostSteps.map(String).slice(0, 8) : [];
  if (!spec.hostSteps.length) {
    spec.hostSteps = [
      "Enter your TikTok LIVE username (no @) and press Connect.",
      "Explain the main command to chat (if used) and the win goal.",
      "Let chat drive the action while you react + hype up the leaderboard.",
    ];
  }

  spec.tiktokActions = spec.tiktokActions && typeof spec.tiktokActions === "object" ? spec.tiktokActions : {};
  spec.uses = spec.uses && typeof spec.uses === "object" ? spec.uses : {};
  spec.commands = spec.commands && typeof spec.commands === "object" ? spec.commands : {};

  // enforce booleans + useful defaults
  const h2 = heuristicUses(idea);
  const u = { ...h2, ...spec.uses };
  spec.uses = {
    chatCommand: Boolean(u.chatCommand),
    shareTrigger: Boolean(u.shareTrigger),
    flags: Boolean(u.flags),
  };

  spec.commands.primary = String(spec.commands.primary || (spec.uses.chatCommand ? "guess" : "") || "").trim();
  if (spec.commands.primary.length > 18) spec.commands.primary = spec.commands.primary.slice(0, 18);

  spec.howToPlay = Array.isArray(spec.howToPlay) ? spec.howToPlay.map(String).slice(0, 8) : [];
  if (!spec.howToPlay.length) {
    spec.howToPlay = [
      spec.uses.chatCommand
        ? `Type ${spec.commands.primary || "guess"} + your move in chat.`
        : "Chat to trigger actions.",
      "Likes charge the power meter.",
      "Gifts trigger big power-ups and visual effects.",
    ];
  }

  spec.defaultSettings = spec.defaultSettings && typeof spec.defaultSettings === "object" ? spec.defaultSettings : {};
  spec.defaultSettings.roundSeconds = Number(spec.defaultSettings.roundSeconds || 30);
  if (!Number.isFinite(spec.defaultSettings.roundSeconds) || spec.defaultSettings.roundSeconds < 5)
    spec.defaultSettings.roundSeconds = 30;

  spec.defaultSettings.winGoal = Number(spec.defaultSettings.winGoal || 15);
  if (!Number.isFinite(spec.defaultSettings.winGoal) || spec.defaultSettings.winGoal < 1) spec.defaultSettings.winGoal = 15;

  return spec;
}

// -----------------------------
// JS AI_REGION
// -----------------------------

function fallbackAiRegion() {
  // Always-valid, playable arcade demo
  return `
function aiInit(ctx){
  // Simple moving targets + scoreboard
  const st = ctx.state;
  st.targets = [];
  st.score = 0;
  st.miss = 0;
  st.lastSpawn = 0;
  st.spawnMs = 650;

  // UI card
  ctx.ui.card({
    title: (SPEC && SPEC.title) ? SPEC.title : "ChatTok Live Game",
    lines: [
      "Demo running (offline).",
      "Connect to TikTok LIVE to enable chat/likes/gifts.",
      "Type 'hit' in chat to score (when live)."
    ]
  });
}

function aiTick(ctx, dt){
  const st = ctx.state;
  const w = ctx.canvas.width, h = ctx.canvas.height;
  st.lastSpawn += dt;
  if (st.lastSpawn > st.spawnMs){
    st.lastSpawn = 0;
    const r = 10 + Math.random()*14;
    st.targets.push({ x: w + r, y: 90 + Math.random()*(h-220), r, vx: -(90 + Math.random()*160) });
    if (st.targets.length > 14) st.targets.shift();
  }
  for (const t of st.targets){ t.x += t.vx * (dt/1000); }
  st.targets = st.targets.filter(t => t.x > -t.r-10);
}

function aiDraw(ctx){
  const g = ctx.g;
  const st = ctx.state;
  const w = ctx.canvas.width, h = ctx.canvas.height;

  // background glow
  g.save();
  g.globalAlpha = 0.9;
  g.fillRect(0,0,w,h);
  g.restore();

  // targets
  g.save();
  for (const t of st.targets){
    g.beginPath();
    g.arc(t.x, t.y, t.r, 0, Math.PI*2);
    g.fill();
  }
  g.restore();

  // HUD
  ctx.ui.hudRight([
    ["Score", String(st.score||0)],
    ["Miss", String(st.miss||0)],
  ]);
}

function aiOnChat(ctx, chat){
  const text = (chat && chat.text ? String(chat.text) : "").trim().toLowerCase();
  if (!text) return;

  // default command: "hit"
  if (!text.includes("hit")) return;
  const st = ctx.state;
  if (!st.targets || !st.targets.length) return;
  st.targets.shift();
  st.score = (st.score||0)+1;
  ctx.ui.flag({ who: chat.nickname || "viewer", msg: "✅ HIT!", pfp: chat.pfp || "" });
}

function aiOnLike(ctx, like){
  // likes already charge meters in template
  if ((ctx.state.counters.likes % 50) === 0){
    ctx.ui.flag({ who: "SYSTEM", msg: "⚡ Power rising", pfp: "" });
  }
}

function aiOnGift(ctx, gift){
  // gift = clear screen + bonus
  const st = ctx.state;
  st.targets = [];
  st.score = (st.score||0) + 3;
  ctx.ui.flag({ who: gift.nickname || "viewer", msg: "🎁 POWER-UP +3", pfp: gift.pfp || "" });
}
  `.trim();
}

function sanitizeAiRegion(code) {
  const c = String(code || "").trim();
  if (!c) return { ok: false, reason: "empty" };

  // must define core handlers
  const needs = ["function aiInit", "function aiOnChat", "function aiOnLike", "function aiOnGift"];
  for (const n of needs) if (!c.includes(n)) return { ok: false, reason: `missing ${n}` };

  // common crash patterns
  if (/\bctx\.on\s*\(/.test(c)) return { ok: false, reason: "ctx.on not allowed" };
  if (/\brequire\s*\(/.test(c) || /\bimport\s+/.test(c)) return { ok: false, reason: "require/import not allowed" };

  return { ok: true, code: c };
}

async function generateAiRegion({ apiKey, model, idea, spec, changeRequest }) {
  const prompt = [
    "Return ONLY JavaScript code. No markdown. No code fences.",
    "Generate ONLY the code that goes inside the AI_REGION of game.template.js.",
    "You MUST define these functions exactly:",
    "- aiInit(ctx)",
    "- aiOnChat(ctx, chat)",
    "- aiOnLike(ctx, like)",
    "- aiOnGift(ctx, gift)",
    "",
    "Optional but allowed (only if you need it):",
    "- aiTick(ctx, dt)  // for per-frame logic",
    "- aiDraw(ctx)      // for custom rendering",
    "",
    "Rules:",
    "- Do NOT call ctx.on(...)",
    "- Do NOT import/require",
    "- Use ctx.ui.flag / ctx.ui.card / ctx.ui.hudRight for UI",
    "- Keep it visibly animated + playable even offline.",
    "",
    "Spec JSON:",
    JSON.stringify(spec),
    "",
    changeRequest ? "Change request:\n" + changeRequest : "Game idea:\n" + idea,
  ].join("\n");

  const raw = await callOpenAIResponses({
    apiKey,
    model,
    maxOutputTokens: Number(process.env.OPENAI_MAX_OUTPUT_TOKENS_JS || 1100),
    prompt,
  });

  const code = stripCodeFences(extractAssistantText(raw));
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
  if (a === -1 || b === -1 || b <= a) {
    throw httpError(500, `Missing markers: ${startMarker} / ${endMarker}`);
  }
  const before = fullText.slice(0, a + startMarker.length);
  const after = fullText.slice(b);
  return `${before}\n\n${String(replacement || "").trim()}\n\n${after}`;
}

function injectSpecIntoGameJs(gameTemplate, spec) {
  return String(gameTemplate || "").replace("__SPEC_JSON__", JSON.stringify(spec, null, 2));
}

function injectThemeVars(cssTemplate, theme) {
  const primary = String(theme?.primary || "#ff0050");
  const secondary = String(theme?.secondary || "#00f2ea");
  const background = String(theme?.background || "#050b17");
  return String(cssTemplate || "")
    .replaceAll("__THEME_PRIMARY__", primary)
    .replaceAll("__THEME_SECONDARY__", secondary)
    .replaceAll("__THEME_BACKGROUND__", background);
}

function renderHowToLi(spec) {
  const items = Array.isArray(spec?.howToPlay) ? spec.howToPlay : [];
  return items
    .slice(0, 10)
    .map((x) => `<li>${escapeHtml(String(x || ""))}</li>`)
    .join("\n");
}

function renderSettingsFieldsHtml(spec) {
  const round = Number(spec?.defaultSettings?.roundSeconds || 30);
  const goal = Number(spec?.defaultSettings?.winGoal || 15);
  const cmd = String(spec?.commands?.primary || "").trim();
  const usesCmd = Boolean(spec?.uses?.chatCommand);
  const usesShare = Boolean(spec?.uses?.shareTrigger);

  const fields = [];
  fields.push(`
<label class="field">
  <span class="field-label">Round seconds</span>
  <input data-setting="roundSeconds" type="number" min="5" max="300" value="${escapeHtml(round)}" />
</label>`);

  fields.push(`
<label class="field">
  <span class="field-label">Win goal</span>
  <input data-setting="winGoal" type="number" min="1" max="999" value="${escapeHtml(goal)}" />
</label>`);

  if (usesCmd) {
    fields.push(`
<label class="field">
  <span class="field-label">Chat command keyword</span>
  <input data-setting="chatCommand" type="text" maxlength="18" value="${escapeHtml(cmd || "guess")}" />
</label>`);
  }

  if (usesCmd) {
    fields.push(`
<label class="field check">
  <input data-setting="allowChat" type="checkbox" checked />
  <span class="field-label">Chat triggers action</span>
</label>`);
  }

  if (usesShare || usesCmd) {
    fields.push(`
<label class="field check">
  <input data-setting="allowShare" type="checkbox" ${usesShare ? "checked" : ""} />
  <span class="field-label">Shares trigger same action</span>
</label>`);
  }

  return fields.join("\n").trim();
}

function renderIndexHtml(indexTemplate, spec) {
  let html = String(indexTemplate || "");
  html = html.replaceAll("{{TITLE}}", escapeHtml(spec?.title || "ChatTok Live Game"));
  html = html.replaceAll("{{SUBTITLE}}", escapeHtml(spec?.subtitle || "Live Interactive"));
  html = html.replaceAll("{{ONE_SENTENCE}}", escapeHtml(spec?.oneSentence || ""));
  html = html.replaceAll("{{BUILD_SUMMARY}}", escapeHtml(spec?.buildSummary || ""));
  html = html.replaceAll("{{HOW_TO_PLAY_LI}}", renderHowToLi(spec));
  html = html.replaceAll("{{SETTINGS_FIELDS_HTML}}", renderSettingsFieldsHtml(spec));
  html = html.replaceAll("{{COMMAND_EXAMPLE}}", escapeHtml(spec?.commands?.primary || ""));
  return html;
}

// -----------------------------
// Validations
// -----------------------------

function validateGeneratedHtml(html) {
  const required = ["setupOverlay", "startGameBtn", "liveIdInput", "gameRoot", "flags"]; // runner contract
  for (const id of required) {
    if (!html.includes(`id=\"${id}\"`) && !html.includes(`id='${id}'`)) {
      throw httpError(500, `index.html missing required id: ${id}`);
    }
  }
}

function validateGeneratedCss(css) {
  if (!css.includes(":root")) throw httpError(500, "style.css missing :root");
  if (!css.includes("--pink") || !css.includes("--aqua")) throw httpError(500, "style.css missing theme vars");
}

function validateGeneratedJs(js) {
  if (!js.includes("new TikTokClient")) throw httpError(500, "game.js missing TikTokClient usage");
  if (!js.includes("// === AI_REGION_START ===") || !js.includes("// === AI_REGION_END ===")) {
    throw httpError(500, "game.js missing AI_REGION markers");
  }
}

// -----------------------------
// Routes
// -----------------------------

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "chattok-builder-api",
    time: new Date().toISOString(),
    endpoints: ["GET /health", "POST /api/plan", "POST /api/generate", "POST /api/edit"],
  });
});

app.post("/api/plan", async (req, res) => {
  try {
    const idea = pickIdea(req.body);
    assert(idea, "Missing idea text.");

    const apiKey = String(process.env.OPENAI_API_KEY || "").trim();
    assert(apiKey, "OPENAI_API_KEY is missing/blank in Render env.");

    const model = String(process.env.OPENAI_MODEL_SPEC || "gpt-4.1-mini").trim();
    const spec = await generateSpec({ apiKey, model, idea });
    return res.json({ ok: true, spec });
  } catch (err) {
    console.error("/api/plan error:", err);
    return res.status(err.status || 500).json({ ok: false, error: err?.message || String(err) });
  }
});

app.post("/api/generate", async (req, res) => {
  try {
    const stage = normalizeStage(req.body?.stage);
    const wantBundle = !stage || stage === "bundle";

    const theme = req.body?.theme || req.body?.colors || {};
    const ctx = req.body?.context && typeof req.body.context === "object" ? req.body.context : {};
    const ctxSpec = ctx.spec || null;

    // CSS is always template-based (no LLM)
    if (!wantBundle && stage === "css") {
      const css = injectThemeVars(TEMPLATES.css, theme);
      validateGeneratedCss(css);
      return res.json({ ok: true, stage, file: { name: "style.css", content: css }, context: { spec: ctxSpec } });
    }

    const apiKey = String(process.env.OPENAI_API_KEY || "").trim();
    assert(apiKey, "OPENAI_API_KEY is missing/blank in Render env.");

    const modelSpec = String(process.env.OPENAI_MODEL_SPEC || "gpt-4.1-mini").trim();
    const modelJs = String(process.env.OPENAI_MODEL_JS || "gpt-4.1-mini").trim();

    // Plan-only (for backward/forward builder versions)
    if (!wantBundle && stage === "plan") {
      const idea = pickIdea(req.body);
      assert(idea, "Missing idea text.");
      const spec = await generateSpec({ apiKey, model: modelSpec, idea });
      return res.json({ ok: true, stage, spec });
    }

    // HTML stage
    if (!wantBundle && stage === "html") {
      const idea = pickIdea(req.body);
      assert(idea, "Missing idea text.");
      const spec = await generateSpec({ apiKey, model: modelSpec, idea });
      const html = renderIndexHtml(TEMPLATES.index, spec);
      validateGeneratedHtml(html);
      return res.json({ ok: true, stage, file: { name: "index.html", content: html }, context: { spec } });
    }

    // JS stage
    if (!wantBundle && stage === "js") {
      const idea = pickIdea(req.body);
      const spec = ctxSpec || (await generateSpec({ apiKey, model: modelSpec, idea }));
      const aiCode = await generateAiRegion({ apiKey, model: modelJs, idea, spec });

      let js = injectSpecIntoGameJs(TEMPLATES.game, spec);
      js = replaceBetweenMarkers(js, "// === AI_REGION_START ===", "// === AI_REGION_END ===", aiCode);
      validateGeneratedJs(js);
      return res.json({ ok: true, stage, file: { name: "game.js", content: js }, context: { spec } });
    }

    // Bundle mode
    const idea = pickIdea(req.body);
    assert(idea, "Missing idea text.");

    const spec = ctxSpec || (await generateSpec({ apiKey, model: modelSpec, idea }));
    const html = renderIndexHtml(TEMPLATES.index, spec);
    const css = injectThemeVars(TEMPLATES.css, theme);
    const aiCode = await generateAiRegion({ apiKey, model: modelJs, idea, spec });

    let js = injectSpecIntoGameJs(TEMPLATES.game, spec);
    js = replaceBetweenMarkers(js, "// === AI_REGION_START ===", "// === AI_REGION_END ===", aiCode);

    validateGeneratedHtml(html);
    validateGeneratedCss(css);
    validateGeneratedJs(js);

    return res.json({
      ok: true,
      stage: "bundle",
      index_html: html,
      style_css: css,
      game_js: js,
      context: { spec },
    });
  } catch (err) {
    console.error("/api/generate error:", err);
    return res
      .status(err.status || 500)
      .json({ ok: false, error: err?.message || String(err), details: err.details || null });
  }
});

// Optional: edits (regenerate AI_REGION only)
app.post("/api/edit", async (req, res) => {
  try {
    const remaining = Number(req.body?.remainingEdits ?? 0);
    assert(remaining > 0, "No edits remaining.");

    const changeRequest = String(req.body?.changeRequest || "").trim();
    assert(changeRequest, "Missing changeRequest.");

    const currentFiles = req.body?.currentFiles && typeof req.body.currentFiles === "object" ? req.body.currentFiles : {};
    const currentJs = String(currentFiles["game.js"] || "");
    assert(currentJs, "Missing current game.js.");

    // Recover spec from embedded SPEC constant if present
    let spec = null;
    const m = currentJs.match(/const\s+SPEC\s*=\s*(\{[\s\S]*?\});/m);
    if (m && m[1]) {
      const parsed = parseJsonLoose(m[1]);
      if (parsed.ok) spec = parsed.value;
    }
    if (!spec)
      spec = {
        title: "ChatTok Live Game",
        uses: { chatCommand: true },
        commands: { primary: "hit" },
        defaultSettings: { roundSeconds: 30, winGoal: 15 },
      };

    const apiKey = String(process.env.OPENAI_API_KEY || "").trim();
    assert(apiKey, "OPENAI_API_KEY is missing/blank in Render env.");
    const modelJs = String(process.env.OPENAI_MODEL_JS || "gpt-4.1-mini").trim();

    const aiCode = await generateAiRegion({ apiKey, model: modelJs, idea: "", spec, changeRequest });
    const newJs = replaceBetweenMarkers(currentJs, "// === AI_REGION_START ===", "// === AI_REGION_END ===", aiCode);
    validateGeneratedJs(newJs);

    return res.json({
      ok: true,
      remainingEdits: remaining - 1,
      patches: [{ name: "game.js", content: newJs }],
      notes: "Updated AI_REGION in game.js.",
    });
  } catch (err) {
    console.error("/api/edit error:", err);
    return res.status(err.status || 500).json({ ok: false, error: err?.message || String(err) });
  }
});

// -----------------------------
// Start
// -----------------------------

app.listen(PORT, LISTEN_HOST, () => {
  console.log(`Builder API listening on http://${LISTEN_HOST}:${PORT}`);
  console.log(`Allowed origins: ${Array.from(ALLOWED_ORIGINS).join(", ") || "(none set)"}`);
});
