/* =========================================================
   ChatTok Game Template — game.template.js (NO DEMO MODE)
   - No simulated TikTok events. No “demo gameplay”.
   - Game starts ONLY after successful TikTok connection.
   - Uses TikTokClient provided by ChatTokGaming (do not edit tiktok-client.js).
   - AI fills ONLY the AI_REGION.

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
  // update pill class if present
  const pill = document.getElementById("connPill");
  if (pill) {
    if (/connected/i.test(t)) pill.classList.add("connected");
    else pill.classList.remove("connected");
  }
}

/* =========================================================
   Robust TikTok message shape helpers (supports many shapes)
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
    const list =
      a1.urlList || a1.urlListList || a1.urllistList || a1.urllist || a1.url_list || a1.url_list_list;
    const pick1 = firstUrl(list);
    if (pick1) return pick1;
  }
  return "";
}

function getUserFromMessage(msg) {
  const m = msg || {};
  const u = m.user || m.userInfo || m.userinfo || m.sender || m.from || {};
  const userId =
    String(u.userId ?? u.userid ?? u.id ?? m.userId ?? m.userid ?? m.user_id ?? "") || "";
  const uniqueId =
    String(u.uniqueId ?? u.uniqueid ?? u.username ?? u.handle ?? m.uniqueId ?? m.uniqueid ?? "") ||
    "";
  const nickname =
    String(u.nickname ?? u.displayName ?? u.name ?? m.nickname ?? "") || uniqueId || "viewer";
  const avatar = getAvatarUrlFromUser(u) || firstUrl(m.profilePictureUrl) || "";
  return { userId, uniqueId, nickname, avatar };
}

function normalizeChat(m) {
  const user = getUserFromMessage(m);
  return {
    type: "chat",
    userId: user.userId,
    uniqueId: user.uniqueId,
    nickname: user.nickname,
    pfp: user.avatar || "",
    text: getChatTextFromMessage(m),
    raw: m,
  };
}

function normalizeLike(m) {
  const user = getUserFromMessage(m);
  const count =
    Number(m.likeCount ?? m.likecount ?? m.count ?? m.totalLikeCount ?? m.totalLikecount ?? 1) || 1;
  return {
    type: "like",
    userId: user.userId,
    uniqueId: user.uniqueId,
    nickname: user.nickname,
    pfp: user.avatar || "",
    count,
    raw: m,
  };
}

function normalizeGift(m) {
  const user = getUserFromMessage(m);
  const giftName = String(m.giftName ?? m.giftname ?? m.gift?.name ?? m.gift?.giftName ?? "Gift");
  const repeat = Number(m.repeatCount ?? m.repeatcount ?? m.repeat ?? m.count ?? 1) || 1;
  const diamond =
    Number(m.diamondCount ?? m.diamondcount ?? m.diamonds ?? m.gift?.diamondCount ?? 0) || 0;
  return {
    type: "gift",
    userId: user.userId,
    uniqueId: user.uniqueId,
    nickname: user.nickname,
    pfp: user.avatar || "",
    giftName,
    repeat,
    diamond,
    raw: m,
  };
}

function normalizeJoin(m) {
  const user = getUserFromMessage(m);
  return {
    type: "join",
    userId: user.userId,
    uniqueId: user.uniqueId,
    nickname: user.nickname,
    pfp: user.avatar || "",
    raw: m,
  };
}

/* =========================================================
   UI build (matches style.template.css stage/topbar/playcard/hud)
========================================================= */
let canvas, ctx;
let W = 0, H = 0, DPR = 1;
let ui = {};

function clearEl(el) {
  if (!el) return;
  while (el.firstChild) el.removeChild(el.firstChild);
}

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

  // Flags container exists in CSS, create only if used
  const flags = document.createElement("div");
  flags.id = "flags";

  stage.appendChild(topbar);
  stage.appendChild(playcard);
  stage.appendChild(hud);

  gameRoot.appendChild(stage);
  gameRoot.appendChild(flags);

  // context + resize
  try {
    ctx = canvas.getContext("2d", { alpha: true, desynchronized: true });
  } catch {
    ctx = canvas.getContext("2d");
  }

  resizeCanvas();
  window.addEventListener("resize", resizeCanvas, { passive: true });

  ui = {
    hudScore: document.getElementById("hudScore"),
    hudPlayers: document.getElementById("hudPlayers"),
    hudLikes: document.getElementById("hudLikes"),
    hudGifts: document.getElementById("hudGifts"),
    hudMeter: document.getElementById("hudMeter"),
    flagsEl: document.getElementById("flags"),
    pillStatus: document.getElementById("pillStatus"),
  };
}

function resizeCanvas() {
  if (!canvas) return;
  const r = canvas.getBoundingClientRect();
  DPR = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
  W = Math.max(1, Math.floor(r.width * DPR));
  H = Math.max(1, Math.floor(r.height * DPR));
  if (canvas.width !== W || canvas.height !== H) {
    canvas.width = W;
    canvas.height = H;
  }
}

/* =========================================================
   Optional flags (only used if AI/Spec wants notifications)
========================================================= */
function escapeHtml(s) {
  return String(s || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
function initials(name) {
  const s = String(name || "").trim();
  if (!s) return "?";
  const parts = s.split(/\s+/).slice(0, 2);
  return parts.map((p) => p[0]).join("").toUpperCase();
}
function flagNotify({ who, msg, pfp, cls }) {
  if (!state.uiFlagsEnabled) return;
  if (!ui.flagsEl) return;

  const wrap = document.createElement("div");
  wrap.className = "flag" + (cls ? " " + String(cls) : "");

  const pfpWrap = document.createElement("div");
  pfpWrap.className = "pfp";

  const img = document.createElement("img");
  img.alt = "";
  img.decoding = "async";
  img.loading = "lazy";

  const fallback = document.createElement("div");
  fallback.style.width = "100%";
  fallback.style.height = "100%";
  fallback.style.display = "grid";
  fallback.style.placeItems = "center";
  fallback.style.fontWeight = "900";
  fallback.style.fontSize = "12px";
  fallback.style.letterSpacing = ".6px";
  fallback.style.color = "rgba(255,255,255,.92)";
  fallback.textContent = initials(who || "");

  const hasPfp = typeof pfp === "string" && pfp.trim().length > 0;
  if (hasPfp) {
    img.src = pfp.trim();
    img.onerror = () => {
      pfpWrap.innerHTML = "";
      pfpWrap.appendChild(fallback);
    };
    pfpWrap.appendChild(img);
  } else {
    pfpWrap.appendChild(fallback);
  }

  const text = document.createElement("div");
  text.className = "txt";
  text.innerHTML =
    `<div class="who">${escapeHtml(who || "")}</div>` +
    `<div class="msg">${escapeHtml(msg || "")}</div>`;

  wrap.appendChild(pfpWrap);
  wrap.appendChild(text);

  ui.flagsEl.prepend(wrap);
  while (ui.flagsEl.childElementCount > 6) ui.flagsEl.removeChild(ui.flagsEl.lastChild);

  setTimeout(() => {
    try { wrap.remove(); } catch {}
  }, 3200);
}

/* =========================================================
   SETTINGS (chat command variables + optional share triggers)
   - Collapsible to avoid clutter
========================================================= */
function readSetting(id, fallback) {
  const el = document.getElementById(id);
  if (!el) return fallback;
  if (el.type === "checkbox") return !!el.checked;
  return String(el.value || "").trim() || fallback;
}

function ensureSettingsUI() {
  // Add a collapsible settings panel inside the overlay-card (only once).
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
  box.style.marginTop = "10px";
  box.style.display = "grid";
  box.style.gap = "10px";

  // Only show these if spec suggests a command-driven action.
  const needsCommand = !!(SPEC && (SPEC.requiresCommand || SPEC.commandDriven || SPEC.chatCommand));
  const showCommandFields = needsCommand || true; // template supports it without forcing; kept in collapsible

  if (showCommandFields) {
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
          <input id="allowShareForAction" type="checkbox" />
          Allow Shares to trigger ACTION (if available)
        </label>

        <label style="display:flex;gap:8px;align-items:center;font-size:13px;color:rgba(255,255,255,.84)">
          <input id="allowShareForJoin" type="checkbox" />
          Allow Shares to trigger JOIN (if available)
        </label>
      </div>
    `;
  }

  details.appendChild(summary);
  details.appendChild(box);
  card.appendChild(details);

  // Apply defaults from AI config after insert
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
   GAME ENGINE (NO GAMEPLAY UNTIL CONNECTED)
========================================================= */
let rafId = 0;
let lastT = 0;

const state = {
  connected: false,
  pendingStart: false,
  gameStarted: false,

  // counters
  score: 0,
  players: new Map(), // userId -> player
  likes: 0,
  gifts: 0,

  // power meter from likes
  power: 0,           // 0..1
  powerBoostUntil: 0, // ms

  // entities (only active after game start)
  meteors: [],
  shots: [],
  explosions: [],

  // idle visuals (allowed, not gameplay)
  stars: [],

  // UI feature flags
  uiFlagsEnabled: false,

  // command settings (loaded at start)
  cmdAction: "",
  cmdJoin: "",
  shareAction: false,
  shareJoin: false,
};

function resetGameState() {
  state.score = 0;
  state.players.clear();
  state.likes = 0;
  state.gifts = 0;
  state.power = 0;
  state.powerBoostUntil = 0;
  state.meteors = [];
  state.shots = [];
  state.explosions = [];
}

function updateHUD() {
  if (ui.hudScore) ui.hudScore.textContent = String(state.score);
  if (ui.hudPlayers) ui.hudPlayers.textContent = String(state.players.size);
  if (ui.hudLikes) ui.hudLikes.textContent = String(state.likes);
  if (ui.hudGifts) ui.hudGifts.textContent = String(state.gifts);
  if (ui.hudMeter) ui.hudMeter.style.width = `${Math.round(clamp(state.power, 0, 1) * 100)}%`;
  if (ui.pillStatus) ui.pillStatus.textContent = state.connected ? "Connected" : "Offline";
}

function ensureStars() {
  if (state.stars.length) return;
  const count = 90;
  for (let i = 0; i < count; i++) {
    state.stars.push({
      x: Math.random(),
      y: Math.random(),
      z: rand(0.2, 1.0),
      tw: rand(0, Math.PI * 2),
    });
  }
}

function spawnPlayer(userId, nickname, pfp) {
  if (!userId) return;
  if (state.players.has(userId)) return;

  const idx = state.players.size;
  const col = pick(AI.playerColors);

  state.players.set(userId, {
    id: userId,
    name: safeText(nickname || "viewer", 18),
    pfp: pfp || "",
    color: col,
    slot: idx, // order of join
    cooldown: 0,
    shots: 0,
  });

  // Use flags only if enabled
  flagNotify({ who: nickname, msg: "Joined!", pfp, cls: "" });
  updateHUD();
}

function playerFire(userId, intensity = 1) {
  const p = state.players.get(userId);
  if (!p) return;
  if (!state.gameStarted) return;
  if (p.cooldown > 0) return;

  // cooldown scales with power boost
  const boosted = nowMs() < state.powerBoostUntil;
  p.cooldown = boosted ? 0.08 : 0.18;

  // fire from player's turret position
  const turret = getTurretPosition(p.slot);
  const speed = (boosted ? 860 : 720) * DPR;

  const spread = boosted ? 0.18 : 0.10;
  const shots = boosted ? 2 : 1;

  for (let i = 0; i < shots; i++) {
    const ang = -Math.PI / 2 + rand(-spread, spread);
    state.shots.push({
      x: turret.x,
      y: turret.y,
      vx: Math.cos(ang) * speed,
      vy: Math.sin(ang) * speed,
      r: 4 * DPR,
      life: 0.9,
      color: p.color,
      owner: userId,
      dmg: Math.max(1, Math.round(intensity)),
    });
  }

  p.shots += 1;
}

function getTurretPosition(slot) {
  const n = Math.max(1, state.players.size);
  const i = clamp(slot, 0, n - 1);
  const pad = 42 * DPR;
  const x = pad + (i + 0.5) * ((W - pad * 2) / n);
  const y = H - 88 * DPR;
  return { x, y };
}

function spawnMeteor(power = 1) {
  const r = clamp(rand(18, 42) * (0.9 + power * 0.18), 16, 88) * DPR;
  const x = rand(r, W - r);
  const y = -r - rand(0, 120 * DPR);
  const vy = rand(140, 240) * DPR * (1 + power * 0.06);
  const vx = rand(-40, 40) * DPR;

  state.meteors.push({
    x, y, vx, vy, r,
    hp: Math.ceil((r / (20 * DPR)) * (1 + power * 0.25)),
    rot: rand(0, Math.PI * 2),
    rv: rand(-1.2, 1.2),
  });
}

function explode(x, y, strength = 1) {
  state.explosions.push({ x, y, t: 0, s: strength });
}

function nukeAll() {
  if (!state.gameStarted) return;
  // big gift event: clear most meteors, score bonus
  const killed = state.meteors.length;
  if (!killed) return;
  for (const m of state.meteors) explode(m.x, m.y, 1.3);
  state.meteors = [];
  state.score += killed * 2;
  flagNotify({ who: "GIFT", msg: "NUKE!", pfp: "", cls: "yellow" });
  updateHUD();
}

/* =========================================================
   Tick + Render
========================================================= */
function tick(t) {
  rafId = requestAnimationFrame(tick);
  const dt = clamp((t - lastT) / 1000, 0, 0.05);
  lastT = t;

  resizeCanvas();
  ensureStars();

  // always render idle background
  renderBackground(dt);

  if (!state.gameStarted) {
    renderWaitingText();
    updateHUD();
    return;
  }

  // === Active gameplay ONLY after beginGame() ===
  updateGame(dt);
  renderGame(dt);
  updateHUD();
}

function renderBackground(dt) {
  if (!ctx) return;
  ctx.clearRect(0, 0, W, H);

  // subtle star field (non-gameplay)
  for (const s of state.stars) {
    s.tw += dt * (0.6 + s.z * 0.8);
    const x = s.x * W;
    const y = s.y * H;
    const a = 0.22 + 0.22 * Math.sin(s.tw);
    const r = (1.2 + 1.6 * s.z) * DPR;
    ctx.globalAlpha = a;
    ctx.fillStyle = "white";
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

function renderWaitingText() {
  const msg = state.connected ? "Ready. Press Start to begin." : "Connect to TikTok LIVE to start.";
  ctx.save();
  ctx.fillStyle = "rgba(255,255,255,.92)";
  ctx.font = `${Math.round(22 * DPR)}px system-ui,Segoe UI,Roboto,Arial`;
  ctx.textAlign = "center";
  ctx.fillText(msg, W * 0.5, H * 0.52);

  ctx.fillStyle = "rgba(255,255,255,.70)";
  ctx.font = `${Math.round(14 * DPR)}px system-ui,Segoe UI,Roboto,Arial`;
  const hint = `Join: "${state.cmdJoin || AI.joinKeyword}" • Action: "${state.cmdAction || AI.actionKeyword}"`;
  ctx.fillText(hint, W * 0.5, H * 0.52 + 26 * DPR);
  ctx.restore();
}

function updateGame(dt) {
  // spawn meteors
  const power = 1 + state.score / 90;
  state._spawnT = (state._spawnT || 0) - dt;
  const boosted = nowMs() < state.powerBoostUntil;
  const spawnEvery = boosted ? 0.34 : 0.48;

  if (state._spawnT <= 0) {
    state._spawnT = spawnEvery;
    spawnMeteor(power);
    if (boosted && Math.random() < 0.35) spawnMeteor(power);
  }

  // update players cooldown
  for (const p of state.players.values()) {
    if (p.cooldown > 0) p.cooldown -= dt;
  }

  // update shots
  for (let i = state.shots.length - 1; i >= 0; i--) {
    const b = state.shots[i];
    b.x += b.vx * dt;
    b.y += b.vy * dt;
    b.life -= dt;
    if (b.life <= 0 || b.y < -60 || b.x < -60 || b.x > W + 60) state.shots.splice(i, 1);
  }

  // update meteors
  for (let i = state.meteors.length - 1; i >= 0; i--) {
    const m = state.meteors[i];
    m.x += m.vx * dt;
    m.y += m.vy * dt;
    m.rot += m.rv * dt;
    if (m.y > H + m.r + 40) {
      // meteor slipped through — penalty
      state.meteors.splice(i, 1);
      state.score = Math.max(0, state.score - 1);
      continue;
    }
  }

  // collisions shots vs meteors
  for (let i = state.meteors.length - 1; i >= 0; i--) {
    const m = state.meteors[i];
    for (let j = state.shots.length - 1; j >= 0; j--) {
      const b = state.shots[j];
      const dx = m.x - b.x;
      const dy = m.y - b.y;
      const rr = (m.r + b.r);
      if (dx * dx + dy * dy <= rr * rr) {
        // hit
        m.hp -= b.dmg;
        state.shots.splice(j, 1);
        if (m.hp <= 0) {
          explode(m.x, m.y, 1);
          state.meteors.splice(i, 1);
          state.score += 2;

          // reward shooter
          const owner = b.owner;
          if (owner && state.players.has(owner)) {
            // tiny bonus shot cooldown reduction already handled by boosted
          }
        }
        break;
      }
    }
  }

  // update explosions
  for (let i = state.explosions.length - 1; i >= 0; i--) {
    const e = state.explosions[i];
    e.t += dt;
    if (e.t > 0.45) state.explosions.splice(i, 1);
  }
}

function renderGame(dt) {
  // meteors
  for (const m of state.meteors) {
    ctx.save();
    ctx.translate(m.x, m.y);
    ctx.rotate(m.rot);
    ctx.fillStyle = "rgba(255,255,255,.10)";
    ctx.strokeStyle = "rgba(255,255,255,.38)";
    ctx.lineWidth = 2 * DPR;
    ctx.beginPath();
    ctx.arc(0, 0, m.r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  // shots
  for (const b of state.shots) {
    ctx.fillStyle = b.color;
    ctx.globalAlpha = 0.9;
    ctx.beginPath();
    ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  // turrets
  const n = Math.max(1, state.players.size);
  let idx = 0;
  for (const p of state.players.values()) {
    const pos = getTurretPosition(p.slot);
    const w = (W - 84 * DPR) / n;
    const baseW = clamp(w, 44 * DPR, 110 * DPR);
    const baseH = 26 * DPR;

    // base
    ctx.fillStyle = "rgba(0,0,0,.35)";
    ctx.strokeStyle = "rgba(255,255,255,.12)";
    ctx.lineWidth = 2 * DPR;
    ctx.beginPath();
    ctx.roundRect(pos.x - baseW * 0.45, pos.y + 16 * DPR, baseW * 0.9, baseH, 12 * DPR);
    ctx.fill();
    ctx.stroke();

    // turret
    ctx.fillStyle = p.color;
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, 14 * DPR, 0, Math.PI * 2);
    ctx.fill();

    idx++;
  }

  // explosions
  for (const e of state.explosions) {
    const k = e.t / 0.45;
    const r = (18 + 90 * k) * DPR * e.s;
    ctx.globalAlpha = (1 - k) * 0.65;
    ctx.fillStyle = "white";
    ctx.beginPath();
    ctx.arc(e.x, e.y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  }
}

/* =========================================================
   Start / Stop
========================================================= */
function beginGame() {
  if (!state.connected) {
    // do not begin gameplay unless connected (no demo mode)
    setStatus("Offline — connect first.", false);
    showOverlay();
    return;
  }
  if (state.gameStarted) return;

  resetGameState();
  state.gameStarted = true;
  hideOverlay();
  setStatus("Connected.", true);

  // small announcement (only if enabled)
  flagNotify({ who: "GAME", msg: "Started!", pfp: "", cls: "" });
}

function stopGame() {
  state.gameStarted = false;
  resetGameState();
  showOverlay();
}

/* =========================================================
   Command parsing
========================================================= */
function normalizeCmd(text) {
  return String(text || "").trim().toLowerCase().replace(/^[@#!]+/, "");
}
function textMatches(text, keyword) {
  const t = normalizeCmd(text);
  const k = normalizeCmd(keyword);
  if (!t || !k) return false;
  return t === k || t.startsWith(k + " ");
}

/* =========================================================
   TikTok event handlers (REAL events only)
========================================================= */
let client = null;

function onChatMessage(data) {
  try {
    const msg = data || {};
    const ev = normalizeChat(msg);
    const text = ev.text;

    if (!text) return;

    // Join by chat command
    if (textMatches(text, state.cmdJoin || AI.joinKeyword)) {
      spawnPlayer(ev.userId, ev.nickname, ev.pfp);
      return;
    }

    // Action command
    if (state.gameStarted) {
      const actionHit =
        textMatches(text, state.cmdAction || AI.actionKeyword) ||
        (AI.allowAnyChatAsAction && state.players.has(ev.userId));
      if (actionHit) {
        playerFire(ev.userId, 1);
      }
    }
  } catch (e) {
    console.error("Error in chat handler:", e);
  }
}

function onGiftMessage(data) {
  try {
    const ev = normalizeGift(data || {});
    state.gifts += 1;
    updateHUD();

    // Gift triggers a big power event (default: nuke)
    const name = String(ev.giftName || "").toLowerCase();
    const isBig = (ev.diamond >= AI.bigGiftDiamondMin) || AI.bigGiftNames.some(x => name.includes(x));

    if (isBig) {
      nukeAll();
    } else {
      // small gift: score bump + short power boost
      state.score += 1;
      state.power = clamp(state.power + 0.08, 0, 1);
      if (state.power >= 1) {
        state.power = 0;
        state.powerBoostUntil = nowMs() + AI.powerBoostMs;
        flagNotify({ who: "POWER", msg: "Boost Activated!", pfp: "", cls: "" });
      }
    }
  } catch (e) {
    console.error("Error in gift handler:", e);
  }
}

function onLikeMessage(data) {
  try {
    const ev = normalizeLike(data || {});
    state.likes += ev.count;
    // likes charge meter
    state.power = clamp(state.power + (ev.count * AI.likePowerGain), 0, 1);
    if (state.power >= 1) {
      state.power = 0;
      state.powerBoostUntil = nowMs() + AI.powerBoostMs;
      flagNotify({ who: "POWER", msg: "Boost Activated!", pfp: "", cls: "" });
    }
  } catch (e) {
    console.error("Error in like handler:", e);
  }
}

function onJoinMessage(data) {
  try {
    // Auto-add player on join if enabled
    if (!AI.useJoinEventToAddPlayer) return;
    const ev = normalizeJoin(data || {});
    spawnPlayer(ev.userId, ev.nickname, ev.pfp);
  } catch (e) {
    console.error("Error in join handler:", e);
  }
}

// Best-effort share support:
// tiktok-client.js in your current file triggers 'social' reliably,
// but 'share' is likely NOT firing due to a duplicate switch-case bug.
// So we listen to 'social' and treat it as a share trigger if allowed.
function onSocialMessage(data) {
  try {
    if (!state.gameStarted) return;
    if (!state.shareAction && !state.shareJoin) return;

    const user = getUserFromMessage(data || {});
    if (!user.userId) return;

    // If allowed: share can join OR action, depending toggles
    if (state.shareJoin) spawnPlayer(user.userId, user.nickname, user.avatar);
    if (state.shareAction) playerFire(user.userId, 1);
  } catch (e) {
    console.error("Error in social handler:", e);
  }
}

/* =========================================================
   TikTok client setup / connect (matches required style)
========================================================= */
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
    try {
      client.setAccessToken(CHATTOK_CREATOR_TOKEN);
    } catch (e) {
      console.warn("Token could not be set:", e);
    }
  } else {
    console.warn("CHATTOK_CREATOR_TOKEN is missing. This is expected outside ChatTokGaming preview/live.");
    // Do NOT block UI; connect attempt may fail and will be reported.
  }

  client.on("connected", () => {
    console.log("Connected to TikTok hub.");
    state.connected = true;
    setStatus("Connected to TikTok LIVE.", true);

    // Only start game once we know we're connected
    if (state.pendingStart && !state.gameStarted) {
      beginGame();
    }
  });

  client.on("disconnected", (reason) => {
    console.log("Disconnected from TikTok hub:", reason);
    const msg = reason || "Connection closed";
    state.connected = false;
    setStatus("Disconnected: " + msg, false);

    if (!state.gameStarted) {
      // Connection failed before game start; allow retry
      state.pendingStart = false;
    } else {
      // If game was running, stop it cleanly.
      stopGame();
    }
  });

  client.on("error", (err) => {
    console.error("TikTok client error:", err);
    setStatus("Error: " + (err && err.message ? err.message : "Unknown"), false);
  });

  client.on("chat", onChatMessage);
  client.on("gift", onGiftMessage);
  client.on("like", onLikeMessage);
  client.on("join", onJoinMessage);
  client.on("social", onSocialMessage);

  // Try connect; if token missing, this may throw. We report cleanly.
  try {
    client.connect();
  } catch (e) {
    console.error("Connect failed:", e);
    setStatus("Error: " + (e && e.message ? e.message : "Connect failed"), false);
    state.pendingStart = false;
    throw e;
  }
}

/* =========================================================
   AI REGION — AI fills ONLY this area.
   Keep it compact and structured.
========================================================= */
// === AI_REGION_START ===
const AI = {
  // Copy should be driven by spec in your prompts; keep clean defaults.
  title: "Meteor Defense",
  subtitle: "Viewers join, then use chat/likes/gifts to protect the arena.",

  // Chat commands (host can override in settings panel)
  joinKeyword: "join",
  actionKeyword: "fire",

  // If the game concept wants “any chat = action”, AI can enable it
  allowAnyChatAsAction: false,

  // Share triggers (optional)
  allowShareForJoinDefault: false,
  allowShareForActionDefault: false,

  // Use join event to add players
  useJoinEventToAddPlayer: true,

  // Likes → power meter
  likePowerGain: 0.0025,     // ~400 likes to fill meter
  powerBoostMs: 9000,        // boost duration

  // Gifts
  bigGiftDiamondMin: 100,    // big gift triggers nuke
  bigGiftNames: ["lion", "universe", "galaxy", "drama", "tiktok"],

  // Visual flair (no demo gameplay)
  playerColors: ["rgba(0,242,234,.92)", "rgba(255,0,80,.92)", "rgba(255,255,255,.88)", "rgba(255,210,77,.92)"],

  // Notifications: only used if the AI/game calls flagNotify().
  uiFlagsEnabled: true
};
// === AI_REGION_END ===

/* =========================================================
   Boot
========================================================= */
document.addEventListener("DOMContentLoaded", () => {
  buildUI();
  ensureSettingsUI();

  // Apply AI settings
  state.uiFlagsEnabled = !!AI.uiFlagsEnabled;

  setStatus("Offline", false);
  showOverlay();

  // Start button: connect + (auto) begin game only after 'connected'
  if (startGameBtn) {
    startGameBtn.addEventListener("click", () => {
      try {
        const liveId = String(liveIdInput && liveIdInput.value ? liveIdInput.value : "").trim().replace(/^@/, "");
        if (!liveId) {
          setStatus("Enter a LIVE ID.", false);
          return;
        }

        // read settings (from collapsible)
        state.cmdAction = readSetting("cmdAction", AI.actionKeyword);
        state.cmdJoin = readSetting("cmdJoin", AI.joinKeyword);
        state.shareAction = !!readSetting("allowShareForAction", AI.allowShareForActionDefault);
        state.shareJoin = !!readSetting("allowShareForJoin", AI.allowShareForJoinDefault);

        state.pendingStart = true;
        setStatus("Connecting…", true);

        setupTikTokClient(liveId);
      } catch (e) {
        console.error(e);
        setStatus("Error: " + (e && e.message ? e.message : "Unknown"), false);
      }
    });
  }

  // animation loop (idle visuals allowed, but NO gameplay until beginGame())
  lastT = performance.now();
  cancelAnimationFrame(rafId);
  rafId = requestAnimationFrame(tick);
});

/* =========================================================
   WORKING TIKTOK CONNECTION EXAMPLE (DO NOT REMOVE)
   Here is an example of code to connect, see TikTok messages,
   and map chat into gameplay. You can adapt this pattern for
   new games, but keep the structure and error handling style:
=========================================================

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

========================================================= */
