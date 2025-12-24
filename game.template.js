/* =========================================================
   ChatTok Game Template — production ready
   - No proto/Tailwind/CDNs; Start waits for injected TikTok client.
   - Accepts "@username" or "username".
   - WebAudio SFX; optional offline simulation; robust DOM guards.
========================================================= */

const SPEC = __SPEC_JSON__;

/* DOM refs */
const setupOverlay = document.getElementById("setupOverlay");
const startGameBtn = document.getElementById("startGameBtn");
const startOfflineBtn = document.getElementById("startOfflineBtn");
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
const clamp=(v,a,b)=>Math.max(a,Math.min(b,Number(v)||0));
const rand=(a,b)=>a+Math.random()*(b-a);
const safeText=(s,m=80)=>String(s||"").trim().replace(/\s+/g," ").slice(0,m);
const stripAt=(s)=>String(s||"").trim().replace(/^@+/, "");

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

/* WebAudio SFX (no assets) */
const SFX = (() => {
  let ctx;
  const C = ()=> (ctx = ctx || new (window.AudioContext||window.webkitAudioContext)());
  function beep({f=440,d=0.08,t="sine",g=0.2,slide=0}={}){ try{
    const c=C(); const o=c.createOscillator(), v=c.createGain(); o.type=t; o.frequency.value=f; v.gain.value=g; o.connect(v); v.connect(c.destination);
    const n=c.currentTime; if(slide){ o.frequency.setValueAtTime(f,n); o.frequency.exponentialRampToValueAtTime(Math.max(40,f+slide), n+d); }
    v.gain.setValueAtTime(g,n); v.gain.exponentialRampToValueAtTime(0.0001,n+d); o.start(); o.stop(n+d+0.02);
  }catch{} }
  return {
    shot(){ beep({f:640,d:0.06,t:"square",g:0.15,slide:-320}); },
    hit(){ beep({f:220,d:0.08,t:"sawtooth",g:0.2,slide:-100}); },
    boost(){ beep({f:540,d:0.18,t:"triangle",g:0.18,slide:220}); },
    victory(){ beep({f:660,d:0.12,t:"square",g:0.2}); setTimeout(()=>beep({f:880,d:0.12,t:"square",g:0.2}),120); },
    defeat(){ beep({f:200,d:0.25,t:"sine",g:0.25,slide:-160}); }
  };
})();

/* Build UI dynamically */
let canvas, ctx2d, W=0, H=0, DPR=1, ui={};
function clearEl(el){ if(!el) return; while(el.firstChild) el.removeChild(el.firstChild); }
function buildUI(){
  if(!gameRoot) return;
  clearEl(gameRoot);

  const stage = document.createElement("div"); stage.className="stage";
  const topbar = document.createElement("div"); topbar.className="topbar";
  const brand = document.createElement("div"); brand.className="brand";
  const title = document.createElement("div"); title.className="title"; title.textContent=safeText(SPEC?.title||"ChatTok Game",48);
  const sub = document.createElement("div"); sub.className="sub"; sub.textContent=safeText(SPEC?.subtitle||"Connect to TikTok LIVE to start.",90);
  brand.append(title,sub);

  const pill = document.createElement("div"); pill.id="connPill"; pill.className="pill"; pill.innerHTML=`<span class="dot"></span><strong>LIVE</strong><span id="pillStatus">Offline</span>`;
  topbar.append(brand,pill);

  const playcard = document.createElement("div"); playcard.className="playcard";
  canvas = document.createElement("canvas"); canvas.className="gameCanvas"; canvas.id="gameCanvas"; playcard.appendChild(canvas);

  const hud = document.createElement("div"); hud.className="hud";
  const left = document.createElement("div"); left.className="left"; left.innerHTML=`<div class="stat"><div class="k">Score</div><div class="v" id="hudScore">0</div></div><div class="stat"><div class="k">Players</div><div class="v" id="hudPlayers">0</div></div>`;
  const meterWrap=document.createElement("div"); meterWrap.style.flex="1"; meterWrap.innerHTML=`<div class="stat" style="margin-bottom:6px"><div class="k">Power Meter (Likes)</div></div><div class="meter"><i id="hudMeter"></i></div>`;
  const right=document.createElement("div"); right.className="right"; right.innerHTML=`<div class="stat"><div class="k">Likes</div><div class="v" id="hudLikes">0</div></div><div class="stat"><div class="k">Gifts</div><div class="v" id="hudGifts">0</div></div><div class="stat"><div class="k">HP</div><div class="v" id="hudHP">5</div></div><div class="stat"><div class="k">Time</div><div class="v" id="hudTime">01:30</div></div>`;
  hud.append(left,meterWrap,right);

  const flags=document.createElement("div"); flags.id="flags";

  stage.append(topbar,playcard,hud);
  gameRoot.append(stage,flags);

  try{ ctx2d = canvas.getContext("2d", { alpha:true, desynchronized:true }); }catch{ ctx2d = canvas.getContext("2d"); }
  resizeCanvas(); window.addEventListener("resize", resizeCanvas, { passive:true });

  ui = {
    hudScore:document.getElementById("hudScore"),
    hudPlayers:document.getElementById("hudPlayers"),
    hudLikes:document.getElementById("hudLikes"),
    hudGifts:document.getElementById("hudGifts"),
    hudMeter:document.getElementById("hudMeter"),
    hudHP:document.getElementById("hudHP"),
    hudTime:document.getElementById("hudTime"),
    flagsEl:document.getElementById("flags"),
    pillStatus:document.getElementById("pillStatus")
  };
}
function resizeCanvas(){ if(!canvas) return; const r=canvas.getBoundingClientRect(); DPR=Math.max(1,Math.min(2,window.devicePixelRatio||1)); const Wn=Math.max(1,Math.floor(r.width*DPR)); const Hn=Math.max(1,Math.floor(r.height*DPR)); if(canvas.width!==Wn||canvas.height!==Hn){ canvas.width=Wn; canvas.height=Hn; } W=canvas.width; H=canvas.height; }

/* Toast flags */
function escapeHtml(s){ return String(s||"").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;"); }
function flagNotify({ who, msg }){ const el=document.getElementById("flags"); if(!el) return; const w=document.createElement("div"); w.className="flag"; w.innerHTML=`<div class="pfp"></div><div class="txt"><div class="who">${escapeHtml(who||"")}</div><div class="msg">${escapeHtml(msg||"")}</div></div>`; el.prepend(w); while(el.childElementCount>6) el.removeChild(el.lastChild); setTimeout(()=>{ try{ w.remove(); }catch{} },3000); }

/* Settings (collapsible) */
function ensureSettingsUI(){
  const card = setupOverlay?.querySelector(".overlay-card");
  if(!card || card.querySelector("#ctSettings")) return;
  const d=document.createElement("details"); d.id="ctSettings"; d.style.cssText="margin-top:10px;border:1px solid rgba(255,255,255,.10);border-radius:14px;padding:10px;background:rgba(0,0,0,.18)";
  d.innerHTML=`<summary style="cursor:pointer;font-weight:900">Game Settings (optional)</summary>
    <div style="margin-top:10px;display:grid;gap:10px">
      <div class="row"><label class="label" for="cmdAction">Chat command (action)</label><input id="cmdAction" class="input" placeholder="fire" autocomplete="off"/></div>
      <div class="row"><label class="label" for="cmdJoin">Chat command (join)</label><input id="cmdJoin" class="input" placeholder="join" autocomplete="off"/></div>
    </div>`;
  card.appendChild(d);
}

/* Game state */
let client=null, gameStarted=false, pendingStart=false, offline=false, simTimer=0;
const state = { connected:false, score:0, likes:0, gifts:0, power:0, baseHP:5, roundLeft:90, players:new Map(), meteors:[], shots:[], stars:[] };

function beginGame(){
  if (gameStarted) return;
  gameStarted = true; hideOverlay(); buildUI(); setStatus(offline?"Offline (demo)":"Connected", true);
}

/* TikTok handlers */
function onChatMessage(data){
  try{
    const text = getChatTextFromMessage(data); const u = getUserFromMessage(data);
    if(!text) return;
    const low = text.toLowerCase().trim();
    const joinKW = (document.getElementById("cmdJoin")?.value || "join").toLowerCase();
    const actKW  = (document.getElementById("cmdAction")?.value || "fire").toLowerCase();

    if (low.startsWith(joinKW)) {
      const id = u.userId || u.uniqueId || u.nickname;
      if (!state.players.has(id)) { state.players.set(id, { name:u.nickname, last:0 }); flagNotify({ who:u.nickname, msg:"Joined!" }); }
    }
    if (low.startsWith(actKW)) {
      state.shots.push({ x: W/2, y: H-120, vx: 0, vy: -820, r: 5 });
      SFX.shot();
    }
  }catch(e){ console.error("Error in chat handler:", e); }
}

/* TikTok connection (STRICT CONTRACT) */
function setupTikTokClient(liveId) {
  if (!liveId) throw new Error("liveId is required");
  if (client && client.socket) { try { client.socket.close(); } catch(e){} }
  if (typeof TikTokClient === "undefined") { throw new Error("TikTokClient is not available. Check tiktok-client.js."); }

  client = new TikTokClient(liveId);

  if (typeof CHATTOK_CREATOR_TOKEN !== "undefined" && CHATTOK_CREATOR_TOKEN) {
    client.setAccessToken(CHATTOK_CREATOR_TOKEN);
  }

  client.on("connected", () => { state.connected = true; if (pendingStart && !gameStarted) beginGame(); });
  client.on("disconnected", () => { state.connected = false; if (!gameStarted) pendingStart = false; });
  client.on("error", (err) => console.error("TikTok client error:", err));

  client.on("chat", onChatMessage);
  client.on("gift", (data) => { state.gifts += 1; state.power = clamp(state.power + 0.2, 0, 1); flagNotify({ who:getUserFromMessage(data).nickname, msg:"Gift!" }); SFX.boost(); });
  client.on("like", () => { state.likes += 1; state.power = clamp(state.power + 0.006, 0, 1); });

  client.connect();
}

/* Wait for TikTokClient (Start pressed) */
async function waitForTikTokClient(timeoutMs=12000){
  const s=Date.now(); while(Date.now()-s<timeoutMs){ if(typeof TikTokClient!=="undefined") return true; await new Promise(r=>setTimeout(r,200)); } return false;
}

/* Offline simulation (safe; disabled by default) */
function simulateStep(dt){
  simTimer += dt;
  if(simTimer>1.2){ simTimer=0; // simulate join & fire
    const fake = { user:{ uniqueId:"demo"+Math.floor(Math.random()*999), nickname:"Guest"+Math.floor(Math.random()*999) }, comment: Math.random()<0.5?"join":"fire" };
    onChatMessage(fake);
  }
}

/* Gameplay */
function ensureStars(){ if(state.stars.length) return; for(let i=0;i<80;i++) state.stars.push({ x:Math.random(), y:Math.random(), z:rand(0.2,1), t:rand(0,Math.PI*2) }); }
function spawnMeteor(){ const r=rand(18,40); state.meteors.push({ x:rand(r,W-r), y:-r, vx:rand(-40,40), vy:rand(140,240), r, hp:2+Math.random()*2 }); }

function draw(){
  if(!ctx2d) return;
  ctx2d.clearRect(0,0,W,H);
  ensureStars();
  for(const s of state.stars){ s.t+=0.02; const a=(Math.sin(s.t)+1)/2*.8+.2; ctx2d.globalAlpha=a; ctx2d.fillStyle="white"; ctx2d.beginPath(); ctx2d.arc(s.x*W, s.y*H, s.z*1.6, 0, Math.PI*2); ctx2d.fill(); ctx2d.globalAlpha=1; }
  ctx2d.fillStyle="rgba(255,255,255,.92)"; for(const m of state.meteors){ ctx2d.beginPath(); ctx2d.arc(m.x,m.y,m.r,0,Math.PI*2); ctx2d.fill(); }
  ctx2d.fillStyle="#00f2ea"; for(const s of state.shots){ ctx2d.beginPath(); ctx2d.arc(s.x,s.y,s.r,0,Math.PI*2); ctx2d.fill(); }
}
function updateHUD(){
  const set=(id,val)=>{ const el=document.getElementById(id); if(el) el.textContent=String(val); };
  set("hudScore", state.score); set("hudPlayers", state.players.size); set("hudLikes", state.likes); set("hudGifts", state.gifts); const m=document.getElementById("hudMeter"); if(m) m.style.width=`${Math.round(state.power*100)}%`; set("hudHP", state.baseHP);
  const t=Math.max(0,Math.floor(state.roundLeft)); const mm=Math.floor(t/60), ss=String(t%60).padStart(2,"0"); set("hudTime", `${mm}:${ss}`);
  const ps=document.getElementById("pillStatus"); if(ps) ps.textContent = state.connected? "Connected":"Offline";
}
function update(dt){
  if(Math.random() < (0.8 + (90 - state.roundLeft) * 0.01) * dt) spawnMeteor();
  for(const m of state.meteors){ m.x+=m.vx*dt; m.y+=m.vy*dt; }
  for(const s of state.shots){ s.x+=s.vx*dt; s.y+=s.vy*dt; }
  for(const s of state.shots){ for(const m of state.meteors){ const dx=s.x-m.x, dy=s.y-m.y, rr=s.r+m.r; if(dx*dx+dy*dy<=rr*rr){ m.hp-=1; s.r=0; state.score+=(m.r<24?3:m.r<32?5:8); SFX.hit(); } } }
  state.meteors=state.meteors.filter(m=>{ if(m.y>H+m.r){ state.baseHP=Math.max(0,state.baseHP-1); return false; } return m.hp>0; });
  state.shots=state.shots.filter(s=>s.r>0 && s.y>-20);
  state.power=clamp(state.power - 0.002*dt, 0, 1);

  if(offline) simulateStep(dt);

  if(gameStarted && state.roundLeft>0){
    state.roundLeft=Math.max(0,state.roundLeft - dt);
    if(state.roundLeft===0 || state.baseHP<=0){ setStatus("Defeat",true); SFX.defeat(); }
    if(state.score>=300 && state.baseHP>0){ setStatus("Victory",true); SFX.victory(); }
  }
  updateHUD();
}
let last=0; function tick(t){ const dt=Math.min(0.045,(t-last)/1000); last=t; draw(); update(dt); requestAnimationFrame(tick); }

/* Start flow */
window.addEventListener("load", ()=>{
  setStatus("Enter your LIVE ID, then press Start."); showOverlay(); ensureSettingsUI(); buildUI();
  requestAnimationFrame(tick);

  startOfflineBtn?.addEventListener("click", ()=>{
    offline=true; pendingStart=false; beginGame();
  });

  startGameBtn?.addEventListener("click", async ()=>{
    try{
      const liveId = stripAt(liveIdInput?.value||"");
      if(!liveId){ setStatus("Enter a LIVE ID.", false); liveIdInput?.focus(); return; }
      setStatus("Waiting for TikTok client…");
      const ok = await waitForTikTokClient(12000);
      if(!ok){ setStatus("TikTok client not available — run in ChatTok preview/live.", false); return; }
      offline=false; pendingStart=true; setStatus("Connecting…", true); setupTikTokClient(liveId);
      // beginGame happens on "connected"
    }catch(e){ console.error(e); setStatus("Error: "+(e?.message||"Unknown"), false); }
  });
});
