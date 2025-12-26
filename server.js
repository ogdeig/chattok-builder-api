import express from "express";
import cors from "cors";
import crypto from "crypto";
import OpenAI from "openai";

/* =========================================================
   IMPORTANT FIX:
   Must call express() to create an app instance.
   If you accidentally do `const app = express;` you'll get:
   TypeError: app.use is not a function
   ========================================================= */
const app = express();

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
    ui: { orientation: "9:16", screens: ["settings", "game"] },
    settings: [
      { id: "offlineToggle", type: "checkbox", label: "Offline/Test Mode", default: false },
      { id: "sfxToggle", type: "checkbox", label: "Sound FX", default: true },
      { id: "volume", type: "range", label: "Volume", min: 0, max: 100, default: 60 },
    ],
    chat: { mapping: [{ event: "chat", rule: "data.content triggers gameplay actions" }] },
    host: { controls: ["Start", "Pause", "Reset/Quit"] },
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

  out = out.replace(/<script[^>]+src=["'][^"']*(google-protobuf|google-protobuf\.js)[^"']*["'][^>]*>\s*<\/script>\s*/gi, "");
  out = out.replace(/<script[^>]+src=["']generic\.js["'][^>]*>\s*<\/script>\s*/gi, "");
  out = out.replace(/<script[^>]+src=["']unknownobjects\.js["'][^>]*>\s*<\/script>\s*/gi, "");
  out = out.replace(/<script[^>]+src=["']data_linkmic_messages\.js["'][^>]*>\s*<\/script>\s*/gi, "");
  out = out.replace(/<script[^>]+src=["']tiktok-client\.js["'][^>]*>\s*<\/script>\s*/gi, "");
  out = out.replace(/<script[^>]+src=["']game\.js["'][^>]*>\s*<\/script>\s*/gi, "");

  if (out.includes("</body>")) out = out.replace("</body>", `\n${REQUIRED_SCRIPT_BLOCK}\n</body>`);
  else out += `\n${REQUIRED_SCRIPT_BLOCK}\n`;

  return out;
}

function ensureCssAndTitle(html) {
  let out = String(html || "");
  if (!/href=["']style\.css["']/.test(out)) out = out.replace(/<\/head>/i, `  <link rel="stylesheet" href="style.css" />\n</head>`);
  if (!/<title>/.test(out)) out = out.replace(/<\/head>/i, `  <title>ChatTok Game</title>\n</head>`);
  return out;
}

/* ===============================
   8. TIKTOK CONNECTION EXAMPLE (DO NOT REMOVE)
   =============================== */

const TIKTOK_CONNECTION_EXAMPLE = `8. TIKTOK CONNECTION EXAMPLE (DO NOT REMOVE)

Here is an example of code to connect to the server, see TikTok messages, and map chat into gameplay. You can adapt this pattern for new games, but keep the structure and error handling style:

// 7. TikTok message handling
// ===============================

function handleTeamJoin(text, user) {
    const maybeTeam = normalizeTeamText(text);
    if (!maybeTeam) return;

    // Assign or move team.
    userTeams.set(user.userId, maybeTeam);
    console.log(\`\${user.nickname} joined team \${maybeTeam}\`);
}

function handleAnswer(text, user) {
    if (!gameStarted || gameFinished) return;
    if (!userTeams.has(user.userId)) return; // must be on a team first

    const answer = normalizeAnswerText(text);
    if (!answer) return;

    // Only allow one answer per question per user
    if (answeredUsersThisQuestion.has(user.userId)) return;
    answeredUsersThisQuestion.set(user.userId, true);

    const team = userTeams.get(user.userId);
    const q = getCurrentQuestion();
    if (!q) return;

    // Track participation per round
    if (roundAnswerCounts[team] !== undefined) {
        roundAnswerCounts[team] += 1;
    }

    if (answer === q.correct) {
        teamScores[team]++;
        teamRoundScores[team]++;
        updateScoreDisplay();
        flashCorrectAnswer(user.nickname, team, answer);
    }

    updateRoundDuelBar();
}

function onChatMessage(data) {
    try {
        const msg = data || {};
        const text = getChatTextFromMessage(msg);
        const user = getUserFromMessage(msg);

        if (!text) return;

        // 1) Team selection ("red" / "blue"; any case)
        handleTeamJoin(text, user);

        // 2) Answer selection ("A"/"B"/"C"/"D"; any case)
        handleAnswer(text, user);
    } catch (e) {
        console.error("Error in chat handler:", e);
    }
}

function onGiftMessage(data) {
    try {
        // You can optionally use gifts to boost scores, etc.
        console.log("Gift message:", data);
    } catch (e) {
        console.error("Error in gift handler:", e);
    }
}

// ===============================
// 8. TikTok client setup / connect
// ===============================

function setupTikTokClient(liveId) {
    if (!liveId) {
        throw new Error("liveId is required");
    }

    if (client && client.socket) {
        try {
            client.socket.close();
        } catch (e) {
            console.warn("Error closing previous socket:", e);
        }
    }

    if (typeof TikTokClient === "undefined") {
        throw new Error("TikTokClient is not available. Check tiktok-client.js.");
    }

    client = new TikTokClient(liveId);

    // ChatTok injects CHATTOK_CREATOR_TOKEN globally.
    if (typeof CHATTOK_CREATOR_TOKEN !== "undefined" && CHATTOK_CREATOR_TOKEN) {
        client.setAccessToken(CHATTOK_CREATOR_TOKEN);
    }

    client.on("connected", () => {
        console.log("Connected to TikTok hub.");
        if (statusText) statusText.textContent = "Connected to TikTok LIVE.";
        if (statusTextInGame) statusTextInGame.textContent = "Connected.";

        // Only start game once we know we're connected
        if (pendingStart && !gameStarted) {
            beginGame();
        }
    });

    client.on("disconnected", (reason) => {
        console.log("Disconnected from TikTok hub:", reason);
        const msg = reason || "Connection closed";
        if (statusText) statusText.textContent = "Disconnected: " + msg;
        if (statusTextInGame) statusTextInGame.textContent = "Disconnected: " + msg;

        if (!gameStarted) {
            // Connection failed before game start; allow retry
            pendingStart = false;
        }
    });

    client.on("error", (err) => {
        console.error("TikTok client error:", err);
        if (statusText) statusText.textContent =
            "Error: " + (err && err.message ? err.message : "Unknown");
    });

    client.on("chat", onChatMessage);
    client.on("gift", onGiftMessage);
    client.on("like", (data) => {
        // Optionally use likes later
        // console.log("Like message:", data);
    });

    client.connect();
}`;

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

TikTok Message Field Mapping (MessagesClean):
- Chat text: data.content
- Username: data.user.displayid OR data.user.nickname
- Profile pic: data.user.avatarthumb.urllistList[0]
- Gifts: data.gift.name, data.gift.id, data.gift.diamondcount, data.combocount / data.repeatcount

Critical dependency order in index.html:
<script src="https://cdn.jsdelivr.net/npm/google-protobuf@3.21.2/google-protobuf.js"></script>
<script src="generic.js"></script>
<script src="unknownobjects.js"></script>
<script src="data_linkmic_messages.js"></script>
<script src="tiktok-client.js"></script>
<script src="game.js"></script>

${TIKTOK_CONNECTION_EXAMPLE}

Important:
- Follow the TikTok connection example structure and error handling style.
- Create TikTokClient only after clicking Connect.
- Close previous socket if exists.
- If CHATTOK_CREATOR_TOKEN exists, setAccessToken.
- Wire events: chat, gift, like, join, social, roomUserSeq, control.

${builderRules ? "BUILDER RULES:\n" + builderRules : ""}
`.trim();
}

/* ===============================
   AI generators
   =============================== */

async function generateSpecWithAI({ prompt, theme, builderRules }) {
  const model = String(process.env.OPENAI_MODEL_SPEC || "gpt-4o-mini").trim();
  const system = buildSystemRules(builderRules);

  const user = `
Create a detailed game SPEC as JSON.
Output keys:
title, subtitle, oneLiner, theme, howToPlay, settings, chat, host, scoring, rounds, sfx, ui

Requirements:
- Must describe Settings screen + Game screen layout
- Must include "Start is gated until connected" and optional Offline/Test mode

theme: ${JSON.stringify(theme)}
prompt: ${JSON.stringify(prompt)}
`.trim();

  return await openaiJson({
    model,
    system,
    user,
    timeoutMs: getTimeoutMs(),
    temperature: getTemperature(),
  });
}

async function generateSingleFileWithAI({ target, prompt, theme, spec, contextFiles, builderRules }) {
  const model = String(process.env.OPENAI_MODEL_BUILD || "gpt-4o-mini").trim();
  const system = buildSystemRules(builderRules);

  const ctxHtml = safeStr(contextFiles?.["index.html"] || "", 180000);
  const ctxCss = safeStr(contextFiles?.["style.css"] || "", 180000);

  let user = "";

  if (target === "index.html") {
    user = `
Generate ONLY index.html as JSON with exactly one key: "index.html".

Hard requirements:
- Must include <link rel="stylesheet" href="style.css">
- Must include Settings screen + Game screen containers with clear IDs used by game.js
- Settings: Live ID input, Connect, Offline/Test toggle (optional), Start button disabled until connected or offline
- Game: 9:16 stage with canvas or main play area + transparent directions overlay
- Must include required script tags in exact dependency order before game.js

theme: ${JSON.stringify(theme)}
spec: ${JSON.stringify(spec)}
prompt: ${JSON.stringify(prompt)}
`.trim();
  } else if (target === "style.css") {
    user = `
Generate ONLY style.css as JSON with exactly one key: "style.css".
- No Tailwind CDN, no external libs
- Mobile-first, professional TikTok LIVE UI
- Uses theme colors
- Styles must match the index.html structure below

index.html:
${JSON.stringify(ctxHtml)}

theme: ${JSON.stringify(theme)}
spec: ${JSON.stringify(spec)}
prompt: ${JSON.stringify(prompt)}
`.trim();
  } else if (target === "game.js") {
    user = `
Generate ONLY game.js as JSON with exactly one key: "game.js".

Hard requirements:
- MUST follow the TikTok connection example structure and error handling style.
- Create TikTokClient ONLY after clicking Connect
- Close previous socket if exists
- If CHATTOK_CREATOR_TOKEN exists, setAccessToken
- Wire events: chat, gift, like, join, social, roomUserSeq, control
- Handlers must use MessagesClean fields with try/catch
- Start gated until connected (unless offline mode enabled)
- Switch Settings -> Game on Start
- Implement gameplay skeleton from spec/prompt

index.html:
${JSON.stringify(ctxHtml)}

style.css:
${JSON.stringify(ctxCss)}

theme: ${JSON.stringify(theme)}
spec: ${JSON.stringify(spec)}
prompt: ${JSON.stringify(prompt)}
`.trim();
  } else {
    return { ok: false, error: "Unsupported target" };
  }

  return await openaiJson({
    model,
    system,
    user,
    timeoutMs: getTimeoutMs(),
    temperature: getTemperature(),
  });
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

    res.json({ ok: true, requestId, echoPrompt: prompt, spec, usedFallback });
  } catch (err) {
    res.status(err.status || 500).json({ ok: false, requestId, error: err.message || "Plan failed" });
  }
});

app.post("/api/build", noStore, async (req, res) => {
  const requestId = safeStr(req.body?.requestId || crypto.randomUUID(), 120);
  try {
    const prompt = safeStr(req.body?.prompt || "", 40000);
    assert(prompt, "Missing prompt");
    const theme = normalizeTheme(req.body?.theme || {});
    const builderRules = safeStr(req.body?.builderRules || "", 80000);

    const target = safeStr(req.body?.target || "", 50);
    assert(target, "Missing target");
    assert(["index.html", "style.css", "game.js"].includes(target), "Invalid target");

    const contextFiles =
      req.body?.contextFiles && typeof req.body.contextFiles === "object" ? req.body.contextFiles : {};

    let spec = req.body?.spec && typeof req.body.spec === "object" ? req.body.spec : null;
    if (!spec) spec = fallbackSpecFromIdea(prompt, theme);

    const client = getOpenAIClient();
    if (!client) {
      // Minimal fallback output
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
  <section id="settingsScreen">
    <h1>${safeStr(spec.title || "ChatTok Game", 120)}</h1>
    <input id="liveIdInput" placeholder="TikTok Live ID" />
    <button id="btnConnect">Connect</button>
    <label><input id="offlineToggle" type="checkbox" /> Offline/Test</label>
    <button id="btnStart" disabled>Start</button>
  </section>

  <section id="gameScreen" style="display:none;">
    <canvas id="gameCanvas" width="720" height="1280"></canvas>
  </section>

${REQUIRED_SCRIPT_BLOCK}
</body>
</html>`;
        html = ensureCssAndTitle(ensureTikTokScriptOrder(html));
        return res.json({ ok: true, requestId, echoPrompt: prompt, fileName: "index.html", content: html });
      }
      if (target === "style.css") {
        const css = `:root{--p:${theme.primary};--s:${theme.secondary};--bg:${theme.bg};--text:${theme.text};}
body{margin:0;background:var(--bg);color:var(--text);font-family:system-ui,Segoe UI,Roboto,Arial,sans-serif;}
canvas{width:100%;height:auto;display:block;}`;
        return res.json({ ok: true, requestId, echoPrompt: prompt, fileName: "style.css", content: css });
      }
      if (target === "game.js") {
        const js = `console.log("game.js loaded (fallback)");`;
        return res.json({ ok: true, requestId, echoPrompt: prompt, fileName: "game.js", content: js });
      }
    }

    const r = await generateSingleFileWithAI({ target, prompt, theme, spec, contextFiles, builderRules });
    if (!r.ok) {
      return res.status(500).json({ ok: false, requestId, echoPrompt: prompt, error: r.error || "Build failed" });
    }

    let content = r.json?.[target];
    if (typeof content !== "string") {
      return res.status(500).json({ ok: false, requestId, echoPrompt: prompt, error: "AI JSON missing target key" });
    }

    if (target === "index.html") content = ensureCssAndTitle(ensureTikTokScriptOrder(content));

    return res.json({ ok: true, requestId, echoPrompt: prompt, spec, fileName: target, content });
  } catch (err) {
    res.status(err.status || 500).json({ ok: false, requestId, error: err.message || "Build failed" });
  }
});

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
      const html = ensureCssAndTitle(ensureTikTokScriptOrder(files["index.html"]));
      return res.json({
        ok: true,
        requestId,
        echoPrompt: editPrompt,
        files: { "index.html": html, "style.css": files["style.css"], "game.js": files["game.js"] },
      });
    }

    const model = String(process.env.OPENAI_MODEL_BUILD || "gpt-4o-mini").trim();
    const system = buildSystemRules(builderRules);
    const user = `
Apply the edit and return ONLY JSON with exactly:
"index.html", "style.css", "game.js"

Edit request: ${JSON.stringify(editPrompt)}
Theme: ${JSON.stringify(theme)}
Screenshot (optional): ${JSON.stringify(screenshotDataUrl ? screenshotDataUrl.slice(0, 2000) + "..." : "")}

Existing index.html: ${JSON.stringify(files["index.html"])}
Existing style.css: ${JSON.stringify(files["style.css"])}
Existing game.js: ${JSON.stringify(files["game.js"])}
`.trim();

    const r = await openaiJson({
      model,
      system,
      user,
      timeoutMs: getTimeoutMs(),
      temperature: getTemperature(),
    });

    if (!r.ok) return res.status(500).json({ ok: false, requestId, echoPrompt: editPrompt, error: r.error || "Edit failed" });

    const out = r.json;
    if (typeof out?.["index.html"] !== "string" || typeof out?.["style.css"] !== "string" || typeof out?.["game.js"] !== "string") {
      return res.status(500).json({ ok: false, requestId, echoPrompt: editPrompt, error: "AI edit missing file keys" });
    }

    out["index.html"] = ensureCssAndTitle(ensureTikTokScriptOrder(out["index.html"]));

    return res.json({ ok: true, requestId, echoPrompt: editPrompt, files: out });
  } catch (err) {
    res.status(err.status || 500).json({ ok: false, requestId, error: err.message || "Edit failed" });
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
