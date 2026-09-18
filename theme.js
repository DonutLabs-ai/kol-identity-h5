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
  /* ── card tuning: size / y / tilt / copy bottom, per device class; auto-clamps so the card never covers the copy ── */
  var TKEY = "donut-identity-card-tune";
  var phone = function () { return innerWidth <= 760; };
  var DEFAULTS = { m: { zoom: 82, y: -30, tz: -6, ty: 12, copy: 22 }, d: { zoom: 90, y: 0, tz: -6, ty: 12, copy: 22 },
                   card: { px: 50, py: 0, pz: 100, ink: 100, bg: 55 } };   // card face (portrait crop + notch label) is shared by phone/desktop   // the flashcard is narrower than the old card
  function loadTune() { try { return Object.assign(JSON.parse(JSON.stringify(DEFAULTS)), JSON.parse(localStorage.getItem(TKEY) || "{}")); } catch (e) { return JSON.parse(JSON.stringify(DEFAULTS)); } }
  var tune = loadTune();
  function saveTune() { try { localStorage.setItem(TKEY, JSON.stringify(tune)); } catch (e) {} }
  function cur() { return tune[phone() ? "m" : "d"]; }
  var CARD_FIELDS = { px: 1, py: 1, pz: 1, ink: 1, bg: 1 };
  function bag(name) { return CARD_FIELDS[name] ? tune.card : cur(); }
  // push the card-face values into every embedded flashcard (same origin, so CSS vars on its <html>)
  function applyFlash() {
    var c = tune.card;
    document.querySelectorAll(".donut-flash").forEach(function (f) {
      try {
        var st = f.contentDocument && f.contentDocument.documentElement.style; if (!st) return;
        st.setProperty("--photo-pos", c.px + "% " + c.py + "%");
        st.setProperty("--photo-zoom", String(c.pz / 100));
        st.setProperty("--notch-ink", String(c.ink / 100));
        st.setProperty("--notch-bg", String(c.bg / 100));
      } catch (e) {}
    });
  }
  var clamped = false;
  function applyTune() {
    var landing = document.querySelector(".landing"); if (!landing) return;
    var t = cur();
    landing.style.setProperty("--card-zoom", String(t.zoom / 100));
    landing.style.setProperty("--card-y", t.y + "px");
    landing.style.setProperty("--tilt-z", t.tz + "deg");
    landing.style.setProperty("--tilt-y", t.ty + "deg");
    landing.style.setProperty("--copy-bottom", t.copy + "px");
    applyFlash();
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
    panel.querySelectorAll("input").forEach(function (inp) { var v = bag(inp.name)[inp.name]; inp.value = v; inp.previousElementSibling.textContent = v + inp.dataset.unit; });
  }
  function mountPanel() {
    tuneBtn = document.createElement("button"); tuneBtn.type = "button"; tuneBtn.className = "donut-tune-toggle"; tuneBtn.setAttribute("aria-label", "Card tuning");
    tuneBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/></svg>';
    panel = document.createElement("div"); panel.className = "donut-tune"; panel.setAttribute("role", "region"); panel.setAttribute("aria-label", "Card tuning");
    var fields = [["zoom", "Card size", "%", 40, 110, 1], ["y", "Card offset Y", "px", -160, 160, 1], ["tz", "Tilt", "°", -20, 20, 1], ["ty", "Turn (Y)", "°", -30, 30, 1], ["copy", "Copy bottom", "px", 0, 120, 1],
                  ["px", "Portrait X", "%", 0, 100, 1], ["py", "Portrait Y", "%", 0, 100, 1], ["pz", "Portrait zoom", "%", 100, 180, 1],
                  ["ink", "Label ink", "%", 20, 100, 1], ["bg", "Label backing", "%", 0, 100, 1]];
    panel.innerHTML = "<h4>Card · " + (phone() ? "phone" : "desktop") + "</h4>" + fields.map(function (f) {
      return '<label><span>' + f[1] + '</span><span>' + bag(f[0])[f[0]] + f[2] + '</span><input type="range" name="' + f[0] + '" min="' + f[3] + '" max="' + f[4] + '" step="' + f[5] + '" data-unit="' + f[2] + '"></label>';
    }).join("") + '<p class="fit"></p><div class="row"><button type="button" data-act="reset">Reset</button><button type="button" data-act="copy">Copy CSS</button></div>';
    panel.addEventListener("input", function (e) {
      var inp = e.target; if (inp.tagName !== "INPUT") return;
      bag(inp.name)[inp.name] = Number(inp.value); saveTune(); applyTune();
    });
    panel.addEventListener("click", function (e) {
      var act = e.target.getAttribute("data-act");
      if (act === "reset") { tune[phone() ? "m" : "d"] = JSON.parse(JSON.stringify(DEFAULTS[phone() ? "m" : "d"])); tune.card = JSON.parse(JSON.stringify(DEFAULTS.card)); saveTune(); applyTune(); }
      if (act === "copy") {
        var t = cur(); var css = (phone() ? "@media (max-width: 760px) { .landing { " : ".landing { ") + "--card-zoom: " + (t.zoom / 100) + "; --card-y: " + t.y + "px; --tilt-z: " + t.tz + "deg; --tilt-y: " + t.ty + "deg; --copy-bottom: " + t.copy + "px; }" + (phone() ? " }" : "") + "\n/* card face */ .donut-flash { --photo-pos: " + tune.card.px + "% " + tune.card.py + "%; --photo-zoom: " + (tune.card.pz / 100) + "; --notch-ink: " + (tune.card.ink / 100) + "; --notch-bg: " + (tune.card.bg / 100) + "; }";
        navigator.clipboard && navigator.clipboard.writeText(css).then(function () { e.target.textContent = "Copied"; setTimeout(function () { e.target.textContent = "Copy CSS"; }, 1200); });
      }
    });
    tuneBtn.addEventListener("click", function () { panel.toggleAttribute("data-open"); renderPanel(); });
    document.body.appendChild(tuneBtn); document.body.appendChild(panel);
    if (new URLSearchParams(location.search).get("tune") === "1") panel.setAttribute("data-open", "");
    renderPanel();
  }
  /* ── Share / Save hand off to Yi's flashcard (public/flashcard/kol.html): the straight, front-facing card.
        The artifact's own share modal / PNG export are bypassed (capture-phase listener runs before React). ── */
  var CARD_BASE = window.DONUT_CARD_BASE || "https://donut-kol-card.vercel.app/flashcard/kol";
  function cardUrl() {
    var name = (document.querySelector(".reveal-card-mount .card-profile > h2") || {}).textContent || "Trader";
    var type = ((document.querySelector(".reveal-copy h1") || {}).textContent || "").replace(/\.$/, "").trim();
    var img = document.querySelector(".reveal-card-mount .portrait > img");
    var q = new URLSearchParams({ user: name.trim(), type: type, code: "Donut2026", bare: "1" });
    if (img && /^https?:/.test(img.src)) q.set("img", img.src);      // real URLs only (data URLs would not fit a link)
    else q.set("img", new URL("img/preview-portrait.jpg", location.href).href);   // the approved placeholder portrait
    return CARD_BASE + "?" + q.toString();
  }
  document.addEventListener("click", function (e) {
    var share = e.target.closest && e.target.closest(".reveal-actions .reveal-share");
    var save = e.target.closest && e.target.closest(".reveal-actions .secondary");
    if (!share && !save) return;
    e.preventDefault(); e.stopPropagation();
    var url = cardUrl();
    if (share) {
      var type = ((document.querySelector(".reveal-copy h1") || {}).textContent || "").replace(/\.$/, "").trim();
      var payload = { title: "My Donut trading identity", text: "My Donut trading identity: " + type + ". Find yours →", url: url };
      if (navigator.share) navigator.share(payload).catch(function () {});
      else if (navigator.clipboard) navigator.clipboard.writeText(url).then(function () { toast("Card link copied"); });
      else window.open(url, "_blank", "noopener");
    } else {
      window.open(url, "_blank", "noopener");                          // the flashcard page: save it from there
    }
  }, true);
  function toast(msg) {
    var t = document.createElement("div"); t.className = "toast"; t.textContent = msg; document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, 2200);
  }

  /* ── Yi's flashcard replaces the artifact card: same-origin iframe of ../flashcard/kol.html?embed=1 ── */
  var FLASH_SRC = "../flashcard/kol.html";
  function flashParams(user, type, img) {
    var q = new URLSearchParams({ embed: "1", bare: "1", lang: "en", user: user, type: type, code: "Donut2026" });
    if (img && /^https?:/.test(img)) q.set("img", img);
    return q.toString();
  }
  function mountFlash(host, user, type, img) {
    if (!host) return;
    var existing = host.querySelector(":scope > .donut-flash");
    var key = user + "|" + type + "|" + (img || "").slice(0, 64);
    if (existing && existing.dataset.key === key) return;
    if (existing) existing.remove();
    var f = document.createElement("iframe");
    f.className = "donut-flash"; f.dataset.key = key; f.title = "Your Donut identity card";
    f.setAttribute("aria-label", "Your Donut identity card"); f.loading = "eager"; f.scrolling = "no";
    f.width = "396"; f.height = "590";   // 380×550 ticket + notch + tilt room
    f.src = FLASH_SRC + "?" + flashParams(user, type, /^https?:/.test(img || "") ? img : "");
    f.addEventListener("load", function () {
      if (img && /^data:/.test(img)) { try { var ph = f.contentDocument.querySelector(".kol-photo img"); if (ph) ph.src = img; } catch (e) {} }   // uploaded photo: same-origin, set directly
      applyFlash();
    });
    host.classList.add("has-flash");
    host.appendChild(f);
  }
  function flashSync() {
    var portrait = new URL("img/preview-portrait.jpg", location.href).href;
    var landingCard = document.querySelector(".landing .hero-card");
    if (landingCard) mountFlash(landingCard, "Donut Trader", "Diamond Hands", portrait);
    var mount = document.querySelector(".reveal-card-mount");
    if (mount) {
      var name = ((mount.querySelector(".card-profile > h2") || {}).textContent || "Trader").trim();
      var type = ((document.querySelector(".reveal-copy h1") || {}).textContent || "").replace(/\.$/, "").trim();
      var up = mount.querySelector(".portrait > img");
      mountFlash(mount, name, type || "Diamond Hands", up ? up.src : portrait);
    }
  }

  /* ── card face declutter: clone referral code into the top bar and the name into the footer (React owns the
        originals, so they are hidden by CSS rather than moved) ── */
  function decorateCard(card) {
    var ref = card.querySelector(".card-referral b"), top = card.querySelector(".card-top");
    if (ref && top && !top.querySelector(".donut-ref")) { var r = document.createElement("span"); r.className = "donut-ref"; r.textContent = ref.textContent.trim(); top.appendChild(r); }
    var name = card.querySelector(".card-profile > h2"), foot = card.querySelector(".card-footer > div");
    if (name && foot) {
      var n = foot.querySelector(".donut-name");
      if (!n) { n = document.createElement("span"); n.className = "donut-name"; foot.prepend(n); }
      if (n.textContent !== name.textContent) n.textContent = name.textContent;
    }
    var handle = card.querySelector(".card-handle");
    if (handle) handle.classList.toggle("is-unlinked", /not linked/i.test(handle.textContent));
  }
  function scan() {
    document.querySelectorAll(".identity-card").forEach(decorateCard);
    flashSync();
    var landing = document.querySelector(".landing");
    if (landing) { stage(landing, true); if (!panel) mountPanel(); applyTune(); }
    if (panel) { panel.style.display = landing ? "" : "none"; if (tuneBtn) tuneBtn.style.display = landing ? "" : "none"; }
    var reveal = document.querySelector(".identity-reveal");
    if (reveal) {
      stage(reveal, false); tapHint();
      var mine = reveal.querySelector(".spectrum-type.is-yours");
      if (mine && !mine.dataset.shown) { mine.dataset.shown = "1"; setTimeout(function () {
        var row = mine.parentElement; if (!row) return;   // scroll the row itself, never the page
        row.scrollTo({ left: mine.offsetLeft - (row.clientWidth - mine.offsetWidth) / 2, behavior: "smooth" });
      }, 1200); }
      autoScroll(reveal.querySelector(".spectrum-grid"));
    }
    // Flow pages: drop any stage layer the reused <main> carried over (it would only keep a video decoding).
    document.querySelectorAll(".donut-hero-bg").forEach(function (bg) {
      var host = bg.parentElement;
      if (!host || !(host.classList.contains("landing") || host.classList.contains("identity-reveal"))) bg.remove();
    });
  }
  /* ── reveal: tap the card to flip it (drives the artifact's hidden Identity/Style switch) ── */
  document.addEventListener("click", function (e) {
    var mount = e.target.closest && e.target.closest(".reveal-card-mount");
    if (!mount || mount.classList.contains("is-flipping") || mount.classList.contains("has-flash")) return;
    var next = Array.prototype.find.call(document.querySelectorAll(".reveal-card-controls button"), function (b) { return !b.classList.contains("active"); });
    if (!next) return;
    mount.classList.add("is-flipping");
    setTimeout(function () {
      next.click();
      requestAnimationFrame(function () {
        mount.classList.remove("is-flipping"); mount.classList.add("is-flipping-in");
        setTimeout(function () { mount.classList.remove("is-flipping-in"); }, 340);
      });
    }, 300);
  });
  function tapHint() {
    var sc = document.querySelector(".reveal-showcase");
    if (!sc || sc.querySelector(".reveal-tap")) return;
    var hint = document.createElement("span"); hint.className = "reveal-tap"; hint.textContent = "Tap the card to flip";
    var mount = sc.querySelector(".reveal-card-mount"); (mount || sc).insertAdjacentElement("afterend", hint);
  }

  /* ── portrait: the avatar circle is the upload button ── */
  document.addEventListener("click", function (e) {
    var pv = e.target.closest && e.target.closest(".avatar-preview");
    if (pv) { var inp = document.querySelector(".upload-button input[type=file]"); if (inp) inp.click(); }
  });

  /* ── card pseudo-3D: pointer (or idle sway) drives tilt + glare vars on every visible card face ── */
  var faces = [];          // { el, tx, ty, gx, gy }
  var pointer = null, lastMove = 0;
  function collectFaces() {
    faces = Array.prototype.map.call(document.querySelectorAll(".hero-card > .identity-card, .reveal-card-mount .identity-card"), function (el) {
      if (!el.querySelector(":scope > .donut-glare")) { var g = document.createElement("div"); g.className = "donut-glare"; g.setAttribute("aria-hidden", "true"); el.appendChild(g); }
      return { el: el, tx: 0, ty: 0, gx: 50, gy: 50 };
    });
  }
  addEventListener("pointermove", function (e) { pointer = { x: e.clientX, y: e.clientY }; lastMove = performance.now(); }, { passive: true });
  addEventListener("pointerleave", function () { pointer = null; });
  var lerp = function (a, b, k) { return a + (b - a) * k; };
  function tiltFrame(now) {
    if (!reduce.matches) for (var i = 0; i < faces.length; i++) {
      var f = faces[i], r = f.el.getBoundingClientRect(); if (!r.width) continue;
      var nx, ny;
      if (pointer && now - lastMove < 2500) {
        // normalised offset from the card centre, softened beyond the card so far-away pointers only nudge it
        var dx = (pointer.x - (r.left + r.width / 2)) / r.width, dy = (pointer.y - (r.top + r.height / 2)) / r.height;
        var d = Math.hypot(dx, dy), soft = d > 0.5 ? 0.5 / d : 1;
        nx = Math.max(-1, Math.min(1, dx * 2)) * soft; ny = Math.max(-1, Math.min(1, dy * 2)) * soft;
      } else { // idle: slow figure-eight sway so the foil never sits dead
        nx = Math.sin(now / 1900) * 0.35; ny = Math.cos(now / 2600) * 0.28;
      }
      f.tx = lerp(f.tx, -ny * 9, 0.12); f.ty = lerp(f.ty, nx * 11, 0.12);
      f.gx = lerp(f.gx, 50 + nx * 38, 0.12); f.gy = lerp(f.gy, 50 + ny * 38, 0.12);
      var st = f.el.style;
      st.setProperty("--tx", f.tx.toFixed(2) + "deg"); st.setProperty("--ty", f.ty.toFixed(2) + "deg");
      st.setProperty("--gx", f.gx.toFixed(1) + "%"); st.setProperty("--gy", f.gy.toFixed(1) + "%");
      st.setProperty("--gp", (50 - nx * 45).toFixed(1) + "%"); st.setProperty("--ga", (115 + nx * 25).toFixed(1) + "deg");
    }
    requestAnimationFrame(tiltFrame);
  }
  requestAnimationFrame(tiltFrame);

  /* ── step-complete pulse: glow from the screen edges whenever the flow advances ── */
  var pulse = document.createElement("div"); pulse.className = "donut-pulse"; pulse.setAttribute("aria-hidden", "true"); document.body.appendChild(pulse);
  var lastStep = -1;
  function currentStep() {
    if (document.querySelector(".identity-reveal")) return 4;
    var btns = document.querySelectorAll(".steps button");
    for (var i = 0; i < btns.length; i++) if (btns[i].classList.contains("active")) return i + 1;
    return document.querySelector(".landing") ? 0 : lastStep;
  }
  function stepPulse() {
    var s = currentStep();
    if (s > lastStep && lastStep >= 0) { pulse.classList.remove("is-on"); void pulse.offsetWidth; pulse.classList.add("is-on"); }
    lastStep = s;
  }

  /* ── archetype row: drifts sideways on its own (ping-pong), pauses while the user touches or hovers it ── */
  function autoScroll(row) {
    if (!row || row.dataset.auto || reduce.matches) return;
    row.dataset.auto = "1";
    var dir = 1, paused = false, resumeAt = 0, started = performance.now() + 1800;   // let the "yours" centring land first
    var hold = function (ms) { paused = true; resumeAt = performance.now() + ms; };
    // Only a deliberate interaction stops the drift (tap, drag, wheel); hovering does not. It resumes after 5s idle.
    ["pointerdown", "touchstart", "wheel"].forEach(function (t) { row.addEventListener(t, function () { hold(5000); }, { passive: true }); });
    (function step(now) {
      if (!row.isConnected) return;
      if (now > started && (!paused || now > resumeAt)) {
        paused = false;
        var max = row.scrollWidth - row.clientWidth;
        if (max > 0) {
          row.scrollLeft += 0.35 * dir;
          if (row.scrollLeft >= max - 1) { dir = -1; hold(1200); }
          if (row.scrollLeft <= 1) { dir = 1; hold(1200); }
        }
      }
      requestAnimationFrame(step);
    })(performance.now());
  }

  var target = document.getElementById("root") || document.body;
  new MutationObserver(function () { scan(); collectFaces(); stepPulse(); }).observe(target, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });
  scan(); collectFaces(); stepPulse();
  var rt; addEventListener("resize", function () { clearTimeout(rt); rt = setTimeout(applyTune, 120); });
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(applyTune);
})();
