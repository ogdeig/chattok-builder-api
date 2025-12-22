/* =========================================================
   game.template.js  (PRODUCTION TEMPLATE — COMPLETE FILE)
   Non-negotiables honored:
   ✅ Do NOT change / load tiktok-client.js (ChatTokGaming injects it)
   ✅ Do NOT request proto.bundle.js (prevents 404)
   ✅ Never hard-crashes if platform scripts aren’t injected yet
   ✅ Includes REQUIRED AI_REGION markers (server injects ONLY inside)
   ✅ Includes your WORKING TikTok connection example (DO NOT REMOVE)
   ========================================================= */

/* Injected by API (must be replaced with valid JSON at generation time) */
const SPEC = __SPEC_JSON__;

/* =========================================================
   DOM refs (must exist in index.template.html)
========================================================= */
const setupOverlay     = document.getElementById("setupOverlay");
const startGameBtn     = document.getElementById("startGameBtn");
const liveIdInput      = document.getElementById("liveIdInput");
const statusText       = document.getElementById("statusText");
const statusTextInGame = document.getElementById("statusTextInGame");
const gameRoot         = document.getElementById("gameRoot");
const flagsEl          = document.getElementById("flags");
const centerToastEl    = document.getElementById("centerToast");
const canvas           = document.getElementById("gameCanvas");

/* =========================================================
   Hard safety: if critical DOM is missing, fail gracefully
========================================================= */
if (!canvas) {
  if (statusText) statusText.textContent = "Template error: gameCanvas missing in HTML.";
  throw new Error("Template error: #gameCanvas missing");
}
const ctx2d = canvas.getContext("2d", { alpha: false });

/* =========================================================
   Helpers
========================================================= */
function nowMs(){ return (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now(); }
function clamp(v,min,max){ return Math.max(min, Math.min(max, v)); }
function rand(min,max){ return min + Math.random()*(max-min); }
function irand(min,max){ return Math.floor(rand(min, max+1)); }
function lerp(a,b,t){ return a + (b-a)*t; }
function safeStr(s){ return (s === null || s === undefined) ? "" : String(s); }
function norm(s){ return safeStr(s).trim(); }
function lower(s){ return safeStr(s).toLowerCase(); }

function escapeHtml(s){
  return safeStr(s)
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;")
    .replaceAll("'","&#039;");
}

function setStatus(msg){
  if (statusText) statusText.textContent = msg;
}
function setInGameStatus(msg){
  if (statusTextInGame) statusTextInGame.textContent = msg;
}

function showCenterToast(big, small, ms){
  if (!centerToastEl) return;
  centerToastEl.innerHTML = `
    <div class="big">${escapeHtml(big)}</div>
    ${small ? `<div class="small">${escapeHtml(small)}</div>` : ``}
  `;
  centerToastEl.classList.add("show");
  clearTimeout(showCenterToast._t);
  showCenterToast._t = setTimeout(() => centerToastEl.classList.remove("show"), ms || 1200);
}

/* =========================================================
   Notifications contract
   - Some games may not want “flags”.
   - Supported: "flags" (default), "toast", "off"
   - Spec may set: SPEC.ui.notificationsStyle
========================================================= */
function getNotificationsStyle(){
  const fromSpec =
    (SPEC && SPEC.ui && SPEC.ui.notificationsStyle) ||
    (SPEC && SPEC.notificationsStyle) ||
    "";
  const s = lower(norm(fromSpec));
  if (s === "off" || s === "none") return "off";
  if (s === "toast") return "toast";
  return "flags"; // default
}

let NOTIF_STYLE = "flags"; // set during init()

function pushFlag({ who, msg, pfp, cls }){
  // Respect style
  if (NOTIF_STYLE === "off") return;
  if (NOTIF_STYLE === "toast") {
    showCenterToast(who || "Viewer", msg || "", 900);
    return;
  }

  // flags
  if (!flagsEl) return;

  const wrap = document.createElement("div");
  wrap.className = "flag" + (cls ? " " + cls : "");

  const pfpBox = document.createElement("div");
  pfpBox.className = "flagPfp";
  if (pfp) {
    const img = document.createElement("img");
    img.alt = "";
    img.referrerPolicy = "no-referrer";
    img.src = pfp;
    pfpBox.appendChild(img);
  }

  const body = document.createElement("div");
  body.className = "flagBody";
  const whoEl = document.createElement("div");
  whoEl.className = "flagWho";
  whoEl.textContent = who || "Viewer";
  const msgEl = document.createElement("div");
  msgEl.className = "flagMsg";
  msgEl.textContent = msg || "";

  body.appendChild(whoEl);
  body.appendChild(msgEl);

  wrap.appendChild(pfpBox);
  wrap.appendChild(body);

  flagsEl.appendChild(wrap);

  // Keep list small
  const kids = Array.from(flagsEl.children);
  if (kids.length > 6) {
    for (let i = 0; i < kids.length - 6; i++) {
      try { kids[i].remove(); } catch(e){}
    }
  }

  setTimeout(() => {
    try { wrap.remove(); } catch(e){}
  }, 3800);
}

/* =========================================================
   Settings parsing (robust)
   - Inputs should have data-setting-key, or id/name is used
========================================================= */
function readSettings(){
  const out = Object.assign({}, (SPEC && SPEC.settingsDefaults) ? SPEC.settingsDefaults : {});

  // Safe defaults for common “command + share fallback” requirement
  if (out.actionCommand === undefined) out.actionCommand = "!boost";
  if (out.allowShareForAction === undefined) out.allowShareForAction = false;
  if (out.joinCommand === undefined) out.joinCommand = "!join";

  const grid = document.getElementById("settingsGrid");
  if (!grid) return out;

  const controls = grid.querySelectorAll("input, select, textarea");
  controls.forEach(el => {
    const key = el.getAttribute("data-setting-key") || el.id || el.name;
    if (!key) return;

    const k = key.replace(/^setting[_-]/i, "").replace(/^spec[_-]/i, "");

    let val;
    if (el.type === "checkbox") val = !!el.checked;
    else if (el.type === "number") val = Number(el.value);
    else val = el.value;

    out[k] = val;
  });

  if (typeof out.allowShareForAction === "string") {
    out.allowShareForAction = lower(out.allowShareForAction) === "true";
  }
  return out;
}

/* =========================================================
   Platform contract checks
   - ChatTokGaming injects:
     window.TikTokClient
     window.proto
========================================================= */
function platformReady(){
  const hasClient = (typeof window.TikTokClient !== "undefined");
  const hasProto  = (typeof window.proto !== "undefined");
  return { hasClient, hasProto };
}

/* =========================================================
   Baseline Game: "Spark Dodger" (never blank, even offline)
========================================================= */
const BASE_W = 720;
const BASE_H = 1280;

const G = {
  started: false,
  connected: false,
  settings: {},
  lastT: 0,
  time: 0,

  players: new Map(), // userId -> player
  orbs: [],
  enemies: [],
  particles: [],

  score: 0,
  pulse: 0,       // 0..100 from likes
  pulseReady: false,

  host: {
    x: BASE_W * 0.5,
    y: BASE_H * 0.62,
    vx: 0, vy: 0,
    r: 18,
  },

  keys: new Set(),
  pointer: { down:false, x:0, y:0 },

  dpr: 1,
};

function resetWorld(){
  G.orbs.length = 0;
  G.enemies.length = 0;
  G.particles.length = 0;
  G.score = 0;
  G.pulse = 0;
  G.pulseReady = false;
}

function ensureDpr(){
  const dpr = clamp((window.devicePixelRatio || 1), 1, 2);
  if (G.dpr === dpr) return;

  G.dpr = dpr;
  canvas.width  = Math.floor(BASE_W * dpr);
  canvas.height = Math.floor(BASE_H * dpr);
  ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function spawnOrb(x, y, boost){
  const r = boost ? rand(10, 16) : rand(8, 12);
  G.orbs.push({
    x: x ?? rand(60, BASE_W-60),
    y: y ?? rand(200, BASE_H-160),
    vx: rand(-18, 18),
    vy: rand(-12, 22),
    r,
    value: boost ? 3 : 1,
  });
}

function spawnEnemy(strength){
  const edge = irand(0, 3);
  let x = 0, y = 0;
  if (edge === 0){ x = rand(40, BASE_W-40); y = -40; }
  if (edge === 1){ x = BASE_W+40; y = rand(140, BASE_H-140); }
  if (edge === 2){ x = rand(40, BASE_W-40); y = BASE_H+40; }
  if (edge === 3){ x = -40; y = rand(140, BASE_H-140); }

  const s = clamp(strength || 1, 1, 6);
  G.enemies.push({
    x, y,
    vx: 0, vy: 0,
    r: 16 + s * 3,
    hp: 1 + s,
    s,
  });
}

function addParticle(x,y, count, hue){
  const n = count || 10;
  for (let i=0;i<n;i++){
    const a = rand(0, Math.PI*2);
    const sp = rand(60, 260);
    G.particles.push({
      x, y,
      vx: Math.cos(a)*sp,
      vy: Math.sin(a)*sp,
      r: rand(2,4),
      life: rand(0.25, 0.65),
      hue: hue ?? (Math.random()<0.5 ? "aqua" : "pink"),
    });
  }
}

function shockwave(x,y, power){
  const p = clamp(power || 1, 1, 6);
  addParticle(x,y, 18 + p*6, "aqua");

  // push enemies away / damage
  for (const e of G.enemies){
    const dx = e.x - x, dy = e.y - y;
    const d = Math.hypot(dx,dy) || 1;
    const f = (420 * p) / d;
    e.vx += (dx/d) * f;
    e.vy += (dy/d) * f;
    e.hp -= 1;
  }
  G.enemies = G.enemies.filter(e => e.hp > 0);
}

function upsertPlayer(user){
  const u = user || {};
  const userId = safeStr(u.userId || u.uniqueId || u.id || "");
  if (!userId) return null;

  let p = G.players.get(userId);
  if (!p){
    p = {
      userId,
      nickname: safeStr(u.nickname || u.uniqueId || "Viewer"),
      pfp: safeStr(u.profilePictureUrl || u.profilePic || u.avatar || ""),
      angle: rand(0, Math.PI*2),
      dist: rand(170, 280),
      r: rand(12, 16),
      score: 0,
      colorClass: "", // optional: "red"/"blue"/etc
      lastAction: 0,
    };
    G.players.set(userId, p);
  } else {
    if (u.nickname) p.nickname = safeStr(u.nickname);
    if (u.profilePictureUrl) p.pfp = safeStr(u.profilePictureUrl);
  }
  return p;
}

/* =========================================================
   Message helpers (robust)
========================================================= */
function getChatTextFromMessage(msg){
  const m = msg || {};
  return norm(
    m.comment ??
    m.text ??
    m.message ??
    m.content ??
    (m.data && (m.data.comment || m.data.text)) ??
    ""
  );
}

function getUserFromMessage(msg){
  const m = msg || {};
  const u = (m.user || m.author || m.sender || (m.data && (m.data.user || m.data.author))) || {};

  const userId =
    safeStr(u.userId || u.id || u.uniqueId || m.userId || m.uniqueId || "");

  const nickname =
    safeStr(u.nickname || u.uniqueId || m.nickname || m.uniqueId || "Viewer");

  const profilePictureUrl =
    safeStr(
      u.profilePictureUrl ||
      u.profilePic ||
      u.avatar ||
      (u.profilePicture && u.profilePicture.url) ||
      (u.profilePicture && u.profilePicture.urls && u.profilePicture.urls[0]) ||
      (m.profilePictureUrl) ||
      ""
    );

  return { userId, nickname, profilePictureUrl };
}

/* =========================================================
   ✅ WORKING TIKTOK CONNECTION EXAMPLE (DO NOT REMOVE)
========================================================= */

// 7. TikTok message handling
// ===============================

const userTeams = new Map();
const answeredUsersThisQuestion = new Map();
const roundAnswerCounts = { red:0, blue:0, green:0, yellow:0 };
const teamScores = { red:0, blue:0, green:0, yellow:0 };
const teamRoundScores = { red:0, blue:0, green:0, yellow:0 };
let gameStarted = false;
let gameFinished = false;

function normalizeTeamText(text){
  const t = lower(text);
  if (t.includes("red")) return "red";
  if (t.includes("blue")) return "blue";
  if (t.includes("green")) return "green";
  if (t.includes("yellow")) return "yellow";
  return null;
}
function normalizeAnswerText(text){
  const t = lower(text);
  if (t === "a" || t.includes(" a ")) return "A";
  if (t === "b" || t.includes(" b ")) return "B";
  if (t === "c" || t.includes(" c ")) return "C";
  if (t === "d" || t.includes(" d ")) return "D";
  return null;
}
function getCurrentQuestion(){ return null; } // Only used by trivia-style games
function updateScoreDisplay(){}
function flashCorrectAnswer(nickname, team, answer){}
function updateRoundDuelBar(){}

function handleTeamJoin(text, user) {
  const maybeTeam = normalizeTeamText(text);
  if (!maybeTeam) return;

  // Assign or move team.
  userTeams.set(user.userId, maybeTeam);
  console.log(`${user.nickname} joined team ${maybeTeam}`);
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

    // 3) Template baseline: treat chat as “action” if it matches command
    handleTemplateChatAction(text, user, msg);
  } catch (e) {
    console.error("Error in chat handler:", e);
  }
}

function onGiftMessage(data) {
  try {
    // You can optionally use gifts to boost scores, etc.
    console.log("Gift message:", data);
    handleTemplateGift(data || {});
  } catch (e) {
    console.error("Error in gift handler:", e);
  }
}

// ===============================
// 8. TikTok client setup / connect
// ===============================

let client = null;
let pendingStart = false;

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
    G.connected = true;
    setStatus("Connected to TikTok LIVE.");
    setInGameStatus("Connected.");

    // Only start game once we know we're connected
    if (pendingStart && !gameStarted) {
      beginGame();
    }
  });

  client.on("disconnected", (reason) => {
    console.log("Disconnected from TikTok hub:", reason);
    G.connected = false;
    const msg = reason || "Connection closed";
    setStatus("Disconnected: " + msg);
    setInGameStatus("Disconnected: " + msg);

    if (!gameStarted) {
      // Connection failed before game start; allow retry
      pendingStart = false;
    }
  });

  client.on("error", (err) => {
    console.error("TikTok client error:", err);
    setStatus("Error: " + (err && err.message ? err.message : "Unknown"));
  });

  client.on("chat", onChatMessage);
  client.on("gift", onGiftMessage);

  // Optional events:
  client.on("like", (data) => {
    try { handleTemplateLike(data || {}); } catch(e){ console.error("like handler:", e); }
  });

  client.on("join", (data) => {
    try { handleTemplateJoin(data || {}); } catch(e){ console.error("join handler:", e); }
  });

  // Some connectors emit "share"
  client.on("share", (data) => {
    try { handleTemplateShare(data || {}); } catch(e){ console.error("share handler:", e); }
  });

  client.connect();
}

/* =========================================================
   Template TikTok mapping (safe baseline)
========================================================= */
function handleTemplateChatAction(text, user, rawMsg){
  const cmd = lower(norm(G.settings.actionCommand || "!boost"));
  const joinCmd = lower(norm(G.settings.joinCommand || "!join"));
  const t = lower(norm(text));

  // Join command
  if (joinCmd && t.startsWith(joinCmd)){
    const p = upsertPlayer(user);
    if (p){
      pushFlag({ who: p.nickname, msg: "joined the arena!", pfp: p.pfp, cls: p.colorClass });
      addParticle(BASE_W*0.5, BASE_H*0.58, 14, "aqua");
    }
    safeCallAI("chat", rawMsg, user, text);
    return;
  }

  // Action command
  if (cmd && t.includes(cmd)){
    const p = upsertPlayer(user);
    if (p){
      p.lastAction = nowMs();
      pushFlag({ who: p.nickname, msg: `used ${cmd}`, pfp: p.pfp, cls: p.colorClass });
      for (let i=0;i<2;i++) spawnOrb(rand(80, BASE_W-80), rand(240, BASE_H-220), true);
      addParticle(BASE_W*0.5, BASE_H*0.62, 10, "pink");
      G.score += 1;
    }
  }

  safeCallAI("chat", rawMsg, user, text);
}

function handleTemplateLike(likeEvt){
  const count =
    Number(likeEvt.likeCount || likeEvt.count || (likeEvt.data && likeEvt.data.likeCount) || 1) || 1;

  G.pulse = clamp(G.pulse + Math.min(8, count*0.15), 0, 100);
  if (G.pulse >= 100 && !G.pulseReady){
    G.pulseReady = true;
    showCenterToast("PULSE READY!", "Next gift triggers a shockwave", 1100);
  }

  safeCallAI("like", likeEvt, getUserFromMessage(likeEvt));
}

function handleTemplateGift(giftEvt){
  const u = getUserFromMessage(giftEvt);
  const p = upsertPlayer(u);

  const power =
    Number(giftEvt.diamondCount || giftEvt.diamonds || giftEvt.repeatCount || giftEvt.count || 1) || 1;

  if (p){
    pushFlag({ who: p.nickname, msg: `sent a gift! (+${power})`, pfp: p.pfp, cls: p.colorClass });
  }

  if (G.pulseReady){
    G.pulseReady = false;
    G.pulse = 0;
    showCenterToast("SHOCKWAVE!", "Gift triggered the pulse blast", 1100);
    shockwave(BASE_W*0.5, BASE_H*0.62, 3);
  } else {
    spawnEnemy(clamp(Math.log2(power+1), 1, 6));
    for (let i=0;i<2;i++) spawnOrb(null, null, true);
    showCenterToast("BOSS INBOUND!", "Gift spawned a heavy", 950);
  }

  safeCallAI("gift", giftEvt, u);
}

function handleTemplateJoin(joinEvt){
  const u = getUserFromMessage(joinEvt);
  const p = upsertPlayer(u);
  if (p){
    pushFlag({ who: p.nickname, msg: "entered the LIVE", pfp: p.pfp, cls: p.colorClass });
  }
  spawnOrb(null, null, false);
  safeCallAI("join", joinEvt, u);
}

function handleTemplateShare(shareEvt){
  const u = getUserFromMessage(shareEvt);
  const p = upsertPlayer(u);
  if (p){
    pushFlag({ who: p.nickname, msg: "shared the LIVE", pfp: p.pfp, cls: p.colorClass });
  }

  // Optional: allow share to trigger same action for users whose chat isn’t visible
  if (G.settings.allowShareForAction){
    const cmd = norm(G.settings.actionCommand || "!boost");
    handleTemplateChatAction(cmd, u, shareEvt);
  }

  safeCallAI("share", shareEvt, u);
}

/* =========================================================
   AI hook calls (safe)
========================================================= */
function safeCallAI(kind, a, b, c){
  try {
    if (kind === "setup" && typeof aiSetup === "function") return aiSetup(GAME_API());
    if (kind === "chat"  && typeof aiOnChat === "function") return aiOnChat(GAME_API(), a, b, c);
    if (kind === "gift"  && typeof aiOnGift === "function") return aiOnGift(GAME_API(), a, b);
    if (kind === "like"  && typeof aiOnLike === "function") return aiOnLike(GAME_API(), a, b);
    if (kind === "join"  && typeof aiOnJoin === "function") return aiOnJoin(GAME_API(), a, b);
    if (kind === "share" && typeof aiOnShare === "function") return aiOnShare(GAME_API(), a, b);
  } catch (e) {
    console.error("AI hook error:", kind, e);
  }
}

/* =========================================================
   API exposed to AI region (stable, small surface)
========================================================= */
function GAME_API(){
  return {
    SPEC,
    G,
    BASE_W,
    BASE_H,
    pushFlag,
    showCenterToast,
    spawnOrb,
    spawnEnemy,
    shockwave,
    addParticle,
    upsertPlayer,
    setStatus,
    setInGameStatus,
    clamp,
    rand,
    irand,
    norm,
    lower,
  };
}

/* =========================================================
   AI REGION (server replaces ONLY between markers)
   - MUST keep markers exactly, or your API will throw:
     "Missing markers: // === AI_REGION_START === / // === AI_REGION_END ==="
========================================================= */

// === AI_REGION_START ===
/*
  AI INSTRUCTIONS:
  - Modify ONLY within this region.
  - Do NOT load external scripts.
  - Do NOT request proto.bundle.js; platform injects proto.
  - Use GAME_API() helpers.
  - Keep it lightweight.
*/

// Optional AI hooks (override as needed)
function aiSetup(ctx){}
function aiOnChat(ctx, rawMsg, user, text){}
function aiOnGift(ctx, giftEvt, user){}
function aiOnLike(ctx, likeEvt, user){}
function aiOnJoin(ctx, joinEvt, user){}
function aiOnShare(ctx, shareEvt, user){}

// Optional per-frame hooks (also overrideable)
function aiUpdate(ctx, dt){}
function aiRender(ctx, g2d){}
// === AI_REGION_END ===

/* =========================================================
   Game loop
========================================================= */
function update(dt){
  G.time += dt;

  // Host movement (keyboard / pointer)
  const sp = 240;
  let ax = 0, ay = 0;
  if (G.keys.has("ArrowLeft") || G.keys.has("a")) ax -= 1;
  if (G.keys.has("ArrowRight") || G.keys.has("d")) ax += 1;
  if (G.keys.has("ArrowUp") || G.keys.has("w")) ay -= 1;
  if (G.keys.has("ArrowDown") || G.keys.has("s")) ay += 1;

  if (G.pointer.down){
    const dx = (G.pointer.x - G.host.x);
    const dy = (G.pointer.y - G.host.y);
    ax += clamp(dx / 120, -1, 1);
    ay += clamp(dy / 120, -1, 1);
  }

  const mag = Math.hypot(ax,ay) || 1;
  ax /= mag; ay /= mag;

  G.host.vx = lerp(G.host.vx, ax * sp, clamp(dt*8, 0, 1));
  G.host.vy = lerp(G.host.vy, ay * sp, clamp(dt*8, 0, 1));
  G.host.x = clamp(G.host.x + G.host.vx*dt, 40, BASE_W-40);
  G.host.y = clamp(G.host.y + G.host.vy*dt, 220, BASE_H-80);

  // Always-active baseline spawns (so it never looks blank)
  if (Math.random() < dt * 0.8) spawnOrb(null, null, false);
  if (Math.random() < dt * 0.18) spawnEnemy(1);

  // Orbs
  for (const o of G.orbs){
    o.x += o.vx*dt;
    o.y += o.vy*dt;
    o.vx *= (1 - dt*0.2);
    o.vy *= (1 - dt*0.2);

    if (o.x < 40){ o.x = 40; o.vx = Math.abs(o.vx)*0.9; }
    if (o.x > BASE_W-40){ o.x = BASE_W-40; o.vx = -Math.abs(o.vx)*0.9; }
    if (o.y < 200){ o.y = 200; o.vy = Math.abs(o.vy)*0.9; }
    if (o.y > BASE_H-80){ o.y = BASE_H-80; o.vy = -Math.abs(o.vy)*0.9; }
  }

  // Center point
  const cx = BASE_W*0.5, cy = BASE_H*0.62;

  // Player orbits + collect
  for (const p of G.players.values()){
    p.angle += dt * 0.6;
    const px = cx + Math.cos(p.angle) * p.dist;
    const py = cy + Math.sin(p.angle) * p.dist;

    for (let i=G.orbs.length-1;i>=0;i--){
      const o = G.orbs[i];
      const d = Math.hypot(o.x - px, o.y - py);
      if (d < o.r + p.r + 8){
        G.orbs.splice(i,1);
        p.score += o.value;
        G.score += o.value;
        addParticle(o.x, o.y, 8, "aqua");
      }
    }
  }

  // Host collects
  for (let i=G.orbs.length-1;i>=0;i--){
    const o = G.orbs[i];
    const d = Math.hypot(o.x - G.host.x, o.y - G.host.y);
    if (d < o.r + G.host.r + 8){
      G.orbs.splice(i,1);
      G.score += o.value;
      addParticle(o.x, o.y, 8, "pink");
    }
  }

  // Enemies drift toward center
  for (const e of G.enemies){
    const dx = cx - e.x, dy = cy - e.y;
    const d = Math.hypot(dx,dy) || 1;
    const spd = 44 + e.s*10;
    e.vx += (dx/d) * spd * dt;
    e.vy += (dy/d) * spd * dt;
    e.vx *= (1 - dt*0.28);
    e.vy *= (1 - dt*0.28);
    e.x += e.vx*dt;
    e.y += e.vy*dt;

    // Reaches center: small penalty
    if (d < 40){
      G.score = Math.max(0, G.score - 2);
      addParticle(e.x, e.y, 14, "pink");
      e.hp = -1;
    }
  }
  G.enemies = G.enemies.filter(e => e.hp > 0);

  // Particles
  for (let i=G.particles.length-1;i>=0;i--){
    const p = G.particles[i];
    p.life -= dt;
    p.x += p.vx*dt;
    p.y += p.vy*dt;
    p.vx *= (1 - dt*2.2);
    p.vy *= (1 - dt*2.2);
    if (p.life <= 0) G.particles.splice(i,1);
  }

  // AI per-frame hook
  try { if (typeof aiUpdate === "function") aiUpdate(GAME_API(), dt); }
  catch(e){ console.error("aiUpdate error:", e); }
}

function render(){
  ctx2d.clearRect(0,0,BASE_W,BASE_H);

  // soft grid
  ctx2d.globalAlpha = 0.08;
  ctx2d.strokeStyle = "#ffffff";
  ctx2d.lineWidth = 1;
  for (let y=200;y<BASE_H;y+=48){
    ctx2d.beginPath();
    ctx2d.moveTo(0,y);
    ctx2d.lineTo(BASE_W,y);
    ctx2d.stroke();
  }
  for (let x=0;x<BASE_W;x+=48){
    ctx2d.beginPath();
    ctx2d.moveTo(x,200);
    ctx2d.lineTo(x,BASE_H);
    ctx2d.stroke();
  }
  ctx2d.globalAlpha = 1;

  const cx = BASE_W*0.5, cy = BASE_H*0.62;

  // core
  ctx2d.beginPath();
  ctx2d.arc(cx, cy, 34, 0, Math.PI*2);
  ctx2d.fillStyle = "rgba(0,242,234,.12)";
  ctx2d.fill();
  ctx2d.beginPath();
  ctx2d.arc(cx, cy, 20, 0, Math.PI*2);
  ctx2d.fillStyle = "rgba(255,0,80,.10)";
  ctx2d.fill();

  // orbs
  for (const o of G.orbs){
    ctx2d.beginPath();
    ctx2d.arc(o.x, o.y, o.r, 0, Math.PI*2);
    ctx2d.fillStyle = o.value >= 3 ? "rgba(0,242,234,.88)" : "rgba(255,255,255,.78)";
    ctx2d.fill();
  }

  // enemies
  for (const e of G.enemies){
    ctx2d.beginPath();
    ctx2d.arc(e.x, e.y, e.r, 0, Math.PI*2);
    ctx2d.fillStyle = "rgba(255,0,80,.22)";
    ctx2d.fill();
    ctx2d.lineWidth = 3;
    ctx2d.strokeStyle = "rgba(255,0,80,.55)";
    ctx2d.stroke();
  }

  // players
  for (const p of G.players.values()){
    const px = cx + Math.cos(p.angle) * p.dist;
    const py = cy + Math.sin(p.angle) * p.dist;

    ctx2d.beginPath();
    ctx2d.arc(px, py, p.r, 0, Math.PI*2);
    ctx2d.fillStyle = "rgba(0,242,234,.18)";
    ctx2d.fill();
    ctx2d.lineWidth = 2;
    ctx2d.strokeStyle = "rgba(0,242,234,.65)";
    ctx2d.stroke();
  }

  // host
  ctx2d.beginPath();
  ctx2d.arc(G.host.x, G.host.y, G.host.r, 0, Math.PI*2);
  ctx2d.fillStyle = "rgba(0,242,234,.70)";
  ctx2d.fill();
  ctx2d.lineWidth = 3;
  ctx2d.strokeStyle = "rgba(255,255,255,.55)";
  ctx2d.stroke();

  // particles
  for (const p of G.particles){
    ctx2d.globalAlpha = clamp(p.life / 0.65, 0, 1);
    ctx2d.beginPath();
    ctx2d.arc(p.x, p.y, p.r, 0, Math.PI*2);
    ctx2d.fillStyle = (p.hue === "pink") ? "rgba(255,0,80,.85)" : "rgba(0,242,234,.85)";
    ctx2d.fill();
  }
  ctx2d.globalAlpha = 1;

  // score + pulse bar
  ctx2d.save();
  ctx2d.font = "900 22px system-ui, -apple-system, Segoe UI, Roboto, Arial";
  ctx2d.fillStyle = "rgba(255,255,255,.95)";
  ctx2d.fillText("Score: " + G.score, 16, 250);

  const barX = 16, barY = 270, barW = 240, barH = 12;
  ctx2d.fillStyle = "rgba(255,255,255,.14)";
  ctx2d.fillRect(barX, barY, barW, barH);
  ctx2d.fillStyle = G.pulseReady ? "rgba(0,242,234,.95)" : "rgba(0,242,234,.55)";
  ctx2d.fillRect(barX, barY, barW * (G.pulse/100), barH);
  ctx2d.font = "800 12px system-ui, -apple-system, Segoe UI, Roboto, Arial";
  ctx2d.fillStyle = "rgba(255,255,255,.80)";
  ctx2d.fillText(G.pulseReady ? "PULSE READY" : "Pulse", barX, barY - 6);
  ctx2d.restore();

  // AI render hook
  try { if (typeof aiRender === "function") aiRender(GAME_API(), ctx2d); }
  catch(e){ console.error("aiRender error:", e); }
}

function loop(t){
  if (!G.started) return;
  const ms = t || nowMs();
  const dt = clamp((ms - (G.lastT || ms)) / 1000, 0, 0.05);
  G.lastT = ms;

  ensureDpr();
  update(dt);
  render();

  requestAnimationFrame(loop);
}

/* =========================================================
   Start / overlay behavior
========================================================= */
function beginGame(){
  if (G.started) return;

  G.started = true;
  gameStarted = true;
  gameFinished = false;

  if (setupOverlay) setupOverlay.classList.add("hidden");
  if (gameRoot) gameRoot.style.opacity = "1";

  resetWorld();

  for (let i=0;i<6;i++) spawnOrb(null, null, false);
  for (let i=0;i<2;i++) spawnEnemy(1);

  showCenterToast("LIVE GAME READY", "Chat + Likes + Gifts drive the action", 1200);

  safeCallAI("setup");

  requestAnimationFrame(loop);
}

/* =========================================================
   Host input (local)
========================================================= */
window.addEventListener("keydown", (e) => {
  G.keys.add(e.key);
  if (e.key === " " && G.started){
    shockwave(BASE_W*0.5, BASE_H*0.62, 2);
  }
});
window.addEventListener("keyup", (e) => G.keys.delete(e.key));

canvas.addEventListener("pointerdown", (e) => {
  const rect = canvas.getBoundingClientRect();
  G.pointer.down = true;
  G.pointer.x = ((e.clientX - rect.left) / rect.width) * BASE_W;
  G.pointer.y = ((e.clientY - rect.top) / rect.height) * BASE_H;
  try { canvas.setPointerCapture(e.pointerId); } catch(_){}
});
canvas.addEventListener("pointermove", (e) => {
  if (!G.pointer.down) return;
  const rect = canvas.getBoundingClientRect();
  G.pointer.x = ((e.clientX - rect.left) / rect.width) * BASE_W;
  G.pointer.y = ((e.clientY - rect.top) / rect.height) * BASE_H;
});
canvas.addEventListener("pointerup", () => { G.pointer.down = false; });

/* =========================================================
   Init + Start button wiring
========================================================= */
function init(){
  NOTIF_STYLE = getNotificationsStyle();
  if (flagsEl && NOTIF_STYLE !== "flags") flagsEl.style.display = "none";

  // status
  const ready = platformReady();
  if (!ready.hasClient || !ready.hasProto){
    setStatus("Waiting for injection… (works in ChatTokGaming preview/live)");
  } else {
    setStatus("Ready. Enter LIVE ID and press Connect & Start Game.");
  }
  setInGameStatus("Disconnected");

  if (!startGameBtn) return;

  startGameBtn.addEventListener("click", () => {
    try {
      G.settings = readSettings();

      const liveId = norm(liveIdInput ? liveIdInput.value : "");
      pendingStart = true;

      const pr = platformReady();

      // If platform scripts aren’t injected, start offline demo (never blank).
      if (!pr.hasClient || !pr.hasProto){
        setStatus("Offline mode: platform scripts not injected here.");
        setInGameStatus("Offline");
        beginGame();
        pendingStart = false;
        return;
      }

      // If no liveId, still start offline (playable immediately).
      if (!liveId){
        setStatus("No LIVE ID entered. Starting offline demo.");
        setInGameStatus("Offline");
        beginGame();
        pendingStart = false;
        return;
      }

      setStatus("Connecting…");
      setInGameStatus("Connecting…");

      // Connect via injected TikTokClient (requires window.proto)
      setupTikTokClient(liveId);
      // beginGame() is called on "connected"
    } catch (e) {
      console.error(e);
      setStatus("Start error: " + (e && e.message ? e.message : "Unknown"));
      pendingStart = false;
    }
  });

  // re-check injection after first paint (some hosts inject later)
  setTimeout(() => {
    const r = platformReady();
    if (r.hasClient && r.hasProto){
      setStatus("Ready. Enter LIVE ID and press Connect & Start Game.");
    }
  }, 1200);

  setTimeout(() => {
    const r = platformReady();
    if (r.hasClient && r.hasProto){
      setStatus("Ready. Enter LIVE ID and press Connect & Start Game.");
    }
  }, 3200);
}

init();
