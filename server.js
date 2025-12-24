/**
 * ChatTok Builder API — multi-template, strict contracts, single listen.
 * Endpoints: /health, /api/plan, /api/generate, /api/edit
 * Fallbacks guarantee working first shot; never loads proto/tailwind.
 */

const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

const app = express();
app.use(express.json({ limit: "1mb" }));

/* CORS for GitHub Pages + local dev */
const allowedOrigins = (process.env.ALLOWED_ORIGINS ||
  "https://ogdeig.github.io,http://localhost:3000,http://localhost:5173").split(",").map(s=>s.trim());
app.use(cors({
  origin(origin, cb){ if(!origin) return cb(null, true); return allowedOrigins.includes(origin) ? cb(null, true) : cb(new Error("CORS blocked: "+origin)); },
  methods:["GET","POST","OPTIONS"],
  allowedHeaders:["Content-Type","Authorization"],
  optionsSuccessStatus:204
}));
app.options("*", cors());

/* OpenAI config (Responses API) */
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL   = process.env.OPENAI_MODEL   || "gpt-4o-mini";
const OPENAI_TIMEOUT = parseInt(process.env.OPENAI_TIMEOUT_MS || "35000", 10);

async function callOpenAIResponses({ prompt, schema, schemaName, temperature=0.2, maxOutputTokens=1200 }){
  if (!OPENAI_API_KEY) { const e=new Error("OPENAI_API_KEY missing"); e.status=503; throw e; }

  const body = {
    model: OPENAI_MODEL, store: false, temperature, max_output_tokens: maxOutputTokens,
    input: [{ role: "user", content: String(prompt || "") }]
  };
  if (schema) body.text = { format: { type: "json_schema", name: schemaName || "structured", strict: true, schema } };

  const controller = new AbortController();
  const to = setTimeout(()=>controller.abort(), OPENAI_TIMEOUT);
  let res, json;
  try{
    res = await fetch((process.env.OPENAI_BASE_URL || "https://api.openai.com/v1/responses"), {
      method:"POST",
      headers:{ "Content-Type":"application/json", Authorization:`Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    json = await res.json();
  }catch(err){
    const e = new Error(err?.name==="AbortError" ? `OpenAI request timed out after ${OPENAI_TIMEOUT}ms` : "OpenAI request failed");
    e.status = 504; e.cause = err; throw e;
  }finally{ clearTimeout(to); }
  if (!res.ok) { const e=new Error("OpenAI error"); e.status=res.status; e.details=json; throw e; }
  return json;
}
const extractAssistantText = (resp)=>{
  if (!resp) return "";
  if (typeof resp.output_text === "string") return resp.output_text;
  const out = resp.output; if (!Array.isArray(out)) return "";
  const buf=[]; for (const it of out) { if (it?.type!=="message") continue; for (const c of (it.content||[])) if (c?.type==="output_text") buf.push(c.text||""); }
  return buf.join("\n").trim();
};
const parseJsonLoose = (t)=>{
  if (typeof t!=="string") return null;
  const m=t.match(/```(?:json)?\s*([\s\S]*?)\s*```/i); const s=(m?m[1]:t).trim();
  try{ return JSON.parse(s); }catch{ const i=s.indexOf("{"), j=s.lastIndexOf("}"); if(i>=0 && j>i){ try{ return JSON.parse(s.slice(i,j+1)); }catch{} } }
  return null;
};

/* Templates */
function readTpl(name){ const p=path.join(__dirname, name); if(!fs.existsSync(p)) throw new Error(`Template missing: ${name}`); return fs.readFileSync(p,"utf8"); }
let TPL_INDEX = readTpl("index.template.html");
let TPL_STYLE = readTpl("style.template.css");
let TPL_GAME  = readTpl("game.template.js");

const PLAN_SCHEMA = {
  type:"object", additionalProperties:false,
  properties:{
    title:{type:"string"}, oneLiner:{type:"string"}, coreLoop:{type:"string"},
    archetype:{type:"string", enum:["defense","quiz","gridfire","runner"]},
    howTo:{type:"array", items:{type:"string"}},
    commands:{ type:"object", additionalProperties:false, properties:{
      join:{type:"string"}, action:{type:"string"}, answerKeys:{type:"array", items:{type:"string"}}
    }},
    ui:{type:"object", additionalProperties:true, properties:{ theme:{type:"string"} }},
    safety:{type:"object", additionalProperties:true}
  },
  required:["title","oneLiner","coreLoop","archetype"]
};
const FILES_SCHEMA = {
  type:"object", additionalProperties:false,
  properties:{ indexHtml:{type:"string"}, styleCss:{type:"string"}, gameJs:{type:"string"} },
  required:["indexHtml","styleCss","gameJs"]
};
const EDIT_SCHEMA = {
  type:"object", additionalProperties:false,
  properties:{ indexHtml:{type:"string"}, styleCss:{type:"string"}, gameJs:{type:"string"}, notes:{type:"string"} },
  required:["indexHtml","styleCss","gameJs","notes"]
};

const sanitizeCss = (css)=>{
  let out = String(css||"");
  out = out.replace(/body\s*\{[^}]*body\s*\{/gi,"body {");
  out = out.replace(/:root\s*\{([^}]*)\}:root\s*\{/gi,":root{$1}");
  const open=(out.match(/\{/g)||[]).length, close=(out.match(/\}/g)||[]).length;
  if (close>open){ let extra=close-open; out = out.replace(/\}$/g, m => (extra-- > 0 ? "" : m)); }
  return out;
};
const themeApply = (css, theme={}) => String(css)
  .replaceAll("__THEME_PRIMARY__", theme.primary||"#ff0050")
  .replaceAll("__THEME_SECONDARY__", theme.secondary||"#00f2ea")
  .replaceAll("__THEME_BACKGROUND__", theme.background||"#050b17");
const renderIndex = (spec, theme)=>{
  const li = (spec?.howTo && spec.howTo.length ? spec.howTo : [
    "Type JOIN to enter.",
    "Use FIRE to act (or A/B/C/D for quiz; A1–J10 for gridfire).",
    "Likes charge the Power Meter; gifts = boost."
  ]).map(x=>`<li>${String(x)}</li>`).join("\n");
  return TPL_INDEX
    .replaceAll("{{TITLE}}", String(spec?.title||"ChatTok Game"))
    .replaceAll("{{ONE_SENTENCE}}", String(spec?.oneLiner||"Fast TikTok LIVE arcade."))
    .replaceAll("{{SUBTITLE}}", String(spec?.coreLoop||"Join & act via chat; likes power; gifts boost."))
    .replaceAll("{{HOW_TO_PLAY_LI}}", li)
    .replaceAll("{{MODE_BADGE}}", (spec?.archetype||"LIVE").toUpperCase());
};
const renderStyle = (theme)=> themeApply(TPL_STYLE, theme);
const renderGame  = (spec)=> TPL_GAME.replace("__SPEC_JSON__", JSON.stringify(spec||{}));

/* Guards */
const REQUIRED = {
  sel: ["#setupOverlay","#startGameBtn","#startOfflineBtn","#liveIdInput","#gameRoot","canvas#gameCanvas",".hud"],
  htmlMust: ["How to play","Status","Mode","Power Meter"],
  cssMust:  [".overlay-card",".hud",".meter",".pill"],
  jsMust:   [
    "function onChatMessage","function setupTikTokClient",
    "client.on(\"chat\"", "client.on(\"gift\"", "client.on(\"like\"", "client.connect()",
    "CHATTOK_CREATOR_TOKEN", "stripAt", "waitForTikTokClient"
  ],
  jsBlock:  ["proto.bundle.js","cdn.tailwindcss","tailwindcss.com"]
};
const includesAll=(s,a)=>a.every(x=>s.includes(x));
const hasSel=(html,sel)=>{
  if (sel.startsWith("#")) return html.includes(`id="${sel.slice(1)}"`) || html.includes(`id='${sel.slice(1)}'`);
  if (sel.startsWith(".")) return html.includes(`class="${sel.slice(1)}`) || html.includes(`class='${sel.slice(1)}`);
  return html.includes(sel.replace(/[.#]/g,""));
};
function validPkg(pkg){
  const h=String(pkg.indexHtml||""), c=String(pkg.styleCss||""), j=String(pkg.gameJs||"");
  return REQUIRED.sel.every(s=>hasSel(h,s)) && includesAll(h, REQUIRED.htmlMust) &&
         includesAll(c, REQUIRED.cssMust) && includesAll(j, REQUIRED.jsMust) &&
         !REQUIRED.jsBlock.some(x=>j.includes(x));
}

/* Health */
app.get("/health", (req,res)=>{ res.setHeader("Cache-Control","no-store"); res.json({ ok:true, model:OPENAI_MODEL, hasKey:!!OPENAI_API_KEY }); });

/* Plan: inject archetype from templateId */
app.post("/api/plan", async (req,res)=>{
  res.setHeader("Cache-Control","no-store");
  try{
    const { prompt, templateId } = req.body || {};
    if (typeof prompt !== "string" || !prompt.trim()) throw new Error("Missing prompt");
    const archetype = (String(templateId||"defense").toLowerCase().match(/defense|quiz|gridfire|runner/)||["defense"])[0];

    const specSeed = {
      title: "ChatTok Game",
      oneLiner: "Viewers join from chat; act with commands; likes power; gifts boost.",
      coreLoop: "Join + act each round; team score climbs; avoid defeat by the timer/base HP.",
      archetype,
      howTo: [],
      commands: { join:"join", action: archetype==="quiz" ? "answer" : "fire", answerKeys:["a","b","c","d"] },
      ui: { theme:"dark neon" },
      safety: { noExternalSecrets:true, noProtoBundle:true }
    };

    let plan = specSeed;
    try {
      const promptText = `
Create a concise JSON plan for a TikTok LIVE HTML5 game archetype "${archetype}".
Include: title, oneLiner, coreLoop, howTo (array of 3-6 lines), commands (join/action; quiz answerKeys when quiz).
NEVER reference proto or Tailwind. JSON only.
User idea:
${prompt}
      `.trim();
      const resp = await callOpenAIResponses({ prompt: promptText, schema: PLAN_SCHEMA, schemaName: "plan", maxOutputTokens: 650 });
      const parsed = parseJsonLoose(extractAssistantText(resp)) || resp.output_parsed;
      if (parsed) plan = parsed;
      plan.archetype = archetype;
    } catch {
      plan = specSeed;
    }

    res.json({ ok:true, plan });
  }catch(e){ res.status(400).json({ ok:false, error: e.message || "Bad request" }); }
});

/* Generate */
app.post("/api/generate", async (req,res)=>{
  res.setHeader("Cache-Control","no-store");
  try{
    const { prompt, plan, theme } = req.body || {};
    if (typeof prompt !== "string" || !prompt.trim()) throw new Error("Missing prompt");
    if (!plan || typeof plan !== "object") throw new Error("Missing plan (object)");

    const guard = `
Return JSON { indexHtml, styleCss, gameJs } ONLY.
Must include: #setupOverlay, #startGameBtn, #startOfflineBtn, #liveIdInput, #gameRoot, <canvas id="gameCanvas">, and .hud with Power Meter.
game.js must contain the TikTok connection functions and never reference proto.bundle.js or Tailwind.
`.trim();

    let pkg = null;
    try{
      const gp = `
Generate production-ready files for archetype "${plan.archetype}":
- index.html (9:16, overlay + LIVE ID input, Start + Try Without TikTok).
- style.css (no CDNs).
- game.js: uses provided TikTok pattern; accept "@user" or "user"; robust chat mapping; WebAudio SFX.
User idea:
${prompt}

Plan:
${JSON.stringify(plan)}

${guard}
      `.trim();
      const r = await callOpenAIResponses({ prompt: gp, schema: FILES_SCHEMA, schemaName: "files", temperature: 0.25, maxOutputTokens: 2400 });
      const parsed = parseJsonLoose(extractAssistantText(r)) || r.output_parsed;
      if (parsed) {
        parsed.styleCss = sanitizeCss(parsed.styleCss||"");
        if (validPkg(parsed)) pkg = parsed;
      }
    }catch{ pkg = null; }

    if (!pkg) {
      const injected = { ...plan, title: plan.title || "ChatTok Game" };
      pkg = {
        indexHtml: renderIndex(injected, theme),
        styleCss: renderStyle(theme),
        gameJs: renderGame(injected)
      };
    }
    res.json({ ok:true, files: pkg });
  }catch(e){
    try{
      const { plan, theme } = req.body || {};
      if (plan) return res.status(200).json({ ok:true, files:{ indexHtml: renderIndex(plan, theme), styleCss: renderStyle(theme), gameJs: renderGame(plan) } });
    }catch{}
    res.status(500).json({ ok:false, error: e.message || "Server error" });
  }
});

/* Edit (guarded) */
app.post("/api/edit", async (req,res)=>{
  res.setHeader("Cache-Control","no-store");
  try{
    const { prompt, currentFiles } = req.body || {};
    if (typeof prompt !== "string" || !prompt.trim()) throw new Error("Missing edit prompt");
    if (!currentFiles || typeof currentFiles !== "object") throw new Error("Missing currentFiles");

    const indexHtml = currentFiles["index.html"] || currentFiles.indexHtml || "";
    const styleCss  = currentFiles["style.css"] || currentFiles.styleCss || "";
    const gameJs    = currentFiles["game.js"]   || currentFiles.gameJs   || "";
    if (!indexHtml || !styleCss || !gameJs) throw new Error("currentFiles incomplete");

    const ep = `
Edit the files as requested but keep all required IDs and TikTok contract intact.
No external CDNs, no proto. JSON {indexHtml,styleCss,gameJs,notes}.
`.trim();

    let out;
    try{
      const r = await callOpenAIResponses({ prompt:`${ep}\n\nindex.html<<<\n${indexHtml}\n>>>\nstyle.css<<<\n${styleCss}\n>>>\ngame.js<<<\n${gameJs}\n>>>`, schema: EDIT_SCHEMA, schemaName:"edit", maxOutputTokens:2400, temperature:0.2 });
      const parsed = parseJsonLoose(extractAssistantText(r)) || r.output_parsed;
      if (parsed) {
        parsed.styleCss = sanitizeCss(parsed.styleCss||"");
        out = validPkg(parsed) ? parsed : { indexHtml, styleCss: sanitizeCss(styleCss), gameJs, notes: "Rejected edit (contract violation)" };
      } else out = { indexHtml, styleCss: sanitizeCss(styleCss), gameJs, notes:"No changes" };
    }catch{
      out = { indexHtml, styleCss: sanitizeCss(styleCss), gameJs, notes:"No changes" };
    }
    res.json({ ok:true, files: out });
  }catch(e){ res.status(400).json({ ok:false, error: e.message || "Bad request" }); }
});

/* Listen once */
const PORT = process.env.PORT || 3000;
app.listen(PORT, ()=> console.log(`ChatTok Builder API listening on :${PORT}`));
