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
        // phones stack card → copy as one centred group: shrink the card until it clears the headline AND the CTA fits the screen
        var c = card.getBoundingClientRect(), top = h1.getBoundingClientRect().top, copy = hero.querySelector(".hero-copy");
        var over = Math.max(c.bottom + 16 - top, copy ? copy.getBoundingClientRect().bottom - (innerHeight - 20) : 0);
        if (over <= 0) break;
        var z = parseFloat(hero.style.getPropertyValue("--card-zoom")) * ((c.height - over) / c.height);
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
    var ws = main.querySelector(".workspace"); if (!ws || main.querySelector(".donut-locked")) return;   /* one row per page, whichever workspace copy is live */
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
      c.innerHTML = '<img alt="" decoding="async">' + lock + '<span class="name">' + t + "</span>";
      c.querySelector("img").src = new URL("img/archetypes/" + ARCHETYPE_FILES[i] + ".jpg", location.href).href;
      row.appendChild(c);
    });
    box.appendChild(head); box.appendChild(row); ws.appendChild(box);
    marquee(row);
  }
  /* the locked row drifts on its own: a cloned set makes the loop seamless; a touch, drag or hover hands it to the viewer,
     and it picks up again 2.5s after they let go. Paused off-screen, in a background tab and under reduced motion. */
  function marquee(row) {
    if (reduce.matches) return;
    Array.prototype.slice.call(row.children).forEach(function (c) { var d = c.cloneNode(true); d.setAttribute("aria-hidden", "true"); row.appendChild(d); });
    row.classList.add("is-marquee");
    var SPEED = 28, held = false, visible = true, resume = 0, last = 0, pos = 0;
    function hold() { held = true; clearTimeout(resume); }
    function release() { clearTimeout(resume); resume = setTimeout(function () { held = false; pos = row.scrollLeft; }, 2500); }
    row.addEventListener("pointerenter", function (e) { if (e.pointerType === "mouse") hold(); });
    row.addEventListener("pointerleave", function (e) { if (e.pointerType === "mouse") release(); });
    row.addEventListener("touchstart", hold, { passive: true });
    row.addEventListener("touchend", release, { passive: true });
    row.addEventListener("wheel", function () { hold(); release(); }, { passive: true });
    new IntersectionObserver(function (es) { visible = es[0].isIntersecting; }).observe(row);
    (function tick(now) {
      if (!row.isConnected) return;
      var dt = last ? Math.min(.05, (now - last) / 1000) : 0; last = now;
      var half = row.scrollWidth / 2;
      if (!held && visible && !document.hidden && half > row.clientWidth) {
        pos += SPEED * dt; if (pos >= half) pos -= half;
        row.scrollLeft = pos;
      } else if (half && row.scrollLeft >= half) { row.scrollLeft -= half; pos = row.scrollLeft; }
      requestAnimationFrame(tick);
    })(0);
  }

  /* ── card back: a 2–3 sentence read + three tags per type (Cory 2026-09-29). Sean's app writes one line and
        [type, "Your own rhythm"] into the flashcard iframe; this rewrites them after him and again whenever he re-renders. ── */
  var TYPE_KEYS = { "diamond hands": "diamond_hands", "dca believer": "hodler", "risk explorer": "degen", "day trader": "scalper", "sniper": "sniper", "grid executor": "grid_farmer",
    "swing hunter": "swing_hunter", "momentum rider": "momentum_chaser", "arb researcher": "arbitrageur", "narrative trader": "narrative_trader", "risk-first": "risk_monk", "contrarian": "bottom_fisher", "style explorer": "unresolved",
    "钻石手": "diamond_hands", "定投信徒": "hodler", "高风险探索者": "degen", "日内交易者": "scalper", "狙击手": "sniper", "网格执行者": "grid_farmer", "波段猎手": "swing_hunter",
    "动量跟随者": "momentum_chaser", "套利研究者": "arbitrageur", "叙事交易者": "narrative_trader", "风控优先者": "risk_monk", "逆向布局者": "bottom_fisher", "风格探索者": "unresolved" };
  /* per type: say = "most likely to say" (replaces Sean's tagline under the title), desc + tags = card back,
     green/red = the flags under the actions. Voice: specific habits, a little self-roast, CT-native — never abstract. */
  var BACK_COPY = {
    diamond_hands: { en: { say: "“Zoom out.” — you, every single red day", desc: "Your bag is down 40% and you're calmly posting the 5-year chart. You haven't opened the sell tab since 2021, and you're weirdly proud of it.", tags: ["HODL mode", "No paper hands", "Thesis > candles"], green: "Never panic-sells the bottom", red: "Also never takes profit" },
      zh: { say: "“拉长周期看。”——每次大跌时的你", desc: "账户回撤 40%，你还在淡定转发五年 K 线图。卖出按钮自 2021 年后就没点过，而且对此有点骄傲。", tags: ["拿得住", "拒绝纸手", "信仰充值"], green: "从不在底部割肉", red: "也从不止盈" } },
    hodler: { en: { say: "“Bought again. It's Tuesday.”", desc: "Your buy order has fired every week for three years and you barely notice. Bull, bear or crab — the bot doesn't care, and neither do you.", tags: ["Stack & chill", "Set & forget", "Time > timing"], green: "Zero emotion since day one", red: "Forgot the password to check" },
      zh: { say: "“又到周二，买了。”", desc: "你的定投每周准时执行了三年，你几乎没注意过。牛市熊市横盘，机器人不在乎，你也不在乎。", tags: ["定投上瘾", "躺平积累", "时间的朋友"], green: "全程零情绪", red: "忘了看账户的密码" } },
    degen: { en: { say: "“It's only up from here.” (it was not)", desc: "You found the coin before it had a website and aped before reading the contract. Wins become screenshots; losses become “tuition”.", tags: ["Full send", "Ape first", "Vol enjoyer"], green: "First to every narrative", red: "Also first to every rug" },
      zh: { say: "“接下来只会涨。”（并没有）", desc: "币还没官网你就找到了，合约没看完你就冲了。赚了截图发圈，亏了叫交学费。", tags: ["梭哈精神", "先冲再说", "波动爱好者"], green: "每个叙事都第一个到", red: "每次被埋也第一个到" } },
    scalper: { en: { say: "“One more trade, then lunch.”", desc: "Six charts open, 1-minute candles in your dreams, bathroom breaks timed around funding. In, out, and flat by the close — every day.", tags: ["Screen-locked", "In & out", "Flat by close"], green: "Never holds a bag overnight", red: "Lunch has been cold since 2022" },
      zh: { say: "“再做一单就去吃饭。”", desc: "六个图表同时开，梦里都是 1 分钟 K 线，连上厕所都掐着资金费率。快进快出，收盘前必清仓。", tags: ["盯盘战士", "快进快出", "日内清仓"], green: "从不隔夜扛单", red: "午饭从 2022 年起就是凉的" } },
    sniper: { en: { say: "“Not my level.” — you, 47 times this week", desc: "Your limit order has sat untouched for 19 days. Everyone's chasing green candles; you're refreshing the chart and waiting for your number.", tags: ["One shot", "Patience arc", "Levels only"], green: "Zero FOMO entries", red: "Missed the whole run by $0.02" },
      zh: { say: "“还没到我的点位。”——这周第 47 次", desc: "你的限价单已经挂了 19 天没动。别人都在追阳线，你只是刷新图表，等你的那个价格。", tags: ["一击必中", "耐心拉满", "只等点位"], green: "从不 FOMO 入场", red: "差 0.02 刀错过整波行情" } },
    grid_farmer: { en: { say: "“Sideways is my bull market.”", desc: "While the timeline argues about direction, your grid bot has quietly flipped the same range 312 times. The more boring the chart, the more you love it.", tags: ["Bot brain", "Range farmer", "Rules > vibes"], green: "Prints money in crab markets", red: "Panics when it finally trends" },
      zh: { say: "“横盘就是我的牛市。”", desc: "时间线还在吵方向，你的网格机器人已经在同一区间来回了 312 次。行情越无聊，你越爱。", tags: ["网格农夫", "规则至上", "机器人心态"], green: "横盘也能赚钱", red: "一走趋势就慌" } },
    swing_hunter: { en: { say: "“I'll check it Friday.”", desc: "You set entries on Sunday night, check price twice a week and somehow still have hobbies. You eat the meat of the move and leave the bones to day traders.", tags: ["Catch the swing", "Exit planned", "No 1m charts"], green: "Has a life outside charts", red: "Exits right before the real pump" },
      zh: { say: "“周五再看吧。”", desc: "你周日晚上挂好单，一周看两次价格，居然还有自己的生活。最肥的那段你吃，骨头留给日内选手抢。", tags: ["只吃鱼身", "计划离场", "拒绝分钟线"], green: "图表之外还有生活", red: "总在真正拉升前下车" } },
    momentum_chaser: { en: { say: "“It broke out. I'm in.”", desc: "You don't buy dips, you buy strength. New highs make you excited, not nervous, and your favourite indicator is “it keeps going up”.", tags: ["Trend is friend", "Breakout ready", "Ride the wave"], green: "Rides the trend, not the hope", red: "Buys the top once a quarter" },
      zh: { say: "“突破了，上车。”", desc: "你不抄底，只买强势。创新高让你兴奋而不是害怕，你最爱的指标叫“它还在涨”。", tags: ["趋势信徒", "突破追击", "顺势冲浪"], green: "跟趋势，不跟希望", red: "每季度准时站岗一次" } },
    arbitrageur: { en: { say: "“Free money. Just boring.”", desc: "Eight exchange tabs, one spreadsheet nobody else understands. A guaranteed 0.3% beats a maybe-30% every single time.", tags: ["Spread hunter", "Delta neutral", "Edge > hype"], green: "Doesn't care where price goes", red: "Explains funding rates at parties" },
      zh: { say: "“白捡的钱，就是无聊。”", desc: "八个交易所标签页，一张只有你看得懂的表格。确定的 0.3%，永远比可能的 30% 香。", tags: ["价差猎人", "中性对冲", "只吃确定性"], green: "涨跌与我无关", red: "聚会上给人讲资金费率" } },
    narrative_trader: { en: { say: "“This is the next meta.”", desc: "You were in AI coins before the headlines and in memes before your group chat. You read the timeline like a weather report, and you leave the party early.", tags: ["Early to meta", "CT native", "Vibe-shift radar"], green: "Early to every trend", red: "Twelve narratives, zero focus" },
      zh: { say: "“这就是下一个大叙事。”", desc: "新闻还没报你就在 AI 币里了，群友还没聊你就在 meme 里了。你把时间线当天气预报看，派对散场前先走。", tags: ["叙事雷达", "CT 原住民", "先知先觉"], green: "每波风口都早到", red: "十二个叙事，零个专注" } },
    risk_monk: { en: { say: "“Where's your stop?”", desc: "You sized the position before you picked the coin. You've missed a few pumps, but you've never received a liquidation email — and you plan to keep it that way.", tags: ["Stop-loss first", "Size discipline", "Survive first"], green: "Still here after every crash", red: "Sizes too small to feel the win" },
      zh: { say: "“你止损设在哪？”", desc: "选币之前你先算好了仓位。错过过几波拉盘，但从没收到过爆仓通知——你打算一直保持。", tags: ["止损先行", "仓位纪律", "活着最重要"], green: "每次崩盘后都还在", red: "仓位小到赚了都没感觉" } },
    bottom_fisher: { en: { say: "“Blood in the streets? Shopping time.”", desc: "When the timeline fills with “it's over”, you quietly start buying. You love the coins nobody wants, and you've been called early more often than wrong.", tags: ["Buy the fear", "Anti-FOMO", "Scale in slow"], green: "Buys when everyone panics", red: "Catches the odd falling knife" },
      zh: { say: "“满地是血？该进货了。”", desc: "时间线满屏“结束了”的时候，你开始悄悄买入。你偏爱没人要的币，被说“太早了”的次数比“错了”还多。", tags: ["逆风建仓", "反向 FOMO", "分批抄底"], green: "别人恐慌时出手", red: "偶尔接到飞刀" } },
    unresolved: { en: { say: "“Still figuring it out.” (valid)", desc: "A bit of HODL, a bit of degen, a lot of vibes. Your style hasn't locked in yet — the next cycle is going to write it for you.", tags: ["Still cooking", "Open mind", "Plot loading"], green: "Open to every strategy", red: "Open to every strategy" },
      zh: { say: "“还在摸索。”（很合理）", desc: "一点拿住，一点梭哈，大部分凭感觉。你的风格还没定型——下一轮周期会替你写好。", tags: ["还在进化", "保持开放", "剧情加载中"], green: "什么策略都愿意试", red: "什么策略都愿意试" } }
  };
  /* Sean's app injects `.kb-radarwrap{height:260px!important}` and `.kb-panel{margin-top:0!important}` — hence the !important here */
  var BACK_CSS = ".kol-back .kb-radarwrap{height:222px!important;margin-top:6px;padding:6px 2px 4px;box-sizing:border-box}.kol-back .kb-radar{height:208px}" +
    ".kol-back .kb-panel{margin-top:10px!important;padding:12px 16px 14px}" +
    ".kol-back .kb-chips{gap:6px;margin:0 0 9px;flex-wrap:nowrap}" +
    ".kol-back .kb-chips span{border-radius:999px;padding:5px 10px;font:600 10px/1 var(--font-body,system-ui,sans-serif);letter-spacing:.02em;text-transform:none;color:#131313d0;border-color:#13131326;background:#ffffff4d}" +
    ".kol-back .kb-desc{font:500 10.5px/1.55 var(--font-body,system-ui,sans-serif);color:#131313c4;text-align:center;margin:0;text-wrap:pretty}";
  /* the reveal, on the page: the quote under the title becomes the type's "most likely to say"; green/red flags follow the actions */
  function dressResult(c, zh) {
    var panel = document.querySelector("main.step-3 .result-panel"); if (!panel) return;
    var quote = panel.querySelector(".result-quote"); if (quote && quote.textContent !== c.say) quote.textContent = c.say;
    /* the card-back read, repeated under the quote so the page makes sense without flipping */
    var desc = panel.querySelector(":scope > .donut-desc");
    if (!desc && quote) { desc = document.createElement("p"); desc.className = "donut-desc"; quote.parentNode.insertBefore(desc, quote.nextSibling); }
    if (desc && desc.textContent !== c.desc) desc.textContent = c.desc;
    var flags = panel.querySelector(":scope > .donut-flags");
    if (!flags) { flags = document.createElement("div"); flags.className = "donut-flags"; panel.appendChild(flags); }
    var html = '<div class="flag green"><span>' + (zh ? "绿旗" : "Green flag") + "</span><p>" + c.green + '</p></div><div class="flag red"><span>' + (zh ? "红旗" : "Red flag") + "</span><p>" + c.red + "</p></div>";
    if (flags.innerHTML !== html) flags.innerHTML = html;
    fitResult();
  }
  /* phones: card + title + actions in one screen — shrink the card until the action row clears the bottom edge */
  var fitKey = "";
  function fitResult() {
    var frame = document.querySelector("main.step-3 .workspace .studio .card-frame"), row = document.querySelector("main.step-3 .result-panel .share-x");
    if (!frame || !row) return;
    var key = innerWidth + "x" + innerHeight; if (key === fitKey) return; fitKey = key;
    frame.style.removeProperty("--card-zoom");
    if (!phone()) return;
    var z = parseFloat(getComputedStyle(frame).getPropertyValue("--card-zoom")) || .9;
    for (var i = 0; i < 8; i++) {
      var over = row.getBoundingClientRect().bottom + scrollY - (innerHeight - 16), h = frame.getBoundingClientRect().height;
      if (over <= 0 || !h) break;
      z = Math.max(.5, Math.floor(z * (h - over) / h * 100) / 100);
      frame.style.setProperty("--card-zoom", String(z));
      if (z === .5) break;
    }
  }
  addEventListener("resize", function () { fitKey = ""; fitResult(); });
  function dressBack() {
    var title = document.querySelector("main.step-3 .result-panel h2"); if (!title) return;
    var key = TYPE_KEYS[title.textContent.trim().toLowerCase()], copy = key && BACK_COPY[key]; if (!copy) return;
    var zh = (document.documentElement.lang || "").toLowerCase().indexOf("zh") === 0, c = zh ? copy.zh : copy.en;
    dressResult(c, zh);
    document.querySelectorAll("main.step-3 .card-frame iframe").forEach(function (f) {
      var doc; try { doc = f.contentDocument; } catch (e) { return; }
      if (!doc || !doc.head) return;
      if (!doc.getElementById("donut-back")) { var st = doc.createElement("style"); st.id = "donut-back"; st.textContent = BACK_CSS; doc.head.appendChild(st); }
      var chips = doc.querySelector(".kol-back .kb-chips"), desc = doc.querySelector(".kol-back .kb-desc");
      if (desc && desc.textContent !== c.desc) desc.textContent = c.desc;
      if (chips && Array.prototype.map.call(chips.children, function (s) { return s.textContent; }).join("|") !== c.tags.join("|")) {
        chips.textContent = ""; c.tags.forEach(function (t) { var s = doc.createElement("span"); s.textContent = t; chips.appendChild(s); });
      }
      var tag = doc.querySelector(".kol-tag"), front = c.say.split(/ — |——| \(|（/)[0];   /* front: the quote alone, no attribution */
      if (tag && tag.textContent !== front) tag.textContent = front;
      if (tag && !tag.dataset.donutWatch) { tag.dataset.donutWatch = "1"; new MutationObserver(dressBack).observe(tag, { childList: true, characterData: true, subtree: true }); }
      var panel = doc.querySelector(".kol-back .kb-panel");
      if (panel && !panel.dataset.donutWatch) { panel.dataset.donutWatch = "1"; new MutationObserver(dressBack).observe(panel, { childList: true, subtree: true, characterData: true }); }
    });
  }

  /* ── D0 analysis → card summoning (Cory 2026-09-29) ──────────────────────────────────────────
     Sean's dialog keeps its clock (8.2s, four phases) and its copy; the stage below replaces his visual.
     Timeline (ms): 0–1600 card rises, seal draws · 1600–4200 scan line sweeps, answers light up ·
     4200–6400 constellation joins, seal turns · 6400–8200 flare · then step 3 mounts → coin burst. ── */
  var answers = [], summoned = false, summonTimers = [];
  function captureAnswers(main) {
    var sets = main.querySelectorAll(".questions fieldset"); if (!sets.length) return;
    answers = Array.prototype.map.call(sets, function (f) {
      var btns = f.querySelectorAll(".choices button"), idx = -1;
      btns.forEach(function (b, i) { if (b.classList.contains("chosen") || b.getAttribute("aria-pressed") === "true") idx = i; });
      return idx;
    });
  }
  function sealSvg(points) {
    var S = 600, c = 300, ns = "http://www.w3.org/2000/svg";
    function el(name, attrs) { var e = document.createElementNS(ns, name); for (var k in attrs) e.setAttribute(k, attrs[k]); return e; }
    var svg = el("svg", { viewBox: "0 0 " + S + " " + S, "aria-hidden": "true" });
    [292, 262, 176, 120].forEach(function (r, i) { svg.appendChild(el("circle", { class: "ring" + (i === 1 || i === 3 ? " faint" : ""), cx: c, cy: c, r: r, "data-draw": "1" })); });
    var ticks = el("path", { class: "ticks", "data-draw": "1" }), d = "";
    for (var i = 0; i < 72; i++) { var a = i / 72 * Math.PI * 2, r1 = i % 6 === 0 ? 248 : 256, r2 = 262; d += "M" + (c + Math.cos(a) * r1).toFixed(1) + " " + (c + Math.sin(a) * r1).toFixed(1) + "L" + (c + Math.cos(a) * r2).toFixed(1) + " " + (c + Math.sin(a) * r2).toFixed(1); }
    ticks.setAttribute("d", d); svg.appendChild(ticks);
    var star = "", n = 12;   /* twelve-point star: one point per trader type */
    for (var j = 0; j <= n; j++) { var a2 = j / n * Math.PI * 2 - Math.PI / 2, rr = j % 2 ? 128 : 236; star += (j ? "L" : "M") + (c + Math.cos(a2) * rr).toFixed(1) + " " + (c + Math.sin(a2) * rr).toFixed(1); }
    svg.appendChild(el("path", { class: "star", d: star + "Z", "data-draw": "1" }));
    for (var g = 0; g < 12; g++) { var ag = g / 12 * Math.PI * 2 - Math.PI / 2; svg.appendChild(el("circle", { class: "glyph", cx: (c + Math.cos(ag) * 292).toFixed(1), cy: (c + Math.sin(ag) * 292).toFixed(1), r: 2.2 })); }
    /* the six answers: one node per question at 60°, radius by the chosen option (unknown → middle) */
    var pts = points.map(function (idx, i) { var a3 = i / 6 * Math.PI * 2 - Math.PI / 2, r3 = 70 + (idx < 0 ? 1.5 : idx) * 46; return [c + Math.cos(a3) * r3, c + Math.sin(a3) * r3]; });
    var poly = el("path", { class: "constellation", "data-draw": "1", d: pts.map(function (p, i) { return (i ? "L" : "M") + p[0].toFixed(1) + " " + p[1].toFixed(1); }).join("") + "Z" });
    svg.appendChild(poly);
    pts.forEach(function (p) { var nd = el("circle", { class: "node", cx: p[0].toFixed(1), cy: p[1].toFixed(1), r: 4 }); nd.style.opacity = "0"; svg.appendChild(nd); });
    return svg;
  }
  function mountSummon(dlg) {
    summoned = true; summonTimers.forEach(clearTimeout); summonTimers = [];
    if (window.DonutBurst) DonutBurst.preload();
    var zh = (document.documentElement.lang || "").toLowerCase().indexOf("zh") === 0;
    var root = document.createElement("div"); root.className = "donut-summon"; root.setAttribute("aria-hidden", "true");
    root.innerHTML = '<button type="button" class="ds-cancel" aria-label="' + (zh ? "返回问卷" : "Back to questionnaire") + '"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="m6 6 12 12M18 6 6 18"/></svg></button>' +
      '<div class="ds-stage"><p class="ds-reading"><i></i>' + (zh ? "D0 正在解读你的交易人格" : "D0 is reading your personality type") + '</p><div class="ds-halo"></div><div class="ds-seal"></div><div class="ds-glow"></div><div class="ds-card"><span class="q">?</span><i class="grid"></i><i class="scan"></i></div><div class="ds-flare"></div></div>';
    var seal = root.querySelector(".ds-seal"); seal.appendChild(sealSvg(answers.length === 6 ? answers : [-1, -1, -1, -1, -1, -1]));
    root.querySelector(".ds-cancel").addEventListener("click", function () { var b = dlg.querySelector(".analysis-top button"); b ? b.click() : dlg.dispatchEvent(new Event("cancel", { cancelable: true })); });
    dlg.appendChild(root);
    if (reduce.matches) { root.querySelector(".ds-card").style.opacity = "1"; root.querySelectorAll(".node").forEach(function (n) { n.style.opacity = "1"; }); return; }
    var E = "cubic-bezier(.2,.7,.2,1)", card = root.querySelector(".ds-card"), halo = root.querySelector(".ds-halo"), scan = root.querySelector(".scan"), grid = root.querySelector(".grid"), flare = root.querySelector(".ds-flare");
    /* 0–1600: the card rises from below and settles; the seal fades in and draws itself */
    card.animate([{ opacity: 0, transform: "translateY(60vh) rotateY(-40deg) scale(.9)" }, { opacity: 1, offset: .35 }, { opacity: 1, transform: "translateY(0) rotateY(0) scale(1)" }], { duration: 1500, easing: E, fill: "both" });
    seal.animate([{ opacity: 0, transform: "rotateX(66deg) rotate(-40deg) scale(.6)" }, { opacity: 1, transform: "rotateX(66deg) rotate(0deg) scale(1)" }], { duration: 1600, delay: 300, easing: E, fill: "both" });
    halo.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 1200, delay: 600, fill: "both" });
    seal.querySelectorAll("[data-draw]").forEach(function (p, i) {
      var len = p.getTotalLength ? p.getTotalLength() : 2000; p.style.strokeDasharray = len; p.style.strokeDashoffset = len;
      if (p.classList.contains("constellation")) return;
      p.animate([{ strokeDashoffset: len }, { strokeDashoffset: 0 }], { duration: 1400, delay: 400 + i * 120, easing: "ease-out", fill: "both" });
    });
    /* the seal keeps turning; the card breathes */
    seal.animate([{ transform: "rotateX(66deg) rotate(0deg)" }, { transform: "rotateX(66deg) rotate(360deg)" }], { duration: 42000, delay: 1900, iterations: Infinity, easing: "linear" });
    card.animate([{ transform: "translateY(0)" }, { transform: "translateY(-8px)" }, { transform: "translateY(0)" }], { duration: 4200, delay: 1500, iterations: Infinity, easing: "ease-in-out" });
    /* 1600–4200: the scan line sweeps down; the grid follows it; the answers light up one by one */
    scan.animate([{ opacity: 0, top: "0%" }, { opacity: 1, offset: .06 }, { opacity: 1, offset: .94 }, { opacity: 0, top: "100%" }], { duration: 2400, delay: 1700, easing: "linear", fill: "both" });
    grid.animate([{ opacity: 0, clipPath: "inset(0 0 100% 0)" }, { opacity: .9, offset: .1 }, { opacity: .9, clipPath: "inset(0 0 0% 0)" }, { opacity: .35, clipPath: "inset(0 0 0% 0)" }], { duration: 3200, delay: 1700, easing: "linear", fill: "both" });
    seal.querySelectorAll(".node").forEach(function (n, i) { n.animate([{ opacity: 0, r: 0 }, { opacity: 1, r: 7 }, { opacity: 1, r: 4 }], { duration: 500, delay: 2000 + i * 380, easing: E, fill: "both" }); });
    /* 4200–6400: the constellation joins */
    var poly = seal.querySelector(".constellation"), plen = poly.getTotalLength();
    poly.animate([{ strokeDashoffset: plen }, { strokeDashoffset: 0 }], { duration: 1500, delay: 4300, easing: "ease-in-out", fill: "both" });
    poly.animate([{ opacity: .6 }, { opacity: 1 }], { duration: 900, delay: 5800, direction: "alternate", iterations: 3, fill: "both" });
    /* 6400–8200: the seal flares, the card lifts and brightens, and the stage goes to white as the result opens */
    seal.animate([{ filter: "brightness(1)" }, { filter: "brightness(2.2)" }, { filter: "brightness(1.2)" }], { duration: 1400, delay: 6500, easing: E, fill: "both" });
    card.animate([{ boxShadow: "inset 0 0 0 1px rgb(255 255 255 / .7), 0 0 0 1px rgb(120 85 239 / .25)" }, { boxShadow: "inset 0 0 0 1px #fff, 0 0 44px 8px rgb(190 170 255 / .7)" }], { duration: 1200, delay: 6600, easing: E, fill: "both" });
    /* the reveal: the card swells and lights up just before the result opens (scale is its own property, so it stacks on the rise/breathe transforms) */
    root.querySelector(".ds-reading").animate([{ opacity: 1 }, { opacity: 0 }], { duration: 500, delay: 6100, fill: "forwards" });   /* reading done */
    card.animate([{ scale: 1, filter: "brightness(1)" }, { scale: 1.18, filter: "brightness(1.28)" }], { duration: 1500, delay: 6300, easing: E, fill: "both" });
    root.querySelector(".ds-glow").animate([{ opacity: 0, transform: "scale(.7)" }, { opacity: 1, transform: "scale(1.3)" }], { duration: 1500, delay: 6200, easing: E, fill: "both" });
    flare.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 450, delay: 7750, easing: "ease-in", fill: "both" });
  }
  function revealBurst(main) {
    var fire = function () {
      var card = main.querySelector(".studio .card-frame"), r = card && card.getBoundingClientRect();
      var x = r && r.width ? r.left + r.width / 2 : innerWidth / 2, y = r && r.width ? r.top + r.height / 2 : innerHeight * .4;
      if (window.DonutBurst && !reduce.matches) DonutBurst.fire(x, y, 2);
    };
    summonTimers.push(setTimeout(fire, 260));   /* after the result page has laid out the card */
  }
  /* ── route scan: Sean's <main class="app step-N"> carries the step ── */
  function currentStep() { var m = document.querySelector("main.app"); if (!m) return -1; var mm = /step-(\d)/.exec(m.className); return mm ? Number(mm[1]) : -1; }
  function scan() {
    var main = document.querySelector("main.app"); if (!main) return;
    var step = currentStep();
    if (document.documentElement.getAttribute("data-step") !== String(step)) document.documentElement.setAttribute("data-step", String(step));
    if (step === 0) { stage(main, true); mountPanel(); mountShine(main.querySelector(".hero-studio .card-frame")); applyTune(); }
    else if (step === 3) { stage(main, false); mountLocked(main); dressBack(); if (summoned) { summoned = false; revealBurst(main); } }
    else clearStage(main);
    if (step === 2) captureAnswers(main);
    var dlg = document.querySelector("dialog.d0-analysis");
    if (dlg && !dlg.querySelector(":scope > .donut-summon")) mountSummon(dlg);
    var show = step === 0 ? "" : "none";
    if (tuneBtn && tuneBtn.style.display !== show) tuneBtn.style.display = show;
    if (panel && panel.style.display !== show) panel.style.display = show;
    // the flashcard iframe inside the studio: make sure the card-face vars land once it has loaded
    document.querySelectorAll(".card-frame iframe").forEach(function (f) { if (!f.dataset.donutHooked) { f.dataset.donutHooked = "1"; f.addEventListener("load", function () { applyFlash(); dressBack(); }); } });
    stepPulse(step);
  }

  /* ── opening: the twelve card faces flick past at full size, settle into an upright ring, the title lands.
        Every load; ?intro=0 skips, reduced-motion skips, any tap skips. ── */
  (function intro() {
    if (q.get("intro") === "0") return;
    if (q.get("intro") !== "1" && reduce.matches) return;
    document.documentElement.setAttribute("data-intro", "");
    var root = document.createElement("div"); root.className = "donut-intro"; root.setAttribute("role", "presentation");
    root.innerHTML = '<div class="donut-intro-ring"></div><i class="donut-intro-logo" aria-hidden="true"></i><div class="donut-intro-copy"><i class="donut-intro-logo" aria-hidden="true"></i><h1>Test your Trading Personality on Donut D0</h1><p>presented by DonutAI</p></div>';
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
    var ringY = H * .5;   /* phones too: the title now lives inside the ring (Cory 2026-09-29), so the ring centres on the screen */
    var R = ph ? Math.min(W / 2 - slot / 2 - 14, ringY - CH * sc / 2 - 24) : Math.min(W, H) * .40 - CH * sc / 2;
    root.style.setProperty("--ring-y", ringY + "px");
    root.style.setProperty("--copy-y", ringY + "px"); root.style.setProperty("--copy-shift", "-50%");
    root.style.setProperty("--copy-w", Math.round((R - CH * sc / 2) * 2 * (ph ? .84 : .86)) + "px");
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
