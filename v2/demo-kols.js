/* Demo X profiles for the mock-up (Cory 2026-10-08): `?kol=<id>` on any v2 page picks one; the landing's login sheet
   lists them. Avatars live in tools/cardgen/avatars, symlinked to v2/img/demo and NOT in git (real people's pictures
   stay out of the repo), so the demo runs on a machine that has them. Each profile carries quiz answers that score to a
   persona type whose card art the mock backend already holds, so the reveal is instant; change an answer and the
   backend generates live (~3 min). */
(function () {
  var KOLS = {
    chriszhu:       { name: "Chris Zhu",       handle: "@chriszhu",       avatar: "./img/demo/chriszhu.png",       type: "diamond_hands",    answers: { market: "majors",  strategy: "conviction", execution: "manual",   information: "macro", horizon: "long",   risk: "flex" } },
    cz_binance:     { name: "CZ",              handle: "@cz_binance",     avatar: "./img/demo/cz_binance.jpg",     type: "risk_monk",        answers: { market: "majors",  strategy: "unknown",    execution: "copy",     information: "macro", horizon: "unsure", risk: "budget" } },
    elonmusk:       { name: "Elon Musk",       handle: "@elonmusk",       avatar: "./img/demo/elonmusk.jpg",       type: "momentum_chaser",  answers: { market: "meme",    strategy: "breakout",   execution: "manual",   information: "news",  horizon: "swing",  risk: "high" } },
    justinsuntron:  { name: "Justin Sun",      handle: "@justinsuntron",  avatar: "./img/demo/justinsuntron.jpg",  type: "narrative_trader", answers: { market: "altcoin", strategy: "narrative",  execution: "manual",   information: "news",  horizon: "swing",  risk: "flex" } },
    VitalikButerin: { name: "Vitalik Buterin", handle: "@VitalikButerin", avatar: "./img/demo/VitalikButerin.jpg", type: "arbitrageur",      answers: { market: "altcoin", strategy: "unknown",    execution: "learning", information: "chain", horizon: "swing",  risk: "stop" } },
    ansem:          { name: "Ansem",           handle: "@blknoiz06",      avatar: "./img/demo/ansem.jpg",          type: "degen",            answers: { market: "meme",    strategy: "unknown",    execution: "copy",     information: "mixed", horizon: "unsure", risk: "high" } }
  };
  /* the profile for this page: ?kol= wins and is remembered for the session; otherwise the remembered one */
  function current() {
    var id = new URLSearchParams(location.search).get("kol");
    if (id && KOLS[id]) { try { sessionStorage.setItem("donut.kol", id); } catch (e) {} }
    else { try { id = sessionStorage.getItem("donut.kol"); } catch (e) { id = null; } }
    return id && KOLS[id] ? Object.assign({ id: id }, KOLS[id]) : null;
  }
  var CSS = ".login-demo{margin:14px 0 2px;padding-top:14px;border-top:1px solid rgb(255 255 255/.08);display:flex;align-items:center;gap:8px;flex-wrap:wrap}" +
    ".login-demo>span{font:500 11px/1 var(--mono,system-ui);letter-spacing:.08em;text-transform:uppercase;color:rgb(255 255 255/.4);margin-right:4px}" +
    ".login-demo a{display:inline-flex;width:34px;height:34px;border-radius:50%;overflow:hidden;box-shadow:0 0 0 1px rgb(255 255 255/.18);transition:transform .15s,box-shadow .15s}" +
    ".login-demo a:hover{transform:translateY(-2px);box-shadow:0 0 0 2px rgb(115 97 255/.9)}.login-demo img{width:100%;height:100%;object-fit:cover;display:block}";
  /* a row of avatars in the landing's login sheet: "Demo as …" */
  function renderPicker(host, next) {
    if (!host) return;
    var st = document.createElement("style"); st.textContent = CSS; document.head.appendChild(st);
    host.innerHTML = "<span>Demo as</span>" + Object.keys(KOLS).map(function (id) { var k = KOLS[id]; return '<a href="' + next + "?kol=" + id + '" title="' + k.name + " · " + k.handle + '"><img src="' + k.avatar + '" alt="' + k.name + '"></a>'; }).join("");
    host.hidden = false;
    /* avatars that aren't on this host (they stay out of git) drop out; no avatars, no row */
    host.querySelectorAll("img").forEach(function (im) { im.onerror = function () { im.parentNode.remove(); if (!host.querySelector("a")) host.hidden = true; }; });
  }
  window.DonutDemo = { KOLS: KOLS, current: current, renderPicker: renderPicker };
})();
