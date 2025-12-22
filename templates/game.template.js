/* =========================================================
   game.template.js (template-first, production-ready)

   NON-NEGOTIABLES (aligned):
   - Do NOT edit tiktok-client.js (platform-provided).
   - Must eliminate proto runtime crashes: if proto missing, fail gracefully + keep demo running.
   - Must run inside ChatTokGaming preview (iframe/srcdoc/base href quirks handled in HTML).
   - Must be a REAL game immediately (animation + entities visible on load), even before TikTok connects.
   - AI must only fill AI_REGION (server enforces), everything else stable for low cost.

   FILE EXPECTATIONS:
   - index.template.html provides these IDs:
     setupOverlay, startGameBtn, liveIdInput, statusText, depStatus,
     statusTextInGame, statusTextFooter, flags, gameRoot
   ========================================================= */

// Injected server-side (JSON object)
const SPEC = __SPEC_JSON__;

/* =========================================================
   DOM refs
========================================================= */
const setupOverlay = document.getElementById("setupOverlay");
const startGameBtn = document.getElementById("startGameBtn");
const liveIdInput  = document.getElementById("liveIdInput");

const statusText = document.getElementById("statusText");
const depStatus  = document.getElementById("depStatus");

const statusTextInGame  = document.getElementById("statusTextInGame");
const statusTextFooter  = document.getElementById("statusTextFooter");

const flagsEl = document.getElementById("flags");
const gameRoot = document.getElementById("gameRoot");

/* =========================================================
   Small utilities (safe, stable)
========================================================= */
function clamp(n, a, b){ return Math.max(a, Math.min(b, n)); }
function rand(a, b){ return a + Math.random() * (b - a); }
function now(){ return performance.now(); }

function safeStr(v){ return (v === null || v === undefined) ? "" : String(v); }
function escapeHtml(s){
  return safeStr(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/* =========================================================
   UI helpers
========================================================= */
function setStatus(msg, ok){
  const t = safeStr(msg || "");
  if (statusText) statusText.textContent = t;
  if (statusTextInGame) statusTextInGame.textContent = ok ? "Connected" : t || "Disconnected";
  if (statusTextFooter) statusTextFooter.textContent = ok ? "Connected" : t || "Disconnected";

  if (depStatus){
    if (!ok && t) depStatus.textContent = t;
  }
}

function showOverlay(){
  if (setupOverlay) setupOverlay.style.display = "flex";
}
function hideOverlay(){
  if (setupOverlay) setupOverlay.style.display = "none";
}

/* =========================================================
   Flag notifications (right-side)
   CSS expects:
   .flag .pfp img, .flag .txt .who, .flag .txt .msg
========================================================= */
function pushFlag(kind, user, message, tint){
  try{
    if (!flagsEl) return;

    const wrap = document.createElement("div");
    wrap.className = "flag " + (kind ? ("is-" + kind) : "is-chat") + (tint ? (" " + tint) : "");
    wrap.style.top = "12px"; // always top; CSS anim handles slide

    const pfp = document.createElement("div");
    pfp.className = "pfp";
    const img = document.createElement("img");
    img.alt = "";
    img.decoding = "async";
    img.loading = "lazy";
    img.src = (user && user.profilePictureUrl) ? user.profilePictureUrl : "";
    pfp.appendChild(img);

    const txt = document.createElement("div");
    txt.className = "txt";
    txt.innerHTML =
      `<div class="who">${escapeHtml(user && (user.nickname || user.uniqueId || user.userId) || "Viewer")}</div>` +
      `<div class="msg">${escapeHtml(message || "")}</div>`;

    wrap.appendChild(pfp);
    wrap.appendChild(txt);
    flagsEl.prepend(wrap);

    // cap
    while (flagsEl.childElementCount > 6) flagsEl.removeChild(flagsEl.lastChild);

    // animate
    requestAnimationFrame(() => wrap.classList.add("show"));

    // cleanup
    setTimeout(() => { try { wrap.remove(); } catch{} }, 4200);
  }catch(e){
    console.warn("flag error", e);
  }
}

/* =========================================================
   Proto guard + fallback loader (no crashes)
   We do NOT assume any specific "proto contract".
   We:
   1) prefer injected window.proto
   2) if missing, attempt a small set of fallback script paths
   3) if still missing, keep game in demo mode + friendly message
========================================================= */
function hasProto(){
  try{
    return !!(window.proto && window.proto.TikTok && window.proto.TikTok.Messages);
  }catch{
    return false;
  }
}

function hasTikTokClient(){
  return (typeof window.TikTokClient !== "undefined");
}

function loadScriptOnce(src){
  return new Promise((resolve) => {
    try{
      // already loaded?
      const existing = Array.from(document.scripts || []).find(s => s && s.src && s.src === src);
      if (existing) return resolve(true);

      const s = document.createElement("script");
      s.src = src;
      s.async = true;
      s.onload = () => resolve(true);
      s.onerror = () => resolve(false);
      document.head.appendChild(s);
    }catch{
      resolve(false);
    }
  });
}

async function ensureProtoReady(){
  if (hasProto()) return true;

  // Small, bounded fallback attempts (avoid endless loops)
  const candidates = [
    // Common single-bundle name used by some hosts:
    "./proto.bundle.js",
    "/proto.bundle.js",

    // Multi-bundle pattern (some projects ship these in the same folder):
    "https://cdn.jsdelivr.net/npm/google-protobuf@3.21.2/google-protobuf.js",
    "./generic.js", "/generic.js",
    "./unknownobjects.js", "/unknownobjects.js",
    "./data_linkmic_messages.js", "/data_linkmic_messages.js",
  ];

  for (let i = 0; i < candidates.length; i++){
    if (hasProto()) return true;
    const ok = await loadScriptOnce(candidates[i]);
    if (ok && hasProto()) return true;
  }

  return hasProto();
}

/* =========================================================
   Game: Orb Arena (template baseline)
   - Always shows motion + entities on load
   - Viewers can join/spawn orbs, push attacks, and power up via gifts
   - Likes build an energy meter -> faster spawns + stronger shots
========================================================= */
const GAME = {
  stageEl: null,
  canvas: null,
  ctx: null,
  w: 0,
  h: 0,
  dpr: 1,

  // timing
  lastT: 0,
  acc: 0,

  // state
  running: true,
  connected: false,
  pendingStart: false,

  // systems
  stars: [],
  particles: [],
  enemies: [],
  projectiles: [],
  players: new Map(), // userId -> player

  // meters
  energy: 0,        // 0..1
  likeBurst: 0,     // small impulse
  danger: 0,        // 0..1 (ramps with time)

  // boss
  boss: null,

  // gameplay settings (safe defaults; AI can override via SPEC)
  settings: {
    roundSeconds: 30,
    winGoal: 50,
    enemySpawnBase: 0.85,     // seconds
    enemySpawnMin: 0.22,
    projectileSpeed: 620,
    playerSpeed: 260,
  },
};

function readSpecSettings(){
  try{
    const s = (SPEC && SPEC.defaultSettings) ? SPEC.defaultSettings : {};
    if (typeof s.roundSeconds === "number") GAME.settings.roundSeconds = clamp(s.roundSeconds, 10, 300);
    if (typeof s.winGoal === "number") GAME.settings.winGoal = clamp(s.winGoal, 1, 9999);
  }catch{}
}

function makeStage(){
  // Create the 9:16 game stage inside #gameRoot
  if (!gameRoot) return;

  const stage = document.createElement("div");
  stage.className = "game-stage";

  const canvas = document.createElement("canvas");
  canvas.style.width = "100%";
  canvas.style.height = "100%";
  canvas.style.display = "block";
  stage.appendChild(canvas);

  // HUD elements (using CSS helpers)
  const hud = document.createElement("div");
  hud.className = "hud";

  const hudTop = document.createElement("div");
  hudTop.className = "hud-top";

  const chipLeft = document.createElement("div");
  chipLeft.className = "hud-chip";
  chipLeft.id = "hudLeft";
  chipLeft.textContent = "Demo: running";

  const chipRight = document.createElement("div");
  chipRight.className = "hud-chip";
  chipRight.id = "hudRight";
  chipRight.textContent = "Energy: 0%";

  hudTop.appendChild(chipLeft);
  hudTop.appendChild(chipRight);
  hud.appendChild(hudTop);

  const meter = document.createElement("div");
  meter.className = "meter";
  const fill = document.createElement("div");
  fill.className = "fill";
  fill.id = "energyFill";
  meter.appendChild(fill);
  hud.appendChild(meter);

  stage.appendChild(hud);
  gameRoot.innerHTML = "";
  gameRoot.appendChild(stage);

  GAME.stageEl = stage;
  GAME.canvas = canvas;
  GAME.ctx = canvas.getContext("2d", { alpha: true });

  function resize(){
    const rect = stage.getBoundingClientRect();
    GAME.dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    GAME.w = Math.max(1, Math.floor(rect.width * GAME.dpr));
    GAME.h = Math.max(1, Math.floor(rect.height * GAME.dpr));
    canvas.width = GAME.w;
    canvas.height = GAME.h;
  }
  window.addEventListener("resize", resize);
  resize();
}

function initStars(){
  GAME.stars.length = 0;
  const count = 90;
  for (let i = 0; i < count; i++){
    GAME.stars.push({
      x: Math.random(),
      y: Math.random(),
      z: Math.random(),
      tw: Math.random(),
    });
  }
}

function resetRun(){
  GAME.particles.length = 0;
  GAME.enemies.length = 0;
  GAME.projectiles.length = 0;
  GAME.players.clear();
  GAME.boss = null;
  GAME.energy = 0;
  GAME.likeBurst = 0;
  GAME.danger = 0;
}

function spawnParticle(x, y, vx, vy, life, size, a, b){
  GAME.particles.push({
    x, y, vx, vy,
    life,
    t: 0,
    size,
    a: a || "rgba(0,242,234,.9)",
    b: b || "rgba(255,0,80,.9)",
  });
}

function burst(x, y, power){
  const p = clamp(power || 1, 0.4, 3.2);
  const n = Math.floor(14 * p);
  for (let i = 0; i < n; i++){
    const ang = rand(0, Math.PI * 2);
    const sp = rand(120, 520) * p;
    const vx = Math.cos(ang) * sp;
    const vy = Math.sin(ang) * sp;
    spawnParticle(x, y, vx, vy, rand(0.35, 0.85), rand(1.5, 3.6) * p);
  }
}

function addEnemy(tier){
  const w = GAME.w, h = GAME.h;
  const side = Math.random() < 0.5 ? -1 : 1;
  const x = (side < 0) ? -40 : (w + 40);
  const y = rand(h * 0.15, h * 0.85);
  const t = clamp(tier || 1, 1, 5);
  const r = 10 + t * 6;
  const hp = 1 + Math.floor(t * 1.2);
  GAME.enemies.push({
    x, y,
    vx: side < 0 ? rand(70, 140) : -rand(70, 140),
    vy: rand(-25, 25),
    r,
    hp,
    tier: t,
  });
}

function ensurePlayer(user){
  const u = user || {};
  const id = safeStr(u.userId || u.uniqueId || u.nickname || u.id || ("guest_" + Math.floor(Math.random()*1e9)));
  let p = GAME.players.get(id);
  if (p) return p;

  // spawn near bottom center with slight randomness
  const w = GAME.w, h = GAME.h;
  p = {
    id,
    name: safeStr(u.nickname || u.uniqueId || id),
    pfp: u.profilePictureUrl || "",
    x: w * 0.5 + rand(-w * 0.18, w * 0.18),
    y: h * 0.72 + rand(-h * 0.10, h * 0.10),
    vx: 0, vy: 0,
    r: 14,
    score: 0,
    lastShot: 0,
    shield: 0,
    hue: rand(0, 360),
  };
  GAME.players.set(id, p);

  pushFlag("chat", u, "Joined the arena!", "tint-aqua");
  burst(p.x, p.y, 1.1);

  return p;
}

function shootFromPlayer(p, power){
  const t = now();
  if (t - p.lastShot < 180) return;
  p.lastShot = t;

  const sp = GAME.settings.projectileSpeed * (0.9 + power * 0.35);
  const ang = rand(-0.25, 0.25) + (-Math.PI / 2);
  GAME.projectiles.push({
    x: p.x,
    y: p.y - p.r - 6,
    vx: Math.cos(ang) * sp,
    vy: Math.sin(ang) * sp,
    r: 5 + power * 2,
    life: 1.2,
    t: 0,
    owner: p.id,
    power: power,
  });
}

function applyLikeImpulse(amount){
  const a = clamp(amount || 1, 1, 1000);
  const inc = clamp(a / 2500, 0.004, 0.06);
  GAME.energy = clamp(GAME.energy + inc, 0, 1);
  GAME.likeBurst = clamp(GAME.likeBurst + inc * 1.4, 0, 1);
}

function giftTierFromData(data){
  // keep stable, no assumptions: use repeatCount / diamondCount if present
  const d = data || {};
  const diamonds = Number(d.diamondCount || d.diamond || 0);
  const repeat = Number(d.repeatCount || d.repeat || 1);
  const value = Math.max(1, diamonds * repeat);

  if (value >= 1000) return 3; // big
  if (value >= 100)  return 2; // medium
  return 1;                   // small
}

function applyGiftPower(data){
  const tier = giftTierFromData(data);
  const who = getUserFromMessage(data || {}) || { nickname: "Viewer", userId: "gift" };

  if (tier === 1){
    // small: rapid shots from all players
    pushFlag("gift", who, "Power-up: Rapid Fire!", "tint-aqua");
    GAME.players.forEach(p => { for (let i=0;i<2;i++) shootFromPlayer(p, 0.7 + GAME.energy); });
    burst(GAME.w*0.5, GAME.h*0.4, 1.2);
  } else if (tier === 2){
    // medium: shield + extra energy
    pushFlag("gift", who, "Power-up: Team Shield!", "tint-pink");
    GAME.players.forEach(p => { p.shield = Math.max(p.shield, 2.8); });
    GAME.energy = clamp(GAME.energy + 0.22, 0, 1);
    burst(GAME.w*0.5, GAME.h*0.45, 1.9);
  } else {
    // big: boss spawn (or boss nuke if already present)
    if (!GAME.boss){
      pushFlag("gift", who, "ULTIMATE: Boss Incoming!", "tint-pink");
      GAME.boss = {
        x: GAME.w * 0.5,
        y: GAME.h * 0.18,
        vx: rand(-90, 90),
        vy: 0,
        r: 44,
        hp: 45,
        t: 0
      };
      burst(GAME.boss.x, GAME.boss.y, 2.8);
    }else{
      pushFlag("gift", who, "ULTIMATE: Boss Nuke!", "tint-pink");
      // nuke all enemies and damage boss
      GAME.enemies.forEach(e => burst(e.x, e.y, 1.6));
      GAME.enemies.length = 0;
      GAME.boss.hp = Math.max(0, GAME.boss.hp - 18);
      burst(GAME.boss.x, GAME.boss.y, 3.2);
    }
  }
}

/* =========================================================
   Message parsing helpers (stable + safe)
   - TikTokClient emits objects with varying shapes; we normalize.
========================================================= */
function getChatTextFromMessage(msg){
  try{
    const m = msg || {};
    // common possibilities:
    return safeStr(m.comment || m.text || m.message || m.msg || m.content || "");
  }catch{
    return "";
  }
}

function getUserFromMessage(msg){
  try{
    const m = msg || {};
    const u = m.user || m.userInfo || m.sender || m.author || m.profile || {};
    // normalize fields used in UI + gameplay
    const userId = safeStr(u.userId || u.id || u.uniqueId || m.userId || m.uniqueId || "");
    const uniqueId = safeStr(u.uniqueId || u.username || m.uniqueId || "");
    const nickname = safeStr(u.nickname || u.displayName || m.nickname || uniqueId || userId || "Viewer");
    const profilePictureUrl =
      safeStr(u.profilePictureUrl || u.avatarThumb || u.avatar || u.pfp || m.profilePictureUrl || "");
    return { userId: userId || uniqueId || nickname, uniqueId, nickname, profilePictureUrl };
  }catch{
    return { userId: "viewer", uniqueId: "", nickname: "Viewer", profilePictureUrl: "" };
  }
}

function normalizeText(t){
  return safeStr(t).trim().toLowerCase();
}

function normalizeTeamText(text){
  // kept for compatibility with your working pattern (can be used by AI_REGION)
  const t = normalizeText(text);
  if (!t) return null;
  if (t.includes("red")) return "red";
  if (t.includes("blue")) return "blue";
  if (t.includes("green")) return "green";
  if (t.includes("yellow")) return "yellow";
  return null;
}

function normalizeAnswerText(text){
  // kept for compatibility with your working pattern (can be used by AI_REGION)
  const t = normalizeText(text);
  if (!t) return null;
  if (t === "a" || t.includes(" a ")) return "A";
  if (t === "b" || t.includes(" b ")) return "B";
  if (t === "c" || t.includes(" c ")) return "C";
  if (t === "d" || t.includes(" d ")) return "D";
  return null;
}

/* =========================================================
   ✅ WORKING TIKTOK CONNECTION EXAMPLE (DO NOT REMOVE)
   (verbatim structure + error handling style; used as reference)
========================================================= */

// 7. TikTok message handling
// ===============================

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
}

/* =========================================================
   Actual game message handling (Orb Arena)
   - Uses same safe patterns (try/catch + normalize)
========================================================= */
let client = null;

// demo state + stable gates (separate from the example snippet variables)
let gameStarted = false;
let gameFinished = false;
let pendingStart = false;

// These exist only to keep the example snippet intact (not used by Orb Arena).
// They must NOT break runtime.
const userTeams = new Map();
const answeredUsersThisQuestion = new Map();
const teamScores = { red:0, blue:0, green:0, yellow:0 };
const teamRoundScores = { red:0, blue:0, green:0, yellow:0 };
const roundAnswerCounts = { red:0, blue:0, green:0, yellow:0 };
function updateScoreDisplay(){}
function flashCorrectAnswer(){}
function updateRoundDuelBar(){}
function getCurrentQuestion(){ return null; }
function beginGame(){ /* Orb Arena uses beginOrbArena() */ }

function orbOnChatMessage(data){
  try{
    const msg = data || {};
    const text = getChatTextFromMessage(msg);
    const user = getUserFromMessage(msg);
    if (!text) return;

    const t = normalizeText(text);

    // “join” is always supported
    if (t === "join" || t === "!join" || t.includes(" join")){
      ensurePlayer(user);
      return;
    }

    // quick “shoot”
    if (t === "shoot" || t === "!shoot" || t.includes(" shoot")){
      const p = ensurePlayer(user);
      shootFromPlayer(p, 0.8 + GAME.energy);
      pushFlag("chat", user, "Shoot!", "tint-aqua");
      return;
    }

    // “shield”
    if (t === "shield" || t === "!shield" || t.includes(" shield")){
      const p = ensurePlayer(user);
      p.shield = Math.max(p.shield, 2.2);
      pushFlag("chat", user, "Shield up!", "tint-pink");
      burst(p.x, p.y, 1.6);
      return;
    }

    // “bomb” (requires some energy)
    if (t === "bomb" || t === "!bomb" || t.includes(" bomb")){
      const need = 0.35;
      if (GAME.energy < need){
        pushFlag("chat", user, "Need more likes (energy) for BOMB!", "tint-dark");
        return;
      }
      GAME.energy = clamp(GAME.energy - need, 0, 1);
      pushFlag("chat", user, "BOMB!", "tint-pink");

      // clear enemies + damage boss
      for (let i=0;i<GAME.enemies.length;i++){
        burst(GAME.enemies[i].x, GAME.enemies[i].y, 1.4);
      }
      GAME.enemies.length = 0;
      if (GAME.boss) GAME.boss.hp = Math.max(0, GAME.boss.hp - 10);
      burst(GAME.w*0.5, GAME.h*0.45, 2.3);
      return;
    }

    // AI_REGION can add more commands/actions.
    // fallthrough: small reaction flag (non-blocking)
    pushFlag("chat", user, text, "tint-dark");
  }catch(e){
    console.error("Error in chat handler:", e);
  }
}

function orbOnGiftMessage(data){
  try{
    applyGiftPower(data);
  }catch(e){
    console.error("Error in gift handler:", e);
  }
}

function orbOnLikeMessage(data){
  try{
    // likes can be a count; we normalize
    const c = Number((data && (data.likeCount || data.count || data.likes)) || 1);
    applyLikeImpulse(isFinite(c) ? c : 1);

    const u = getUserFromMessage(data || {});
    // only show occasional like flags (avoid spam)
    if (Math.random() < 0.08){
      pushFlag("like", u, "Likes boosted energy!", "tint-aqua");
    }
  }catch(e){
    console.error("Error in like handler:", e);
  }
}

/* =========================================================
   Orb Arena: loop + collisions
========================================================= */
let enemySpawnTimer = 0;

function step(dt){
  const w = GAME.w, h = GAME.h;
  if (!w || !h || !GAME.ctx) return;

  // meters
  GAME.likeBurst *= Math.pow(0.001, dt); // quick decay
  GAME.danger = clamp(GAME.danger + dt * 0.012, 0, 1);
  // energy slowly decays
  GAME.energy = clamp(GAME.energy - dt * 0.02, 0, 1);

  // spawn enemies (faster with danger + energy)
  const spd = clamp(1 - (GAME.danger * 0.55 + GAME.energy * 0.55), 0.25, 1);
  const interval = clamp(GAME.settings.enemySpawnBase * spd, GAME.settings.enemySpawnMin, 1.2);

  enemySpawnTimer -= dt;
  if (enemySpawnTimer <= 0){
    enemySpawnTimer = interval;

    // tier ramps
    const tier = 1 + Math.floor(GAME.danger * 3.2 + GAME.energy * 1.8);
    addEnemy(clamp(tier, 1, 5));
  }

  // boss behavior
  if (GAME.boss){
    const b = GAME.boss;
    b.t += dt;
    b.x += b.vx * dt;
    // bounce
    if (b.x < b.r){ b.x = b.r; b.vx *= -1; }
    if (b.x > w - b.r){ b.x = w - b.r; b.vx *= -1; }
    // occasional pulse spawn
    if (Math.floor(b.t * 2) !== Math.floor((b.t - dt) * 2)){
      addEnemy(4);
      addEnemy(3);
    }
    if (b.hp <= 0){
      burst(b.x, b.y, 3.3);
      GAME.boss = null;
    }
  }

  // players idle drift + shield decay
  GAME.players.forEach((p) => {
    p.shield = Math.max(0, p.shield - dt);
    // slight drift for life
    p.vx += Math.sin((now()*0.001) + p.hue) * 6 * dt;
    p.vy += Math.cos((now()*0.0012) + p.hue) * 6 * dt;
    p.vx *= Math.pow(0.001, dt);
    p.vy *= Math.pow(0.001, dt);

    p.x = clamp(p.x + p.vx, p.r, w - p.r);
    p.y = clamp(p.y + p.vy, p.r, h - p.r);
  });

  // projectiles
  for (let i = GAME.projectiles.length - 1; i >= 0; i--){
    const pr = GAME.projectiles[i];
    pr.t += dt;
    pr.x += pr.vx * dt;
    pr.y += pr.vy * dt;
    if (pr.t > pr.life || pr.y < -60 || pr.x < -80 || pr.x > w + 80){
      GAME.projectiles.splice(i, 1);
      continue;
    }

    // hit enemies
    for (let j = GAME.enemies.length - 1; j >= 0; j--){
      const e = GAME.enemies[j];
      const dx = pr.x - e.x;
      const dy = pr.y - e.y;
      const rr = pr.r + e.r;
      if (dx*dx + dy*dy <= rr*rr){
        e.hp -= 1 + Math.floor(pr.power * 0.9);
        burst(pr.x, pr.y, 1.0 + pr.power * 0.6);
        GAME.projectiles.splice(i, 1);

        if (e.hp <= 0){
          burst(e.x, e.y, 1.5 + e.tier * 0.3);
          GAME.enemies.splice(j, 1);
          // reward
          GAME.energy = clamp(GAME.energy + 0.05 + e.tier * 0.01, 0, 1);
        }
        break;
      }
    }

    // hit boss
    if (GAME.boss){
      const b = GAME.boss;
      const dx = pr.x - b.x;
      const dy = pr.y - b.y;
      const rr = pr.r + b.r;
      if (dx*dx + dy*dy <= rr*rr){
        b.hp -= 1 + Math.floor(pr.power * 1.2);
        burst(pr.x, pr.y, 1.3 + pr.power);
        GAME.projectiles.splice(i, 1);
      }
    }
  }

  // enemies movement + collisions with players
  for (let i = GAME.enemies.length - 1; i >= 0; i--){
    const e = GAME.enemies[i];
    e.x += e.vx * dt;
    e.y += e.vy * dt;

    // gentle wander
    e.vy += Math.sin((now()*0.001) + e.x * 0.001) * 18 * dt;
    e.vy *= Math.pow(0.001, dt);

    // remove off-screen
    if (e.x < -120 || e.x > w + 120){
      GAME.enemies.splice(i, 1);
      continue;
    }

    // collide with players (damage shield / burst)
    GAME.players.forEach((p) => {
      const dx = e.x - p.x;
      const dy = e.y - p.y;
      const rr = e.r + p.r + (p.shield > 0 ? 10 : 0);
      if (dx*dx + dy*dy <= rr*rr){
        // hit FX
        burst((e.x + p.x)/2, (e.y + p.y)/2, 1.3);
        // knock
        const inv = 1 / Math.max(1, Math.sqrt(dx*dx + dy*dy));
        p.vx -= dx * inv * 80;
        p.vy -= dy * inv * 80;

        // shield absorbs
        if (p.shield > 0){
          p.shield = Math.max(0, p.shield - 0.6);
          e.hp -= 1;
        }else{
          e.hp -= 1;
        }

        if (e.hp <= 0){
          burst(e.x, e.y, 1.4);
          // remove this enemy
          const idx = GAME.enemies.indexOf(e);
          if (idx >= 0) GAME.enemies.splice(idx, 1);
        }
      }
    });
  }

  // particles
  for (let i = GAME.particles.length - 1; i >= 0; i--){
    const p = GAME.particles[i];
    p.t += dt;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.vx *= Math.pow(0.001, dt);
    p.vy *= Math.pow(0.001, dt);
    if (p.t >= p.life) GAME.particles.splice(i, 1);
  }

  // autopilot demo shooting
  const shootChance = 0.04 + GAME.energy * 0.12 + GAME.likeBurst * 0.25;
  if (Math.random() < shootChance){
    // ensure at least 1 demo player exists so action is visible
    const demo = ensurePlayer({ userId: "demo", nickname: "Demo", profilePictureUrl: "" });
    shootFromPlayer(demo, 0.65 + GAME.energy);
  }

  // update HUD
  const hudLeft = document.getElementById("hudLeft");
  const hudRight = document.getElementById("hudRight");
  const fill = document.getElementById("energyFill");

  if (hudLeft){
    hudLeft.textContent = (GAME.connected ? "LIVE: connected" : "Demo: running") + " • Players: " + GAME.players.size;
  }
  if (hudRight){
    hudRight.textContent = "Energy: " + Math.round(GAME.energy * 100) + "%";
  }
  if (fill){
    fill.style.width = Math.round(GAME.energy * 100) + "%";
  }
}

function draw(){
  const ctx = GAME.ctx;
  const w = GAME.w, h = GAME.h;
  if (!ctx || !w || !h) return;

  ctx.clearRect(0, 0, w, h);

  // starfield
  ctx.save();
  ctx.globalAlpha = 0.9;
  for (let i=0;i<GAME.stars.length;i++){
    const s = GAME.stars[i];
    const px = s.x * w;
    const py = s.y * h;
    const tw = 0.4 + 0.6 * Math.abs(Math.sin((now()*0.0012) + s.tw*10));
    const r = 0.6 + s.z * 1.6;
    ctx.fillStyle = `rgba(255,255,255,${0.12 + tw*0.18})`;
    ctx.beginPath();
    ctx.arc(px, py, r, 0, Math.PI*2);
    ctx.fill();
  }
  ctx.restore();

  // soft vignette
  ctx.save();
  const g = ctx.createRadialGradient(w*0.5, h*0.5, Math.min(w,h)*0.1, w*0.5, h*0.5, Math.min(w,h)*0.75);
  g.addColorStop(0, "rgba(0,0,0,0)");
  g.addColorStop(1, "rgba(0,0,0,0.32)");
  ctx.fillStyle = g;
  ctx.fillRect(0,0,w,h);
  ctx.restore();

  // enemies
  for (let i=0;i<GAME.enemies.length;i++){
    const e = GAME.enemies[i];
    ctx.save();
    ctx.translate(e.x, e.y);

    // glow
    ctx.shadowBlur = 18;
    ctx.shadowColor = "rgba(255,0,80,.35)";
    ctx.fillStyle = "rgba(255,0,80,.18)";
    ctx.beginPath();
    ctx.arc(0,0,e.r+6,0,Math.PI*2);
    ctx.fill();

    ctx.shadowBlur = 0;
    ctx.fillStyle = "rgba(255,255,255,.85)";
    ctx.beginPath();
    ctx.arc(0,0,e.r,0,Math.PI*2);
    ctx.fill();

    ctx.strokeStyle = "rgba(0,242,234,.45)";
    ctx.lineWidth = 2 * GAME.dpr;
    ctx.beginPath();
    ctx.arc(0,0,e.r-2,0,Math.PI*2);
    ctx.stroke();

    ctx.restore();
  }

  // boss
  if (GAME.boss){
    const b = GAME.boss;
    ctx.save();
    ctx.translate(b.x, b.y);

    ctx.shadowBlur = 28;
    ctx.shadowColor = "rgba(255,0,80,.55)";
    ctx.fillStyle = "rgba(255,0,80,.22)";
    ctx.beginPath();
    ctx.arc(0,0,b.r+14,0,Math.PI*2);
    ctx.fill();

    ctx.shadowBlur = 0;
    ctx.fillStyle = "rgba(0,0,0,.25)";
    ctx.beginPath();
    ctx.arc(0,0,b.r,0,Math.PI*2);
    ctx.fill();

    ctx.strokeStyle = "rgba(0,242,234,.55)";
    ctx.lineWidth = 3 * GAME.dpr;
    ctx.beginPath();
    ctx.arc(0,0,b.r-4,0,Math.PI*2);
    ctx.stroke();

    // HP bar
    const hp = clamp(b.hp / 45, 0, 1);
    ctx.fillStyle = "rgba(0,0,0,.35)";
    ctx.fillRect(-b.r, b.r+16, b.r*2, 8*GAME.dpr);
    ctx.fillStyle = "rgba(255,0,80,.85)";
    ctx.fillRect(-b.r, b.r+16, b.r*2*hp, 8*GAME.dpr);

    ctx.restore();
  }

  // players
  GAME.players.forEach((p) => {
    ctx.save();
    ctx.translate(p.x, p.y);

    // shield ring
    if (p.shield > 0){
      const a = clamp(p.shield / 3, 0, 1);
      ctx.strokeStyle = `rgba(0,242,234,${0.25 + a*0.55})`;
      ctx.lineWidth = 3 * GAME.dpr;
      ctx.beginPath();
      ctx.arc(0,0,p.r+10,0,Math.PI*2);
      ctx.stroke();
    }

    // core
    ctx.shadowBlur = 18;
    ctx.shadowColor = "rgba(0,242,234,.35)";
    ctx.fillStyle = "rgba(0,242,234,.14)";
    ctx.beginPath();
    ctx.arc(0,0,p.r+6,0,Math.PI*2);
    ctx.fill();

    ctx.shadowBlur = 0;
    ctx.fillStyle = "rgba(255,255,255,.88)";
    ctx.beginPath();
    ctx.arc(0,0,p.r,0,Math.PI*2);
    ctx.fill();

    // label
    ctx.fillStyle = "rgba(247,247,251,.85)";
    ctx.font = `${12*GAME.dpr}px ${getComputedStyle(document.body).fontFamily}`;
    const nm = p.name.length > 12 ? p.name.slice(0,12) + "…" : p.name;
    ctx.fillText(nm, -p.r, -p.r - 12*GAME.dpr);

    ctx.restore();
  });

  // projectiles
  for (let i=0;i<GAME.projectiles.length;i++){
    const pr = GAME.projectiles[i];
    ctx.save();
    ctx.translate(pr.x, pr.y);

    ctx.shadowBlur = 16;
    ctx.shadowColor = "rgba(0,242,234,.35)";
    ctx.fillStyle = "rgba(0,242,234,.95)";
    ctx.beginPath();
    ctx.arc(0,0,pr.r,0,Math.PI*2);
    ctx.fill();

    ctx.shadowBlur = 0;
    ctx.strokeStyle = "rgba(255,0,80,.55)";
    ctx.lineWidth = 2 * GAME.dpr;
    ctx.beginPath();
    ctx.arc(0,0,pr.r+1,0,Math.PI*2);
    ctx.stroke();

    ctx.restore();
  }

  // particles
  for (let i=0;i<GAME.particles.length;i++){
    const p = GAME.particles[i];
    const k = 1 - (p.t / p.life);
    ctx.save();
    ctx.globalAlpha = k;
    const col = (Math.random() < 0.5) ? p.a : p.b;
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.size * k * GAME.dpr, 0, Math.PI*2);
    ctx.fill();
    ctx.restore();
  }
}

function loop(t){
  if (!GAME.running) return;

  if (!GAME.lastT) GAME.lastT = t;
  const dt = clamp((t - GAME.lastT) / 1000, 0, 0.05);
  GAME.lastT = t;

  step(dt);
  draw();

  requestAnimationFrame(loop);
}

/* =========================================================
   Connect flow (connect-first; start after connected)
========================================================= */
async function connectAndStart(liveId){
  try{
    const id = safeStr(liveId || "").trim().replace(/^@/,"");
    if (!id) throw new Error("LIVE ID is required");

    // Ensure proto exists (or fail gracefully)
    const okProto = await ensureProtoReady();
    if (!okProto){
      setStatus("Missing proto. Preview must provide proto bundle(s). Game will run in demo mode.", false);
      pushFlag("chat", { nickname: "System" }, "Proto missing — running demo only.", "tint-dark");
      return;
    }

    if (!hasTikTokClient()){
      setStatus("TikTokClient missing. Game will run in demo mode.", false);
      pushFlag("chat", { nickname: "System" }, "TikTokClient missing — running demo only.", "tint-dark");
      return;
    }

    // close previous
    if (client && client.socket){
      try{ client.socket.close(); }catch{}
    }

    client = new window.TikTokClient(id);

    if (typeof window.CHATTOK_CREATOR_TOKEN !== "undefined" && window.CHATTOK_CREATOR_TOKEN){
      client.setAccessToken(window.CHATTOK_CREATOR_TOKEN);
    }

    client.on("connected", () => {
      GAME.connected = true;
      setStatus("Connected to TikTok LIVE.", true);
      hideOverlay();
      gameStarted = true;
      pendingStart = false;
      pushFlag("chat", { nickname: "System" }, "Connected — chat now controls the arena!", "tint-aqua");
    });

    client.on("disconnected", (reason) => {
      GAME.connected = false;
      const msg = reason || "Connection closed";
      setStatus("Disconnected: " + msg, false);

      // allow retry if never fully started
      if (!gameStarted){
        pendingStart = false;
        showOverlay();
      }
    });

    client.on("error", (err) => {
      GAME.connected = false;
      setStatus("Error: " + (err && err.message ? err.message : "Unknown"), false);
      showOverlay();
      pendingStart = false;
    });

    // Hook Orb Arena handlers (not the reference snippet)
    client.on("chat", orbOnChatMessage);
    client.on("gift", orbOnGiftMessage);
    client.on("like", orbOnLikeMessage);

    pendingStart = true;
    setStatus("Connecting…", false);
    client.connect();
  }catch(e){
    console.error(e);
    pendingStart = false;
    setStatus(e?.message || String(e), false);
    showOverlay();
  }
}

/* =========================================================
   AI REGION (server may inject compact mechanics here)
   KEEP IT SMALL: only add/adjust commands, balance, visuals.
========================================================= */
/* === AI_REGION_START === */
/*
  AI: You may only modify code inside this region.
  Goals:
  - Add 2–4 additional chat commands that create visible actions.
  - Make likes/gifts feel impactful (without spamming flags).
  - Keep everything safe + stable (no DOM assumptions beyond IDs).
  - Do NOT add debug buttons.

  Example additions:
  - "!dash" -> quick player boost
  - "!spawn" -> spawn a wave
  - "meteor" -> call down meteors
*/
/* === AI_REGION_END === */

/* =========================================================
   Start
========================================================= */
function start(){
  try{
    readSpecSettings();
    makeStage();
    initStars();
    resetRun();

    // Always start the loop immediately (demo visible behind overlay)
    GAME.running = true;
    requestAnimationFrame(loop);

    showOverlay();
    setStatus("Not connected", false);

    // Button: connect-first
    if (startGameBtn){
      startGameBtn.addEventListener("click", async () => {
        try{
          const liveId = liveIdInput ? liveIdInput.value : "";
          await connectAndStart(liveId);
        }catch(e){
          setStatus(e?.message || "Failed to start", false);
        }
      });
    }

    // Light heartbeat flags for demo so it never feels dead
    setTimeout(() => {
      pushFlag("chat", { nickname:"System" }, "Type JOIN to enter • SHOOT / SHIELD / BOMB", "tint-dark");
    }, 700);

  }catch(e){
    console.error(e);
    setStatus("Startup error: " + (e?.message || String(e)), false);
    showOverlay();
  }
}

if (document.readyState === "loading"){
  document.addEventListener("DOMContentLoaded", start);
}else{
  start();
}
