/* game.js (template-first)
   - TikTok connection uses your existing TikTokClient (tiktok-client.js)
   - AI fills ONLY the region between the markers.
   - Everything else stays stable to reduce token usage.
*/

// This constant is injected server-side.
const SPEC = __SPEC_JSON__;

/* ASSET PLAN CHECKLIST (keep these visuals present every build)
   - Boss character
   - Hero/Units
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
  state: {
    startedAt: 0,
    settings: {},
    counters: {
      likes: 0,
      gifts: 0,
      chats: 0,
    },
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

  // optional styling hooks if your CSS uses them
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
  // Stacked, non-overlapping "flag" notifications (auto-expire)
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

  // stack newest on top
  flagsEl.prepend(wrap);

  // cap the stack
  while (flagsEl.childElementCount > 6) flagsEl.removeChild(flagsEl.lastChild);

  // auto-remove with fade
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
// Required by your builder rules:
// - getChatTextFromMessage(msg)
// - getUserFromMessage(msg) with avatar URL extraction
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

  // common variants
  const direct = firstUrl(u.profilePictureUrl || u.profilePicture || u.avatar || u.pfp || u.avatarUrl);
  if (direct) return direct;

  // TikTokClient variants (including your MessagesClean.txt shapes)
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

// Read settings from any [data-setting] inputs.
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

// ---------------- Base UI ----------------
function renderBase() {
  clearRoot();

  const s = ctx.spec || {};
  const headline = document.createElement("div");
  headline.className = "bigText";
  headline.textContent = s.title || "ChatTok Live Game";

  const about = card(
    "What viewers do",
    `<p>${escapeHtml(s.oneSentence || "")}</p>`
  );

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
  `;

  const tests = document.createElement("div");
  tests.className = "card";
  tests.innerHTML = `
    <h3>Test Buttons</h3>
    <p style="margin:0 0 10px;color:rgba(234,242,255,.75);font-size:12px">
      Use these to verify visuals before going LIVE.
    </p>
    <div style="display:flex;gap:10px;flex-wrap:wrap">
      <button class="primary-btn" style="padding:10px 12px;font-size:12px" id="testHitBtn" type="button">Hit FX</button>
      <button class="primary-btn" style="padding:10px 12px;font-size:12px" id="testGiftBtn" type="button">Gift FX</button>
      <button class="primary-btn" style="padding:10px 12px;font-size:12px" id="testJoinBtn" type="button">Join Banner</button>
      <button class="primary-btn" style="padding:10px 12px;font-size:12px" id="testLikeBtn" type="button">Like Pop</button>
    </div>
  `;

  gameRoot.appendChild(headline);
  gameRoot.appendChild(about);
  gameRoot.appendChild(meters);
  gameRoot.appendChild(tests);

  // Attach after DOM insertion
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
  }, 0);
}

function renderMeters() {
  const likesEl = document.getElementById("likesCount");
  const giftsEl = document.getElementById("giftsCount");
  const likesMeter = document.getElementById("likesMeter");
  const giftsMeter = document.getElementById("giftsMeter");

  if (likesEl) likesEl.textContent = String(ctx.state.counters.likes);
  if (giftsEl) giftsEl.textContent = String(ctx.state.counters.gifts);

  // simple normalization so meter moves
  setMeter(likesMeter, Math.min(1, ctx.state.counters.likes / 500));
  setMeter(giftsMeter, Math.min(1, ctx.state.counters.gifts / 50));
}

function playFX(kind, detail) {
  // Visible, lightweight effects without extra assets (works before connect)
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

  // subtle camera shake
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

// ---------------- TikTok wiring ----------------
function connectTikTok(liveId) {
  const id = String(liveId || "").trim().replace(/^@/, "");
  if (!id) throw new Error("Live ID is required.");

  // Close previous socket if any
  if (ctx.client && ctx.client.socket) {
    try {
      ctx.client.socket.close();
    } catch (e) {
      console.warn("Error closing previous socket:", e);
    }
  }

  if (typeof TikTokClient === "undefined") {
    throw new Error("TikTokClient is not available. Check tiktok-client.js.");
  }

  const client = new TikTokClient(id);

  // ChatTok injects CHATTOK_CREATOR_TOKEN globally (preferred).
  const tok = (typeof CHATTOK_CREATOR_TOKEN !== "undefined" ? CHATTOK_CREATOR_TOKEN : "") || "";
  if (typeof tok === "string" ? tok.trim().length > 0 : Boolean(tok)) {
    client.setAccessToken(tok);
  }

  client.on("connected", () => {
    ctx.connected = true;
    setStatus("Connected", true);
    flag({ who: "SYSTEM", msg: "Connected to TikTok LIVE", pfp: "" });

    // CONNECT-FIRST: only hide overlay once we receive the connected event
    if (ctx.pendingStart) {
      ctx.pendingStart = false;
      hideOverlay();
    }
  });

  client.on("disconnected", (reason) => {
    ctx.connected = false;
    ctx.pendingStart = false;
    const msg = (reason ? String(reason) : "Connection closed").trim();
    setStatus(`Disconnected: ${msg}`, false);
    flag({ who: "SYSTEM", msg: `Disconnected: ${msg}`, pfp: "" });

    // keep the overlay open so host can retry
    showOverlay();
  });

  client.on("error", (err) => {
    ctx.connected = false;
    ctx.pendingStart = false;
    const msg = err && err.message ? err.message : String(err || "Unknown error");
    setStatus(`Error: ${msg}`, false);
    flag({ who: "SYSTEM", msg: `Error: ${msg}`, pfp: "" });
    showOverlay();
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

function routeEvent(type, data) {
  try {
    if (type === "chat") {
      ctx.state.counters.chats++;
      flag({ who: data.nickname || data.uniqueId || "viewer", msg: data.text, pfp: data.pfp });
      aiOnChat(ctx, data);
    } else if (type === "like") {
      const inc = Number(data.count || 1) || 1;
      ctx.state.counters.likes += inc;
      renderMeters();

      // show a throttled like flag so it doesn't spam
      const now = Date.now();
      if (!ctx.state._lastLikeFlagAt) ctx.state._lastLikeFlagAt = 0;
      if (now - ctx.state._lastLikeFlagAt > 1200) {
        ctx.state._lastLikeFlagAt = now;
        flag({ who: data.nickname || data.uniqueId || "viewer", msg: `liked ×${inc}`, pfp: data.pfp });
      }

      aiOnLike(ctx, data);
    } else if (type === "gift") {
      const inc = Number(data.repeat || 1) || 1;
      ctx.state.counters.gifts += inc;
      renderMeters();
      flag({ who: data.nickname || data.uniqueId || "viewer", msg: `sent ${data.giftName} ×${inc}`, pfp: data.pfp });
      aiOnGift(ctx, data);
    } else if (type === "join") {
      flag({ who: data.nickname || data.uniqueId || "viewer", msg: "joined", pfp: data.pfp });
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
  // default: show base UI
  renderBase();
  renderMeters();
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

  // Render base UI immediately (works offline too).
  aiInit(ctx);

  startGameBtn.addEventListener("click", () => {
    try {
      readSettings();

      // CONNECT-FIRST: do not proceed without a valid token (show error and keep overlay open)
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
