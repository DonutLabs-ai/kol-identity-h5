/* Donut website skin for Sean's KOL identity flow (app.js). Adds, without touching the React bundle:
   planet-video stage behind the landing and the result, card sizing that never covers the headline (with a
   tuning panel on ?tune=1), the opening card flick, cross-flare sparkles on the landing card, a step-complete
   edge pulse, and steadier background video. Sean's own EN / 中文 toggle stays; it is only restyled. */
(function () {
  "use strict";
  var reduce = matchMedia("(prefers-reduced-motion: reduce)");
  var phone = function () { return innerWidth <= 760; };
  var q = new URLSearchParams(location.search);

  /* ── hero stage: planet loop behind the landing (step-0), poster behind the result (step-3) ── */
  var MEDIA = "./media/";
  function stage(host, withVideo) {
    var kind = withVideo ? "video" : "poster";
    var existing = host.querySelector(":scope > .donut-hero-bg");
    if (existing && existing.dataset.kind === kind) return;
    if (existing) existing.remove();
    var bg = document.createElement("div");
    bg.className = "donut-hero-bg"; bg.dataset.kind = kind; bg.setAttribute("aria-hidden", "true");
    // poster sits underneath at all times, so a stalled or black frame never shows through
    var img = document.createElement("img");
    img.src = MEDIA + "hero-poster.jpg"; img.alt = ""; img.decoding = "async";
    bg.appendChild(img);
    if (withVideo && !reduce.matches) {
      var v = document.createElement("video");
      v.muted = true; v.loop = true; v.playsInline = true; v.autoplay = true; v.preload = "auto"; v.disableRemotePlayback = true;
      v.setAttribute("muted", ""); v.setAttribute("playsinline", ""); v.setAttribute("webkit-playsinline", "");
      var src = document.createElement("source"); src.src = MEDIA + "hero-720.mp4"; src.type = "video/mp4";
      v.appendChild(src);
      var hideT;
      function show() { clearTimeout(hideT); v.classList.add("is-playing"); }
      function hideSoon() { clearTimeout(hideT); hideT = setTimeout(function () { v.classList.remove("is-playing"); }, 1200); }
      v.addEventListener("playing", show); v.addEventListener("timeupdate", show);
      v.addEventListener("waiting", hideSoon); v.addEventListener("stalled", hideSoon);
      v.addEventListener("error", function () { v.classList.remove("is-playing"); });
      document.addEventListener("visibilitychange", function () { if (!document.hidden && v.isConnected) v.play().catch(function () {}); });
      bg.appendChild(v);
      v.play().catch(function () {});
    }
    host.prepend(bg);
  }
  function clearStage(host) { var e = host && host.querySelector(":scope > .donut-hero-bg"); if (e) e.remove(); }

  /* ── card tuning: size / y / tilt / copy gap per device class; clamps so the card never covers the headline ── */
  var TKEY = "donut-identity-card-tune";
  var DEFAULTS = { m: { zoom: 78, y: 0, tz: -6, ty: 12, copy: 22 }, d: { zoom: 100, y: 0, tz: -6, ty: 12, copy: 22 },
                   card: { px: 50, py: 0, pz: 100, ink: 100, bg: 55 } };
  function loadTune() { try { return Object.assign(JSON.parse(JSON.stringify(DEFAULTS)), JSON.parse(localStorage.getItem(TKEY) || "{}")); } catch (e) { return JSON.parse(JSON.stringify(DEFAULTS)); } }
  var tune = loadTune();
  function saveTune() { try { localStorage.setItem(TKEY, JSON.stringify(tune)); } catch (e) {} }
  function cur() { return tune[phone() ? "m" : "d"]; }
  var CARD_FIELDS = { px: 1, py: 1, pz: 1, ink: 1, bg: 1 };
  function bag(name) { return CARD_FIELDS[name] ? tune.card : cur(); }
  // card-face values go into the embedded flashcard as CSS vars (same origin)
  function applyFlash() {
    var c = tune.card;
    document.querySelectorAll(".card-frame iframe").forEach(function (f) {
      try {
        var st = f.contentDocument && f.contentDocument.documentElement.style; if (!st) return;
        st.setProperty("--photo-pos", c.px + "% " + c.py + "%"); st.setProperty("--photo-zoom", String(c.pz / 100));
        st.setProperty("--notch-ink", String(c.ink / 100)); st.setProperty("--notch-bg", String(c.bg / 100));
      } catch (e) {}
    });
  }
  var clamped = false, tuneKey = "";
  function applyTune(force) {
    var hero = document.querySelector(".hero"); if (!hero) return;
    var key = innerWidth + "x" + innerHeight + "|" + JSON.stringify(tune);
    if (!force && key === tuneKey && hero.style.getPropertyValue("--card-zoom")) { applyFlash(); return; }
    tuneKey = key;
    var t = cur();
    hero.style.setProperty("--card-zoom", String(t.zoom / 100));
    hero.style.setProperty("--card-y", t.y + "px");
    hero.style.setProperty("--tilt-z", t.tz + "deg");
    hero.style.setProperty("--tilt-y", t.ty + "deg");
    hero.style.setProperty("--copy-bottom", t.copy + "px");
    applyFlash();
    clamped = false;
    var card = hero.querySelector(".hero-studio .card-frame"), h1 = hero.querySelector("h1");
    // measure at the settled pose: finite animations jump to their end, the idle float to its resting frame
    var running = hero.getAnimations ? hero.getAnimations({ subtree: true }).filter(function (a) { return a.playState !== "finished"; }) : [];
    var saved = running.map(function (a) { return a.currentTime; });
    running.forEach(function (a) { try { var tm = a.effect.getComputedTiming(); a.currentTime = tm.iterations === Infinity ? 0 : tm.endTime; } catch (e) {} });
    if (card && h1 && phone()) {
      for (var i = 0; i < 12; i++) {
        var c = card.getBoundingClientRect(), top = h1.getBoundingClientRect().top;
        if (c.bottom + 16 <= top) break;
        var z = parseFloat(hero.style.getPropertyValue("--card-zoom")) * ((top - 16 - c.top) / (c.bottom - c.top));
        hero.style.setProperty("--card-zoom", String(Math.max(0.4, Math.floor(z * 100) / 100)));
        clamped = true;
      }
    }
    running.forEach(function (a, i) { try { a.currentTime = saved[i]; } catch (e) {} });
    if (panel) renderPanel();
  }
  var panel = null, tuneBtn = null;
  function renderPanel() {
    var fit = panel.querySelector(".fit");
    fit.textContent = clamped ? "Size clamped so the card clears the headline" : "Card clears the headline";
    if (clamped) fit.setAttribute("data-clamped", ""); else fit.removeAttribute("data-clamped");
    panel.querySelector("h4").textContent = "Card · " + (phone() ? "phone" : "desktop");
    panel.querySelectorAll("input").forEach(function (inp) { var v = bag(inp.name)[inp.name]; inp.value = v; inp.previousElementSibling.textContent = v + inp.dataset.unit; });
  }
  function mountPanel() {
    if (panel) return;
    tuneBtn = document.createElement("button"); tuneBtn.type = "button"; tuneBtn.className = "donut-tune-toggle"; tuneBtn.setAttribute("aria-label", "Card tuning");
    tuneBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/></svg>';
    panel = document.createElement("div"); panel.className = "donut-tune"; panel.setAttribute("role", "region"); panel.setAttribute("aria-label", "Card tuning");
    var fields = [["zoom", "Card size", "%", 40, 120, 1], ["y", "Card offset Y", "px", -160, 160, 1], ["tz", "Tilt", "°", -20, 20, 1], ["ty", "Turn (Y)", "°", -30, 30, 1], ["copy", "Copy bottom", "px", 0, 120, 1],
                  ["px", "Portrait X", "%", 0, 100, 1], ["py", "Portrait Y", "%", 0, 100, 1], ["pz", "Portrait zoom", "%", 100, 180, 1], ["ink", "Label ink", "%", 20, 100, 1], ["bg", "Label backing", "%", 0, 100, 1]];
    panel.innerHTML = "<h4></h4>" + fields.map(function (f) {
      return '<label><span>' + f[1] + '</span><span></span><input type="range" name="' + f[0] + '" min="' + f[3] + '" max="' + f[4] + '" step="' + f[5] + '" data-unit="' + f[2] + '"></label>';
    }).join("") + '<p class="fit"></p><div class="row"><button type="button" data-act="reset">Reset</button><button type="button" data-act="copy">Copy CSS</button></div>';
    panel.addEventListener("input", function (e) {
      var inp = e.target; if (inp.tagName !== "INPUT") return;
      var v = Number(inp.value); if (!isFinite(v)) return;
      bag(inp.name)[inp.name] = v; saveTune(); applyTune(true);
    });
    panel.addEventListener("click", function (e) {
      var act = e.target.getAttribute("data-act");
      if (act === "reset") { tune[phone() ? "m" : "d"] = JSON.parse(JSON.stringify(DEFAULTS[phone() ? "m" : "d"])); tune.card = JSON.parse(JSON.stringify(DEFAULTS.card)); saveTune(); applyTune(true); }
      if (act === "copy") {
        var t = cur(); var css = (phone() ? "@media (max-width: 760px) { .hero { " : ".hero { ") + "--card-zoom: " + (t.zoom / 100) + "; --card-y: " + t.y + "px; --tilt-z: " + t.tz + "deg; --tilt-y: " + t.ty + "deg; --copy-bottom: " + t.copy + "px; }" + (phone() ? " }" : "") +
          "\n/* card face */ .card-frame iframe { --photo-pos: " + tune.card.px + "% " + tune.card.py + "%; --photo-zoom: " + (tune.card.pz / 100) + "; --notch-ink: " + (tune.card.ink / 100) + "; --notch-bg: " + (tune.card.bg / 100) + "; }";
        navigator.clipboard && navigator.clipboard.writeText(css).then(function () { e.target.textContent = "Copied"; setTimeout(function () { e.target.textContent = "Copy CSS"; }, 1200); });
      }
    });
    tuneBtn.addEventListener("click", function () { panel.toggleAttribute("data-open"); renderPanel(); });
    document.body.appendChild(tuneBtn); document.body.appendChild(panel);
    if (q.get("tune") === "1") { document.body.setAttribute("data-tools", ""); panel.setAttribute("data-open", ""); }
    renderPanel();
  }

  /* ── landing card: cross-flare sparkles sized to the ticket inside the iframe ── */
  function mountShine(card) {
    if (!card || card.querySelector(":scope > .donut-shine")) return;
    var sh = document.createElement("div"); sh.className = "donut-shine"; sh.setAttribute("aria-hidden", "true");
    sh.innerHTML = "<i></i><i></i><i></i><i></i>"; card.appendChild(sh);
  }

  /* ── step-complete pulse: a warm inner glow at the screen edge when the flow advances ── */
  var pulse = null, lastStep = -1;
  function stepPulse(step) {
    if (step > lastStep && lastStep >= 0 && step > 0 && !reduce.matches) {
      if (!pulse) { pulse = document.createElement("div"); pulse.className = "donut-pulse"; pulse.setAttribute("aria-hidden", "true"); document.body.appendChild(pulse); }
      pulse.classList.remove("is-on"); void pulse.offsetWidth; pulse.classList.add("is-on");
    }
    lastStep = step;
  }

  var ARCHETYPES = ["Diamond Hands", "DCA Believer", "Risk Explorer", "Day Trader", "Sniper", "Grid Executor", "Swing Hunter", "Momentum Rider", "Arb Researcher", "Narrative Trader", "Risk-First", "Contrarian"];

  /* ── result: the other eleven trader types, locked, under the card and copy (Cory 2026-09-29) ── */
  var ARCHETYPE_FILES = ["01-diamond-hands", "02-dca-believer", "03-risk-explorer", "04-day-trader", "05-sniper", "06-grid-executor", "07-swing-hunter", "08-momentum-rider", "09-arb-researcher", "10-narrative-trader", "11-risk-first", "12-contrarian"];
  function mountLocked(main) {
    var ws = main.querySelector(".workspace"); if (!ws || ws.querySelector(":scope > .donut-locked")) return;
    var zh = (document.documentElement.lang || "").toLowerCase().indexOf("zh") === 0;
    var title = (main.querySelector(".result-panel h2") || {}).textContent || "";
    var mine = ARCHETYPES.findIndex(function (t) { return title.toLowerCase().replace(/[^a-z]/g, "").indexOf(t.toLowerCase().replace(/[^a-z]/g, "")) !== -1; });
    var box = document.createElement("section"); box.className = "donut-locked"; box.setAttribute("aria-label", zh ? "其他交易人格" : "Other trader types");
    var head = document.createElement("div"); head.className = "donut-locked-head";
    head.innerHTML = "<h3>" + (zh ? "其他交易人格" : "Other trader types") + "</h3><p>" + (zh ? "邀请朋友测试，解锁他们的卡片。" : "Invite friends to test; each one unlocks their card.") + "</p>";
    var row = document.createElement("div"); row.className = "donut-locked-row";
    var lock = '<span class="lock"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>' + (zh ? "待解锁" : "Locked") + "</span>";
    ARCHETYPES.forEach(function (t, i) {
      if (i === mine) return;
      var c = document.createElement("div"); c.className = "donut-locked-card";
      c.innerHTML = '<img alt="" loading="lazy" decoding="async">' + lock + '<span class="name">' + t + "</span>";
      c.querySelector("img").src = new URL("img/archetypes/" + ARCHETYPE_FILES[i] + ".jpg", location.href).href;
      row.appendChild(c);
    });
    box.appendChild(head); box.appendChild(row); ws.appendChild(box);
  }
  /* ── route scan: Sean's <main class="app step-N"> carries the step ── */
  function currentStep() { var m = document.querySelector("main.app"); if (!m) return -1; var mm = /step-(\d)/.exec(m.className); return mm ? Number(mm[1]) : -1; }
  function scan() {
    var main = document.querySelector("main.app"); if (!main) return;
    var step = currentStep();
    if (document.documentElement.getAttribute("data-step") !== String(step)) document.documentElement.setAttribute("data-step", String(step));
    if (step === 0) { stage(main, true); mountPanel(); mountShine(main.querySelector(".hero-studio .card-frame")); applyTune(); }
    else if (step === 3) { stage(main, false); mountLocked(main); }
    else clearStage(main);
    var show = step === 0 ? "" : "none";
    if (tuneBtn && tuneBtn.style.display !== show) tuneBtn.style.display = show;
    if (panel && panel.style.display !== show) panel.style.display = show;
    // the flashcard iframe inside the studio: make sure the card-face vars land once it has loaded
    document.querySelectorAll(".card-frame iframe").forEach(function (f) { if (!f.dataset.donutHooked) { f.dataset.donutHooked = "1"; f.addEventListener("load", applyFlash); } });
    stepPulse(step);
  }

  /* ── opening: the twelve card faces flick past at full size, settle into an upright ring, the title lands.
        Every load; ?intro=0 skips, reduced-motion skips, any tap skips. ── */
  (function intro() {
    if (q.get("intro") === "0") return;
    if (q.get("intro") !== "1" && reduce.matches) return;
    document.documentElement.setAttribute("data-intro", "");
    var root = document.createElement("div"); root.className = "donut-intro"; root.setAttribute("role", "presentation");
    root.innerHTML = '<div class="donut-intro-ring"></div><div class="donut-intro-copy"><h1>Test your Trading Personality on Donut D0</h1><p>presented by DonutAI</p></div>';
    var ring = root.querySelector(".donut-intro-ring");
    var W = innerWidth, H = innerHeight, ph = W <= 760;
    var CW = ph ? Math.min(340, W - 40) : 380, CH = Math.round(CW * 550 / 380);
    root.style.setProperty("--cw", CW + "px"); root.style.setProperty("--ch", CH + "px");
    var imgs = [];
    var cards = ARCHETYPES.map(function (t, i) {
      var o = document.createElement("div"); o.className = "donut-intro-orbit";
      var c = document.createElement("div"); c.className = "donut-intro-card";
      var img = document.createElement("img"); img.alt = t; img.decoding = "async";
      img.src = new URL("img/intro/" + String(i + 1).padStart(2, "0") + "-" + t.toLowerCase().replace(/[^a-z]+/g, "-") + ".webp", location.href).href;
      c.appendChild(img); imgs.push(img); o.appendChild(c); ring.appendChild(o); return o;
    });
    var slot = ph ? 54 : 84, sc = slot / CW;
    var ringY = ph ? H * .40 : H * .5;
    var R = ph ? Math.min(W / 2 - slot / 2 - 14, ringY - CH * sc / 2 - 24) : Math.min(W, H) * .40 - CH * sc / 2;
    root.style.setProperty("--ring-y", ringY + "px");
    if (ph) { root.style.setProperty("--copy-y", (ringY + R + CH * sc / 2 + 32) + "px"); root.style.setProperty("--copy-shift", "0"); root.style.setProperty("--copy-w", "320px"); }
    else { root.style.setProperty("--copy-y", ringY + "px"); root.style.setProperty("--copy-shift", "-50%"); root.style.setProperty("--copy-w", Math.round((R - CH * sc / 2) * 2 * .86) + "px"); }
    document.body.appendChild(root);
    var timers = [], done = false;
    function finish() {
      if (done) return; done = true;
      timers.forEach(clearTimeout);
      root.classList.add("is-out");
      document.documentElement.removeAttribute("data-intro");
      applyTune(true);
      setTimeout(function () { root.remove(); }, 700);
    }
    root.addEventListener("click", finish);
    var STAGGER = 260, FLY = 1350, flyY = ph ? H * .44 : H * .5;
    function run() {
      var from = "translate(" + Math.round(W / 2 + CW) + "px, " + Math.round(flyY) + "px) rotate(4deg)";
      var to = "translate(" + Math.round(-W / 2 - CW) + "px, " + Math.round(flyY) + "px) rotate(-4deg)";
      var fly = cards.map(function (c, i) {
        return c.animate([{ transform: from, opacity: 0 }, { opacity: 1, offset: .1 }, { opacity: 1, offset: .9 }, { transform: to, opacity: 0 }],
          { duration: FLY, delay: i * STAGGER, easing: "cubic-bezier(.35,.55,.2,1)", fill: "both" });
      });
      var settleAt = (cards.length - 1) * STAGGER + FLY - 320;
      timers.push(setTimeout(function () {
        cards.forEach(function (c, i) {
          var a = -90 + i * 30, rad = a * Math.PI / 180, x = Math.cos(rad) * R, y = Math.sin(rad) * R;
          try { fly[i].cancel(); } catch (e) {}
          c.animate([{ transform: "translate(" + (x * 2.6).toFixed(1) + "px, " + (y * 2.6).toFixed(1) + "px) rotate(-30deg) scale(" + (sc * .6).toFixed(3) + ")", opacity: 0 },
                     { transform: "translate(" + x.toFixed(1) + "px, " + y.toFixed(1) + "px) scale(" + sc.toFixed(3) + ")", opacity: 1 }],
            { duration: 900, delay: i * 45, easing: "cubic-bezier(.2,.8,.2,1)", fill: "both" });
        });
        ring.classList.add("is-ring"); root.classList.add("is-titled");
      }, settleAt));
      timers.push(setTimeout(finish, settleAt + 3000));
    }
    var ready = Promise.all(imgs.slice(0, 4).map(function (im) { return im.decode ? im.decode().catch(function () {}) : Promise.resolve(); }));
    Promise.race([ready, new Promise(function (r) { setTimeout(r, 1200); })]).then(run);
  })();

  var target = document.getElementById("root") || document.body;
  new MutationObserver(function () { scan(); }).observe(target, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });
  scan();
  var rt; addEventListener("resize", function () { clearTimeout(rt); rt = setTimeout(function () { applyTune(true); }, 120); });
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () { applyTune(true); });
})();
