/* =========================================================
   game.template.js — ChatTok Gaming “Epic First Shot” Template
   - Production-ready, works even WITHOUT TikTok connected (demo mode).
   - Uses platform-injected TikTokClient + proto (DO NOT load them here).
   - Robust for iframe/srcdoc preview runners.
   - Provides flexible host settings for chat commands + optional shares mapping.

   IMPORTANT NON-NEGOTIABLES:
   - DO NOT change tiktok-client.js (platform provides it).
   - DO NOT load proto.bundle.js here. HTML checks injection; we fail gracefully.
   - Keep costs low: the template is already a complete game.
========================================================= */

(() => {
  "use strict";

  // ===============================
  // 0) DOM refs / UI wiring
  // ===============================
  const setupOverlay = document.getElementById("setupOverlay");
  const gameScreen = document.getElementById("gameScreen");
  const startGameBtn = document.getElementById("startGameBtn");
  const liveIdInput = document.getElementById("liveIdInput");
  const statusText = document.getElementById("statusText");
  const statusTextInGame = document.getElementById("statusTextInGame");
  const statusTextFooter = document.getElementById("statusTextFooter");
  const flagsEl = document.getElementById("flags");
  const setupFields = document.getElementById("setupFields");

  function setStatus(msg) {
    if (statusText) statusText.textContent = msg || "";
    if (statusTextInGame) statusTextInGame.textContent = msg || "";
    if (statusTextFooter) statusTextFooter.textContent = msg || "";
  }

  function showOverlay(show) {
    if (!setupOverlay) return;
    setupOverlay.style.display = show ? "flex" : "none";
  }

  // ===============================
  // 1) Helpers: safe parsing & UI
  // ===============================
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

  function safeStr(v) {
    if (v === null || v === undefined) return "";
    return String(v);
  }

  function normText(s) {
    return safeStr(s).trim();
  }

  function normLower(s) {
    return normText(s).toLowerCase();
  }

  function escapeHtml(s) {
    return safeStr(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  // Small WebAudio blip (copyright-safe)
  let audioCtx = null;
  function beep(freq = 880, ms = 80, gain = 0.03) {
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const t0 = audioCtx.currentTime;
      const osc = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      osc.type = "triangle";
      osc.frequency.setValueAtTime(freq, t0);
      g.gain.setValueAtTime(gain, t0);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + ms / 1000);
      osc.connect(g);
      g.connect(audioCtx.destination);
      osc.start(t0);
      osc.stop(t0 + ms / 1000);
    } catch { /* ignore */ }
  }

  // Notifications: use flags if present, otherwise fallback to console/status
  function notify(type, user, message, opts = {}) {
    try {
      const mode = getSetting("notifMode", "auto"); // auto | flags | toast | off
      if (mode === "off") return;

      const u = user || {};
      const name = normText(u.nickname || u.uniqueId || u.userId || "Viewer");
      const pfp = normText(u.profilePictureUrl || u.avatar || u.pfp || "");

      if (!flagsEl || (mode !== "auto" && mode !== "flags")) {
        // Minimal fallback
        // (We intentionally avoid noisy dev logs in production gameplay)
        return;
      }

      const flag = document.createElement("div");
      flag.className = "flag";

      const p = document.createElement(pfp ? "img" : "div");
      p.className = "pfp";
      if (pfp) {
        p.src = pfp;
        p.alt = name;
        p.loading = "lazy";
        p.referrerPolicy = "no-referrer";
      }

      const text = document.createElement("div");
      text.className = "flagText";
      const who = document.createElement("div");
      who.className = "who";
      who.textContent = name;
      const msg = document.createElement("div");
      msg.className = "msg";
      msg.textContent = normText(message);

      text.appendChild(who);
      text.appendChild(msg);

      flag.appendChild(p);
      flag.appendChild(text);

      // Optional color accents by type (subtle; not required)
      if (type === "gift") {
        flag.style.borderColor = "rgba(255,0,80,.28)";
      } else if (type === "like") {
        flag.style.borderColor = "rgba(0,242,234,.28)";
      } else if (type === "join") {
        flag.style.borderColor = "rgba(255,255,255,.18)";
      }

      flagsEl.prepend(flag);

      // cap stack
      const max = clamp(parseInt(getSetting("notifMax", "5"), 10) || 5, 1, 8);
      while (flagsEl.children.length > max) flagsEl.removeChild(flagsEl.lastChild);

      const life = clamp(parseInt(getSetting("notifLifeMs", "2400"), 10) || 2400, 900, 6000);
      setTimeout(() => {
        try { flag.remove(); } catch { /* ignore */ }
      }, life);
    } catch { /* ignore */ }
  }

  // ===============================
  // 2) Host settings UI (inject if missing)
  // ===============================
  const injectedSettings = [
    {
      id: "joinCommand",
      label: "Join command (chat)",
      type: "text",
      def: "join",
      help: "Viewers type this to join the game.",
    },
    {
      id: "actionCommand",
      label: "Action command (chat)",
      type: "text",
      def: "pulse",
      help: "Viewers type this to trigger the main action (attack/ability).",
    },
    {
      id: "allowShareForJoin",
      label: "Allow shares to count as JOIN",
      type: "select",
      def: "yes",
      options: [
        ["yes", "Yes (shares count as join)"],
        ["no", "No (chat only)"],
      ],
      help: "Some viewers can’t be seen chatting; shares can also count as join.",
    },
    {
      id: "allowShareForAction",
      label: "Allow shares to count as ACTION",
      type: "select",
      def: "no",
      options: [
        ["no", "No"],
        ["yes", "Yes (shares trigger action)"],
      ],
      help: "Optional: shares can trigger the same action as the chat command.",
    },
    {
      id: "winGoal",
      label: "Win goal (points)",
      type: "number",
      def: "25",
      help: "First player to reach this score wins the round.",
      min: 5,
      max: 500,
      step: 1,
    },
    {
      id: "roundSeconds",
      label: "Round time (seconds)",
      type: "number",
      def: "90",
      help: "If time runs out, the top score wins the round.",
      min: 20,
      max: 600,
      step: 5,
    },
    {
      id: "demoMode",
      label: "Demo mode (offline animation)",
      type: "select",
      def: "yes",
      options: [
        ["yes", "Yes (run demo bots if not connected)"],
        ["no", "No (TikTok only)"],
      ],
      help: "Ensures the game is never a blank screen during testing.",
    },
    {
      id: "notifMode",
      label: "Notifications",
      type: "select",
      def: "auto",
      options: [
        ["auto", "Auto (use flags if available)"],
        ["flags", "Flags (right pop-outs)"],
        ["off", "Off"],
      ],
      help: "Only used if the game chooses to show notifications.",
    },
  ];

  function makeFieldHTML(s) {
    const id = escapeHtml(s.id);
    const label = escapeHtml(s.label);
    const help = escapeHtml(s.help || "");
    const def = escapeHtml(s.def || "");

    if (s.type === "select") {
      const opts = (s.options || [])
        .map(([v, t]) => `<option value="${escapeHtml(v)}"${v === s.def ? " selected" : ""}>${escapeHtml(t)}</option>`)
        .join("");
      return `
        <label class="field field-span">
          <span class="field-label">${label}</span>
          <select id="${id}">
            ${opts}
          </select>
          ${help ? `<span class="mini">${help}</span>` : ""}
        </label>
      `;
    }

    if (s.type === "number") {
      const min = s.min !== undefined ? ` min="${s.min}"` : "";
      const max = s.max !== undefined ? ` max="${s.max}"` : "";
      const step = s.step !== undefined ? ` step="${s.step}"` : "";
      return `
        <label class="field field-span">
          <span class="field-label">${label}</span>
          <input id="${id}" type="number" value="${def}"${min}${max}${step} />
          ${help ? `<span class="mini">${help}</span>` : ""}
        </label>
      `;
    }

    // text
    return `
      <label class="field field-span">
        <span class="field-label">${label}</span>
        <input id="${id}" type="text" value="${def}" />
        ${help ? `<span class="mini">${help}</span>` : ""}
      </label>
    `;
  }

  function ensureSettingsUI() {
    try {
      if (!setupFields) return;
      for (const s of injectedSettings) {
        if (document.getElementById(s.id)) continue; // already injected by server
        const wrap = document.createElement("div");
        wrap.innerHTML = makeFieldHTML(s).trim();
        // Insert after LIVE ID field (first field-span) so it stays near top
        setupFields.appendChild(wrap.firstElementChild);
      }
    } catch { /* ignore */ }
  }

  function getSetting(id, fallback) {
    const el = document.getElementById(id);
    if (!el) return fallback;
    const tag = (el.tagName || "").toLowerCase();
    if (tag === "select") return safeStr(el.value || fallback);
    if (tag === "input") return safeStr(el.value || fallback);
    return fallback;
  }

  ensureSettingsUI();

  // ===============================
  // 3) Game: “Pulse Arena” — fun by default
  // ===============================
  const root = document.getElementById("gameRoot");

  // canvas game layer
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { alpha: true });

  // HUD layer (simple DOM)
  const hud = document.createElement("div");
  hud.className = "card";
  hud.innerHTML = `
    <h3>Pulse Arena</h3>
    <div class="bigText" id="hudHeadline">Get ready…</div>
    <div class="meterGrid">
      <div class="card" style="padding:10px;">
        <h3 style="margin-bottom:6px;">Likes charge</h3>
        <div class="meter"><div id="likeFill"></div></div>
        <div class="mini" id="likeText" style="margin-top:6px;">0%</div>
      </div>
      <div class="card" style="padding:10px;">
        <h3 style="margin-bottom:6px;">Top players</h3>
        <div class="mini" id="scoreList" style="font-family:var(--mono);line-height:1.35;">—</div>
      </div>
    </div>
    <div class="mini" id="hudHowTo" style="margin-top:10px;">
      Type <b id="hudJoinCmd">join</b> to enter. Type <b id="hudActionCmd">pulse</b> to fire a pulse.
    </div>
  `;

  const roundCard = document.createElement("div");
  roundCard.className = "card";
  roundCard.style.display = "none";
  roundCard.innerHTML = `
    <h3>Round Result</h3>
    <div class="bigText" id="roundWinner">—</div>
    <div class="mini" id="roundDetail">—</div>
  `;

  const stage = document.createElement("div");
  stage.className = "card";
  stage.style.padding = "0";
  stage.style.overflow = "hidden";
  stage.appendChild(canvas);

  if (root) {
    root.appendChild(hud);
    root.appendChild(stage);
    root.appendChild(roundCard);
  }

  const likeFill = document.getElementById("likeFill");
  const likeText = document.getElementById("likeText");
  const scoreList = document.getElementById("scoreList");
  const hudJoinCmd = document.getElementById("hudJoinCmd");
  const hudActionCmd = document.getElementById("hudActionCmd");
  const hudHeadline = document.getElementById("hudHeadline");
  const roundWinner = document.getElementById("roundWinner");
  const roundDetail = document.getElementById("roundDetail");

  function resize() {
    try {
      const rect = stage.getBoundingClientRect();
      const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
      canvas.width = Math.floor(rect.width * dpr);
      canvas.height = Math.floor(Math.min(rect.height, rect.width * 1.25) * dpr); // keep it tall-ish
      canvas.style.width = rect.width + "px";
      canvas.style.height = Math.min(rect.height, rect.width * 1.25) + "px";
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    } catch { /* ignore */ }
  }
  window.addEventListener("resize", resize, { passive: true });
  setTimeout(resize, 50);

  // Entities
  const players = new Map(); // userId -> player
  const pulses = [];
  const bosses = [];
  let likeCharge = 0; // 0..1
  let lastTick = now();
  let gameStarted = false;
  let gameFinished = false;

  // Round settings (from UI)
  let roundMs = 90 * 1000;
  let winGoal = 25;
  let roundStartAt = 0;

  function rand(a, b) { return a + Math.random() * (b - a); }
  function hashColor(seedStr) {
    // Deterministic-ish vibrant color per user
    let h = 0;
    for (let i = 0; i < seedStr.length; i++) h = (h * 31 + seedStr.charCodeAt(i)) >>> 0;
    const r = 120 + (h % 136);
    const g = 90 + ((h >> 8) % 156);
    const b = 110 + ((h >> 16) % 136);
    return `rgb(${r},${g},${b})`;
  }

  function getOrCreatePlayer(user) {
    const u = user || {};
    const userId = normText(u.userId || u.uniqueId || u.id || u.nickname || "");
    if (!userId) return null;

    if (players.has(userId)) return players.get(userId);

    const name = normText(u.nickname || u.uniqueId || userId).slice(0, 18);
    const p = {
      userId,
      name,
      pfp: normText(u.profilePictureUrl || u.avatar || u.pfp || ""),
      x: rand(40, 290),
      y: rand(80, 320),
      vx: rand(-30, 30),
      vy: rand(-30, 30),
      r: rand(10, 14),
      score: 0,
      lastActionAt: 0,
      color: hashColor(userId),
    };
    players.set(userId, p);
    notify("join", u, "joined the arena");
    beep(740, 70, 0.03);
    return p;
  }

  function formatScoreboard() {
    const top = Array.from(players.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);

    if (!top.length) return "No players yet.";

    return top
      .map((p, i) => `${String(i + 1).padStart(2, "0")}. ${p.name}  —  ${p.score}`)
      .join("\n");
  }

  function updateHud() {
    try {
      if (hudJoinCmd) hudJoinCmd.textContent = getSetting("joinCommand", "join");
      if (hudActionCmd) hudActionCmd.textContent = getSetting("actionCommand", "pulse");

      const pct = Math.round(likeCharge * 100);
      if (likeFill) likeFill.style.width = pct + "%";
      if (likeText) likeText.textContent = pct + "%";
      if (scoreList) scoreList.textContent = formatScoreboard();

      const elapsed = roundStartAt ? (now() - roundStartAt) : 0;
      const remain = Math.max(0, roundMs - elapsed);
      const s = Math.ceil(remain / 1000);
      if (hudHeadline) {
        if (!gameStarted) hudHeadline.textContent = "Enter LIVE ID + Start!";
        else if (gameFinished) hudHeadline.textContent = "Round complete!";
        else hudHeadline.textContent = `Round: ${s}s  •  Goal: ${winGoal}`;
      }
    } catch { /* ignore */ }
  }

  // Main action: pulse blast that awards points on boss hits
  function firePulse(p) {
    const t = now();
    if (!p) return;
    if (t - p.lastActionAt < 650) return; // cooldown
    p.lastActionAt = t;

    const speed = 240 + likeCharge * 260;
    const ang = rand(-Math.PI, Math.PI);
    const power = 1 + Math.floor(likeCharge * 3);

    pulses.push({
      x: p.x,
      y: p.y,
      vx: Math.cos(ang) * speed,
      vy: Math.sin(ang) * speed,
      r: 6 + power * 1.5,
      ownerId: p.userId,
      life: 900 + power * 250,
      born: t,
      power,
    });

    notify("chat", { nickname: p.name, profilePictureUrl: p.pfp }, `used ${getSetting("actionCommand", "pulse")}`);
    beep(980, 55, 0.028);
    likeCharge = Math.max(0, likeCharge - 0.35); // spend charge
  }

  function spawnBoss(source = "auto") {
    const t = now();
    bosses.push({
      x: rand(60, 290),
      y: rand(110, 320),
      vx: rand(-35, 35),
      vy: rand(-35, 35),
      r: rand(26, 34),
      hp: 14,
      born: t,
      source,
      wob: rand(0, Math.PI * 2),
    });
    notify("gift", { nickname: "SYSTEM" }, "Boss spawned!");
    beep(220, 120, 0.035);
  }

  function endRound(winner) {
    gameFinished = true;
    roundCard.style.display = "block";
    const name = winner ? winner.name : "No winner";
    if (roundWinner) roundWinner.textContent = name;
    if (roundDetail) {
      const top = Array.from(players.values()).sort((a, b) => b.score - a.score)[0];
      const topLine = top ? `${top.name} led with ${top.score} points.` : "No scores recorded.";
      roundDetail.textContent = `Goal: ${winGoal} • Duration: ${Math.round(roundMs / 1000)}s • ${topLine}`;
    }
    beep(540, 160, 0.03);
    setTimeout(() => {
      // reset round
      roundCard.style.display = "none";
      for (const p of players.values()) p.score = 0;
      pulses.length = 0;
      bosses.length = 0;
      likeCharge = 0;
      gameFinished = false;
      roundStartAt = now();
    }, 5200);
  }

  function beginGameLoop() {
    if (gameStarted) return;
    gameStarted = true;
    gameFinished = false;

    // Read settings
    winGoal = clamp(parseInt(getSetting("winGoal", "25"), 10) || 25, 5, 500);
    roundMs = clamp(parseInt(getSetting("roundSeconds", "90"), 10) || 90, 20, 600) * 1000;

    roundStartAt = now();
    setStatus("Connected.");
    showOverlay(false);

    // Ensure at least one boss so gameplay is obvious
    spawnBoss("start");

    lastTick = now();
    tick();
  }

  // Rendering
  function draw(dt) {
    const w = canvas.width / Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    const h = canvas.height / Math.max(1, Math.min(2, window.devicePixelRatio || 1));

    // Backdrop
    ctx.clearRect(0, 0, w, h);

    // subtle grid glow
    ctx.save();
    ctx.globalAlpha = 0.12;
    for (let y = 0; y < h; y += 28) {
      ctx.fillStyle = "rgba(255,255,255,0.08)";
      ctx.fillRect(0, y, w, 1);
    }
    for (let x = 0; x < w; x += 28) {
      ctx.fillStyle = "rgba(255,255,255,0.06)";
      ctx.fillRect(x, 0, 1, h);
    }
    ctx.restore();

    // Bosses
    for (const b of bosses) {
      b.wob += dt * 0.003;
      ctx.save();
      ctx.translate(b.x, b.y);

      const glow = 0.22 + 0.10 * Math.sin(b.wob);
      ctx.shadowColor = "rgba(255,0,80,0.55)";
      ctx.shadowBlur = 18;

      ctx.globalAlpha = 1;
      ctx.beginPath();
      ctx.fillStyle = "rgba(255,0,80,0.20)";
      ctx.arc(0, 0, b.r + 10, 0, Math.PI * 2);
      ctx.fill();

      ctx.shadowColor = "rgba(0,242,234,0.45)";
      ctx.shadowBlur = 14;

      ctx.beginPath();
      ctx.fillStyle = `rgba(0,242,234,${0.20 + glow})`;
      ctx.arc(0, 0, b.r, 0, Math.PI * 2);
      ctx.fill();

      // HP ring
      const hpPct = clamp(b.hp / 14, 0, 1);
      ctx.lineWidth = 4;
      ctx.strokeStyle = "rgba(255,255,255,0.25)";
      ctx.beginPath();
      ctx.arc(0, 0, b.r + 8, 0, Math.PI * 2);
      ctx.stroke();

      ctx.strokeStyle = "rgba(255,255,255,0.85)";
      ctx.beginPath();
      ctx.arc(0, 0, b.r + 8, -Math.PI / 2, -Math.PI / 2 + hpPct * Math.PI * 2);
      ctx.stroke();

      ctx.restore();
    }

    // Pulses
    for (const p of pulses) {
      ctx.save();
      ctx.globalAlpha = 0.9;
      ctx.shadowColor = "rgba(255,255,255,0.40)";
      ctx.shadowBlur = 10;

      ctx.beginPath();
      ctx.fillStyle = "rgba(255,255,255,0.82)";
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    // Players
    for (const p of players.values()) {
      ctx.save();
      ctx.translate(p.x, p.y);

      ctx.shadowColor = "rgba(0,0,0,0.55)";
      ctx.shadowBlur = 12;

      ctx.beginPath();
      ctx.fillStyle = p.color;
      ctx.arc(0, 0, p.r, 0, Math.PI * 2);
      ctx.fill();

      // inner shine
      ctx.globalAlpha = 0.30;
      ctx.beginPath();
      ctx.fillStyle = "white";
      ctx.arc(-p.r * 0.25, -p.r * 0.25, p.r * 0.45, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;

      // name
      ctx.font = "12px ui-monospace, Menlo, Monaco, Consolas, monospace";
      ctx.fillStyle = "rgba(255,255,255,0.92)";
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      ctx.shadowBlur = 0;
      ctx.fillText(p.name, 0, p.r + 6);

      // score
      ctx.font = "11px ui-monospace, Menlo, Monaco, Consolas, monospace";
      ctx.fillStyle = "rgba(255,255,255,0.72)";
      ctx.fillText(String(p.score), 0, p.r + 20);

      ctx.restore();
    }
  }

  // Physics + collisions
  function step(dt) {
    const w = canvas.width / Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    const h = canvas.height / Math.max(1, Math.min(2, window.devicePixelRatio || 1));

    // players drift
    for (const p of players.values()) {
      p.x += (p.vx * dt) / 1000;
      p.y += (p.vy * dt) / 1000;

      // gentle wander
      p.vx += rand(-10, 10) * (dt / 1000);
      p.vy += rand(-10, 10) * (dt / 1000);
      p.vx = clamp(p.vx, -70, 70);
      p.vy = clamp(p.vy, -70, 70);

      // bounds
      const pad = 18;
      if (p.x < pad) { p.x = pad; p.vx *= -0.8; }
      if (p.x > w - pad) { p.x = w - pad; p.vx *= -0.8; }
      if (p.y < pad) { p.y = pad; p.vy *= -0.8; }
      if (p.y > h - pad) { p.y = h - pad; p.vy *= -0.8; }
    }

    // bosses drift
    for (const b of bosses) {
      b.x += (b.vx * dt) / 1000;
      b.y += (b.vy * dt) / 1000;

      // bounce
      const pad = 40;
      if (b.x < pad) { b.x = pad; b.vx *= -0.85; }
      if (b.x > w - pad) { b.x = w - pad; b.vx *= -0.85; }
      if (b.y < pad) { b.y = pad; b.vy *= -0.85; }
      if (b.y > h - pad) { b.y = h - pad; b.vy *= -0.85; }
    }

    // pulses move + expire
    const t = now();
    for (let i = pulses.length - 1; i >= 0; i--) {
      const p = pulses[i];
      p.x += (p.vx * dt) / 1000;
      p.y += (p.vy * dt) / 1000;
      if (t - p.born > p.life) pulses.splice(i, 1);
    }

    // collisions: pulse hits boss
    for (let i = bosses.length - 1; i >= 0; i--) {
      const b = bosses[i];
      for (let j = pulses.length - 1; j >= 0; j--) {
        const pu = pulses[j];
        const dx = pu.x - b.x;
        const dy = pu.y - b.y;
        const rr = (pu.r + b.r) * (pu.r + b.r);
        if (dx * dx + dy * dy <= rr) {
          // hit
          pulses.splice(j, 1);
          b.hp -= pu.power;
          const owner = players.get(pu.ownerId);
          if (owner) owner.score += 1 + pu.power;

          beep(320 + pu.power * 80, 60, 0.03);

          if (b.hp <= 0) {
            bosses.splice(i, 1);
            // bonus to owner
            if (owner) owner.score += 4;
            notify("gift", { nickname: owner ? owner.name : "SYSTEM" }, "defeated the boss!");
            beep(160, 160, 0.035);

            // spawn next boss shortly so the loop continues
            setTimeout(() => spawnBoss("respawn"), 850);
            break;
          }
        }
      }
    }

    // end round by time or winGoal
    if (!gameFinished && roundStartAt) {
      const elapsed = t - roundStartAt;
      if (elapsed >= roundMs) {
        const top = Array.from(players.values()).sort((a, b) => b.score - a.score)[0] || null;
        endRound(top);
      } else {
        const top = Array.from(players.values()).sort((a, b) => b.score - a.score)[0] || null;
        if (top && top.score >= winGoal) endRound(top);
      }
    }

    // slowly decay charge
    likeCharge = Math.max(0, likeCharge - (dt / 1000) * 0.03);
  }

  function tick() {
    const t = now();
    const dt = clamp(t - lastTick, 8, 40);
    lastTick = t;

    step(dt);
    draw(dt);
    updateHud();

    requestAnimationFrame(tick);
  }

  // ===============================
  // 4) TikTok message shape helpers
  // ===============================
  function getUserFromMessage(msg) {
    const m = msg || {};
    // Try common shapes
    const u =
      m.user ||
      m.userInfo ||
      m.sender ||
      m.user_profile ||
      m.data?.user ||
      m.data?.userInfo ||
      m.data?.sender ||
      m;

    return {
      userId: normText(u.userId || u.id || u.uniqueId || u.uid || u.secUid || u.nickname || u.unique_id || ""),
      uniqueId: normText(u.uniqueId || u.unique_id || u.username || u.handle || ""),
      nickname: normText(u.nickname || u.displayName || u.name || u.uniqueId || u.unique_id || ""),
      profilePictureUrl: normText(u.profilePictureUrl || u.avatar || u.avatarThumb || u.avatar_url || u.profilePic || u.pfp || ""),
    };
  }

  function getChatTextFromMessage(msg) {
    const m = msg || {};
    // Common chat text fields
    return normText(
      m.comment ||
      m.text ||
      m.message ||
      m.content ||
      m.chat ||
      m.data?.comment ||
      m.data?.text ||
      m.data?.message ||
      ""
    );
  }

  function getGiftSummary(msg) {
    const m = msg || {};
    const g = m.gift || m.giftInfo || m.data?.gift || m.data?.giftInfo || m;
    const name = normText(g.giftName || g.name || g.gift_name || "Gift");
    const diamonds = Number(g.diamondCount || g.diamond_count || g.diamonds || 0) || 0;
    const count = Number(m.repeatCount || m.repeat_count || g.repeatCount || g.count || 1) || 1;
    return { name, diamonds, count };
  }

  // ===============================
  // 5) Mapping: join/action + optional shares
  // ===============================
  let client = null;
  let pendingStart = false;

  // “Join” is always allowed; action is optional but this template uses it.
  function isJoinCommand(text) {
    const cmd = normLower(getSetting("joinCommand", "join"));
    const t = normLower(text);
    if (!cmd) return false;
    // allow "join", "!join", "/join"
    return t === cmd || t === "!" + cmd || t === "/" + cmd || t.startsWith(cmd + " ");
  }

  function isActionCommand(text) {
    const cmd = normLower(getSetting("actionCommand", "pulse"));
    const t = normLower(text);
    if (!cmd) return false;
    return t === cmd || t === "!" + cmd || t === "/" + cmd || t.startsWith(cmd + " ");
  }

  function onChatMessage(data) {
    try {
      const msg = data || {};
      const text = getChatTextFromMessage(msg);
      const user = getUserFromMessage(msg);

      if (!text) return;

      // Join
      if (isJoinCommand(text)) {
        getOrCreatePlayer(user);
        return;
      }

      // Action (requires join first)
      if (isActionCommand(text)) {
        const p = players.get(user.userId);
        if (!p) return;
        firePulse(p);
        return;
      }

      // Optional: quick join by plain "hi"/anything? (disabled by default)
    } catch (e) {
      // keep stable
      console.error("Error in chat handler:", e);
    }
  }

  function onLikeMessage(data) {
    try {
      // Likes build charge meter
      const inc = 0.015;
      likeCharge = clamp(likeCharge + inc, 0, 1);
      if (Math.random() < 0.08) beep(1080, 40, 0.012);
      // optional notification (kept subtle)
      // notify("like", getUserFromMessage(data), "liked");
    } catch (e) {
      console.error("Error in like handler:", e);
    }
  }

  function onGiftMessage(data) {
    try {
      const user = getUserFromMessage(data);
      const g = getGiftSummary(data);

      // Gifts: spawn bosses / boost charge
      const power = clamp(Math.floor((g.diamonds || 0) / 10) + g.count, 1, 12);
      for (let i = 0; i < Math.min(3, Math.ceil(power / 3)); i++) spawnBoss("gift");
      likeCharge = clamp(likeCharge + 0.12 + power * 0.02, 0, 1);

      notify("gift", user, `${g.name} x${g.count}`);
      beep(260, 90, 0.03);
    } catch (e) {
      console.error("Error in gift handler:", e);
    }
  }

  function onJoinMessage(data) {
    try {
      // Some platforms emit "join" event
      const user = getUserFromMessage(data);
      if (!user.userId) return;
      // If join via event, treat as join
      getOrCreatePlayer(user);
    } catch (e) {
      console.error("Error in join handler:", e);
    }
  }

  function onShareMessage(data) {
    try {
      const user = getUserFromMessage(data);
      if (!user.userId) return;

      const allowJoin = normLower(getSetting("allowShareForJoin", "yes")) === "yes";
      const allowAction = normLower(getSetting("allowShareForAction", "no")) === "yes";

      if (allowJoin && !players.has(user.userId)) {
        getOrCreatePlayer(user);
        notify("join", user, "shared (counts as join)");
        return;
      }

      if (allowAction && players.has(user.userId)) {
        const p = players.get(user.userId);
        firePulse(p);
        notify("chat", user, "shared (counts as action)");
        return;
      }
    } catch (e) {
      console.error("Error in share handler:", e);
    }
  }

  // ===============================
  // 6) TikTok client setup / connect
  // ===============================
  function setupTikTokClient(liveId) {
    if (!liveId) throw new Error("liveId is required");

    if (client && client.socket) {
      try { client.socket.close(); } catch (e) { /* ignore */ }
    }

    if (typeof TikTokClient === "undefined") {
      throw new Error("TikTokClient is not available. Check platform injection (tiktok-client.js).");
    }

    // proto is required for protobuf decode on some deployments
    const hasProto = (typeof proto !== "undefined") || (typeof window !== "undefined" && typeof window.proto !== "undefined");
    if (!hasProto) {
      throw new Error("proto is not available. Platform must inject proto bundle (no proto.bundle.js should be requested by the game).");
    }

    client = new TikTokClient(liveId);

    // ChatTok injects CHATTOK_CREATOR_TOKEN globally.
    if (typeof CHATTOK_CREATOR_TOKEN !== "undefined" && CHATTOK_CREATOR_TOKEN) {
      client.setAccessToken(CHATTOK_CREATOR_TOKEN);
    }

    client.on("connected", () => {
      setStatus("Connected.");
      // Only start game once we know we're connected
      if (pendingStart && !gameStarted) beginGameLoop();
    });

    client.on("disconnected", (reason) => {
      const msg = reason || "Connection closed";
      setStatus("Disconnected: " + msg);
      if (!gameStarted) pendingStart = false; // allow retry
    });

    client.on("error", (err) => {
      const m = err && err.message ? err.message : "Unknown error";
      setStatus("Error: " + m);
    });

    // Events
    client.on("chat", onChatMessage);
    client.on("gift", onGiftMessage);
    client.on("like", onLikeMessage);
    client.on("join", onJoinMessage);

    // Not all clients emit share; safe to attach
    try { client.on("share", onShareMessage); } catch { /* ignore */ }

    client.connect();
  }

  // ===============================
  // 7) START BUTTON behavior
  // ===============================
  function startPressed() {
    try {
      const liveId = normText(liveIdInput ? liveIdInput.value : "");
      if (!liveId) {
        setStatus("Enter a LIVE ID (username without @).");
        beep(160, 120, 0.03);
        return;
      }

      // Apply settings immediately to HUD (shows commands)
      updateHud();
      resize();

      pendingStart = true;
      setStatus("Connecting…");

      setupTikTokClient(liveId);
    } catch (e) {
      pendingStart = false;

      // If TikTok isn’t available, optionally run demo
      const demo = normLower(getSetting("demoMode", "yes")) === "yes";
      if (demo) {
        setStatus((e && e.message ? e.message : "Offline") + " — Running demo mode.");
        showOverlay(false);
        beginGameLoop();
        seedDemoBots();
        return;
      }

      setStatus(e && e.message ? e.message : "Start failed.");
    }
  }

  if (startGameBtn) {
    startGameBtn.addEventListener("click", () => {
      // Unlock audio context via user gesture
      try { beep(880, 20, 0.001); } catch { /* ignore */ }
      startPressed();
    });
  }

  // ===============================
  // 8) Demo mode: never blank
  // ===============================
  let demoSeeded = false;
  function seedDemoBots() {
    if (demoSeeded) return;
    demoSeeded = true;

    const bots = [
      { userId: "demo_1", nickname: "DemoFox" },
      { userId: "demo_2", nickname: "DemoWave" },
      { userId: "demo_3", nickname: "DemoNova" },
      { userId: "demo_4", nickname: "DemoSpark" },
    ];
    for (const b of bots) getOrCreatePlayer(b);
    likeCharge = 0.4;

    // periodic actions
    setInterval(() => {
      if (!gameStarted || gameFinished) return;
      const arr = Array.from(players.values());
      if (!arr.length) return;
      const p = arr[Math.floor(Math.random() * arr.length)];
      firePulse(p);
    }, 1150);

    // periodic likes
    setInterval(() => {
      if (!gameStarted || gameFinished) return;
      likeCharge = clamp(likeCharge + 0.03, 0, 1);
    }, 420);

    // occasional gift/boss
    setInterval(() => {
      if (!gameStarted || gameFinished) return;
      spawnBoss("demo");
    }, 7200);
  }

  // Update HUD initially
  updateHud();
  setStatus("Disconnected");

  // If platform injected scripts slowly, the user can still start when ready
  showOverlay(true);

  // ===============================
  // ✅ WORKING TIKTOK CONNECTION EXAMPLE (DO NOT REMOVE)
  // ===============================
  /*
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
  */
})();
