/* game.js (template-first, MULTI-TEMPLATE ENGINE)
   - TikTok connection uses your existing TikTokClient (tiktok-client.js)
   - AI fills ONLY the region between the markers.
   - Everything else stays stable to reduce token usage.
   - This template contains MULTIPLE game engines (asteroids, boss, + stubs).
   - Engine auto-picks from SPEC text if SPEC.templateId is missing.
*/

// This constant is injected server-side.
const SPEC = __SPEC_JSON__;

/* ASSET PLAN CHECKLIST (keep these visuals present every build)
   - Always-moving demo loop (never a dead screen)
   - Procedural sprites (no external assets required)
   - Particle system
   - Hit FX (shake + flash)
   - Gift FX tiers (S/M/L)
   - Join banner animation
*/

// ---------------- DOM ----------------
const setupOverlay = document.getElementById("setupOverlay");
const gameScreen = document.getElementById("gameScreen");
const liveIdInput = document.getElementById("liveIdInput");
const startGameBtn = document.getElementById("startGameBtn");
const statusText = document.getElementById("statusText");
const statusTextInGame = document.getElementById("statusTextInGame");
const gameRoot = document.getElementById("gameRoot");
const flagsEl = document.getElementById("flags");

// ---------------- State ----------------
const ctx = {
  spec: SPEC,
  client: null,
  pendingStart: false,
  connected: false,

  loop: {
    raf: 0,
    lastTs: 0,
    running: false,
  },

  render: {
    canvas: null,
    g: null,
    dpr: 1,
    w: 0,
    h: 0,
    hudEl: null,
    hud: { score: null, hp: null, shield: null, mode: null, title: null },
    flashEl: null,
  },

  game: null, // { id, actions, update(dt), draw(), resize(w,h), destroy() }
  actions: null, // shortcut to ctx.game.actions

  state: {
    startedAt: 0,
    settings: {},
    counters: { likes: 0, gifts: 0, chats: 0 },
    _lastLikeFlagAt: 0,
  },

  ui: {
    setStatus,
    showOverlay,
    hideOverlay,
    clearRoot,
    card,
    setMeter,
    flag,
    escapeHtml,
    readSettings,
    renderBase,
    renderMeters,
    playFX,
    connectTikTok,
    normalizeChat,
    normalizeLike,
    normalizeGift,
    normalizeJoin,
    routeEvent,
  },
};

// ---------------- UI helpers ----------------
function setStatus(text, ok) {
  const t = String(text || "").trim();
  if (statusText) statusText.textContent = t;
  if (statusTextInGame) statusTextInGame.textContent = t;

  if (statusText) statusText.dataset.ok = ok ? "1" : "0";
  if (statusTextInGame) statusTextInGame.dataset.ok = ok ? "1" : "0";
}

function showOverlay() {
  if (setupOverlay) setupOverlay.style.display = "flex";
}

function hideOverlay() {
  if (setupOverlay) setupOverlay.style.display = "none";
}

function clearRoot() {
  while (gameRoot && gameRoot.firstChild) gameRoot.removeChild(gameRoot.firstChild);
}

function card(title, bodyHtml) {
  const el = document.createElement("div");
  el.className = "card";
  el.innerHTML = `<h3>${escapeHtml(title)}</h3><div>${bodyHtml || ""}</div>`;
  return el;
}

function setMeter(meterEl, ratio) {
  const r = Math.max(0, Math.min(1, Number(ratio) || 0));
  const fill = meterEl && meterEl.querySelector ? meterEl.querySelector("div") : null;
  if (fill) fill.style.width = `${Math.round(r * 100)}%`;
}

function flag({ who, msg, pfp }) {
  const wrap = document.createElement("div");
  wrap.className = "flag";

  const img = document.createElement("img");
  img.className = "pfp";
  img.alt = "";
  img.decoding = "async";
  img.loading = "lazy";

  const fb = document.createElement("div");
  fb.className = "pfp";
  fb.textContent = initials(who || "");
  fb.style.display = "grid";
  fb.style.placeItems = "center";
  fb.style.fontWeight = "800";
  fb.style.letterSpacing = ".5px";
  fb.style.fontSize = "12px";
  fb.style.textTransform = "uppercase";

  const hasPfp = typeof pfp === "string" && pfp.trim().length > 0;
  if (hasPfp) {
    img.src = pfp.trim();
    fb.style.display = "none";
    img.onerror = () => {
      img.style.display = "none";
      fb.style.display = "grid";
    };
  } else {
    img.style.display = "none";
  }

  const text = document.createElement("div");
  text.className = "flagText";
  text.innerHTML = `<div class="who">${escapeHtml(who || "")}</div><div class="msg">${escapeHtml(msg || "")}</div>`;

  wrap.appendChild(img);
  wrap.appendChild(fb);
  wrap.appendChild(text);

  flagsEl.prepend(wrap);

  while (flagsEl.childElementCount > 6) flagsEl.removeChild(flagsEl.lastChild);

  setTimeout(() => {
    try {
      wrap.style.opacity = "0";
      wrap.style.transform = "translateX(12px)";
    } catch {}
    setTimeout(() => wrap.remove(), 240);
  }, 4500);
}

function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// ---------------- TikTok message helpers (LOCKED SHAPE SUPPORT) ----------------
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
    const list = a1.urlList || a1.urlListList || a1.urllistList || a1.urllist || a1.url_list || a1.url_list_list;
    const pick = firstUrl(list);
    if (pick) return pick;
  }

  const a2 = u.avatarMedium || u.avatarLarge || u.avatarLarger || u.avatarlarge || null;
  if (a2) {
    const list = a2.urlList || a2.urlListList || a2.urllistList || a2.urllist || a2.url_list || a2.url_list_list;
    const pick = firstUrl(list);
    if (pick) return pick;
  }

  return "";
}

function getUserFromMessage(msg) {
  const m = msg || {};
  const u = m.user || m.userInfo || m.author || m.sender || m.user_id || m.userId || {};
  const userId = String(u.userId || u.id || m.userId || m.user_id || "");
  const nickname = String(u.nickname || u.displayName || u.uniqueId || u.displayid || u.displayId || u.username || "");
  const uniqueId = String(u.uniqueId || u.unique_id || u.displayid || u.displayId || u.username || nickname || "");
  const avatar = getAvatarUrlFromUser(u);
  return { userId, nickname, uniqueId, avatar };
}

function initials(name) {
  const s = String(name || "").trim();
  if (!s) return "?";
  const parts = s
    .replace(/[^a-zA-Z0-9\s]/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const a = (parts[0] || "").slice(0, 1).toUpperCase();
  const b = (parts[1] || parts[0] || "").slice(0, 1).toUpperCase();
  return (a + b).slice(0, 2) || "?";
}

function readSettings() {
  const out = {};
  document.querySelectorAll("[data-setting]").forEach((el) => {
    const id = el.getAttribute("data-setting");
    if (!id) return;
    if (el.type === "checkbox") out[id] = !!el.checked;
    else out[id] = String(el.value || "").trim();
  });
  ctx.state.settings = out;
  return out;
}

// ---------------- Base UI (canvas + HUD + minimal cards) ----------------
function renderBase() {
  clearRoot();

  const s = ctx.spec || {};

  // Title / status header
  const headline = document.createElement("div");
  headline.className = "bigText";
  headline.textContent = s.title || "ChatTok Live Game";

  // Game stage container (canvas)
  const stage = document.createElement("div");
  stage.style.position = "relative";
  stage.style.borderRadius = "18px";
  stage.style.overflow = "hidden";
  stage.style.border = "1px solid rgba(255,255,255,.10)";
  stage.style.background =
    "radial-gradient(1000px 400px at 30% 0%, rgba(255,0,80,.14), transparent 60%)," +
    "radial-gradient(900px 400px at 80% 0%, rgba(0,242,234,.10), transparent 60%)," +
    "linear-gradient(180deg, rgba(10,14,20,.95), rgba(6,8,12,.92))";
  stage.style.boxShadow = "0 18px 60px rgba(0,0,0,.45)";
  stage.style.minHeight = "360px";

  const canvas = document.createElement("canvas");
  canvas.id = "gameCanvas";
  canvas.style.display = "block";
  canvas.style.width = "100%";
  canvas.style.height = "420px"; // base height; will be resized for actual container
  canvas.style.background = "transparent";

  // HUD overlay
  const hud = document.createElement("div");
  hud.style.position = "absolute";
  hud.style.left = "12px";
  hud.style.top = "10px";
  hud.style.right = "12px";
  hud.style.display = "flex";
  hud.style.alignItems = "flex-start";
  hud.style.justifyContent = "space-between";
  hud.style.gap = "10px";
  hud.style.pointerEvents = "none";

  const hudLeft = document.createElement("div");
  hudLeft.style.display = "grid";
  hudLeft.style.gap = "6px";

  const pill = (text) => {
    const p = document.createElement("div");
    p.style.display = "inline-flex";
    p.style.alignItems = "center";
    p.style.gap = "8px";
    p.style.padding = "6px 10px";
    p.style.borderRadius = "999px";
    p.style.border = "1px solid rgba(255,255,255,.14)";
    p.style.background = "rgba(0,0,0,.32)";
    p.style.color = "rgba(255,255,255,.92)";
    p.style.fontFamily = "var(--mono)";
    p.style.fontSize = "12px";
    p.style.boxShadow = "0 12px 30px rgba(0,0,0,.35)";
    p.textContent = text;
    return p;
  };

  const titlePill = pill(s.subtitle || "Live Interactive");
  const modePill = pill("DEMO");
  const scorePill = pill("Score: 0");
  const hpPill = pill("HP: 100");
  const shieldPill = pill("Shield: 0%");

  hudLeft.appendChild(titlePill);
  hudLeft.appendChild(modePill);

  const hudRight = document.createElement("div");
  hudRight.style.display = "grid";
  hudRight.style.gap = "6px";
  hudRight.style.justifyItems = "end";
  hudRight.appendChild(scorePill);
  hudRight.appendChild(hpPill);
  hudRight.appendChild(shieldPill);

  hud.appendChild(hudLeft);
  hud.appendChild(hudRight);

  // Flash overlay (for big moments)
  const flash = document.createElement("div");
  flash.style.position = "absolute";
  flash.style.inset = "0";
  flash.style.pointerEvents = "none";
  flash.style.background = "transparent";
  flash.style.opacity = "0";
  flash.style.transition = "opacity 160ms ease";

  stage.appendChild(canvas);
  stage.appendChild(flash);
  stage.appendChild(hud);

  // Meters + quick help
  const meters = document.createElement("div");
  meters.className = "card";
  meters.innerHTML = `
    <h3>Live Meters</h3>
    <div class="meterGrid">
      <div>
        <div style="display:flex;justify-content:space-between;font-family:var(--mono);font-size:12px;color:rgba(234,242,255,.75)">
          <span>Likes</span><span id="likesCount">0</span>
        </div>
        <div id="likesMeter" class="meter"><div></div></div>
      </div>
      <div>
        <div style="display:flex;justify-content:space-between;font-family:var(--mono);font-size:12px;color:rgba(234,242,255,.75)">
          <span>Gifts</span><span id="giftsCount">0</span>
        </div>
        <div id="giftsMeter" class="meter"><div></div></div>
      </div>
    </div>
    <p style="margin:10px 0 0;color:rgba(234,242,255,.70);font-size:12px;line-height:1.45">
      Demo runs instantly. When LIVE: <b>Chat</b> spawns challenges, <b>Likes</b> charge shield, <b>Gifts</b> trigger power-ups.
    </p>
  `;

  const tests = document.createElement("div");
  tests.className = "card";
  tests.innerHTML = `
    <h3>Test Buttons</h3>
    <p style="margin:0 0 10px;color:rgba(234,242,255,.75);font-size:12px">
      Verify visuals before going LIVE.
    </p>
    <div style="display:flex;gap:10px;flex-wrap:wrap">
      <button class="primary-btn" style="padding:10px 12px;font-size:12px" id="testHitBtn" type="button">Hit FX</button>
      <button class="primary-btn" style="padding:10px 12px;font-size:12px" id="testGiftBtn" type="button">Gift FX</button>
      <button class="primary-btn" style="padding:10px 12px;font-size:12px" id="testJoinBtn" type="button">Join Banner</button>
      <button class="primary-btn" style="padding:10px 12px;font-size:12px" id="testLikeBtn" type="button">Like Pop</button>
      <button class="primary-btn" style="padding:10px 12px;font-size:12px" id="testAstBtn" type="button">Spawn Asteroids</button>
    </div>
  `;

  gameRoot.appendChild(headline);
  gameRoot.appendChild(stage);
  gameRoot.appendChild(meters);
  gameRoot.appendChild(tests);

  // Store render refs
  ctx.render.canvas = canvas;
  ctx.render.g = canvas.getContext("2d", { alpha: true });
  ctx.render.hudEl = hud;
  ctx.render.hud.title = titlePill;
  ctx.render.hud.mode = modePill;
  ctx.render.hud.score = scorePill;
  ctx.render.hud.hp = hpPill;
  ctx.render.hud.shield = shieldPill;
  ctx.render.flashEl = flash;

  // Attach tests
  setTimeout(() => {
    const mkUser = (name) => ({
      nickname: name,
      uniqueId: String(name || "").toLowerCase().replace(/\s+/g, ""),
      pfp: "",
    });

    const hit = document.getElementById("testHitBtn");
    const gift = document.getElementById("testGiftBtn");
    const join = document.getElementById("testJoinBtn");
    const like = document.getElementById("testLikeBtn");
    const ast = document.getElementById("testAstBtn");

    if (hit) hit.onclick = () => playFX("hit", { label: "HIT!", bg: "rgba(255,0,80,.92)" });
    if (gift)
      gift.onclick = () => {
        routeEvent("gift", { ...mkUser("Tester"), giftName: "Rose", repeat: 1 });
        playFX("gift", { label: "GIFT!", bg: "rgba(0,242,234,.92)" });
      };
    if (join)
      join.onclick = () => {
        routeEvent("join", mkUser("New Viewer"));
        playFX("join", { label: "WELCOME!", bg: "rgba(255,255,255,.92)" });
      };
    if (like)
      like.onclick = () => {
        routeEvent("like", { ...mkUser("Fan"), count: 10 });
        playFX("like", { label: "+LIKES", bg: "rgba(255,255,255,.92)" });
      };
    if (ast)
      ast.onclick = () => {
        if (ctx.actions && ctx.actions.spawnAsteroids) ctx.actions.spawnAsteroids(8, "ring");
      };
  }, 0);

  // Resize canvas to container
  resizeCanvasToStage();
}

function renderMeters() {
  const likesEl = document.getElementById("likesCount");
  const giftsEl = document.getElementById("giftsCount");
  const likesMeter = document.getElementById("likesMeter");
  const giftsMeter = document.getElementById("giftsMeter");

  if (likesEl) likesEl.textContent = String(ctx.state.counters.likes);
  if (giftsEl) giftsEl.textContent = String(ctx.state.counters.gifts);

  setMeter(likesMeter, Math.min(1, ctx.state.counters.likes / 500));
  setMeter(giftsMeter, Math.min(1, ctx.state.counters.gifts / 50));
}

function playFX(kind, detail) {
  const k = String(kind || "").toLowerCase();
  const root = document.getElementById("gameRoot") || gameRoot || document.body;

  const burst = document.createElement("div");
  burst.textContent =
    detail?.label ||
    (k === "hit" ? "HIT!" : k === "gift" ? "GIFT!" : k === "join" ? "JOIN!" : "WOW!");
  burst.style.position = "absolute";
  burst.style.left = "50%";
  burst.style.top = "34%";
  burst.style.transform = "translate(-50%,-50%)";
  burst.style.padding = "10px 14px";
  burst.style.borderRadius = "14px";
  burst.style.fontWeight = "900";
  burst.style.letterSpacing = ".6px";
  burst.style.textTransform = "uppercase";
  burst.style.fontSize = "14px";
  burst.style.color = "#0b0f14";
  burst.style.background = detail?.bg || "rgba(255,255,255,.92)";
  burst.style.boxShadow = "0 16px 36px rgba(0,0,0,.35)";
  burst.style.pointerEvents = "none";
  burst.style.zIndex = "50";

  root.appendChild(burst);

  try {
    burst.animate(
      [
        { opacity: 0, transform: "translate(-50%,-50%) scale(.7)" },
        { opacity: 1, transform: "translate(-50%,-50%) scale(1.05)" },
        { opacity: 0, transform: "translate(-50%,-70%) scale(1.12)" },
      ],
      { duration: 850, easing: "cubic-bezier(.2,.8,.2,1)" }
    );
  } catch {}

  // subtle camera shake (visual)
  try {
    gameScreen.animate(
      [
        { transform: "translateX(0px)" },
        { transform: "translateX(-2px)" },
        { transform: "translateX(2px)" },
        { transform: "translateX(0px)" },
      ],
      { duration: 220, iterations: 1 }
    );
  } catch {}

  setTimeout(() => {
    try {
      burst.remove();
    } catch {}
  }, 900);
}

// ---------------- Canvas sizing ----------------
function resizeCanvasToStage() {
  const c = ctx.render.canvas;
  if (!c) return;

  // Try to match the canvas's displayed size
  const rect = c.getBoundingClientRect();
  const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
  ctx.render.dpr = dpr;

  const w = Math.max(320, Math.floor(rect.width));
  const h = Math.max(320, Math.floor(rect.height));

  ctx.render.w = w;
  ctx.render.h = h;

  c.width = Math.floor(w * dpr);
  c.height = Math.floor(h * dpr);

  const g = ctx.render.g;
  if (g) g.setTransform(dpr, 0, 0, dpr, 0, 0);

  if (ctx.game && ctx.game.resize) {
    try { ctx.game.resize(w, h); } catch (e) { console.warn("resize error", e); }
  }
}

window.addEventListener("resize", () => {
  // Debounced resize
  clearTimeout(resizeCanvasToStage._t);
  resizeCanvasToStage._t = setTimeout(resizeCanvasToStage, 80);
});

// ---------------- TikTok wiring ----------------
function connectTikTok(liveId) {
  const id = String(liveId || "").trim().replace(/^@/, "");
  if (!id) throw new Error("Live ID is required.");

  if (ctx.client && ctx.client.socket) {
    try { ctx.client.socket.close(); } catch (e) { console.warn("Error closing previous socket:", e); }
  }

  if (typeof TikTokClient === "undefined") {
    throw new Error("TikTokClient is not available. Check tiktok-client.js.");
  }

  const client = new TikTokClient(id);

  // Token enforcement is handled server-side too, but we keep it safe here.
  const tok = (typeof CHATTOK_CREATOR_TOKEN !== "undefined" ? CHATTOK_CREATOR_TOKEN : "") || "";
  if (typeof tok === "string" ? tok.trim().length > 0 : Boolean(tok)) {
    client.setAccessToken(tok);
  }

  client.on("connected", () => {
    ctx.connected = true;
    setStatus("Connected", true);
    flag({ who: "SYSTEM", msg: "Connected to TikTok LIVE", pfp: "" });

    // CONNECT-FIRST: hide overlay on connected
    try { hideOverlay(); } catch {}

    // Update HUD
    updateHudMode();
  });

  client.on("disconnected", (reason) => {
    ctx.connected = false;
    ctx.pendingStart = false;
    const msg = (reason ? String(reason) : "Connection closed").trim();
    setStatus(`Disconnected: ${msg}`, false);
    flag({ who: "SYSTEM", msg: `Disconnected: ${msg}`, pfp: "" });
    showOverlay();
    updateHudMode();
  });

  client.on("error", (err) => {
    ctx.connected = false;
    ctx.pendingStart = false;
    const msg = err && err.message ? err.message : String(err || "Unknown error");
    setStatus(`Error: ${msg}`, false);
    flag({ who: "SYSTEM", msg: `Error: ${msg}`, pfp: "" });
    showOverlay();
    updateHudMode();
  });

  client.on("chat", (m) => routeEvent("chat", normalizeChat(m)));
  client.on("gift", (m) => routeEvent("gift", normalizeGift(m)));
  client.on("like", (m) => routeEvent("like", normalizeLike(m)));
  client.on("join", (m) => routeEvent("join", normalizeJoin(m)));

  client.connect();
  ctx.client = client;
}

function normalizeChat(m) {
  const user = getUserFromMessage(m);
  const text = getChatTextFromMessage(m);
  return {
    type: "chat",
    userId: String(user.userId || ""),
    uniqueId: String(user.uniqueId || ""),
    nickname: String(user.nickname || user.uniqueId || ""),
    pfp: String(user.avatar || ""),
    text: String(text || "").trim(),
    raw: m,
  };
}

function normalizeLike(m) {
  const user = getUserFromMessage(m);
  const count = Number(m?.count ?? m?.likeCount ?? m?.likes ?? 1) || 1;
  const total = Number(m?.total ?? m?.likeTotal ?? m?.likesTotal ?? 0) || 0;
  return {
    type: "like",
    userId: String(user.userId || ""),
    uniqueId: String(user.uniqueId || ""),
    nickname: String(user.nickname || user.uniqueId || ""),
    pfp: String(user.avatar || ""),
    count,
    total,
    raw: m,
  };
}

function normalizeGift(m) {
  const user = getUserFromMessage(m);
  const gift = m?.gift || m?.giftInfo || m?.giftinfo || {};
  const giftName = String(gift?.name || gift?.giftName || m?.giftName || "Gift");
  const repeat = Number(m?.repeat ?? m?.repeatCount ?? m?.repeatcount ?? m?.count ?? 1) || 1;
  const diamond = Number(gift?.diamondCount ?? gift?.diamondcount ?? m?.diamondCount ?? 0) || 0;
  return {
    type: "gift",
    userId: String(user.userId || ""),
    uniqueId: String(user.uniqueId || ""),
    nickname: String(user.nickname || user.uniqueId || ""),
    pfp: String(user.avatar || ""),
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
    userId: String(user.userId || ""),
    uniqueId: String(user.uniqueId || ""),
    nickname: String(user.nickname || user.uniqueId || ""),
    pfp: String(user.avatar || ""),
    raw: m,
  };
}

// ---------------- Engine selection (auto template pick) ----------------
function specTextForPick(spec) {
  const s = spec || {};
  const how = Array.isArray(s.howToPlay) ? s.howToPlay.join(" ") : "";
  return `${s.title || ""} ${s.subtitle || ""} ${s.oneSentence || ""} ${how}`.toLowerCase();
}

function autoPickTemplateFromSpec(spec) {
  // If the server (or AI) includes templateId, we respect it.
  const s = spec || {};
  const explicit = String(s.templateId || s.template || "").trim().toLowerCase();
  if (explicit) return explicit;

  const t = specTextForPick(s);

  // Keyword router (free, zero-API-cost)
  if (/(asteroid|mete(or|orite)|spaceship|space ship|spacecraft|space|ship|ufo|galaxy|cosmic)/.test(t)) return "asteroids";
  if (/(runner|endless|lane|jump|slide|obstacle|dodge|dash)/.test(t)) return "runner";
  if (/(trivia|question|answer|quiz|multiple choice|true\/false)/.test(t)) return "trivia";
  if (/(wheel|spin|spinner|raffle|lottery|giveaway)/.test(t)) return "wheel";
  if (/(boss|raid|health bar|phase|damage|dps)/.test(t)) return "bossraid";
  if (/(arena|battle|brawl|wave|enemy|monsters|survive)/.test(t)) return "arena";

  // Default fallback that always looks good:
  return "asteroids";
}

// ---------------- Core loop (always running demo) ----------------
function startLoop() {
  if (ctx.loop.running) return;
  ctx.loop.running = true;
  ctx.loop.lastTs = performance.now();

  const step = (ts) => {
    if (!ctx.loop.running) return;
    const dt = Math.min(0.033, Math.max(0.001, (ts - ctx.loop.lastTs) / 1000));
    ctx.loop.lastTs = ts;

    if (ctx.game && ctx.game.update) {
      try { ctx.game.update(dt); } catch (e) { console.error("update error", e); }
    }
    if (ctx.game && ctx.game.draw) {
      try { ctx.game.draw(); } catch (e) { console.error("draw error", e); }
    }

    ctx.loop.raf = requestAnimationFrame(step);
  };

  ctx.loop.raf = requestAnimationFrame(step);
}

function stopLoop() {
  ctx.loop.running = false;
  if (ctx.loop.raf) cancelAnimationFrame(ctx.loop.raf);
  ctx.loop.raf = 0;
}

// ---------------- HUD helpers ----------------
function updateHudMode() {
  if (!ctx.render.hud.mode) return;
  ctx.render.hud.mode.textContent = ctx.connected ? "LIVE" : "DEMO";
}

function setHudScore(n) {
  if (!ctx.render.hud.score) return;
  ctx.render.hud.score.textContent = `Score: ${Math.max(0, Math.floor(n || 0))}`;
}

function setHudHp(n) {
  if (!ctx.render.hud.hp) return;
  ctx.render.hud.hp.textContent = `HP: ${Math.max(0, Math.floor(n || 0))}`;
}

function setHudShield01(r) {
  if (!ctx.render.hud.shield) return;
  const pct = Math.round(Math.max(0, Math.min(1, Number(r) || 0)) * 100);
  ctx.render.hud.shield.textContent = `Shield: ${pct}%`;
}

function flashScreen(color, ms = 120) {
  const el = ctx.render.flashEl;
  if (!el) return;
  el.style.background = color || "rgba(255,255,255,.25)";
  el.style.opacity = "1";
  clearTimeout(flashScreen._t);
  flashScreen._t = setTimeout(() => {
    try { el.style.opacity = "0"; } catch {}
  }, ms);
}

// ---------------- Utilities ----------------
function rand(a, b) { return a + Math.random() * (b - a); }
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function len(x, y) { return Math.hypot(x, y); }
function norm(x, y) {
  const l = Math.hypot(x, y) || 1;
  return { x: x / l, y: y / l };
}
function rotate(x, y, a) {
  const c = Math.cos(a), s = Math.sin(a);
  return { x: x * c - y * s, y: x * s + y * c };
}

// ---------------- ENGINE INDEX ----------------
// Add new templates by adding another entry here.
// Each engine must return an object: { id, actions, update(dt), draw(), resize(w,h), destroy() }
const ENGINES = {
  asteroids: createEngineAsteroids,
  boss: createEngineBossSimple,
  arena: createEngineBossSimple,     // stub fallback (upgrade later)
  runner: createEngineBossSimple,    // stub fallback (upgrade later)
  trivia: createEngineBossSimple,    // stub fallback (upgrade later)
  wheel: createEngineBossSimple,     // stub fallback (upgrade later)
  bossraid: createEngineBossSimple,  // stub fallback (upgrade later)
};

// Boot engine based on SPEC (auto-pick allowed)
function bootEngineFromSpec() {
  const id = autoPickTemplateFromSpec(ctx.spec);
  const fn = ENGINES[id] || ENGINES.asteroids;

  if (ctx.game && ctx.game.destroy) {
    try { ctx.game.destroy(); } catch {}
  }

  ctx.game = fn(ctx);
  ctx.actions = ctx.game && ctx.game.actions ? ctx.game.actions : null;

  updateHudMode();
  startLoop();

  // Small system flag to show what template was picked
  flag({ who: "SYSTEM", msg: `Template: ${ctx.game?.id || id}`, pfp: "" });
}

// ---------------- ENGINE: ASTEROIDS (real on-screen action) ----------------
function createEngineAsteroids(ctx) {
  const g = ctx.render.g;
  const state = {
    w: ctx.render.w,
    h: ctx.render.h,
    time: 0,

    score: 0,
    hp: 100,
    shield: 0,          // 0..1
    shieldDecay: 0.12,  // per sec
    demoSteerT: 0,

    // power-ups / effects
    nukePulse: 0,     // >0 shows pulse
    laserT: 0,        // seconds remaining
    shakeT: 0,        // seconds remaining
    shakeMag: 0,

    ship: {
      x: 0, y: 0,
      vx: 0, vy: 0,
      a: -Math.PI / 2,
      r: 16,
      fireCd: 0,
      thrust: 0,
    },

    asteroids: [],
    bullets: [],
    particles: [],
  };

  function reset() {
    state.time = 0;
    state.score = 0;
    state.hp = 100;
    state.shield = 0;
    state.nukePulse = 0;
    state.laserT = 0;
    state.shakeT = 0;
    state.shakeMag = 0;

    state.ship.x = state.w * 0.5;
    state.ship.y = state.h * 0.68;
    state.ship.vx = 0;
    state.ship.vy = 0;
    state.ship.a = -Math.PI / 2;
    state.ship.fireCd = 0;
    state.ship.thrust = 0;

    state.asteroids.length = 0;
    state.bullets.length = 0;
    state.particles.length = 0;

    // start with a few asteroids so it's never empty
    spawnAsteroids(6, "random");
    syncHud();
  }

  function resize(w, h) {
    state.w = w;
    state.h = h;
    // keep ship in bounds
    state.ship.x = clamp(state.ship.x, 60, w - 60);
    state.ship.y = clamp(state.ship.y, 80, h - 80);
  }

  function syncHud() {
    setHudScore(state.score);
    setHudHp(state.hp);
    setHudShield01(state.shield);
  }

  function addScore(n) {
    state.score += Math.max(0, Math.floor(n || 0));
    setHudScore(state.score);
  }

  function addShieldLikes(count) {
    // likes charge shield smoothly
    const inc = clamp((Number(count) || 1) / 400, 0.01, 0.12);
    state.shield = clamp(state.shield + inc, 0, 1);
    setHudShield01(state.shield);
  }

  function damageShip(dmg) {
    const amount = Math.max(0, Number(dmg) || 0);
    if (amount <= 0) return;

    // shield absorbs first
    const shieldAbsorb = Math.min(state.shield, amount / 100);
    if (shieldAbsorb > 0) {
      state.shield = clamp(state.shield - shieldAbsorb, 0, 1);
      setHudShield01(state.shield);
    }

    const effective = amount * (1 - shieldAbsorb * 0.9);
    state.hp = clamp(state.hp - effective, 0, 100);
    setHudHp(state.hp);

    // FX
    playFX("hit", { label: "HIT!", bg: "rgba(255,0,80,.92)" });
    flashScreen("rgba(255,0,80,.18)", 110);
    shake(0.22, 6);

    if (state.hp <= 0) {
      playFX("hit", { label: "DOWN!", bg: "rgba(255,255,255,.92)" });
      flashScreen("rgba(255,255,255,.22)", 180);
      // quick reset to keep the live moving
      state.hp = 100;
      state.score = Math.max(0, state.score - 50);
      state.ship.x = state.w * 0.5;
      state.ship.y = state.h * 0.68;
      state.ship.vx = 0;
      state.ship.vy = 0;
      state.asteroids.length = 0;
      state.bullets.length = 0;
      spawnAsteroids(8, "ring");
      syncHud();
    }
  }

  function shake(t, mag) {
    state.shakeT = Math.max(state.shakeT, t);
    state.shakeMag = Math.max(state.shakeMag, mag);
  }

  function spawnParticle(x, y, vx, vy, life, size, color) {
    state.particles.push({ x, y, vx, vy, life, t: life, size, color });
  }

  function burst(x, y, n, color) {
    for (let i = 0; i < n; i++) {
      const a = rand(0, Math.PI * 2);
      const sp = rand(30, 240);
      spawnParticle(x, y, Math.cos(a) * sp, Math.sin(a) * sp, rand(0.25, 0.9), rand(1.5, 4.5), color);
    }
  }

  function makeAsteroid(x, y, r, speed) {
    const ang = rand(0, Math.PI * 2);
    const v = rand(speed * 0.7, speed * 1.2);
    const vx = Math.cos(ang) * v;
    const vy = Math.sin(ang) * v;

    // polygon shape
    const points = [];
    const k = Math.floor(rand(8, 13));
    for (let i = 0; i < k; i++) {
      const a = (i / k) * Math.PI * 2;
      const wob = rand(0.78, 1.15);
      points.push({ a, d: wob });
    }

    return {
      x, y, vx, vy, r,
      a: rand(0, Math.PI * 2),
      spin: rand(-1.4, 1.4),
      points,
      hp: Math.max(1, Math.round(r / 12)),
    };
  }

  function spawnAsteroids(n, pattern) {
    const count = Math.max(1, Math.min(40, Math.floor(n || 1)));
    const pat = String(pattern || "random").toLowerCase();
    const w = state.w, h = state.h;

    for (let i = 0; i < count; i++) {
      let x = 0, y = 0;

      if (pat === "ring") {
        const a = (i / count) * Math.PI * 2;
        const rr = Math.min(w, h) * 0.42;
        x = w * 0.5 + Math.cos(a) * rr;
        y = h * 0.5 + Math.sin(a) * rr;
      } else if (pat === "top") {
        x = rand(30, w - 30);
        y = -rand(20, 120);
      } else {
        // random edges
        const side = Math.floor(rand(0, 4));
        if (side === 0) { x = -rand(20, 120); y = rand(0, h); }
        if (side === 1) { x = w + rand(20, 120); y = rand(0, h); }
        if (side === 2) { x = rand(0, w); y = -rand(20, 120); }
        if (side === 3) { x = rand(0, w); y = h + rand(20, 120); }
      }

      const r = rand(14, 46) * (pat === "ring" ? 1.05 : 1.0);
      const sp = rand(22, 74);
      state.asteroids.push(makeAsteroid(x, y, r, sp));
    }
  }

  function fireBullet() {
    const s = state.ship;
    if (s.fireCd > 0) return;
    s.fireCd = 0.16;

    const dir = rotate(0, -1, s.a);
    const speed = 520;
    state.bullets.push({
      x: s.x + dir.x * 18,
      y: s.y + dir.y * 18,
      vx: dir.x * speed + s.vx * 0.2,
      vy: dir.y * speed + s.vy * 0.2,
      life: 1.25,
      r: 3,
    });

    // muzzle flash
    burst(s.x + dir.x * 18, s.y + dir.y * 18, 6, "rgba(0,242,234,.85)");
  }

  function fireSuperLaser(seconds) {
    state.laserT = Math.max(state.laserT, Number(seconds) || 1.2);
    playFX("gift", { label: "LASER!", bg: "rgba(0,242,234,.92)" });
    flashScreen("rgba(0,242,234,.14)", 140);
  }

  function nuke() {
    state.nukePulse = 0.55;
    playFX("gift", { label: "NUKE!", bg: "rgba(255,255,255,.92)" });
    flashScreen("rgba(255,255,255,.22)", 180);

    // clear or heavily damage asteroids
    for (const a of state.asteroids) a.hp = 0;
    addScore(120);
  }

  function steerToward(tx, ty, strength) {
    const s = state.ship;
    const dx = tx - s.x, dy = ty - s.y;
    const n = norm(dx, dy);
    const targetAngle = Math.atan2(n.y, n.x) + Math.PI / 2;
    // smooth turn
    let da = targetAngle - s.a;
    while (da > Math.PI) da -= Math.PI * 2;
    while (da < -Math.PI) da += Math.PI * 2;
    s.a += da * clamp(strength, 0, 1);
    s.thrust = 1;
  }

  function defaultChatControls(chatText) {
    const t = String(chatText || "").toLowerCase();
    if (!t) return false;

    // basic commands
    if (/(fire|shoot|pew|laser)/.test(t)) { fireBullet(); return true; }
    if (/\b(left|l)\b/.test(t)) { state.ship.a -= 0.25; state.ship.thrust = 1; return true; }
    if (/\b(right|r)\b/.test(t)) { state.ship.a += 0.25; state.ship.thrust = 1; return true; }
    if (/\b(up|boost|go)\b/.test(t)) { state.ship.thrust = 1; return true; }
    if (/\b(nuke)\b/.test(t)) { nuke(); return true; }

    // spawn hints
    if (/(asteroid|rock|meteor)/.test(t)) { spawnAsteroids(3, "top"); return true; }

    return false;
  }

  function update(dt) {
    state.time += dt;

    // shield decay
    state.shield = clamp(state.shield - state.shieldDecay * dt, 0, 1);
    setHudShield01(state.shield);

    // ship demo autopilot (keeps motion even with no input)
    state.demoSteerT -= dt;
    if (state.demoSteerT <= 0) {
      state.demoSteerT = rand(0.35, 0.85);
      const tx = state.w * 0.5 + Math.cos(state.time * 0.8) * state.w * 0.25;
      const ty = state.h * 0.62 + Math.sin(state.time * 0.9) * state.h * 0.16;
      steerToward(tx, ty, 0.09);
      if (Math.random() < 0.26) fireBullet();
    }

    // ship physics
    const s = state.ship;
    s.fireCd = Math.max(0, s.fireCd - dt);

    // thrust
    if (s.thrust > 0) {
      const dir = rotate(0, -1, s.a);
      s.vx += dir.x * 210 * dt;
      s.vy += dir.y * 210 * dt;
      s.thrust = 0;
      spawnParticle(s.x - dir.x * 10, s.y - dir.y * 10, -dir.x * 60 + rand(-20, 20), -dir.y * 60 + rand(-20, 20), 0.25, 2.2, "rgba(255,0,80,.65)");
    }

    // friction
    s.vx *= Math.pow(0.78, dt * 8);
    s.vy *= Math.pow(0.78, dt * 8);

    // move ship
    s.x += s.vx * dt;
    s.y += s.vy * dt;
    s.x = clamp(s.x, 40, state.w - 40);
    s.y = clamp(s.y, 50, state.h - 50);

    // asteroid spawn rate baseline
    const spawnRate = ctx.connected ? 1.15 : 0.75; // per sec
    if (Math.random() < spawnRate * dt) spawnAsteroids(1, "top");

    // update asteroids
    for (const a of state.asteroids) {
      a.x += a.vx * dt;
      a.y += a.vy * dt;
      a.a += a.spin * dt;

      // wrap / recycle softly
      if (a.x < -200 || a.x > state.w + 200 || a.y < -240 || a.y > state.h + 240) {
        a.x = rand(0, state.w);
        a.y = -rand(40, 180);
        a.vx = rand(-60, 60);
        a.vy = rand(20, 110);
      }
    }

    // bullets
    for (const b of state.bullets) {
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      b.life -= dt;
    }
    state.bullets = state.bullets.filter((b) => b.life > 0);

    // particles
    for (const p of state.particles) {
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vx *= Math.pow(0.8, dt * 10);
      p.vy *= Math.pow(0.8, dt * 10);
      p.t -= dt;
    }
    state.particles = state.particles.filter((p) => p.t > 0);

    // laser & nuke pulse timers
    state.laserT = Math.max(0, state.laserT - dt);
    state.nukePulse = Math.max(0, state.nukePulse - dt);

    // shake timer
    state.shakeT = Math.max(0, state.shakeT - dt);

    // collisions: bullets vs asteroids
    for (const a of state.asteroids) {
      if (a.hp <= 0) continue;

      // laser melts asteroids
      if (state.laserT > 0) {
        // if asteroid crosses vertical laser corridor near ship x
        const dx = Math.abs(a.x - s.x);
        if (dx < 120) {
          a.hp -= dt * 6.5;
          spawnParticle(a.x, a.y, rand(-40, 40), rand(-40, 40), 0.22, 2.2, "rgba(0,242,234,.7)");
        }
      }

      for (const b of state.bullets) {
        const d = len(a.x - b.x, a.y - b.y);
        if (d < a.r + b.r) {
          a.hp -= 1;
          b.life = 0;
          burst(b.x, b.y, 8, "rgba(0,242,234,.75)");
          addScore(3);
          shake(0.08, 2);

          if (a.hp <= 0) {
            burst(a.x, a.y, 18, "rgba(255,255,255,.75)");
            addScore(Math.round(a.r));
          }
        }
      }

      // ship vs asteroid
      const ds = len(a.x - s.x, a.y - s.y);
      if (ds < a.r + s.r * 0.95) {
        a.hp = 0;
        burst(a.x, a.y, 24, "rgba(255,0,80,.75)");
        damageShip(Math.round(a.r * 0.9));
      }
    }

    // remove dead asteroids (and respawn some)
    const before = state.asteroids.length;
    state.asteroids = state.asteroids.filter((a) => a.hp > 0);
    const removed = before - state.asteroids.length;
    if (removed > 0 && state.asteroids.length < 10) spawnAsteroids(removed, "top");

    // keep HUD synced
    syncHud();
  }

  function draw() {
    const g = ctx.render.g;
    if (!g) return;

    const w = state.w;
    const h = state.h;

    // camera shake
    let sx = 0, sy = 0;
    if (state.shakeT > 0) {
      const m = state.shakeMag * (state.shakeT / 0.22);
      sx = rand(-m, m);
      sy = rand(-m, m);
    }

    g.save();
    g.translate(sx, sy);

    // clear
    g.clearRect(0, 0, w, h);

    // stars
    drawStars(g, w, h, state.time);

    // nuke pulse overlay
    if (state.nukePulse > 0) {
      const t = state.nukePulse / 0.55;
      g.fillStyle = `rgba(255,255,255,${0.18 * t})`;
      g.fillRect(0, 0, w, h);
    }

    // laser beam
    if (state.laserT > 0) {
      const t = clamp(state.laserT / 1.3, 0, 1);
      const x = state.ship.x;
      const grad = g.createLinearGradient(x - 90, 0, x + 90, 0);
      grad.addColorStop(0, "rgba(0,242,234,0)");
      grad.addColorStop(0.45, `rgba(0,242,234,${0.10 + 0.35 * t})`);
      grad.addColorStop(0.55, `rgba(255,255,255,${0.12 + 0.28 * t})`);
      grad.addColorStop(1, "rgba(0,242,234,0)");
      g.fillStyle = grad;
      g.fillRect(x - 90, 0, 180, h);
    }

    // asteroids
    for (const a of state.asteroids) drawAsteroid(g, a);

    // bullets
    for (const b of state.bullets) {
      g.beginPath();
      g.fillStyle = "rgba(0,242,234,.88)";
      g.arc(b.x, b.y, b.r, 0, Math.PI * 2);
      g.fill();
    }

    // ship
    drawShip(g, state.ship, state.shield);

    // particles
    for (const p of state.particles) {
      const t = p.t / p.life;
      g.globalAlpha = clamp(t, 0, 1);
      g.fillStyle = p.color || "rgba(255,255,255,.7)";
      g.beginPath();
      g.arc(p.x, p.y, p.size * (0.9 + (1 - t) * 0.6), 0, Math.PI * 2);
      g.fill();
      g.globalAlpha = 1;
    }

    g.restore();

    // subtle vignette
    g.save();
    const vg = g.createRadialGradient(w * 0.5, h * 0.45, Math.min(w, h) * 0.2, w * 0.5, h * 0.45, Math.max(w, h) * 0.75);
    vg.addColorStop(0, "rgba(0,0,0,0)");
    vg.addColorStop(1, "rgba(0,0,0,0.36)");
    g.fillStyle = vg;
    g.fillRect(0, 0, w, h);
    g.restore();
  }

  // procedural starfield (cheap, deterministic-ish)
  function drawStars(g, w, h, time) {
    const n = 70;
    g.save();
    g.globalAlpha = 0.9;
    for (let i = 0; i < n; i++) {
      const s = (i * 9187) % 9973;
      const x = (s % 97) / 97 * w;
      const y = (Math.floor(s / 97) % 103) / 103 * h;
      const tw = 0.35 + 0.65 * Math.sin(time * 1.2 + i) * 0.5 + 0.5;
      g.fillStyle = `rgba(255,255,255,${0.06 + tw * 0.22})`;
      g.fillRect(x, y, 1.6, 1.6);
    }
    g.restore();
  }

  function drawAsteroid(g, a) {
    g.save();
    g.translate(a.x, a.y);
    g.rotate(a.a);

    const r = a.r;
    const glow = g.createRadialGradient(0, 0, r * 0.2, 0, 0, r * 1.4);
    glow.addColorStop(0, "rgba(255,255,255,.08)");
    glow.addColorStop(1, "rgba(255,0,80,.04)");
    g.fillStyle = glow;
    g.beginPath();
    g.arc(0, 0, r * 1.2, 0, Math.PI * 2);
    g.fill();

    g.beginPath();
    for (let i = 0; i < a.points.length; i++) {
      const p = a.points[i];
      const rr = r * p.d;
      const px = Math.cos(p.a) * rr;
      const py = Math.sin(p.a) * rr;
      if (i === 0) g.moveTo(px, py);
      else g.lineTo(px, py);
    }
    g.closePath();

    g.fillStyle = "rgba(255,255,255,.07)";
    g.strokeStyle = "rgba(255,255,255,.18)";
    g.lineWidth = 2;
    g.fill();
    g.stroke();

    g.restore();
  }

  function drawShip(g, s, shield01) {
    g.save();
    g.translate(s.x, s.y);
    g.rotate(s.a);

    // shield ring
    if (shield01 > 0.01) {
      const alpha = clamp(0.08 + shield01 * 0.22, 0, 0.35);
      g.strokeStyle = `rgba(0,242,234,${alpha})`;
      g.lineWidth = 3 + shield01 * 2;
      g.beginPath();
      g.arc(0, 0, 24, 0, Math.PI * 2);
      g.stroke();
    }

    // body
    g.fillStyle = "rgba(255,255,255,.10)";
    g.strokeStyle = "rgba(255,255,255,.30)";
    g.lineWidth = 2;

    g.beginPath();
    g.moveTo(0, -18);
    g.lineTo(12, 14);
    g.lineTo(0, 9);
    g.lineTo(-12, 14);
    g.closePath();
    g.fill();
    g.stroke();

    // cockpit
    g.fillStyle = "rgba(0,242,234,.22)";
    g.beginPath();
    g.ellipse(0, -6, 5, 8, 0, 0, Math.PI * 2);
    g.fill();

    // tail glow
    g.fillStyle = "rgba(255,0,80,.25)";
    g.beginPath();
    g.arc(0, 14, 6, 0, Math.PI * 2);
    g.fill();

    g.restore();
  }

  const actions = {
    spawnAsteroids,          // (count, pattern)
    fireBullet,
    fireSuperLaser,          // (seconds)
    nuke,
    addScore,
    addShieldLikes,          // (likeCount)
    damageShip,              // (damage)
  };

  reset();

  return {
    id: "asteroids",
    actions,
    update,
    draw,
    resize,
    destroy() {
      // nothing special
    },
  };
}

// ---------------- ENGINE: BOSS SIMPLE (fallback, still animated) ----------------
function createEngineBossSimple(ctx) {
  const g = ctx.render.g;
  const st = {
    w: ctx.render.w,
    h: ctx.render.h,
    t: 0,
    bossHp: 1000,
    bossMax: 1000,
    score: 0,
    wob: 0,
    particles: [],
  };

  function resize(w, h) {
    st.w = w; st.h = h;
  }

  function addScore(n) {
    st.score += Math.max(0, Math.floor(n || 0));
    setHudScore(st.score);
  }

  function hitBoss(dmg) {
    const d = Math.max(1, Math.floor(dmg || 10));
    st.bossHp = Math.max(0, st.bossHp - d);
    addScore(Math.round(d * 0.2));
    playFX("hit", { label: `-${d}`, bg: "rgba(255,0,80,.92)" });
    flashScreen("rgba(255,0,80,.14)", 120);

    // particles
    for (let i = 0; i < 10; i++) {
      st.particles.push({
        x: st.w * 0.5 + rand(-60, 60),
        y: st.h * 0.38 + rand(-40, 40),
        vx: rand(-80, 80),
        vy: rand(-120, 20),
        life: rand(0.25, 0.85),
        t: rand(0.25, 0.85),
      });
    }

    if (st.bossHp <= 0) {
      playFX("gift", { label: "BOSS DOWN!", bg: "rgba(255,255,255,.92)" });
      flashScreen("rgba(255,255,255,.22)", 180);
      st.bossHp = st.bossMax;
    }
  }

  function addShieldLikes(count) {
    // use shield meter as “crowd power” here
    const inc = clamp((Number(count) || 1) / 400, 0.01, 0.12);
    ctx.state._bossPower = clamp((ctx.state._bossPower || 0) + inc, 0, 1);
    setHudShield01(ctx.state._bossPower || 0);
  }

  function update(dt) {
    st.t += dt;
    st.wob = Math.sin(st.t * 1.6) * 10;

    for (const p of st.particles) {
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vx *= Math.pow(0.86, dt * 10);
      p.vy += 220 * dt;
      p.t -= dt;
    }
    st.particles = st.particles.filter((p) => p.t > 0);

    setHudHp(Math.round((st.bossHp / st.bossMax) * 100)); // show boss hp% as HP
  }

  function draw() {
    if (!g) return;
    const w = st.w, h = st.h;

    g.clearRect(0, 0, w, h);

    // background glow
    const bg = g.createRadialGradient(w * 0.5, h * 0.3, 40, w * 0.5, h * 0.3, Math.max(w, h) * 0.8);
    bg.addColorStop(0, "rgba(255,0,80,.10)");
    bg.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = bg;
    g.fillRect(0, 0, w, h);

    // boss body
    const bx = w * 0.5;
    const by = h * 0.38 + st.wob;
    const br = Math.min(w, h) * 0.16;

    const grad = g.createRadialGradient(bx - br * 0.2, by - br * 0.2, br * 0.2, bx, by, br * 1.2);
    grad.addColorStop(0, "rgba(255,255,255,.12)");
    grad.addColorStop(1, "rgba(255,0,80,.18)");
    g.fillStyle = grad;

    g.beginPath();
    g.arc(bx, by, br, 0, Math.PI * 2);
    g.fill();

    g.strokeStyle = "rgba(255,255,255,.18)";
    g.lineWidth = 3;
    g.stroke();

    // eyes
    g.fillStyle = "rgba(0,242,234,.32)";
    g.beginPath(); g.arc(bx - br * 0.28, by - br * 0.1, br * 0.12, 0, Math.PI * 2); g.fill();
    g.beginPath(); g.arc(bx + br * 0.28, by - br * 0.1, br * 0.12, 0, Math.PI * 2); g.fill();

    // HP bar
    const hpR = st.bossHp / st.bossMax;
    const barW = Math.min(w * 0.78, 520);
    const barH = 12;
    const x = (w - barW) * 0.5;
    const y = 14;
    g.fillStyle = "rgba(255,255,255,.10)";
    roundRect(g, x, y, barW, barH, 999, true, false);
    g.fillStyle = "rgba(0,242,234,.55)";
    roundRect(g, x, y, barW * clamp(hpR, 0, 1), barH, 999, true, false);

    // particles
    for (const p of st.particles) {
      const t = p.t / p.life;
      g.globalAlpha = clamp(t, 0, 1);
      g.fillStyle = "rgba(0,242,234,.80)";
      g.beginPath();
      g.arc(p.x, p.y, 2.2 + (1 - t) * 2.0, 0, Math.PI * 2);
      g.fill();
      g.globalAlpha = 1;
    }
  }

  function roundRect(g, x, y, w, h, r, fill, stroke) {
    const rr = Math.min(r, w / 2, h / 2);
    g.beginPath();
    g.moveTo(x + rr, y);
    g.arcTo(x + w, y, x + w, y + h, rr);
    g.arcTo(x + w, y + h, x, y + h, rr);
    g.arcTo(x, y + h, x, y, rr);
    g.arcTo(x, y, x + w, y, rr);
    g.closePath();
    if (fill) g.fill();
    if (stroke) g.stroke();
  }

  const actions = {
    // Provide the same names as Asteroids where possible
    addScore,
    addShieldLikes,
    spawnAsteroids() {},   // no-op in boss stub
    fireBullet() { hitBoss(14); },
    fireSuperLaser() { hitBoss(80); playFX("gift", { label: "POWER!", bg: "rgba(0,242,234,.92)" }); },
    nuke() { hitBoss(200); playFX("gift", { label: "MEGA!", bg: "rgba(255,255,255,.92)" }); },
    damageShip() {},
    hitBoss,
  };

  // init HUD
  setHudScore(0);
  setHudHp(100);
  setHudShield01(0);

  return {
    id: "boss",
    actions,
    update,
    draw,
    resize,
    destroy() {},
  };
}

// ---------------- Event routing (calls AI region + default fallback mapping) ----------------
function routeEvent(type, data) {
  try {
    if (type === "chat") {
      ctx.state.counters.chats++;
      flag({ who: data.nickname || data.uniqueId || "viewer", msg: data.text, pfp: data.pfp });

      // AI mapping
      aiOnChat(ctx, data);

      // Default fallback mapping if AI did nothing / user gave no mapping
      if (ctx.actions && ctx.actions.spawnAsteroids) {
        // Chat spawns a small challenge by default
        if (data.text && data.text.trim().length > 0) {
          // For asteroids: parse basic commands too
          if (ctx.game && ctx.game.id === "asteroids") {
            // Let the engine interpret commands if AI is minimal
            // (AI can override by handling commands itself)
            try {
              // Soft: only if chat includes command-ish words to avoid constant spam
              const t = data.text.toLowerCase();
              if (/(fire|shoot|left|right|up|boost|asteroid|rock|meteor|nuke)/.test(t)) {
                // these helpers exist on the engine via actions
                if (/(fire|shoot)/.test(t) && ctx.actions.fireBullet) ctx.actions.fireBullet();
                if (/(nuke)/.test(t) && ctx.actions.nuke) ctx.actions.nuke();
                if (/(asteroid|rock|meteor)/.test(t) && ctx.actions.spawnAsteroids) ctx.actions.spawnAsteroids(2, "top");
              }
            } catch {}
          } else {
            // Other engines: treat chat as “hit”
            if (ctx.actions.fireBullet) ctx.actions.fireBullet();
          }
        }
      }
    } else if (type === "like") {
      const inc = Number(data.count || 1) || 1;
      ctx.state.counters.likes += inc;
      renderMeters();

      const now = Date.now();
      if (!ctx.state._lastLikeFlagAt) ctx.state._lastLikeFlagAt = 0;
      if (now - ctx.state._lastLikeFlagAt > 1200) {
        ctx.state._lastLikeFlagAt = now;
        flag({ who: data.nickname || data.uniqueId || "viewer", msg: `liked ×${inc}`, pfp: data.pfp });
      }

      aiOnLike(ctx, data);

      // Default: likes charge shield / power
      if (ctx.actions && ctx.actions.addShieldLikes) ctx.actions.addShieldLikes(inc);
    } else if (type === "gift") {
      const inc = Number(data.repeat || 1) || 1;
      ctx.state.counters.gifts += inc;
      renderMeters();
      flag({ who: data.nickname || data.uniqueId || "viewer", msg: `sent ${data.giftName} ×${inc}`, pfp: data.pfp });

      aiOnGift(ctx, data);

      // Default gift tiers:
      if (ctx.actions) {
        const name = String(data.giftName || "").toLowerCase();
        const big = inc >= 5 || /(lion|universe|galaxy|whale|castle|jet|tiktok)/.test(name);
        const mid = inc >= 2 || /(rose|hand heart|gg|mic|donut|coral)/.test(name);

        if (big && ctx.actions.nuke) ctx.actions.nuke();
        else if (mid && ctx.actions.fireSuperLaser) ctx.actions.fireSuperLaser(1.35);
        else if (ctx.actions.fireBullet) ctx.actions.fireBullet();
      }
    } else if (type === "join") {
      flag({ who: data.nickname || data.uniqueId || "viewer", msg: "joined", pfp: data.pfp });
      // small join FX
      playFX("join", { label: "WELCOME!", bg: "rgba(255,255,255,.92)" });
    }
  } catch (e) {
    console.error("routeEvent error", e);
  }
}

// ---------------- AI REGION ----------------
// The builder inserts game-specific code here.
// MUST define: aiInit, aiOnChat, aiOnLike, aiOnGift
// === AI_REGION_START ===

function aiInit(ctx) {
  // Default AI behavior: do nothing special.
  // Core boot happens outside AI to keep games moving even if AI output is minimal.
}

function aiOnChat(ctx, chat) {
  // default no-op
}

function aiOnLike(ctx, like) {
  // default no-op
}

function aiOnGift(ctx, gift) {
  // default no-op
}

// === AI_REGION_END ===

// ---------------- Boot ----------------
function start() {
  setStatus("Not connected", true);
  showOverlay();
  gameScreen.style.display = "block";

  // Always render + boot a real engine immediately (DEMO).
  renderBase();
  bootEngineFromSpec();
  aiInit(ctx);

  startGameBtn.addEventListener("click", () => {
    try {
      readSettings();

      // CONNECT-FIRST: do not proceed without a valid token
      const tok = (typeof CHATTOK_CREATOR_TOKEN !== "undefined" ? CHATTOK_CREATOR_TOKEN : "") || "";
      if (!(typeof tok === "string" ? tok.trim().length > 0 : Boolean(tok))) {
        setStatus("Error: Missing creator token (CHATTOK_CREATOR_TOKEN).", false);
        showOverlay();
        return;
      }

      ctx.pendingStart = true;
      setStatus("Connecting...", true);
      connectTikTok(liveIdInput.value);

      // Do NOT hide overlay here — it hides only after the connected event.
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
