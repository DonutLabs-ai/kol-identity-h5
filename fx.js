/*
 * Intro FX for the identity landing: a quiet scatter of sparks bursting outward from behind the card — small
 * stars and short streaks, lightly bloomed, with a touch of chromatic dispersion (pmndrs/postprocessing, the
 * library under @react-three/postprocessing). Deliberately understated: no glare body, rays or rings.
 * Vanilla three + postprocessing so it can ride on the static artifact bundle. Plays once per landing mount
 * (theme.js dispatches `donut:landing`), lasts ~3.4s, then tears itself down.
 */
import * as THREE from "three";
import {
  EffectComposer, RenderPass, EffectPass, BloomEffect, ChromaticAberrationEffect,
} from "postprocessing";

const reduce = matchMedia("(prefers-reduced-motion: reduce)");
const HOLD = (() => { const v = new URLSearchParams(location.search).get("fx"); return v && v.startsWith("hold") ? Number(v.slice(4)) || 0.9 : null; })();   // ?fx=hold1.2 freezes the timeline for inspection
const DURATION = 3.0;          // seconds

function ease(t) { return t < 0 ? 0 : t > 1 ? 1 : 1 - Math.pow(1 - t, 3); }
function bell(t, a, b, c) { /* 0 → 1 (at b) → 0, between a and c */
  if (t <= a || t >= c) return 0;
  return t < b ? ease((t - a) / (b - a)) : ease((c - t) / (c - b));
}

function play(art) {
  if (reduce.matches) return;
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ alpha: true, antialias: false, powerPreference: "high-performance", premultipliedAlpha: false });
  } catch { return; }
  const host = document.createElement("div");
  host.className = "donut-fx"; host.setAttribute("aria-hidden", "true");
  host.appendChild(renderer.domElement);
  art.prepend(host);

  const rect = () => host.getBoundingClientRect();
  let { width: W, height: H } = rect();
  W = Math.max(320, Math.round(W)); H = Math.max(320, Math.round(H));
  const dpr = Math.min(devicePixelRatio || 1, 1.5);
  renderer.setPixelRatio(dpr);
  renderer.setSize(W, H, false);
  renderer.setClearColor(0x000000, 0);
  renderer.domElement.style.width = "100%"; renderer.domElement.style.height = "100%";

  // Orthographic, 1 unit = 1 CSS px, origin at the canvas (= card) centre.
  const camera = new THREE.OrthographicCamera(-W / 2, W / 2, H / 2, -H / 2, 0.1, 100);
  camera.position.z = 10;
  const scene = new THREE.Scene();

  // Sparks: additive shards flung outward; bloom makes them read as light.
  const N = 160;
  const sparkGeo = new THREE.PlaneGeometry(1, 1);
  const sparks = new THREE.InstancedMesh(sparkGeo, new THREE.MeshBasicMaterial({ color: new THREE.Color("#ffffff"), transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false }), N);
  const sp = [];
  const palette = ["#ffffff", "#e9e4ff", "#acaaff", "#ffd9a8", "#9fe8ff", "#ffb7dc"];
  const col = new THREE.Color();
  for (let i = 0; i < N; i++) {
    const dot = Math.random() < 0.55;                       // ~half are star points, the rest short streaks
    const a = Math.random() * Math.PI * 2, speed = 160 + Math.random() * 480;
    const len = dot ? 1.6 + Math.random() * 2.2 : 6 + Math.random() * 22, w = dot ? len : 1 + Math.random() * 1.4;
    sp.push({ a, speed, len, w, dot, delay: Math.random() * 0.7, life: 1.0 + Math.random() * 1.1, tw: 3 + Math.random() * 6 });
    col.set(palette[i % palette.length]); sparks.setColorAt(i, col);
  }
  sparks.instanceColor && (sparks.instanceColor.needsUpdate = true);
  scene.add(sparks);
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), v3 = new THREE.Vector3(), s3 = new THREE.Vector3(), zAxis = new THREE.Vector3(0, 0, 1);

  // Post: light bloom so the sparks glow, and a whisper of dispersion on their edges.
  const composer = new EffectComposer(renderer, { multisampling: 0 });
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new BloomEffect({ intensity: 1.1, luminanceThreshold: 0.35, luminanceSmoothing: 0.25, mipmapBlur: true, radius: 0.6, levels: 5 });
  const aberration = new ChromaticAberrationEffect({ offset: new THREE.Vector2(0, 0), radialModulation: true, modulationOffset: 0.3 });
  composer.addPass(new EffectPass(camera, bloom, aberration));

  const clock = new THREE.Clock();
  let raf = 0, done = false;
  requestAnimationFrame(() => host.setAttribute("data-on", ""));

  function frame() {
    const t = HOLD != null ? HOLD : clock.getElapsedTime();
    // Dispersion: faint, only while the burst is live.
    const ab = 0.0035 * bell(t, 0.1, 0.7, 2.2);
    aberration.offset.set(ab, ab * 0.6);
    // Sparks.
    for (let i = 0; i < N; i++) {
      const p = sp[i]; const lt = t - 0.3 - p.delay;
      if (lt < 0 || lt > p.life) { s3.set(0.0001, 0.0001, 1); v3.set(0, 0, -1); m4.compose(v3, q, s3); sparks.setMatrixAt(i, m4); continue; }
      const k = lt / p.life; const dist = 30 + p.speed * (1 - Math.pow(1 - k, 2.4)) * 0.9;
      v3.set(Math.cos(p.a) * dist, Math.sin(p.a) * dist, 1);
      q.setFromAxisAngle(zAxis, p.a);
      const fade = 1 - k, twinkle = p.dot ? 0.65 + 0.35 * Math.sin(lt * p.tw) : 1;   // star points twinkle
      s3.set(Math.max(0.001, p.len * (p.dot ? fade * twinkle : 1 - k * 0.5)), Math.max(0.001, p.w * fade * twinkle), 1);
      m4.compose(v3, q, s3); sparks.setMatrixAt(i, m4);
    }
    sparks.instanceMatrix.needsUpdate = true;
    sparks.material.opacity = 0.95 * (1 - ease((t - 1.8) / 0.9));

    composer.render();
    if (t >= DURATION - 0.6) host.removeAttribute("data-on");
    if (t >= DURATION) return teardown();
    raf = requestAnimationFrame(frame);
  }
  function teardown() {
    if (done) return; done = true;
    cancelAnimationFrame(raf);
    composer.dispose(); renderer.dispose(); sparkGeo.dispose();
    host.remove();
  }
  const onResize = () => { const r = rect(); W = Math.round(r.width); H = Math.round(r.height); renderer.setSize(W, H, false); composer.setSize(W, H); camera.left = -W / 2; camera.right = W / 2; camera.top = H / 2; camera.bottom = -H / 2; camera.updateProjectionMatrix(); };
  addEventListener("resize", onResize, { passive: true });
  setTimeout(() => removeEventListener("resize", onResize), (DURATION + 1) * 1000);
  raf = requestAnimationFrame(frame);
}

addEventListener("donut:landing", (e) => { const art = e.detail && e.detail.art; if (art) play(art); });
// If theme.js fired before this module finished loading, catch the already-mounted landing.
const pending = document.querySelector(".landing .hero-art[data-fx-played]:not(:has(.donut-fx))");
if (pending && performance.now() < 4000) play(pending);
