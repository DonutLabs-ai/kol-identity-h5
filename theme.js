/* Donut skin runtime: theme toggle + the website's planet hero as the stage behind the landing and reveal.
   The React bundle owns #root; we only observe it and add presentation-only layers (aria-hidden). */
(function () {
  var root = document.documentElement;
  var KEY = "donut-identity-theme";
  var reduce = matchMedia("(prefers-reduced-motion: reduce)");

  /* ── theme toggle ── */
  function current() { return root.dataset.theme === "dark" ? "dark" : "light"; }
  function apply(t) {
    root.dataset.theme = t;
    try { localStorage.setItem(KEY, t); } catch (e) {}
    btn.setAttribute("aria-label", t === "dark" ? "Switch to light theme" : "Switch to dark theme");
  }
  var btn = document.createElement("button");
  btn.type = "button";
  btn.className = "donut-theme-toggle";
  btn.innerHTML =
    '<svg class="moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>' +
    '<svg class="sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
  btn.addEventListener("click", function () { apply(current() === "dark" ? "light" : "dark"); });
  document.body.appendChild(btn);
  apply(current());

  /* ── hero stage: planet loop behind .landing, poster behind .identity-reveal ── */
  var MEDIA = "./media/";
  function stage(host, withVideo) {
    // React reuses the <main> node between routes and only swaps its className, so a layer made for the
    // landing can find itself inside the reveal (or a flow page). Rebuild when the kind no longer matches.
    var kind = withVideo ? "video" : "poster";
    var existing = host.querySelector(":scope > .donut-hero-bg");
    if (existing && existing.dataset.kind === kind) return;
    if (existing) existing.remove();
    var bg = document.createElement("div");
    bg.className = "donut-hero-bg";
    bg.dataset.kind = kind;
    bg.setAttribute("aria-hidden", "true");
    if (withVideo && !reduce.matches) {
      var v = document.createElement("video");
      v.muted = true; v.loop = true; v.playsInline = true; v.autoplay = true; v.preload = "auto";
      v.setAttribute("muted", ""); v.setAttribute("playsinline", "");
      v.poster = MEDIA + "hero-poster.jpg";
      var s = document.createElement("source"); s.src = MEDIA + "hero-720.mp4"; s.type = "video/mp4";
      v.appendChild(s);
      v.addEventListener("loadedmetadata", function () { v.defaultPlaybackRate = 0.8; v.playbackRate = 0.8; });
      bg.appendChild(v);
      v.play().catch(function () {});
    } else {
      var img = document.createElement("img");
      img.src = MEDIA + "hero-poster.jpg"; img.alt = ""; img.decoding = "async";
      bg.appendChild(img);
    }
    host.prepend(bg);
  }
  /* ── intro FX: fx.js (three + postprocessing) listens for this and plays once per landing mount ── */
  function burst(landing) {
    var art = landing.querySelector(".hero-art");
    if (!art || art.dataset.fxPlayed) return;
    art.dataset.fxPlayed = "1";
    window.dispatchEvent(new CustomEvent("donut:landing", { detail: { art: art } }));
  }

  /* ── card tuning: size / y / tilt / copy bottom, per device class; auto-clamps so the card never covers the copy ── */
  var TKEY = "donut-identity-card-tune";
  var phone = function () { return innerWidth <= 760; };
  var DEFAULTS = { m: { zoom: 70, y: -63, tz: -6, ty: 12, copy: 22 }, d: { zoom: 70, y: 0, tz: -6, ty: 12, copy: 22 } };
  function loadTune() { try { return Object.assign(JSON.parse(JSON.stringify(DEFAULTS)), JSON.parse(localStorage.getItem(TKEY) || "{}")); } catch (e) { return JSON.parse(JSON.stringify(DEFAULTS)); } }
  var tune = loadTune();
  function saveTune() { try { localStorage.setItem(TKEY, JSON.stringify(tune)); } catch (e) {} }
  function cur() { return tune[phone() ? "m" : "d"]; }
  var clamped = false;
  function applyTune() {
    var landing = document.querySelector(".landing"); if (!landing) return;
    var t = cur();
    landing.style.setProperty("--card-zoom", String(t.zoom / 100));
    landing.style.setProperty("--card-y", t.y + "px");
    landing.style.setProperty("--tilt-z", t.tz + "deg");
    landing.style.setProperty("--tilt-y", t.ty + "deg");
    landing.style.setProperty("--copy-bottom", t.copy + "px");
    // never let the card sit on the copy: shrink until there is a 12px gap (phones stack them in one screen)
    clamped = false;
    var card = landing.querySelector(".hero-card"), h1 = landing.querySelector(".hero-copy h1");
    if (card && h1 && phone()) {
      for (var i = 0; i < 12; i++) {
        var c = card.getBoundingClientRect(), top = h1.getBoundingClientRect().top;
        if (c.bottom + 12 <= top) break;
        var z = parseFloat(landing.style.getPropertyValue("--card-zoom")) * ((top - 12 - c.top) / (c.bottom - c.top));
        landing.style.setProperty("--card-zoom", String(Math.max(0.4, Math.floor(z * 100) / 100)));
        clamped = true;
      }
    }
    if (panel) renderPanel();
  }
  var panel = null, tuneBtn = null;
  function renderPanel() {
    var t = cur();
    var fit = panel.querySelector(".fit");
    fit.textContent = clamped ? "Size clamped so the card clears the headline" : "Card clears the headline";
    if (clamped) fit.setAttribute("data-clamped", ""); else fit.removeAttribute("data-clamped");
    panel.querySelectorAll("input").forEach(function (inp) { inp.value = t[inp.name]; inp.previousElementSibling.textContent = t[inp.name] + inp.dataset.unit; });
  }
  function mountPanel() {
    tuneBtn = document.createElement("button"); tuneBtn.type = "button"; tuneBtn.className = "donut-tune-toggle"; tuneBtn.setAttribute("aria-label", "Card tuning");
    tuneBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/></svg>';
    panel = document.createElement("div"); panel.className = "donut-tune"; panel.setAttribute("role", "region"); panel.setAttribute("aria-label", "Card tuning");
    var fields = [["zoom", "Card size", "%", 40, 110, 1], ["y", "Card offset Y", "px", -160, 160, 1], ["tz", "Tilt", "°", -20, 20, 1], ["ty", "Turn (Y)", "°", -30, 30, 1], ["copy", "Copy bottom", "px", 0, 120, 1]];
    panel.innerHTML = "<h4>Card · " + (phone() ? "phone" : "desktop") + "</h4>" + fields.map(function (f) {
      return '<label><span>' + f[1] + '</span><span>' + cur()[f[0]] + f[2] + '</span><input type="range" name="' + f[0] + '" min="' + f[3] + '" max="' + f[4] + '" step="' + f[5] + '" data-unit="' + f[2] + '"></label>';
    }).join("") + '<p class="fit"></p><div class="row"><button type="button" data-act="reset">Reset</button><button type="button" data-act="copy">Copy CSS</button></div>';
    panel.addEventListener("input", function (e) {
      var inp = e.target; if (inp.tagName !== "INPUT") return;
      cur()[inp.name] = Number(inp.value); saveTune(); applyTune();
    });
    panel.addEventListener("click", function (e) {
      var act = e.target.getAttribute("data-act");
      if (act === "reset") { tune[phone() ? "m" : "d"] = JSON.parse(JSON.stringify(DEFAULTS[phone() ? "m" : "d"])); saveTune(); applyTune(); }
      if (act === "copy") {
        var t = cur(); var css = (phone() ? "@media (max-width: 760px) { .landing { " : ".landing { ") + "--card-zoom: " + (t.zoom / 100) + "; --card-y: " + t.y + "px; --tilt-z: " + t.tz + "deg; --tilt-y: " + t.ty + "deg; --copy-bottom: " + t.copy + "px; }" + (phone() ? " }" : "");
        navigator.clipboard && navigator.clipboard.writeText(css).then(function () { e.target.textContent = "Copied"; setTimeout(function () { e.target.textContent = "Copy CSS"; }, 1200); });
      }
    });
    tuneBtn.addEventListener("click", function () { panel.toggleAttribute("data-open"); renderPanel(); });
    document.body.appendChild(tuneBtn); document.body.appendChild(panel);
    if (new URLSearchParams(location.search).get("tune") === "1") panel.setAttribute("data-open", "");
    renderPanel();
  }
  function scan() {
    var landing = document.querySelector(".landing");
    if (landing) { stage(landing, true); burst(landing); if (!panel) mountPanel(); applyTune(); }
    if (panel) { panel.style.display = landing ? "" : "none"; if (tuneBtn) tuneBtn.style.display = landing ? "" : "none"; }
    var reveal = document.querySelector(".identity-reveal");
    if (reveal) stage(reveal, false);
    // Flow pages: drop any stage layer the reused <main> carried over (it would only keep a video decoding).
    document.querySelectorAll(".donut-hero-bg").forEach(function (bg) {
      var host = bg.parentElement;
      if (!host || !(host.classList.contains("landing") || host.classList.contains("identity-reveal"))) bg.remove();
    });
  }
  var target = document.getElementById("root") || document.body;
  new MutationObserver(scan).observe(target, { childList: true, subtree: true });
  scan();
  var rt; addEventListener("resize", function () { clearTimeout(rt); rt = setTimeout(applyTune, 120); });
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(applyTune);
})();
