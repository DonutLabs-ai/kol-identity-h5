/*
 * Intro FX for the identity landing: a glowing body behind the card, volumetric glare (GodRays), Bloom and
 * animated ChromaticAberration from pmndrs/postprocessing (the library under @react-three/postprocessing).
 * Vanilla three + postprocessing so it can ride on the static artifact bundle. Plays once per landing mount
 * (theme.js dispatches `donut:landing`), lasts ~3.4s, then tears itself down.
 */
import * as THREE from "three";
import {
  EffectComposer, RenderPass, EffectPass, BloomEffect, GodRaysEffect, ChromaticAberrationEffect,
  KernelSize, BlendFunction,
} from "postprocessing";

const reduce = matchMedia("(prefers-reduced-motion: reduce)");
const HOLD = (() => { const v = new URLSearchParams(location.search).get("fx"); return v && v.startsWith("hold") ? Number(v.slice(4)) || 0.9 : null; })();   // ?fx=hold1.2 freezes the timeline for inspection
const DURATION = 3.0;          // seconds
const SPIN = 2.6;              // matches .hero-card donut-spin-in

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

  // The glowing body: a soft violet-white disc the card appears to be born from.
  const sunMat = new THREE.MeshBasicMaterial({ color: new THREE.Color("#cfc6ff"), transparent: true, opacity: 1 });
  const sun = new THREE.Mesh(new THREE.CircleGeometry(1, 64), sunMat);
  sun.scale.setScalar(1);
  scene.add(sun);

  // A thin ring that expands with the burst (bloom turns it into a halo).
  const ringMat = new THREE.MeshBasicMaterial({ color: new THREE.Color("#acaaff"), transparent: true, opacity: 0, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.96, 1, 96), ringMat);
  scene.add(ring);

  // Anamorphic glare: a razor-thin horizontal streak (and a shorter vertical one) that bloom turns into lens glare.
  const streakMat = new THREE.MeshBasicMaterial({ color: new THREE.Color("#ffffff"), transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
  const streakH = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), streakMat); scene.add(streakH);
  const streakV = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), streakMat); scene.add(streakV);

  // Sparks: additive shards flung outward; bloom makes them read as light.
  const N = 90;
  const sparkGeo = new THREE.PlaneGeometry(1, 1);
  const sparks = new THREE.InstancedMesh(sparkGeo, new THREE.MeshBasicMaterial({ color: new THREE.Color("#ffffff"), transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false }), N);
  const sp = [];
  const palette = ["#ffffff", "#e9e4ff", "#acaaff", "#ffd9a8", "#9fe8ff", "#ffb7dc"];
  const col = new THREE.Color();
  for (let i = 0; i < N; i++) {
    const a = Math.random() * Math.PI * 2, speed = 220 + Math.random() * 520, len = 10 + Math.random() * 46, w = 1.2 + Math.random() * 2.2;
    sp.push({ a, speed, len, w, delay: Math.random() * 0.5, life: 0.9 + Math.random() * 0.9 });
    col.set(palette[i % palette.length]); sparks.setColorAt(i, col);
  }
  sparks.instanceColor && (sparks.instanceColor.needsUpdate = true);
  scene.add(sparks);
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), v3 = new THREE.Vector3(), s3 = new THREE.Vector3(), zAxis = new THREE.Vector3(0, 0, 1);

  // Post: volumetric glare from the sun, bloom on everything bright, animated dispersion.
  const composer = new EffectComposer(renderer, { multisampling: 0 });
  composer.addPass(new RenderPass(scene, camera));
  const godRays = new GodRaysEffect(camera, sun, {
    height: 480, kernelSize: KernelSize.MEDIUM, density: 0.96, decay: 0.94, weight: 0.6, exposure: 0.7, samples: 64, clampMax: 1.0, blur: true,
  });
  const bloom = new BloomEffect({ intensity: 1.8, luminanceThreshold: 0.22, luminanceSmoothing: 0.3, mipmapBlur: true, radius: 0.8, levels: 7 });
  const aberration = new ChromaticAberrationEffect({ offset: new THREE.Vector2(0, 0), radialModulation: true, modulationOffset: 0.35 });
  composer.addPass(new EffectPass(camera, godRays, bloom));
  composer.addPass(new EffectPass(camera, aberration));

  const clock = new THREE.Clock();
  let raf = 0, done = false;
  requestAnimationFrame(() => host.setAttribute("data-on", ""));

  function frame() {
    const t = HOLD != null ? HOLD : clock.getElapsedTime();
    const spinT = Math.min(1, t / SPIN);
    // Sun: ignites fast, holds while the card spins, collapses as the card settles.
    const ignite = ease(t / 0.3);
    const collapse = 1 - ease((t - 1.5) / 1.1);            // flare is over by ~2.6s, as the card settles
    const sunR = (12 + 96 * ignite) * (0.2 + 0.8 * collapse);
    sun.scale.setScalar(Math.max(0.001, sunR));
    sunMat.opacity = Math.min(1, ignite) * (0.05 + 0.95 * collapse);
    godRays.godRaysMaterial.exposure = 0.9 * ignite * (0.1 + 0.9 * collapse);
    godRays.godRaysMaterial.weight = 0.6 * (0.25 + 0.75 * collapse);
    godRays.godRaysMaterial.density = 0.95 + 0.02 * Math.sin(t * 2.0);
    // Halo ring: expands from the card edge and thins out.
    const ringT = ease((t - 0.2) / 1.4);
    ring.scale.setScalar(Math.max(0.001, 40 + ringT * Math.max(W, H) * 0.5));
    ringMat.opacity = 0.7 * bell(t, 0.2, 0.5, 1.6);
    // Glare streaks flash with ignition and stretch as they fade.
    const g = bell(t, 0.05, 0.45, 1.5);
    streakMat.opacity = g;
    streakH.scale.set(Math.max(0.001, W * (0.5 + 0.9 * ease(t / 1.2))), Math.max(0.001, 2.2 + 3 * g), 1);
    streakV.scale.set(Math.max(0.001, 1.6 + 2 * g), Math.max(0.001, H * (0.2 + 0.4 * ease(t / 1.2))), 1);
    // Dispersion peaks mid-spin then relaxes to zero.
    const ab = 0.009 * bell(t, 0.1, 0.7, 2.2) + 0.002 * (1 - spinT);
    aberration.offset.set(ab, ab * 0.6);
    bloom.intensity = 0.9 + 1.3 * bell(t, 0.1, 0.7, 2.3);
    // Sparks.
    for (let i = 0; i < N; i++) {
      const p = sp[i]; const lt = t - 0.3 - p.delay;
      if (lt < 0 || lt > p.life) { s3.set(0.0001, 0.0001, 1); v3.set(0, 0, -1); m4.compose(v3, q, s3); sparks.setMatrixAt(i, m4); continue; }
      const k = lt / p.life; const dist = 26 + p.speed * (1 - Math.pow(1 - k, 2.2)) * 0.9;
      v3.set(Math.cos(p.a) * dist, Math.sin(p.a) * dist, 1);
      q.setFromAxisAngle(zAxis, p.a);
      s3.set(p.len * (1 - k * 0.6), p.w * (1 - k), 1);
      m4.compose(v3, q, s3); sparks.setMatrixAt(i, m4);
    }
    sparks.instanceMatrix.needsUpdate = true;
    sparks.material.opacity = 0.9 * (1 - ease((t - 1.6) / 0.8));

    composer.render();
    if (t >= DURATION - 0.6) host.removeAttribute("data-on");
    if (t >= DURATION) return teardown();
    raf = requestAnimationFrame(frame);
  }
  function teardown() {
    if (done) return; done = true;
    cancelAnimationFrame(raf);
    composer.dispose(); renderer.dispose(); sparkGeo.dispose(); sun.geometry.dispose(); ring.geometry.dispose(); streakH.geometry.dispose(); streakV.geometry.dispose();
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
