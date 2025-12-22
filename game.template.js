/* game.js (template-first)
   - Uses TikTokClient (provided by ChatTokGaming host at runtime)
   - AI fills ONLY the region between markers (AI_REGION)
   - Always renders real gameplay action (not a blank screen)
   - No debug/test buttons
*/

// Injected server-side
const SPEC = __SPEC_JSON__;

/* =========================================================
   DOM refs (must exist in index.template.html)
========================================================= */
const setupOverlay = document.getElementById("setupOverlay");
const startGameBtn  = document.getElementById("startGameBtn");
const liveIdInput   = document.getElementById("liveIdInput");
const statusText    = document.getElementById("statusText");
const statusTextInGame = document.getElementById("statusTextInGame");
const gameRoot      = document.getElementById("gameRoot");
const flagsEl       = document.getElementById("flags");

/* =========================================================
   Small helpers
========================================================= */
function escapeHtml(s){
  return String(s || "")
    .replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;")
    .replaceAll('"',"&quot;").replaceAll("'","&#39;");
}
function showOverlay(){ if (setupOverlay) setupOverlay.style.display = ""; }
function hideOverlay(){ if (setupOverlay) setupOverlay.style.display = "none"; }
function setStatus(msg, ok=true){
  const t = String(msg || "");
  if (statusText){
    statusText.textContent = t;
    statusText.style.color = ok ? "rgba(255,255,255,.9)" : "rgba(255,120,120,.95)";
  }
  if (statusTextInGame){
    statusTextInGame.textContent = t;
    statusTextInGame.style.color = ok ? "rgba(255,255,255,.78)" : "rgba(255,120,120,.95)";
  }
}
function clamp(v,a,b){ v = Number(v)||0; return Math.max(a, Math.min(b, v)); }
function nowMs(){ return Date.now(); }
function rand(a,b){ return a + Math.random()*(b-a); }
function pick(arr){ return arr[Math.floor(Math.random()*arr.length)]; }
function safeText(s, max=70){ return String(s||"").trim().replace(/\s+/g," ").slice(0,max); }
function getUrlFlag(name){
  try { return new URLSearchParams(location.search).get(name); } catch { return null; }
}
function initials(name){
  const s = String(name||"").trim();
  if (!s) return "?";
  const parts = s.split(/\s+/).slice(0,2);
  return parts.map(p=>p[0]).join("").toUpperCase();
}

/* =========================================================
   Flags (right-side pop-outs)
   CSS expects:
   .flag .pfp, .flag .txt .name, .flag .txt .msg
========================================================= */
function flag({ who, msg, pfp, cls }){
  if (!flagsEl) return;

  const wrap = document.createElement("div");
  wrap.className = "flag" + (cls ? " " + String(cls) : "");

  const img = document.createElement("img");
  img.className = "pfp";
  img.alt = "";
  img.decoding = "async";
  img.loading = "lazy";

  const fb = document.createElement("div");
  fb.className = "pfp";
  fb.textContent = initials(who||"");
  fb.style.display = "grid";
  fb.style.placeItems = "center";
  fb.style.fontWeight = "900";
  fb.style.letterSpacing = ".6px";
  fb.style.fontSize = "12px";
  fb.style.textTransform = "uppercase";
  fb.style.color = "rgba(255,255,255,.92)";

  const hasPfp = typeof pfp === "string" && pfp.trim().length > 0;
  if (hasPfp){
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
  text.className = "txt";
  text.innerHTML =
    `<div class="name">${escapeHtml(who||"")}</div>` +
    `<div class="msg">${escapeHtml(msg||"")}</div>`;

  wrap.appendChild(img);
  wrap.appendChild(fb);
  wrap.appendChild(text);

  flagsEl.prepend(wrap);
  while (flagsEl.childElementCount > 6) flagsEl.removeChild(flagsEl.lastChild);

  setTimeout(() => {
    try { wrap.style.opacity = "0"; wrap.style.transform = "translateX(12px)"; } catch {}
    setTimeout(() => wrap.remove(), 240);
  }, 3400);
}

/* =========================================================
   TikTok message helpers (stable / supports multiple shapes)
========================================================= */
function getChatTextFromMessage(msg){
  const m = msg || {};
  const t = m.content ?? m.comment ?? m.text ?? m.message ?? m.msg ?? "";
  return String(t || "").trim();
}
function firstUrl(v){
  if (!v) return "";
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return typeof v[0] === "string" ? v[0] : "";
  return "";
}
function getAvatarUrlFromUser(u){
  if (!u || typeof u !== "object") return "";
  const direct = firstUrl(u.profilePictureUrl || u.profilePicture || u.avatar || u.pfp || u.avatarUrl);
  if (direct) return direct;

  const a1 = u.avatarThumb || u.avatarthumb || null;
  if (a1){
    const list = a1.urlList || a1.urlListList || a1.urllistList || a1.urllist || a1.url_list || a1.url_list_list;
    const pick = firstUrl(list);
    if (pick) return pick;
  }
  const a2 = u.profilePicture && u.profilePicture.urlList ? firstUrl(u.profilePicture.urlList) : "";
  return a2 || "";
}
function getUserFromMessage(msg){
  const m = msg || {};
  const u = m.user || m.userInfo || m.userinfo || m.sender || m.from || {};
  const userId = String(u.userId ?? u.userid ?? u.id ?? m.userId ?? m.userid ?? m.user_id ?? "") || "";
  const uniqueId = String(u.uniqueId ?? u.uniqueid ?? u.username ?? u.handle ?? m.uniqueId ?? m.uniqueid ?? "") || "";
  const nickname = String(u.nickname ?? u.displayName ?? u.name ?? m.nickname ?? "") || uniqueId || "viewer";
  const avatar = getAvatarUrlFromUser(u) || firstUrl(m.profilePictureUrl) || "";
  return { userId, uniqueId, nickname, avatar };
}

/* =========================================================
   Normalizers -> simplified event objects
========================================================= */
function normalizeChat(m){
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
function normalizeLike(m){
  const user = getUserFromMessage(m);
  const count = Number(m.likeCount ?? m.likecount ?? m.count ?? m.totalLikeCount ?? m.totalLikecount ?? 1) || 1;
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
function normalizeGift(m){
  const user = getUserFromMessage(m);
  const giftName = String(m.giftName ?? m.giftname ?? m.gift?.name ?? m.gift?.giftName ?? "Gift");
  const repeat = Number(m.repeatCount ?? m.repeatcount ?? m.repeat ?? m.count ?? 1) || 1;
  const diamond = Number(m.diamondCount ?? m.diamondcount ?? m.diamonds ?? m.gift?.diamondCount ?? 0) || 0;
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
function normalizeJoin(m){
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
   Game state (Epic Space Arena)
========================================================= */
let canvas, g;
let W = 0, H = 0, DPR = 1;
let _lastT = 0;

const state = {
  connected: false,
  pendingStart: false,
  startedAt: 0,

  counters: { chats:0, likes:0, gifts:0, joins:0 },
  score: 0,
  streak: 0,

  // top contributors
  contrib: new Map(), // userId -> {name,pfp,points}

  // effects
  shakeUntil: 0,
  flashUntil: 0,

  // entities
  stars: [],
  bullets: [],
  asteroids: [],
  drones: [],   // chatters spawn drones
  bombs: [],
  pickups: [],

  boss: null,
  bossHP: 0,
  bossMax: 0,
};

function addContrib(userId, nickname, pfp, points){
  if (!userId) return;
  const cur = state.contrib.get(userId) || { name: nickname||"viewer", pfp: pfp||"", points: 0 };
  cur.name = nickname || cur.name;
  cur.pfp = pfp || cur.pfp;
  cur.points += points;
  state.contrib.set(userId, cur);
}

function topContrib(n=5){
  const arr = Array.from(state.contrib.entries()).map(([id,v]) => ({ id, ...v }));
  arr.sort((a,b)=>b.points - a.points);
  return arr.slice(0,n);
}

/* =========================================================
   Rendering base + resize
========================================================= */
function clearRoot(){
  while (gameRoot && gameRoot.firstChild) gameRoot.removeChild(gameRoot.firstChild);
}

function renderBase(){
  clearRoot();
  if (!gameRoot) return;

  const wrap = document.createElement("div");
  wrap.style.position = "relative";
  wrap.style.width = "100%";
  wrap.style.height = "100%";
  wrap.style.overflow = "hidden";

  canvas = document.createElement("canvas");
  canvas.style.width = "100%";
  canvas.style.height = "100%";
  canvas.style.display = "block";
  wrap.appendChild(canvas);

  // HUD (tiny, non-blocking)
  const hud = document.createElement("div");
  hud.id = "hud";
  hud.style.position = "absolute";
  hud.style.left = "10px";
  hud.style.top = "10px";
  hud.style.pointerEvents = "none";
  hud.style.display = "flex";
  hud.style.flexDirection = "column";
  hud.style.gap = "8px";

  const row1 = document.createElement("div");
  row1.style.display = "flex";
  row1.style.gap = "8px";
  row1.appendChild(pill("SCORE", "hudScore", "0"));
  row1.appendChild(pill("STREAK", "hudStreak", "0"));
  row1.appendChild(pill("LIKES", "hudLikes", "0"));
  row1.appendChild(pill("GIFTS", "hudGifts", "0"));
  hud.appendChild(row1);

  const row2 = document.createElement("div");
  row2.id = "hudTop";
  row2.style.display = "flex";
  row2.style.flexDirection = "column";
  row2.style.gap = "6px";
  hud.appendChild(row2);

  wrap.appendChild(hud);
  gameRoot.appendChild(wrap);

  try { g = canvas.getContext("2d", { alpha:true, desynchronized:true }); }
  catch { g = canvas.getContext("2d"); }

  resizeCanvas();
}

function pill(label, id, value){
  const p = document.createElement("div");
  p.style.display = "flex";
  p.style.alignItems = "center";
  p.style.gap = "6px";
  p.style.padding = "6px 10px";
  p.style.borderRadius = "999px";
  p.style.background = "rgba(0,0,0,.28)";
  p.style.border = "1px solid rgba(255,255,255,.10)";
  p.style.backdropFilter = "blur(6px)";

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

  p.appendChild(a);
  p.appendChild(b);
  return p;
}

function resizeCanvas(){
  if (!canvas) return;
  const r = canvas.getBoundingClientRect();
  DPR = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
  W = Math.max(1, Math.floor(r.width * DPR));
  H = Math.max(1, Math.floor(r.height * DPR));
  if (canvas.width !== W || canvas.height !== H){
    canvas.width = W;
    canvas.height = H;
  }
}

window.addEventListener("resize", () => resizeCanvas(), { passive:true });

/* =========================================================
   Space Arena: spawn + update
========================================================= */
function ensureStars(){
  if (state.stars.length > 0) return;
  const count = 90;
  for (let i=0;i<count;i++){
    state.stars.push({
      x: Math.random(), y: Math.random(),
      z: rand(0.2, 1.0),
      tw: rand(0, Math.PI*2),
    });
  }
}

function spawnAsteroid(power=1){
  const side = Math.floor(Math.random()*4);
  const pad = 40;
  let x, y, vx, vy;
  if (side===0){ x = -pad; y = rand(0,H); vx = rand(40,110); vy = rand(-60,60); }
  if (side===1){ x = W+pad; y = rand(0,H); vx = -rand(40,110); vy = rand(-60,60); }
  if (side===2){ x = rand(0,W); y = -pad; vx = rand(-60,60); vy = rand(40,110); }
  if (side===3){ x = rand(0,W); y = H+pad; vx = rand(-60,60); vy = -rand(40,110); }

  const r = clamp(rand(18, 40) * (0.9 + power*0.15), 16, 72);
  const hp = Math.ceil((r/18) * (1 + power*0.2));
  state.asteroids.push({ x, y, vx, vy, r, hp, rot: rand(0,Math.PI*2), rv: rand(-1.2,1.2) });
}

function spawnDrone(nickname, pfp){
  // Drones orbit center and shoot asteroids automatically
  const a = rand(0, Math.PI*2);
  const d = rand(90, 180);
  const x = W*0.5 + Math.cos(a)*d;
  const y = H*0.55 + Math.sin(a)*d;
  state.drones.push({
    x,y, vx:0,vy:0, a, d,
    name: nickname||"viewer",
    pfp: pfp||"",
    cool: rand(0.1, 0.4),
    hp: 3,
    hue: rand(0,360),
    flash: 0,
  });
  if (state.drones.length > 18) state.drones.shift();
}

function spawnBullet(x,y,vx,vy, dmg=1){
  state.bullets.push({ x,y,vx,vy, r: 3*DPR, dmg, life: 1.8 });
}

function spawnBomb(x,y, radius, power){
  state.bombs.push({ x,y, t:0, radius, power });
}

function spawnPickup(x,y,type){
  state.pickups.push({ x,y, type, t:0, vy: -40 });
}

function maybeSpawnBoss(){
  if (state.boss) return;
  // Boss appears after enough score
  if (state.score < 75) return;

  state.bossMax = 120;
  state.bossHP = state.bossMax;
  state.boss = {
    x: W*0.5,
    y: H*0.22,
    vx: 0,
    phase: 0,
    t: 0,
  };
  state.flashUntil = nowMs() + 280;
  flag({ who: "BOSS", msg: "A TITAN ENTERS THE ARENA!", pfp: "", cls: "yellow" });
}

function hitShake(ms=160){
  state.shakeUntil = Math.max(state.shakeUntil, nowMs() + ms);
  state.flashUntil = Math.max(state.flashUntil, nowMs() + 120);
}

function update(dt){
  ensureStars();

  // drift stars
  for (const s of state.stars){
    s.tw += dt*(0.6 + s.z*0.8);
  }

  // auto-spawn asteroids
  const target = 7 + Math.floor(state.score/30);
  while (state.asteroids.length < target) spawnAsteroid(1 + state.score/90);

  // boss
  maybeSpawnBoss();
  if (state.boss){
    const b = state.boss;
    b.t += dt;
    b.phase += dt*0.6;
    const sway = Math.sin(b.phase)*0.8;
    b.x = W*0.5 + sway * (W*0.22);
    b.y = H*0.2 + Math.sin(b.phase*0.8)* (H*0.03);

    // boss fires occasionally
    if (b.t > 0.35){
      b.t = 0;
      // fire 2-3 “shards”
      const n = 2 + (Math.random()<0.35 ? 1 : 0);
      for (let i=0;i<n;i++){
        const ang = rand(Math.PI*0.55, Math.PI*0.80) + rand(-0.22,0.22);
        const sp = rand(150, 220) * DPR;
        spawnBullet(b.x, b.y, Math.cos(ang)*sp, Math.sin(ang)*sp, 0); // dmg 0 = enemy bullet
      }
    }
  }

  // drones orbit and shoot
  for (const d of state.drones){
    d.a += dt * 0.55;
    const tx = W*0.5 + Math.cos(d.a)*d.d;
    const ty = H*0.56 + Math.sin(d.a)*d.d;
    d.x += (tx - d.x) * dt * 2.2;
    d.y += (ty - d.y) * dt * 2.2;

    d.cool -= dt;
    if (d.cool <= 0){
      d.cool = rand(0.18, 0.42);
      // target nearest asteroid
      let best = null;
      let bestD = 1e9;
      for (const a of state.asteroids){
        const dx = a.x - d.x, dy = a.y - d.y;
        const dd = dx*dx + dy*dy;
        if (dd < bestD){ bestD = dd; best = a; }
      }
      if (best){
        const dx = best.x - d.x, dy = best.y - d.y;
        const L = Math.max(1, Math.hypot(dx,dy));
        const sp = 360 * DPR;
        spawnBullet(d.x, d.y, (dx/L)*sp, (dy/L)*sp, 1);
      }
    }

    if (d.flash > 0) d.flash -= dt;
  }

  // asteroids move
  for (const a of state.asteroids){
    a.x += a.vx*dt*DPR;
    a.y += a.vy*dt*DPR;
    a.rot += a.rv*dt;
    // wrap a bit
    if (a.x < -120) a.x = W+120;
    if (a.x > W+120) a.x = -120;
    if (a.y < -120) a.y = H+120;
    if (a.y > H+120) a.y = -120;
  }

  // bullets move
  for (const b of state.bullets){
    b.x += b.vx*dt;
    b.y += b.vy*dt;
    b.life -= dt;
  }
  state.bullets = state.bullets.filter(b => b.life > 0 && b.x>-120 && b.x<W+120 && b.y>-120 && b.y<H+120);

  // bombs expand
  for (const b of state.bombs){
    b.t += dt;
  }
  state.bombs = state.bombs.filter(b => b.t < 0.45);

  // pickups
  for (const p of state.pickups){
    p.t += dt;
    p.y += p.vy*dt*DPR;
    p.vy += 20*dt*DPR;
  }
  state.pickups = state.pickups.filter(p => p.t < 3.6);

  // collisions: bullets vs asteroids / boss / enemy bullets
  handleCollisions();

  // update HUD
  const hs = document.getElementById("hudScore");
  const ht = document.getElementById("hudStreak");
  const hl = document.getElementById("hudLikes");
  const hg = document.getElementById("hudGifts");
  if (hs) hs.textContent = String(state.score);
  if (ht) ht.textContent = String(state.streak);
  if (hl) hl.textContent = String(state.counters.likes);
  if (hg) hg.textContent = String(state.counters.gifts);

  renderTopContrib();
}

function handleCollisions(){
  // bombs damage asteroids + boss
  if (state.bombs.length){
    for (const bomb of state.bombs){
      const r = bomb.radius * (bomb.t / 0.45);
      const rr = r*r;
      for (const a of state.asteroids){
        const dx = a.x - bomb.x, dy = a.y - bomb.y;
        if (dx*dx + dy*dy <= rr){
          a.hp -= bomb.power;
        }
      }
      if (state.boss){
        const b = state.boss;
        const dx = b.x - bomb.x, dy = b.y - bomb.y;
        if (dx*dx + dy*dy <= rr){
          state.bossHP -= bomb.power * 2;
        }
      }
    }
  }

  // bullets: dmg>0 are player bullets, dmg==0 are enemy shards
  for (const b of state.bullets){
    if (b.dmg > 0){
      // hit asteroids
      for (const a of state.asteroids){
        const dx = a.x - b.x, dy = a.y - b.y;
        if (dx*dx + dy*dy <= (a.r + 8*DPR)*(a.r + 8*DPR)){
          a.hp -= b.dmg;
          b.life = -1;
          hitShake(90);
          break;
        }
      }
      // hit boss
      if (b.life > 0 && state.boss){
        const bossR = 54*DPR;
        const dx = state.boss.x - b.x, dy = state.boss.y - b.y;
        if (dx*dx + dy*dy <= bossR*bossR){
          state.bossHP -= 1;
          b.life = -1;
          hitShake(120);
        }
      }
    } else {
      // enemy shard hits drones
      for (const d of state.drones){
        const dx = d.x - b.x, dy = d.y - b.y;
        if (dx*dx + dy*dy <= (18*DPR)*(18*DPR)){
          d.hp -= 1;
          d.flash = 0.16;
          b.life = -1;
          hitShake(110);
          break;
        }
      }
    }
  }

  // remove dead asteroids -> score + pickups
  const before = state.asteroids.length;
  state.asteroids = state.asteroids.filter(a => a.hp > 0);
  const killed = before - state.asteroids.length;
  if (killed > 0){
    state.score += killed * 2;
    state.streak += killed;
    if (state.streak % 6 === 0){
      spawnPickup(rand(W*0.25, W*0.75), rand(H*0.35, H*0.65), "charge");
    }
  }

  // drones dying
  const dBefore = state.drones.length;
  state.drones = state.drones.filter(d => d.hp > 0);
  if (dBefore !== state.drones.length){
    state.streak = Math.max(0, state.streak - 2);
  }

  // boss defeated
  if (state.boss && state.bossHP <= 0){
    state.score += 80;
    state.boss = null;
    state.bossHP = 0;
    state.flashUntil = nowMs() + 280;
    flag({ who: "BOSS", msg: "TITAN DEFEATED! +80", pfp:"", cls:"green" });
    // victory bomb
    spawnBomb(W*0.5, H*0.42, 260*DPR, 6);
  }
}

function renderTopContrib(){
  const wrap = document.getElementById("hudTop");
  if (!wrap) return;
  wrap.innerHTML = "";

  const top = topContrib(4);
  if (!top.length) return;

  const title = document.createElement("div");
  title.style.fontSize = "11px";
  title.style.fontWeight = "900";
  title.style.color = "rgba(255,255,255,.70)";
  title.style.letterSpacing = ".4px";
  title.textContent = "TOP PILOTS";
  wrap.appendChild(title);

  for (const t of top){
    const row = document.createElement("div");
    row.style.display = "flex";
    row.style.alignItems = "center";
    row.style.gap = "8px";
    row.style.padding = "6px 10px";
    row.style.borderRadius = "14px";
    row.style.background = "rgba(0,0,0,.24)";
    row.style.border = "1px solid rgba(255,255,255,.08)";
    row.style.backdropFilter = "blur(6px)";

    const pic = document.createElement("div");
    pic.style.width = "26px";
    pic.style.height = "26px";
    pic.style.borderRadius = "10px";
    pic.style.overflow = "hidden";
    pic.style.border = "1px solid rgba(255,255,255,.14)";
    pic.style.background = "rgba(255,255,255,.08)";
    if (t.pfp){
      const im = document.createElement("img");
      im.src = t.pfp;
      im.alt = "";
      im.loading = "lazy";
      im.decoding = "async";
      im.style.width = "100%";
      im.style.height = "100%";
      im.style.objectFit = "cover";
      pic.appendChild(im);
    } else {
      pic.style.display = "grid";
      pic.style.placeItems = "center";
      pic.style.fontWeight = "900";
      pic.style.fontSize = "11px";
      pic.textContent = initials(t.name);
    }

    const name = document.createElement("div");
    name.style.flex = "1";
    name.style.minWidth = "0";
    name.style.fontWeight = "900";
    name.style.fontSize = "12px";
    name.style.whiteSpace = "nowrap";
    name.style.overflow = "hidden";
    name.style.textOverflow = "ellipsis";
    name.textContent = t.name;

    const pts = document.createElement("div");
    pts.style.fontWeight = "900";
    pts.style.fontSize = "12px";
    pts.style.color = "rgba(255,255,255,.86)";
    pts.textContent = String(t.points);

    row.appendChild(pic);
    row.appendChild(name);
    row.appendChild(pts);
    wrap.appendChild(row);
  }
}

/* =========================================================
   Draw
========================================================= */
function roundRect(ctx,x,y,w,h,r){
  r = Math.min(r, w*0.5, h*0.5);
  ctx.beginPath();
  ctx.moveTo(x+r,y);
  ctx.arcTo(x+w,y,x+w,y+h,r);
  ctx.arcTo(x+w,y+h,x,y+h,r);
  ctx.arcTo(x,y+h,x,y,r);
  ctx.arcTo(x,y,x+w,y,r);
  ctx.closePath();
}

function draw(){
  if (!g || !canvas) return;

  // camera shake
  let sx = 0, sy = 0;
  if (nowMs() < state.shakeUntil){
    sx = rand(-4,4) * DPR;
    sy = rand(-3,3) * DPR;
  }

  g.save();
  g.translate(sx, sy);

  // background
  g.clearRect(0,0,W,H);
  const bg = g.createRadialGradient(W*0.5,H*0.45, 20, W*0.5,H*0.45, Math.max(W,H));
  bg.addColorStop(0, "rgba(255,255,255,.03)");
  bg.addColorStop(1, "rgba(0,0,0,.92)");
  g.fillStyle = bg;
  g.fillRect(0,0,W,H);

  // stars
  for (const s of state.stars){
    const x = s.x * W;
    const y = s.y * H;
    const tw = 0.35 + 0.65*Math.abs(Math.sin(s.tw));
    g.globalAlpha = 0.12 + s.z*0.35*tw;
    g.fillStyle = "white";
    g.fillRect(x, y, (1+s.z)*DPR, (1+s.z)*DPR);
  }
  g.globalAlpha = 1;

  // bombs (shockwaves)
  for (const b of state.bombs){
    const t = clamp(b.t/0.45, 0, 1);
    const r = b.radius * t;
    g.globalAlpha = 0.20 * (1-t);
    g.strokeStyle = "rgba(255,255,255,.9)";
    g.lineWidth = 3*DPR;
    g.beginPath();
    g.arc(b.x,b.y,r,0,Math.PI*2);
    g.stroke();

    g.globalAlpha = 0.14 * (1-t);
    g.strokeStyle = "rgba(255,200,120,.9)";
    g.lineWidth = 8*DPR;
    g.beginPath();
    g.arc(b.x,b.y,r*0.86,0,Math.PI*2);
    g.stroke();
    g.globalAlpha = 1;
  }

  // asteroids
  for (const a of state.asteroids){
    g.save();
    g.translate(a.x,a.y);
    g.rotate(a.rot);
    g.globalAlpha = 0.92;

    g.fillStyle = "rgba(255,255,255,.07)";
    g.strokeStyle = "rgba(255,255,255,.18)";
    g.lineWidth = 2*DPR;

    roundRect(g, -a.r, -a.r, a.r*2, a.r*2, 10*DPR);
    g.fill();
    g.stroke();

    // cracks
    g.globalAlpha = 0.35;
    g.beginPath();
    g.moveTo(-a.r*0.6, -a.r*0.1);
    g.lineTo(a.r*0.2, a.r*0.6);
    g.lineTo(a.r*0.6, a.r*0.1);
    g.strokeStyle = "rgba(255,170,90,.18)";
    g.stroke();

    g.restore();
  }
  g.globalAlpha = 1;

  // boss
  if (state.boss){
    const b = state.boss;
    const R = 56*DPR;
    g.save();
    g.translate(b.x,b.y);

    const grad = g.createRadialGradient(0,0, 10*DPR, 0,0, R*1.3);
    grad.addColorStop(0, "rgba(255,230,180,.22)");
    grad.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = grad;
    g.beginPath();
    g.arc(0,0,R*1.3,0,Math.PI*2);
    g.fill();

    g.fillStyle = "rgba(255,255,255,.10)";
    g.strokeStyle = "rgba(255,255,255,.22)";
    g.lineWidth = 2*DPR;
    roundRect(g, -R, -R*0.72, R*2, R*1.44, 18*DPR);
    g.fill(); g.stroke();

    // boss eye
    g.globalAlpha = 0.85;
    g.fillStyle = "rgba(255,140,80,.9)";
    g.beginPath();
    g.arc(0,0, 10*DPR, 0, Math.PI*2);
    g.fill();
    g.globalAlpha = 1;

    // HP bar
    const bw = 160*DPR, bh = 14*DPR;
    const x = -bw*0.5, y = R*0.95;
    g.globalAlpha = 0.9;
    g.fillStyle = "rgba(0,0,0,.35)";
    roundRect(g, x, y, bw, bh, 8*DPR); g.fill();
    g.fillStyle = "rgba(255,140,80,.95)";
    const r = clamp(state.bossHP / state.bossMax, 0, 1);
    roundRect(g, x, y, bw*r, bh, 8*DPR); g.fill();
    g.globalAlpha = 1;

    g.restore();
  }

  // drones
  for (const d of state.drones){
    g.save();
    g.translate(d.x, d.y);

    const glow = g.createRadialGradient(0,0, 2*DPR, 0,0, 28*DPR);
    glow.addColorStop(0, `hsla(${d.hue},90%,65%,.22)`);
    glow.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = glow;
    g.beginPath();
    g.arc(0,0, 28*DPR, 0, Math.PI*2);
    g.fill();

    g.globalAlpha = 0.95;
    g.fillStyle = d.flash > 0 ? "rgba(255,140,120,.16)" : "rgba(255,255,255,.10)";
    g.strokeStyle = "rgba(255,255,255,.18)";
    g.lineWidth = 2*DPR;
    roundRect(g, -14*DPR, -10*DPR, 28*DPR, 20*DPR, 8*DPR);
    g.fill(); g.stroke();

    // tiny cockpit
    g.globalAlpha = 0.8;
    g.fillStyle = "rgba(255,255,255,.22)";
    g.beginPath(); g.arc(0,0, 4*DPR, 0, Math.PI*2); g.fill();
    g.globalAlpha = 1;

    g.restore();
  }

  // bullets
  for (const b of state.bullets){
    g.globalAlpha = 0.9;
    g.fillStyle = b.dmg > 0 ? "rgba(255,255,255,.82)" : "rgba(255,150,90,.85)";
    g.beginPath();
    g.arc(b.x,b.y, (b.dmg>0?3:4)*DPR, 0, Math.PI*2);
    g.fill();
  }
  g.globalAlpha = 1;

  // pickups
  for (const p of state.pickups){
    g.save();
    g.translate(p.x,p.y);
    const t = clamp(p.t/3.6,0,1);
    g.globalAlpha = 0.9*(1-t);
    g.fillStyle = "rgba(120,255,210,.20)";
    g.strokeStyle = "rgba(120,255,210,.55)";
    g.lineWidth = 2*DPR;
    roundRect(g, -14*DPR, -14*DPR, 28*DPR, 28*DPR, 10*DPR);
    g.fill(); g.stroke();
    g.globalAlpha = 1;
    g.restore();
  }

  // flash overlay (small)
  if (nowMs() < state.flashUntil){
    const t = (state.flashUntil - nowMs()) / 200;
    g.globalAlpha = 0.12 * clamp(t,0,1);
    g.fillStyle = "white";
    g.fillRect(0,0,W,H);
    g.globalAlpha = 1;
  }

  g.restore();
}

/* =========================================================
   Event router (built-in reactions + AI hooks)
========================================================= */
function routeEvent(type, data){
  try{
    if (type === "chat"){
      state.counters.chats++;
      // chat fires a “burst” and spawns a drone if needed
      const text = safeText(data.text, 80);
      flag({ who: data.nickname || data.uniqueId || "viewer", msg: text || "chat", pfp: data.pfp, cls: "blue" });

      addContrib(data.userId, data.nickname, data.pfp, 2);
      if (Math.random() < 0.35 || state.drones.length < 4){
        spawnDrone(data.nickname, data.pfp);
      }
      // quick burst from center
      const cx = W*0.5, cy = H*0.62;
      for (let i=0;i<2;i++){
        const ang = rand(-Math.PI*0.15, -Math.PI*0.85);
        const sp  = rand(260, 360)*DPR;
        spawnBullet(cx, cy, Math.cos(ang)*sp, Math.sin(ang)*sp, 1);
      }
      state.score += 1;

      try { aiOnChat(ctxPublic(), data); } catch {}
    }
    else if (type === "like"){
      const inc = Number(data.count || 1) || 1;
      state.counters.likes += inc;
      addContrib(data.userId, data.nickname, data.pfp, Math.max(1, Math.floor(inc/3)));

      // likes create “shock pulses” every ~10 likes
      if (inc >= 10 || Math.random() < clamp(inc/40, 0.08, 0.6)){
        spawnBomb(rand(W*0.25,W*0.75), rand(H*0.35,H*0.75), 180*DPR, 2);
        hitShake(140);
      }

      try { aiOnLike(ctxPublic(), data); } catch {}
    }
    else if (type === "gift"){
      state.counters.gifts += 1;
      const diamonds = Number(data.diamond || 0) || 0;
      const rep = Number(data.repeat || 1) || 1;
      const power = clamp((diamonds/10) + rep*0.25, 1, 12);

      flag({
        who: data.nickname || "viewer",
        msg: `🎁 ${safeText(data.giftName, 22)} x${rep}`,
        pfp: data.pfp,
        cls: "red"
      });

      addContrib(data.userId, data.nickname, data.pfp, Math.ceil(power*3));

      // gifts drop big bomb at center; larger gift = bigger radius/power
      spawnBomb(W*0.5, H*0.52, (140 + power*18)*DPR, Math.ceil(2 + power/2));
      hitShake(220);

      // a few bonus bullets upward
      for (let i=0;i<3;i++){
        const ang = rand(-Math.PI*0.40, -Math.PI*0.60) + rand(-0.20,0.20);
        const sp = rand(320, 420)*DPR;
        spawnBullet(W*0.5, H*0.62, Math.cos(ang)*sp, Math.sin(ang)*sp, 2);
      }

      state.score += Math.ceil(power);

      try { aiOnGift(ctxPublic(), data); } catch {}
    }
    else if (type === "join"){
      state.counters.joins++;
      flag({ who: data.nickname || "viewer", msg: "joined the arena", pfp: data.pfp, cls:"green" });
      addContrib(data.userId, data.nickname, data.pfp, 1);
      spawnDrone(data.nickname, data.pfp);
      state.score += 1;

      try { aiOnJoin(ctxPublic(), data); } catch {}
    }
  } catch (e){
    console.error("routeEvent error:", e);
  }
}

// Public ctx passed into AI region
function ctxPublic(){
  return {
    spec: SPEC,
    state,
    flag,
    spawnAsteroid,
    spawnDrone,
    spawnBullet,
    spawnBomb,
    spawnPickup,
    hitShake,
    setStatus,
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
function aiOnJoin(ctx, join) {
  // Filled by API
}
// === AI_REGION_END ===

/* =========================================================
   TikTok connection (matches your working example pattern)
========================================================= */
let client = null;

function setupTikTokClient(liveId){
  if (!liveId) throw new Error("liveId is required");

  if (client && client.socket){
    try { client.socket.close(); }
    catch (e){ console.warn("Error closing previous socket:", e); }
  }

  if (typeof TikTokClient === "undefined"){
    throw new Error("TikTokClient is not available. Check tiktok-client.js.");
  }

  client = new TikTokClient(liveId);

  // ChatTok injects CHATTOK_CREATOR_TOKEN globally.
  const token =
    (typeof CHATTOK_CREATOR_TOKEN !== "undefined" ? CHATTOK_CREATOR_TOKEN : (window && window.CHATTOK_CREATOR_TOKEN)) || "";
  if (token && String(token).trim()){
    client.setAccessToken(String(token).trim());
  }

  client.on("connected", () => {
    state.connected = true;
    setStatus("Connected to TikTok LIVE.", true);
    flag({ who:"SYSTEM", msg:"Connected — going live!", pfp:"" });
    hideOverlay();
    state.pendingStart = false;
  });

  client.on("disconnected", (reason) => {
    state.connected = false;
    const msg = reason || "Connection closed";
    setStatus("Disconnected: " + msg, false);
    showOverlay();
  });

  client.on("error", (err) => {
    console.error("TikTok client error:", err);
    setStatus("Error: " + (err && err.message ? err.message : "Unknown"), false);
  });

  client.on("chat", (m) => routeEvent("chat", normalizeChat(m)));
  client.on("gift", (m) => routeEvent("gift", normalizeGift(m)));
  client.on("like", (m) => routeEvent("like", normalizeLike(m)));
  client.on("join", (m) => routeEvent("join", normalizeJoin(m)));

  client.connect();
}

/* =========================================================
   Main loop
========================================================= */
function loop(ts){
  if (!canvas || !g) return;
  if (!_lastT) _lastT = ts;
  const dt = clamp((ts - _lastT)/1000, 0, 0.033);
  _lastT = ts;

  resizeCanvas();
  update(dt);
  draw();

  requestAnimationFrame(loop);
}

/* =========================================================
   Boot
========================================================= */
function start(){
  setStatus("Enter your LIVE ID, then press Start.", true);
  renderBase();
  ensureStars();

  // Let AI add extra visuals/logic safely after base is built
  try { aiInit(ctxPublic()); } catch (e) { console.warn(e); }

  requestAnimationFrame(loop);

  if (startGameBtn){
    startGameBtn.addEventListener("click", () => {
      try{
        const id = String(liveIdInput ? liveIdInput.value : "").trim();
        if (!id) throw new Error("Enter your TikTok LIVE ID.");
        state.pendingStart = true;
        setStatus("Connecting…", true);

        setupTikTokClient(id);
        // overlay hides on "connected"
      } catch (e){
        console.error(e);
        state.pendingStart = false;
        setStatus(e && e.message ? e.message : String(e), false);
        showOverlay();
      }
    });
  }
}

if (document.readyState === "loading"){
  document.addEventListener("DOMContentLoaded", start);
} else {
  start();
}
