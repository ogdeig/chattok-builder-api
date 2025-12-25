/**
 * ChatTok Gaming — AI Game Builder API (Render)
 * Goals:
 * - Stable builder/API contract (no regressions)
 * - Deterministic, high-quality template-first generation (HTML/CSS/JS)
 * - OpenAI used only for plan/spec + optional lightweight edits (cost/timeout safe)
 * - Robust in iframe/about:srcdoc environments (no fragile relative proto loads)
 *
 * NON-NEGOTIABLES:
 * - DO NOT ship secrets to GitHub Pages
 * - DO NOT modify tiktok-client.js (platform injected / read-only)
 * - Must tolerate missing optional fields and never crash
 */

"use strict";

require("dotenv").config();

const fs = require("fs");
const path = require("path");
const express = require("express");
const cors = require("cors");

const app = express();

// -------------------------------
// Config
// -------------------------------
const HOST = process.env.HOST || "0.0.0.0";
const PORT = Number(process.env.PORT || 3000);

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL_SPEC = (process.env.OPENAI_MODEL_SPEC || "gpt-4o-mini").trim();
const OPENAI_MODEL_EDIT = (process.env.OPENAI_MODEL_EDIT || process.env.OPENAI_MODEL_AI || "gpt-4o-mini").trim();

const PLAN_TIMEOUT_MS = Number(process.env.PLAN_TIMEOUT_MS || 18000);
const EDIT_TIMEOUT_MS = Number(process.env.EDIT_TIMEOUT_MS || 22000);

const MAX_PROMPT_CHARS = Number(process.env.MAX_PROMPT_CHARS || 2500);
const JSON_LIMIT_BYTES = "1mb";

// Allowlist origins (GitHub Pages + local dev + optional ChatTok)
const ORIGIN_ALLOWLIST = new Set(
  (process.env.CORS_ALLOWLIST ||
    [
      "https://ogdeig.github.io",
      "http://localhost:5500",
      "http://localhost:5173",
      "http://localhost:3000",
      "http://127.0.0.1:5500",
      "http://127.0.0.1:5173",
      "http://127.0.0.1:3000",
      "https://chattokgaming.com",
    ].join(","))
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
);

// -------------------------------
// Middleware
// -------------------------------
app.set("trust proxy", 1);
app.disable("x-powered-by");

app.use(express.json({ limit: JSON_LIMIT_BYTES }));

app.use(
  cors({
    origin(origin, cb) {
      // Same-origin / curl / server-side
      if (!origin) return cb(null, true);
      if (ORIGIN_ALLOWLIST.has(origin)) return cb(null, true);

      // Allow any localhost port
      if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin)) return cb(null, true);

      return cb(new Error("CORS blocked for origin: " + origin), false);
    },
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: false,
    maxAge: 86400,
  })
);

// Preflight support (Render + GH Pages)
app.options("*", (_req, res) => res.sendStatus(204));

// No caching on generation endpoints
app.use((req, res, next) => {
  if (req.path.startsWith("/api/")) {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    res.setHeader("Surrogate-Control", "no-store");
  }
  next();
});

app.get("/favicon.ico", (_req, res) => res.status(204).end());

// -------------------------------
// Template loading
// -------------------------------
const TEMPLATE_DIR = process.env.TEMPLATE_DIR || process.cwd();

function readFileSafe(p) {
  return fs.readFileSync(p, "utf8");
}

let TEMPLATES = loadTemplates();

function loadTemplates() {
  const indexPath = path.join(TEMPLATE_DIR, "index.template.html");
  const cssPath = path.join(TEMPLATE_DIR, "style.template.css");
  const jsPath = path.join(TEMPLATE_DIR, "game.template.js");

  const indexHtml = readFileSafe(indexPath);
  const styleCss = readFileSafe(cssPath);
  const gameJs = readFileSafe(jsPath);

  return { indexHtml, styleCss, gameJs, loadedAt: Date.now() };
}

app.post("/api/reload-templates", (_req, res) => {
  try {
    TEMPLATES = loadTemplates();
    return res.json({ ok: true, loadedAt: TEMPLATES.loadedAt });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e && e.message ? e.message : e) });
  }
});

// -------------------------------
// Helpers
// -------------------------------
function okJson(res, payload) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.status(200).send(JSON.stringify(payload));
}

function badRequest(res, message, extra) {
  return res.status(400).json({ ok: false, error: message, ...(extra || {}) });
}

function safeTrim(s, max = 2500) {
  return String(s || "").trim().replace(/\s+/g, " ").slice(0, max);
}

function normalizeStage(stage) {
  const s = String(stage || "").trim().toLowerCase();
  if (!s) return "";
  if (["bundle", "all"].includes(s)) return "bundle";
  if (["html", "index", "index.html", "index_html", "indexhtml"].includes(s)) return "index.html";
  if (["css", "style", "style.css", "style_css", "stylecss"].includes(s)) return "style.css";
  if (["js", "game", "game.js", "game_js", "gamejs"].includes(s)) return "game.js";
  return s;
}

function pickPrompt(body) {
  return (
    body?.prompt ??
    body?.idea ??
    body?.text ??
    body?.gameIdea ??
    body?.description ??
    body?.message ??
    ""
  );
}

function pickTheme(body) {
  const t = body?.theme || body?.colors || body?.palette || {};
  return {
    primary: t.primary || t.pink || t.accent || t.primaryColor || "",
    secondary: t.secondary || t.aqua || t.secondaryColor || "",
    background: t.background || t.bg || t.backgroundColor || "",
  };
}

function validHex(s) {
  const v = String(s || "").trim();
  return /^#([0-9a-f]{6}|[0-9a-f]{3})$/i.test(v) ? v : "";
}

function normalizeTheme(theme) {
  const primary = validHex(theme.primary) || "#ff0050";
  const secondary = validHex(theme.secondary) || "#00f2ea";
  const background = validHex(theme.background) || "#0b0f14";
  return { primary, secondary, background };
}

function pickTemplateId(body) {
  return safeTrim(body?.templateId || body?.template || "default", 48).toLowerCase();
}

function pickSpec(body) {
  // Accept many shapes to avoid regressions
  const direct = body?.spec;
  const plan = body?.plan;
  const context = body?.context;

  if (direct && typeof direct === "object") return direct;
  if (plan && typeof plan === "object") {
    if (plan.spec && typeof plan.spec === "object") return plan.spec;
    if (plan.plan && typeof plan.plan === "object" && plan.plan.spec) return plan.plan.spec;
  }
  if (context && typeof context === "object") {
    if (context.spec && typeof context.spec === "object") return context.spec;
    if (context.plan && typeof context.plan === "object" && context.plan.spec) return context.plan.spec;
  }
  return null;
}

function safeJsonParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function extractFirstJsonObject(text) {
  const s = String(text || "").trim();
  const first = s.indexOf("{");
  const last = s.lastIndexOf("}");
  if (first === -1 || last === -1 || last <= first) return null;
  const candidate = s.slice(first, last + 1);
  return safeJsonParse(candidate);
}

function toSpecFallback(prompt) {
  const p = safeTrim(prompt, 140);
  const titleSeed = p.split(/[.!?]/)[0].slice(0, 48).trim() || "ChatTok Live Game";
  const words = titleSeed.split(/\s+/).filter(Boolean);
  const title = words.slice(0, 6).join(" ") || "ChatTok Live Game";

  return {
    title,
    subtitle: "Live Interactive",
    oneSentence: "Chat commands control the action. Likes charge power. Gifts trigger big effects.",
    howToPlay: [
      "Type !join to enter.",
      "Type !hit (or any short command) to attack.",
      "Likes fill the power meter.",
      "Gifts trigger a special move."
    ],
    defaultSettings: { roundSeconds: 30, winGoal: 20 },
    commands: { join: "!join", action: "!hit", special: "!boost" },
    visuals: { theme: "neon-dark", vibe: p }
  };
}

// -------------------------------
// OpenAI (plan + optional edit)
// -------------------------------
async function callOpenAIChat({ model, messages, max_tokens, temperature, timeoutMs }) {
  if (!OPENAI_API_KEY) {
    const err = new Error("OPENAI_API_KEY is not set.");
    err.code = "NO_API_KEY";
    throw err;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(2000, timeoutMs || 15000));

  try {
    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: typeof temperature === "number" ? temperature : 0.7,
        max_tokens: typeof max_tokens === "number" ? max_tokens : 700,
        response_format: { type: "json_object" },
      }),
    });

    const json = await resp.json().catch(() => null);

    if (!resp.ok) {
      const msg =
        (json && (json.error?.message || json.error)) ||
        `OpenAI error (HTTP ${resp.status})`;
      const err = new Error(msg);
      err.status = resp.status;
      err.payload = json;
      throw err;
    }

    const content = json?.choices?.[0]?.message?.content || "";
    return String(content || "");
  } finally {
    clearTimeout(timeout);
  }
}

async function generateSpecWithOpenAI({ prompt, templateId, theme }) {
  const p = safeTrim(prompt, MAX_PROMPT_CHARS);
  const t = normalizeTheme(theme);

  const system = [
    "You write JSON specs for TikTok Live interactive games.",
    "Return ONLY valid JSON (no markdown).",
    "Keep it compact and production-friendly.",
    "Do NOT include code; only configuration and clear commands.",
    "Commands must be simple and memorable.",
  ].join(" ");

  const user = [
    `PROMPT: ${p}`,
    `TEMPLATE_ID: ${templateId}`,
    `THEME: primary=${t.primary}, secondary=${t.secondary}, background=${t.background}`,
    "",
    "Output JSON with keys:",
    "title, subtitle, oneSentence, howToPlay (4-6 strings), defaultSettings ({roundSeconds, winGoal}), commands ({join, action, special}), visuals ({theme, vibe}).",
    "Constraints:",
    "- title <= 32 chars if possible",
    "- howToPlay items <= 70 chars each",
    "- defaultSettings.roundSeconds between 15 and 60",
    "- commands must begin with !"
  ].join("\n");

  const content = await callOpenAIChat({
    model: OPENAI_MODEL_SPEC,
    timeoutMs: PLAN_TIMEOUT_MS,
    max_tokens: 550,
    temperature: 0.6,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  });

  const obj = extractFirstJsonObject(content) || safeJsonParse(content);
  if (!obj || typeof obj !== "object") return null;

  // minimal normalization
  const spec = {
    title: safeTrim(obj.title || "ChatTok Live Game", 48),
    subtitle: safeTrim(obj.subtitle || "Live Interactive", 60),
    oneSentence: safeTrim(obj.oneSentence || "", 120),
    howToPlay: Array.isArray(obj.howToPlay) ? obj.howToPlay.map((x) => safeTrim(x, 80)).filter(Boolean).slice(0, 6) : [],
    defaultSettings: {
      roundSeconds: Number(obj?.defaultSettings?.roundSeconds || 30),
      winGoal: Number(obj?.defaultSettings?.winGoal || 20),
    },
    commands: {
      join: safeTrim(obj?.commands?.join || "!join", 18),
      action: safeTrim(obj?.commands?.action || "!hit", 18),
      special: safeTrim(obj?.commands?.special || "!boost", 18),
    },
    visuals: {
      theme: safeTrim(obj?.visuals?.theme || "neon-dark", 40),
      vibe: safeTrim(obj?.visuals?.vibe || "", 220),
    },
  };

  spec.defaultSettings.roundSeconds = Math.max(15, Math.min(60, spec.defaultSettings.roundSeconds || 30));
  spec.defaultSettings.winGoal = Math.max(1, Math.min(999, spec.defaultSettings.winGoal || 20));

  // Guarantee howToPlay
  if (!spec.howToPlay.length) {
    spec.howToPlay = toSpecFallback(prompt).howToPlay;
  }

  // Guarantee commands begin with !
  for (const k of Object.keys(spec.commands)) {
    if (!String(spec.commands[k]).startsWith("!")) spec.commands[k] = "!" + normalizeCommand(spec.commands[k]);
  }

  return spec;
}

function normalizeCommand(s) {
  return String(s || "").trim().replace(/^!+/, "").replace(/\s+/g, "").slice(0, 16) || "cmd";
}

// -------------------------------
// Template-first generation
// -------------------------------
function injectThemeIntoCss(css, theme) {
  const t = normalizeTheme(theme);
  let out = String(css || "");

  // Replace ONLY :root vars if present (safe, deterministic).
  out = out.replace(/(--pink:\s*)#[0-9a-f]{3,6}\s*;/i, `$1${t.primary};`);
  out = out.replace(/(--aqua:\s*)#[0-9a-f]{3,6}\s*;/i, `$1${t.secondary};`);
  out = out.replace(/(--bg:\s*)#[0-9a-f]{3,6}\s*;/i, `$1${t.background};`);

  return out;
}

function injectSpecIntoJs(js, spec) {
  const s = JSON.stringify(spec || {}, null, 2);
  return String(js || "").replace("__SPEC_JSON__", s);
}

function postProcessHtml(html, spec) {
  // We enforce a safer runtime contract:
  // - do NOT hard-load proto bundles from relative paths (breaks in iframes)
  // - do NOT hard-load tiktok-client.js here (platform injects it)
  // - load game.js after DOM is ready (defer)
  let out = String(html || "");

  // Ensure stylesheet link exists
  if (!/href=["']style\.css["']/i.test(out)) {
    out = out.replace(/<\/head>/i, `  <link rel="stylesheet" href="style.css" />\n</head>`);
  }

  // Remove brittle runtime script tags (proto + tiktok-client)
  out = out.replace(/<script[^>]+src=["']https:\/\/cdn\.jsdelivr\.net\/npm\/google-protobuf[^"']+["'][^>]*>\s*<\/script>\s*/gi, "");
  out = out.replace(/<script[^>]+src=["']generic\.js["'][^>]*>\s*<\/script>\s*/gi, "");
  out = out.replace(/<script[^>]+src=["']unknownobjects\.js["'][^>]*>\s*<\/script>\s*/gi, "");
  out = out.replace(/<script[^>]+src=["']data_linkmic_messages\.js["'][^>]*>\s*<\/script>\s*/gi, "");
  out = out.replace(/<script[^>]+src=["']proto\.bundle\.js["'][^>]*>\s*<\/script>\s*/gi, "");
  out = out.replace(/<script[^>]+src=["']tiktok-client\.js["'][^>]*>\s*<\/script>\s*/gi, "");

  // Remove any existing game.js script tag (we will re-add in a controlled way)
  out = out.replace(/<script[^>]+src=["']game\.js["'][^>]*>\s*<\/script>\s*/gi, "");

  const boot = `
<script>
(function(){
  function $(id){ return document.getElementById(id); }
  function setStatus(text){
    try{
      var a = $("statusText"), b = $("statusTextInGame"), c = $("statusTextFooter");
      if (a) a.textContent = text;
      if (b) b.textContent = text;
      if (c) c.textContent = text;
    }catch(e){}
  }

  // Proto contract (safe default):
  // - We do NOT request proto bundles here.
  // - In ChatTokGaming preview/live, platform injects proto + TikTokClient.
  // - Outside ChatTokGaming, the game still runs in Practice Mode (no connection required).
  function checkRuntime(){
    var missing = [];
    if (typeof window.TikTokClient === "undefined") missing.push("TikTokClient");
    if (typeof window.proto === "undefined") missing.push("proto");
    if (missing.length){
      setStatus("Practice Mode (offline)");
      // no blocking UI; game.js should still run.
      console.warn("Missing runtime libs:", missing.join(", "), "(expected outside ChatTokGaming preview/live)");
    } else {
      setStatus("Ready");
    }
  }

  window.__CHATTOK_SPEC__ = ${JSON.stringify(spec || {}, null, 0)};

  window.addEventListener("DOMContentLoaded", function(){
    checkRuntime();
  });
})();
</script>`.trim();

  // Insert boot before </body> and add deferred game.js
  const gameTag = `<script src="game.js" defer></script>`;
  if (/<\/body>/i.test(out)) {
    out = out.replace(/<\/body>/i, `${boot}\n${gameTag}\n</body>`);
  } else {
    out += `\n${boot}\n${gameTag}\n`;
  }

  // Inject title if needed
  if (spec && spec.title && /<title>.*<\/title>/i.test(out)) {
    out = out.replace(/<title>.*<\/title>/i, `<title>${escapeHtml(spec.title)}</title>`);
  }

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

function buildBundle({ spec, theme }) {
  const html = postProcessHtml(TEMPLATES.indexHtml, spec);
  const css = injectThemeIntoCss(TEMPLATES.styleCss, theme);
  const js = injectSpecIntoJs(TEMPLATES.gameJs, spec);

  // Basic validation (never return empty)
  if (!String(html || "").trim()) throw new Error("Generated index.html is empty.");
  if (!String(css || "").trim()) throw new Error("Generated style.css is empty.");
  if (!String(js || "").trim()) throw new Error("Generated game.js is empty.");

  return { html, css, js };
}

// -------------------------------
// API: /api/plan
// -------------------------------
app.post("/api/plan", async (req, res) => {
  try {
    const prompt = safeTrim(pickPrompt(req.body), MAX_PROMPT_CHARS);
    if (!prompt) return badRequest(res, "Missing prompt");

    const templateId = pickTemplateId(req.body);
    const theme = pickTheme(req.body);

    let spec = null;

    // Try OpenAI first, fallback to heuristic spec (never 500).
    try {
      if (OPENAI_API_KEY) {
        spec = await generateSpecWithOpenAI({ prompt, templateId, theme });
      }
    } catch (e) {
      console.warn("[plan] OpenAI failed, using fallback:", e && e.message ? e.message : e);
      spec = null;
    }

    if (!spec) spec = toSpecFallback(prompt);

    // Return multiple compatible shapes so builder never regresses on parsing:
    // - spec
    // - plan.spec
    // - context.spec
    return okJson(res, {
      ok: true,
      spec,
      plan: { spec },
      context: { spec },
      meta: { templateId },
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: String(e && e.message ? e.message : e) });
  }
});

// -------------------------------
// API: /api/generate
// -------------------------------
app.post("/api/generate", async (req, res) => {
  try {
    const stage = normalizeStage(req.body?.stage);
    const templateId = pickTemplateId(req.body);
    const theme = pickTheme(req.body);

    const prompt = safeTrim(pickPrompt(req.body), MAX_PROMPT_CHARS);
    const spec = pickSpec(req.body) || (prompt ? toSpecFallback(prompt) : null);

    if (!spec) return badRequest(res, "Missing plan/spec (object)", { hint: "Call /api/plan first or include { spec }." });

    const bundle = buildBundle({ spec, theme });

    const files = {
      indexHtml: bundle.html,
      styleCss: bundle.css,
      gameJs: bundle.js,
    };

    // File-by-file response for builder staging, plus full bundle
    let file = null;
    if (stage && stage !== "bundle") {
      if (stage === "index.html") file = { name: "index.html", content: files.indexHtml };
      else if (stage === "style.css") file = { name: "style.css", content: files.styleCss };
      else if (stage === "game.js") file = { name: "game.js", content: files.gameJs };
      else file = { name: stage, content: "" };
    }

    return okJson(res, {
      ok: true,
      stage: stage || "bundle",
      file,
      files,

      // Legacy keys (some old builders used these)
      index_html: files.indexHtml,
      style_css: files.styleCss,
      game_js: files.gameJs,

      // Compatibility context
      spec,
      plan: { spec },
      context: { spec, templateId },
      meta: { templateId },
    });
  } catch (e) {
    console.error(e);
    const msg = String(e && e.message ? e.message : e);
    return res.status(500).json({ ok: false, error: msg });
  }
});

// -------------------------------
// API: /api/edit (optional limited edits)
// -------------------------------
app.post("/api/edit", async (req, res) => {
  try {
    const change = safeTrim(req.body?.prompt || req.body?.change || req.body?.changeRequest || "", 1200);
    const currentFiles = req.body?.files || req.body?.currentFiles || {};
    const theme = pickTheme(req.body);
    const spec = pickSpec(req.body) || req.body?.spec || null;

    const remaining = Number(req.body?.remainingEdits ?? 3);
    if (remaining <= 0) {
      return okJson(res, { ok: true, remainingEdits: 0, patches: [], notes: "No edits remaining." });
    }

    // 1) Theme-only edit (fast, deterministic, zero OpenAI)
    if (/\b(theme|color|colour|primary|secondary|background|palette)\b/i.test(change)) {
      const cssBase = String(currentFiles.styleCss || currentFiles["style.css"] || TEMPLATES.styleCss);
      const css = injectThemeIntoCss(cssBase, theme);
      return okJson(res, {
        ok: true,
        remainingEdits: remaining - 1,
        patches: [{ name: "style.css", content: css }],
        notes: "Re-injected theme vars into style.css.",
      });
    }

    // 2) If OpenAI is not configured, fallback to rebuilding bundle with updated title/subtitle hints.
    if (!OPENAI_API_KEY || !spec) {
      let spec2 = spec || toSpecFallback(change || "ChatTok Live Game");
      if (change) {
        // very light heuristic edits
        if (/title\s*:/i.test(change)) {
          const m = change.match(/title\s*:\s*(.+)$/im);
          if (m && m[1]) spec2.title = safeTrim(m[1], 48);
        }
      }
      const bundle = buildBundle({ spec: spec2, theme });
      return okJson(res, {
        ok: true,
        remainingEdits: remaining - 1,
        patches: [
          { name: "index.html", content: bundle.html },
          { name: "style.css", content: bundle.css },
          { name: "game.js", content: bundle.js },
        ],
        notes: "Applied a safe edit by rebuilding from templates (OpenAI not used).",
        spec: spec2,
        plan: { spec: spec2 },
        context: { spec: spec2 },
      });
    }

    // 3) OpenAI-assisted edit (compact, hard timeout, with safe fallback)
    const target = String(req.body?.target || "game.js").toLowerCase();
    const allowedTargets = new Set(["index.html", "style.css", "game.js"]);
    const t = allowedTargets.has(target) ? target : "game.js";

    const base =
      String(
        currentFiles[t] ||
          (t === "index.html" ? currentFiles.indexHtml : t === "style.css" ? currentFiles.styleCss : currentFiles.gameJs) ||
          ""
      ) || (t === "index.html" ? TEMPLATES.indexHtml : t === "style.css" ? TEMPLATES.styleCss : TEMPLATES.gameJs);

    const sys = [
      "You are editing a single web file for a TikTok live game.",
      "Return ONLY the full updated file contents (no markdown).",
      "Do not introduce new external dependencies.",
      "Do not reference files that do not exist.",
      "Keep IDs and selectors consistent with the existing file."
    ].join(" ");

    const usr = [
      `EDIT REQUEST: ${safeTrim(change, 1000)}`,
      `FILE: ${t}`,
      `SPEC (for context): ${JSON.stringify(spec).slice(0, 1400)}`,
      "",
      "CURRENT FILE CONTENTS:",
      base
    ].join("\n");

    let updated = null;
    try {
      updated = await callOpenAIChat({
        model: OPENAI_MODEL_EDIT,
        timeoutMs: EDIT_TIMEOUT_MS,
        max_tokens: 900,
        temperature: 0.4,
        messages: [{ role: "system", content: sys }, { role: "user", content: usr }],
      });
    } catch (e) {
      console.warn("[edit] OpenAI failed, returning unchanged:", e && e.message ? e.message : e);
      updated = null;
    }

    const content = String(updated || "").trim() || base;

    // If CSS, re-inject theme to be safe
    const finalContent = t === "style.css" ? injectThemeIntoCss(content, theme) : content;

    return okJson(res, {
      ok: true,
      remainingEdits: remaining - 1,
      patches: [{ name: t, content: finalContent }],
      notes: updated ? "Edit applied." : "Edit fallback: unchanged file returned due to timeout/error.",
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: String(e && e.message ? e.message : e) });
  }
});

// -------------------------------
// Health
// -------------------------------
app.get("/health", (_req, res) => {
  res.status(200).json({
    ok: true,
    ts: Date.now(),
    templatesLoadedAt: TEMPLATES.loadedAt,
    hasOpenAIKey: !!OPENAI_API_KEY,
  });
});

// -------------------------------
// Start
// -------------------------------
app.listen(PORT, HOST, () => {
  console.log(`[chattok-builder-api] listening on http://${HOST}:${PORT}`);
});
