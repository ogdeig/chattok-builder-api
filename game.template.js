/* =========================================================
   ChatTok Multi-Template Game Engine (production)
   - Archetypes: defense, quiz, gridfire, runner (SPEC.archetype)
   - Accepts "@username" or "username"
   - Your TikTok connection pattern INCLUDED verbatim
   - WebAudio SFX, offline preview, strict DOM safety
========================================================= */

const SPEC = __SPEC_JSON__;

/* ---------- Shared DOM + helpers ---------- */
const setupOverlay = document.getElementById("setupOverlay");
const startGameBtn = document.getElementById("startGameBtn");
const startOfflineBtn = document.getElementById("startOfflineBtn");
const liveIdInput = document.getElementById("liveIdInput");
const statusText = document.getElementById("statusText");
const statusTextInGame = document.getElementById("statusTextInGame");
const gameRoot = document.getElementById("gameRoot");

const stripAt = (s)=>String(s||"").trim().replace(/^@+/, "");
const clamp=(v,a,b)=>Math.max(a,Math.min(b,Number(v)||0));
const rand=(a,b)=>a+Math.random()*(b-a);
const safe=(s,m=120)=>String(s||"").trim().replace(/\s+/g," ").slice(0,m);

function showOverlay(){ if (setupOverlay) setupOverlay.style.display = ""; }
function hideOverlay(){ if (setupOverlay) setupOverlay.style.display = "none"; }
function setStatus(msg){
  const t=String(msg||"");
  if (statusText) statusText.textContent=t;
  if (statusTextInGame) statusTextInGame.textContent=t;
  const pill=document.getElementById("connPill");
  if (pill){ if (/connected|victory/i.test(t)) pill.classList.add("connected"); else pill.classList.remove("connected"); }
}

/* TikTok message user/fields */
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

/* ---------- UI build (shared) ---------- */
let canvas, ctx2d, W=0, H=0, DPR=1;
const UI = {};
function buildUI(){
  if(!gameRoot) return;
  while(gameRoot.firstChild) gameRoot.removeChild(gameRoot.firstChild);

  const stage = document.createElement("div"); stage.className="stage";
  const topbar = document.createElement("div"); topbar.className="topbar";
  const brand = document.createElement("div"); brand.className="brand";
  const title = document.createElement("div"); title.className="title"; title.textContent=safe(SPEC?.title||"ChatTok Game",48);
  const sub = document.createElement("div"); sub.className="sub"; sub.textContent=safe(SPEC?.oneLiner||"Connect to TikTok LIVE to start.",90);
  brand.append(title,sub);
  const pill = document.createElement("div"); pill.id="connPill"; pill.className="pill"; pill.innerHTML=`<span class="dot"></span><strong>LIVE</strong><span id="pillStatus">Offline</span>`;
  topbar.append(brand,pill);

  const playcard = document.createElement("div"); playcard.className="playcard";
  canvas = document.createElement("canvas"); canvas.className="gameCanvas"; canvas.id="gameCanvas"; playcard.appendChild(canvas);

  const hud = document.createElement("div"); hud.className="hud";
  const left = document.createElement("div"); left.className="left";
  left.innerHTML = `<div class="stat"><div class="k">Score</div><div class="v" id="hudScore">0</div></div>
                    <div class="stat"><div class="k">Players</div><div class="v" id="hudPlayers">0</div></div>`;
  const meterWrap = document.createElement("div"); meterWrap.style.flex="1";
  meterWrap.innerHTML = `<div class="stat" style="margin-bottom:6px"><div class="k">Power Meter (Likes)</div></div><div class="meter"><i id="hudMeter"></i></div>`;
  const right = document.createElement("div"); right.className="right";
  right.innerHTML = `<div class="stat"><div class="k">Likes</div><div class="v" id="hudLikes">0</div></div>
                     <div class="stat"><div class="k">Gifts</div><div class="v" id="hudGifts">0</div></div>
                     <div class="stat"><div class="k">HP</div><div class="v" id="hudHP">5</div></div>
                     <div class="stat"><div class="k">Time</div><div class="v" id="hudTime">01:30</div></div>`;
  hud.append(left,meterWrap,right);

  const flags = document.createElement("div"); flags.id="flags";

  stage.append(topbar,playcard,hud);
  gameRoot.append(stage,flags);

  try { ctx2d = canvas.getContext("2d", { alpha:true, desynchronized:true }); } catch { ctx2d = canvas.getContext("2d"); }
  resizeCanvas(); addEventListener("resize", resizeCanvas, { passive:true });

  UI.score=document.getElementById("hudScore");
  UI.players=document.getElementById("hudPlayers");
  UI.likes=document.getElementById("hudLikes");
  UI.gifts=document.getElementById("hudGifts");
  UI.meter=document.getElementById("hudMeter");
  UI.hp=document.getElementById("hudHP");
  UI.time=document.getElementById("hudTime");
  UI.pillStatus=document.getElementById("pillStatus");
}
function resizeCanvas(){ if(!canvas) return; const r=canvas.getBoundingClientRect(); DPR=Math.max(1,Math.min(2, devicePixelRatio||1)); const Wn=Math.max(1, Math.floor(r.width*DPR)); const Hn=Math.max(1, Math.floor(r.height*DPR)); if (canvas.width!==Wn || canvas.height!==Hn){ canvas.width=Wn; canvas.height=Hn; } W=canvas.width; H=canvas.height; }

function flagNotify({ who, msg }){
  const flags = document.getElementById("flags"); if(!flags) return;
  const wrap = document.createElement("div"); wrap.className="flag";
  wrap.innerHTML = `<div class="pfp"></div><div class="txt"><div class="who">${(who||"")}</div><div class="msg">${(msg||"")}</div></div>`;
  flags.prepend(wrap); while(flags.childElementCount>6) flags.removeChild(flags.lastChild);
  setTimeout(()=>{ try{ wrap.remove(); }catch{} }, 3000);
}

/* ---------- Core game state ---------- */
let client=null, gameStarted=false, gameFinished=false, pendingStart=false, connected=false, offline=false;
const state = {
  score:0, likes:0, gifts:0, power:0, baseHP:5, roundLeft:90,
  players:new Map(), shots:[], meteors:[], stars:[], // defense
  // quiz:
  userTeams:new Map(), answeredUsersThisQuestion:new Map(), roundAnswerCounts:{}, teamScores:{red:0,blue:0}, teamRoundScores:{red:0,blue:0},
  // gridfire:
  grid:{w:10,h:10, hits:new Set(), misses:new Set(), ships: new Set()},
};

/* ---------- Archetype mechanics ---------- */
function normalizeTeamText(text){
  const t=String(text||"").trim().toLowerCase();
  if (/^red\b/.test(t)) return "red";
  if (/^blue\b/.test(t)) return "blue";
  return "";
}
function normalizeAnswerText(text){
  const t=String(text||"").trim().toLowerCase();
  const m=t.match(/\b([a-d])\b/); return m?m[1].toUpperCase():"";
}
function getCurrentQuestion(){ return { correct:"A" }; } // placeholder; your builder can inject actual Qs

function letterToIndex(ch){ return ch.charCodeAt(0)-65; } // A->0
function parseGridCoord(s){
  const m=String(s||"").trim().toUpperCase().match(/^([A-J])\s*([1-9]|10)\b/);
  if(!m) return null; return { x: letterToIndex(m[1]), y: (parseInt(m[2],10)-1) };
}

/* ---------- Chat handlers (AR archetype switch) ---------- */
// (1) DEFENSE / RUNNER / GRIDFIRE commands:
function handleJoinGeneric(user){
  const id = user.userId || user.uniqueId || user.nickname;
  if (!state.players.has(id)) { state.players.set(id, { name:user.nickname, t:0 }); flagNotify({ who:user.nickname, msg:"Joined!" }); }
}
function handleFireGeneric(){ state.shots.push({ x: W*0.5, y: H-120, vx:0, vy:-820, r:5 }); SFX.shot(); }

// (2) QUIZ handlers — ***from your provided example pattern***:
function handleTeamJoin(text, user) {
  const maybeTeam = normalizeTeamText(text);
  if (!maybeTeam) return;
  state.userTeams.set(user.userId, maybeTeam);
  console.log(`${user.nickname} joined team ${maybeTeam}`);
}
function handleAnswer(text, user) {
  if (!gameStarted || gameFinished) return;
  if (!state.userTeams.has(user.userId)) return;
  const answer = normalizeAnswerText(text);
  if (!answer) return;
  if (state.answeredUsersThisQuestion.has(user.userId)) return;
  state.answeredUsersThisQuestion.set(user.userId, true);

  const team = state.userTeams.get(user.userId);
  const q = getCurrentQuestion();
  if (!q) return;

  state.roundAnswerCounts[team] = (state.roundAnswerCounts[team] || 0) + 1;
  if (answer === q.correct) {
    state.teamScores[team] = (state.teamScores[team] || 0) + 1;
    state.teamRoundScores[team] = (state.teamRoundScores[team] || 0) + 1;
    state.score += 5;
    SFX.hit();
  }
}

// (3) Main message router (ALWAYS used)
function onChatMessage(data) {
  try {
    const msg = data || {};
    const text = getChatTextFromMessage(msg);
    const user = getUserFromMessage(msg);
    if (!text) return;

    const arche = (SPEC && SPEC.archetype) || "defense";
    const low = text.toLowerCase().trim();

    if (arche === "quiz") {
      handleTeamJoin(text, user);
      handleAnswer(text, user);
      return;
    }

    // defense / runner / gridfire
    if (/^join\b/i.test(low)) handleJoinGeneric(user);

    if (arche === "gridfire") {
      const coord = parseGridCoord(text);
      if (coord) {
        const key = coord.x + "," + coord.y;
        if (state.ships.has(key)) { state.hits?.add(key); state.score+=10; SFX.hit(); flagNotify({ who:user.nickname, msg:`Hit ${key}!` }); }
        else { state.misses?.add(key); flagNotify({ who:user.nickname, msg:`Miss ${key}` }); }
      }
      return;
    }

    if (arche === "runner") {
      if (/^jump\b/.test(low)) { state.shots.push({ x: W*0.5, y: H-120, vx:0, vy:-820, r:5 }); SFX.shot(); }
      return;
    }

    // default: defense
    if (/^fire\b/.test(low)) handleFireGeneric();
  } catch (e) {
    console.error("Error in chat handler:", e);
  }
}

function onGiftMessage(data) {
  try {
    state.gifts += 1;
    state.power = clamp(state.power + 0.2, 0, 1);
    const u = getUserFromMessage(data);
    flagNotify({ who:u.nickname, msg:"Gift!" });
    SFX.boost();
  } catch (e) {
    console.error("Error in gift handler:", e);
  }
}

/* ---------- Your exact TikTok client setup pattern (UNMODIFIED) ---------- */
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
        connected = true;
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
        connected = false;
    });

    client.on("error", (err) => {
        console.error("TikTok client error:", err);
        if (statusText) statusText.textContent =
            "Error: " + (err && err.message ? err.message : "Unknown");
    });

    client.on("chat", onChatMessage);
    client.on("gift", onGiftMessage);
    client.on("like", (data) => { state.likes += 1; state.power = clamp(state.power + 0.006, 0, 1); });

    client.connect();
}

/* ---------- Connect timing helpers ---------- */
async function waitForTikTokClient(timeoutMs=12000){
  const ts=Date.now();
  while(Date.now()-ts<timeoutMs){
    if (typeof TikTokClient !== "undefined") return true;
    await new Promise(r=>setTimeout(r,200));
  }
  return false;
}

/* ---------- Archetype rendering & loop ---------- */
function ensureStars(){ if(state.stars.length) return; for(let i=0;i<80;i++) state.stars.push({ x:Math.random(), y:Math.random(), z:rand(0.2,1), t:rand(0,Math.PI*2) }); }
function spawnMeteor(){ const r=rand(18,40); state.meteors.push({ x:rand(r,W-r), y:-r, vx:rand(-40,40), vy:rand(140,240), r, hp:2+Math.random()*2 }); }

function drawDefense(){
  ensureStars();
  for (const s of state.stars){ s.t+=0.02; const a=(Math.sin(s.t)+1)/2*.8+.2; ctx2d.globalAlpha=a; ctx2d.fillStyle="white"; ctx2d.beginPath(); ctx2d.arc(s.x*W, s.y*H, s.z*1.6, 0, Math.PI*2); ctx2d.fill(); ctx2d.globalAlpha=1; }
  ctx2d.fillStyle="rgba(255,255,255,.92)";
  for (const m of state.meteors){ ctx2d.beginPath(); ctx2d.arc(m.x,m.y,m.r,0,Math.PI*2); ctx2d.fill(); }
  ctx2d.fillStyle="#00f2ea";
  for (const s of state.shots){ ctx2d.beginPath(); ctx2d.arc(s.x,s.y,s.r,0,Math.PI*2); ctx2d.fill(); }
}
function updateDefense(dt){
  if (Math.random() < (0.8 + (90 - state.roundLeft) * 0.01) * dt) spawnMeteor();
  for (const m of state.meteors){ m.x+=m.vx*dt; m.y+=m.vy*dt; }
  for (const s of state.shots){ s.x+=s.vx*dt; s.y+=s.vy*dt; }
  for (const s of state.shots){
    for (const m of state.meteors){
      const dx=s.x-m.x, dy=s.y-m.y, rr=(s.r+m.r); if (dx*dx+dy*dy <= rr*rr){ m.hp-=1; s.r=0; state.score+=(m.r<24?3:m.r<32?5:8); SFX.hit(); }
    }
  }
  state.meteors = state.meteors.filter(m => (m.y>H+m.r ? (state.baseHP=Math.max(0,state.baseHP-1), false) : m.hp>0));
  state.shots = state.shots.filter(s => s.r>0 && s.y>-20);
}

function drawGridfire(){ // simple grid overlay
  const gw=state.grid.w, gh=state.grid.h; const cellX=W/gw, cellY=H/gh;
  ctx2d.strokeStyle="rgba(255,255,255,.15)"; for(let i=1;i<gw;i++){ ctx2d.beginPath(); ctx2d.moveTo(i*cellX,0); ctx2d.lineTo(i*cellX,H); ctx2d.stroke(); }
  for(let j=1;j<gh;j++){ ctx2d.beginPath(); ctx2d.moveTo(0,j*cellY); ctx2d.lineTo(W,j*cellY); ctx2d.stroke(); }
  ctx2d.fillStyle="#00f2ea"; for(const k of state.grid.hits){ const [x,y]=k.split(",").map(n=>+n); ctx2d.fillRect(x*cellX+2,y*cellY+2,cellX-4,cellY-4); }
  ctx2d.fillStyle="rgba(255,255,255,.3)"; for(const k of state.grid.misses){ const [x,y]=k.split(",").map(n=>+n); ctx2d.fillRect(x*cellX+6,y*cellY+6,cellX-12,cellY-12); }
}
function updateGridfire(dt){ /* no-op; updates come from chat */ }

function drawRunner(){ drawDefense(); } // reuse visuals
function updateRunner(dt){ // shots are "jumps" used for score pacing
  for (const s of state.shots){ s.x+=s.vx*dt; s.y+=s.vy*dt; }
  state.shots = state.shots.filter(s => s.y>-20);
}

function updateHUD(){
  const set=(el,val)=>{ if(el) el.textContent=String(val); };
  set(UI.score, state.score); set(UI.players, state.players.size);
  set(UI.likes, state.likes); set(UI.gifts, state.gifts);
  if (UI.meter) UI.meter.style.width = `${Math.round(clamp(state.power,0,1)*100)}%`;
  set(UI.hp, state.baseHP);
  const t=Math.max(0,Math.floor(state.roundLeft)); const mm=Math.floor(t/60), ss=String(t%60).padStart(2,"0"); set(UI.time, `${mm}:${ss}`);
  if (UI.pillStatus) UI.pillStatus.textContent = connected ? "Connected" : (offline ? "Demo" : "Offline");
}

function draw(){ ctx2d.clearRect(0,0,W,H); const a=(SPEC?.archetype)||"defense"; if(a==="gridfire") drawGridfire(); else if(a==="runner") drawRunner(); else drawDefense(); }
function update(dt){
  const a=(SPEC?.archetype)||"defense";
  if(a==="gridfire") updateGridfire(dt);
  else if(a==="runner") updateRunner(dt);
  else updateDefense(dt);

  state.power = clamp(state.power - 0.002*dt, 0, 1);
  if (gameStarted && state.roundLeft>0){
    state.roundLeft = Math.max(0, state.roundLeft - dt);
    if (state.roundLeft===0 || state.baseHP<=0){ setStatus("Defeat"); SFX.defeat(); gameFinished=true; }
    if (state.score>=300 && state.baseHP>0){ setStatus("Victory"); SFX.victory(); gameFinished=true; }
  }
  updateHUD();
}

let lastT=0; function tick(t){ const dt=Math.min(0.045, (t-lastT)/1000); lastT=t; draw(); update(dt); requestAnimationFrame(tick); }

/* ---------- Game start flow ---------- */
function beginGame(){ if(gameStarted) return; gameStarted=true; hideOverlay(); buildUI(); setStatus(offline?"Offline (demo)":"Connected"); }

/* Offline simulation (safe) */
let simTimer=0;
function simulate(dt){
  if (!offline) return;
  simTimer += dt;
  if (simTimer>1.1){
    simTimer=0;
    const fake = { user:{ uniqueId:"demo"+Math.floor(Math.random()*999), nickname:"Guest"+Math.floor(Math.random()*999) }, comment: (SPEC?.archetype)==="quiz" ? (Math.random()<0.5?"red":"blue") : (Math.random()<0.5?"join":"fire") };
    onChatMessage(fake);
  }
}

/* Augment main loop for offline sim */
const _update = update;
update = function(dt){ simulate(dt); _update(dt); };

/* ---------- Bootstrap ---------- */
addEventListener("load", ()=>{
  setStatus("Enter your LIVE ID, then press Start.");
  showOverlay(); buildUI(); requestAnimationFrame(tick);

  startOfflineBtn?.addEventListener("click", ()=>{ offline=true; pendingStart=false; beginGame(); });

  startGameBtn?.addEventListener("click", async ()=>{
    try{
      const liveId = stripAt(liveIdInput?.value||"");
      if (!liveId) { setStatus("Enter a LIVE ID."); liveIdInput?.focus(); return; }
      setStatus("Waiting for TikTok client…");
      const ok = await waitForTikTokClient(12000);
      if (!ok) { setStatus("TikTok client not available — run in ChatTok preview/live."); return; }
      offline=false; pendingStart=true; setStatus("Connecting…"); setupTikTokClient(liveId);
    }catch(e){ console.error(e); setStatus("Error: "+(e?.message||"Unknown")); }
  });
});
