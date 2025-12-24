/* =========================================================
   ChatTok Game Template — game.template.js
   - Settings overlay; accepts "@username" or "username".
   - Waits for injected TikTokClient on Start (no proto fetch).
   - Robust chat parsing + sound effects (WebAudio).
========================================================= */

const SPEC = __SPEC_JSON__;

/* DOM refs */
const setupOverlay = document.getElementById("setupOverlay");
const startGameBtn = document.getElementById("startGameBtn");
const liveIdInput = document.getElementById("liveIdInput");
const statusText = document.getElementById("statusText");
const statusTextInGame = document.getElementById("statusTextInGame");
const gameRoot = document.getElementById("gameRoot");

function showOverlay(){ if (setupOverlay) setupOverlay.style.display = ""; }
function hideOverlay(){ if (setupOverlay) setupOverlay.style.display = "none"; }
function setStatus(msg, ok = true){
  const t = String(msg || "");
  if (statusText) statusText.textContent = t;
  if (statusTextInGame) statusTextInGame.textContent = t;
  const pill = document.getElementById("connPill");
  if (pill){ if (/connected|victory/i.test(t)) pill.classList.add("connected"); else pill.classList.remove("connected"); }
}

/* Helpers */
function clamp(v,a,b){ v = Number(v)||0; return Math.max(a, Math.min(b, v)); }
function nowMs(){ return Date.now(); }
function rand(a,b){ return a + Math.random()*(b-a); }
function pick(arr){ return arr[Math.floor(Math.random()*arr.length)]; }
function safeText(s, max=80){ return String(s||"").trim().replace(/\s+/g," ").slice(0,max); }
function stripAt(s){ return String(s||"").trim().replace(/^@+/, ""); }

function getChatTextFromMessage(m){ const t = m?.content ?? m?.comment ?? m?.text ?? m?.message ?? ""; return String(t||"").trim(); }
function firstUrl(v){ if(!v) return ""; if(typeof v==="string") return v; if(Array.isArray(v)) return typeof v[0]==="string"?v[0]:""; return ""; }
function getUserFromMessage(m){
  const u = m?.user || m?.userInfo || m?.sender || {};
  const userId = String(u.userId ?? u.id ?? m.userId ?? "");
  const uniqueId = String(u.uniqueId ?? u.username ?? m.uniqueId ?? "");
  const nickname = String(u.nickname ?? u.displayName ?? uniqueId || "viewer");
  const avatar = firstUrl(u.profilePictureUrl) || "";
  return { userId, uniqueId, nickname, avatar };
}

/* WebAudio (tiny, no assets) */
const SFX = (() => {
  let ctx;
  function getCtx(){ ctx = ctx || new (window.AudioContext||window.webkitAudioContext)(); return ctx; }
  function beep({f=440,d=0.08,t="sine",g=0.2,slide=0}={}){
    try{
      const c = getCtx(); const o = c.createOscillator(); const v = c.createGain();
      o.type = t; o.frequency.value = f; v.gain.value = g; o.connect(v); v.connect(c.destination);
      const now = c.currentTime; if (slide){ o.frequency.setValueAtTime(f, now); o.frequency.exponentialRampToValueAtTime(Math.max(40,f+slide), now + d); }
      v.gain.setValueAtTime(g, now); v.gain.exponentialRampToValueAtTime(0.0001, now + d);
      o.start(); o.stop(now + d + 0.02);
    }catch{}
  }
  return {
    shot(){ beep({f:640,d:0.06,t:"square",g:0.15,slide:-320}); },
    hit(){ beep({f:220,d:0.08,t:"sawtooth",g:0.2,slide:-100}); },
    boost(){ beep({f:540,d:0.18,t:"triangle",g:0.18,slide:220}); },
    victory(){ beep({f:660,d:0.12,t:"square",g:0.2}); setTimeout(()=>beep({f:880,d:0.12,t:"square",g:0.2}),120); },
    defeat(){ beep({f:200,d:0.25,t:"sine",g:0.25,slide:-160}); }
  };
})();

/* Build UI dynamically (guaranteed IDs) */
let canvas, ctx2d, W=0, H=0, DPR=1, ui={};
function clearEl(el){ if(!el) return; while(el.firstChild) el.removeChild(el.firstChild); }
function buildUI(){
  clearEl(gameRoot);

  const stage = document.createElement("div");
  stage.className = "stage";

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

  const playcard = document.createElement("div");
  playcard.className = "playcard";

  canvas = document.createElement("canvas");
  canvas.className = "gameCanvas";
  canvas.id = "gameCanvas";
  playcard.appendChild(canvas);

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
    <div class="stat"><div class="k">HP</div><div class="v" id="hudHP">5</div></div>
    <div class="stat"><div class="k">Time</div><div class="v" id="hudTime">01:30</div></div>
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

  try { ctx2d = canvas.getContext("2d", { alpha: true, desynchronized: true }); }
  catch { ctx2d = canvas.getContext("2d"); }

  resizeCanvas();
  window.addEventListener("resize", resizeCanvas, { passive: true });

  ui = {
    hudScore: document.getElementById("hudScore"),
    hudPlayers: document.getElementById("hudPlayers"),
    hudLikes: document.getElementById("hudLikes"),
    hudGifts: document.getElementById("hudGifts"),
    hudMeter: document.getElementById("hudMeter"),
    hudHP: document.getElementById("hudHP"),
    hudTime: document.getElementById("hudTime"),
    flagsEl: document.getElementById("flags"),
    pillStatus: document.getElementById("pillStatus")
  };
}

function resizeCanvas(){
  if (!canvas) return;
  const r = canvas.getBoundingClientRect();
  DPR = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
  const Wn = Math.max(1, Math.floor(r.width * DPR));
  const Hn = Math.max(1, Math.floor(r.height * DPR));
  if (canvas.width !== Wn || canvas.height !== Hn){ canvas.width = Wn; canvas.height = Hn; }
  W = canvas.width; H = canvas.height;
}

/* Flags (small toasts) */
function escapeHtml(s){ return String(s||"").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;"); }
function flagNotify({ who, msg }){
  const flags = document.getElementById("flags");
  if (!flags) return;
  const wrap = document.createElement("div");
  wrap.className = "flag";
  wrap.innerHTML = `<div class="pfp"></div><div class="txt"><div class="who">${escapeHtml(who||"")}</div><div class="msg">${escapeHtml(msg||"")}</div></div>`;
  flags.prepend(wrap);
  while (flags.childElementCount > 6) flags.removeChild(flags.lastChild);
  setTimeout(()=>{ try{ wrap.remove(); }catch{} }, 3000);
}

/* Settings panel on overlay */
function ensureSettingsUI(){
  const card = setupOverlay ? setupOverlay.querySelector(".overlay-card") : null;
  if (!card || card.querySelector("#ctSettings")) return;

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

  const box = document.createElement("div");
  box.style.marginTop = "10px"; box.style.display = "grid"; box.style.gap = "10px";
  box.innerHTML = `
    <div class="row">
      <label class="label" for="cmdAction">Chat command (action)</label>
      <input id="cmdAction" class="input" placeholder="fire" autocomplete="off" />
    </div>
    <div class="row">
      <label class="label" for="cmdJoin">Chat command (join)</label>
      <input id="cmdJoin" class="input" placeholder="join" autocomplete="off" />
    </div>
  `;
  details.appendChild(summary); details.appendChild(box); card.appendChild(details);
}

/* Game state */
let client = null, gameStarted = false, pendingStart = false;
const state = {
  connected:false,
  score:0, likes:0, gifts:0, power:0,
  baseHP: 5,
  roundLeft: 90,
  players:new Map(),
  meteors:[], shots:[], explosions:[], stars:[]
};

function beginGame(){
  if (gameStarted) return;
  gameStarted = true;
  hideOverlay();
  buildUI();
  setStatus("Connected", true);
}

/* TikTok handlers */
function onChatMessage(data){
  try{
    const text = getChatTextFromMessage(data);
    const u = getUserFromMessage(data);
    if (!text) return;

    const low = text.toLowerCase().trim();
    const joinKW = (document.getElementById("cmdJoin")?.value || "join").toLowerCase();
    const actKW  = (document.getElementById("cmdAction")?.value || "fire").toLowerCase();

    if (low.startsWith(joinKW)) {
      const id = u.userId || u.uniqueId || u.nickname;
      if (!state.players.has(id)) {
        state.players.set(id, { name:u.nickname, last:0 });
        flagNotify({ who:u.nickname, msg:"Joined!" });
      }
    }
    if (low.startsWith(actKW)) {
      const speed = 820;
      state.shots.push({ x: W/2, y: H-120, vx: 0, vy: -speed, r: 5 });
      SFX.shot();
    }
  }catch(e){ console.error("Error in chat handler:", e); }
}

/* TikTok connection (STRICT CONTRACT) */
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
    state.connected = true;
    if (pendingStart && !gameStarted) beginGame();
  });

  client.on("disconnected", (reason) => {
    console.log("Disconnected:", reason);
    state.connected = false;
    if (!gameStarted) pendingStart = false;
  });

  client.on("error", (err) => console.error("TikTok client error:", err));

  client.on("chat", onChatMessage);
  client.on("gift", (data) => {
    state.gifts += 1;
    state.power = clamp(state.power + 0.2, 0, 1);
    const u = getUserFromMessage(data);
    flagNotify({ who:u.nickname, msg:"Gift!" });
    SFX.boost();
  });
  client.on("like", () => {
    state.likes += 1;
    state.power = clamp(state.power + 0.006, 0, 1);
  });

  client.connect();
}

/* Wait for TikTokClient on Start */
async function waitForTikTokClient(timeoutMs = 12000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (typeof TikTokClient !== "undefined") return true;
    await new Promise(r => setTimeout(r, 200));
  }
  return false;
}

/* Gameplay */
function ensureStars(){
  if (state.stars.length) return;
  for (let i=0;i<80;i++) state.stars.push({ x:Math.random(), y:Math.random(), z:rand(0.2,1), t:rand(0,Math.PI*2) });
}
function spawnMeteor(){
  const r = rand(18, 40);
  state.meteors.push({ x: rand(r, W-r), y: -r, vx: rand(-40,40), vy: rand(140,240), r, hp: 2+Math.random()*2 });
}

function updateHUD(){
  const scoreEl = document.getElementById("hudScore");
  const playersEl = document.getElementById("hudPlayers");
  const likesEl = document.getElementById("hudLikes");
  const giftsEl = document.getElementById("hudGifts");
  const meterEl = document.getElementById("hudMeter");
  const hpEl = document.getElementById("hudHP");
  const timeEl = document.getElementById("hudTime");
  const pill = document.getElementById("pillStatus");

  if (scoreEl) scoreEl.textContent = String(state.score);
  if (playersEl) playersEl.textContent = String(state.players.size);
  if (likesEl) likesEl.textContent = String(state.likes);
  if (giftsEl) giftsEl.textContent = String(state.gifts);
  if (meterEl) meterEl.style.width = `${Math.round(state.power*100)}%`;
  if (hpEl) hpEl.textContent = String(state.baseHP);
  if (timeEl){
    const s = Math.max(0, Math.floor(state.roundLeft));
    const m = Math.floor(s/60), ss = String(s%60).padStart(2,"0");
    timeEl.textContent = `${m}:${ss}`;
  }
  if (pill) pill.textContent = state.connected ? "Connected" : "Offline";
}

function draw(){
  if (!ctx2d) return;
  ctx2d.clearRect(0,0,W,H);

  ensureStars();
  for (const s of state.stars){
    s.t += 0.02; const a = (Math.sin(s.t)+1)/2 * 0.8 + 0.2;
    ctx2d.globalAlpha = a; ctx2d.fillStyle = "white";
    ctx2d.beginPath(); ctx2d.arc(s.x*W, s.y*H, s.z*1.6, 0, Math.PI*2); ctx2d.fill(); ctx2d.globalAlpha = 1;
  }

  ctx2d.fillStyle = "rgba(255,255,255,.92)";
  for (const m of state.meteors){ ctx2d.beginPath(); ctx2d.arc(m.x, m.y, m.r, 0, Math.PI*2); ctx2d.fill(); }

  ctx2d.fillStyle = "#00f2ea";
  for (const s of state.shots){ ctx2d.beginPath(); ctx2d.arc(s.x, s.y, s.r, 0, Math.PI*2); ctx2d.fill(); }
}

function update(dt){
  if (Math.random() < (0.8 + (90 - state.roundLeft) * 0.01) * dt) spawnMeteor();

  for (const m of state.meteors){ m.x += m.vx*dt; m.y += m.vy*dt; }
  for (const s of state.shots){ s.x += s.vx*dt; s.y += s.vy*dt; }

  for (const s of state.shots){
    for (const m of state.meteors){
      const dx=s.x-m.x, dy=s.y-m.y, rr=(s.r+m.r); if (dx*dx+dy*dy <= rr*rr){
        m.hp -= 1; s.r = 0;
        state.score += (m.r<24?3:m.r<32?5:8);
        SFX.hit();
      }
    }
  }

  state.meteors = state.meteors.filter(m => {
    if (m.y > H + m.r){ state.baseHP = Math.max(0, state.baseHP-1); return false; }
    if (m.hp <= 0) return false; return true;
  });
  state.shots = state.shots.filter(s => s.r > 0 && s.y > -20);

  state.power = clamp(state.power - 0.002*dt, 0, 1);

  if (gameStarted && state.roundLeft > 0){
    state.roundLeft = Math.max(0, state.roundLeft - dt);
    if (state.roundLeft === 0 || state.baseHP <= 0){
      setStatus("Defeat", true); SFX.defeat();
    }
    if (state.score >= 300 && state.baseHP > 0){
      setStatus("Victory", true); SFX.victory();
    }
  }

  updateHUD();
}

let rafId=0,lastT=0;
function tick(t){ const dt = Math.min(0.045, (t-lastT)/1000); lastT = t; draw(); update(dt); rafId = requestAnimationFrame(tick); }

/* Start flow */
window.addEventListener("load", () => {
  setStatus("Enter your LIVE ID, then press Start.");
  showOverlay();
  ensureSettingsUI();
  buildUI();

  lastT = performance.now();
  cancelAnimationFrame(rafId);
  rafId = requestAnimationFrame(tick);

  if (startGameBtn) {
    startGameBtn.addEventListener("click", async () => {
      try{
        const liveIdRaw = String(liveIdInput && liveIdInput.value ? liveIdInput.value : "");
        const liveId = stripAt(liveIdRaw);
        if (!liveId){ setStatus("Enter a LIVE ID.", false); liveIdInput?.focus(); return; }

        setStatus("Waiting for TikTok client…");
        const ok = await waitForTikTokClient(12000);
        if (!ok){ setStatus("TikTok client not available — run in ChatTok preview/live.", false); return; }

        pendingStart = true;
        setStatus("Connecting…", true);
        setupTikTokClient(liveId);
        // beginGame happens on "connected"
      }catch(e){
        console.error(e);
        setStatus("Error: " + (e?.message || "Unknown"), false);
      }
    });
  }
});
