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
  function scan() {
    var landing = document.querySelector(".landing");
    if (landing) stage(landing, true);
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
})();
