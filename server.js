import express from "express";
import cors from "cors";
import crypto from "crypto";
import OpenAI from "openai";

const app = express();

/* ===============================
   Config helpers
   =============================== */

function getTimeoutMs() {
  const v = Number(process.env.OPENAI_TIMEOUT_MS || 60000);
  return Number.isFinite(v) && v >= 5000 ? v : 60000;
}
function getTemperature() {
  const v = Number(process.env.OPENAI_TEMPERATURE || 0.4);
  if (!Number.isFinite(v)) return 0.4;
  return Math.max(0, Math.min(1.2, v));
}
function safeStr(x, max = 20000) {
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

app.use(express.json({ limit: "2mb" }));

// CORS: allow GitHub Pages + your future domains.
// Add/remove as needed.
const allowedOrigins = new Set([
  "https://ogdeig.github.io",
  "http://localhost:5500",
  "http://127.0.0.1:5500",
  "https://chattokapps.com",
  "https://www.chattokapps.com"
]);

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true); // allow non-browser requests
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

  const walkStack = (stack, prefix = "") => {
    for (const layer of stack) {
      // direct route
      if (layer.route?.path) {
        const methods = Object.keys(layer.route.methods || {})
          .filter(Boolean)
          .map((m) => m.toUpperCase());
        out.push({ path: prefix + layer.route.path, methods });
        continue;
      }

      // router mounted with app.use("/prefix", router)
      if (layer.name === "router" && layer.handle?.stack) {
        // Express stores mount path in regexp; best-effort:
        // if layer.regexp exists, we keep prefix as-is; you still see internal route paths.
        walkStack(layer.handle.stack, prefix);
      }
    }
  };

  if (appInstance?._router?.stack) walkStack(appInstance._router.stack, "");
  // de-dupe
  const seen = new Set();
  return out.filter((r) => {
    const key = `${r.methods.join(",")} ${r.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/* ===============================
   OpenAI helpers (cheap + robust)
   =============================== */

function getOpenAIClient() {
  const apiKey = String(process.env.OPENAI_API_KEY || "").trim();
  if (!apiKey) return null;
  return new OpenAI({ apiKey });
}

function extractFirstJsonObject(text) {
  const s = String(text || "").trim();
  if (!s) return null;

  // Try direct parse
  try { return JSON.parse(s); } catch {}

  // Try to find first {...} block
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
    // Use chat.completions for broad compatibility
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
   Builders (spec + files + edit)
   =============================== */

function fallbackSpecFromIdea(prompt, templateId, theme) {
  return {
    title: "New TikTok Live Game",
    templateId,
    summary: prompt.slice(0, 240),
    ui: {
      orientation: "9:16",
      theme,
      screens: ["settings", "game"]
    },
    settings: [
      { id: "roundSeconds", type: "number", label: "Round Length (seconds)", min: 15, max: 300, default: 60 },
      { id: "difficulty", type: "select", label: "Difficulty", options: ["Easy", "Normal", "Hard"], default: "Normal" }
    ],
    chat: {
      joinCommand: "!join",
      commands: [
        { command: "!join", effect: "Join the session" },
        { command: "!spawn", effect: "Trigger a game action (varies by game)" }
      ]
    },
    scoring: {
      enabled: true,
      description: "Points awarded for participation and correct actions."
    },
    sfx: {
      enabled: true,
      cues: ["join", "action", "win", "lose"]
    }
  };
}

function validateFiles(files) {
  return (
    files &&
    typeof files === "object" &&
    typeof files["index.html"] === "string" &&
    typeof files["style.css"] === "string" &&
    typeof files["game.js"] === "string"
  );
}

function buildSystemRules(builderRules = "") {
  // Your mandatory TikTok connection example will be sent from the builder as builderRules.
  // We enforce JSON-only output at the system level too.
  return `
You are a senior HTML/CSS/JS game developer.
Return ONLY valid JSON. No markdown. No backticks.

${builderRules ? "BUILDER RULES:\n" + builderRules : ""}
`.trim();
}

async function generateSpecWithAI({ prompt, templateId, theme, builderRules }) {
  const model = String(process.env.OPENAI_MODEL_SPEC || "gpt-4o-mini").trim();
  const timeoutMs = getTimeoutMs();
  const temperature = getTemperature();

  const system = buildSystemRules(builderRules);
  const user = `
Create a detailed game SPEC as JSON.

Constraints:
- Must be a TikTok LIVE interactive game
- Must be 9:16 portrait
- Must include: title, one-liner, howToPlay for host and chat, settings list, chat commands mapping, scoring, rounds, sound cues, UI layout notes.
- Must reference theme colors passed in.
- Output JSON object keys: title, subtitle, oneLiner, templateId, theme, howToPlay, settings, chat, host, scoring, rounds, sfx, ui

Inputs:
templateId: ${templateId}
theme: ${JSON.stringify(theme)}
prompt: ${JSON.stringify(prompt)}
`.trim();

  const r = await openaiJson({ model, system, user, timeoutMs, temperature });
  if (!r.ok) return { ok: false, error: r.error, raw: r.raw };

  // Light normalize
  const spec = r.json;
  spec.templateId = spec.templateId || templateId;
  spec.theme = theme;

  return { ok: true, spec };
}

async function generateFilesWithAI({ prompt, templateId, theme, spec, builderRules }) {
  const model = String(process.env.OPENAI_MODEL_BUILD || "gpt-4o-mini").trim();
  const timeoutMs = getTimeoutMs();
  const temperature = getTemperature();

  const system = buildSystemRules(builderRules);
  const user = `
Generate a COMPLETE professional game as JSON with exactly 3 keys:
- "index.html"
- "style.css"
- "game.js"

Rules:
- No markdown, only JSON.
- index.html must reference style.css and game.js.
- The game must implement: settings screen → connect TikTok Live ID → start → game screen.
- Must be 9:16 responsive and polished.
- Must use the TikTokClient connect pattern provided in the builder rules.
- Must NOT include external CDN Tailwind. Use hand-written CSS.
- Must include SFX hooks with WebAudio or <audio> (no copyrighted assets; use simple synth/beeps if needed).
- Must include clear on-screen directions overlay with transparent background.
- Must cache profile pics in JS map when used.

Inputs:
templateId: ${templateId}
theme: ${JSON.stringify(theme)}
spec: ${JSON.stringify(spec)}
prompt: ${JSON.stringify(prompt)}
`.trim();

  const r = await openaiJson({ model, system, user, timeoutMs, temperature });
  if (!r.ok) return { ok: false, error: r.error, raw: r.raw };

  const files = r.json;
  if (!validateFiles(files)) {
    return { ok: false, error: "AI returned JSON but missing required files keys", raw: r.raw };
  }
  return { ok: true, files };
}

async function editFilesWithAI({ editPrompt, theme, files, builderRules }) {
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

Existing files:
index.html: ${JSON.stringify(files["index.html"])}
style.css: ${JSON.stringify(files["style.css"])}
game.js: ${JSON.stringify(files["game.js"])}

Rules:
- Keep TikTok connection pattern intact.
- Keep settings/connect/start flow intact.
- Keep 9:16 responsive.
- Fix issues cleanly; no placeholders.
`.trim();

  const r = await openaiJson({ model, system, user, timeoutMs, temperature });
  if (!r.ok) return { ok: false, error: r.error, raw: r.raw };

  const outFiles = r.json;
  if (!validateFiles(outFiles)) {
    return { ok: false, error: "AI edit returned JSON but missing required file keys", raw: r.raw };
  }
  return { ok: true, files: outFiles };
}

/* ===============================
   Routes
   =============================== */

app.get("/api/ping", noStore, (_req, res) => {
  res.json({
    ok: true,
    name: "chattok-builder-api",
    time: new Date().toISOString(),
  });
});

app.get("/api/models", noStore, (_req, res) => {
  res.json({
    ok: true,
    models: {
      spec: process.env.OPENAI_MODEL_SPEC || "gpt-4o-mini",
      build: process.env.OPENAI_MODEL_BUILD || "gpt-4o-mini",
    },
    timeoutMs: getTimeoutMs(),
    temperature: getTemperature(),
  });
});

app.get("/api/routes", noStore, (_req, res) => {
  res.json({ ok: true, routes: listRoutes(app) });
});

// PLAN (alias SPEC)
async function planHandler(req, res) {
  const requestId = crypto.randomUUID();
  try {
    const prompt = safeStr(req.body?.prompt || req.body?.idea || req.body?.text || "");
    assert(prompt, "Missing prompt");

    const templateId = safeStr(req.body?.templateId || req.body?.template || "arena", 50).toLowerCase();
    const theme = normalizeTheme(req.body?.theme || req.body?.colors || {});
    const builderRules = safeStr(req.body?.builderRules || "", 30000);

    let spec;
    let usedFallback = false;

    const client = getOpenAIClient();
    if (client) {
      const r = await generateSpecWithAI({ prompt, templateId, theme, builderRules });
      if (r.ok) spec = r.spec;
      else {
        usedFallback = true;
        spec = fallbackSpecFromIdea(prompt, templateId, theme);
      }
    } else {
      usedFallback = true;
      spec = fallbackSpecFromIdea(prompt, templateId, theme);
    }

    return res.json({
      ok: true,
      requestId,
      echoPrompt: prompt,
      spec,
      usedFallback,
      planText: usedFallback
        ? "Fallback plan used (OpenAI unavailable or failed)."
        : "Plan generated successfully.",
      context: { templateId, theme },
    });
  } catch (err) {
    const status = err.status || 500;
    return res.status(status).json({
      ok: false,
      requestId,
      error: err.message || "Plan failed",
    });
  }
}

app.post("/api/plan", noStore, planHandler);
app.post("/api/spec", noStore, planHandler); // alias for your builder defaults

// BUILD
app.post("/api/build", noStore, async (req, res) => {
  const requestId = crypto.randomUUID();
  try {
    const prompt = safeStr(req.body?.prompt || req.body?.idea || req.body?.text || "");
    assert(prompt, "Missing prompt");

    const templateId = safeStr(req.body?.templateId || req.body?.template || "arena", 50).toLowerCase();
    const theme = normalizeTheme(req.body?.theme || req.body?.colors || {});
    const builderRules = safeStr(req.body?.builderRules || "", 30000);

    const incomingSpec = req.body?.spec && typeof req.body.spec === "object" ? req.body.spec : null;

    // Ensure we have a spec (AI or fallback)
    let spec = incomingSpec;
    if (!spec) {
      const r = await generateSpecWithAI({ prompt, templateId, theme, builderRules });
      spec = r.ok ? r.spec : fallbackSpecFromIdea(prompt, templateId, theme);
    }

    const out = await generateFilesWithAI({ prompt, templateId, theme, spec, builderRules });
    if (!out.ok) {
      return res.status(500).json({
        ok: false,
        requestId,
        echoPrompt: prompt,
        error: out.error || "Build failed",
        raw: out.raw || null,
      });
    }

    return res.json({
      ok: true,
      requestId,
      echoPrompt: prompt,
      spec,
      files: out.files,
    });
  } catch (err) {
    const status = err.status || 500;
    return res.status(status).json({
      ok: false,
      requestId,
      error: err.message || "Build failed",
    });
  }
});

// EDIT
app.post("/api/edit", noStore, async (req, res) => {
  const requestId = crypto.randomUUID();
  try {
    const editPrompt = safeStr(req.body?.editPrompt || req.body?.prompt || "");
    assert(editPrompt, "Missing editPrompt");

    const theme = normalizeTheme(req.body?.theme || req.body?.colors || {});
    const builderRules = safeStr(req.body?.builderRules || "", 30000);

    const files = req.body?.files;
    assert(files && typeof files === "object", "Missing files");
    assert(typeof files["index.html"] === "string", "Missing index.html");
    assert(typeof files["style.css"] === "string", "Missing style.css");
    assert(typeof files["game.js"] === "string", "Missing game.js");

    const out = await editFilesWithAI({ editPrompt, theme, files, builderRules });
    if (!out.ok) {
      return res.status(500).json({
        ok: false,
        requestId,
        echoPrompt: editPrompt,
        error: out.error || "Edit failed",
        raw: out.raw || null,
      });
    }

    return res.json({
      ok: true,
      requestId,
      echoPrompt: editPrompt,
      files: out.files,
    });
  } catch (err) {
    const status = err.status || 500;
    return res.status(status).json({
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
