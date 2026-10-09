/* "D0 is reading" summon for the v2 analysis page — ported from identity/theme.js. Mounts into #analyze: reading line,
   percentage, astrolabe seal, the real foil card (kol-v0 shell) with a "?" window, scan line. The page decides when the
   reveal happens (art-gated); this only animates. window.DonutSummon.mount(host, {name, handle, demo}) */
(function () {
  var reduce = matchMedia("(prefers-reduced-motion: reduce)");
  /* the astrolabe seal (Cory 2026-10-08: "星阵不够精致" — finer): an outer 360° scale between hairlines with twelve
     diamonds, a dashed orbit, the twelve-point star (one point per trader type) inside a hairline dodecagon, twelve
     spokes, tip rings, a counter-rotating inner band with a hexagram, a small hub; the six answers stay the bright figure */
  function sealSvg(points) {
    var S = 600, c = 300, ns = "http://www.w3.org/2000/svg", TAU = Math.PI * 2;
    function el(name, attrs) { var e = document.createElementNS(ns, name); for (var k in attrs) e.setAttribute(k, attrs[k]); return e; }
    function pt(a, r) { return (c + Math.cos(a) * r).toFixed(1) + " " + (c + Math.sin(a) * r).toFixed(1); }
    function ring(r, cls, draw) { var at = { class: cls, cx: c, cy: c, r: r }; if (draw !== false) at["data-draw"] = "1"; return el("circle", at); }
    function ticks(n, r1, r2, cls) { var d = ""; for (var i = 0; i < n; i++) { var a = i / n * TAU - Math.PI / 2; d += "M" + pt(a, r1) + "L" + pt(a, r2); } return el("path", { class: cls, d: d, "data-draw": "1" }); }
    function star(n, ro, ri, rot) { var d = ""; for (var j = 0; j <= n * 2; j++) { var a = j / (n * 2) * TAU - Math.PI / 2 + rot; d += (j ? "L" : "M") + pt(a, j % 2 ? ri : ro); } return d + "Z"; }
    function poly(n, r, rot) { var d = ""; for (var j = 0; j < n; j++) { var a = j / n * TAU - Math.PI / 2 + rot; d += (j ? "L" : "M") + pt(a, r); } return d + "Z"; }
    var svg = el("svg", { viewBox: "0 0 " + S + " " + S, "aria-hidden": "true" });
    /* outer band: a degree scale between two hairlines, every 30° a long mark and a diamond on the rim */
    svg.appendChild(ring(294, "ring"));
    svg.appendChild(ring(270, "ring faint"));
    svg.appendChild(ticks(360, 273, 277, "ticks fine"));
    svg.appendChild(ticks(72, 273, 282, "ticks"));
    svg.appendChild(ticks(12, 273, 290, "ticks"));
    for (var g = 0; g < 12; g++) { var ag = g / 12 * TAU - Math.PI / 2, gx = c + Math.cos(ag) * 294, gy = c + Math.sin(ag) * 294; svg.appendChild(el("path", { class: "glyph", d: "M" + gx.toFixed(1) + " " + (gy - 3.4).toFixed(1) + "L" + (gx + 3.4).toFixed(1) + " " + gy.toFixed(1) + "L" + gx.toFixed(1) + " " + (gy + 3.4).toFixed(1) + "L" + (gx - 3.4).toFixed(1) + " " + gy.toFixed(1) + "Z" })); }
    /* mid field: dashed orbit, spokes, the twelve-point star and its fainter twin, a small ring on every tip */
    svg.appendChild(ring(236, "ring dash", false));
    var spokes = ""; for (var sp = 0; sp < 12; sp++) { var as = sp / 12 * TAU - Math.PI / 2; spokes += "M" + pt(as, 188) + "L" + pt(as, 266); }
    svg.appendChild(el("path", { class: "spoke", d: spokes, "data-draw": "1" }));
    svg.appendChild(el("path", { class: "star faint", d: poly(12, 238, 0), "data-draw": "1" }));   /* a dodecagon through the tips: construction geometry, not a second blade */
    svg.appendChild(el("path", { class: "star", d: star(12, 238, 130, 0), "data-draw": "1" }));
    var tips = ""; for (var t = 0; t < 12; t++) { var at2 = t / 12 * TAU - Math.PI / 2, tx = c + Math.cos(at2) * 238, ty = c + Math.sin(at2) * 238; tips += "M" + (tx + 4.5).toFixed(1) + " " + ty.toFixed(1) + "a4.5 4.5 0 1 0 -9 0a4.5 4.5 0 1 0 9 0"; }
    svg.appendChild(el("path", { class: "tip", d: tips, "data-draw": "1" }));
    /* inner band (turns the other way): two hairlines, 24 ticks, a hexagram */
    var inner = el("g", { class: "inner" });
    inner.appendChild(ring(180, "ring"));
    inner.appendChild(ring(168, "ring faint"));
    inner.appendChild(ticks(24, 170, 178, "ticks"));
    inner.appendChild(el("path", { class: "star faint", d: poly(3, 160, 0) + poly(3, 160, Math.PI), "data-draw": "1" }));
    svg.appendChild(inner);
    /* hub */
    svg.appendChild(ring(14, "ring faint"));
    svg.appendChild(ticks(4, 18, 30, "ticks fine"));
    svg.appendChild(el("circle", { class: "glyph", cx: c, cy: c, r: 2.2 }));
    /* the six answers: one node per question at 60°, radius by the chosen option (unknown → middle) */
    var pts = points.map(function (idx, i) { var a3 = i / 6 * TAU - Math.PI / 2, r3 = 70 + (idx < 0 ? 1.5 : idx) * 46; return [c + Math.cos(a3) * r3, c + Math.sin(a3) * r3]; });
    var cons = el("path", { class: "constellation", "data-draw": "1", d: pts.map(function (p, i) { return (i ? "L" : "M") + p[0].toFixed(1) + " " + p[1].toFixed(1); }).join("") + "Z" });
    svg.appendChild(cons);
    pts.forEach(function (p) { var nd = el("circle", { class: "node", cx: p[0].toFixed(1), cy: p[1].toFixed(1), r: 4 }); nd.style.opacity = "0"; svg.appendChild(nd); });
    return svg;
  }
  function mount(host, opt) {
    opt = opt || {};
    var zh = (document.documentElement.lang || "").toLowerCase().indexOf("zh") === 0;
    var root = document.createElement("div"); root.className = "donut-summon";
    root.innerHTML = '<div class="ds-stage"><p class="ds-reading">' + (zh ? "D0 正在解读你的交易人格" : "D0 is reading your personality type") + '</p>' +
      '<div class="ds-halo"></div><div class="ds-seal"></div><div class="ds-glow"></div>' +
      '<div class="ds-card is-shell"><iframe class="ds-shell" title="" aria-hidden="true"></iframe><i class="scan"></i></div>' +
      '<div class="ds-pct" id="az-pct" hidden><b>0</b>%</div></div>';
    var seal = root.querySelector(".ds-seal"); seal.appendChild(sealSvg(opt.answers && opt.answers.length === 6 ? opt.answers : [-1, -1, -1, -1, -1, -1]));
    var shell = root.querySelector(".ds-shell");
    shell.src = "../flashcard/kol-v0.html?code=DONUT2026&skin=amethyst&user=" + encodeURIComponent((opt.name || "YOUR DONUT ID").toUpperCase());
    shell.addEventListener("load", function () { try {
      var d = shell.contentDocument, st = d.createElement("style");
      var tlx = new URL("./fonts/TimelessText-W465.woff2", location.href).href;   /* the "?" uses the site's serif, like the claim page's */
      st.textContent = "@font-face{font-family:'Timeless Text';font-weight:465;src:url('" + tlx + "') format('woff2')}" +
        ".skin-bar{display:none!important}.kol-photo img{visibility:hidden}.kol-photo>.kol-q{position:absolute;inset:0;z-index:1;display:grid;place-items:center;background:radial-gradient(90% 70% at 50% 45%,#2a1a52 0%,#140c2c 60%,#0b0718 100%);font:465 150px/1 'Timeless Text',Georgia,serif;color:rgb(222 208 255 / .85);text-shadow:0 0 24px rgb(178 150 255 / .8)}" +
        ".kol-photo>.kol-bling{position:absolute;inset:-10% 0;z-index:2;pointer-events:none;mix-blend-mode:screen;opacity:0;background:linear-gradient(180deg,transparent 0%,rgb(255 214 170 / .55) 46%,rgb(255 255 255 / .95) 50%,rgb(190 170 255 / .75) 54%,transparent 62%);background-size:100% 42%;background-repeat:no-repeat;background-position:0 -60%}";
      d.head.appendChild(st);
      var ph = d.querySelector(".kol-photo");
      if (ph) { var q = d.createElement("div"); q.className = "kol-q"; q.innerHTML = "<span>?</span>"; ph.appendChild(q); var bl = d.createElement("div"); bl.className = "kol-bling"; ph.appendChild(bl);
        if (!reduce.matches) bl.animate([{ opacity: 0, backgroundPosition: "0 -60%" }, { opacity: 1, offset: .08 }, { opacity: 1, offset: .9 }, { opacity: 0, backgroundPosition: "0 160%" }], { duration: 2400, delay: 1700, easing: "linear", fill: "both" }); }
      var desc = d.querySelector("[data-ticket-description]"); if (desc) { desc.textContent = zh ? "分析中" : "ANALYZING"; desc.dataset.foilText = desc.textContent; }
      var tag = d.querySelector(".kol-tag"); if (tag) tag.textContent = zh ? "D0 正在读取你的六个答案…" : "D0 is reading your six answers…";
      if (opt.handle) d.querySelectorAll(".kol-notch span").forEach(function (sp, i) { if (i) sp.textContent = opt.handle; });
    } catch (e) {} });
    host.appendChild(root);
    if (window.DonutSummonGL && !reduce.matches) DonutSummonGL.mount(root);   /* WebGL particle field behind the stage */
    if (reduce.matches) { root.querySelector(".ds-card").style.opacity = "1"; root.querySelectorAll(".node").forEach(function (n) { n.style.opacity = "1"; }); return root; }
    var E = "cubic-bezier(.2,.7,.2,1)", card = root.querySelector(".ds-card"), halo = root.querySelector(".ds-halo"), scan = root.querySelector(".scan");
    card.animate([{ opacity: 0, transform: "translateY(60vh) rotateY(-40deg) scale(.9)" }, { opacity: 1, offset: .35 }, { opacity: 1, transform: "translateY(0) rotateY(0) scale(1)" }], { duration: 1500, easing: E, fill: "both" });
    seal.animate([{ opacity: 0, transform: "rotateX(66deg) rotate(-40deg) scale(.6)" }, { opacity: 1, transform: "rotateX(66deg) rotate(0deg) scale(1)" }], { duration: 1600, delay: 300, easing: E, fill: "both" });
    halo.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 1200, delay: 600, fill: "both" });
    seal.querySelectorAll("[data-draw]").forEach(function (p, i) { var len = p.getTotalLength ? p.getTotalLength() : 2000; p.style.strokeDasharray = len; p.style.strokeDashoffset = len; if (p.classList.contains("constellation")) return; p.animate([{ strokeDashoffset: len }, { strokeDashoffset: 0 }], { duration: 1400, delay: 400 + i * 120, easing: "ease-out", fill: "both" }); });
    seal.animate([{ transform: "rotateX(66deg) rotate(0deg)" }, { transform: "rotateX(66deg) rotate(360deg)" }], { duration: 42000, delay: 1900, iterations: Infinity, easing: "linear" });
    var inner = seal.querySelector(".inner"); if (inner) inner.animate([{ transform: "rotate(0deg)" }, { transform: "rotate(-360deg)" }], { duration: 64000, delay: 1900, iterations: Infinity, easing: "linear" });
    card.animate([{ transform: "translateY(0)" }, { transform: "translateY(-8px)" }, { transform: "translateY(0)" }], { duration: 4200, delay: 1500, iterations: Infinity, easing: "ease-in-out" });
    /* the scan sweeps every 4 s for as long as D0 is reading */
    scan.animate([{ opacity: 0, top: "0%" }, { opacity: 1, offset: .06 }, { opacity: 1, offset: .94 }, { opacity: 0, top: "100%" }], { duration: 2400, delay: 1700, easing: "linear", iterations: Infinity, endDelay: 1600 });
    seal.querySelectorAll(".node").forEach(function (n, i) { n.animate([{ opacity: 0, r: 0 }, { opacity: 1, r: 7 }, { opacity: 1, r: 4 }], { duration: 500, delay: 2000 + i * 380, easing: E, fill: "both" }); });
    var poly = seal.querySelector(".constellation"), plen = poly.getTotalLength();
    poly.animate([{ strokeDashoffset: plen }, { strokeDashoffset: 0 }], { duration: 1500, delay: 4300, easing: "ease-in-out", fill: "both" });
    poly.animate([{ opacity: .6 }, { opacity: 1 }], { duration: 900, delay: 5800, direction: "alternate", iterations: Infinity });
    return root;
  }
  /* called by the page right before the reveal: the seal flares, the card swells and lights up */
  function flare(root) {
    if (!root || reduce.matches) return;
    var E = "cubic-bezier(.2,.7,.2,1)", seal = root.querySelector(".ds-seal"), card = root.querySelector(".ds-card"), glow = root.querySelector(".ds-glow");
    if (window.DonutSummonGL) DonutSummonGL.flare();
    seal.animate([{ filter: "brightness(1)" }, { filter: "brightness(2.2)" }, { filter: "brightness(1.2)" }], { duration: 1200, easing: E, fill: "both" });
    card.animate([{ scale: 1, filter: "brightness(1)" }, { scale: 1.18, filter: "brightness(1.28)" }], { duration: 1200, easing: E, fill: "both" });
    glow.animate([{ opacity: 0, transform: "scale(.7)" }, { opacity: 1, transform: "scale(1.3)" }], { duration: 1200, easing: E, fill: "both" });
  }
  window.DonutSummon = { mount: mount, flare: flare };
})();
