/* =========================================================
   ChatTok Live Game — game.js (template-first, spec-driven)
   - Uses SPEC JSON injected by server
   - Works in Practice mode without TikTok
   - LIVE mode uses TikTokClient injected by ChatTok platform
   - Soft warning overlay if scripts/proto missing (does NOT hard-block)
   - Uses your working connection pattern (events + token)
   - Keeps required TikTok connection example section (DO NOT REMOVE)
========================================================= */

/* Injected spec (do not edit by hand in generated games) */
const SPEC = __SPEC_JSON__; /*__SPEC_END__*/

(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);

  const bootErrorEl = $("bootError");
  const bootErrorText = $("bootErrorText");
  const bootCloseBtn = $("bootCloseBtn");
  const bootPracticeBtn = $("bootPracticeBtn");

  const setupOverlay = $("setupOverlay");
  const liveIdInput = $("liveIdInput");
  const startBtn = $("startGameBtn");
  const practiceBtn = $("practiceBtn");
  const overlayStartBtn = $("overlayStartBtn");
  const overlayPracticeBtn = $("overlayPracticeBtn");

  const statusText = $("statusText");
  const statusTextInGame = $("statusTextInGame");

  const canvas = $("gameCanvas");
  const ctx = canvas.getContext("2d", { alpha: true });

  const hudRound = $("hudRound");
  const hudTime = $("hudTime");
  const hudShots = $("hudShots");
  const hudHits = $("hudHits");

  const scoreboardEl = $("scoreboard");
  const flagsEl = $("flags");
  const flashLayer = $("flashLayer");

  const required = [
    setupOverlay, liveIdInput, startBtn, practiceBtn, overlayStartBtn, overlayPracticeBtn,
    statusText, statusTextInGame, canvas, scoreboardEl, flagsEl, flashLayer,
    hudRound, hudTime, hudShots, hudHits
  ];
  if (required.some((x) => !x)) {
    console.error("Missing required HTML elements. Ensure index.html matches template.");
    return;
  }

  const S = normalizeSpec(SPEC);

  // -----------------------------
  // State
  // -----------------------------
  let mode = "idle";        // idle | practice | live
  let connected = false;

  let client = null;        // TikTokClient instance
  let pendingStart = false; // wait for "connected" before starting live game

  let round = 1;
  let timeLeft = S.defaultSettings.roundSeconds;
  let timerHandle = null;

  const gridSize = clampInt(S.defaultSettings.gridSize, 6, 14);
  const winGoal = clampInt(S.defaultSettings.winGoal, 5, 999);

  const board = new Array(gridSize * gridSize).fill(0); // 0 empty, 1 miss, 2 hit, 3 scan
  const targets = new Set();

  const users = new Map(); // userId -> stats
  let totalShots = 0;
  let totalHits = 0;

  const particles = [];
  const ripples = [];
  let likesBank = 0;

  // -----------------------------
  // UI helpers
  // -----------------------------
  function setStatus(text) {
    statusText.textContent = text;
    statusTextInGame.textContent = text;
  }

  function showOverlay(show) {
    setupOverlay.style.display = show ? "flex" : "none";
  }

  function showBootError(message) {
    if (!bootErrorEl || !bootErrorText) return;

    const body =
      escapeHtml(message) +
      "<div style='margin-top:10px;opacity:.88;line-height:1.35'>" +
      "Missing scripts? The platform should inject <code>tiktok-client.js</code> and <code>proto</code>." +
      "</div>";

    bootErrorText.innerHTML = body;
    bootErrorEl.style.display = "flex";
  }

  function hideBootError() {
    if (!bootErrorEl) return;
    bootErrorEl.style.display = "none";
  }

  bootCloseBtn?.addEventListener("click", hideBootError);
  bootPracticeBtn?.addEventListener("click", () => {
    hideBootError();
    startPractice();
  });

  function addFlag({ pfpUrl, line1, line2 }) {
    const el = document.createElement("div");
    el.className = "flag";
    el.innerHTML = `
      <div class="pfp">${pfpUrl ? `<img src="${escapeAttr(pfpUrl)}" alt="">` : ""}</div>
      <div class="meta">
        <div class="line1">${escapeHtml(line1)}</div>
        <div class="line2">${escapeHtml(line2)}</div>
      </div>
    `;
    flagsEl.prepend(el);
    setTimeout(() => {
      try { el.remove(); } catch {}
      while (flagsEl.children.length > 6) flagsEl.lastChild?.remove();
    }, 3400);
  }

  function flashWinner(user, text) {
    const el = document.createElement("div");
    el.className = "flashCard";
    el.innerHTML = `
      <div class="flashTop">
        <div class="pfp">${user?.profilePictureUrl ? `<img src="${escapeAttr(user.profilePictureUrl)}" alt="">` : ""}</div>
        <div>
          <div class="flashName">${escapeHtml(user?.nickname || "Player")}</div>
          <div style="opacity:.8;font-weight:900">${escapeHtml(text)}</div>
        </div>
      </div>
      <div class="flashMsg">${escapeHtml(S.title)} • ${escapeHtml(S.visuals.hitEmoji)} ${escapeHtml(S.visuals.missEmoji)}</div>
    `;
    flashLayer.appendChild(el);
    setTimeout(() => { try { el.remove(); } catch {} }, 950);
  }

  function updateHud() {
    hudRound.textContent = String(round);
    hudTime.textContent = formatTime(timeLeft);
    hudShots.textContent = String(totalShots);
    hudHits.textContent = String(totalHits);
  }

  function renderScoreboard() {
    const arr = Array.from(users.values())
      .sort((a, b) => (b.hits - a.hits) || (b.shots - a.shots))
      .slice(0, 5);

    scoreboardEl.innerHTML = "";
    const card = document.createElement("div");
    card.className = "scoreCard";
    card.innerHTML = `<div class="scoreTitle">Top Hunters (Hits)</div>`;

    for (const u of arr) {
      const row = document.createElement("div");
      row.className = "scoreRow";
      row.innerHTML = `
        <div class="pfp">${u.profilePictureUrl ? `<img src="${escapeAttr(u.profilePictureUrl)}" alt="">` : ""}</div>
        <div class="nick">${escapeHtml(u.nickname || "Player")}</div>
        <div class="val">${u.hits}</div>
      `;
      card.appendChild(row);
    }

    scoreboardEl.appendChild(card);
  }

  // -----------------------------
  // Game logic
  // -----------------------------
  function resetRound() {
    board.fill(0);
    targets.clear();
    totalShots = 0;
    totalHits = 0;
    likesBank = 0;

    for (const u of users.values()) {
      u.shots = 0;
      u.hits = 0;
      u.lastShotAt = 0;
    }

    // Scale targets with grid size so different prompts/settings still feel good
    const targetCount = clampInt(Math.floor(gridSize * gridSize * 0.12), 8, Math.floor(gridSize * gridSize * 0.35));
    placeTargetsRandom(targetCount);

    timeLeft = S.defaultSettings.roundSeconds;

    particles.length = 0;
    ripples.length = 0;

    updateHud();
    renderScoreboard();
  }

  function placeTargetsRandom(count) {
    const c = clampInt(count, 6, Math.floor(gridSize * gridSize * 0.35));
    let guard = 0;
    while (targets.size < c && guard < 5000) {
      guard++;
      const idx = randInt(0, gridSize * gridSize - 1);
      targets.add(idx);
    }
  }

  function startTimer() {
    stopTimer();
    timerHandle = setInterval(() => {
      if (mode === "idle") return;
      timeLeft -= 1;
      if (timeLeft <= 0) {
        timeLeft = 0;
        endRound();
      }
      updateHud();
    }, 1000);
  }

  function stopTimer() {
    if (timerHandle) clearInterval(timerHandle);
    timerHandle = null;
  }

  let roundEnding = false;
  function endRound() {
    if (roundEnding) return;
    roundEnding = true;

    stopTimer();

    const best = Array.from(users.values())
      .sort((a, b) => (b.hits - a.hits) || (b.shots - a.shots))[0];

    if (best && best.hits > 0) {
      flashWinner(best, `wins the round with ${best.hits} hits!`);
    } else {
      flashWinner({ nickname: "No one" }, "No hits this round!");
    }

    addFlag({
      pfpUrl: best?.profilePictureUrl,
      line1: "Round ended",
      line2: best ? `${best.nickname} led with ${best.hits}` : "Try again!"
    });

    setTimeout(() => {
      round += 1;
      roundEnding = false;
      resetRound();
      startTimer();
      setStatus(mode === "live" && connected ? "LIVE • Round started" : "Practice • Round started");
      showOverlay(false);
    }, 1200);
  }

  function registerUser(user) {
    if (!user || !user.userId) return null;

    if (!users.has(user.userId)) {
      users.set(user.userId, {
        userId: user.userId,
        nickname: user.nickname || "Player",
        profilePictureUrl: user.profilePictureUrl || "",
        shots: 0,
        hits: 0,
        lastShotAt: 0,
      });
    } else {
      const u = users.get(user.userId);
      u.nickname = user.nickname || u.nickname;
      u.profilePictureUrl = user.profilePictureUrl || u.profilePictureUrl;
    }

    return users.get(user.userId);
  }

  function tryFireAt(text, user) {
    const coord = parseCoordinate(text, gridSize, S.commands.fire);
    if (!coord) return false;

    const u = registerUser(user) || { nickname: "Player" };
    const now = Date.now();

    // simple per-user cooldown to reduce spam
    if (u.lastShotAt && now - u.lastShotAt < 1200) return true;
    u.lastShotAt = now;

    const idx = coord.row * gridSize + coord.col;
    if (board[idx] === 1 || board[idx] === 2) return true;

    totalShots += 1;
    u.shots += 1;

    const hit = targets.has(idx);
    if (hit) {
      board[idx] = 2;
      totalHits += 1;
      u.hits += 1;
      burstAtCell(coord.col, coord.row, true);
      addFlag({ pfpUrl: u.profilePictureUrl, line1: `${u.nickname}`, line2: `HIT ${S.visuals.hitEmoji} at ${coord.label}` });
      flashWinner(u, `HIT ${S.visuals.hitEmoji} • ${coord.label}`);
    } else {
      board[idx] = 1;
      burstAtCell(coord.col, coord.row, false);
      addFlag({ pfpUrl: u.profilePictureUrl, line1: `${u.nickname}`, line2: `MISS ${S.visuals.missEmoji} at ${coord.label}` });
      flashWinner(u, `MISS ${S.visuals.missEmoji} • ${coord.label}`);
    }

    renderScoreboard();

    if (totalHits >= winGoal) {
      timeLeft = 0;
      updateHud();
      endRound();
    }

    return true;
  }

  function onLike(user, likeCount) {
    const u = registerUser(user) || { nickname: "Someone", profilePictureUrl: "" };
    likesBank += clampInt(likeCount || 1, 1, 9999);
    if (likesBank >= 50) {
      likesBank = 0;
      revealHintCell(u);
    }
  }

  function revealHintCell(u) {
    const candidates = [];
    for (const t of targets) {
      const r = Math.floor(t / gridSize);
      const c = t % gridSize;
      for (const [dr, dc] of [[-1,0],[1,0],[0,-1],[0,1]]) {
        const rr = r + dr, cc = c + dc;
        if (rr < 0 || rr >= gridSize || cc < 0 || cc >= gridSize) continue;
        const idx = rr * gridSize + cc;
        if (board[idx] === 0) candidates.push(idx);
      }
    }
    if (!candidates.length) return;

    const idx = candidates[randInt(0, candidates.length - 1)];
    board[idx] = 3;

    const rr = Math.floor(idx / gridSize);
    const cc = idx % gridSize;
    scanRipple(cc, rr);
    addFlag({ pfpUrl: u?.profilePictureUrl, line1: `${u?.nickname || "Like storm!"}`, line2: `SCAN ${S.visuals.scanEmoji} reveals a warm spot` });
  }

  function onGift(user, giftName, repeatCount) {
    const u = registerUser(user) || { nickname: "Someone", profilePictureUrl: "" };
    const n = clampInt(repeatCount || 1, 1, 10);
    const strikes = Math.min(3, n);
    addFlag({ pfpUrl: u.profilePictureUrl, line1: `${u.nickname}`, line2: `GIFT: ${giftName} → AIRSTRIKE x${strikes}` });
    for (let i = 0; i < strikes; i++) setTimeout(() => airstrike(u), 120 * i);
  }

  function airstrike(u) {
    const candidates = [];
    for (let i = 0; i < board.length; i++) if (board[i] === 0) candidates.push(i);
    if (!candidates.length) return;

    const idx = candidates[randInt(0, candidates.length - 1)];
    const r = Math.floor(idx / gridSize);
    const c = idx % gridSize;
    tryFireAt(`${toColLabel(c)}${r + 1}`, u);
  }

  // -----------------------------
  // Effects & rendering
  // -----------------------------
  function burstAtCell(col, row, isHit) {
    const p = cellCenter(col, row);
    ripples.push({ x: p.x, y: p.y, t: 0, hit: !!isHit });

    for (let i = 0; i < 22; i++) {
      particles.push({
        x: p.x,
        y: p.y,
        vx: (Math.random() - 0.5) * 6,
        vy: (Math.random() - 0.7) * 7,
        life: 40 + Math.random() * 25,
        hit: !!isHit,
      });
    }
  }

  function scanRipple(col, row) {
    const p = cellCenter(col, row);
    ripples.push({ x: p.x, y: p.y, t: 0, hit: null, scan: true });
  }

  function draw() {
    requestAnimationFrame(draw);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    drawBackground();
    drawGrid();
    stepEffects();
    drawRipples();
    drawParticles();
    if (mode === "idle") drawIdleHint();
  }

  function drawBackground() {
    const g = ctx.createLinearGradient(0, 0, 0, canvas.height);
    g.addColorStop(0, "rgba(0,242,234,0.10)");
    g.addColorStop(1, "rgba(255,0,80,0.08)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "rgba(0,0,0,0.22)";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }

  function gridRect() {
    const padX = 54;
    const padY = 150;
    const size = Math.min(canvas.width - padX * 2, canvas.height - padY * 2);
    const x = (canvas.width - size) / 2;
    const y = 200;
    return { x, y, size };
  }

  function cellCenter(col, row) {
    const gr = gridRect();
    const cs = gr.size / gridSize;
    return { x: gr.x + (col + 0.5) * cs, y: gr.y + (row + 0.5) * cs, cs };
  }

  function drawGrid() {
    const gr = gridRect();
    const cs = gr.size / gridSize;

    ctx.strokeStyle = "rgba(255,255,255,0.14)";
    ctx.lineWidth = 2;
    roundRect(ctx, gr.x - 8, gr.y - 8, gr.size + 16, gr.size + 16, 16);
    ctx.stroke();

    ctx.fillStyle = "rgba(255,255,255,0.75)";
    ctx.font = "900 16px system-ui";
    for (let c = 0; c < gridSize; c++) {
      const t = toColLabel(c);
      const x = gr.x + c * cs + cs / 2;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(t, x, gr.y - 22);
      ctx.fillText(t, x, gr.y + gr.size + 22);
    }
    for (let r = 0; r < gridSize; r++) {
      const t = String(r + 1);
      const y = gr.y + r * cs + cs / 2;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(t, gr.x - 22, y);
      ctx.fillText(t, gr.x + gr.size + 22, y);
    }

    for (let r = 0; r < gridSize; r++) {
      for (let c = 0; c < gridSize; c++) {
        const idx = r * gridSize + c;
        const x = gr.x + c * cs;
        const y = gr.y + r * cs;

        ctx.fillStyle = "rgba(0,0,0,0.18)";
        ctx.fillRect(x + 1, y + 1, cs - 2, cs - 2);

        if (board[idx] === 1) drawEmoji(S.visuals.missEmoji, x + cs / 2, y + cs / 2, 24);
        else if (board[idx] === 2) drawEmoji(S.visuals.hitEmoji, x + cs / 2, y + cs / 2, 26);
        else if (board[idx] === 3) drawEmoji(S.visuals.scanEmoji, x + cs / 2, y + cs / 2, 22);

        ctx.strokeStyle = "rgba(255,255,255,0.08)";
        ctx.lineWidth = 1;
        ctx.strokeRect(x, y, cs, cs);
      }
    }
  }

  function drawIdleHint() {
    ctx.fillStyle = "rgba(255,255,255,0.75)";
    ctx.font = "900 28px system-ui";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("TAP A CELL TO FIRE", canvas.width / 2, 140);

    ctx.fillStyle = "rgba(255,255,255,0.65)";
    ctx.font = "700 16px system-ui";
    ctx.fillText(`Or connect to TikTok LIVE with ${S.commands.join}`, canvas.width / 2, 172);
  }

  function drawEmoji(emoji, x, y, size) {
    ctx.font = `900 ${size}px system-ui, Apple Color Emoji, Segoe UI Emoji`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(emoji || "•", x, y);
  }

  function stepEffects() {
    for (const p of particles) {
      p.x += p.vx;
      p.y += p.vy;
      p.vy += 0.18;
      p.life -= 1;
    }
    for (let i = particles.length - 1; i >= 0; i--) if (particles[i].life <= 0) particles.splice(i, 1);

    for (const r of ripples) r.t += 1;
    for (let i = ripples.length - 1; i >= 0; i--) if (ripples[i].t > 40) ripples.splice(i, 1);
  }

  function drawParticles() {
    for (const p of particles) {
      const a = clamp01(p.life / 65);
      ctx.fillStyle = p.hit ? `rgba(255,0,80,${0.45 * a})` : `rgba(0,242,234,${0.40 * a})`;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 2.2, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function drawRipples() {
    for (const r of ripples) {
      const t = r.t / 40;
      const rad = 6 + t * 64;
      const a = 1 - t;
      if (r.scan) ctx.strokeStyle = `rgba(0,242,234,${0.35 * a})`;
      else if (r.hit) ctx.strokeStyle = `rgba(255,0,80,${0.40 * a})`;
      else ctx.strokeStyle = `rgba(0,242,234,${0.30 * a})`;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(r.x, r.y, rad, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  // -----------------------------
  // Input
  // -----------------------------
  canvas.addEventListener("pointerdown", (ev) => {
    if (mode === "idle") {
      startPractice();
      return;
    }
    if (mode !== "practice") return;

    const pt = pointerToCanvas(ev);
    const cell = pointToCell(pt.x, pt.y);
    if (!cell) return;

    const fakeUser = { userId: "practice", nickname: "Host", profilePictureUrl: "" };
    tryFireAt(`${toColLabel(cell.col)}${cell.row + 1}`, fakeUser);
  });

  function pointerToCanvas(ev) {
    const rect = canvas.getBoundingClientRect();
    const x = ((ev.clientX - rect.left) / rect.width) * canvas.width;
    const y = ((ev.clientY - rect.top) / rect.height) * canvas.height;
    return { x, y };
  }

  function pointToCell(x, y) {
    const gr = gridRect();
    if (x < gr.x || x > gr.x + gr.size || y < gr.y || y > gr.y + gr.size) return null;
    const cs = gr.size / gridSize;
    const col = Math.floor((x - gr.x) / cs);
    const row = Math.floor((y - gr.y) / cs);
    return { col, row };
  }

  // -----------------------------
  // Buttons
  // -----------------------------
  startBtn.addEventListener("click", startLiveFromUI);
  overlayStartBtn.addEventListener("click", startLiveFromUI);

  practiceBtn.addEventListener("click", startPractice);
  overlayPracticeBtn.addEventListener("click", startPractice);

  function startPractice() {
    mode = "practice";
    connected = false;

    try {
      if (client && client.socket) client.socket.close();
    } catch {}

    setStatus("Practice • Tap cells to fire");
    showOverlay(false);
    hideBootError();

    round = 1;
    resetRound();
    startTimer();
  }

  async function startLiveFromUI() {
    const liveId = String(liveIdInput.value || "").trim();
    if (!liveId) {
      setStatus("Enter a LIVE username or room ID first.");
      return;
    }
    await startLive(liveId);
  }

  async function startLive(liveId) {
    mode = "live";
    connected = false;
    pendingStart = true;

    setStatus("Connecting…");
    showOverlay(false);

    const hasClient = typeof window.TikTokClient !== "undefined";
    const hasProto = typeof window.proto !== "undefined" && window.proto;

    if (!hasClient) {
      pendingStart = false;
      setStatus("LIVE not available here • Use Practice");
      showBootError(
        "TikTok client scripts were not found. Practice mode still works, but LIVE connect requires the platform to inject the TikTok client."
      );
      return;
    }

    if (!hasProto) {
      showBootError(
        "Proto bundle was not detected in this preview. LIVE may not work locally. On ChatTok Gaming it is injected automatically."
      );
    }

    try {
      setupTikTokClient(liveId);
    } catch (e) {
      console.error(e);
      pendingStart = false;
      setStatus("Connection failed. Check LIVE ID and try again.");
      showBootError("Could not start LIVE connection: " + (e && e.message ? e.message : "Unknown error"));
    }
  }

  function beginLiveGame() {
    connected = true;
    pendingStart = false;

    hideBootError();
    setStatus("LIVE • Connected");

    round = 1;
    resetRound();
    startTimer();
  }

  // =========================================================
  // 8. TIKTOK CONNECTION EXAMPLE (DO NOT REMOVE)
  //
  // Here is an example of code to connect to the server, see TikTok messages,
  // and map chat into gameplay. You can adapt this pattern for new games,
  // but keep the structure and error handling style:
  //
  // // 7. TikTok message handling
  // // ===============================
  //
  // function handleTeamJoin(text, user) {
  //     const maybeTeam = normalizeTeamText(text);
  //     if (!maybeTeam) return;
  //
  //     // Assign or move team.
  //     userTeams.set(user.userId, maybeTeam);
  //     console.log(`${user.nickname} joined team ${maybeTeam}`);
  // }
  //
  // function handleAnswer(text, user) {
  //     if (!gameStarted || gameFinished) return;
  //     if (!userTeams.has(user.userId)) return; // must be on a team first
  //
  //     const answer = normalizeAnswerText(text);
  //     if (!answer) return;
  //
  //     // Only allow one answer per question per user
  //     if (answeredUsersThisQuestion.has(user.userId)) return;
  //     answeredUsersThisQuestion.set(user.userId, true);
  //
  //     const team = userTeams.get(user.userId
  //
  // =========================================================

  // -----------------------------
  // LIVE: Working connection pattern (your style)
  // -----------------------------
  function onChatMessage(data) {
    try {
      const msg = data || {};
      const text = getChatTextFromMessage(msg);
      const user = getUserFromMessage(msg);
      if (!text) return;

      if (user && normalizeChat(text) === normalizeChat(S.commands.join)) {
        const u = registerUser(user);
        addFlag({ pfpUrl: u.profilePictureUrl, line1: `${u.nickname}`, line2: "joined the hunt" });
        return;
      }

      if (user) {
        const did = tryFireAt(text, user);
        if (did) return;
      }

      if (user) addFlag({ pfpUrl: user.profilePictureUrl, line1: user.nickname || "Chat", line2: text });
    } catch (e) {
      console.error("Error in chat handler:", e);
    }
  }

  function onGiftMessage(data) {
    try {
      const msg = data || {};
      const user = getUserFromMessage(msg);
      const giftName = msg?.giftName || msg?.gift?.name || msg?.gift?.giftName || "Gift";
      const repeatCount = msg?.repeatCount || msg?.repeat || msg?.count || 1;
      if (!user) return;
      onGift(user, giftName, repeatCount);
    } catch (e) {
      console.error("Error in gift handler:", e);
    }
  }

  function onLikeMessage(data) {
    try {
      const msg = data || {};
      const user = getUserFromMessage(msg);
      const likeCount = msg?.likeCount || msg?.count || 1;
      if (!user) return;
      onLike(user, likeCount);
    } catch (e) {
      console.error("Error in like handler:", e);
    }
  }

  function setupTikTokClient(liveId) {
    if (!liveId) throw new Error("liveId is required");

    if (client && client.socket) {
      try { client.socket.close(); } catch (e) { console.warn("Error closing previous socket:", e); }
    }

    if (typeof TikTokClient === "undefined") {
      throw new Error("TikTokClient is not available. Check tiktok-client.js.");
    }

    client = new TikTokClient(liveId);

    if (typeof CHATTOK_CREATOR_TOKEN !== "undefined" && CHATTOK_CREATOR_TOKEN) {
      try { client.setAccessToken(CHATTOK_CREATOR_TOKEN); } catch {}
    }

    const on = (evt, fn) => {
      try { client.on(evt, fn); } catch {}
    };

    on("connected", () => {
      console.log("Connected to TikTok hub.");
      if (!connected && pendingStart) beginLiveGame();
      else setStatus("LIVE • Connected");
    });

    on("Connected", () => {
      console.log("Connected to TikTok hub (Connected).");
      if (!connected && pendingStart) beginLiveGame();
      else setStatus("LIVE • Connected");
    });

    on("disconnected", (reason) => {
      console.log("Disconnected from TikTok hub:", reason);
      connected = false;
      const msg = reason || "Connection closed";
      setStatus("Disconnected: " + msg);
      pendingStart = false;
    });

    on("Disconnected", (reason) => {
      console.log("Disconnected from TikTok hub (Disconnected):", reason);
      connected = false;
      const msg = reason || "Connection closed";
      setStatus("Disconnected: " + msg);
      pendingStart = false;
    });

    on("error", (err) => {
      console.error("TikTok client error:", err);
      const msg = (err && err.message) ? err.message : "Unknown";
      setStatus("Error: " + msg);
      pendingStart = false;
    });

    on("Error", (err) => {
      console.error("TikTok client error (Error):", err);
      const msg = (err && err.message) ? err.message : "Unknown";
      setStatus("Error: " + msg);
      pendingStart = false;
    });

    on("chat", onChatMessage);
    on("Chat", onChatMessage);

    on("gift", onGiftMessage);
    on("Gift", onGiftMessage);

    on("like", onLikeMessage);
    on("Like", onLikeMessage);

    on("member", (data) => {
      const user = getUserFromMessage(data);
      if (!user) return;
      addFlag({ pfpUrl: user.profilePictureUrl, line1: user.nickname || "Viewer", line2: "joined the LIVE" });
    });
    on("Member", (data) => {
      const user = getUserFromMessage(data);
      if (!user) return;
      addFlag({ pfpUrl: user.profilePictureUrl, line1: user.nickname || "Viewer", line2: "joined the LIVE" });
    });

    client.connect();
  }

  // -----------------------------
  // Boot
  // -----------------------------
  showOverlay(true);
  setStatus("Ready. Start LIVE or practice.");
  resetRound();
  updateHud();
  draw();

  // -----------------------------
  // Spec + parsing helpers
  // -----------------------------
  function normalizeSpec(spec) {
    const f = {
      title: "ChatTok Live Game",
      subtitle: "Live Interactive",
      oneSentence: "Connect to TikTok LIVE and let chat control the action.",
      howToPlay: ["Type !join to join.", "Type coordinates like A4 to fire."],
      defaultSettings: { roundSeconds: 30, winGoal: 20, gridSize: 10 },
      commands: { join: "!join", fire: "!fire A4" },
      visuals: { hitEmoji: "💥", missEmoji: "🌊", scanEmoji: "🔎" },
      archetype: "grid-strike",
    };

    if (spec && typeof spec === "object") {
      Object.assign(f, spec);
      if (spec.defaultSettings && typeof spec.defaultSettings === "object") f.defaultSettings = { ...f.defaultSettings, ...spec.defaultSettings };
      if (spec.commands && typeof spec.commands === "object") f.commands = { ...f.commands, ...spec.commands };
      if (spec.visuals && typeof spec.visuals === "object") f.visuals = { ...f.visuals, ...spec.visuals };
      if (!Array.isArray(f.howToPlay)) f.howToPlay = f.howToPlay ? [String(f.howToPlay)] : [];
    }

    f.commands.join = String(f.commands.join || "!join").trim();
    f.commands.fire = String(f.commands.fire || "!fire A4").trim();
    f.visuals.hitEmoji = String(f.visuals.hitEmoji || "💥");
    f.visuals.missEmoji = String(f.visuals.missEmoji || "🌊");
    f.visuals.scanEmoji = String(f.visuals.scanEmoji || "🔎");
    return f;
  }

  function parseCoordinate(text, size, firePatternHint) {
    const t0 = String(text || "").trim();
    if (!t0) return null;

    const hint = String(firePatternHint || "!fire A4").split(/\s+/)[0].trim();
    let t = t0;
    if (hint && normalizeChat(t).startsWith(normalizeChat(hint))) t = t.slice(hint.length).trim();

    const cleaned = t.toUpperCase().replace(/[^A-Z0-9]/g, "");
    const m = cleaned.match(/^([A-Z])([0-9]{1,2})$/);
    if (!m) return null;

    const col = m[1].charCodeAt(0) - 65;
    const row = Number(m[2]) - 1;
    if (col < 0 || col >= size || row < 0 || row >= size) return null;

    return { col, row, label: `${toColLabel(col)}${row + 1}` };
  }

  function toColLabel(col) { return String.fromCharCode(65 + col); }

  function formatTime(sec) {
    const s = clampInt(sec, 0, 9999);
    const m = Math.floor(s / 60);
    const r = s % 60;
    return m > 0 ? `${m}:${String(r).padStart(2, "0")}` : String(r);
  }

  function clampInt(n, a, b) {
    const x = Number(n);
    if (!Number.isFinite(x)) return a;
    return Math.max(a, Math.min(b, Math.floor(x)));
  }
  function clamp01(x) { return Math.max(0, Math.min(1, x)); }
  function randInt(a, b) { return Math.floor(a + Math.random() * (b - a + 1)); }

  function roundRect(ctx2, x, y, w, h, r) {
    const rr = Math.max(0, Math.min(r, Math.min(w, h) / 2));
    ctx2.beginPath();
    ctx2.moveTo(x + rr, y);
    ctx2.arcTo(x + w, y, x + w, y + h, rr);
    ctx2.arcTo(x + w, y + h, x, y + h, rr);
    ctx2.arcTo(x, y + h, x, y, rr);
    ctx2.arcTo(x, y, x + w, y, rr);
    ctx2.closePath();
  }

  function escapeHtml(s) {
    return String(s || "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }
  function escapeAttr(s) { return escapeHtml(s).replaceAll("`", "&#96;"); }

  function normalizeChat(t) { return String(t || "").trim().toLowerCase(); }

  function getChatTextFromMessage(msg) {
    return (msg?.comment || msg?.text || msg?.message || msg?.content || "").toString();
  }

  function getUserFromMessage(msg) {
    const userId = (msg?.userId || msg?.user?.userId || msg?.user?.id || msg?.uniqueId || msg?.id || "").toString();
    if (!userId) return null;

    const nickname = (msg?.nickname || msg?.user?.nickname || msg?.user?.uniqueId || msg?.uniqueId || "Viewer").toString();
    const pfp =
      (msg?.profilePictureUrl ||
        msg?.user?.profilePictureUrl ||
        msg?.user?.avatarUrl ||
        msg?.avatarUrl ||
        "").toString();

    return { userId, nickname, profilePictureUrl: pfp };
  }
})();
