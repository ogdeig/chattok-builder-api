/* server.js — ChatTok Builder API (Render)
   Goals:
   - Stable Builder/API contract (no more "Missing prompt/plan" regressions)
   - Reliable outputs: HTML + CSS are template-based (no LLM corruption)
   - JS uses template-first + AI_REGION generation w/ timeout + fallback
   - Correct CORS + preflight
   - Exactly ONE app.listen()
*/

const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
require("dotenv").config();

const app = express();
app.use(express.json({ limit: "1mb" }));

// ---------------------------
// 1) CORS (stable + preflight)
// ---------------------------
const DEFAULT_ALLOWED = [
  "https://ogdeig.github.io",
  "http://localhost:3000",
  "http://localhost:5173",
  "http://localhost:5500",
  "http://127.0.0.1:3000",
  "http://127.0.0.1:5173",
  "http://127.0.0.1:5500",
];

const allowedOriginsFromEnv = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const allowedOrigins = Array.from(new Set([...DEFAULT_ALLOWED, ...allowedOriginsFromEnv]));

const corsOptions = {
  origin: function (origin, cb) {
    // Allow requests with no origin (curl/health checks/server-to-server)
    if (!origin) return cb(null, true);

    // If ALLOWED_ORIGINS was intentionally set to "*" allow all.
    if ((process.env.ALLOWED_ORIGINS || "").trim() === "*") return cb(null, true);

    // Otherwise allow only known origins
    if (allowedOrigins.includes(origin)) return cb(null, true);

    return cb(new Error("CORS blocked: " + origin));
  },
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  optionsSuccessStatus: 204,
};

app.use(cors(corsOptions));
app.options("*", cors(corsOptions));

// ---------------------------
// 2) Helpers / config
// ---------------------------
const CONTRACT_VERSION = 2;

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const OPENAI_TIMEOUT_MS = Number.parseInt(process.env.OPENAI_TIMEOUT_MS || "35000", 10);

function noStore(res) {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.setHeader("Surrogate-Control", "no-store");
}

function assert(cond, msg) {
  if (!cond) {
    const e = new Error(msg || "Assertion failed");
    e.status = 400;
    throw e;
  }
}

function safeStr(v, fallback = "") {
  const s = typeof v === "string" ? v : v == null ? "" : String(v);
  return s.trim() ? s : fallback;
}

function clamp(n, min, max) {
  const x = Number(n);
  if (!Number.isFinite(x)) return min;
  return Math.min(max, Math.max(min, x));
}

function stripCodeFences(s) {
  const t = String(s || "").trim();
  const m = t.match(/```(?:\w+)?\s*([\s\S]*?)\s*```/);
  return m ? m[1].trim() : t;
}

function escapeHtml(s) {
  return String(s || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function pickSpecFromReq(body) {
  const b = body && typeof body === "object" ? body : {};
  return b.spec || b.plan || (b.context && (b.context.spec || b.context.plan)) || null;
}

function pickIdeaFromReq(body) {
  const b = body && typeof body === "object" ? body : {};
  return safeStr(b.idea || b.prompt || "");
}

function normalizeTheme(bodyTheme) {
  const t = bodyTheme && typeof bodyTheme === "object" ? bodyTheme : {};
  const primary = safeStr(t.primary, "#ff0050");
  const secondary = safeStr(t.secondary, "#00f2ea");
  const background = safeStr(t.background, "#0b0f14");

  // very small validation — keep defaults if invalid
  const hex6 = /^#[0-9a-fA-F]{6}$/;
  return {
    primary: hex6.test(primary) ? primary.toLowerCase() : "#ff0050",
    secondary: hex6.test(secondary) ? secondary.toLowerCase() : "#00f2ea",
    background: hex6.test(background) ? background.toLowerCase() : "#0b0f14",
  };
}

// ---------------------------
// 3) Templates (loaded once)
// ---------------------------
function resolveTemplatePath(filename) {
  const base = process.env.TEMPLATE_DIR ? path.resolve(process.env.TEMPLATE_DIR) : path.resolve(__dirname);
  return path.join(base, filename);
}

function readTemplate(filename) {
  const p = resolveTemplatePath(filename);
  if (!fs.existsSync(p)) {
    const e = new Error(`Template not found: ${filename} at ${p}`);
    e.status = 500;
    throw e;
  }
  return fs.readFileSync(p, "utf8");
}

const TPL = {
  index: readTemplate("index.template.html"),
  css: readTemplate("style.template.css"),
  js: readTemplate("game.template.js"),
};

// ---------------------------
// 4) OpenAI (Responses API) + timeout + schema
// ---------------------------
function ensureFetch() {
  if (typeof fetch !== "function") {
    const e = new Error("Server runtime missing global fetch(). Use Node 18+ on Render.");
    e.status = 503;
    throw e;
  }
}

function extractOutputText(respJson) {
  if (!respJson) return "";
  if (typeof respJson.output_text === "string") return respJson.output_text;

  const out = respJson.output;
  if (!Array.isArray(out)) return "";

  const parts = [];
  for (const item of out) {
    if (!item || item.type !== "message") continue;
    if (!Array.isArray(item.content)) continue;
    for (const c of item.content) {
      if (c && c.type === "output_text" && typeof c.text === "string") parts.push(c.text);
    }
  }
  return parts.join("\n").trim();
}

async function callOpenAIResponses({ prompt, schema }) {
  ensureFetch();

  if (!OPENAI_API_KEY) {
    const e = new Error("OPENAI_API_KEY is missing on the server");
    e.status = 503;
    throw e;
  }

  const endpoint = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1/responses").trim();

  const body = {
    model: OPENAI_MODEL,
    store: false,
    temperature: 0.2,
    max_output_tokens: 900,
    input: [{ role: "user", content: String(prompt || "") }],
  };

  if (schema) {
    body.text = {
      format: {
        type: "json_schema",
        name: "spec_schema",
        strict: true,
        schema,
      },
    };
  }

  const controller = new AbortController();
  const to = setTimeout(() => controller.abort(), OPENAI_TIMEOUT_MS);

  let r;
  try {
    r = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    const e = new Error(
      err && err.name === "AbortError"
        ? `OpenAI request timed out after ${OPENAI_TIMEOUT_MS}ms`
        : "OpenAI request failed (network/transport error)"
    );
    e.status = err && err.name === "AbortError" ? 504 : 502;
    e.cause = err;
    throw e;
  } finally {
    clearTimeout(to);
  }

  let json;
  try {
    json = await r.json();
  } catch (err) {
    const e = new Error("OpenAI response was not valid JSON");
    e.status = 502;
    e.cause = err;
    throw e;
  }

  if (!r.ok) {
    const e = new Error(json?.error?.message || "OpenAI error");
    e.status = r.status;
    e.details = json;
    throw e;
  }

  return json;
}

// ---------------------------
// 5) Spec generation (plan)
// ---------------------------
const SPEC_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    title: { type: "string" },
    subtitle: { type: "string" },
    oneSentence: { type: "string" },
    howToPlay: { type: "array", items: { type: "string" }, minItems: 3, maxItems: 8 },
    defaultSettings: {
      type: "object",
      additionalProperties: false,
      properties: {
        roundSeconds: { type: "number" },
        winGoal: { type: "number" },
      },
      required: ["roundSeconds", "winGoal"],
    },
    // optional, helpful for AI_REGION prompts
    commands: {
      type: "object",
      additionalProperties: true,
      properties: {
        join: { type: "string" },
        fire: { type: "string" },
        boost: { type: "string" },
      },
    },
    visuals: {
      type: "object",
      additionalProperties: true,
      properties: {
        theme: { type: "string" },
        vibe: { type: "string" },
      },
    },
  },
  required: ["title", "subtitle", "oneSentence", "howToPlay", "defaultSettings"],
};

function fallbackSpecFromIdea(idea, templateId) {
  const name = safeStr(templateId, "arena");
  const title = name === "seek" ? "Seek & Destroy" : "ChatTok Live Arena";
  const subtitle = "Live Interactive";
  return {
    title,
    subtitle,
    oneSentence: "Chat commands affect the action instantly; likes charge energy; gifts trigger power moves.",
    howToPlay: [
      "Type !join to enter the match.",
      "Type a command (like A4 or !fire A4) to act.",
      "Likes charge the power meter; gifts trigger special effects.",
      "Watch the right-side flags for live event feedback.",
    ],
    defaultSettings: { roundSeconds: 25, winGoal: 20 },
    commands: { join: "!join", fire: "!fire A4", boost: "!boost" },
    visuals: { theme: "neon-dark", vibe: safeStr(idea, "").slice(0, 64) },
  };
}

async function generateSpec({ idea, templateId }) {
  const prompt = [
    "You are generating a compact game spec for a TikTok LIVE interactive game.",
    "The game MUST feel alive even without connection (motion, HUD, reactions).",
    "Keep the spec short and concrete. No essays.",
    "",
    `TemplateId: ${safeStr(templateId, "arena")}`,
    "",
    "Game idea:",
    safeStr(idea, "A fun live interactive game."),
    "",
    "Return JSON matching the provided schema.",
  ].join("\n");

  try {
    const raw = await callOpenAIResponses({ prompt, schema: SPEC_SCHEMA });
    // With strict schema, the output_text is JSON
    const txt = extractOutputText(raw);
    const obj = JSON.parse(txt);
    // normalize
    obj.title = safeStr(obj.title, "ChatTok Live Game");
    obj.subtitle = safeStr(obj.subtitle, "Live Interactive");
    obj.oneSentence = safeStr(obj.oneSentence, "Chat and gifts power the action.");
    obj.howToPlay = Array.isArray(obj.howToPlay) ? obj.howToPlay.map((x) => safeStr(x)).filter(Boolean) : [];
    if (obj.howToPlay.length < 3) obj.howToPlay = fallbackSpecFromIdea(idea, templateId).howToPlay;
    obj.defaultSettings = obj.defaultSettings || {};
    obj.defaultSettings.roundSeconds = clamp(obj.defaultSettings.roundSeconds, 5, 300);
    obj.defaultSettings.winGoal = clamp(obj.defaultSettings.winGoal, 1, 999);
    return obj;
  } catch (e) {
    // Fallback spec must still allow the builder to proceed
    console.warn("Spec generation failed; using fallback:", e?.message || e);
    return fallbackSpecFromIdea(idea, templateId);
  }
}

// ---------------------------
// 6) HTML rendering
// ---------------------------
function renderHowToLi(spec) {
  const items = Array.isArray(spec?.howToPlay) ? spec.howToPlay : [];
  return items
    .slice(0, 10)
    .map((x) => `<li>${escapeHtml(String(x || ""))}</li>`)
    .join("\n");
}

function renderSettingsFieldsHtml(spec) {
  const round = clamp(spec?.defaultSettings?.roundSeconds ?? 20, 5, 300);
  const goal = clamp(spec?.defaultSettings?.winGoal ?? 20, 1, 999);

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

/**
 * IMPORTANT (platform robustness):
 * The builder only outputs: index.html, style.css, game.js
 * So index.html MUST NOT hard-require proto/generic bundles that aren't shipped.
 * Instead we rely on platform injection (tiktok-client.js + proto) and fail gracefully if missing.
 */
function normalizeIndexForChatTok(html) {
  let out = String(html || "");

  // Remove any script tags that reference proto files or tiktok-client.js (since builder doesn't ship them)
  out = out.replace(/<script[^>]+src="[^"]*(google-protobuf|generic\.js|unknownobjects\.js|data_linkmic_messages\.js|proto\.bundle\.js|tiktok-client\.js)"[^>]*>\s*<\/script>\s*/gi, "");

  // Ensure there is ONLY one game.js include (keep last)
  // (We'll append a clean include at the bottom.)
  out = out.replace(/<script[^>]+src="game\.js"[^>]*>\s*<\/script>\s*/gi, "");

  // Add a tiny base-href fix for srcdoc-ish contexts (does nothing on normal hosting)
  // Note: we cannot guess a correct absolute base; we just avoid crashing and show status.
  const headClose = out.indexOf("</head>");
  const injectedHead = `
  <script>
    (function(){
      try{
        // In some preview iframes (about:srcdoc), relative paths may break.
        // We can't safely infer a base URL cross-origin, so we just surface a status hint.
        if (String(location.href||"").startsWith("about:")) {
          window.__CHATTOK_SRC_DOC__ = true;
        }
      }catch(e){}
    })();
  </script>
`.trim();

  if (headClose !== -1) {
    out = out.slice(0, headClose) + injectedHead + "\n" + out.slice(headClose);
  } else {
    out = injectedHead + "\n" + out;
  }

  // Inject runtime guard (friendly on-screen message if TikTokClient/proto missing)
  const bodyClose = out.lastIndexOf("</body>");
  const guard = `
  <script>
    (function(){
      function setStatus(text){
        try{
          var a = document.getElementById("statusText");
          var b = document.getElementById("statusTextInGame");
          var c = document.getElementById("statusTextFooter");
          if (a) a.textContent = text;
          if (b) b.textContent = text;
          if (c) c.textContent = text;
        }catch(e){}
      }

      function showCard(msg){
        try{
          var root = document.getElementById("gameRoot");
          if (!root) return;
          var d = document.createElement("div");
          d.className = "card";
          d.style.maxWidth = "520px";
          d.innerHTML = "<h3>Runtime missing</h3><div>" + msg + "</div>";
          root.appendChild(d);
        }catch(e){}
      }

      window.addEventListener("DOMContentLoaded", function(){
        var missing = [];
        if (typeof TikTokClient === "undefined") missing.push("TikTokClient");
        if (typeof proto === "undefined") missing.push("proto");
        if (missing.length){
          var msg = "Missing: " + missing.join(", ") + ". In ChatTok preview/live these are injected by the platform.";
          if (window.__CHATTOK_SRC_DOC__) msg += " (Also: running in about:srcdoc can break relative file loads.)";
          setStatus("Not ready: missing runtime");
          showCard(msg);
        } else {
          setStatus("Ready");
        }
      });
    })();
  </script>
  <script src="game.js"></script>
`.trim();

  if (bodyClose !== -1) {
    out = out.slice(0, bodyClose) + guard + "\n" + out.slice(bodyClose);
  } else {
    out += "\n" + guard + "\n";
  }

  return out;
}

function renderIndexHtml(indexTemplate, spec) {
  let html = String(indexTemplate || "");
  html = html.replaceAll("{{TITLE}}", escapeHtml(spec.title || "ChatTok Live Game"));
  html = html.replaceAll("{{SUBTITLE}}", escapeHtml(spec.subtitle || "Live Interactive"));
  html = html.replaceAll("{{ONE_SENTENCE}}", escapeHtml(spec.oneSentence || ""));
  html = html.replaceAll("{{HOW_TO_PLAY_LI}}", renderHowToLi(spec));
  html = html.replaceAll("{{SETTINGS_FIELDS_HTML}}", renderSettingsFieldsHtml(spec));
  return normalizeIndexForChatTok(html);
}

// ---------------------------
// 7) CSS rendering (theme inject only)
// ---------------------------
function injectThemeIntoCss(cssTemplate, theme) {
  let css = String(cssTemplate || "");

  // Replace ONLY the known :root vars
  css = css.replace(/--pink:\s*#[0-9a-fA-F]{6}\s*;/, `--pink:${theme.primary};`);
  css = css.replace(/--aqua:\s*#[0-9a-fA-F]{6}\s*;/, `--aqua:${theme.secondary};`);
  css = css.replace(/--bg:\s*#[0-9a-fA-F]{6}\s*;/, `--bg:${theme.background};`);

  return css;
}

function validateCss(css) {
  const c = String(css || "");
  if (!c.includes(":root")) throw new Error("style.css missing :root block");
  if (!c.includes("--pink") || !c.includes("--aqua") || !c.includes("--bg")) {
    throw new Error("style.css missing theme vars (--pink/--aqua/--bg)");
  }
  // Guard against the common concatenation corruption
  if (/flex-direction\s*:\s*body\s*\{/i.test(c)) throw new Error("style.css appears corrupted (concatenation artifact)");
  return true;
}

// ---------------------------
// 8) JS generation (template-first + AI_REGION)
// ---------------------------
function replaceBetweenMarkers(fullText, startMarker, endMarker, replacement) {
  const a = fullText.indexOf(startMarker);
  const b = fullText.indexOf(endMarker);
  if (a === -1 || b === -1 || b <= a) throw new Error(`Missing markers: ${startMarker} / ${endMarker}`);
  const before = fullText.slice(0, a + startMarker.length);
  const after = fullText.slice(b);
  return `${before}\n\n${replacement.trim()}\n\n${after}`;
}

function injectSpecIntoGameJs(jsTemplate, spec) {
  const json = JSON.stringify(spec, null, 2);
  return String(jsTemplate || "").replace("__SPEC_JSON__", json);
}

function fallbackAiRegion() {
  return `
function aiInit(ctx){
  renderBase();
  renderMeters();
  ctx.ui.flag({ who:"SYSTEM", msg:"Demo running — go LIVE and connect to play with chat.", pfp:"" });
  ctx.ui.card("Quick Start", "<p>Type <b>!join</b> in chat. Then fire with <b>A4</b> or <b>!fire A4</b>.</p>");
}

function aiOnChat(ctx, chat){
  if (!chat || !chat.text) return;
  const t = String(chat.text).trim();
  const low = t.toLowerCase();

  // join
  if (low === "!join" || low.startsWith("!join ")) {
    ctx.ui.flag({ who: chat.nickname || "viewer", msg:"joined the match ✅", pfp: chat.pfp || "" });
    return;
  }

  // fire coords (A1..J10)
  const m = t.match(/(?:!fire\\s*)?([A-Ja-j])\\s*(10|[1-9])\\b/);
  if (m){
    const coord = (m[1].toUpperCase() + m[2]);
    const hit = (Math.random() < 0.25);
    ctx.ui.flag({
      who: chat.nickname || "viewer",
      msg: hit ? ("🎯 HIT " + coord + "!") : ("💨 MISS " + coord),
      pfp: chat.pfp || ""
    });
    playFX(hit ? "hit" : "miss");
    return;
  }

  // otherwise just echo reaction sometimes
  if (low.includes("boom") || low.includes("fire") || low.includes("hit")){
    ctx.ui.flag({ who: chat.nickname || "viewer", msg:"💥", pfp: chat.pfp || "" });
    playFX("hit");
  }
}

function aiOnLike(ctx, like){
  if ((ctx.state.counters.likes % 50) === 0) {
    ctx.ui.flag({ who:"SYSTEM", msg:"Likes charged ⚡ Power rising!", pfp:"" });
  }
}

function aiOnGift(ctx, gift){
  const who = gift.nickname || "viewer";
  ctx.ui.flag({ who, msg:"🎁 Power-up activated!", pfp: gift.pfp || "" });
  playFX("gift");
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
  if (/\brequire\s*\(/.test(c) || /\bimport\s+/.test(c)) return { ok: false, reason: "require/import not allowed" };
  // Disallow ctx.on usage (common hallucination)
  if (/\bctx\.on\s*\(/.test(c)) return { ok: false, reason: "ctx.on() not allowed" };

  return { ok: true, code: c };
}

async function generateAiRegion({ idea, spec, templateId, changeRequest }) {
  const maxOut = Number(process.env.OPENAI_MAX_OUTPUT_TOKENS_JS || 1200);

  const prompt = [
    "Return ONLY JavaScript code. No markdown. No code fences.",
    "Generate ONLY the code that goes inside the AI_REGION of game.template.js.",
    "You MUST define these functions exactly:",
    "- aiInit(ctx)",
    "- aiOnChat(ctx, chat)",
    "- aiOnLike(ctx, like)",
    "- aiOnGift(ctx, gift)",
    "",
    "You may call ONLY these helpers (already defined in the template):",
    "renderBase(), renderMeters(), playFX(type), ctx.ui.flag({...}), ctx.ui.card(title, html), ctx.ui.setStatus(text, ok)",
    "",
    "Hard rules:",
    "- Do NOT call ctx.on(...). ctx is NOT an event emitter.",
    "- Do NOT require/import anything.",
    "- Make gameplay visible even with no TikTok connection (offline demo still shows motion + UI).",
    "- Handle chat delay gracefully (actions update instantly with flags; no precision timing required).",
    "",
    `TemplateId: ${safeStr(templateId, "arena")}`,
    "",
    "Spec JSON:",
    JSON.stringify(spec || {}, null, 2),
    "",
    changeRequest ? `Change request:\n${changeRequest}` : `Game idea:\n${safeStr(idea, "")}`,
  ].join("\n");

  try {
    ensureFetch();
    const endpoint = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1/responses").trim();

    const controller = new AbortController();
    const to = setTimeout(() => controller.abort(), OPENAI_TIMEOUT_MS);

    let r;
    try {
      r = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
          model: OPENAI_MODEL,
          store: false,
          temperature: 0.25,
          max_output_tokens: maxOut,
          input: [{ role: "user", content: prompt }],
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(to);
    }

    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      const e = new Error(data?.error?.message || "OpenAI request failed");
      e.status = r.status;
      throw e;
    }

    const code = stripCodeFences(extractOutputText(data));
    const checked = sanitizeAiRegion(code);
    if (!checked.ok) {
      console.warn("AI_REGION rejected:", checked.reason);
      return fallbackAiRegion();
    }
    return checked.code;
  } catch (e) {
    // timeout / transient errors => safe fallback
    console.warn("AI_REGION generation failed; using fallback:", e?.message || e);
    return fallbackAiRegion();
  }
}

function validateHtml(html) {
  const requiredIds = ["setupOverlay", "startGameBtn", "liveIdInput", "gameRoot", "flags"];
  for (const id of requiredIds) {
    if (!html.includes(`id="${id}"`) && !html.includes(`id='${id}'`)) {
      throw new Error(`index.html missing required id: ${id}`);
    }
  }
  const matches = html.match(/id\s*=\s*["']liveIdInput["']/g) || [];
  if (matches.length !== 1) throw new Error(`index.html must have exactly 1 liveIdInput (found ${matches.length})`);
}

function validateJs(js) {
  const s = String(js || "");
  if (!s.includes("new TikTokClient")) throw new Error("game.js missing TikTokClient usage");
  if (!s.includes("// === AI_REGION_START ===") || !s.includes("// === AI_REGION_END ===")) {
    throw new Error("game.js missing AI_REGION markers");
  }
}

// ---------------------------
// 9) Endpoints
// ---------------------------

app.get("/health", (req, res) => {
  noStore(res);
  res.json({
    ok: true,
    status: "ok",
    contractVersion: CONTRACT_VERSION,
    model: OPENAI_MODEL,
    timeoutMs: OPENAI_TIMEOUT_MS,
    templates: {
      index: Boolean(TPL.index && TPL.index.length),
      css: Boolean(TPL.css && TPL.css.length),
      js: Boolean(TPL.js && TPL.js.length),
    },
    now: new Date().toISOString(),
  });
});

// POST /api/plan
// Accepts: { idea|prompt, templateId }
// Returns canonical + backward compatible mirrors:
// { ok:true, plan:<spec>, spec:<spec>, context:{spec:<spec>} }
app.post("/api/plan", async (req, res) => {
  noStore(res);
  try {
    const idea = pickIdeaFromReq(req.body);
    assert(idea, "Missing prompt");

    const templateId = safeStr(req.body?.templateId, "arena");
    const spec = await generateSpec({ idea, templateId });

    res.json({
      ok: true,
      plan: spec,
      spec,
      planText: JSON.stringify(spec, null, 2),
      context: { spec, plan: spec, templateId },
    });
  } catch (e) {
    const status = e.status || 500;
    res.status(status).json({ ok: false, error: e.message || "Plan failed" });
  }
});

// POST /api/generate
// Accepts: { stage:"html"|"css"|"js", spec|plan|context.spec, idea|prompt, templateId, theme }
// Returns canonical: { ok:true, file:{name,content}, content:<mirror>, context:{spec,stage} }
// Also returns optional files mirror for builder backward compatibility.
app.post("/api/generate", async (req, res) => {
  noStore(res);

  try {
    const stage = safeStr(req.body?.stage, "").toLowerCase();
    assert(stage === "html" || stage === "css" || stage === "js", "Invalid stage");

    const idea = pickIdeaFromReq(req.body) || "(no idea provided)";
    const templateId = safeStr(req.body?.templateId, "arena");
    const theme = normalizeTheme(req.body?.theme);

    let spec = pickSpecFromReq(req.body);
    if (!spec || typeof spec !== "object") {
      // If builder forgot spec, do NOT 500 — generate a fallback plan so the flow continues.
      spec = await generateSpec({ idea, templateId });
    }

    let fileName = "";
    let content = "";

    if (stage === "html") {
      fileName = "index.html";
      content = renderIndexHtml(TPL.index, spec);
      validateHtml(content);
    }

    if (stage === "css") {
      fileName = "style.css";
      content = injectThemeIntoCss(TPL.css, theme);
      validateCss(content);
    }

    if (stage === "js") {
      fileName = "game.js";
      const base = injectSpecIntoGameJs(TPL.js, spec);
      const aiRegion = await generateAiRegion({ idea, spec, templateId, changeRequest: "" });
      content = replaceBetweenMarkers(base, "// === AI_REGION_START ===", "// === AI_REGION_END ===", aiRegion);
      validateJs(content);
    }

    const filesMirror = {
      indexHtml: stage === "html" ? content : undefined,
      styleCss: stage === "css" ? content : undefined,
      gameJs: stage === "js" ? content : undefined,
    };

    res.json({
      ok: true,
      file: { name: fileName, content },
      content, // mirror
      files: filesMirror, // compatibility
      context: { spec, plan: spec, stage, templateId, theme },
    });
  } catch (e) {
    const status = e.status || (String(e?.message || "").includes("timed out") ? 504 : 500);
    res.status(status).json({
      ok: false,
      error: e.message || "Generate failed",
    });
  }
});

// POST /api/edit
// Accepts:
// {
//   remainingEdits:number,
//   changeRequest:string,
//   templateId:string,
//   theme:{...},
//   currentFiles: { "index.html":string, "style.css":string, "game.js":string }
// }
// Returns: { ok:true, patches:[{name,content}], remainingEdits }
function extractSpecFromGameJs(gameJs) {
  const js = String(gameJs || "");
  const m = js.match(/const\s+SPEC\s*=\s*([\s\S]*?);\s*\n/);
  if (!m) return null;
  const raw = m[1].trim();
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

app.post("/api/edit", async (req, res) => {
  noStore(res);
  try {
    const remainingEdits = Number(req.body?.remainingEdits ?? 0) || 0;
    assert(remainingEdits > 0, "No edits remaining");

    const changeRequest = safeStr(req.body?.changeRequest, "");
    assert(changeRequest, "Missing changeRequest");

    const templateId = safeStr(req.body?.templateId, "arena");
    const theme = normalizeTheme(req.body?.theme);

    const currentFiles = req.body?.currentFiles && typeof req.body.currentFiles === "object" ? req.body.currentFiles : {};
    const curHtml = safeStr(currentFiles["index.html"], "");
    const curCss = safeStr(currentFiles["style.css"], "");
    const curJs = safeStr(currentFiles["game.js"], "");

    // Spec from current JS if possible, otherwise fallback
    let spec = extractSpecFromGameJs(curJs);
    if (!spec) spec = fallbackSpecFromIdea("", templateId);

    const patches = [];

    // If user asks for color/theme changes, safely re-inject CSS vars (no LLM)
    const wantsTheme =
      /\bcolor\b|\btheme\b|primary|secondary|background|pink|aqua|neon|dark|light/i.test(changeRequest);

    if (wantsTheme) {
      const nextCss = injectThemeIntoCss(TPL.css, theme);
      validateCss(nextCss);
      patches.push({ name: "style.css", content: nextCss });
    } else if (curCss) {
      // preserve current CSS (do not attempt LLM edits to CSS)
      patches.push({ name: "style.css", content: curCss });
    }

    // Re-generate AI_REGION for gameplay edits
    let baseJs;
    if (curJs && curJs.includes("// === AI_REGION_START ===") && curJs.includes("// === AI_REGION_END ===")) {
      // keep the current JS shell to avoid regressions
      baseJs = curJs;
    } else {
      baseJs = injectSpecIntoGameJs(TPL.js, spec);
    }

    const aiRegion = await generateAiRegion({
      idea: "",
      spec,
      templateId,
      changeRequest,
    });

    const nextJs = replaceBetweenMarkers(baseJs, "// === AI_REGION_START ===", "// === AI_REGION_END ===", aiRegion);
    validateJs(nextJs);
    patches.push({ name: "game.js", content: nextJs });

    // We do not patch index.html in edit (keep stable DOM to avoid regressions)
    if (curHtml) patches.unshift({ name: "index.html", content: curHtml });

    res.json({
      ok: true,
      patches,
      remainingEdits: remainingEdits - 1,
      context: { spec, templateId, theme },
    });
  } catch (e) {
    const status = e.status || 500;
    res.status(status).json({ ok: false, error: e.message || "Edit failed" });
  }
});

// ---------------------------
// 10) One listen() only
// ---------------------------
const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, () => {
  console.log(`[ChatTok Builder API] listening on :${PORT} (contract v${CONTRACT_VERSION})`);
});
