#!/usr/bin/env node
/* Mock card-art backend — the endpoints from BACKEND.md, runnable locally (and deployable, see DEPLOY.md) so the H5
   hooks can be built and demoed before Sean's real service exists. Two pipelines, picked by --pipeline / CARD_PIPELINE:
     fast (default, Cory 2026-10-09): one Gemini call, avatar only — ~25 s, ~$0.14 (BACKEND.md §12)
     two: GPT card → Gemini restyle with the glare-set references — ~3.5 min, ~$0.39 (BACKEND.md §11; needs style-refs/)

   NODE_USE_ENV_PROXY=1 node tools/cardgen/server.mjs [--port 3022] [--host 0.0.0.0] [--pipeline fast|two] [--warm who:type:avatar]
   env: OPENROUTER_API_KEY (or ../../.env) · PORT · HOST · CARD_PIPELINE · CARD_BUDGET (USD cap per process, default 20)

   State model (PM, 2026-10-10): a job is {status, stage, error, layers}. `status` is the card itself (queued → running →
   done | failed); `layers` is the 2.5D pair (cut-out + clean plate: pending → ready | failed) and never holds the card
   back — the page decides what to show. Every "failed" and every "timeout" is the server's verdict (a provider error, a
   budget stop, or a stage that ran past its own limit); the browser never infers failure from waiting.

   POST /v1/identity/card-art            { avatar_url|avatar_data, handle, type }  → 200 done (cache) | 202 queued/running
   GET  /v1/identity/card-art/:job                                                 → queued | running | done | failed (+layers)
   POST /v1/identity/card-art/:job/layers                                          → re-run only the layers of a finished card
   GET  /art/<key>.png | .cut.png | .plate.jpg                                     → the files
   GET  /healthz                                                                   → ok + per-stage counters
   The real backend gets the avatar from X; here the client sends the (mock) avatar it is showing. */
import http from "node:http";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir, copyFile, readdir, unlink, appendFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { apiKey, loadPrompts, buildPrompt, generateImage, fastPrompt, Budget, STYLE_DIR, CARDGEN, HERE as HARNESS } from "./harness/lib.mjs";

const exec = promisify(execFile), require = createRequire(import.meta.url);
const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, all) => (v.startsWith("--") ? a.concat([[v.slice(2), all[i + 1] && !all[i + 1].startsWith("--") ? all[i + 1] : true]]) : a), []));
const PORT = Number(args.port || process.env.PORT || 3022), HOST = String(args.host || process.env.HOST || "127.0.0.1");
const PIPELINE = String(args.pipeline || process.env.CARD_PIPELINE || "fast");
const CACHE = join(CARDGEN, "out/server-cache"); await mkdir(CACHE, { recursive: true });
const METRICS_LOG = join(CACHE, "jobs.jsonl");          /* one line per stage attempt: llm / layers, ok, ms, error, cost */
const LAYERS_TIMEOUT = 180000;                           /* the segmenter's own limit; past it the layers are "failed: timeout" (server verdict) */
const key = await apiKey(), prompts = await loadPrompts(), budget = new Budget(Number(args.cap || process.env.CARD_BUDGET || 20));
const jobs = new Map();
/* QA switches (BACKEND.md §4): POST …?fault=llm → the LLM stage fails with provider_error after 2 s (no call made);
   POST …?fault=layers → the layers verdict is "failed: simulated" for that card until a layers retry. Never set in production. */
const faultLayers = new Set();
const PHOTO_AVATAR = /\.(jpe?g)$/i;   /* photo avatars get --face-clean in the restyle; drawn ones don't */

function refsFor(type) { const f = join(STYLE_DIR, `figma/refs-${type}.txt`); if (!existsSync(f)) return []; return require("node:fs").readFileSync(f, "utf8").split("\n").filter(Boolean).map((n) => ["webp", "jpg", "png"].map((e) => join(STYLE_DIR, n + "." + e)).find(existsSync)).filter(Boolean); }

/* extension from the bytes (magic numbers) — the URL's suffix lied for PNG avatars fetched via a .jpg-looking path */
const extOf = (buf) => buf[0] === 0x89 && buf[1] === 0x50 ? ".png" : buf[0] === 0x52 && buf[8] === 0x57 ? ".webp" : buf[0] === 0x47 ? ".gif" : ".jpg";
const cacheKey = (avatarBytes, type) => createHash("sha256").update(avatarBytes).update(":" + type + ":" + prompts.version + ":v2").digest("hex").slice(0, 24);

/* ── per-stage bookkeeping: LLM and layers are counted apart (never one merged failure rate) ── */
const metrics = { llm: { ok: 0, failed: 0, timeout: 0 }, layers: { ok: 0, failed: 0, timeout: 0 } };
async function record(stage, key, type, ok, ms, error, cost) {
  metrics[stage][ok ? "ok" : error === "timeout" ? "timeout" : "failed"]++;
  await appendFile(METRICS_LOG, JSON.stringify({ t: new Date().toISOString(), key, type, stage, ok, ms, error: error || undefined, cost: cost || undefined }) + "\n").catch(() => {});
}
/* an error from the provider or the runner, reduced to the codes BACKEND.md names */
function classify(e) {
  const m = String(e && e.message || e);
  if (/abort|timed? ?out|ETIMEDOUT|killed/i.test(m)) return "timeout";
  if (/budget|cap /i.test(m)) return "budget";
  if (/moderat|safety|refus|blocked/i.test(m)) return "moderation_blocked";
  return "provider_error";
}

/* ── subject cut-out + clean plate for the H5's 2.5D portrait (BACKEND.md §4 step 5b) ──
   <key>.cut.png = RGBA subject only · <key>.plate.jpg = the art with the subject blurred away · <key>.cut.none = the
   server's verdict that this card has no usable layers (the reason inside); a retry deletes it. macOS Vision via
   harness/cutout.swift (built on first use), rembg via harness/cutout.py elsewhere. Single-flight per key: the job and
   the polls used to start the segmenter concurrently (three rembg processes on a 2 GB machine → OOM, 2026-10-09). */
const CUTOUT_BIN = join(HARNESS, "bin/cutout"), CUTOUT_SRC = join(HARNESS, "cutout.swift"), CUTOUT_PY = join(HARNESS, "cutout.py");
const MAC = process.platform === "darwin";
let cutoutReady = null;
function ensureCutout() {
  return cutoutReady || (cutoutReady = (async () => {
    if (MAC) {
      if (existsSync(CUTOUT_BIN)) return true;
      try { await mkdir(join(HARNESS, "bin"), { recursive: true }); await exec("swiftc", ["-O", CUTOUT_SRC, "-o", CUTOUT_BIN]); return true; }
      catch (e) { console.error("cutout: cannot build (" + String(e.message).split("\n")[0] + ") — cards ship without the 2.5D layer"); return false; }
    }
    try { await exec("python3", ["-c", "import rembg, PIL, numpy"]); return true; }   /* the Python twin (rembg), see Dockerfile */
    catch (e) { console.error("cutout: python3 with rembg not found — cards ship without the 2.5D layer"); return false; }
  })());
}
const cutoutCmd = (png, cut, plate) => MAC ? [CUTOUT_BIN, [png, cut, plate]] : ["python3", [CUTOUT_PY, png, cut, plate]];
const layerFiles = (k) => ({ png: join(CACHE, k + ".png"), cut: join(CACHE, k + ".cut.png"), plate: join(CACHE, k + ".plate.jpg"), none: join(CACHE, k + ".cut.none") });
const inflight = new Map();
function cutoutFor(key, type) {
  if (inflight.has(key)) return inflight.get(key);
  const p = cutoutRun(key, type).finally(() => inflight.delete(key));
  inflight.set(key, p); return p;
}
async function cutoutRun(key, type) {
  const F = layerFiles(key);
  if (existsSync(F.cut) && existsSync(F.plate)) return "ready";
  if (existsSync(F.none) || !existsSync(F.png)) return "failed";
  if (!(await ensureCutout())) { await writeFile(F.none, "no_segmenter"); await record("layers", key, type, false, 0, "no_segmenter"); return "failed"; }
  const t0 = Date.now();
  try {
    const [bin, argv] = cutoutCmd(F.png, F.cut, F.plate);
    const { stdout } = await exec(bin, argv, { maxBuffer: 1 << 20, timeout: LAYERS_TIMEOUT });
    const cov = Number((/coverage ([\d.]+)/.exec(stdout) || [])[1]);
    if (!(cov >= 0.03 && cov <= 0.9)) throw new Error("coverage " + cov);   /* nothing lifted, or the whole frame: no depth to gain */
    console.log("cutout", key, "coverage", cov.toFixed(2), Date.now() - t0, "ms");
    await record("layers", key, type, true, Date.now() - t0);
    return "ready";
  } catch (e) {
    const code = /coverage/.test(String(e.message)) ? "no_subject" : classify(e);
    await writeFile(F.none, code); for (const f of [F.cut, F.plate]) if (existsSync(f)) await unlink(f);
    await record("layers", key, type, false, Date.now() - t0, code);
    console.error("cutout", key, "failed:", code, String(e.message || e).split("\n")[0]); return "failed";
  }
}
/* the layers block of every answer: ready (urls) / failed (reason) / pending (a run is on its way — started here if needed) */
function layersFor(k, type) {
  const F = layerFiles(k);
  if (faultLayers.has(k)) return { status: "failed", error: "simulated" };
  if (existsSync(F.cut) && existsSync(F.plate)) return { status: "ready", cutout_url: `/art/${k}.cut.png`, plate_url: `/art/${k}.plate.jpg` };
  if (existsSync(F.none)) return { status: "failed", error: require("node:fs").readFileSync(F.none, "utf8").trim() || "failed" };
  cutoutFor(k, type).catch(() => {});
  return { status: "pending" };
}
/* "Retry 3D effect": forget the verdict, run the layers again for the same card; the LLM is never involved */
async function retryLayers(k, type) {
  const F = layerFiles(k); faultLayers.delete(k);
  if (existsSync(F.none) && !inflight.has(k)) await unlink(F.none);
  return layersFor(k, type);
}

async function pipeline(job) {
  const { avatarPath, type } = job, t0 = Date.now();
  job.status = "running";
  try {
    if (job.fault === "llm") { job.stage = "gemini"; await new Promise((r) => setTimeout(r, 2000)); throw new Error("simulated provider failure (?fault=llm)"); }
    if (PIPELINE === "fast") {
      /* one Gemini call: the avatar and the type's gear + action, style named in the text (harness/fast.mjs) */
      job.stage = "gemini";
      const action = prompts.types[type].replace(/\s+/g, " ").trim();
      const g = await generateImage({ key, model: "google/gemini-3-pro-image", prompt: fastPrompt(action), avatarPath, refs: [], budget });
      await writeFile(join(CACHE, job.key + ".png"), g.png); job.cost = g.cost;
    } else {
      job.stage = "gpt";
      const refs = refsFor(type);
      const g = await generateImage({ key, model: "openai/gpt-5.4-image-2", prompt: buildPrompt(prompts, prompts.style, type), avatarPath, refs, brandPath: join(CARDGEN, "refs/donut-ribbons.webp"), budget, refMode: "style" });
      const stage1 = join(CACHE, job.key + ".stage1.png"); await writeFile(stage1, g.png);
      job.stage = "gemini";
      const faceClean = PHOTO_AVATAR.test(avatarPath) ? ["--face-clean"] : [];
      await exec("node", [join(HARNESS, "restyle.mjs"), "--image", stage1, "--avatar", avatarPath, "--type", type, "--refs", refs.map((p) => "figma/" + p.split("/").pop().replace(/\.\w+$/, "")).join(","), "--name", "server-" + job.key, "--brand", "--edge-sparkle", ...faceClean], { env: { ...process.env, NODE_USE_ENV_PROXY: "1" } });
      await copyFile(join(CARDGEN, "out/restyle", "server-" + job.key, "restyled.png"), join(CACHE, job.key + ".png"));
    }
  } catch (e) {
    job.status = "failed"; job.error = classify(e); job.detail = String(e.message || e).slice(0, 200);
    await record("llm", job.key, type, false, Date.now() - t0, job.error);
    console.error("job", job.key, "failed:", job.error, job.detail); return;
  }
  job.llm_ms = Date.now() - t0; await record("llm", job.key, type, true, job.llm_ms, null, job.cost);
  job.status = "done"; job.image_url = `/art/${job.key}.png`;
  /* the 2.5D layers follow on their own (0.3 s on macOS Vision, ~10 s on Fly): answers carry layers.status */
  job.stage = "cutout"; cutoutFor(job.key, type).catch(() => {});
}

const json = (res, code, body) => { res.writeHead(code, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "content-type", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" }); res.end(JSON.stringify(body)); };
const doneAnswer = (k, type, extra = {}) => ({ status: "done", job_id: k, image_url: `/art/${k}.png`, layers: layersFor(k, type), prompt_version: prompts.version, ...extra });
http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, "http://x");
    if (req.method === "OPTIONS") return json(res, 204, {});
    if (u.pathname === "/healthz") return json(res, 200, { ok: true, pipeline: PIPELINE, spent_usd: Number(budget.spent.toFixed(3)), prompt_version: prompts.version, metrics });
    if (u.pathname.startsWith("/art/")) {
      const name = u.pathname.slice(5); if (!/^[a-f0-9]+(\.png|\.cut\.png|\.plate\.jpg)$/.test(name)) return json(res, 404, { error: "not_found" });
      const f = join(CACHE, name); if (!existsSync(f)) return json(res, 404, { error: "not_found" });
      res.writeHead(200, { "Content-Type": name.endsWith(".jpg") ? "image/jpeg" : "image/png", "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=86400" }); return res.end(await readFile(f));
    }
    if (req.method === "POST" && u.pathname === "/v1/identity/card-art") {
      let body = ""; for await (const c of req) body += c; const b = JSON.parse(body || "{}");
      if (!prompts.types[b.type]) return json(res, 400, { error: "unknown_type" });
      let avatarBytes;
      if (b.avatar_data) { avatarBytes = Buffer.from(String(b.avatar_data).split(",").pop(), "base64"); }
      else if (b.avatar_url) { const r = await fetch(new URL(b.avatar_url, "http://127.0.0.1:3021/")); avatarBytes = Buffer.from(await r.arrayBuffer()); }
      else return json(res, 400, { error: "no_avatar" });
      const k = cacheKey(avatarBytes, b.type), fault = u.searchParams.get("fault") || "";
      if (fault === "layers") faultLayers.add(k);
      if (existsSync(join(CACHE, k + ".png")) && fault !== "llm") return json(res, 200, doneAnswer(k, b.type, { cached: true }));
      /* a finished or failed record whose output isn't there is not reused: a new POST is a new attempt (counted) */
      const stale = jobs.get(k); if (stale && (stale.status === "done" || stale.status === "failed")) jobs.delete(k);
      if (!jobs.has(k)) {
        /* ".avatar" in the name: a PNG avatar saved as <key>.png was mistaken for the finished art (instant "done" with the avatar as the card) */
        const avatarPath = join(CACHE, k + ".avatar" + extOf(avatarBytes)); await writeFile(avatarPath, avatarBytes);
        const job = { id: k, key: k, type: b.type, avatarPath, status: "queued", started: Date.now(), attempt: (stale ? stale.attempt || 1 : 0) + 1, fault: fault === "llm" ? "llm" : "" }; jobs.set(k, job);
        pipeline(job).catch((e) => { job.status = "failed"; job.error = classify(e); console.error("job", k, "crashed:", e.message); });
      }
      const job = jobs.get(k); return json(res, 202, { status: job.status, stage: job.stage || null, job_id: k, attempt: job.attempt });
    }
    const m = /^\/v1\/identity\/card-art\/([a-f0-9]+)(\/layers)?$/.exec(u.pathname);
    if (m) {
      const k = m[1], job = jobs.get(k), type = job ? job.type : "unresolved";
      if (m[2]) {   /* POST …/layers: re-run only the layers of a finished card */
        if (req.method !== "POST") return json(res, 405, { error: "method_not_allowed" });
        if (!existsSync(join(CACHE, k + ".png"))) return json(res, 404, { error: "not_found" });
        const layers = await retryLayers(k, type);
        return json(res, layers.status === "ready" ? 200 : 202, { status: "done", job_id: k, image_url: `/art/${k}.png`, layers, prompt_version: prompts.version });
      }
      if (req.method !== "GET") return json(res, 405, { error: "method_not_allowed" });
      /* a QA-faulted job reports its own verdict even though a cached card exists for the key */
      if (existsSync(join(CACHE, k + ".png")) && !(job && job.fault === "llm" && job.status !== "done")) return json(res, 200, doneAnswer(k, type, job ? { elapsed_s: Math.round((Date.now() - job.started) / 1000), llm_ms: job.llm_ms } : {}));
      if (!job) return json(res, 404, { error: "not_found" });
      if (job.status === "done") { jobs.delete(k); return json(res, 200, { status: "failed", error: "output_missing", job_id: k }); }   /* done but the PNG is gone */
      return json(res, 200, { status: job.status, stage: job.stage || null, error: job.error, job_id: k, attempt: job.attempt, elapsed_s: Math.round((Date.now() - job.started) / 1000) });
    }
    json(res, 404, { error: "not_found" });
  } catch (e) { json(res, 500, { error: "server_error", message: e.message }); }
}).listen(PORT, HOST, () => console.log(`card-art mock backend on http://${HOST}:${PORT}  pipeline=${PIPELINE}  (cache ${CACHE})`));

/* --warm who:type:avatar → pre-compute (or register an existing PNG via --warm-from path) */
if (args.warm) {
  const [who, type, avatar] = String(args.warm).split(":"); const bytes = await readFile(resolve(CARDGEN, avatar)); const k = cacheKey(bytes, type);
  if (args["warm-from"]) { await copyFile(resolve(CARDGEN, String(args["warm-from"])), join(CACHE, k + ".png")); await cutoutFor(k, type); console.log(`warm: ${who}/${type} ← ${args["warm-from"]} (key ${k})`); }
  else if (!existsSync(join(CACHE, k + ".png"))) { const p = join(CACHE, k + ".avatar" + extOf(bytes)); await writeFile(p, bytes); const job = { id: k, key: k, type, avatarPath: p, status: "queued", started: Date.now(), attempt: 1 }; jobs.set(k, job); pipeline(job).then(() => console.log("warm done", k)).catch((e) => console.error("warm failed", e.message)); }
  else console.log(`warm: ${who}/${type} already cached (key ${k})`);
}

/* layers for art cached before this step existed (sequential, ~0.3 s each on macOS) */
(async () => { for (const f of await readdir(CACHE)) { const m = /^([a-f0-9]+)\.png$/.exec(f); if (m) await cutoutFor(m[1], "unresolved"); } })().catch((e) => console.error("cutout sweep:", e.message));
