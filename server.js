import express from "express";
import cors from "cors";
import crypto from "crypto";
import OpenAI from "openai";

const app = express;

/* ===============================
   Config helpers
   =============================== */

function getTimeoutMs() {
  const v = Number(process.env.OPENAI_TIMEOUT_MS || 60000);
  return Number.isFinite(v) && v >= 5000 ? v : 60000;
}
function getTemperature() {
  const v = Number(process.env.OPENAI_TEMPERATURE || 0.35);
  if (!Number.isFinite(v)) return 0.35;
  return Math.max(0, Math.min(1.2, v));
}
function safeStr(x, max = 200000) {
  const s = String(x ?? "").trim();
  return s.length > max ? s.slice(0, max) : s;
}
function assert(cond, msg, status = 400) {
  if (!cond) {
    const err = new Error(msg);
    err.status = status;
    throw err;
  }
}
function normalizeTheme(theme = {}) {
  const pick = (k, fallback) => {
    const v = String(theme?.[k] ?? fallback).trim();
    return /^#[0-9a-fA-F]{6}$/.test(v) ? v : fallback;
  };
  return {
    primary: pick("primary", "#ff0050"),
    secondary: pick("secondary", "#00f2ea"),
    bg: pick("bg", "#050b17"),
    surface: pick("surface", "#0b1632"),
    text: pick("text", "#ffffff"),
  };
}

/* ===============================
   Middleware
   =============================== */

// allow screenshots (base64) + larger specs
app.use(express.json({ limit: "10mb" }));

const allowedOrigins = new Set([
  "https://ogdeig.github.io",
  "http://localhost:5500",
  "http://127.0.0.1:5500",
  "https://chattokapps.com",
  "https://www.chattokapps.com",
]);

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (allowedOrigins.has(origin)) return cb(null, true);
      return cb(new Error("CORS blocked for origin: " + origin));
    },
  })
);

function noStore(_req, res, next) {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.setHeader("Surrogate-Control", "no-store");
  next();
}

/* ===============================
   Route listing helper
   =============================== */

function listRoutes(appInstance) {
  const out = [];
  const walkStack = (stack) => {
    for (const layer of stack) {
      if (layer.route?.path) {
        const methods = Object.keys(layer.route.methods || {})
          .filter(Boolean)
          .map((m) => m.toUpperCase());
        out.push({ path: layer.route.path, methods });
        continue;
      }
      if (layer.name === "router" && layer.handle?.stack) {
        walkStack(layer.handle.stack);
      }
    }
  };
  if (appInstance?._router?.stack) walkStack(appInstance._router.stack);

  const seen = new Set();
  return out.filter((r) => {
    const key = `${r.methods.join(",")} ${r.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/* ===============================
   OpenAI helpers
   =============================== */

function getOpenAIClient() {
  const apiKey = String(process.env.OPENAI_API_KEY || "").trim();
  if (!apiKey) return null;
  return new OpenAI({ apiKey });
}

function extractFirstJsonObject(text) {
  const s = String(text || "").trim();
  if (!s) return null;

  try { return JSON.parse(s); } catch {}

  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start >= 0 && end > start) {
    const sub = s.slice(start, end + 1);
    try { return JSON.parse(sub); } catch {}
  }

  return null;
}

async function openaiJson({ model, system, user, timeoutMs, temperature }) {
  const client = getOpenAIClient();
  if (!client) return { ok: false, error: "OPENAI_API_KEY missing" };

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const resp = await client.chat.completions.create(
      {
        model,
        temperature,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      },
      { signal: controller.signal }
    );

    const text = resp?.choices?.[0]?.message?.content || "";
    const json = extractFirstJsonObject(text);
    if (!json) return { ok: false, error: "Model did not return valid JSON", raw: text };
    return { ok: true, json, raw: text };
  } catch (e) {
    const msg = e?.name === "AbortError" ? "OpenAI timeout" : (e?.message || String(e));
    return { ok: false, error: msg };
  } finally {
    clearTimeout(t);
  }
}

/* ===============================
   Fallback spec
   =============================== */

function fallbackSpecFromIdea(prompt, theme) {
  return {
    title: "New TikTok Live Game",
    subtitle: "Built with ChatTokApps",
    oneLiner: "A TikTok LIVE interactive game.",
    theme,
    ui: {
      orientation: "9:16",
      screens: ["settings", "game"],
      notes: "Settings screen connects and gates Start; Game screen replaces settings."
    },
    settings: [
      { id: "offlineToggle", type: "checkbox", label: "Offline/Test Mode", default: false },
      { id: "sfxToggle", type: "checkbox", label: "Sound FX", default: true },
      { id: "volume", type: "range", label: "Volume", min: 0, max: 100, default: 60 }
    ],
    chat: {
      mapping: [
        { event: "chat", rule: "data.content triggers gameplay actions based on prompt" },
        { event: "gift", rule: "data.gift.* scales stronger effects" }
      ]
    },
    host: {
      controls: ["Start", "Pause", "Reset/Quit", "Keyboard/mouse inputs depending on game"]
    },
    scoring: { enabled: true, notes: "Score impacts leaderboard display." },
    rounds: { enabled: true, notes: "Round timer or win condition ends round." },
    sfx: { enabled: true, cues: ["join", "action", "hit", "win"] },
    promptSummary: safeStr(prompt, 300),
  };
}

/* ===============================
   Enforce TikTok dependency script order in HTML
   =============================== */

const REQUIRED_SCRIPT_BLOCK = `
  <!-- REQUIRED DEP ORDER (fixes proto is not defined / TikTokClient not available) -->
  <script src="https://cdn.jsdelivr.net/npm/google-protobuf@3.21.2/google-protobuf.js"></script>
  <script src="generic.js"></script>
  <script src="unknownobjects.js"></script>
  <script src="data_linkmic_messages.js"></script>
  <script src="tiktok-client.js"></script>

  <!-- Your game -->
  <script src="game.js"></script>
`.trim();

function ensureTikTokScriptOrder(html) {
  let out = String(html || "");

  // remove any existing references to these scripts (to avoid duplicates / wrong order)
  out = out.replace(/<script[^>]+src=["'][^"']*(google-protobuf|google-protobuf\.js)[^"']*["'][^>]*>\s*<\/script>\s*/gi, "");
  out = out.replace(/<script[^>]+src=["']generic\.js["'][^>]*>\s*<\/script>\s*/gi, "");
  out = out.replace(/<script[^>]+src=["']unknownobjects\.js["'][^>]*>\s*<\/script>\s*/gi, "");
  out = out.replace(/<script[^>]+src=["']data_linkmic_messages\.js["'][^>]*>\s*<\/script>\s*/gi, "");
  out = out.replace(/<script[^>]+src=["']tiktok-client\.js["'][^>]*>\s*<\/script>\s*/gi, "");
  out = out.replace(/<script[^>]+src=["']game\.js["'][^>]*>\s*<\/script>\s*/gi, "");

  // insert required block before </body> if possible, else append
  if (out.includes("</body>")) {
    out = out.replace("</body>", `\n${REQUIRED_SCRIPT_BLOCK}\n</body>`);
  } else {
    out += `\n${REQUIRED_SCRIPT_BLOCK}\n`;
  }

  return out;
}

function ensureCssAndTitle(html) {
  let out = String(html || "");
  if (!/href=["']style\.css["']/.test(out)) {
    out = out.replace(/<\/head>/i, `  <link rel="stylesheet" href="style.css" />\n</head>`);
  }
  if (!/<title>/.test(out)) {
    out = out.replace(/<\/head>/i, `  <title>ChatTok Game</title>\n</head>`);
  }
  return out;
}

/* ===============================
   System rules
   =============================== */

function buildSystemRules(builderRules = "") {
  return `
You are a senior HTML/CSS/JS game developer.
Return ONLY valid JSON. No markdown. No backticks.

Non-negotiable:
- 9:16 portrait
- Two screens: Settings (connect + gated Start) and Game screen
- Use TikTokClient from tiktok-client.js (SignalR-compatible). Do NOT replace it.
- Wrap handlers in try/catch. Never crash on missing fields.
- Chat text at data.content, username at data.user.displayid or data.user.nickname, pfp at data.user.avatarthumb.urllistList[0]
- Gifts at data.gift.name/id/diamondcount and data.combocount/repeatcount

Critical dependency order in index.html (must be present exactly before game.js):
<script src="https://cdn.jsdelivr.net/npm/google-protobuf@3.21.2/google-protobuf.js"></script>
<script src="generic.js"></script>
<script src="unknownobjects.js"></script>
<script src="data_linkmic_messages.js"></script>
<script src="tiktok-client.js"></script>
<script src="game.js"></script>

${builderRules ? "BUILDER RULES:\n" + builderRules : ""}
`.trim();
}

/* ===============================
   AI generators
   =============================== */

async function generateSpecWithAI({ prompt, theme, builderRules }) {
  const model = String(process.env.OPENAI_MODEL_SPEC || "gpt-4o-mini").trim();
  const timeoutMs = getTimeoutMs();
  const temperature = getTemperature();

  const system = buildSystemRules(builderRules);

  const user = `
Create a detailed game SPEC as JSON.

Output keys:
title, subtitle, oneLiner, theme, howToPlay, settings, chat, host, scoring, rounds, sfx, ui

Requirements:
- Must describe Settings screen + Game screen layout
- Must include "Start is gated until connected" and optional Offline/Test mode

Inputs:
theme: ${JSON.stringify(theme)}
prompt: ${JSON.stringify(prompt)}
`.trim();

  return await openaiJson({ model, system, user, timeoutMs, temperature });
}

async function generateSingleFileWithAI({ target, prompt, theme, spec, contextFiles, builderRules }) {
  const model = String(process.env.OPENAI_MODEL_BUILD || "gpt-4o-mini").trim();
  const timeoutMs = getTimeoutMs();
  const temperature = getTemperature();

  const system = buildSystemRules(builderRules);

  const ctxHtml = safeStr(contextFiles?.["index.html"] || "", 180000);
  const ctxCss = safeStr(contextFiles?.["style.css"] || "", 180000);

  let user = "";

  if (target === "index.html") {
    user = `
Generate ONLY index.html as JSON with exactly one key: "index.html".

Hard requirements:
- Reference <link rel="stylesheet" href="style.css">
- Include Settings screen and Game screen containers with clear IDs used by game.js
- Settings screen: Live ID input, Connect button, Offline/Test toggle (optional), settings controls, Start button (disabled until connected or offline mode)
- Game screen: 9:16 stage with canvas or main play area + transparent directions overlay
- MUST include required script tags in the exact dependency order before game.js.

theme: ${JSON.stringify(theme)}
spec: ${JSON.stringify(spec)}
prompt: ${JSON.stringify(prompt)}
`.trim();
  } else if (target === "style.css") {
    user = `
Generate ONLY style.css as JSON with exactly one key: "style.css".

Hard requirements:
- No Tailwind CDN, no external libs
- Style must look professional and modern for TikTok LIVE (mobile-first)
- Must support 9:16 portrait stage
- Must style Settings screen and Game screen per HTML structure below
- Use theme colors (primary/secondary/bg/surface/text)

index.html (structure you must match):
${JSON.stringify(ctxHtml)}

theme: ${JSON.stringify(theme)}
spec: ${JSON.stringify(spec)}
prompt: ${JSON.stringify(prompt)}
`.trim();
  } else if (target === "game.js") {
    user = `
Generate ONLY game.js as JSON with exactly one key: "game.js".

Hard requirements:
- Create TikTokClient ONLY after clicking Connect
- Close any previous socket if exists
- If CHATTOK_CREATOR_TOKEN exists, call client.setAccessToken(CHATTOK_CREATOR_TOKEN)
- Wire events: chat, gift, like, join, social, roomUserSeq, control
- Handlers must read MessagesClean fields (chat text at data.content etc) with try/catch guards
- Start must be gated: Start button enabled only when connected OR offline mode enabled
- Switch Settings screen -> Game screen on Start
- Provide gameplay skeleton based on spec and prompt (canvas loop, input handlers, SFX beeps)
- Must not crash if TikTok fields missing

index.html (IDs/structure you must match):
${JSON.stringify(ctxHtml)}

style.css (for visual intent, optional reference):
${JSON.stringify(ctxCss)}

theme: ${JSON.stringify(theme)}
spec: ${JSON.stringify(spec)}
prompt: ${JSON.stringify(prompt)}
`.trim();
  } else {
    return { ok: false, error: "Unsupported target" };
  }

  return await openaiJson({ model, system, user, timeoutMs, temperature });
}

/* ===============================
   Routes
   =============================== */

app.get("/api/ping", noStore, (_req, res) => {
  res.json({ ok: true, name: "chattok-builder-api", time: new Date().toISOString() });
});

app.get("/api/routes", noStore, (_req, res) => {
  res.json({ ok: true, routes: listRoutes(app) });
});

/* ===============================
   /api/plan  (Spec)
   =============================== */

app.post("/api/plan", noStore, async (req, res) => {
  const requestId = safeStr(req.body?.requestId || crypto.randomUUID(), 120);
  try {
    const prompt = safeStr(req.body?.prompt || "", 40000);
    assert(prompt, "Missing prompt");

    const theme = normalizeTheme(req.body?.theme || {});
    const builderRules = safeStr(req.body?.builderRules || "", 80000);

    const client = getOpenAIClient();
    let spec = null;
    let usedFallback = false;

    if (client) {
      const r = await generateSpecWithAI({ prompt, theme, builderRules });
      if (r.ok) spec = r.json;
      else {
        usedFallback = true;
        spec = fallbackSpecFromIdea(prompt, theme);
      }
    } else {
      usedFallback = true;
      spec = fallbackSpecFromIdea(prompt, theme);
    }

    res.json({
      ok: true,
      requestId,
      echoPrompt: prompt,
      spec,
      usedFallback,
    });
  } catch (err) {
    res.status(err.status || 500).json({
      ok: false,
      requestId,
      error: err.message || "Plan failed",
    });
  }
});

/* ===============================
   /api/build  (one file at a time via target)
   =============================== */

app.post("/api/build", noStore, async (req, res) => {
  const requestId = safeStr(req.body?.requestId || crypto.randomUUID(), 120);
  try {
    const prompt = safeStr(req.body?.prompt || "", 40000);
    assert(prompt, "Missing prompt");

    const theme = normalizeTheme(req.body?.theme || {});
    const builderRules = safeStr(req.body?.builderRules || "", 80000);

    const target = safeStr(req.body?.target || "", 50);
    assert(target, "Missing target (index.html | style.css | game.js)");
    assert(["index.html", "style.css", "game.js"].includes(target), "Invalid target");

    const contextFiles = req.body?.contextFiles && typeof req.body.contextFiles === "object" ? req.body.contextFiles : {};

    // Spec must be provided (cheap). If not, fallback or build it.
    let spec = req.body?.spec && typeof req.body.spec === "object" ? req.body.spec : null;
    if (!spec) spec = fallbackSpecFromIdea(prompt, theme);

    const client = getOpenAIClient();
    if (!client) {
      // No OpenAI: return minimal, but still valid
      if (target === "index.html") {
        let html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <title>${safeStr(spec.title || "ChatTok Game", 120)}</title>
  <link rel="stylesheet" href="style.css" />
</head>
<body>
  <div class="app">
    <section id="settingsScreen" class="screen">
      <h1>${safeStr(spec.title || "ChatTok Game", 120)}</h1>
      <label>TikTok Live ID <input id="liveIdInput" /></label>
      <button id="btnConnect">Connect</button>
      <label><input id="offlineToggle" type="checkbox" /> Offline/Test</label>
      <button id="btnStart" disabled>Start</button>
    </section>

    <section id="gameScreen" class="screen hidden">
      <canvas id="gameCanvas" width="720" height="1280"></canvas>
      <button id="btnQuit">Quit</button>
    </section>
  </div>
${REQUIRED_SCRIPT_BLOCK}
</body>
</html>`;
        html = ensureCssAndTitle(ensureTikTokScriptOrder(html));
        return res.json({ ok: true, requestId, echoPrompt: prompt, fileName: "index.html", content: html });
      }
      if (target === "style.css") {
        const css = `:root{--p:${theme.primary};--s:${theme.secondary};--bg:${theme.bg};--text:${theme.text};}
body{margin:0;background:var(--bg);color:var(--text);font-family:system-ui,Segoe UI,Roboto,Arial,sans-serif;}
.hidden{display:none !important;}
canvas{width:100%;height:auto;display:block;}`;
        return res.json({ ok: true, requestId, echoPrompt: prompt, fileName: "style.css", content: css });
      }
      if (target === "game.js") {
        const js = `// OpenAI unavailable - minimal skeleton\nconsole.log("game.js loaded");`;
        return res.json({ ok: true, requestId, echoPrompt: prompt, fileName: "game.js", content: js });
      }
    }

    const r = await generateSingleFileWithAI({ target, prompt, theme, spec, contextFiles, builderRules });
    if (!r.ok) {
      return res.status(500).json({
        ok: false,
        requestId,
        echoPrompt: prompt,
        error: r.error || "Build failed",
        raw: r.raw || null,
      });
    }

    let content = r.json?.[target];
    if (typeof content !== "string") {
      return res.status(500).json({
        ok: false,
        requestId,
        echoPrompt: prompt,
        error: "AI returned JSON but missing target key",
        raw: r.raw || null,
      });
    }

    if (target === "index.html") {
      content = ensureCssAndTitle(ensureTikTokScriptOrder(content));
    }

    return res.json({
      ok: true,
      requestId,
      echoPrompt: prompt,
      spec,
      fileName: target,
      content,
    });
  } catch (err) {
    res.status(err.status || 500).json({
      ok: false,
      requestId,
      error: err.message || "Build failed",
    });
  }
});

/* ===============================
   /api/edit  (edits all 3 files)
   =============================== */

app.post("/api/edit", noStore, async (req, res) => {
  const requestId = safeStr(req.body?.requestId || crypto.randomUUID(), 120);
  try {
    const editPrompt = safeStr(req.body?.editPrompt || "", 30000);
    assert(editPrompt, "Missing editPrompt");

    const theme = normalizeTheme(req.body?.theme || {});
    const builderRules = safeStr(req.body?.builderRules || "", 80000);

    const files = req.body?.files;
    assert(files && typeof files === "object", "Missing files");
    assert(typeof files["index.html"] === "string", "Missing index.html");
    assert(typeof files["style.css"] === "string", "Missing style.css");
    assert(typeof files["game.js"] === "string", "Missing game.js");

    const screenshotDataUrl = safeStr(req.body?.screenshotDataUrl || "", 4000000);

    const client = getOpenAIClient();
    if (!client) {
      // No OpenAI: return original with enforcement
      const html = ensureCssAndTitle(ensureTikTokScriptOrder(files["index.html"]));
      return res.json({
        ok: true,
        requestId,
        echoPrompt: editPrompt,
        files: { "index.html": html, "style.css": files["style.css"], "game.js": files["game.js"] },
      });
    }

    const model = String(process.env.OPENAI_MODEL_BUILD || "gpt-4o-mini").trim();
    const timeoutMs = getTimeoutMs();
    const temperature = getTemperature();

    const system = buildSystemRules(builderRules);
    const user = `
You will receive existing files for a TikTok Live game.
Apply the edit request and return ONLY JSON with exactly:
- "index.html"
- "style.css"
- "game.js"

Edit request:
${JSON.stringify(editPrompt)}

Theme:
${JSON.stringify(theme)}

Optional screenshot (data URL, may be empty):
${JSON.stringify(screenshotDataUrl ? screenshotDataUrl.slice(0, 2000) + "..." : "")}

Existing files:
index.html: ${JSON.stringify(files["index.html"])}
style.css: ${JSON.stringify(files["style.css"])}
game.js: ${JSON.stringify(files["game.js"])}

Rules:
- Keep TikTok connection pattern intact
- Keep settings/connect/start flow intact
- Start must be gated until connected (unless offline/test mode enabled)
- Keep 9:16 responsive
- Maintain the required script dependency order in index.html
`.trim();

    const r = await openaiJson({ model, system, user, timeoutMs, temperature });
    if (!r.ok) {
      return res.status(500).json({
        ok: false,
        requestId,
        echoPrompt: editPrompt,
        error: r.error || "Edit failed",
        raw: r.raw || null,
      });
    }

    const out = r.json;
    if (typeof out?.["index.html"] !== "string" || typeof out?.["style.css"] !== "string" || typeof out?.["game.js"] !== "string") {
      return res.status(500).json({
        ok: false,
        requestId,
        echoPrompt: editPrompt,
        error: "AI edit returned JSON but missing required file keys",
        raw: r.raw || null,
      });
    }

    out["index.html"] = ensureCssAndTitle(ensureTikTokScriptOrder(out["index.html"]));

    return res.json({
      ok: true,
      requestId,
      echoPrompt: editPrompt,
      files: out,
    });
  } catch (err) {
    res.status(err.status || 500).json({
      ok: false,
      requestId,
      error: err.message || "Edit failed",
    });
  }
});

/* ===============================
   Start
   =============================== */

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`chattok-builder-api listening on :${PORT}`);
  console.log("Routes:", JSON.stringify(listRoutes(app), null, 2));
});
