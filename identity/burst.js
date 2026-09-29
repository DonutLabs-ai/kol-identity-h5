/* Coin burst, ported from donut-website-white lib/white-hole-burst.ts (2026-09-29): the same pearl flash,
   diffraction glint and spinning metallic coins. window.DonutBurst.fire(x, y, charge) runs one burst to completion. */
(function () {
  var coins = [];
  function preload() {
    if (coins.length) return;
    ["usdt", "eth", "btc", "doge", "sol"].forEach(function (name) {
      var image = new Image(); image.decoding = "async";
      image.src = new URL("img/coins/" + name + ".webp", document.currentScript ? document.currentScript.src : location.href).href;
      coins.push(image);
    });
  }
  function create(x, y, charge, subtle) {
    preload();
    var canvas = document.createElement("canvas");
    canvas.className = "white-hole-burst"; canvas.setAttribute("aria-hidden", "true");
    Object.assign(canvas.style, { position: "fixed", inset: "0", width: "100%", height: "100%", pointerEvents: "none", zIndex: "241" });
    var ratio = Math.min(devicePixelRatio, 2);
    canvas.width = innerWidth * ratio; canvas.height = innerHeight * ratio;
    var ctx = canvas.getContext("2d");
    if (!ctx) return { draw: function () {}, dispose: function () {} };
    ctx.scale(ratio, ratio);
    document.body.appendChild(canvas);
    var count = subtle ? 1 + Math.round(Math.random()) : Math.round(22 + Math.min(charge, 3) * 9);
    var particles = [];
    for (var i = 0; i < count; i++) {
      var angle = subtle ? -Math.PI / 2 + (i ? .55 : -.55) + (Math.random() - .5) * .3 : i * 2.39996 + Math.random() * .25;
      var speed = subtle ? 150 + Math.random() * 90 : 240 + Math.random() * 560;
      var coinIndex = subtle ? Math.floor(Math.random() * coins.length) : i % coins.length;
      particles.push({ vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed * .65 - 190, size: subtle ? 76 + Math.random() * 30 : 52 + Math.random() * 80, spin: (Math.random() - .5) * 10, phase: Math.random() * 6.28, delay: Math.random() * .15, gold: coinIndex === 0 || coinIndex === 3, image: coins[coinIndex] });
    }
    return {
      draw: function (time) {
        ctx.clearRect(0, 0, innerWidth, innerHeight);
        var pulse = .6 * Math.min(1, time / .075) * Math.pow(Math.max(0, 1 - time / .9), 2);
        if (pulse > 0 && !subtle) {
          var radius = 180 + time * 520;
          var glow = ctx.createRadialGradient(x, y, 0, x, y, radius);
          glow.addColorStop(0, "rgba(255,255,255," + pulse + ")"); glow.addColorStop(.12, "rgba(228,232,255," + pulse + ")");
          glow.addColorStop(.35, "rgba(159,169,255," + pulse * .5 + ")"); glow.addColorStop(1, "rgba(144,132,255,0)");
          ctx.fillStyle = glow; ctx.fillRect(x - radius, y - radius, radius * 2, radius * 2);
          ctx.save(); ctx.globalCompositeOperation = "lighter"; ctx.translate(x, y); ctx.scale(1, .035);
          var streak = ctx.createRadialGradient(0, 0, 0, 0, 0, radius * 1.5);
          streak.addColorStop(0, "rgba(255,255,255," + pulse + ")"); streak.addColorStop(1, "rgba(172,173,255,0)");
          ctx.fillStyle = streak; ctx.fillRect(-radius * 1.5, -radius * 1.5, radius * 3, radius * 3); ctx.restore();
        }
        var glint = Math.pow(Math.sin(Math.min(1, time / .55) * Math.PI), 2);
        if (glint > 0) {
          ctx.save(); ctx.translate(x, y); ctx.globalCompositeOperation = "lighter";
          [[subtle ? 78 : 190, 1.25, 0], [subtle ? 48 : 105, .85, Math.PI / 2]].forEach(function (s) {
            var length = s[0], width = s[1];
            ctx.save(); ctx.rotate(s[2]);
            var light = ctx.createLinearGradient(-length, 0, length, 0);
            light.addColorStop(0, "rgba(158,158,255,0)"); light.addColorStop(.48, "rgba(205,211,255," + glint * .7 + ")"); light.addColorStop(.5, "rgba(241,242,255," + glint + ")");
            light.addColorStop(.52, "rgba(205,211,255," + glint * .7 + ")"); light.addColorStop(1, "rgba(158,158,255,0)");
            ctx.fillStyle = light; ctx.shadowColor = "#c1c5ff"; ctx.shadowBlur = 5;
            ctx.beginPath(); ctx.moveTo(-length, 0); ctx.quadraticCurveTo(-7, -width * .3, 0, -width); ctx.quadraticCurveTo(7, -width * .3, length, 0);
            ctx.quadraticCurveTo(7, width * .3, 0, width); ctx.quadraticCurveTo(-7, width * .3, -length, 0); ctx.fill(); ctx.restore();
          });
          ctx.restore();
        }
        particles.forEach(function (p) {
          var t = time - .12 - p.delay;
          if (t < 0 || !p.image.complete || !p.image.naturalWidth) return;
          var fade = Math.min(1, t * 12) * Math.max(0, Math.min(1, (2.6 - t) / .65));
          var travel = (1 - Math.exp(-t * .65)) / .65;
          ctx.save(); ctx.globalAlpha = fade;
          ctx.translate(x + p.vx * travel, y + p.vy * travel + 220 * t * t);
          ctx.rotate(p.phase + p.spin * t * .35);
          var rotation = p.phase + t * p.spin, face = Math.max(.025, Math.abs(Math.cos(rotation)));
          var thickness = p.size * .105 * Math.abs(Math.sin(rotation)), radius = p.size * .35, halfWidth = radius * face;
          var metal = ctx.createLinearGradient(0, -radius, 0, radius);
          (p.gold ? ["#fff2b8", "#bc8428", "#ffdf80", "#76501c", "#d4a54f"] : ["#ffffff", "#727e94", "#e7edff", "#464c60", "#b3c0d5"]).forEach(function (shade, i) { metal.addColorStop(i / 4, shade); });
          ctx.fillStyle = metal; ctx.beginPath(); ctx.ellipse(thickness / 2, 0, halfWidth, radius, 0, 0, Math.PI * 2); ctx.fill();
          ctx.fillRect(-thickness / 2, -radius, thickness, radius * 2);
          ctx.strokeStyle = p.gold ? "rgba(255,240,180,.55)" : "rgba(240,246,255,.55)"; ctx.lineWidth = .65;
          for (var ridge = -radius + 2; ridge < radius; ridge += 3) {
            ctx.beginPath(); ctx.moveTo(-thickness / 2, ridge);
            ctx.lineTo(thickness / 2 + halfWidth * Math.sqrt(Math.max(0, 1 - Math.pow(ridge / radius, 2))), ridge); ctx.stroke();
          }
          ctx.translate(-thickness / 2, 0); ctx.scale(face, 1);
          ctx.filter = "sepia(.22) saturate(.8) hue-rotate(325deg)"; ctx.shadowColor = "#9d9bff"; ctx.shadowBlur = 17;
          ctx.drawImage(p.image, -p.size / 2, -p.size / 2, p.size, p.size);
          ctx.globalCompositeOperation = "lighter"; ctx.globalAlpha = fade * .23;
          ctx.filter = "blur(6px) sepia(1) hue-rotate(195deg) saturate(1.2)";
          ctx.drawImage(p.image, -p.size / 2, -p.size / 2, p.size, p.size);
          ctx.restore();
        });
      },
      dispose: function () { canvas.remove(); }
    };
  }
  function fire(x, y, charge) {
    var burst = create(x, y, charge == null ? 2 : charge, false), start = performance.now();
    (function frame(now) {
      var t = (now - start) / 1000;
      burst.draw(t);
      if (t < 3) requestAnimationFrame(frame); else burst.dispose();
    })(start);
    return burst;
  }
  window.DonutBurst = { preload: preload, create: create, fire: fire };
})();
