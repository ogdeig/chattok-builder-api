<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover" />
  <title>{{TITLE}}</title>

  <!--
    IMPORTANT FIX:
    When this HTML runs inside iframe srcdoc (about:srcdoc), relative paths can resolve
    to the site root (/) due to parent base href handling.
    We force a local <base> using document.referrer (the parent page URL).
  -->
  <script>
    (function () {
      try {
        var ref = document.referrer;
        if (!ref && window.parent && window.parent.location) ref = window.parent.location.href;
        if (!ref) return;

        var u = new URL(ref);
        var dir = u.origin + u.pathname.replace(/[^\/]*$/, "");

        var base = document.createElement("base");
        base.href = dir;
        document.head.appendChild(base);
      } catch (e) {
        // non-fatal
        console.warn("Base href fix skipped:", e);
      }
    })();
  </script>

  <link rel="stylesheet" href="style.css" />
</head>

<body>
  <div id="app">

    <!-- ===============================
         START / SETUP OVERLAY
         =============================== -->
    <div id="setupOverlay" class="overlay">
      <div class="overlay-card">
        <h1 class="title">{{TITLE}}</h1>
        <p class="subtitle">{{SUBTITLE}}</p>

        <div id="assetWarning" class="status-line" style="display:none;color:rgba(255,160,160,.95)">
          Loading required scripts…
        </div>

        <!-- All setup inputs live in one consistent grid so nothing looks like a duplicate LIVE ID -->
        <div class="form-grid" id="setupFields">

          <label class="field field-span">
            <span class="field-label">TikTok LIVE ID (username only)</span>
            <input
              id="liveIdInput"
              type="text"
              placeholder="username (without @)"
              autocomplete="off"
              autocapitalize="none"
              spellcheck="false"
            />
          </label>

          <!--
            Server injects additional settings fields here.
            RULE: Do NOT inject another TikTok LIVE ID field.
          -->
          {{SETTINGS_FIELDS_HTML}}

        </div>

        <button id="startGameBtn" class="primary-btn">Connect &amp; Start Game</button>

        <p id="statusText" class="status-line">Not connected</p>

        <div class="hint">
          <div class="hint-title">How to play</div>
          <div class="hint-sub">{{ONE_SENTENCE}}</div>
          <ul class="hint-list">{{HOW_TO_PLAY_LI}}</ul>
          <div class="hint-sub muted">
            Tip: if connection fails, double-check your LIVE ID and try again.
          </div>
        </div>
      </div>
    </div>

    <!-- ===============================
         GAME SCREEN (9:16 VIEWPORT)
         =============================== -->
    <div id="gameScreen" class="game-screen">
      <div class="game-wrapper">

        <header class="topbar">
          <div class="topbar-left">
            <div class="game-name">{{TITLE}}</div>
            <div class="game-sub">{{SUBTITLE}}</div>
          </div>
          <div class="topbar-right">
            <span class="pill">Status: <span id="statusTextInGame" class="status-text">Disconnected</span></span>
          </div>
        </header>

        <main class="layout">
          <section class="main">
            <div class="viewport">
              <div class="safe-top"></div>
              <div id="gameRoot" class="game-root">
                <!-- game.js renders here -->
              </div>
              <div class="safe-bottom"></div>
            </div>
          </section>

          <aside class="side">
            <div class="side-card">
              <div class="side-title">Live Events</div>
              <div id="flags" class="flags"></div>
              <div class="side-foot">Chat / likes / gifts pop here.</div>
            </div>
          </aside>
        </main>

        <footer class="footer-text">
          Connection: <span id="statusTextFooter" class="status-text">Disconnected</span>
        </footer>
      </div>
    </div>

  </div>

  <!--
    PROTO + TIKTOK CLIENT LOADER (CRITICAL)
    - Fixes: proto.bundle.js 404 + "proto is not defined"
    - Works whether ChatTok injects scripts OR expects the game to load them.
    - Loads ONLY what is missing, then loads game.js last.
  -->
  <script>
    (function () {
      const warnEl = document.getElementById("assetWarning");
      function showWarn(msg) {
        try {
          if (!warnEl) return;
          warnEl.style.display = "";
          warnEl.textContent = msg;
        } catch {}
      }
      function hideWarn() {
        try {
          if (!warnEl) return;
          warnEl.style.display = "none";
        } catch {}
      }

      function getPreviewOrigin() {
        try {
          const ref = document.referrer || "";
          if (ref) return new URL(ref).origin;
        } catch {}
        try {
          return new URL(window.location.href).origin;
        } catch {}
        return "";
      }

      function loadScript(src) {
        return new Promise((resolve, reject) => {
          const s = document.createElement("script");
          s.src = src;
          s.async = false;
          s.onload = () => resolve(src);
          s.onerror = () => reject(new Error("Failed to load: " + src));
          document.head.appendChild(s);
        });
      }

      async function ensureProto() {
        if (window.proto) return true;

        const origin = getPreviewOrigin();
        const candidates = [
          // same-origin (most likely in preview)
          origin ? (origin + "/proto.bundle.js") : "",
          origin ? (origin + "/assets/proto.bundle.js") : "",
          origin ? (origin + "/js/proto.bundle.js") : "",
          origin ? (origin + "/scripts/proto.bundle.js") : "",

          // relative (if preview exposes alongside game files)
          "proto.bundle.js",

          // root-relative
          "/proto.bundle.js",
          "/assets/proto.bundle.js",
          "/js/proto.bundle.js",
          "/scripts/proto.bundle.js",
        ].filter(Boolean);

        for (const src of candidates) {
          try {
            await loadScript(src);
            if (window.proto) return true;
          } catch (e) {
            // try next
          }
        }
        return !!window.proto;
      }

      async function ensureTikTokClient() {
        if (typeof window.TikTokClient !== "undefined") return true;

        const origin = getPreviewOrigin();
        const candidates = [
          // same-origin (platform host)
          origin ? (origin + "/tiktok-client.js") : "",
          origin ? (origin + "/assets/tiktok-client.js") : "",
          origin ? (origin + "/js/tiktok-client.js") : "",
          origin ? (origin + "/scripts/tiktok-client.js") : "",

          // relative (if included with the uploaded game)
          "tiktok-client.js",

          // root-relative
          "/tiktok-client.js",
          "/assets/tiktok-client.js",
          "/js/tiktok-client.js",
          "/scripts/tiktok-client.js",
        ].filter(Boolean);

        for (const src of candidates) {
          try {
            await loadScript(src);
            if (typeof window.TikTokClient !== "undefined") return true;
          } catch (e) {
            // try next
          }
        }
        return (typeof window.TikTokClient !== "undefined");
      }

      async function boot() {
        showWarn("Loading required scripts…");

        // 1) Ensure proto exists (fixes: proto undefined)
        const protoOk = await ensureProto();
        if (!protoOk) {
          console.warn("proto is still undefined after load attempts.");
          showWarn("Missing proto.bundle.js in preview. Connection may fail.");
          // continue anyway so at least the UI renders
        }

        // 2) Ensure TikTokClient exists (don’t double-load if platform injects)
        const clientOk = await ensureTikTokClient();
        if (!clientOk) {
          console.error("TikTokClient is not available.");
          showWarn("TikTokClient missing in preview. Cannot connect.");
          return;
        }

        // 3) Load game.js last so it can safely bind to TikTokClient/proto
        try {
          await loadScript("game.js");
          hideWarn();
        } catch (e) {
          console.error(e);
          showWarn("Failed to load game.js (check preview path/base).");
        }
      }

      boot();
    })();
  </script>
</body>
</html>
