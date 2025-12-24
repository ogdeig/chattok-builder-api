/* =========================================================
   ChatTok Game Template — game.template.js (NO DEMO MODE)
   - Game starts after successful TikTok connection.
   - Uses TikTokClient provided by ChatTokGaming (do not edit tiktok-client.js).
   - AI fills ONLY the AI_REGION.
   - SPEC is injected by server during generation.

   Injected server-side:
   const SPEC = __SPEC_JSON__;
========================================================= */

const SPEC = __SPEC_JSON__;

/* =========================================================
   DOM refs (must exist in index.template.html)
========================================================= */
const setupOverlay = document.getElementById("setupOverlay");
const startGameBtn = document.getElementById("startGameBtn");
const liveIdInput = document.getElementById("liveIdInput");
const statusText = document.getElementById("statusText");
const statusTextInGame = document.getElementById("statusTextInGame");
const gameRoot = document.getElementById("gameRoot");

/* =========================================================
   Utilities
========================================================= */
function clamp(v, a, b) { v = Number(v) || 0; return Math.max(a, Math.min(b, v)); }
function nowMs() { return Date.now(); }
function rand(a, b) { return a + Math.random() * (b - a); }
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function safeText(s, max = 80) { return String(s || "").trim().replace(/\s+/g, " ").slice(0, max); }

function showOverlay() { if (setupOverlay) setupOverlay.style.display = ""; }
function hideOverlay() { if (setupOverlay) setupOverlay.style.display = "none"; }

function setStatus(msg, ok = true) {
  const t = String(msg || "");
  if (statusText) {
    statusText.textContent = t;
    statusText.style.color = ok ? "rgba(255,255,255,.9)" : "rgba(255,120,120,.95)";
  }
  if (statusTextInGame) {
    statusTextInGame.textContent = t;
    statusTextInGame.style.color = ok ? "rgba(255,255,255,.78)" : "rgba(255,120,120,.95)";
  }
  const pill = document.getElementById("connPill");
  if (pill) {
    if (/connected/i.test(t)) pill.classList.add("connected");
    else pill.classList.remove("connected");
  }
}

/* =========================================================
   Robust TikTok message shape helpers
========================================================= */
function getChatTextFromMessage(msg) {
  const m = msg || {};
  const t = m.content ?? m.comment ?? m.text ?? m.message ?? m.msg ?? "";
  return String(t || "").trim();
}
function firstUrl(v) {
  if (!v) return "";
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return typeof v[0] === "string" ? v[0] : "";
  return "";
}
function getAvatarUrlFromUser(u) {
  if (!u || typeof u !== "object") return "";
  const direct = firstUrl(u.profilePictureUrl || u.profilePicture || u.avatar || u.pfp || u.avatarUrl);
  if (direct) return direct;
  const a1 = u.avatarThumb || u.avatarthumb || null;
  if (a1) {
    const list = a1.urlList || a1.url_list || a1.urllist || a1.urlListList || a1.url_list_list;
    const pick1 = firstUrl(list);
    if (pick1) return pick1;
  }
  return "";
}
function getUserFromMessage(msg) {
  const m = msg || {};
  const u = m.user || m.userInfo || m.userinfo || m.sender || m.from || {};
  const userId = String(u.userId ?? u.userid ?? u.id ?? m.userId ?? m.userid ?? m.user_id ?? "") || "";
  const uniqueId = String(u.uniqueId ?? u.uniqueid ?? u.username ?? u.handle ?? m.uniqueId ?? m.uniqueid ?? "") || "";
  const nickname = String(u.nickname ?? u.displayName ?? u.name ?? m.nickname ?? "") || uniqueId || "viewer";
  const avatar = getAvatarUrlFromUser(u) || firstUrl(m.profilePictureUrl) || "";
  return { userId, uniqueId, nickname, avatar };
}
function normalizeChat(m) { const user = getUserFromMessage(m); return { type: "chat", userId: user.userId, uniqueId: user.uniqueId, nickname: user.nickname, pfp: user.avatar || "", text: getChatTextFromMessage(m), raw: m }; }
function normalizeLike(m) { const user = getUserFromMessage(m); const count = Number(m.likeCount ?? m.count ?? m.totalLikeCount ?? 1) || 1; return { type: "like", userId: user.userId, uniqueId: user.uniqueId, nickname: user.nickname, pfp: user.avatar || "", count, raw: m }; }
function normalizeGift(m) {
  const user = getUserFromMessage(m);
  const giftName = String(m.giftName ?? m.gift?.name ?? m.gift?.giftName ?? "Gift");
  const repeat = Number(m.repeatCount ?? m.repeat ?? m.count ?? 1) || 1;
  const diamond = Number(m.diamondCount ?? m.diamonds ?? m.gift?.diamondCount ?? 0) || 0;
  return { type: "gift", userId: user.userId, uniqueId: user.uniqueId, nickname: user.nickname, pfp: user.avatar || "", giftName, repeat, diamond, raw: m };
}
function normalizeJoin(m) { const user = getUserFromMessage(m); return { type: "join", userId: user.userId, uniqueId: user.uniqueId, nickname: user.nickname, pfp: user.avatar || "", raw: m }; }

/* =========================================================
   UI build (stage/topbar/playcard/hud)
========================================================= */
let canvas, ctx; let W = 0, H = 0, DPR = 1; let ui = {};
function clearEl(el) { if (!el) return; while (el.firstChild) el.removeChild(el.firstChild); }

function buildUI() {
  if (!gameRoot) return;
  clearEl(gameRoot);

  const stage = document.createElement("div");
  stage.className = "stage";

  // Topbar
  const topbar = document.createElement("div");
  topbar.className = "topbar";

  const brand = document.createElement("div");
  brand.className = "brand";
  const title = document.createElement("div");
  title.className = "title";
  title.textContent = safeText((SPEC && SPEC.title) || "ChatTok Game", 48);
  const sub = document.createElement("div");
  sub.className = "sub";
  sub.textContent = safeText((SPEC && SPEC.subtitle) || "Connect to TikTok LIVE to start.", 90);
  brand.appendChild(title);
  brand.appendChild(sub);

  const pill = document.createElement("div");
  pill.id = "connPill";
  pill.className = "pill";
  pill.innerHTML = `<span class="dot"></span><strong>LIVE</strong><span id="pillStatus">Offline</span>`;

  topbar.appendChild(brand);
  topbar.appendChild(pill);

  // Playcard
  const playcard = document.createElement("div");
  playcard.className = "playcard";

  canvas = document.createElement("canvas");
  canvas.className = "gameCanvas";
  canvas.id = "gameCanvas";
  playcard.appendChild(canvas);

  // HUD
  const hud = document.createElement("div");
  hud.className = "hud";

  const left = document.createElement("div");
  left.className = "left";
  left.innerHTML = `
    <div class="stat"><div class="k">Score</div><div class="v" id="hudScore">0</div></div>
    <div class="stat"><div class="k">Players</div><div class="v" id="hudPlayers">0</div></div>
  `;

  const meterWrap = document.createElement("div");
  meterWrap.style.flex = "1";
  meterWrap.innerHTML = `
    <div class="stat" style="margin-bottom:6px">
      <div class="k">Power Meter (Likes)</div>
    </div>
    <div class="meter"><i id="hudMeter"></i></div>
  `;

  const right = document.createElement("div");
  right.className = "right";
  right.innerHTML = `
    <div class="stat"><div class="k">Likes</div><div class="v" id="hudLikes">0</div></div>
    <div class="stat"><div class="k">Gifts</div><div class="v" id="hudGifts">0</div></div>
  `;

  hud.appendChild(left);
  hud.appendChild(meterWrap);
  hud.appendChild(right);

  const flags = document.createElement("div");
  flags.id = "flags";

  stage.appendChild(topbar);
  stage.appendChild(playcard);
  stage.appendChild(hud);

  gameRoot.appendChild(stage);
  gameRoot.appendChild(flags);

  try { ctx = canvas.getContext("2d", { alpha: true, desynchronized: true }); }
  catch { ctx = canvas.getContext("2d"); }

  resizeCanvas();
  window.addEventListener("resize", resizeCanvas, { passive: true });

  ui = {
    hudScore: document.getElementById("hudScore"),
    hudPlayers: document.getElementById("hudPlayers"),
    hudLikes: document.getElementById("hudLikes"),
    hudGifts: document.getElementById("hudGifts"),
    hudMeter: document.getElementById("hudMeter"),
    flagsEl: document.getElementById("flags"),
    pillStatus: document.getElementById("pillStatus")
  };
}

function resizeCanvas() {
  if (!canvas) return;
  const r = canvas.getBoundingClientRect();
  DPR = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
  W = Math.max(1, Math.floor(r.width * DPR));
  H = Math.max(1, Math.floor(r.height * DPR));
  if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
}

/* Flags (optional UI notifications) */
function escapeHtml(s) {
  return String(s || "").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#39;");
}
function initials(name) { const s = String(name || "").trim(); if (!s) return "?"; const parts = s.split(/\s+/).slice(0, 2); return parts.map((p) => p[0]).join("").toUpperCase(); }
function flagNotify({ who, msg, pfp, cls }) {
  if (!state.uiFlagsEnabled) return;
  if (!ui.flagsEl) return;
  const wrap = document.createElement("div"); wrap.className = "flag" + (cls ? " " + String(cls) : "");
  const pfpWrap = document.createElement("div"); pfpWrap.className = "pfp";
  const img = document.createElement("img"); img.alt = ""; img.decoding = "async"; img.loading = "lazy";
  const fallback = document.createElement("div"); fallback.style.width = "100%"; fallback.style.height = "100%"; fallback.style.display = "grid"; fallback.style.placeItems = "center"; fallback.style.fontWeight = "900"; fallback.style.fontSize = "12px"; fallback.style.letterSpacing = ".6px"; fallback.style.color = "rgba(255,255,255,.92)"; fallback.textContent = initials(who || "");
  const hasPfp = typeof pfp === "string" && pfp.trim().length > 0;
  if (hasPfp) { img.src = pfp.trim(); img.onerror = () => { pfpWrap.innerHTML = ""; pfpWrap.appendChild(fallback); }; pfpWrap.appendChild(img); }
  else { pfpWrap.appendChild(fallback); }
  const text = document.createElement("div"); text.className = "txt";
  text.innerHTML = `<div class="who">${escapeHtml(who || "")}</div><div class="msg">${escapeHtml(msg || "")}</div>`;
  wrap.appendChild(pfpWrap); wrap.appendChild(text); ui.flagsEl.prepend(wrap);
  while (ui.flagsEl.childElementCount > 6) ui.flagsEl.removeChild(ui.flagsEl.lastChild);
  setTimeout(() => { try { wrap.remove(); } catch {} }, 3200);
}

/* =========================================================
   SETTINGS PANEL (optional, collapsible)
========================================================= */
function readSetting(id, fallback) {
  const el = document.getElementById(id);
  if (!el) return fallback;
  if (el.type === "checkbox") return !!el.checked;
  return String(el.value || "").trim() || fallback;
}
function ensureSettingsUI() {
  const card = setupOverlay ? setupOverlay.querySelector(".overlay-card") : null;
  if (!card) return;
  if (card.querySelector("#ctSettings")) return;

  const details = document.createElement("details");
  details.id = "ctSettings";
  details.style.marginTop = "10px";
  details.style.border = "1px solid rgba(255,255,255,.10)";
  details.style.borderRadius = "14px";
  details.style.padding = "10px";
  details.style.background = "rgba(0,0,0,.18)";

  const summary = document.createElement("summary");
  summary.textContent = "Game Settings (optional)";
  summary.style.cursor = "pointer";
  summary.style.fontWeight = "900";
  summary.style.color = "rgba(255,255,255,.9)";
  summary.style.listStyle = "none";

  const box = document.createElement("div");
  box.style.marginTop = "10px"; box.style.display = "grid"; box.style.gap = "10px";

  box.innerHTML = `
    <div class="row">
      <label class="label" for="cmdAction">Chat command (action)</label>
      <input id="cmdAction" class="input" placeholder="Example: fire" autocomplete="off" />
    </div>
    <div class="row">
      <label class="label" for="cmdJoin">Chat command (join)</label>
      <input id="cmdJoin" class="input" placeholder="Example: join" autocomplete="off" />
    </div>
    <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
      <label style="display:flex;gap:8px;align-items:center;font-size:13px;color:rgba(255,255,255,.84)">
        <input id="allowShareForAction" type="checkbox" /> Allow Shares to trigger ACTION (if available)
      </label>
      <label style="display:flex;gap:8px;align-items:center;font-size:13px;color:rgba(255,255,255,.84)">
        <input id="allowShareForJoin" type="checkbox" /> Allow Shares to trigger JOIN (if available)
      </label>
    </div>
  `;

  details.appendChild(summary); details.appendChild(box); card.appendChild(details);

  setTimeout(() => {
    const a = document.getElementById("cmdAction");
    const j = document.getElementById("cmdJoin");
    const sA = document.getElementById("allowShareForAction");
    const sJ = document.getElementById("allowShareForJoin");
    if (a && !a.value) a.value = AI.actionKeyword;
    if (j && !j.value) j.value = AI.joinKeyword;
    if (sA) sA.checked = !!AI.allowShareForActionDefault;
    if (sJ) sJ.checked = !!AI.allowShareForJoinDefault;
  }, 0);
}

/* =========================================================
   GAME ENGINE
========================================================= */
let rafId = 0; let lastT = 0;
const state = {
  connected: false, pendingStart: false, gameStarted: false,
  score: 0, players: new Map(), likes: 0, gifts: 0,
  power: 0, powerBoostUntil: 0,
  meteors: [], shots: [], explosions: [],
  stars: [],
  uiFlagsEnabled: true,
  cmdAction: "", cmdJoin: "", shareAction: false, shareJoin: false
};

function resetGameState(){
  state.score = 0; state.players.clear(); state.likes = 0; state.gifts = 0;
  state.power = 0; state.powerBoostUntil = 0; state.meteors = []; state.shots = []; state.explosions = [];
}

function updateHUD(){
  if (ui.hudScore) ui.hudScore.textContent = String(state.score);
  if (ui.hudPlayers) ui.hudPlayers.textContent = String(state.players.size);
  if (ui.hudLikes) ui.hudLikes.textContent = String(state.likes);
  if (ui.hudGifts) ui.hudGifts.textContent = String(state.gifts);
  if (ui.hudMeter) ui.hudMeter.style.width = `${Math.round(clamp(state.power, 0, 1) * 100)}%`;
  if (ui.pillStatus) ui.pillStatus.textContent = state.connected ? "Connected" : "Offline";
}

function ensureStars(){
  if (state.stars.length) return;
  const count = 90;
  for (let i = 0; i < count; i++) state.stars.push({ x: Math.random(), y: Math.random(), z: rand(0.2, 1.0), tw: rand(0, Math.PI * 2) });
}

function spawnPlayer(userId, nickname, pfp){
  if (!userId) return; if (state.players.has(userId)) return;
  const col = pick(AI.playerColors);
  state.players.set(userId, { id:userId, name:safeText(nickname || "viewer", 18), pfp: pfp || "", color: col, slot: state.players.size, cooldown: 0, shots: 0 });
  flagNotify({ who: nickname, msg: "Joined!", pfp, cls: "" }); updateHUD();
}

function getTurretPosition(slot){
  // Place turrets evenly across bottom area
  const n = Math.max(1, state.players.size);
  const i = slot % n;
  const pad = 60 * DPR;
  return { x: pad + (W - 2*pad) * (i + 0.5) / n, y: H - 100 * DPR };
}

function spawnMeteor(){
  const r = rand(18, 40) * DPR;
  state.meteors.push({ x: rand(r, W-r), y: -r, vx: rand(-40,40)*DPR, vy: rand(140, 240)*DPR, r, hp: 2 + Math.random()*2 });
}

function playerFire(userId){
  const p = state.players.get(userId);
  if (!p || !state.gameStarted || p.cooldown > 0) return;
  const boosted = nowMs() < state.powerBoostUntil;
  p.cooldown = boosted ? 0.08 : 0.18;

  const turret = getTurretPosition(p.slot);
  const speed = (boosted ? 860 : 720) * DPR;
  const spread = boosted ? 0.18 : 0.10;
  const shots = boosted ? 2 : 1;

  for (let i = 0; i < shots; i++) {
    const ang = -Math.PI/2 + rand(-spread, spread);
    state.shots.push({ x: turret.x, y: turret.y, vx: Math.cos(ang)*speed, vy: Math.sin(ang)*speed, r: 4*DPR, life: 0.9, color: p.color, owner: userId });
  }
  p.shots++;
}

function overlap(a, b){
  const dx = a.x - b.x, dy = a.y - b.y, rr = (a.r + b.r); return (dx*dx + dy*dy) <= rr*rr;
}

/* Rendering */
function draw(){
  if (!ctx) return;
  ctx.clearRect(0,0,W,H);

  // starfield
  ensureStars();
  for (const s of state.stars){
    s.tw += 0.02; const a = (Math.sin(s.tw)+1)/2 * 0.8 + 0.2;
    ctx.globalAlpha = a; ctx.fillStyle = "white";
    ctx.beginPath(); ctx.arc(s.x*W, s.y*H, s.z*1.6, 0, Math.PI*2); ctx.fill(); ctx.globalAlpha = 1;
  }

  // meteors
  ctx.fillStyle = "rgba(255,255,255,.92)";
  for (const m of state.meteors){ ctx.beginPath(); ctx.arc(m.x, m.y, m.r, 0, Math.PI*2); ctx.fill(); }

  // shots
  for (const s of state.shots){ ctx.fillStyle = s.color; ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, Math.PI*2); ctx.fill(); }

  // explosions
  for (const e of state.explosions){ ctx.globalAlpha = Math.max(0, e.life); ctx.fillStyle = e.color; ctx.beginPath(); ctx.arc(e.x, e.y, e.r*(1.2-e.life), 0, Math.PI*2); ctx.fill(); ctx.globalAlpha = 1; }
}

function update(dt){
  for (const p of state.players.values()) if (p.cooldown > 0) p.cooldown = Math.max(0, p.cooldown - dt);

  // spawn meteors
  if (Math.random() < 0.02) spawnMeteor();

  // update meteors
  for (const m of state.meteors){ m.x += m.vx * dt; m.y += m.vy * dt; }

  // update shots
  for (const s of state.shots){ s.x += s.vx * dt; s.y += s.vy * dt; s.life -= dt; }

  // collisions
  for (const s of state.shots){
    for (const m of state.meteors){
      if (overlap(s, m)){
        m.hp -= 1; s.life = 0;
        state.explosions.push({ x:m.x, y:m.y, r:m.r*1.4, life:0.5, color:s.color });
        if (m.hp <= 0){ state.score += 5; m.y = H + 9999; }
      }
    }
  }

  // cleanup
  state.meteors = state.meteors.filter(m => m.y < H + 60*DPR);
  state.shots = state.shots.filter(s => s.life > 0);
  state.explosions = state.explosions.filter(e => (e.life -= dt) > 0);

  updateHUD();
}

function tick(t){
  const dt = Math.min(0.045, (t - lastT) / 1000); lastT = t;
  draw(); update(dt);
  rafId = requestAnimationFrame(tick);
}

/* =========================================================
   CONNECTION + GAME START
========================================================= */
let client = null;
let gameStarted = false;
let pendingStart = false;

function beginGame(){
  if (gameStarted) return;
  gameStarted = true;
  hideOverlay();
  resetGameState();
  buildUI();
  setStatus("Connected", true);
}

function onChatMessage(data) {
  try {
    const msg = data || {};
    const text = getChatTextFromMessage(msg);
    const user = getUserFromMessage(msg);
    if (!text) return;

    // Simple command model:
    // join: adds a player
    // action keyword: fires
    const joinKw = (state.cmdJoin || AI.joinKeyword || "join").toLowerCase();
    const actKw  = (state.cmdAction || AI.actionKeyword || "fire").toLowerCase();

    const low = text.trim().toLowerCase();
    if (low.startsWith(joinKw)) spawnPlayer(user.userId || user.uniqueId || user.nickname, user.nickname, user.avatar);
    if (low.startsWith(actKw)) playerFire(user.userId || user.uniqueId || user.nickname);

  } catch (e) {
    console.error("Error in chat handler:", e);
  }
}

function setupTikTokClient(liveId) {
  if (!liveId) throw new Error("liveId is required");

  if (client && client.socket) { try { client.socket.close(); } catch(e){} }

  if (typeof TikTokClient === "undefined") {
    throw new Error("TikTokClient is not available. Check tiktok-client.js.");
  }

  client = new TikTokClient(liveId);

  if (typeof CHATTOK_CREATOR_TOKEN !== "undefined" && CHATTOK_CREATOR_TOKEN) {
    client.setAccessToken(CHATTOK_CREATOR_TOKEN);
  }

  client.on("connected", () => {
    console.log("Connected to TikTok hub.");
    if (pendingStart && !gameStarted) beginGame();
    state.connected = true; setStatus("Connected", true);
  });

  client.on("disconnected", (reason) => {
    console.log("Disconnected:", reason);
    state.connected = false; setStatus("Disconnected", false);
    if (!gameStarted) pendingStart = false;
  });

  client.on("error", (err) => console.error("TikTok client error:", err));

  client.on("chat", onChatMessage);
  client.on("gift", (data) => {
    const n = normalizeGift(data);
    state.gifts += n.repeat;
    state.powerBoostUntil = nowMs() + Math.min(6000, 2000 + n.diamond * 50);
    flagNotify({ who:n.nickname, msg:`${n.giftName} x${n.repeat}`, pfp:n.pfp, cls:"" });
  });
  client.on("like", (data) => {
    const n = normalizeLike(data);
    state.likes += Number(n.count || 1);
    state.power = clamp(state.power + 0.006 * (n.count || 1), 0, 1);
  });

  client.connect();
}

/* =========================================================
   AI_REGION (parameters for designers; can be tuned per game)
========================================================= */
const AI = {
  playerColors: ["#00f2ea", "#ff0050", "#8a7dff", "#2ee59d", "#ffd166", "#ef476f"],
  joinKeyword: "join",
  actionKeyword: "fire",
  allowShareForActionDefault: false,
  allowShareForJoinDefault: false
};

/* =========================================================
   BOOT
========================================================= */
window.addEventListener("load", () => {
  // Initial UI (overlay visible; not connected)
  setStatus("Offline", false);
  showOverlay();
  ensureSettingsUI();
  buildUI();

  // Start button: connect + begin when 'connected'
  if (startGameBtn) {
    startGameBtn.addEventListener("click", () => {
      try {
        const liveId = String(liveIdInput && liveIdInput.value ? liveIdInput.value : "").trim().replace(/^@/, "");
        if (!liveId) { setStatus("Enter a LIVE ID.", false); return; }

        state.cmdAction = readSetting("cmdAction", AI.actionKeyword);
        state.cmdJoin = readSetting("cmdJoin", AI.joinKeyword);
        state.shareAction = !!readSetting("allowShareForAction", AI.allowShareForActionDefault);
        state.shareJoin = !!readSetting("allowShareForJoin", AI.allowShareForJoinDefault);

        pendingStart = true;
        setStatus("Connecting…", true);
        setupTikTokClient(liveId);
      } catch (e) {
        console.error(e);
        setStatus("Error: " + (e && e.message ? e.message : "Unknown"), false);
      }
    });
  }

  // Animation loop (no gameplay logic depends on connection until beginGame())
  lastT = performance.now();
  cancelAnimationFrame(rafId);
  rafId = requestAnimationFrame(tick);
});
