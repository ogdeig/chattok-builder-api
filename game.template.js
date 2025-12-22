/* game.js (template-first, multi-template inside ONE file)
   - Uses TikTokClient (tiktok-client.js)
   - AI fills ONLY the region between markers.
   - No dev/test buttons. Ever.
   - Always renders a real animated game (even before connect)
*/

// This constant is injected server-side.
const SPEC = __SPEC_JSON__;

/* =========================================================
   DOM refs (must exist in index.html template)
========================================================= */
const setupOverlay = document.getElementById("setupOverlay");
const startGameBtn = document.getElementById("startGameBtn");
const liveIdInput = document.getElementById("liveIdInput");
const statusText = document.getElementById("statusText");
const statusTextInGame = document.getElementById("statusTextInGame");
const gameRoot = document.getElementById("gameRoot");
const flagsEl = document.getElementById("flags");

/* =========================================================
   Helpers
========================================================= */
function escapeHtml(s) {
  return String(s || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function showOverlay() {
  if (setupOverlay) setupOverlay.style.display = "";
}

function hideOverlay() {
  if (setupOverlay) setupOverlay.style.display = "none";
}

function setStatus(msg, ok = true) {
  const t = String(msg || "");
  if (statusText) {
    statusText.textContent = t;
    statusText.style.color = ok ? "rgba(255,255,255,.9)" : "rgba(255,120,120,.95)";
  }
  if (statusTextInGame) {
    statusTextInGame.textContent = t;
    statusTextInGame.style.color = ok ? "rgba(255,255,255,.75)" : "rgba(255,120,120,.95)";
  }
}

function clearRoot() {
  while (gameRoot && gameRoot.firstChild) gameRoot.removeChild(gameRoot.firstChild);
}

function clamp(v, a, b) {
  v = Number(v) || 0;
  return Math.max(a, Math.min(b, v));
}

function nowMs() {
  return Date.now();
}

function rand(a, b) {
  return a + Math.random() * (b - a);
}

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function safeText(s, max = 70) {
  return String(s || "").trim().replace(/\s+/g, " ").slice(0, max);
}

function getUrlFlag(name) {
  try {
    const u = new URL(window.location.href);
    return u.searchParams.get(name);
  } catch {
    return null;
  }
}

/* =========================================================
   Toast / Flag notifications (small + transparent)
========================================================= */
function flag({ who, msg, pfp }) {
  if (!flagsEl) return;

  const wrap = document.createElement("div");
  wrap.className = "flag";

  // Inline styles to guarantee: small + transparent + non-blocking
  wrap.style.display = "flex";
  wrap.style.alignItems = "center";
  wrap.style.gap = "8px";
  wrap.style.padding = "6px 10px";
  wrap.style.borderRadius = "999px";
  wrap.style.background = "rgba(0,0,0,.33)";
  wrap.style.backdropFilter = "blur(6px)";
  wrap.style.border = "1px solid rgba(255,255,255,.10)";
  wrap.style.boxShadow = "0 10px 24px rgba(0,0,0,.35)";
  wrap.style.pointerEvents = "none";
  wrap.style.maxWidth = "92%";
  wrap.style.opacity = "1";
  wrap.style.transform = "translateX(0)";
  wrap.style.transition = "opacity .22s ease, transform .22s ease";

  const img = document.createElement("img");
  img.alt = "";
  img.decoding = "async";
  img.referrerPolicy = "no-referrer";
  img.loading = "lazy";
  img.style.width = "22px";
  img.style.height = "22px";
  img.style.borderRadius = "50%";
  img.style.flex = "0 0 auto";
  img.style.border = "1px solid rgba(255,255,255,.20)";
  img.src =
    pfp && String(pfp).trim()
      ? String(pfp).trim()
      : "data:image/svg+xml;charset=utf-8," +
        encodeURIComponent(
          `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#111"/><circle cx="32" cy="26" r="12" fill="#444"/><rect x="14" y="40" width="36" height="16" rx="8" fill="#333"/></svg>`
        );

  const text = document.createElement("div");
  text.style.minWidth = "0";
  text.style.display = "flex";
  text.style.flexDirection = "column";
  text.style.lineHeight = "1.1";

  const a = document.createElement("div");
  a.style.fontSize = "11px";
  a.style.fontWeight = "800";
  a.style.letterSpacing = ".2px";
  a.style.color = "rgba(255,255,255,.90)";
  a.style.whiteSpace = "nowrap";
  a.style.overflow = "hidden";
  a.style.textOverflow = "ellipsis";
  a.textContent = safeText(who || "viewer", 26);

  const b = document.createElement("div");
  b.style.fontSize = "12px";
  b.style.fontWeight = "700";
  b.style.color = "rgba(255,255,255,.82)";
  b.style.whiteSpace = "nowrap";
  b.style.overflow = "hidden";
  b.style.textOverflow = "ellipsis";
  b.textContent = safeText(msg || "", 70);

  text.appendChild(a);
  text.appendChild(b);

  wrap.appendChild(img);
  wrap.appendChild(text);

  flagsEl.prepend(wrap);

  // cap stack
  while (flagsEl.childElementCount > 7) flagsEl.removeChild(flagsEl.lastChild);

  // auto-remove
  setTimeout(() => {
    try {
      wrap.style.opacity = "0";
      wrap.style.transform = "translateX(14px)";
    } catch {}
    setTimeout(() => {
      try {
        wrap.remove();
      } catch {}
    }, 240);
  }, 3600);
}

/* =========================================================
   Core ctx
========================================================= */
const ctx = {
  spec: SPEC,
  client: null,
  pendingStart: false,
  connected: false,
  ui: {
    flag,
    setStatus,
    card: () => null,
  },
  fx: {
    _pulseAt: 0,
    pulse() {
      this._pulseAt = nowMs();
    },
    spark() {
      this._sparkAt = nowMs();
    },
    burst() {
      this._burstAt = nowMs();
    },
    shake(ms = 220) {
      ctx.state.camera.shakeUntil = Math.max(ctx.state.camera.shakeUntil, nowMs() + (Number(ms) || 220));
    },
  },
  state: {
    startedAt: 0,
    settings: {},
    counters: { chats: 0, likes: 0, gifts: 0, joins: 0 },
    score: { points: 0, streak: 0, level: 1 },
    camera: { shakeUntil: 0 },
    mode: null,
    modeId: "",
    host: false,
  },
};

/* =========================================================
   Minimal HUD + Canvas Stage
========================================================= */
let canvas = null;
let g = null;
let hud = null;

function renderBase() {
  clearRoot();
  if (!gameRoot) return;

  const wrap = document.createElement("div");
  wrap.style.position = "relative";
  wrap.style.width = "100%";
  wrap.style.height = "100%";
  wrap.style.overflow = "hidden";
  wrap.style.borderRadius = "16px";

  canvas = document.createElement("canvas");
  canvas.id = "gameCanvas";
  canvas.style.width = "100%";
  canvas.style.height = "100%";
  canvas.style.display = "block";
  canvas.style.background = "radial-gradient(1200px 800px at 50% 35%, rgba(255,140,0,.14), rgba(0,0,0,.92))";
  wrap.appendChild(canvas);

  // HUD (scoreboards)
  hud = document.createElement("div");
  hud.id = "hud";
  hud.style.position = "absolute";
  hud.style.left = "10px";
  hud.style.top = "10px";
  hud.style.display = "flex";
  hud.style.flexDirection = "column";
  hud.style.gap = "8px";
  hud.style.pointerEvents = "none";
  wrap.appendChild(hud);

  // Top row scoreboard
  const topRow = document.createElement("div");
  topRow.style.display = "flex";
  topRow.style.gap = "10px";
  topRow.style.alignItems = "center";

  const badge = document.createElement("div");
  badge.textContent = "LIVE";
  badge.style.fontWeight = "900";
  badge.style.fontSize = "12px";
  badge.style.letterSpacing = ".6px";
  badge.style.padding = "6px 10px";
  badge.style.borderRadius = "999px";
  badge.style.background = "rgba(255,140,0,.20)";
  badge.style.border = "1px solid rgba(255,255,255,.14)";
  badge.style.backdropFilter = "blur(6px)";
  topRow.appendChild(badge);

  const title = document.createElement("div");
  title.textContent = (ctx.spec && ctx.spec.title) ? ctx.spec.title : "ChatTok Live Game";
  title.style.fontWeight = "900";
  title.style.fontSize = "13px";
  title.style.padding = "6px 10px";
  title.style.borderRadius = "999px";
  title.style.background = "rgba(0,0,0,.32)";
  title.style.border = "1px solid rgba(255,255,255,.10)";
  title.style.backdropFilter = "blur(6px)";
  title.style.maxWidth = "52vw";
  title.style.whiteSpace = "nowrap";
  title.style.overflow = "hidden";
  title.style.textOverflow = "ellipsis";
  topRow.appendChild(title);

  hud.appendChild(topRow);

  // Metrics row
  const metrics = document.createElement("div");
  metrics.id = "hudMetrics";
  metrics.style.display = "flex";
  metrics.style.gap = "8px";
  metrics.style.flexWrap = "wrap";

  metrics.appendChild(makePill("Score", "0", "hudScore"));
  metrics.appendChild(makePill("Likes", "0", "hudLikes"));
  metrics.appendChild(makePill("Gifts", "0", "hudGifts"));
  metrics.appendChild(makePill("Chats", "0", "hudChats"));
  metrics.appendChild(makePill("Joins", "0", "hudJoins"));

  hud.appendChild(metrics);

  // Optional host controls (ONLY if includeHostControls AND ?host=1)
  if (ctx.spec && ctx.spec.includeHostControls && ctx.state.host) {
    const hostPanel = document.createElement("div");
    hostPanel.style.position = "absolute";
    hostPanel.style.left = "10px";
    hostPanel.style.bottom = "10px";
    hostPanel.style.display = "flex";
    hostPanel.style.gap = "8px";
    hostPanel.style.padding = "8px";
    hostPanel.style.borderRadius = "14px";
    hostPanel.style.background = "rgba(0,0,0,.35)";
    hostPanel.style.border = "1px solid rgba(255,255,255,.12)";
    hostPanel.style.backdropFilter = "blur(8px)";
    hostPanel.style.pointerEvents = "auto";

    const btn = (label, onClick) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = label;
      b.style.fontWeight = "900";
      b.style.fontSize = "12px";
      b.style.padding = "10px 12px";
      b.style.borderRadius = "12px";
      b.style.border = "1px solid rgba(255,255,255,.16)";
      b.style.background = "rgba(255,140,0,.16)";
      b.style.color = "rgba(255,255,255,.92)";
      b.style.cursor = "pointer";
      b.onclick = onClick;
      return b;
    };

    hostPanel.appendChild(
      btn("PAUSE", () => {
        ctx.state._paused = !ctx.state._paused;
        flag({ who: "HOST", msg: ctx.state._paused ? "Paused" : "Resumed", pfp: "" });
      })
    );
    hostPanel.appendChild(
      btn("RESET", () => {
        softResetMode();
        flag({ who: "HOST", msg: "Reset round", pfp: "" });
      })
    );

    wrap.appendChild(hostPanel);
  }

  gameRoot.appendChild(wrap);

  // 2d context
  try {
    g = canvas.getContext("2d", { alpha: true, desynchronized: true });
  } catch {
    g = canvas.getContext("2d");
  }

  resizeCanvas();
  renderMeters();
}

function makePill(label, value, id) {
  const pill = document.createElement("div");
  pill.style.display = "flex";
  pill.style.gap = "6px";
  pill.style.alignItems = "center";
  pill.style.padding = "6px 10px";
  pill.style.borderRadius = "999px";
  pill.style.background = "rgba(0,0,0,.28)";
  pill.style.border = "1px solid rgba(255,255,255,.10)";
  pill.style.backdropFilter = "blur(6px)";

  const a = document.createElement("div");
  a.style.fontSize = "11px";
  a.style.fontWeight = "900";
  a.style.color = "rgba(255,255,255,.72)";
  a.textContent = label;

  const b = document.createElement("div");
  b.id = id;
  b.style.fontSize = "12px";
  b.style.fontWeight = "900";
  b.style.color = "rgba(255,255,255,.92)";
  b.textContent = value;

  pill.appendChild(a);
  pill.appendChild(b);
  return pill;
}

function renderMeters() {
  const set = (id, v) => {
    const el = document.getElementById(id);
    if (el) el.textContent = String(v);
  };
  set("hudScore", Math.floor(ctx.state.score.points || 0));
  set("hudLikes", Math.floor(ctx.state.counters.likes || 0));
  set("hudGifts", Math.floor(ctx.state.counters.gifts || 0));
  set("hudChats", Math.floor(ctx.state.counters.chats || 0));
  set("hudJoins", Math.floor(ctx.state.counters.joins || 0));
}

function resizeCanvas() {
  if (!canvas || !g) return;
  const rect = canvas.getBoundingClientRect();
  const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
  const w = Math.max(2, Math.floor(rect.width * dpr));
  const h = Math.max(2, Math.floor(rect.height * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
}

/* =========================================================
   Mode engine (built-in templates)
========================================================= */
const MODES = {
  bossraid: createBossRaidMode,
  asteroids: createAsteroidsMode,
  runner: createRunnerMode,
  trivia: createTriviaMode,
  wheel: createWheelMode,
  arena: createArenaMode,
};

function pickModeIdFromSpec() {
  const allowed = new Set(["bossraid", "asteroids", "runner", "trivia", "wheel", "arena"]);
  const id = String(ctx.spec?.templateId || "").trim().toLowerCase();
  return allowed.has(id) ? id : "bossraid";
}

function ensureMode() {
  const want = pickModeIdFromSpec();
  if (ctx.state.mode && ctx.state.modeId === want) return;

  ctx.state.modeId = want;
  ctx.state.mode = MODES[want] ? MODES[want](ctx) : createBossRaidMode(ctx);
  try {
    ctx.state.mode.init();
  } catch (e) {
    console.error(e);
    ctx.state.modeId = "bossraid";
    ctx.state.mode = createBossRaidMode(ctx);
    ctx.state.mode.init();
  }

  // Always show the mode in status (user-friendly)
  setStatus(`Ready: ${want}`, true);
}

function softResetMode() {
  try {
    ctx.state.score.points = 0;
    ctx.state.score.streak = 0;
    ctx.state.score.level = 1;
    ctx.state.counters.likes = 0;
    ctx.state.counters.gifts = 0;
    ctx.state.counters.chats = 0;
    ctx.state.counters.joins = 0;
    renderMeters();
  } catch {}
  try {
    if (ctx.state.mode && ctx.state.mode.reset) ctx.state.mode.reset();
  } catch {}
}

/* =========================================================
   Built-in template: Boss Raid (default)
   - Likes chip damage
   - Gifts big damage + burst
   - Chat “attack” boosts damage
========================================================= */
function createBossRaidMode(ctx) {
  const S = {
    bossHp: 1000,
    bossHpMax: 1000,
    bossX: 0,
    bossY: 0,
    bossR: 0,
    shake: 0,
    particles: [],
    lastAuto: 0,
    dmgBoostUntil: 0,
  };

  function init() {
    S.bossHpMax = 1000 + Math.floor(rand(0, 600));
    S.bossHp = S.bossHpMax;
    S.particles.length = 0;
    S.dmgBoostUntil = 0;
    ctx.state.score.points = 0;
    ctx.fx.pulse();
  }

  function reset() {
    init();
  }

  function spawnBurst(x, y, n, pow) {
    for (let i = 0; i < n; i++) {
      S.particles.push({
        x,
        y,
        vx: rand(-1, 1) * pow,
        vy: rand(-1, 1) * pow,
        r: rand(1, 4),
        life: rand(20, 55),
      });
    }
  }

  function damage(amount, label) {
    const a = Math.max(1, Math.floor(amount));
    S.bossHp = Math.max(0, S.bossHp - a);
    ctx.state.score.points += a;
    renderMeters();
    ctx.fx.shake(180);
    ctx.fx.burst();
    if (label) flag({ who: "RAID", msg: label, pfp: "" });
  }

  function onChat(chat) {
    const t = String(chat?.text || "").toLowerCase();
    if (t.includes("attack") || t.includes("hit") || t.includes("fire")) {
      S.dmgBoostUntil = nowMs() + 2500;
      damage(6, `⚔️ ${chat.nickname || "viewer"} attacked!`);
    }
  }

  function onLike(like) {
    const boosted = nowMs() < S.dmgBoostUntil;
    damage(boosted ? 10 : 4);
  }

  function onGift(gift) {
    const repeat = Number(gift?.repeat || 1) || 1;
    const diamond = Number(gift?.diamond || 0) || 0;
    const base = 40 + Math.min(220, diamond);
    damage(base * repeat, `🎁 Power hit x${repeat}`);
  }

  function onJoin(join) {
    damage(8, `👋 ${join.nickname || "viewer"} joined the raid!`);
  }

  function update(dt, w, h) {
    // gentle idle auto sparks so it looks alive even without input
    S.lastAuto += dt;
    if (S.lastAuto > 0.28) {
      S.lastAuto = 0;
      spawnBurst(rand(w * 0.3, w * 0.7), rand(h * 0.20, h * 0.48), 2, 0.7);
    }

    for (const p of S.particles) {
      p.x += p.vx * dt * 60;
      p.y += p.vy * dt * 60;
      p.vx *= 0.985;
      p.vy *= 0.985;
      p.life -= dt * 60;
    }
    S.particles = S.particles.filter((p) => p.life > 0);

    // boss position
    S.bossX = w * 0.5;
    S.bossY = h * 0.34;
    S.bossR = Math.min(w, h) * 0.12;
  }

  function draw(g, w, h) {
    // background stars
    g.save();
    g.globalAlpha = 0.12;
    for (let i = 0; i < 26; i++) {
      g.fillStyle = "white";
      g.beginPath();
      g.arc(rand(0, w), rand(0, h), rand(0.8, 2.2), 0, Math.PI * 2);
      g.fill();
    }
    g.restore();

    // boss
    const shake = nowMs() < ctx.state.camera.shakeUntil ? rand(-2, 2) : 0;
    const x = S.bossX + shake;
    const y = S.bossY + shake;

    // glow
    g.save();
    g.globalAlpha = 0.25;
    g.fillStyle = "orange";
    g.beginPath();
    g.arc(x, y, S.bossR * 1.35, 0, Math.PI * 2);
    g.fill();
    g.restore();

    // body
    g.save();
    g.fillStyle = "rgba(255,140,0,.85)";
    g.beginPath();
    g.arc(x, y, S.bossR, 0, Math.PI * 2);
    g.fill();
    g.restore();

    // eyes
    g.save();
    g.fillStyle = "rgba(0,0,0,.55)";
    g.beginPath();
    g.arc(x - S.bossR * 0.30, y - S.bossR * 0.12, S.bossR * 0.12, 0, Math.PI * 2);
    g.arc(x + S.bossR * 0.30, y - S.bossR * 0.12, S.bossR * 0.12, 0, Math.PI * 2);
    g.fill();
    g.restore();

    // HP bar
    const pad = 14;
    const barW = w - pad * 2;
    const barH = 12;
    const barX = pad;
    const barY = Math.max(10, Math.floor(h * 0.10));
    const r = clamp(S.bossHp / S.bossHpMax, 0, 1);

    g.save();
    g.fillStyle = "rgba(0,0,0,.35)";
    roundRect(g, barX, barY, barW, barH, 999);
    g.fill();
    g.fillStyle = "rgba(255,140,0,.88)";
    roundRect(g, barX, barY, Math.max(6, barW * r), barH, 999);
    g.fill();
    g.strokeStyle = "rgba(255,255,255,.18)";
    g.lineWidth = 1;
    roundRect(g, barX, barY, barW, barH, 999);
    g.stroke();
    g.restore();

    // particles
    g.save();
    g.globalAlpha = 0.85;
    g.fillStyle = "rgba(255,200,120,.85)";
    for (const p of S.particles) {
      g.beginPath();
      g.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      g.fill();
    }
    g.restore();

    // KO message
    if (S.bossHp <= 0) {
      g.save();
      g.globalAlpha = 0.95;
      g.fillStyle = "rgba(0,0,0,.45)";
      roundRect(g, w * 0.18, h * 0.42, w * 0.64, 80, 18);
      g.fill();
      g.fillStyle = "rgba(255,255,255,.94)";
      g.font = `${Math.floor(Math.min(w, h) * 0.06)}px system-ui,Segoe UI,Roboto,Arial`;
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.fillText("BOSS DEFEATED!", w * 0.5, h * 0.46);
      g.font = `700 ${Math.floor(Math.min(w, h) * 0.028)}px system-ui,Segoe UI,Roboto,Arial`;
      g.fillText("Chat keeps the raid going…", w * 0.5, h * 0.52);
      g.restore();
    }
  }

  return { init, reset, update, draw, onChat, onLike, onGift, onJoin };
}

/* =========================================================
   Built-in template: Asteroids
========================================================= */
function createAsteroidsMode(ctx) {
  const S = {
    ship: { x: 0, y: 0, vx: 0, vy: 0 },
    ast: [],
    bullets: [],
    particles: [],
    lastSpawn: 0,
    lastFire: 0,
  };

  function init() {
    S.ast.length = 0;
    S.bullets.length = 0;
    S.particles.length = 0;
    ctx.state.score.points = 0;
    ctx.fx.pulse();
  }

  function reset() {
    init();
  }

  function spawnAst(w) {
    S.ast.push({
      x: rand(w * 0.12, w * 0.88),
      y: -30,
      vx: rand(-0.4, 0.4),
      vy: rand(0.6, 1.3),
      r: rand(14, 34),
      hp: 1,
    });
  }

  function fire() {
    S.bullets.push({ x: S.ship.x, y: S.ship.y - 18, vx: 0, vy: -7 });
    ctx.fx.spark();
  }

  function onChat(chat) {
    const t = String(chat?.text || "").toLowerCase();
    if (t.includes("left")) S.ship.vx -= 0.9;
    if (t.includes("right")) S.ship.vx += 0.9;
    if (t.includes("fire") || t.includes("shoot") || t.includes("pew")) fire();
  }

  function onLike() {
    // likes auto-fire slightly
    if ((ctx.state.counters.likes % 8) === 0) fire();
  }

  function onGift(gift) {
    // gift: clear wave burst
    ctx.fx.burst();
    for (const a of S.ast) a.hp = 0;
  }

  function onJoin() {
    // join = bonus points
    ctx.state.score.points += 15;
    renderMeters();
  }

  function update(dt, w, h) {
    // ship
    S.ship.x = clamp(S.ship.x + S.ship.vx * dt * 60, 20, w - 20);
    S.ship.y = h * 0.78;
    S.ship.vx *= 0.92;

    // spawn asteroids constantly (alive even with no inputs)
    S.lastSpawn += dt;
    if (S.lastSpawn > 0.55) {
      S.lastSpawn = 0;
      spawnAst(w);
    }

    // bullets
    for (const b of S.bullets) {
      b.y += b.vy * dt * 60;
    }
    S.bullets = S.bullets.filter((b) => b.y > -40);

    // asteroids
    for (const a of S.ast) {
      a.x += a.vx * dt * 60;
      a.y += a.vy * dt * 60;
    }

    // collisions
    for (const a of S.ast) {
      for (const b of S.bullets) {
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        if (dx * dx + dy * dy < (a.r + 5) * (a.r + 5)) {
          a.hp = 0;
          b.y = -9999;
          ctx.state.score.points += 10;
          ctx.fx.shake(120);
          for (let i = 0; i < 10; i++) {
            S.particles.push({ x: a.x, y: a.y, vx: rand(-2, 2), vy: rand(-2, 2), life: rand(18, 42) });
          }
          renderMeters();
        }
      }
    }

    S.ast = S.ast.filter((a) => a.hp > 0 && a.y < h + 60);

    for (const p of S.particles) {
      p.x += p.vx * dt * 60;
      p.y += p.vy * dt * 60;
      p.vx *= 0.97;
      p.vy *= 0.97;
      p.life -= dt * 60;
    }
    S.particles = S.particles.filter((p) => p.life > 0);

    // gentle auto-fire so it always looks playable
    S.lastFire += dt;
    if (S.lastFire > 0.65) {
      S.lastFire = 0;
      fire();
    }
  }

  function draw(g, w, h) {
    // stars
    g.save();
    g.globalAlpha = 0.13;
    g.fillStyle = "white";
    for (let i = 0; i < 22; i++) {
      g.beginPath();
      g.arc(rand(0, w), rand(0, h), rand(0.6, 1.8), 0, Math.PI * 2);
      g.fill();
    }
    g.restore();

    // ship
    const shake = nowMs() < ctx.state.camera.shakeUntil ? rand(-2, 2) : 0;
    g.save();
    g.translate(S.ship.x + shake, S.ship.y + shake);
    g.fillStyle = "rgba(255,140,0,.88)";
    g.beginPath();
    g.moveTo(0, -20);
    g.lineTo(16, 18);
    g.lineTo(-16, 18);
    g.closePath();
    g.fill();
    g.restore();

    // bullets
    g.save();
    g.strokeStyle = "rgba(255,255,255,.70)";
    g.lineWidth = 2;
    for (const b of S.bullets) {
      g.beginPath();
      g.moveTo(b.x, b.y);
      g.lineTo(b.x, b.y + 10);
      g.stroke();
    }
    g.restore();

    // asteroids
    g.save();
    g.fillStyle = "rgba(255,255,255,.12)";
    g.strokeStyle = "rgba(255,255,255,.22)";
    for (const a of S.ast) {
      g.beginPath();
      g.arc(a.x, a.y, a.r, 0, Math.PI * 2);
      g.fill();
      g.stroke();
    }
    g.restore();

    // particles
    g.save();
    g.globalAlpha = 0.9;
    g.fillStyle = "rgba(255,200,140,.85)";
    for (const p of S.particles) {
      g.beginPath();
      g.arc(p.x, p.y, 2, 0, Math.PI * 2);
      g.fill();
    }
    g.restore();
  }

  return { init, reset, update, draw, onChat, onLike, onGift, onJoin };
}

/* =========================================================
   Built-in template: Runner
========================================================= */
function createRunnerMode(ctx) {
  const S = {
    y: 0,
    vy: 0,
    onGround: true,
    obstacles: [],
    t: 0,
    speed: 3.2,
  };

  function init() {
    S.y = 0;
    S.vy = 0;
    S.onGround = true;
    S.obstacles.length = 0;
    S.t = 0;
    S.speed = 3.2;
    ctx.state.score.points = 0;
  }

  function reset() {
    init();
  }

  function jump() {
    if (!S.onGround) return;
    S.onGround = false;
    S.vy = -10.5;
    ctx.fx.spark();
  }

  function onChat(chat) {
    const t = String(chat?.text || "").toLowerCase();
    if (t.includes("jump") || t.includes("up")) jump();
  }

  function onLike() {
    // likes = tiny speed boost
    if ((ctx.state.counters.likes % 15) === 0) S.speed = Math.min(6.5, S.speed + 0.3);
  }

  function onGift() {
    // gift clears nearest obstacle
    if (S.obstacles.length) S.obstacles.shift();
    ctx.fx.burst();
  }

  function onJoin() {
    ctx.state.score.points += 5;
    renderMeters();
  }

  function update(dt, w, h) {
    const groundY = h * 0.78;
    S.t += dt;

    // gravity
    if (!S.onGround) {
      S.vy += 0.62;
      S.y += S.vy;
      if (S.y >= 0) {
        S.y = 0;
        S.vy = 0;
        S.onGround = true;
      }
    }

    // spawn obstacles
    if (Math.random() < 0.028) {
      S.obstacles.push({ x: w + 40, w: rand(18, 34), h: rand(24, 52) });
    }

    // move obstacles
    for (const o of S.obstacles) o.x -= S.speed * dt * 60;
    S.obstacles = S.obstacles.filter((o) => o.x > -80);

    // collision
    const px = w * 0.22;
    const py = groundY + S.y;
    for (const o of S.obstacles) {
      const ox = o.x;
      const ow = o.w;
      const oh = o.h;
      if (px + 18 > ox && px - 18 < ox + ow && py + 18 > groundY - oh && py - 18 < groundY) {
        // hit
        ctx.fx.shake(220);
        ctx.state.score.streak = 0;
        S.speed = Math.max(3.0, S.speed - 0.5);
        // knock obstacle away
        o.x += 40;
      }
    }

    // score climbs automatically
    ctx.state.score.points += dt * 8;
    renderMeters();
  }

  function draw(g, w, h) {
    const groundY = h * 0.78;

    // ground
    g.save();
    g.strokeStyle = "rgba(255,255,255,.18)";
    g.lineWidth = 3;
    g.beginPath();
    g.moveTo(0, groundY);
    g.lineTo(w, groundY);
    g.stroke();
    g.restore();

    // runner
    const shake = nowMs() < ctx.state.camera.shakeUntil ? rand(-2, 2) : 0;
    const px = w * 0.22 + shake;
    const py = groundY + S.y + shake;

    g.save();
    g.fillStyle = "rgba(255,140,0,.88)";
    roundRect(g, px - 16, py - 32, 32, 32, 10);
    g.fill();
    g.restore();

    // obstacles
    g.save();
    g.fillStyle = "rgba(255,255,255,.14)";
    g.strokeStyle = "rgba(255,255,255,.22)";
    for (const o of S.obstacles) {
      roundRect(g, o.x, groundY - o.h, o.w, o.h, 10);
      g.fill();
      g.stroke();
    }
    g.restore();
  }

  return { init, reset, update, draw, onChat, onLike, onGift, onJoin };
}

/* =========================================================
   Built-in template: Trivia (lightweight)
   - Chat answers A/B/C
========================================================= */
function createTriviaMode(ctx) {
  const BANK = [
    { q: "Which planet is known as the Red Planet?", a: "B", c: ["A) Venus", "B) Mars", "C) Jupiter"] },
    { q: "What is 7 + 8?", a: "C", c: ["A) 14", "B) 16", "C) 15"] },
    { q: "Which animal is the largest?", a: "A", c: ["A) Blue whale", "B) Elephant", "C) Giraffe"] },
    { q: "What color do you get from red + yellow?", a: "B", c: ["A) Purple", "B) Orange", "C) Green"] },
  ];

  const S = {
    cur: null,
    showAnswerUntil: 0,
    answered: new Set(),
  };

  function init() {
    nextQ();
    ctx.state.score.points = 0;
    ctx.state.score.streak = 0;
    ctx.fx.pulse();
  }

  function reset() {
    init();
  }

  function nextQ() {
    S.cur = pick(BANK);
    S.showAnswerUntil = 0;
    S.answered.clear();
    flag({ who: "TRIVIA", msg: "Answer with A, B, or C!", pfp: "" });
  }

  function onChat(chat) {
    if (!S.cur) return;
    const uid = String(chat?.uniqueId || chat?.userId || chat?.nickname || "");
    if (uid && S.answered.has(uid)) return;

    const t = String(chat?.text || "").trim().toUpperCase();
    const m = t.match(/\b(A|B|C)\b/);
    if (!m) return;

    const guess = m[1];
    S.answered.add(uid);

    if (guess === S.cur.a) {
      ctx.state.score.points += 25;
      ctx.state.score.streak += 1;
      ctx.fx.burst();
      flag({ who: chat.nickname || "viewer", msg: "✅ Correct!", pfp: chat.pfp || "" });
      S.showAnswerUntil = nowMs() + 1800;
      // auto-next shortly after showing answer
      setTimeout(() => nextQ(), 1700);
      renderMeters();
    } else {
      ctx.state.score.streak = 0;
      flag({ who: chat.nickname || "viewer", msg: "❌ Wrong", pfp: chat.pfp || "" });
      renderMeters();
    }
  }

  function onLike() {
    // likes add tiny points
    if ((ctx.state.counters.likes % 20) === 0) {
      ctx.state.score.points += 5;
      renderMeters();
    }
  }

  function onGift() {
    // gift reveals answer briefly
    if (!S.cur) return;
    S.showAnswerUntil = nowMs() + 2200;
    ctx.fx.spark();
  }

  function onJoin() {}

  function update(_dt, _w, _h) {}

  function draw(g, w, h) {
    if (!S.cur) return;

    // question card
    g.save();
    g.globalAlpha = 0.92;
    g.fillStyle = "rgba(0,0,0,.35)";
    roundRect(g, w * 0.08, h * 0.22, w * 0.84, h * 0.32, 18);
    g.fill();
    g.strokeStyle = "rgba(255,255,255,.14)";
    g.lineWidth = 1;
    roundRect(g, w * 0.08, h * 0.22, w * 0.84, h * 0.32, 18);
    g.stroke();

    g.fillStyle = "rgba(255,255,255,.92)";
    g.font = `900 ${Math.floor(Math.min(w, h) * 0.035)}px system-ui,Segoe UI,Roboto,Arial`;
    g.textAlign = "left";
    g.textBaseline = "top";
    drawWrappedText(g, S.cur.q, w * 0.10, h * 0.24, w * 0.80, Math.floor(Math.min(w, h) * 0.042));

    g.font = `800 ${Math.floor(Math.min(w, h) * 0.03)}px system-ui,Segoe UI,Roboto,Arial`;
    g.fillStyle = "rgba(255,255,255,.80)";
    g.fillText(S.cur.c[0], w * 0.10, h * 0.36);
    g.fillText(S.cur.c[1], w * 0.10, h * 0.41);
    g.fillText(S.cur.c[2], w * 0.10, h * 0.46);

    // show answer
    if (nowMs() < S.showAnswerUntil) {
      g.fillStyle = "rgba(255,140,0,.92)";
      g.font = `900 ${Math.floor(Math.min(w, h) * 0.032)}px system-ui,Segoe UI,Roboto,Arial`;
      g.fillText(`Correct: ${S.cur.a}`, w * 0.10, h * 0.52);
    }

    g.restore();
  }

  return { init, reset, update, draw, onChat, onLike, onGift, onJoin };
}

/* =========================================================
   Built-in template: Wheel (simple visual wheel)
========================================================= */
function createWheelMode(ctx) {
  const S = { angle: 0, spin: 0, entrants: [] };

  function init() {
    S.angle = 0;
    S.spin = 0.02;
    S.entrants = [];
    flag({ who: "WHEEL", msg: "Type JOIN to enter!", pfp: "" });
  }

  function reset() {
    init();
  }

  function addEntrant(name) {
    name = safeText(name, 16);
    if (!name) return;
    if (S.entrants.includes(name)) return;
    S.entrants.push(name);
    ctx.fx.spark();
  }

  function spinNow() {
    S.spin = rand(0.18, 0.32);
    setTimeout(() => {
      S.spin = 0.02;
      // pick winner
      if (S.entrants.length) {
        const winner = pick(S.entrants);
        flag({ who: "WINNER", msg: winner, pfp: "" });
        ctx.fx.burst();
      }
    }, 2200);
  }

  function onChat(chat) {
    const t = String(chat?.text || "").toLowerCase();
    if (t.includes("join")) addEntrant(chat.nickname || chat.uniqueId || "viewer");
    if (t.includes("spin")) spinNow();
  }

  function onLike() {
    if ((ctx.state.counters.likes % 50) === 0) spinNow();
  }

  function onGift() {
    spinNow();
  }

  function onJoin(join) {
    addEntrant(join.nickname || "viewer");
  }

  function update(dt) {
    S.angle += S.spin * dt * 60;
    S.spin *= 0.985;
    if (S.spin < 0.02) S.spin = 0.02;
  }

  function draw(g, w, h) {
    const cx = w * 0.5;
    const cy = h * 0.50;
    const R = Math.min(w, h) * 0.26;

    const slices = Math.max(6, Math.min(18, S.entrants.length || 10));
    g.save();
    g.translate(cx, cy);
    g.rotate(S.angle);

    for (let i = 0; i < slices; i++) {
      const a0 = (i / slices) * Math.PI * 2;
      const a1 = ((i + 1) / slices) * Math.PI * 2;

      g.beginPath();
      g.moveTo(0, 0);
      g.arc(0, 0, R, a0, a1);
      g.closePath();
      g.fillStyle = i % 2 === 0 ? "rgba(255,140,0,.25)" : "rgba(255,255,255,.10)";
      g.fill();
      g.strokeStyle = "rgba(255,255,255,.14)";
      g.stroke();
    }

    // center hub
    g.beginPath();
    g.arc(0, 0, R * 0.16, 0, Math.PI * 2);
    g.fillStyle = "rgba(0,0,0,.35)";
    g.fill();
    g.strokeStyle = "rgba(255,255,255,.18)";
    g.stroke();

    g.restore();

    // pointer
    g.save();
    g.fillStyle = "rgba(255,140,0,.90)";
    g.beginPath();
    g.moveTo(cx, cy - R - 18);
    g.lineTo(cx - 12, cy - R + 8);
    g.lineTo(cx + 12, cy - R + 8);
    g.closePath();
    g.fill();
    g.restore();

    // entrants count
    g.save();
    g.fillStyle = "rgba(255,255,255,.85)";
    g.font = `900 ${Math.floor(Math.min(w, h) * 0.03)}px system-ui,Segoe UI,Roboto,Arial`;
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText(`${S.entrants.length} joined`, cx, cy + R + 28);
    g.restore();
  }

  return { init, reset, update, draw, onChat, onLike, onGift, onJoin };
}

/* =========================================================
   Built-in template: Arena (bouncing orbs)
========================================================= */
function createArenaMode(ctx) {
  const S = { orbs: [], lastSpawn: 0 };

  function init() {
    S.orbs = [];
    S.lastSpawn = 0;
    for (let i = 0; i < 10; i++) spawnOrb();
  }

  function reset() {
    init();
  }

  function spawnOrb(boost = 0) {
    S.orbs.push({
      x: rand(80, 520),
      y: rand(120, 880),
      vx: rand(-2, 2) * (1 + boost),
      vy: rand(-2, 2) * (1 + boost),
      r: rand(10, 20) + boost * 6,
    });
  }

  function onChat(chat) {
    const t = String(chat?.text || "").toLowerCase();
    if (t.includes("more") || t.includes("spawn")) spawnOrb(0.2);
  }

  function onLike() {
    if ((ctx.state.counters.likes % 25) === 0) spawnOrb(0.15);
  }

  function onGift() {
    for (let i = 0; i < 6; i++) spawnOrb(0.35);
    ctx.fx.burst();
  }

  function onJoin() {
    spawnOrb(0.1);
  }

  function update(dt, w, h) {
    for (const o of S.orbs) {
      o.x += o.vx * dt * 60;
      o.y += o.vy * dt * 60;

      if (o.x < o.r || o.x > w - o.r) o.vx *= -1;
      if (o.y < o.r || o.y > h - o.r) o.vy *= -1;

      o.vx *= 0.999;
      o.vy *= 0.999;
    }
  }

  function draw(g, w, h) {
    g.save();
    for (const o of S.orbs) {
      g.fillStyle = "rgba(255,140,0,.18)";
      g.beginPath();
      g.arc(o.x, o.y, o.r * 1.6, 0, Math.PI * 2);
      g.fill();

      g.fillStyle = "rgba(255,255,255,.14)";
      g.beginPath();
      g.arc(o.x, o.y, o.r, 0, Math.PI * 2);
      g.fill();

      g.strokeStyle = "rgba(255,255,255,.20)";
      g.stroke();
    }
    g.restore();
  }

  return { init, reset, update, draw, onChat, onLike, onGift, onJoin };
}

/* =========================================================
   Drawing utils
========================================================= */
function roundRect(g, x, y, w, h, r) {
  r = Math.max(0, Math.min(r, Math.min(w, h) / 2));
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

function drawWrappedText(g, text, x, y, maxWidth, lineHeight) {
  const words = String(text || "").split(/\s+/);
  let line = "";
  for (let i = 0; i < words.length; i++) {
    const test = line ? line + " " + words[i] : words[i];
    if (g.measureText(test).width > maxWidth && i > 0) {
      g.fillText(line, x, y);
      line = words[i];
      y += lineHeight;
    } else {
      line = test;
    }
  }
  if (line) g.fillText(line, x, y);
}

/* =========================================================
   Normalizers (TikTokClient messages -> simplified event data)
========================================================= */
function getUserFromMessage(m) {
  if (!m) return {};
  // tiktok-client.js uses protobuf .toObject(), common fields vary
  const user = m.user || m.userId || m.user_id || m.sender || m.author || {};
  return {
    userId: String(user.userId || user.id || m.userId || m.user_id || ""),
    uniqueId: String(user.uniqueId || user.unique_id || user.username || m.uniqueId || m.unique_id || ""),
    nickname: String(user.nickname || user.displayName || user.display_name || m.nickname || ""),
    avatar: String(user.profilePictureUrl || user.avatar || user.avatarThumb || user.avatar_thumb || m.avatar || ""),
  };
}

function normalizeChat(m) {
  const user = getUserFromMessage(m);
  const text = String(m?.text || m?.comment || m?.content || m?.message || "");
  return {
    type: "chat",
    userId: user.userId,
    uniqueId: user.uniqueId,
    nickname: user.nickname || user.uniqueId || "viewer",
    pfp: user.avatar || "",
    text,
    raw: m,
  };
}

function normalizeLike(m) {
  const user = getUserFromMessage(m);
  const count = Number(m?.likeCount ?? m?.count ?? m?.total ?? 1) || 1;
  return {
    type: "like",
    userId: user.userId,
    uniqueId: user.uniqueId,
    nickname: user.nickname || user.uniqueId || "viewer",
    pfp: user.avatar || "",
    count,
    raw: m,
  };
}

function normalizeGift(m) {
  const user = getUserFromMessage(m);
  const gift = m?.gift || m?.giftData || {};
  const giftName = String(gift?.name || gift?.giftName || m?.giftName || "Gift");
  const repeat = Number(m?.repeat ?? m?.repeatCount ?? m?.repeatcount ?? m?.count ?? 1) || 1;
  const diamond = Number(gift?.diamondCount ?? gift?.diamondcount ?? m?.diamondCount ?? 0) || 0;
  return {
    type: "gift",
    userId: user.userId,
    uniqueId: user.uniqueId,
    nickname: user.nickname || user.uniqueId || "viewer",
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
    nickname: user.nickname || user.uniqueId || "viewer",
    pfp: user.avatar || "",
    raw: m,
  };
}

/* =========================================================
   AI_REGION (filled by API) — MUST keep markers
========================================================= */
// === AI_REGION_START ===
function aiInit(ctx) {
  // Filled by API
}
function aiOnChat(ctx, chat) {
  // Filled by API
}
function aiOnLike(ctx, like) {
  // Filled by API
}
function aiOnGift(ctx, gift) {
  // Filled by API
}
// === AI_REGION_END ===

/* =========================================================
   Event router (mode first, then AI)
========================================================= */
function routeEvent(type, data) {
  try {
    ensureMode();

    if (type === "chat") {
      ctx.state.counters.chats++;
      flag({ who: data.nickname || data.uniqueId || "viewer", msg: data.text, pfp: data.pfp });
      try { ctx.state.mode.onChat && ctx.state.mode.onChat(data); } catch {}
      try { aiOnChat(ctx, data); } catch {}
    } else if (type === "like") {
      const inc = Number(data.count || 1) || 1;
      ctx.state.counters.likes += inc;
      // throttle like flags
      const now = nowMs();
      if (!ctx.state._lastLikeFlagAt) ctx.state._lastLikeFlagAt = 0;
      if (now - ctx.state._lastLikeFlagAt > 900) {
        ctx.state._lastLikeFlagAt = now;
        flag({ who: data.nickname || "viewer", msg: `❤️ +${inc}`, pfp: data.pfp });
      }
      renderMeters();
      try { ctx.state.mode.onLike && ctx.state.mode.onLike(data); } catch {}
      try { aiOnLike(ctx, data); } catch {}
    } else if (type === "gift") {
      ctx.state.counters.gifts++;
      flag({ who: data.nickname || "viewer", msg: `🎁 ${data.giftName} x${data.repeat || 1}`, pfp: data.pfp });
      renderMeters();
      try { ctx.state.mode.onGift && ctx.state.mode.onGift(data); } catch {}
      try { aiOnGift(ctx, data); } catch {}
    } else if (type === "join") {
      ctx.state.counters.joins++;
      flag({ who: data.nickname || "viewer", msg: "joined", pfp: data.pfp });
      renderMeters();
      try { ctx.state.mode.onJoin && ctx.state.mode.onJoin(data); } catch {}
    }
  } catch (e) {
    console.error(e);
  }
}

/* =========================================================
   Main loop
========================================================= */
let _last = 0;

function loop(ts) {
  requestAnimationFrame(loop);
  if (!g || !canvas) return;

  if (!_last) _last = ts;
  const dt = clamp((ts - _last) / 1000, 0, 0.05);
  _last = ts;

  resizeCanvas();

  const w = canvas.width;
  const h = canvas.height;

  // pause (host)
  if (ctx.state._paused) {
    drawFrame(dt, w, h, true);
    return;
  }

  drawFrame(dt, w, h, false);
}

function drawFrame(dt, w, h, paused) {
  // clear
  g.clearRect(0, 0, w, h);

  ensureMode();

  try {
    if (!paused && ctx.state.mode && ctx.state.mode.update) ctx.state.mode.update(dt, w, h);
  } catch (e) {
    console.error(e);
  }

  try {
    if (ctx.state.mode && ctx.state.mode.draw) ctx.state.mode.draw(g, w, h);
  } catch (e) {
    console.error(e);
  }

  // subtle overlay pulse
  const p = nowMs() - (ctx.fx._pulseAt || 0);
  if (p < 220) {
    g.save();
    g.globalAlpha = 0.12 * (1 - p / 220);
    g.fillStyle = "white";
    g.fillRect(0, 0, w, h);
    g.restore();
  }

  // paused overlay text
  if (paused) {
    g.save();
    g.globalAlpha = 0.92;
    g.fillStyle = "rgba(0,0,0,.38)";
    roundRect(g, w * 0.28, h * 0.44, w * 0.44, 70, 18);
    g.fill();
    g.fillStyle = "rgba(255,255,255,.92)";
    g.font = `900 ${Math.floor(Math.min(w, h) * 0.05)}px system-ui,Segoe UI,Roboto,Arial`;
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText("PAUSED", w * 0.5, h * 0.48);
    g.restore();
  }
}

/* =========================================================
   Connect + start
========================================================= */
function start() {
  // host mode only if enabled AND ?host=1
  ctx.state.host = String(getUrlFlag("host") || "") === "1";

  renderBase();
  ensureMode();

  // call AI init after base is built (AI can add extra visuals)
  try { aiInit(ctx); } catch (e) { console.warn(e); }

  // start animation
  requestAnimationFrame(loop);

  // Button wiring
  if (!startGameBtn) return;

  startGameBtn.addEventListener("click", async () => {
    try {
      const id = String(liveIdInput ? liveIdInput.value : "").trim();
      if (!id) throw new Error("Enter your TikTok LIVE ID.");

      setStatus("Connecting…", true);
      ctx.pendingStart = true;

      const client = new TikTokClient(id);

      // Token rule: ONLY set if present and non-empty
      const token =
        (typeof CHATTOK_CREATOR_TOKEN !== "undefined"
          ? CHATTOK_CREATOR_TOKEN
          : (window && window.CHATTOK_CREATOR_TOKEN)) || "";
      if (token && String(token).trim()) {
        client.setAccessToken(String(token).trim());
      }

      // wire events
      client.on("connected", () => {
        ctx.client = client;
        ctx.connected = true;
        setStatus("Connected.", true);
        flag({ who: "SYSTEM", msg: "Connected — going live!", pfp: "" });

        // CONNECT-FIRST: hide overlay on connected
        try { hideOverlay(); } catch {}
      });

      client.on("disconnected", (reason) => {
        ctx.connected = false;
        setStatus(`Disconnected${reason ? ": " + reason : ""}`, false);
        showOverlay();
      });

      client.on("chat", (m) => routeEvent("chat", normalizeChat(m)));
      client.on("like", (m) => routeEvent("like", normalizeLike(m)));
      client.on("gift", (m) => routeEvent("gift", normalizeGift(m)));
      client.on("join", (m) => routeEvent("join", normalizeJoin(m)));

      client.connect();

      // DO NOT hide overlay here — it hides only after the connected event.
    } catch (e) {
      console.error(e);
      ctx.pendingStart = false;
      setStatus(e?.message || String(e), false);
      showOverlay();
    }
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", start);
} else {
  start();
}
