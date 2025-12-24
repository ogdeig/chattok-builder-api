/**
 * ChatTok Builder API (Render)
 * One listen(); strict validation + fallbacks; never references proto/Tailwind.
 */

const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
require("dotenv").config();

const app = express();
app.use(express.json({ limit: "1mb" }));

/* CORS */
const allowedOrigins = (process.env.ALLOWED_ORIGINS || "https://ogdeig.github.io,http://localhost:3000,http://localhost:5173").split(",").map(s=>s.trim()).filter(Boolean);
app.use(cors({
  origin(origin, cb){ if(!origin) return cb(null,true); return allowedOrigins.includes(origin) ? cb(null,true) : cb(new Error("CORS blocked: "+origin)); },
  methods:["GET","POST","OPTIONS"],
  allowedHeaders:["Content-Type","Authorization"],
  optionsSuccessStatus:204
}));
app.options("*", cors());

/* Config */
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL_DEFAULT = process.env.OPENAI_MODEL || "gpt-4o-mini";
const OPENAI_TIMEOUT_MS = parseInt(process.env.OPENAI_TIMEOUT_MS || "35000", 10);

/* Utils */
const assert = (c,m)=>{ if(!c) throw new Error(m||"Assertion"); };
const safeJson = (o)=>{ try{return JSON.stringify(o);}catch{return "{}";} };

/* OpenAI (Responses API) */
async function callOpenAIResponses({ prompt, model=OPENAI_MODEL_DEFAULT, schemaName, schema, temperature=0.2, maxOutputTokens=1200 }){
  if(!OPENAI_API_KEY){ const e=new Error("OPENAI_API_KEY missing"); e.status=503; throw e; }
  const body = { model, store:false, temperature, max_output_tokens:maxOutputTokens, input:[{role:"user",content:String(prompt||"")}] };
  if(schema){ body.text = { format:{ type:"json_schema", name:schemaName||"structured", strict:true, schema } }; }

  const controller = new AbortController(); const to = setTimeout(()=>controller.abort(), OPENAI_TIMEOUT_MS);
  let r, json;
  try{
    r = await fetch((process.env.OPENAI_BASE_URL||"https://api.openai.com/v1/responses"), {
      method:"POST", headers:{ "Content-Type":"application/json", Authorization:`Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify(body), signal: controller.signal
    });
    json = await r.json();
  }catch(err){
    const e=new Error(err?.name==="AbortError" ? `OpenAI request timed out after ${OPENAI_TIMEOUT_MS}ms` : "OpenAI request failed"); e.status=504; e.cause=err; throw e;
  }finally{ clearTimeout(to); }
  if(!r.ok){ const e=new Error("OpenAI error"); e.status=r.status; e.details=json; throw e; }
  return json;
}
const extractAssistantText = (resp)=>{
  if(!resp) return "";
  if(typeof resp.output_text==="string") return resp.output_text;
  const out = resp.output; if(!Array.isArray(out)) return "";
  const buf=[];
  for(const it of out){ if(it?.type!=="message") continue; for(const c of (it.content||[])){ if(c?.type==="output_text" && typeof c.text==="string") buf.push(c.text); } }
  return buf.join("\n").trim();
};
const parseJsonLoose = (t)=>{
  if(typeof t!=="string") return null;
  const m=t.match(/```(?:json)?\s*([\s\S]*?)\s*```/i); const s=(m?m[1]:t).trim();
  try{ return JSON.parse(s); }catch{ const i=s.indexOf("{"), j=s.lastIndexOf("}"); if(i>=0&&j>i){ try{return JSON.parse(s.slice(i,j+1));}catch{} } }
  return null;
};

/* Templates */
function readTemplate(name){ const p = path.join(__dirname, name); assert(fs.existsSync(p), `Template not found: ${name}`); return fs.readFileSync(p,"utf8"); }
let TPL_INDEX=readTemplate("index.template.html");
let TPL_STYLE=readTemplate("style.template.css");
let TPL_GAME =readTemplate("game.template.js");

const PLAN_SCHEMA = {
  type:"object", additionalProperties:false,
  properties:{
    title:{type:"string"}, genre:{type:"string"}, oneLiner:{type:"string"}, coreLoop:{type:"string"},
    entities:{type:"array", items:{type:"string"}},
    controls:{type:"object", additionalProperties:false, properties:{chat:{type:"string"},gifts:{type:"string"},likes:{type:"string"},joins:{type:"string"}}, required:["chat","gifts","likes","joins"]},
    ui:{type:"object", additionalProperties:false, properties:{theme:{type:"string"},hud:{type:"string"},feedback:{type:"string"}}, required:["theme","hud","feedback"]},
    safety:{type:"object", additionalProperties:false, properties:{noExternalSecrets:{type:"boolean"}, noProtoBundle:{type:"boolean"}, notes:{type:"string"}}, required:["noExternalSecrets","noProtoBundle","notes"]}
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

const sanitizeCss = (css)=>{
  let out=String(css||"");
  out=out.replace(/body\s*\{[^}]*body\s*\{/gi,"body {");
  out=out.replace(/:root\s*\{([^}]*)\}:root\s*\{/gi,":root{$1}");
  const open=(out.match(/\{/g)||[]).length, close=(out.match(/\}/g)||[]).length;
  if(close>open){ let extra=close-open; out=out.replace(/\}$/g,(m)=> (extra-->0?"":m)); }
  return out;
};
const applyTheme = (css, theme={})=> String(css)
 .replaceAll("__THEME_PRIMARY__", theme.primary||"#ff0050")
 .replaceAll("__THEME_SECONDARY__", theme.secondary||"#00f2ea")
 .replaceAll("__THEME_BACKGROUND__", theme.background||"#050b17");
const renderIndex = (spec={}, theme)=> TPL_INDEX
  .replaceAll("{{TITLE}}", String(spec.title||"ChatTok Game"))
  .replaceAll("{{ONE_SENTENCE}}", String(spec.oneLiner||"Fast TikTok LIVE arcade."))
  .replaceAll("{{SUBTITLE}}", String(spec.coreLoop||"Join & fire via chat; likes power, gifts boost."))
  .replaceAll("{{HOW_TO_PLAY_LI}}", (Array.isArray(spec.howTo)?spec.howTo:["Type JOIN to enter.","Type FIRE to shoot. Likes charge power; gifts = boost."]).map(x=>`<li>${String(x)}</li>`).join("\n"))
  .replaceAll("{{MODE_BADGE}}","LIVE");
const renderStyle = (theme)=> applyTheme(TPL_STYLE, theme);
const renderGame  = (spec)=> TPL_GAME.replace("__SPEC_JSON__", safeJson(spec||{}));

/* Guards */
const REQUIRED = {
  htmlSel: ["#setupOverlay","#startGameBtn","#liveIdInput","#gameRoot","canvas#gameCanvas",".hud","#startOfflineBtn"],
  htmlMust: ["How to play","Status","Mode","Power Meter"],
  cssMust:  [".overlay-card",".hud",".meter",".pill"],
  jsMust:   ["function onChatMessage","function setupTikTokClient","client.on(\"chat\"","client.on(\"gift\"","client.on(\"like\"","client.connect()","CHATTOK_CREATOR_TOKEN","stripAt","waitForTikTokClient"],
  jsBlock:  ["proto.bundle.js","cdn.tailwindcss","tailwind"]
};
const containsAll = (s,words)=> words.every(w=>s.includes(w));
const hasSel = (html,sel)=>{
  if(sel.startsWith("#")) return html.includes(`id="${sel.slice(1)}"`)||html.includes(`id='${sel.slice(1)}'`);
  if(sel.startsWith(".")) return html.includes(`class="${sel.slice(1)}`)||html.includes(`class='${sel.slice(1)}`);
  return html.includes(sel.replace(/[.#]/g,""));
};
function validPackage(pkg){
  const h=String(pkg.indexHtml||""), c=String(pkg.styleCss||""), j=String(pkg.gameJs||"");
  return REQUIRED.htmlSel.every(s=>hasSel(h,s))
    && containsAll(h, REQUIRED.htmlMust)
    && containsAll(c, REQUIRED.cssMust)
    && containsAll(j, REQUIRED.jsMust)
    && !REQUIRED.jsBlock.some(x=>j.includes(x));
}

/* Routes */
app.get("/health",(req,res)=>{ res.setHeader("Cache-Control","no-store"); res.json({ ok:true, modelDefault:OPENAI_MODEL_DEFAULT, hasKey:!!OPENAI_API_KEY, templates:true }); });

app.post("/api/plan", async (req,res)=>{
  res.setHeader("Cache-Control","no-store");
  try{
    const { prompt } = req.body||{};
    assert(typeof prompt==="string" && prompt.trim(), "Missing prompt");
    const p = `
Generate a concise plan/spec for a TikTok LIVE HTML5 game. 9:16 layout, playable without TikTok.
Return JSON matching the schema. Do NOT mention proto/tailwind or editing tiktok-client.js.
`.trim();
    let plan;
    try{
      const r = await callOpenAIResponses({ prompt: `${p}\n\nUser:\n${prompt}`, schema: PLAN_SCHEMA, schemaName: "game_plan", maxOutputTokens: 650 });
      const parsed = parseJsonLoose(extractAssistantText(r)) || r.output_parsed;
      assert(parsed, "No plan"); plan = parsed;
    }catch{ plan = { title:"ChatTok Arena", genre:"Arcade", oneLiner:"Join & fire; likes power; gifts boost.", coreLoop:"Players join and shoot; team score rises.", entities:["player","meteor_small","meteor_large","shot"], controls:{chat:"join/fire",gifts:"power boost",likes:"charge power",joins:"spawn"}, ui:{theme:"dark",hud:"score players likes gifts power",feedback:"flags+pops"}, safety:{noExternalSecrets:true,noProtoBundle:true,notes:"No CDNs"} }; }
    res.json({ ok:true, plan });
  }catch(e){ res.status(400).json({ ok:false, error:e.message||"Bad request" }); }
});

app.post("/api/generate", async (req,res)=>{
  res.setHeader("Cache-Control","no-store");
  try{
    const { prompt, plan, theme } = req.body||{};
    assert(typeof prompt==="string" && prompt.trim(), "Missing prompt");
    assert(plan && typeof plan==="object", "Missing plan (object)");

    const guard = `
MANDATORY:
- index.html has #setupOverlay, #startGameBtn, #startOfflineBtn, #liveIdInput, #gameRoot, <canvas id="gameCanvas">, and .hud with Power Meter.
- style.css includes selectors: .overlay-card, .hud, .meter, .pill.
- game.js must include: "function onChatMessage","function setupTikTokClient","client.on(\\"chat\\")","client.on(\\"gift\\")","client.on(\\"like\\")","client.connect()","CHATTOK_CREATOR_TOKEN","stripAt","waitForTikTokClient".
- Never reference proto.bundle.js or Tailwind CDN.
Return JSON: { indexHtml, styleCss, gameJs }.
`.trim();

    const gp = `
Generate a polished 3-file HTML5 TikTok LIVE game (index.html, style.css, game.js):
- Settings overlay + input accepts "@user" or "user".
- Wait for injected TikTok client on Start (poll up to 12s).
- Immediate visuals + WebAudio SFX (no external assets).
- No external CDNs. No proto loads. 9:16 layout. HUD: score/players/likes/gifts/power/time/HP.

User idea:
${prompt}

Plan:
${safeJson(plan)}

${guard}
`.trim();

    let pkg;
    try{
      const r = await callOpenAIResponses({ prompt: gp, schema: FILE_PACKAGE_SCHEMA, schemaName:"file_package", temperature:0.25, maxOutputTokens:2400 });
      const parsed = parseJsonLoose(extractAssistantText(r)) || r.output_parsed;
      assert(parsed, "Invalid package");
      parsed.styleCss = sanitizeCss(parsed.styleCss||"");
      pkg = parsed;
    }catch{ pkg = null; }

    if(!pkg || !validPackage(pkg)){
      pkg = { indexHtml: renderIndex(plan, theme), styleCss: renderStyle(theme), gameJs: renderGame(plan) };
    }

    res.json({ ok:true, files: pkg });
  }catch(e){
    try{
      const { plan, theme } = req.body||{};
      if(plan && typeof plan==="object"){
        return res.status(200).json({ ok:true, files:{ indexHtml: renderIndex(plan, theme), styleCss: renderStyle(theme), gameJs: renderGame(plan) } });
      }
    }catch{}
    res.status(500).json({ ok:false, error:e.message||"Server error" });
  }
});

app.post("/api/edit", async (req,res)=>{
  res.setHeader("Cache-Control","no-store");
  try{
    const { prompt, currentFiles } = req.body||{};
    assert(typeof prompt==="string" && prompt.trim(), "Missing edit prompt");
    assert(currentFiles && typeof currentFiles==="object", "Missing currentFiles");

    const indexHtml = currentFiles["index.html"] || currentFiles.indexHtml || "";
    const styleCss  = currentFiles["style.css"] || currentFiles.styleCss || "";
    const gameJs    = currentFiles["game.js"]   || currentFiles.gameJs   || "";
    assert(indexHtml && styleCss && gameJs, "currentFiles incomplete");

    const ep = `
Edit the 3-file game. Keep required IDs and TikTok contract; do not add CDNs or proto.
Return JSON { indexHtml, styleCss, gameJs, notes }.
`.trim();

    let out;
    try{
      const r = await callOpenAIResponses({ prompt:`${ep}\n\nindex.html<<<\n${indexHtml}\n>>>\nstyle.css<<<\n${styleCss}\n>>>\ngame.js<<<\n${gameJs}\n>>>`, schema: EDIT_SCHEMA, schemaName:"edit_package", maxOutputTokens:2400, temperature:0.2 });
      const parsed = parseJsonLoose(extractAssistantText(r)) || r.output_parsed; assert(parsed, "Edit invalid");
      parsed.styleCss = sanitizeCss(parsed.styleCss||"");
      out = validPackage(parsed) ? parsed : { indexHtml, styleCss: sanitizeCss(styleCss), gameJs, notes:"Rejected edit (missing required IDs)" };
    }catch{ out = { indexHtml, styleCss: sanitizeCss(styleCss), gameJs, notes:"No changes" }; }

    res.json({ ok:true, files: out });
  }catch(e){ res.status(400).json({ ok:false, error:e.message||"Bad request" }); }
});

/* Listen */
const PORT = process.env.PORT || 3000;
app.listen(PORT, ()=> console.log(`ChatTok Builder API listening on :${PORT} (CORS: ${allowedOrigins.join(",")})`));
