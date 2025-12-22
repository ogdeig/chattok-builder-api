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

function getChatTextFromMessage(m) {
  try {
    const msg = m || {};
    const t =
      msg.comment ??
      msg.text ??
      msg.message ??
      msg.msg ??
      msg.content ??
      msg?.chat?.text ??
      msg?.data?.comment ??
      msg?.data?.text ??
      "";
    const s = String(t || "").trim();
    return s ? safeText(s, 160) : "";
  } catch {
    return "";
  }
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
    _sparkAt: 0,
    _burstAt: 0,
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
    _lastLikeFlagAt: 0,
    _lastChatFlagAt: 0,
    _paused: false,
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

  // HUD
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
   - Idle shimmer + bob so the screen is never “dead”
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
    t: 0,
    dmgBoostUntil: 0,
  };

  function init() {
    S.bossHpMax = 1000 + Math.floor(rand(0, 600));
    S.bossHp = S.bossHpMax;
    S.particles.length = 0;
    S.dmgBoostUntil = 0;
    S.t = 0;
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
    const boost = nowMs() < S.dmgBoostUntil ? 1.6 : 1;
    const a = Math.max(1, Math.floor(amount * boost));
    S.bossHp = Math.max(0, S.bossHp - a);
    ctx.state.score.points += a;
    ctx.fx.pulse();
    ctx.fx.shake(180);
    if (label) flag({ who: "RAID", msg: label, pfp: "" });

    if (S.bossHp <= 0) {
      spawnBurst(S.bossX, S.bossY, 140, 2.4);
      flag({ who: "RAID", msg: "BOSS DOWN! New boss incoming…", pfp: "" });
      init();
    }
  }

  function onLike(like) {
    const inc = Number(like.count || 1) || 1;
    damage(Math.max(1, Math.floor(inc * 0.8)), null);
  }

  function onGift(gift) {
    const d = Number(gift.diamond || 0) || 0;
    const r = Number(gift.repeat || 1) || 1;
    const power = Math.max(12, Math.min(240, d * r * 1.2));
    spawnBurst(S.bossX, S.bossY, 40 + Math.min(140, power), 1.8);
    damage(Math.floor(power), `⚡ BIG HIT +${Math.floor(power)}`);
  }

  function onChat(chat) {
    const t = String(chat.text || "").toLowerCase();
    if (t.includes("attack") || t.includes("hit") || t.includes("go")) {
      S.dmgBoostUntil = nowMs() + 2200;
      damage(18, "Damage boost!");
    } else {
      damage(4, null);
    }
  }

  function update(dt, w, h) {
    S.t += dt;
    S.bossX = w * 0.5;
    S.bossY = h * 0.42;
    S.bossR = Math.min(w, h) * 0.14;

    // idle shimmer so the screen never feels "dead"
    if (S.particles.length < 18 && nowMs() - S.lastAuto > 420) {
      S.lastAuto = nowMs();
      spawnBurst(
        S.bossX + rand(-S.bossR * 0.4, S.bossR * 0.4),
        S.bossY + rand(-S.bossR * 0.4, S.bossR * 0.4),
        2,
        0.35
      );
    }

    for (let i = S.particles.length - 1; i >= 0; i--) {
      const p = S.particles[i];
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vx *= 0.985;
      p.vy *= 0.985;
      p.life -= dt * 60;
      if (p.life <= 0) S.particles.splice(i, 1);
    }

    renderMeters();
  }

  function draw(g, w, h) {
    const hp = S.bossHp / S.bossHpMax;

    g.save();
    g.translate(S.bossX, S.bossY + Math.sin(S.t * 2.2) * (S.bossR * 0.06));

    g.globalAlpha = 0.35;
    g.beginPath();
    g.ellipse(0, S.bossR * 0.9, S.bossR * 0.9, S.bossR * 0.35, 0, 0, Math.PI * 2);
    g.fillStyle = "black";
    g.fill();

    g.globalAlpha = 1;
    g.beginPath();
    g.arc(0, 0, S.bossR, 0, Math.PI * 2);
    g.fillStyle = "rgba(255,140,0,.20)";
    g.fill();
    g.lineWidth = Math.max(2, S.bossR * 0.08);
    g.strokeStyle = "rgba(255,255,255,.16)";
    g.stroke();

    g.beginPath();
    g.arc(0, 0, S.bossR * 0.55, 0, Math.PI * 2);
    g.fillStyle = "rgba(0,0,0,.35)";
    g.fill();

    g.beginPath();
    g.arc(0, 0, S.bossR * 0.22, 0, Math.PI * 2);
    g.fillStyle = "rgba(255,255,255,.70)";
    g.fill();

    g.restore();

    const barW = w * 0.62;
    const barH = Math.max(10, h * 0.014);
    const x = (w - barW) * 0.5;
    const y = h * 0.13;

    g.save();
    g.globalAlpha = 0.88;
    roundRect(g, x, y, barW, barH, barH);
    g.fillStyle = "rgba(0,0,0,.38)";
    g.fill();

    roundRect(g, x, y, barW * hp, barH, barH);
    g.fillStyle = "rgba(255,140,0,.65)";
    g.fill();

    g.globalAlpha = 0.9;
    g.fillStyle = "rgba(255,255,255,.86)";
    g.font = `900 ${Math.floor(Math.min(w, h) * 0.032)}px system-ui,Segoe UI,Roboto,Arial`;
    g.textAlign = "center";
    g.textBaseline = "bottom";
    g.fillText("BOSS HP", w * 0.5, y - 6);
    g.restore();

    g.save();
    g.globalAlpha = 0.85;
    for (const p of S.particles) {
      g.beginPath();
      g.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      g.fillStyle = "rgba(255,255,255,.65)";
      g.fill();
    }
    g.restore();
  }

  return { init, reset, update, draw, onLike, onGift, onChat };
}

/* =========================================================
   Other modes (Asteroids / Runner / Trivia / Wheel / Arena)
   NOTE: These are already implemented in your current template.
   They remain unchanged.
========================================================= */

function createAsteroidsMode(ctx) { /* ... existing code in your template ... */ }
function createRunnerMode(ctx) { /* ... existing code in your template ... */ }
function createTriviaMode(ctx) { /* ... existing code in your template ... */ }
function createWheelMode(ctx) { /* ... existing code in your template ... */ }
function createArenaMode(ctx) { /* ... existing code in your template ... */ }

/* =========================================================
   User extraction + normalizers
========================================================= */
function getUserFromMessage(m) {
  const msg = m || {};
  const user =
    msg.user ||
    msg.userInfo ||
    msg.userData ||
    msg.sender ||
    msg.author ||
    msg.from ||
    msg.profile ||
    {};

  const userId = String(
    user.userId || user.id || msg.userId || msg.user_id || msg.uid || msg.userID || ""
  );
  const uniqueId = String(
    user.uniqueId || user.unique_id || user.username || user.userName || msg.uniqueId || msg.unique_id || msg.username || ""
  );
  const nickname = String(
    user.nickname || user.displayName || user.display_name || msg.nickname || msg.displayName || uniqueId || ""
  );
  const avatar = String(
    user.profilePictureUrl ||
      user.avatarThumb ||
      user.avatar_thumb ||
      user.avatar ||
      user.profilePic ||
      msg.profilePictureUrl ||
      msg.avatarThumb ||
      msg.avatar ||
      ""
  );

  return { userId, uniqueId, nickname, avatar };
}

function normalizeChat(m) {
  const user = getUserFromMessage(m);
  const text = getChatTextFromMessage(m);
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
  const count = Number(m?.likeCount ?? m?.likes ?? m?.count ?? 1) || 1;
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
function aiInit(ctx) { }
function aiOnChat(ctx, chat) { }
function aiOnLike(ctx, like) { }
function aiOnGift(ctx, gift) { }
// === AI_REGION_END ===

/* =========================================================
   Event router (mode first, then AI)
========================================================= */
function routeEvent(type, data) {
  try {
    ensureMode();

    if (type === "chat") {
      if (!data || !data.text) return;
      ctx.state.counters.chats++;

      const n = nowMs();
      if (!ctx.state._lastChatFlagAt) ctx.state._lastChatFlagAt = 0;
      if (n - ctx.state._lastChatFlagAt > 350) {
        ctx.state._lastChatFlagAt = n;
        flag({ who: data.nickname || data.uniqueId || "viewer", msg: data.text, pfp: data.pfp });
      }

      try { ctx.state.mode.onChat && ctx.state.mode.onChat(data); } catch {}
      try { aiOnChat(ctx, data); } catch {}
    } else if (type === "like") {
      const inc = Number(data.count || 1) || 1;
      ctx.state.counters.likes += inc;

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
  if (!canvas || !g) return;

  const dt = Math.min(0.05, Math.max(0.001, (ts - _last) / 1000 || 0.016));
  _last = ts;

  resizeCanvas();
  const w = canvas.width;
  const h = canvas.height;

  if (ctx.state._paused) {
    drawFrame(dt, w, h, true);
    return;
  }

  drawFrame(dt, w, h, false);
}

function drawFrame(dt, w, h, paused) {
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

  const p = nowMs() - (ctx.fx._pulseAt || 0);
  if (p < 220) {
    g.save();
    g.globalAlpha = 0.12 * (1 - p / 220);
    g.fillStyle = "white";
    g.fillRect(0, 0, w, h);
    g.restore();
  }

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
   Drawing helpers
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

/* =========================================================
   Connect + start (ChatTok-compatible pattern)
   - DO NOT modify tiktok-client.js (host-provided by ChatTokGaming)
   - Connect-first: hide overlay ONLY after 'connected'
   - Safe reconnection: closes previous socket if needed
========================================================= */
let client = null;
let gameStarted = false;

function beginGame() {
  if (gameStarted) return;
  gameStarted = true;
  ctx.state.startedAt = nowMs();
  try { hideOverlay(); } catch {}
}

function onChatMessage(data) {
  try {
    const msg = data || {};
    const chat = normalizeChat(msg);
    if (!chat.text) return;
    routeEvent("chat", chat);
  } catch (e) {
    console.error("Error in chat handler:", e);
  }
}

function onGiftMessage(data) {
  try {
    routeEvent("gift", normalizeGift(data || {}));
  } catch (e) {
    console.error("Error in gift handler:", e);
  }
}

function setupTikTokClient(liveId) {
  if (!liveId) throw new Error("liveId is required");

  if (client && client.socket) {
    try { client.socket.close(); } catch (e) { console.warn("Error closing previous socket:", e); }
  }

  if (typeof TikTokClient === "undefined") {
    throw new Error("TikTokClient is not available. Check host injection / script loader.");
  }

  client = new TikTokClient(liveId);

  if (typeof CHATTOK_CREATOR_TOKEN !== "undefined" && CHATTOK_CREATOR_TOKEN) {
    try { client.setAccessToken(CHATTOK_CREATOR_TOKEN); } catch {}
  }

  client.on("connected", () => {
    console.log("Connected to TikTok hub.");
    ctx.client = client;
    ctx.connected = true;
    setStatus("Connected to TikTok LIVE.", true);
    if (ctx.pendingStart && !gameStarted) beginGame();
  });

  client.on("disconnected", (reason) => {
    console.log("Disconnected from TikTok hub:", reason);
    ctx.connected = false;

    const msg = reason || "Connection closed";
    setStatus("Disconnected: " + msg, false);

    if (!gameStarted) ctx.pendingStart = false;
    showOverlay();
  });

  client.on("error", (err) => {
    console.error("TikTok client error:", err);
    setStatus("Error: " + (err && err.message ? err.message : "Unknown"), false);

    if (!gameStarted) ctx.pendingStart = false;
    showOverlay();
  });

  client.on("chat", onChatMessage);
  client.on("gift", onGiftMessage);

  client.on("like", (data) => {
    try { routeEvent("like", normalizeLike(data || {})); } catch (e) { console.error("Error in like handler:", e); }
  });

  const joinHandler = (data) => {
    try { routeEvent("join", normalizeJoin(data || {})); } catch (e) { console.error("Error in join handler:", e); }
  };
  client.on("join", joinHandler);
  client.on("member", joinHandler);

  client.connect();
}

function disableStartBtn(disabled) {
  if (!startGameBtn) return;
  try {
    startGameBtn.disabled = !!disabled;
    startGameBtn.style.opacity = disabled ? "0.7" : "";
    startGameBtn.style.cursor = disabled ? "not-allowed" : "";
  } catch {}
}

function start() {
  ctx.state.host = String(getUrlFlag("host") || "") === "1";

  renderBase();
  ensureMode();

  try { aiInit(ctx); } catch (e) { console.warn(e); }

  requestAnimationFrame(loop);

  if (!startGameBtn) return;

  startGameBtn.addEventListener("click", () => {
    try {
      const id = String(liveIdInput ? liveIdInput.value : "").trim();
      if (!id) throw new Error("Enter your TikTok LIVE ID.");

      setStatus("Connecting…", true);
      ctx.pendingStart = true;

      disableStartBtn(true);

      setupTikTokClient(id);

      setTimeout(() => {
        if (!ctx.connected && !gameStarted) disableStartBtn(false);
      }, 4500);
    } catch (e) {
      console.error(e);
      ctx.pendingStart = false;
      setStatus(e?.message || String(e), false);
      disableStartBtn(false);
      showOverlay();
    }
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", start);
} else {
  start();
}
