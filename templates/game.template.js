/* game.js (template-first, production)
   ============================================================
   Non-Negotiables honored:
   - DO NOT edit / bundle tiktok-client.js here (ChatTok injects it).
   - DO NOT load proto.bundle.js here (index.html handles contract checks).
   - Works in iframe/srcdoc runners (index.template.html sets <base>).
   - Game shows action immediately even without TikTok connected.
   - AI fills ONLY the AI_REGION between markers.

   THIS TEMPLATE ALSO BUILDS HOST SETTINGS FIELDS DYNAMICALLY
   so “chat commands” (and optional Share-as-fallback) are always configurable.
*/

// This constant is injected server-side.
const SPEC = __SPEC_JSON__;

/* ---------------- DOM ---------------- */
const setupOverlay = document.getElementById("setupOverlay");
const gameScreen = document.getElementById("gameScreen");
const liveIdInput = document.getElementById("liveIdInput");
const startGameBtn = document.getElementById("startGameBtn");
const statusText = document.getElementById("statusText");
const statusTextInGame = document.getElementById("statusTextInGame");
const statusTextFooter = document.getElementById("statusTextFooter");
const gameRoot = document.getElementById("gameRoot");
const flagsEl = document.getElementById("flags");
const setupFields = document.getElementById("setupFields");

/* ---------------- State ---------------- */
let client = null;
let pendingStart = false;

const state = {
  spec: SPEC || {},
  settings: {},
  connected: false,

  counters: { likes: 0, gifts: 0, chats: 0, joins: 0, shares: 0 },
  _lastLikeFlagAt: 0,

  // engine
  canvas: null,
  ctx2d: null,
  w: 0,
  h: 0,
  dpr: 1,
  t0: performance.now(),
  last: performance.now(),

  // entities
  stars: [],
  particles: [],
  floaters: [],
  players: new Map(), // userId -> player
  bots: [],
  boss: null,

  // gameplay meters
  hype: 0,          // 0..1 filled by likes/shares (optionally)
  hypeDecay: 0.015, // per second
  hypePulse: 0,

  // fx
  shake: 0,
  flash: 0
};

/* ============================================================
   UI helpers
   ============================================================ */
function setStatus(text, ok) {
  const msg = String(text || "");
  if (statusText) statusText.textContent = msg;
  if (statusTextInGame) statusTextInGame.textContent = msg;
  if (statusTextFooter) statusTextFooter.textContent = msg;

  if (statusText) statusText.style.color = ok ? "rgba(46,229,157,.95)" : "rgba(255,255,255,.82)";
  if (statusTextInGame) statusTextInGame.style.color = ok ? "rgba(46,229,157,.95)" : "rgba(255,255,255,.92)";
  if (statusTextFooter) statusTextFooter.style.color = ok ? "rgba(46,229,157,.95)" : "rgba(255,255,255,.92)";
}

function showOverlay() {
  if (setupOverlay) setupOverlay.style.display = "flex";
}
function hideOverlay() {
  if (setupOverlay) setupOverlay.style.display = "none";
}

function escapeHtml(s) {
  return String(s || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function flag({ who, msg, pfp, tint }) {
  if (!flagsEl) return;

  const el = document.createElement("div");
  el.className = "flag " + (tint || "tint-aqua");

  const img = document.createElement("img");
  img.className = "pfp";
  img.alt = "";
  img.loading = "lazy";
  img.decoding = "async";
  img.referrerPolicy = "no-referrer";
  img.src =
    pfp ||
    "data:image/svg+xml;charset=utf-8," +
      encodeURIComponent(
        `<svg xmlns="http://www.w3.org/2000/svg" width="72" height="72">
           <rect width="72" height="72" rx="14" fill="rgba(255,255,255,.10)"/>
           <text x="50%" y="55%" text-anchor="middle" font-family="system-ui,Segoe UI,Roboto,Arial" font-size="28" fill="rgba(255,255,255,.75)">${escapeHtml(
             initials(who)
           )}</text>
         </svg>`
      );

  const txt = document.createElement("div");
  txt.className = "txt";
  txt.innerHTML = `<div class="line1">${escapeHtml(who || "viewer")}</div>
                   <div class="line2">${escapeHtml(msg || "")}</div>`;

  el.appendChild(img);
  el.appendChild(txt);

  flagsEl.insertBefore(el, flagsEl.firstChild);

  // cap list
  const max = 8;
  while (flagsEl.childElementCount > max) flagsEl.removeChild(flagsEl.lastChild);
}

/* Tiny “copyright-free” audio via WebAudio (no external assets) */
let audioCtx = null;
function beep(type) {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const t = audioCtx.currentTime;

    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();

    o.type = "sine";
    g.gain.setValueAtTime(0.0001, t);

    if (type === "join") {
      o.frequency.setValueAtTime(330, t);
      g.gain.exponentialRampToValueAtTime(0.16, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
    } else if (type === "gift") {
      o.frequency.setValueAtTime(220, t);
      o.frequency.exponentialRampToValueAtTime(660, t + 0.10);
      g.gain.exponentialRampToValueAtTime(0.20, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.26);
    } else if (type === "hit") {
      o.frequency.setValueAtTime(520, t);
      o.frequency.exponentialRampToValueAtTime(240, t + 0.08);
      g.gain.exponentialRampToValueAtTime(0.18, t + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
    } else {
      o.frequency.setValueAtTime(440, t);
      g.gain.exponentialRampToValueAtTime(0.12, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.14);
    }

    o.connect(g);
    g.connect(audioCtx.destination);

    o.start(t);
    o.stop(t + 0.30);
  } catch (e) {
    // ignore audio failures
  }
}

function initials(name) {
  const s = String(name || "").trim();
  if (!s) return "?";
  const parts = s.replace(/[^a-zA-Z0-9\s]/g, " ").trim().split(/\s+/).filter(Boolean);
  const a = parts[0] ? parts[0][0] : "?";
  const b = parts[1] ? parts[1][0] : "";
  return (a + b).toUpperCase();
}

/* ============================================================
   Settings Field Builder (Dynamic)
   - If a command exists, it MUST be configurable.
   - Optional: allow SHARE to trigger the same action as chat.
   - Also supports “some viewers can’t chat” workaround.
   ============================================================ */
function ensureSettingField(def) {
  if (!setupFields || !def || !def.id) return;
  const exists = document.querySelector(`[data-setting="${CSS.escape(def.id)}"]`);
  if (exists) return;

  const wrap = document.createElement("label");
  wrap.className = "field" + (def.span ? " field-span" : "");

  const lab = document.createElement("span");
  lab.className = "field-label";
  lab.textContent = def.label || def.id;

  wrap.appendChild(lab);

  let input;
  if (def.type === "select") {
    input = document.createElement("select");
    input.style.width = "100%";
    input.style.borderRadius = "14px";
    input.style.border = "1px solid rgba(255,255,255,.12)";
    input.style.background = "rgba(0,0,0,.26)";
    input.style.color = "rgba(247,247,251,.92)";
    input.style.padding = "12px 12px";
    input.style.outline = "none";
    input.style.fontFamily = "var(--mono)";
    (def.options || []).forEach((o) => {
      const opt = document.createElement("option");
      opt.value = o.value;
      opt.textContent = o.label;
      input.appendChild(opt);
    });
    if (def.value != null) input.value = String(def.value);
  } else if (def.type === "checkbox") {
    input = document.createElement("input");
    input.type = "checkbox";
    input.checked = !!def.value;
    input.style.transform = "scale(1.15)";
    input.style.marginTop = "4px";
  } else if (def.type === "number") {
    input = document.createElement("input");
    input.type = "number";
    input.value = def.value != null ? String(def.value) : "";
    if (def.min != null) input.min = String(def.min);
    if (def.max != null) input.max = String(def.max);
    if (def.step != null) input.step = String(def.step);
    input.placeholder = def.placeholder || "";
    input.autocomplete = "off";
  } else {
    input = document.createElement("input");
    input.type = "text";
    input.value = def.value != null ? String(def.value) : "";
    input.placeholder = def.placeholder || "";
    input.autocomplete = "off";
    input.autocapitalize = "none";
    input.spellcheck = false;
  }

  input.setAttribute("data-setting", def.id);
  wrap.appendChild(input);

  // Put below LIVE ID field, but before any huge custom blocks
  // We append at end; index.template.html places LIVE ID first and allows injected fields after.
  setupFields.appendChild(wrap);
}

function ensureCoreSettingsUI() {
  // Commands (always configurable)
  ensureSettingField({
    id: "joinCommand",
    type: "text",
    span: false,
    label: "Chat Command: Join",
    value: (state.spec?.defaults?.joinCommand) || "join",
    placeholder: "join"
  });

  ensureSettingField({
    id: "actionCommand",
    type: "text",
    span: false,
    label: "Chat Command: Action",
    value: (state.spec?.defaults?.actionCommand) || "attack",
    placeholder: "attack"
  });

  // Share fallback selector (only used if the game uses chat commands)
  ensureSettingField({
    id: "shareAsAction",
    type: "checkbox",
    span: false,
    label: "Allow SHARE to trigger the Action command (for viewers who can’t chat)",
    value: true
  });

  ensureSettingField({
    id: "shareCountsAs",
    type: "select",
    span: false,
    label: "If SHARE triggers something, what should it count as?",
    value: "action",
    options: [
      { value: "none", label: "Do nothing" },
      { value: "action", label: "Same as Action command" },
      { value: "join", label: "Same as Join command" },
      { value: "hype", label: "Fill Hype meter" }
    ]
  });

  // Optional: host scaling (keeps template flexible for many game types)
  ensureSettingField({
    id: "difficulty",
    type: "select",
    span: false,
    label: "Difficulty",
    value: "normal",
    options: [
      { value: "easy", label: "Easy" },
      { value: "normal", label: "Normal" },
      { value: "hard", label: "Hard" }
    ]
  });

  ensureSettingField({
    id: "roundSeconds",
    type: "number",
    span: false,
    label: "Round Seconds",
    value: Number(state.spec?.defaultSettings?.roundSeconds || 120),
    min: 30, max: 9999, step: 5
  });

  ensureSettingField({
    id: "winGoal",
    type: "number",
    span: false,
    label: "Win Goal",
    value: Number(state.spec?.defaultSettings?.winGoal || 25),
    min: 1, max: 9999, step: 1
  });
}

function readSettings() {
  const out = {};
  document.querySelectorAll("[data-setting]").forEach((el) => {
    const id = el.getAttribute("data-setting");
    if (!id) return;
    if (el.type === "checkbox") out[id] = !!el.checked;
    else out[id] = String(el.value || "").trim();
  });

  // Normalize helpful defaults
  out.joinCommand = normalizeCommand(out.joinCommand || "join");
  out.actionCommand = normalizeCommand(out.actionCommand || "attack");

  out.roundSeconds = clampNum(out.roundSeconds, 30, 9999, 120);
  out.winGoal = clampNum(out.winGoal, 1, 9999, 25);

  state.settings = out;
  return out;
}

function normalizeCommand(s) {
  const t = String(s || "").trim().toLowerCase();
  // allow "share" style text etc.
  return t.replace(/^@/, "").replace(/\s+/g, " ").trim();
}

function clampNum(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

/* ============================================================
   Engine: Canvas arena with boss + players + particles
   ============================================================ */
function mountCanvas() {
  if (!gameRoot) return;

  // Only mount once
  if (state.canvas && state.ctx2d) return;

  const c = document.createElement("canvas");
  c.style.width = "100%";
  c.style.height = "100%";
  c.style.display = "block";
  c.style.touchAction = "none";
  gameRoot.appendChild(c);

  state.canvas = c;
  state.ctx2d = c.getContext("2d", { alpha: true });

  resize();
  window.addEventListener("resize", resize, { passive: true });

  seedStars();
  spawnBoss();
  seedBots(7);

  requestAnimationFrame(loop);
}

function resize() {
  if (!state.canvas) return;
  const rect = state.canvas.getBoundingClientRect();
  state.dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
  state.w = Math.max(10, Math.floor(rect.width));
  state.h = Math.max(10, Math.floor(rect.height));
  state.canvas.width = Math.floor(state.w * state.dpr);
  state.canvas.height = Math.floor(state.h * state.dpr);
}

function seedStars() {
  state.stars.length = 0;
  const count = Math.floor(90 + (state.w * state.h) / 18000);
  for (let i = 0; i < count; i++) {
    state.stars.push({
      x: Math.random(),
      y: Math.random(),
      z: 0.3 + Math.random() * 0.7,
      tw: Math.random()
    });
  }
}

function spawnBoss() {
  const hpBase = 140;
  state.boss = {
    x: 0.5,
    y: 0.32,
    r: 46,
    hp: hpBase,
    hpMax: hpBase,
    phase: 0,
    pulse: 0
  };
}

function seedBots(n) {
  state.bots.length = 0;
  for (let i = 0; i < n; i++) {
    state.bots.push(makePlayer({
      userId: "BOT_" + i,
      nickname: ["Spark","Nova","Rift","Pulse","Hex","Orbit","Vibe"][i % 7],
      uniqueId: "bot" + i,
      avatar: ""
    }, true));
  }
}

function makePlayer(user, isBot) {
  const h = hash01(user.userId || user.uniqueId || user.nickname || "x");
  const x = 0.15 + Math.random() * 0.70;
  const y = 0.48 + Math.random() * 0.42;
  const col = palette(h);
  return {
    id: String(user.userId || user.uniqueId || user.nickname || "anon"),
    name: String(user.nickname || user.uniqueId || "viewer"),
    pfp: String(user.avatar || ""),
    isBot: !!isBot,
    x, y,
    vx: (Math.random() - 0.5) * 0.18,
    vy: (Math.random() - 0.5) * 0.18,
    r: isBot ? 12 : 13,
    col,
    score: 0,
    lastShotAt: 0
  };
}

function palette(t) {
  // two theme-ish colors blended
  const a = lerpColor([255,0,80], [0,242,234], t);
  return `rgb(${a[0]|0},${a[1]|0},${a[2]|0})`;
}

function hash01(s) {
  let h = 2166136261;
  const str = String(s || "");
  for (let i=0;i<str.length;i++){
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 10000) / 10000;
}

function lerp(a,b,t){ return a + (b-a)*t; }
function lerpColor(a,b,t){
  return [lerp(a[0],b[0],t), lerp(a[1],b[1],t), lerp(a[2],b[2],t)];
}

function spawnParticles(x, y, count, power, color) {
  for (let i=0;i<count;i++){
    state.particles.push({
      x, y,
      vx: (Math.random()-0.5) * power,
      vy: (Math.random()-0.5) * power,
      life: 0.55 + Math.random()*0.55,
      age: 0,
      col: color || "rgba(255,255,255,.9)"
    });
  }
}

function floater(text, x, y, color) {
  state.floaters.push({
    text: String(text || ""),
    x, y,
    vy: -0.08 - Math.random()*0.06,
    life: 1.2,
    age: 0,
    col: color || "rgba(255,255,255,.90)"
  });
}

function worldToPxX(x){ return x * state.w; }
function worldToPxY(y){ return y * state.h; }

function screenShake(strength) {
  state.shake = Math.min(1, state.shake + strength);
}
function screenFlash(strength) {
  state.flash = Math.min(1, state.flash + strength);
}

/* ============================================================
   Gameplay actions
   ============================================================ */
function ensurePlayer(user) {
  const id = String(user.userId || user.uniqueId || user.nickname || "");
  if (!id) return null;
  let p = state.players.get(id);
  if (!p) {
    p = makePlayer(user, false);
    state.players.set(id, p);
    state.counters.joins++;
    beep("join");
    flag({ who: p.name, msg: `joined`, pfp: p.pfp, tint: "tint-good" });
    floater("JOIN!", p.x, p.y, "rgba(46,229,157,.95)");
    spawnParticles(p.x, p.y, 20, 0.42, "rgba(46,229,157,.85)");
  }
  return p;
}

function joinAction(user) {
  // Join (or keep alive)
  const p = ensurePlayer(user);
  if (!p) return;
  // tiny bump for joining
  p.vx += (Math.random()-0.5)*0.10;
  p.vy += (Math.random()-0.5)*0.10;
}

function actionAttack(user, strength) {
  const p = ensurePlayer(user);
  if (!p || !state.boss) return;

  const now = performance.now();
  if (now - p.lastShotAt < 180) return; // basic anti-spam per user
  p.lastShotAt = now;

  const dmg = Math.max(1, Math.floor(strength || 1));
  state.boss.hp = Math.max(0, state.boss.hp - dmg);
  p.score += dmg;

  // FX
  screenShake(0.20);
  screenFlash(0.10);
  beep("hit");

  // particles around boss
  spawnParticles(state.boss.x, state.boss.y, 18, 0.55, p.col);
  floater("-" + dmg, state.boss.x, state.boss.y, p.col);

  if (state.boss.hp <= 0) {
    // Boss down => big celebration + respawn stronger
    screenShake(0.85);
    screenFlash(0.75);
    beep("gift");

    spawnParticles(state.boss.x, state.boss.y, 140, 1.2, "rgba(255,255,255,.95)");
    floater("BOSS DOWN!", 0.5, 0.22, "rgba(255,255,255,.95)");
    flag({ who: "SYSTEM", msg: `Boss defeated!`, pfp: "", tint: "tint-pink" });

    // respawn with scaling
    const nextMax = Math.min(9999, Math.floor((state.boss.hpMax || 140) * 1.22 + 20));
    state.boss.hpMax = nextMax;
    state.boss.hp = nextMax;
    state.boss.phase = (state.boss.phase || 0) + 1;
  }
}

function addHype(amount) {
  state.hype = Math.max(0, Math.min(1, state.hype + amount));
}

function likeBoost(count) {
  const inc = Math.max(1, Number(count || 1));
  state.counters.likes += inc;
  addHype(Math.min(0.35, inc * 0.015));
  state.hypePulse = 1;
}

function giftPower(name, repeat) {
  const r = Math.max(1, Number(repeat || 1));
  state.counters.gifts += r;

  // tiered gift impact
  const tier = r >= 10 ? "L" : r >= 5 ? "M" : "S";
  const msg = `sent ${name || "gift"} ×${r}`;
  flag({ who: "GIFT", msg, pfp: "", tint: "tint-pink" });
  beep("gift");
  addHype(tier === "L" ? 0.55 : tier === "M" ? 0.32 : 0.18);

  // big effect: burst damage to boss
  if (state.boss) {
    const dmg = tier === "L" ? 30 : tier === "M" ? 16 : 8;
    state.boss.hp = Math.max(0, state.boss.hp - dmg);
    screenShake(tier === "L" ? 0.75 : 0.45);
    screenFlash(tier === "L" ? 0.65 : 0.40);
    spawnParticles(state.boss.x, state.boss.y, tier === "L" ? 120 : tier === "M" ? 70 : 40, tier === "L" ? 1.3 : 0.9, "rgba(255,255,255,.95)");
    floater("GIFT HIT!", state.boss.x, state.boss.y, "rgba(255,255,255,.92)");
    if (state.boss.hp <= 0) {
      // Let normal attack logic handle respawn next frame
    }
  }
}

/* ============================================================
   Render loop
   ============================================================ */
function loop(now) {
  const dt = Math.min(0.033, Math.max(0.001, (now - state.last) / 1000));
  state.last = now;

  step(dt);
  draw(dt);

  requestAnimationFrame(loop);
}

function step(dt) {
  // decay meters
  state.hype = Math.max(0, state.hype - state.hypeDecay * dt);
  state.hypePulse = Math.max(0, state.hypePulse - 2.6 * dt);
  state.shake = Math.max(0, state.shake - 2.5 * dt);
  state.flash = Math.max(0, state.flash - 2.2 * dt);

  // boss pulse
  if (state.boss) {
    state.boss.pulse = (state.boss.pulse || 0) + dt * (1.8 + state.hype * 2.8);
  }

  // bots move and occasionally shoot
  for (const b of state.bots) {
    wander(b, dt);
    if (Math.random() < (0.30 + state.hype * 0.55) * dt) {
      actionAttack({ userId: b.id, nickname: b.name, uniqueId: b.id, avatar: "" }, 1);
    }
  }

  // players
  for (const p of state.players.values()) {
    wander(p, dt);
  }

  // particles
  for (let i = state.particles.length - 1; i >= 0; i--) {
    const pt = state.particles[i];
    pt.age += dt;
    pt.x += pt.vx * dt;
    pt.y += pt.vy * dt;
    pt.vx *= Math.pow(0.22, dt);
    pt.vy *= Math.pow(0.22, dt);
    if (pt.age >= pt.life) state.particles.splice(i, 1);
  }

  // floaters
  for (let i = state.floaters.length - 1; i >= 0; i--) {
    const f = state.floaters[i];
    f.age += dt;
    f.y += f.vy * dt;
    if (f.age >= f.life) state.floaters.splice(i, 1);
  }

  // Hype triggers occasional meteor shower effect
  if (state.hype > 0.82 && Math.random() < 0.65 * dt) {
    spawnParticles(Math.random(), 0.04, 12, 0.75, "rgba(0,242,234,.95)");
    screenShake(0.08);
  }
}

function wander(p, dt) {
  // wobble
  const sp = 0.24 + state.hype * 0.38;
  p.vx += (Math.random() - 0.5) * sp * dt;
  p.vy += (Math.random() - 0.5) * sp * dt;

  // clamp velocity
  p.vx = Math.max(-0.28, Math.min(0.28, p.vx));
  p.vy = Math.max(-0.28, Math.min(0.28, p.vy));

  p.x += p.vx * dt;
  p.y += p.vy * dt;

  // bounds
  const pad = 0.06;
  if (p.x < pad) { p.x = pad; p.vx *= -0.85; }
  if (p.x > 1 - pad) { p.x = 1 - pad; p.vx *= -0.85; }
  if (p.y < 0.18) { p.y = 0.18; p.vy *= -0.85; }
  if (p.y > 0.96) { p.y = 0.96; p.vy *= -0.85; }
}

function draw(dt) {
  const g = state.ctx2d;
  const c = state.canvas;
  if (!g || !c) return;

  g.save();
  g.scale(state.dpr, state.dpr);

  // shake
  const sh = state.shake;
  if (sh > 0.001) {
    g.translate((Math.random() - 0.5) * 10 * sh, (Math.random() - 0.5) * 10 * sh);
  }

  // background
  g.clearRect(0, 0, state.w, state.h);
  drawStars(g);
  drawGlow(g);

  // boss
  drawBoss(g);

  // players + bots
  for (const b of state.bots) drawPlayer(g, b, true);
  for (const p of state.players.values()) drawPlayer(g, p, false);

  // particles
  for (const pt of state.particles) {
    const t = pt.age / pt.life;
    g.globalAlpha = (1 - t) * 0.9;
    g.fillStyle = pt.col;
    g.beginPath();
    g.arc(worldToPxX(pt.x), worldToPxY(pt.y), 2.2 + (1 - t) * 2.0, 0, Math.PI * 2);
    g.fill();
  }
  g.globalAlpha = 1;

  // HUD
  drawHUD(g);

  // floaters
  for (const f of state.floaters) {
    const t = f.age / f.life;
    g.globalAlpha = (1 - t) * 0.95;
    g.fillStyle = f.col;
    g.font = "900 18px system-ui,Segoe UI,Roboto,Arial";
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText(f.text, worldToPxX(f.x), worldToPxY(f.y));
  }
  g.globalAlpha = 1;

  // flash
  if (state.flash > 0.001) {
    g.globalAlpha = 0.18 * state.flash;
    g.fillStyle = "#ffffff";
    g.fillRect(0, 0, state.w, state.h);
    g.globalAlpha = 1;
  }

  g.restore();
}

function drawStars(g) {
  g.save();
  g.globalAlpha = 0.85;
  for (const s of state.stars) {
    s.tw += 0.8 * (0.02 + Math.random() * 0.02);
    const tw = 0.4 + 0.6 * Math.abs(Math.sin(s.tw));
    const x = s.x * state.w;
    const y = s.y * state.h;
    g.globalAlpha = 0.10 + 0.35 * tw * s.z;
    g.fillStyle = "rgba(255,255,255,.9)";
    g.fillRect(x, y, 1.0 + s.z, 1.0 + s.z);
  }
  g.restore();
}

function drawGlow(g) {
  // center haze
  const grd = g.createRadialGradient(state.w * 0.5, state.h * 0.35, 10, state.w * 0.5, state.h * 0.35, state.w * 0.65);
  grd.addColorStop(0, "rgba(255,0,80,.10)");
  grd.addColorStop(0.55, "rgba(0,242,234,.06)");
  grd.addColorStop(1, "rgba(0,0,0,0)");
  g.fillStyle = grd;
  g.fillRect(0, 0, state.w, state.h);
}

function drawBoss(g) {
  const b = state.boss;
  if (!b) return;

  const x = worldToPxX(b.x);
  const y = worldToPxY(b.y);

  const pulse = 1 + 0.06 * Math.sin(b.pulse || 0);
  const r = (b.r || 46) * pulse;

  // outer ring
  g.save();
  g.globalAlpha = 0.35 + state.hype * 0.25;
  g.strokeStyle = "rgba(255,255,255,.45)";
  g.lineWidth = 2;
  g.beginPath();
  g.arc(x, y, r + 10 + 12 * state.hypePulse, 0, Math.PI * 2);
  g.stroke();
  g.restore();

  // body
  const grd = g.createRadialGradient(x - r*0.3, y - r*0.35, 8, x, y, r);
  grd.addColorStop(0, "rgba(255,255,255,.95)");
  grd.addColorStop(0.22, "rgba(255,0,80,.55)");
  grd.addColorStop(0.62, "rgba(0,242,234,.35)");
  grd.addColorStop(1, "rgba(0,0,0,.15)");
  g.fillStyle = grd;
  g.beginPath();
  g.arc(x, y, r, 0, Math.PI * 2);
  g.fill();

  // eyes
  g.fillStyle = "rgba(0,0,0,.55)";
  g.beginPath();
  g.arc(x - r*0.22, y - r*0.10, Math.max(2, r*0.08), 0, Math.PI * 2);
  g.arc(x + r*0.22, y - r*0.10, Math.max(2, r*0.08), 0, Math.PI * 2);
  g.fill();

  // HP bar
  const bw = Math.min(state.w * 0.78, 520);
  const bh = 10;
  const bx = state.w * 0.5 - bw * 0.5;
  const by = state.h * 0.08;

  const pct = b.hpMax ? (b.hp / b.hpMax) : 1;

  g.save();
  g.globalAlpha = 0.9;
  roundRect(g, bx, by, bw, bh, 999);
  g.fillStyle = "rgba(0,0,0,.32)";
  g.fill();
  roundRect(g, bx, by, bw * pct, bh, 999);
  g.fillStyle = pct > 0.35 ? "rgba(46,229,157,.92)" : "rgba(255,77,77,.92)";
  g.fill();
  g.restore();
}

function drawPlayer(g, p, isBot) {
  const x = worldToPxX(p.x);
  const y = worldToPxY(p.y);
  const r = (p.r || 12);

  // glow
  g.save();
  g.globalAlpha = 0.18;
  g.fillStyle = p.col;
  g.beginPath();
  g.arc(x, y, r * 2.6, 0, Math.PI * 2);
  g.fill();
  g.restore();

  // body
  g.fillStyle = p.col;
  g.beginPath();
  g.arc(x, y, r * 1.18, 0, Math.PI * 2);
  g.fill();

  // outline
  g.strokeStyle = "rgba(255,255,255,.35)";
  g.lineWidth = 1;
  g.beginPath();
  g.arc(x, y, r * 1.18, 0, Math.PI * 2);
  g.stroke();

  // name plate (only for real players, keep HUD clean)
  if (!isBot) {
    g.save();
    g.globalAlpha = 0.9;
    g.font = "900 12px system-ui,Segoe UI,Roboto,Arial";
    g.textAlign = "center";
    g.textBaseline = "top";
    g.fillStyle = "rgba(255,255,255,.90)";
    g.fillText(p.name, x, y + r * 1.6);
    g.restore();
  }
}

function drawHUD(g) {
  // Hype meter (likes/shares)
  const w = Math.min(state.w * 0.72, 420);
  const h = 14;
  const x = state.w * 0.5 - w * 0.5;
  const y = state.h - 28;

  const pct = Math.max(0, Math.min(1, state.hype));

  g.save();
  g.globalAlpha = 0.92;
  roundRect(g, x, y, w, h, 999);
  g.fillStyle = "rgba(0,0,0,.32)";
  g.fill();

  roundRect(g, x, y, w * pct, h, 999);
  g.fillStyle = "rgba(0,242,234,.92)";
  g.fill();

  // label
  g.font = "900 12px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', monospace";
  g.fillStyle = "rgba(247,247,251,.88)";
  g.textAlign = "center";
  g.textBaseline = "bottom";
  g.fillText("HYPE", state.w * 0.5, y - 4);

  // counters corner
  g.textAlign = "left";
  g.textBaseline = "top";
  g.font = "900 12px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', monospace";
  g.fillStyle = "rgba(247,247,251,.78)";
  g.fillText(
    `chat ${state.counters.chats}  likes ${state.counters.likes}  gifts ${state.counters.gifts}`,
    14,
    12
  );

  g.restore();
}

function roundRect(g, x, y, w, h, r) {
  const rr = Math.min(r, h / 2, w / 2);
  g.beginPath();
  g.moveTo(x + rr, y);
  g.arcTo(x + w, y, x + w, y + h, rr);
  g.arcTo(x + w, y + h, x, y + h, rr);
  g.arcTo(x, y + h, x, y, rr);
  g.arcTo(x, y, x + w, y, rr);
  g.closePath();
}

/* ============================================================
   ✅ WORKING TIKTOK CONNECTION EXAMPLE (DO NOT REMOVE)
   (Structure preserved; adapted to generic gameplay)
   ============================================================ */

// 7. TikTok message handling
// ===============================

function handleTeamJoin(text, user) {
  // For general games, use this as "join" command detection
  const maybeJoin = normalizeJoinText(text);
  if (!maybeJoin) return;

  // Join the game
  joinAction(user);
  console.log(`${user.nickname} joined game`);
}

function handleAnswer(text, user) {
  // For general games, use this as "action" command detection
  const maybeAction = normalizeActionText(text);
  if (!maybeAction) return;

  // Perform action (attack boss)
  actionAttack(user, 2);
}

// Chat event
function onChatMessage(data) {
  try {
    const msg = data || {};
    const text = getChatTextFromMessage(msg);
    const user = getUserFromMessage(msg);
    if (!text) return;

    state.counters.chats++;
    flag({ who: user.nickname || user.uniqueId || "viewer", msg: text, pfp: user.avatar, tint: "tint-aqua" });

    // 1) Join selection (join command; any case)
    handleTeamJoin(text, user);

    // 2) Action selection (action command; any case)
    handleAnswer(text, user);

    // 3) Game-specific extra chat routing (AI region)
    try { if (typeof aiOnChat === "function") aiOnChat(state, { text, user }); } catch(e){}
  } catch (e) {
    console.error("Error in chat handler:", e);
  }
}

function onGiftMessage(data) {
  try {
    const g = normalizeGift(data);
    giftPower(g.giftName, g.repeat);
    try { if (typeof aiOnGift === "function") aiOnGift(state, g); } catch(e){}
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
    state.connected = true;
    setStatus("Connected", true);

    flag({ who: "SYSTEM", msg: "Connected to TikTok LIVE", pfp: "", tint: "tint-good" });

    // Only start game once we know we're connected
    if (pendingStart) {
      pendingStart = false;
      hideOverlay();
    }
  });

  client.on("disconnected", (reason) => {
    console.log("Disconnected from TikTok hub:", reason);
    state.connected = false;

    const msg = reason || "Connection closed";
    setStatus("Disconnected: " + msg, false);

    flag({ who: "SYSTEM", msg: "Disconnected: " + msg, pfp: "", tint: "tint-warn" });

    if (!pendingStart) {
      // keep overlay open so host can retry
      showOverlay();
    } else {
      pendingStart = false;
      showOverlay();
    }
  });

  client.on("error", (err) => {
    console.error("TikTok client error:", err);
    state.connected = false;
    pendingStart = false;
    const m = err && err.message ? err.message : "Unknown";
    setStatus("Error: " + m, false);
    flag({ who: "SYSTEM", msg: "Error: " + m, pfp: "", tint: "tint-warn" });
    showOverlay();
  });

  client.on("chat", onChatMessage);
  client.on("gift", onGiftMessage);

  client.on("like", (data) => {
    try {
      const l = normalizeLike(data);
      likeBoost(l.count);

      // throttle flags
      const now = Date.now();
      if (!state._lastLikeFlagAt) state._lastLikeFlagAt = 0;
      if (now - state._lastLikeFlagAt > 1200) {
        state._lastLikeFlagAt = now;
        const u = getUserFromMessage(data);
        flag({ who: u.nickname || u.uniqueId || "viewer", msg: `liked ×${l.count}`, pfp: u.avatar, tint: "tint-aqua" });
      }

      try { if (typeof aiOnLike === "function") aiOnLike(state, l); } catch(e){}
    } catch (e) {
      console.error("Error in like handler:", e);
    }
  });

  client.on("join", (data) => {
    try {
      const u = getUserFromMessage(data);
      // Join event can optionally count as join action (AI can decide)
      state.counters.joins++;
      flag({ who: u.nickname || u.uniqueId || "viewer", msg: "joined", pfp: u.avatar, tint: "tint-good" });
      try { if (typeof aiOnJoin === "function") aiOnJoin(state, { user: u }); } catch(e){}
    } catch(e){}
  });

  // Share support (if TikTokClient emits it)
  client.on("share", (data) => {
    try {
      const u = getUserFromMessage(data);
      state.counters.shares++;
      flag({ who: u.nickname || u.uniqueId || "viewer", msg: "shared", pfp: u.avatar, tint: "tint-pink" });

      // Optional: share as fallback for chat commands
      const s = state.settings || {};
      const mode = String(s.shareCountsAs || "action");
      const allow = !!s.shareAsAction;

      if (allow) {
        if (mode === "action") {
          actionAttack(u, 3);
        } else if (mode === "join") {
          joinAction(u);
        } else if (mode === "hype") {
          addHype(0.18);
        }
      }

      try { if (typeof aiOnShare === "function") aiOnShare(state, { user: u }); } catch(e){}
    } catch (e) {
      console.error("Error in share handler:", e);
    }
  });

  client.connect();
}

/* ============================================================
   Message helpers (robust across shapes)
   ============================================================ */
function getUserFromMessage(msg) {
  const m = msg || {};
  const u = m.user || m.userInfo || m.author || m.sender || m.user_id || m.userId || {};
  const userId = String(u.userId || u.id || m.userId || m.user_id || "");
  const nickname = String(u.nickname || u.displayName || u.uniqueId || u.displayid || u.displayId || u.username || "");
  const uniqueId = String(u.uniqueId || u.unique_id || u.displayid || u.displayId || u.username || nickname || "");
  const avatar = getAvatarUrlFromUser(u);
  return { userId, nickname, uniqueId, avatar };
}

function getAvatarUrlFromUser(u) {
  const x = u || {};
  const p =
    x.avatarThumb ||
    x.avatar_thumb ||
    x.avatarMedium ||
    x.avatar_medium ||
    x.avatarLarge ||
    x.avatar_large ||
    x.avatar ||
    x.profilePicture ||
    x.profile_picture ||
    "";
  if (typeof p === "string") return p;
  if (p && typeof p === "object") {
    if (Array.isArray(p.urlList) && p.urlList[0]) return String(p.urlList[0]);
    if (Array.isArray(p.url_list) && p.url_list[0]) return String(p.url_list[0]);
    if (p.url) return String(p.url);
  }
  return "";
}

function getChatTextFromMessage(msg) {
  const m = msg || {};
  const t = m.comment || m.text || m.message || m.msg || m.content || m.chat || "";
  if (typeof t === "string") return t;
  return String(t || "");
}

function normalizeLike(m) {
  const mm = m || {};
  const c = Number(mm.likeCount || mm.count || mm.likes || 1) || 1;
  return { type: "like", count: c };
}

function normalizeGift(m) {
  const mm = m || {};
  const giftName = String(mm.giftName || (mm.gift && mm.gift.name) || mm.name || "gift");
  const repeat = Number(mm.repeatCount || mm.repeat || mm.count || 1) || 1;
  return { type: "gift", giftName, repeat };
}

/* ============================================================
   Command parsing (host configurable)
   ============================================================ */
function normalizeJoinText(text) {
  const s = state.settings || {};
  const joinCmd = String(s.joinCommand || "join").toLowerCase();
  const t = String(text || "").trim().toLowerCase();

  // allow "join", "!join", "/join"
  if (t === joinCmd) return true;
  if (t === "!" + joinCmd) return true;
  if (t === "/" + joinCmd) return true;

  // allow share-workaround in chat if host wants (some viewers use "share" in chat)
  if (t === "share" && String(s.shareCountsAs || "") === "join") return true;
  return false;
}

function normalizeActionText(text) {
  const s = state.settings || {};
  const actCmd = String(s.actionCommand || "attack").toLowerCase();
  const t = String(text || "").trim().toLowerCase();

  if (t === actCmd) return true;
  if (t === "!" + actCmd) return true;
  if (t === "/" + actCmd) return true;

  // allow "share" typed in chat to count as action if desired
  if (t === "share" && String(s.shareCountsAs || "") === "action") return true;

  return false;
}

/* ============================================================
   Start / flow
   ============================================================ */
function startOffline() {
  hideOverlay();
  setStatus("Disconnected (Offline Mode)", false);
  flag({ who: "SYSTEM", msg: "Offline Mode: game is running without TikTok connection", pfp: "", tint: "tint-warn" });
}

function beginStart() {
  ensureCoreSettingsUI();
  readSettings(); // always update settings on start click

  // Always ensure game is mounted/running (even if connection fails)
  mountCanvas();
  try { if (typeof aiInit === "function") aiInit(state); } catch(e){}

  const liveId = String(liveIdInput && liveIdInput.value ? liveIdInput.value : "").trim().replace(/^@/,"");
  if (!liveId) {
    // allow offline start
    startOffline();
    return;
  }

  pendingStart = true;
  setStatus("Connecting…", false);
  try {
    setupTikTokClient(liveId);
  } catch (e) {
    pendingStart = false;
    setStatus("Error: " + (e && e.message ? e.message : "Connection failed"), false);
    showOverlay();
  }
}

/* ============================================================
   AI REGION
   - The builder inserts game-specific code here.
   - MUST define: aiInit, aiOnChat, aiOnLike, aiOnGift
   - Optional: aiOnShare, aiOnJoin
   ============================================================ */
// === AI_REGION_START ===

function aiInit(state) {
  // Default: nothing extra needed. Canvas engine already runs.
}

function aiOnChat(state, ev) {
  // Default: no extra routing.
  // You can add more commands here, but ALWAYS make them host-configurable
  // by reading state.settings and/or adding a new setting field with ensureSettingField().
}

function aiOnLike(state, like) {
  // Default: likes already fill hype meter via likeBoost().
}

function aiOnGift(state, gift) {
  // Default: gifts already trigger giftPower().
}

// Optional
function aiOnShare(state, share) {
  // Default: share behavior is handled by settings in the share event.
}

// === AI_REGION_END ===

/* ============================================================
   Boot
   ============================================================ */
(function boot() {
  try {
    // Show overlay until start
    showOverlay();
    setStatus("Not connected", false);

    // Ensure configurable settings exist even if server didn’t inject fields
    ensureCoreSettingsUI();
    readSettings();

    // Mount game immediately so it never looks blank
    mountCanvas();
    try { if (typeof aiInit === "function") aiInit(state); } catch(e){}

    if (startGameBtn) {
      startGameBtn.addEventListener("click", () => {
        // Refresh settings right before starting
        beginStart();
      });
    }

    // Helpful first banner so host sees motion instantly
    flag({ who: "SYSTEM", msg: "Game ready. Set commands, then Connect & Start.", pfp: "", tint: "tint-aqua" });
  } catch (e) {
    console.error("boot error", e);
    setStatus("Error starting game", false);
  }
})();
