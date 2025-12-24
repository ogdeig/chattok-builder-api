/**
 * ChatTok Builder API (Render)
 * - Endpoints: /health, /api/plan, /api/generate, /api/edit
 * - Strict validator: if AI output lacks required layout/IDs or tries to fetch proto/tailwind, we fallback to templates.
 * - Fallbacks guarantee a working first shot. One app.listen only.
 */

const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
require("dotenv").config();

const app = express();
app.use(express.json({ limit: "1mb" }));

/* CORS */
const allowedOrigins = (process.env.ALLOWED_ORIGINS || "").split(",").map(s=>s.trim()).filter(Boolean);
const corsOptions = {
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (!allowedOrigins.length || allowedOrigins.includes(origin)) return cb(null, true);
    return cb(new Error("CORS blocked: " + origin));
  },
  methods: ["GET","POST","OPTIONS"],
  allowedHeaders: ["Content-Type","Authorization"],
  optionsSuccessStatus: 204
};
app.use(cors(corsOptions));
app.options("*", cors(corsOptions));

/* Config */
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL_DEFAULT = process.env.OPENAI_MODEL || "gpt-4o-mini";
const OPENAI_TIMEOUT_MS = Number.parseInt(process.env.OPENAI_TIMEOUT_MS || "35000", 10);

/* Utils */
function assert(cond, msg){ if(!cond) throw new Error(msg || "Assertion failed"); }
function safeJson(obj){ try{return JSON.stringify(obj);}catch{return '"[unserializable]"';} }

/* OpenAI Responses API helpers */
function extractAssistantText(respJson) {
  if (!respJson) return "";
  if (typeof respJson.output_text === "string") return respJson.output_text;
  const out = respJson.output;
  if (!Array.isArray(out)) return "";
  const texts = [];
  for (const item of out) {
    if (!item || item.type !== "message") continue;
    const content = item.content;
    if (!Array.isArray(content)) continue;
    for (const c of content) {
      if (c && c.type === "output_text" && typeof c.text === "string") texts.push(c.text);
    }
  }
  return texts.join("\n").trim();
}
function parseJsonLoose(text){
  if (typeof text !== "string") return null;
  const t = text.trim(); if (!t) return null;
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const body = fence ? fence[1].trim() : t;
  try{ return JSON.parse(body); }catch{
    const i = body.indexOf("{"), j = body.lastIndexOf("}");
    if (i>=0 && j>i) { try{ return JSON.parse(body.slice(i,j+1)); }catch{} }
    return null;
  }
}
async function callOpenAIResponses({ apiKey, model, maxOutputTokens=900, temperature=0.2, prompt, schemaName, schema }){
  const key = apiKey || OPENAI_API_KEY;
  if (!key) { const err = new Error("OPENAI_API_KEY is missing on the server"); err.status = 503; throw err; }
  const endpoint = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1/responses").trim();

  const body = {
    model: model || OPENAI_MODEL_DEFAULT,
    store: false,
    temperature,
    max_output_tokens: maxOutputTokens,
    input: [{ role: "user", content: String(prompt || "") }]
  };
  if (schema) {
    body.text = { format: { type: "json_schema", name: schemaName || "structured_output", strict: true, schema } };
  }

  const controller = new AbortController();
  const to = setTimeout(() => controller.abort(), OPENAI_TIMEOUT_MS);
  let r;
  try {
    r = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      signal: controller.signal
    });
  } catch (e) {
    const err = new Error(e && e.name === "AbortError"
      ? `OpenAI request timed out after ${OPENAI_TIMEOUT_MS}ms`
      : "OpenAI request failed (network/transport)");
    err.status = e && e.name === "AbortError" ? 504 : 502;
    err.cause = e;
    throw err;
  } finally { clearTimeout(to); }

  let json; try { json = await r.json(); } catch(e){ const err = new Error("OpenAI response was not valid JSON"); err.status=502; err.cause=e; throw err; }
  if (!r.ok) { const err = new Error("OpenAI error"); err.status = r.status; err.details = json; throw err; }
  return json;
}

/* Templates */
function resolveTemplatePath(filename){
  const base = process.env.TEMPLATE_DIR ? path.resolve(process.env.TEMPLATE_DIR) : path.resolve(__dirname);
  return path.join(base, filename);
}
function readTemplate(filename){
  const p = resolveTemplatePath(filename);
  assert(fs.existsSync(p), `Template not found: ${filename} at ${p}`);
  return fs.readFileSync(p, "utf8");
}
let TPL_INDEX="", TPL_STYLE="", TPL_GAME="";
function loadTemplates(){ TPL_INDEX=readTemplate("index.template.html"); TPL_STYLE=readTemplate("style.template.css"); TPL_GAME=readTemplate("game.template.js"); }
loadTemplates();

/* Schemas */
const PLAN_SCHEMA = {
  type: "object", additionalProperties: false,
  properties: {
    title:{type:"string"}, genre:{type:"string"}, oneLiner:{type:"string"}, coreLoop:{type:"string"},
    entities:{type:"array", items:{type:"string"}},
    controls:{ type:"object", additionalProperties:false, properties:{ chat:{type:"string"}, gifts:{type:"string"}, likes:{type:"string"}, joins:{type:"string"} }, required:["chat","gifts","likes","joins"] },
    ui:{ type:"object", additionalProperties:false, properties:{ theme:{type:"string"}, hud:{type:"string"}, feedback:{type:"string"} }, required:["theme","hud","feedback"] },
    safety:{ type:"object", additionalProperties:false, properties:{ noExternalSecrets:{type:"boolean"}, noProtoBundle:{type:"boolean"}, notes:{type:"string"} }, required:["noExternalSecrets","noProtoBundle","notes"] }
  },
  required:["title","genre","oneLiner","coreLoop","entities","controls","ui","safety"]
};
const FILE_PACKAGE_SCHEMA = {
  type:"object", additionalProperties:false,
  properties:{ indexHtml:{type:"string"}, styleCss:{type:"string"}, gameJs:{type:"string"} },
  required:["indexHtml","styleCss","gameJs"]
};
const EDIT_SCHEMA = {
  type:"object", additionalProperties:false,
  properties:{ indexHtml:{type:"string"}, styleCss:{type:"string"}, gameJs:{type:"string"}, notes:{type:"string"} },
  required:["indexHtml","styleCss","gameJs","notes"]
};

/* Validation + Fallback rendering */
function normalizePlan(plan){
  assert(plan && typeof plan==="object", "Plan must be an object");
  assert(typeof plan.title==="string" && plan.title.trim(), "Plan.title required");
  assert(typeof plan.coreLoop==="string" && plan.coreLoop.trim(), "Plan.coreLoop required");
  assert(Array.isArray(plan.entities), "Plan.entities must be array");
  return plan;
}
function validatePlan(p){ return normalizePlan(p); }

function applyThemeVars(css, theme){
  const t = theme || {};
  return String(css)
    .replaceAll("__THEME_PRIMARY__", t.primary || "#ff0050")
    .replaceAll("__THEME_SECONDARY__", t.secondary || "#00f2ea")
    .replaceAll("__THEME_BACKGROUND__", t.background || "#050b17");
}
function renderIndex(spec, theme){
  const s = spec || {};
  const howTo = Array.isArray(s.howTo) ? s.howTo : [
    "Type JOIN to enter.",
    "Type FIRE to shoot. Likes charge power; gifts = boost."
  ];
  const li = howTo.map(x=>`<li>${String(x)}</li>`).join("\n");
  return TPL_INDEX
    .replaceAll("{{TITLE}}", String(s.title || "ChatTok Game"))
    .replaceAll("{{ONE_SENTENCE}}", String(s.oneLiner || "Fast TikTok LIVE arcade."))
    .replaceAll("{{SUBTITLE}}", String(s.coreLoop || "Join & fire via chat; likes power, gifts boost."))
    .replaceAll("{{HOW_TO_PLAY_LI}}", li)
    .replaceAll("{{MODE_BADGE}}", "LIVE");
}
function renderStyle(theme){ return applyThemeVars(TPL_STYLE, theme); }
function renderGame(spec){ return TPL_GAME.replace("__SPEC_JSON__", safeJson(spec || {})); }

function sanitizeCss(css){
  let out = String(css||"");
  out = out.replace(/body\s*\{[^}]*body\s*\{/gi, "body {");
  out = out.replace(/:root\s*\{([^}]*)\}:root\s*\{/gi, ":root{$1}");
  const open=(out.match(/\{/g)||[]).length, close=(out.match(/\}/g)||[]).length;
  if(close>open){ let extra=close-open; out = out.replace(/\}$/g, m=> (extra-- > 0 ? "" : m)); }
  return out;
}

/* Strict validator */
const REQUIRED = {
  htmlSelectors: ["#setupOverlay","#startGameBtn","#liveIdInput","#gameRoot","canvas#gameCanvas",".hud"],
  htmlStringsMustContain: ["How to play","Status","Mode","Power Meter"],
  jsStringsMustContain: [
    "function onChatMessage",
    "function setupTikTokClient",
    "client.on(\"chat\"",
    "client.on(\"gift\"",
    "client.on(\"like\"",
    "client.connect()",
    "CHATTOK_CREATOR_TOKEN"
  ],
  cssStringsMustContain: [".overlay-card",".hud",".meter",".pill"],
  jsMustNotContain: ["proto.bundle.js","tailwind","cdn.tailwindcss"]
};
function containsAll(hay, needles){ return needles.every(n => hay.includes(n)); }
function selectorExists(html, sel){
  if (sel.startsWith("#")) return html.includes(`id="${sel.slice(1)}"`) || html.includes(`id='${sel.slice(1)}'`);
  if (sel.startsWith(".")) return html.includes(`class="${sel.slice(1)}`) || html.includes(`class='${sel.slice(1)}`);
  if (sel.includes("#") || sel.includes(".")) return html.includes(sel.replace(/[#.]/g,""));
  return html.includes(`<${sel}`);
}
function validateGeneratedPackage(pkg){
  const html = String(pkg.indexHtml||"");
  const css = String(pkg.styleCss||"");
  const js  = String(pkg.gameJs||"");

  const selOk = REQUIRED.htmlSelectors.every(s => selectorExists(html, s));
  const htmlOk = selOk && containsAll(html, REQUIRED.htmlStringsMustContain);
  const cssOk  = containsAll(css, REQUIRED.cssStringsMustContain);
  const jsOk   = containsAll(js, REQUIRED.jsStringsMustContain) && !REQUIRED.jsMustNotContain.some(x=>js.includes(x));

  return htmlOk && cssOk && jsOk;
}

/* Routes */
app.get("/health", (req,res)=>{
  res.setHeader("Cache-Control","no-store");
  res.json({ ok:true, service:"chattok-builder-api", modelDefault:OPENAI_MODEL_DEFAULT, hasOpenAIKey:Boolean(OPENAI_API_KEY), templatesLoaded:Boolean(TPL_INDEX && TPL_STYLE && TPL_GAME) });
});

app.post("/api/plan", async (req,res)=>{
  res.setHeader("Cache-Control","no-store");
  try{
    const { prompt, theme } = req.body || {};
    assert(typeof prompt === "string" && prompt.trim(), "Missing prompt");

    const planPrompt = `
Generate a concise, actionable plan/spec for a TikTok LIVE HTML5 game.
- 9:16 layout
- Works without TikTok (no blank screen)
- Do not mention or edit tiktok-client.js
Return JSON exactly matching the schema.
`.trim();

    let plan;
    try{
      const resp = await callOpenAIResponses({
        prompt: `${planPrompt}\n\nUser prompt:\n${prompt}\n\nTheme:\n${theme||"none"}`,
        schemaName: "game_plan",
        schema: PLAN_SCHEMA,
        maxOutputTokens: 650,
        temperature: 0.2
      });
      const text = extractAssistantText(resp);
      const parsed = parseJsonLoose(text) || resp.output_parsed || null;
      plan = validatePlan(parsed);
    } catch {
      plan = validatePlan({
        title: "ChatTok Arena",
        genre: "Arcade",
        oneLiner: "Join via chat, fire meteors; likes charge power; gifts boost.",
        coreLoop: "Players join and shoot; team score climbs; meteors chip base HP.",
        entities: ["player","meteor_small","meteor_medium","meteor_large","shot","explosion"],
        controls: { chat:"join/fire", gifts:"power boost", likes:"charge power", joins:"spawn" },
        ui: { theme:"dark neon", hud:"score players likes gifts power", feedback:"flags + pops" },
        safety: { noExternalSecrets:true, noProtoBundle:true, notes:"No external libs" }
      });
    }
    res.json({ ok:true, plan });
  }catch(err){
    res.status(400).json({ ok:false, error: err.message || "Bad request" });
  }
});

app.post("/api/generate", async (req,res)=>{
  res.setHeader("Cache-Control","no-store");
  try{
    const { prompt, plan, theme } = req.body || {};
    assert(typeof prompt === "string" && prompt.trim(), "Missing prompt");
    assert(plan && typeof plan === "object", "Missing plan (object)");

    const guard = `
MANDATORY LAYOUT + SETTINGS:
- index.html includes: #setupOverlay, #startGameBtn, #liveIdInput, #gameRoot, <canvas id="gameCanvas">, bottom .hud with a Power Meter bar.
- style.css includes: .overlay-card, .hud, .meter, .pill.
- game.js includes EXACT strings: "function onChatMessage", "function setupTikTokClient", "client.on(\\"chat\\")", "client.on(\\"gift\\")", "client.on(\\"like\\")", "client.connect()", "CHATTOK_CREATOR_TOKEN".
- Do NOT include proto.bundle.js or Tailwind CDN.
- Return JSON with { indexHtml, styleCss, gameJs } (strings).
`.trim();

    const generationPrompt = `
Generate a complete 3-file HTML5 game (index.html, style.css, game.js) for ChatTokGaming.
- Production-ready, 9:16, immediately playable UI.
- Settings overlay with TikTok LIVE ID input; accept "@username" or "username".
- Robust TikTok parsing; use provided client pattern; do not modify tiktok-client.js.
- Add small WebAudio sound effects for shot/hit/boost/victory/defeat (no external assets).
- No external CDNs or secrets.

User prompt:
${prompt}

Plan/spec:
${safeJson(plan)}

${guard}
`.trim();

    let pkg;
    try{
      const resp = await callOpenAIResponses({
        prompt: generationPrompt,
        schemaName: "file_package",
        schema: FILE_PACKAGE_SCHEMA,
        maxOutputTokens: 2400,
        temperature: 0.25
      });
      const text = extractAssistantText(resp);
      const parsed = parseJsonLoose(text) || resp.output_parsed || null;
      pkg = parsed;
      assert(pkg && typeof pkg==="object", "Invalid package");
      assert(typeof pkg.indexHtml==="string" && pkg.indexHtml.length>10, "indexHtml missing");
      assert(typeof pkg.styleCss==="string" && pkg.styleCss.length>10, "styleCss missing");
      assert(typeof pkg.gameJs==="string" && pkg.gameJs.length>10, "gameJs missing");
      pkg.styleCss = sanitizeCss(pkg.styleCss);
    }catch{
      pkg = null;
    }

    if (!pkg || !validateGeneratedPackage(pkg)) {
      pkg = {
        indexHtml: renderIndex(plan, theme),
        styleCss: renderStyle(theme),
        gameJs: renderGame(plan)
      };
    }

    assert(pkg.indexHtml.includes("<html") || pkg.indexHtml.includes("<!doctype"), "indexHtml invalid");
    assert(pkg.styleCss.includes("{") || pkg.styleCss.includes(":root"), "styleCss invalid");
    assert(pkg.gameJs.includes("function") || pkg.gameJs.includes("const"), "gameJs invalid");

    res.json({ ok:true, files: pkg });
  }catch(err){
    try{
      const { plan, theme } = req.body || {};
      if (plan && typeof plan === "object") {
        const pkg = { indexHtml: renderIndex(plan, theme), styleCss: renderStyle(theme), gameJs: renderGame(plan) };
        return res.status(200).json({ ok:true, files: pkg });
      }
    }catch{}
    res.status(500).json({ ok:false, error: err.message || "Server error" });
  }
});

app.post("/api/edit", async (req,res)=>{
  res.setHeader("Cache-Control","no-store");
  try{
    const { prompt, currentFiles } = req.body || {};
    assert(typeof prompt === "string" && prompt.trim(), "Missing edit prompt");
    assert(currentFiles && typeof currentFiles === "object", "Missing currentFiles");

    const { indexHtml, styleCss, gameJs } = {
      indexHtml: currentFiles["index.html"] || currentFiles.indexHtml,
      styleCss: currentFiles["style.css"] || currentFiles.styleCss,
      gameJs: currentFiles["game.js"] || currentFiles.gameJs
    };
    assert(typeof indexHtml === "string", "currentFiles.indexHtml missing");
    assert(typeof styleCss === "string", "currentFiles.styleCss missing");
    assert(typeof gameJs === "string", "currentFiles.gameJs missing");

    const editPrompt = `
Edit the 3-file HTML5 game for ChatTokGaming.
- Keep settings overlay + TikTok connection intact.
- Do NOT add extra files/CDNs or secrets.
Return JSON with: indexHtml, styleCss, gameJs, notes.
`.trim();

    let parsed;
    try{
      const resp = await callOpenAIResponses({
        prompt: `${editPrompt}\n\nindex.html<<<\n${indexHtml}\n>>>\nstyle.css<<<\n${styleCss}\n>>>\ngame.js<<<\n${gameJs}\n>>>`,
        schemaName: "edit_package",
        schema: EDIT_SCHEMA,
        maxOutputTokens: 2400,
        temperature: 0.2
      });
      const text = extractAssistantText(resp);
      parsed = parseJsonLoose(text) || resp.output_parsed || null;
      assert(parsed && typeof parsed === "object", "Edit response invalid");
      parsed.styleCss = sanitizeCss(parsed.styleCss || "");
      if (!validateGeneratedPackage(parsed)) {
        parsed = { indexHtml, styleCss: sanitizeCss(styleCss), gameJs, notes: "Rejected AI edit (missing required IDs or blocked libs). No-op applied." };
      }
    }catch{
      parsed = { indexHtml, styleCss: sanitizeCss(styleCss), gameJs, notes: "No changes (edit AI failed)." };
    }
    res.json({ ok:true, files: parsed });
  }catch(err){
    res.status(400).json({ ok:false, error: err.message || "Bad request" });
  }
});

/* Listen (one) */
const PORT = process.env.PORT || 3000;
app.listen(PORT, ()=> {
  console.log(`ChatTok Builder API listening on :${PORT}`);
  console.log(`CORS allowedOrigins: ${allowedOrigins.join(", ") || "(dev default: allow all)"}`);
});
