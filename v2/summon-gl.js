/* WebGL particle field for the "D0 is reading" scene (Cory 2026-10-08: "加一点 WebGL 3D 特效"): ~1100 additive points
   orbiting the seal in its own tilted plane (inner ones faster, the front ones larger and brighter), plus sparks that
   rise from the disc into the card. Raw WebGL1, no library; sits behind the stage; skipped under reduced motion. */
(function () {
  var VS = [
    "attribute vec4 a; attribute float k;",            /* a = (r01, theta0, h0, rnd) · k = 0 orbit, 1 spark */
    "uniform float t, rx, ry, dpr, boost; uniform vec2 c, res;",
    "varying float vA; varying float vMix;",
    "void main(){",
    "  float r01 = a.x, th0 = a.y, h0 = a.z, rnd = a.w;",
    "  vec2 p; float depth; float size; float alpha;",
    "  if (k < .5) {",
    "    float r = mix(.3, 1.12, r01);",
    "    float w = .22 / sqrt(r01 + .25);",              /* inner orbits turn faster */
    "    float th = th0 + t * w;",
    "    float x = cos(th) * r, zd = sin(th) * r;",
    "    float h = (h0 * 16. + sin(t * .8 + rnd * 6.28) * 3.) * dpr;",
    "    p = c + vec2(x * rx, zd * ry - h);",
    "    depth = zd;",
    "    size = (1.1 + rnd * 2.4) * (1. + depth * .35);",
    "    alpha = (.3 + .7 * (.5 + .5 * sin(t * 2.5 + rnd * 20.))) * (.55 + .45 * depth);",
    "  } else {",
    "    float L = 2.6 + rnd * 2.2; float ph = fract((t + rnd * 10.) / L);",
    "    float r = mix(.45, 1., r01) * (1. - ph * .55);",
    "    float x = cos(th0) * r, zd = sin(th0) * r;",
    "    p = c + vec2(x * rx, zd * ry - ph * ry * 2.6);",  /* rises from the disc up into the card */
    "    depth = zd;",
    "    size = 1.4 + rnd * 1.8;",
    "    alpha = sin(ph * 3.1416) * .85;",
    "  }",
    "  vA = alpha * boost; vMix = r01 * .7 + rnd * .3;",
    "  gl_PointSize = size * dpr * 2.2;",
    "  vec2 clip = (p / res) * 2. - 1.; gl_Position = vec4(clip.x, -clip.y, 0., 1.);",
    "}"].join("\n");
  var FS = [
    "precision mediump float; varying float vA; varying float vMix;",
    "void main(){",
    "  float d = length(gl_PointCoord - .5) * 2.; if (d > 1.) discard;",
    "  float a = pow(1. - d, 1.6) * vA;",
    "  vec3 violet = vec3(.62, .5, 1.), amber = vec3(1., .78, .5), cream = vec3(1., .96, .9);",
    "  vec3 col = mix(violet, amber, smoothstep(.35, .9, vMix)); col = mix(col, cream, pow(1. - d, 6.) * .6);",
    "  gl_FragColor = vec4(col * a, a);",
    "}"].join("\n");
  var N_ORBIT = 900, N_SPARK = 220, state = null;
  function mount(root) {
    var stage = root.querySelector(".ds-stage"), seal = root.querySelector(".ds-seal"), card = root.querySelector(".ds-card");
    if (!stage || !seal || !card) return;
    var canvas = document.createElement("canvas"), gl = null;
    canvas.className = "ds-gl"; canvas.setAttribute("aria-hidden", "true");
    canvas.style.cssText = "position:absolute;inset:0;width:100%;height:100%;z-index:0;pointer-events:none;opacity:0;transition:opacity 1.6s ease .5s";
    try { gl = canvas.getContext("webgl", { alpha: true, premultipliedAlpha: true, antialias: false, powerPreference: "low-power" }); } catch (e) {}
    if (!gl) return;
    root.insertBefore(canvas, root.firstChild);
    function sh(type, src) { var s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; }
    var prog = gl.createProgram(); gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS)); gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    gl.useProgram(prog);
    var N = N_ORBIT + N_SPARK, data = new Float32Array(N * 5);
    for (var i = 0; i < N; i++) { var o = i * 5, spark = i >= N_ORBIT; data[o] = Math.pow(Math.random(), spark ? 1 : .8); data[o + 1] = Math.random() * Math.PI * 2; data[o + 2] = (Math.random() - .5) * 2; data[o + 3] = Math.random(); data[o + 4] = spark ? 1 : 0; }
    var buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf); gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    var aLoc = gl.getAttribLocation(prog, "a"), kLoc = gl.getAttribLocation(prog, "k");
    gl.enableVertexAttribArray(aLoc); gl.vertexAttribPointer(aLoc, 4, gl.FLOAT, false, 20, 0);
    gl.enableVertexAttribArray(kLoc); gl.vertexAttribPointer(kLoc, 1, gl.FLOAT, false, 20, 16);
    var U = {}; ["t", "rx", "ry", "dpr", "boost", "c", "res"].forEach(function (n) { U[n] = gl.getUniformLocation(prog, n); });
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE); gl.clearColor(0, 0, 0, 0);
    var dpr = Math.min(2, window.devicePixelRatio || 1), boost = 1, target = 1, t0 = performance.now();
    function size() { var r = root.getBoundingClientRect(); canvas.width = Math.max(1, Math.round(r.width * dpr)); canvas.height = Math.max(1, Math.round(r.height * dpr)); gl.viewport(0, 0, canvas.width, canvas.height); }
    size(); addEventListener("resize", size);
    requestAnimationFrame(function () { canvas.style.opacity = "1"; });
    function frame(now) {
      if (!root.isConnected) return;
      requestAnimationFrame(frame);
      if (document.hidden) return;
      var rr = root.getBoundingClientRect(), sr = stage.getBoundingClientRect();
      var rx = seal.offsetWidth / 2, ry = rx * .4067;   /* the seal is rotateX(66deg): its circle shows as this ellipse */
      var cx = sr.left - rr.left, cy = sr.top - rr.top + card.offsetHeight * .46;
      boost += (target - boost) * .06;
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.uniform1f(U.t, (now - t0) / 1000); gl.uniform1f(U.rx, rx * dpr); gl.uniform1f(U.ry, ry * dpr); gl.uniform1f(U.dpr, dpr); gl.uniform1f(U.boost, boost);
      gl.uniform2f(U.c, cx * dpr, cy * dpr); gl.uniform2f(U.res, canvas.width, canvas.height);
      gl.drawArrays(gl.POINTS, 0, N);
    }
    requestAnimationFrame(frame);
    state = { setBoost: function (v) { target = v; } };
  }
  /* the reveal flare: the field flashes, then settles a little brighter */
  function flare() { if (!state) return; state.setBoost(2.8); setTimeout(function () { state.setBoost(1.5); }, 900); }
  window.DonutSummonGL = { mount: function (root) { try { mount(root); } catch (e) { console.warn("summon-gl:", e.message); } }, flare: flare };
})();
