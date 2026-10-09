#!/usr/bin/env node
/* Mock card-art backend — the endpoints from BACKEND.md, runnable locally (and deployable, see DEPLOY.md) so the H5
   hooks can be built and demoed before Sean's real service exists. Two pipelines, picked by --pipeline / CARD_PIPELINE:
     fast (default, Cory 2026-10-09): one Gemini call, avatar only — ~24 s, ~$0.14 (BACKEND.md §12)
     two: GPT card → Gemini restyle with the glare-set references — ~3.5 min, ~$0.39 (BACKEND.md §11; needs style-refs/)

   NODE_USE_ENV_PROXY=1 node tools/cardgen/server.mjs [--port 3022] [--host 0.0.0.0] [--pipeline fast|two] [--warm who:type:avatar]
   env: OPENROUTER_API_KEY (or ../../.env) · PORT · HOST · CARD_PIPELINE · CARD_BUDGET (USD cap per process, default 20)

   POST /v1/identity/card-art   { avatar_url|avatar_data, handle, type }  → 200 done (cache) | 202 queued
   GET  /v1/identity/card-art/:job                                          → queued | running | done | failed
   GET  /art/<file>                                                         → the generated PNGs
   The real backend gets the avatar from X; here the client sends the (mock) avatar it is showing. */
import http from "node:http";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir, copyFile, readdir, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { apiKey, loadPrompts, buildPrompt, generateImage, fastPrompt, Budget, STYLE_DIR, CARDGEN, HERE as HARNESS } from "./harness/lib.mjs";

const exec = promisify(execFile);
const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, all) => (v.startsWith("--") ? a.concat([[v.slice(2), all[i + 1] && !all[i + 1].startsWith("--") ? all[i + 1] : true]]) : a), []));
const PORT = Number(args.port || process.env.PORT || 3022), HOST = String(args.host || process.env.HOST || "127.0.0.1");
const PIPELINE = String(args.pipeline || process.env.CARD_PIPELINE || "fast");
const CACHE = join(CARDGEN, "out/server-cache"); await mkdir(CACHE, { recursive: true });
const key = await apiKey(), prompts = await loadPrompts(), budget = new Budget(Number(args.cap || process.env.CARD_BUDGET || 20));
const jobs = new Map();
const PHOTO_AVATAR = /\.(jpe?g)$/i;   /* photo avatars get --face-clean in the restyle; drawn ones don't */

function refsFor(type) { const f = join(STYLE_DIR, `figma/refs-${type}.txt`); if (!existsSync(f)) return []; return readFileSyncLines(f); }
function readFileSyncLines(f) { return require("node:fs").readFileSync(f, "utf8").split("\n").filter(Boolean).map((n) => ["webp", "jpg", "png"].map((e) => join(STYLE_DIR, n + "." + e)).find(existsSync)).filter(Boolean); }
import { createRequire } from "node:module"; const require = createRequire(import.meta.url);

/* extension from the bytes (magic numbers) — the URL's suffix lied for PNG avatars fetched via a .jpg-looking path */
const extOf = (buf) => buf[0] === 0x89 && buf[1] === 0x50 ? ".png" : buf[0] === 0x52 && buf[8] === 0x57 ? ".webp" : buf[0] === 0x47 ? ".gif" : ".jpg";
/* subject cut-out for the H5's 2.5D portrait (BACKEND.md §4 step 5b): the art's foreground lifted onto alpha, so the
   reveal can float the figure in front of the art. macOS Vision via harness/cutout.swift, built on first use.
   <key>.cut.png = RGBA subject only · <key>.plate.jpg = the art with the subject blurred away (the plane under the cut-out, so
   no second rim shows while they pan apart) · <key>.cut.none = tried, nothing usable (so polls don't retry) */
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
/* → { cutout_url, plate_url } or {}. Single-flight per key: the job and the polls used to start the segmenter
   concurrently (three rembg processes on a 2 GB machine → out of memory, 2026-10-09); now they share one run. */
const inflight = new Map();
function cutoutFor(key) {
  if (inflight.has(key)) return inflight.get(key);
  const p = cutoutRun(key).finally(() => inflight.delete(key));
  inflight.set(key, p); return p;
}
async function cutoutRun(key) {
  const png = join(CACHE, key + ".png"), cut = join(CACHE, key + ".cut.png"), plate = join(CACHE, key + ".plate.jpg"), none = join(CACHE, key + ".cut.none");
  const urls = { cutout_url: `/art/${key}.cut.png`, plate_url: `/art/${key}.plate.jpg` };
  if (existsSync(cut) && existsSync(plate)) return urls;
  if (existsSync(none) || !existsSync(png) || !(await ensureCutout())) return {};
  try {
    const [bin, argv] = cutoutCmd(png, cut, plate); const { stdout } = await exec(bin, argv, { maxBuffer: 1 << 20 });
    const cov = Number((/coverage ([\d.]+)/.exec(stdout) || [])[1]);
    if (!(cov >= 0.03 && cov <= 0.9)) throw new Error("coverage " + cov);   /* nothing lifted, or the whole frame: no depth to gain */
    console.log("cutout", key, "coverage", cov.toFixed(2));
    return urls;
  } catch (e) {
    await writeFile(none, String(e.message || e)); for (const f of [cut, plate]) if (existsSync(f)) await unlink(f);
    console.error("cutout", key, "skipped:", String(e.message || e).split("\n")[0]); return {};
  }
}
const cacheKey = (avatarBytes, type) => createHash("sha256").update(avatarBytes).update(":" + type + ":" + prompts.version + ":v2").digest("hex").slice(0, 24);

async function pipeline(job) {
  const { avatarPath, type, id } = job;
  job.status = "running";
  if (PIPELINE === "fast") {
    /* one Gemini call: the avatar and the type's gear + action, style named in the text (harness/fast.mjs) */
    job.stage = "gemini";
    const action = prompts.types[type].replace(/\s+/g, " ").trim();
    const g = await generateImage({ key, model: "google/gemini-3-pro-image", prompt: fastPrompt(action), avatarPath, refs: [], budget });
    await writeFile(join(CACHE, job.key + ".png"), g.png);
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
  job.stage = "cutout"; Object.assign(job, await cutoutFor(job.key));   /* ~0.3 s; done is reported with the cut-out already in place */
  job.status = "done"; job.image_url = `/art/${job.key}.png`;
}

const json = (res, code, body) => { res.writeHead(code, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "content-type" }); res.end(JSON.stringify(body)); };
http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, "http://x");
    if (req.method === "OPTIONS") return json(res, 204, {});
    if (u.pathname === "/healthz") return json(res, 200, { ok: true, pipeline: PIPELINE, spent_usd: Number(budget.spent.toFixed(3)), prompt_version: prompts.version });
    if (u.pathname.startsWith("/art/")) { const name = u.pathname.slice(5); if (!/^[a-f0-9]+(\.png|\.cut\.png|\.plate\.jpg)$/.test(name)) return json(res, 404, { error: "not_found" }); const f = join(CACHE, name); if (!existsSync(f)) return json(res, 404, { error: "not_found" }); res.writeHead(200, { "Content-Type": name.endsWith(".jpg") ? "image/jpeg" : "image/png", "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=86400" }); return res.end(await readFile(f)); }
    if (req.method === "POST" && u.pathname === "/v1/identity/card-art") {
      let body = ""; for await (const c of req) body += c; const b = JSON.parse(body || "{}");
      if (!prompts.types[b.type]) return json(res, 400, { error: "unknown_type" });
      let avatarBytes, avatarPath;
      if (b.avatar_data) { avatarBytes = Buffer.from(String(b.avatar_data).split(",").pop(), "base64"); }
      else if (b.avatar_url) { const r = await fetch(new URL(b.avatar_url, "http://127.0.0.1:3021/")); avatarBytes = Buffer.from(await r.arrayBuffer()); }
      else return json(res, 400, { error: "no_avatar" });
      const k = cacheKey(avatarBytes, b.type);
      if (existsSync(join(CACHE, k + ".png"))) {
        const extra = cutoutFor(k);
        if (inflight.has(k)) { extra.catch(() => {}); return json(res, 202, { status: "running", stage: "cutout", job_id: k }); }
        return json(res, 200, { status: "done", job_id: k, image_url: `/art/${k}.png`, ...(await extra), prompt_version: prompts.version, cached: true });
      }
      /* a job record whose output vanished (cache cleared) must not be trusted — start over */
      const stale = jobs.get(k); if (stale && (stale.status === "done" || stale.status === "failed") && !existsSync(join(CACHE, k + ".png"))) jobs.delete(k);
      if (!jobs.has(k)) {
        /* ".avatar" in the name: a PNG avatar saved as <key>.png was mistaken for the finished art (instant "done" with the avatar as the card) */
        avatarPath = join(CACHE, k + ".avatar" + extOf(avatarBytes)); await writeFile(avatarPath, avatarBytes);
        const job = { id: k, key: k, type: b.type, avatarPath, status: "queued", started: Date.now() }; jobs.set(k, job);
        pipeline(job).catch((e) => { job.status = "failed"; job.error = e.message; console.error("job", k, "failed:", e.message); });
      }
      return json(res, 202, { status: jobs.get(k).status, job_id: k });
    }
    const m = /^\/v1\/identity\/card-art\/([a-f0-9]+)$/.exec(u.pathname);
    if (req.method === "GET" && m) {
      const k = m[1];
      if (existsSync(join(CACHE, k + ".png"))) {
        const extra = cutoutFor(k);
        if (inflight.has(k)) { extra.catch(() => {}); return json(res, 200, { status: "running", stage: "cutout" }); }
        return json(res, 200, { status: "done", image_url: `/art/${k}.png`, ...(await extra), prompt_version: prompts.version });
      }
      const job = jobs.get(k); if (!job) return json(res, 404, { error: "not_found" });
      if (job.status === "done") { jobs.delete(k); return json(res, 200, { status: "failed", error: "output_missing" }); }   /* done but the PNG is gone */
      return json(res, 200, { status: job.status, stage: job.stage, error: job.error, elapsed_s: Math.round((Date.now() - job.started) / 1000) });
    }
    json(res, 404, { error: "not_found" });
  } catch (e) { json(res, 500, { error: "server_error", message: e.message }); }
}).listen(PORT, HOST, () => console.log(`card-art mock backend on http://${HOST}:${PORT}  pipeline=${PIPELINE}  (cache ${CACHE})`));

/* --warm who:type:avatar → pre-compute (or register an existing PNG via --warm-from path) */
if (args.warm) {
  const [who, type, avatar] = String(args.warm).split(":"); const bytes = await readFile(resolve(CARDGEN, avatar)); const k = cacheKey(bytes, type);
  if (args["warm-from"]) { await copyFile(resolve(CARDGEN, String(args["warm-from"])), join(CACHE, k + ".png")); await cutoutFor(k); console.log(`warm: ${who}/${type} ← ${args["warm-from"]} (key ${k})`); }
  else if (!existsSync(join(CACHE, k + ".png"))) { const p = join(CACHE, k + ".avatar" + extOf(bytes)); await writeFile(p, bytes); const job = { id: k, key: k, type, avatarPath: p, status: "queued", started: Date.now() }; jobs.set(k, job); pipeline(job).then(() => console.log("warm done", k)).catch((e) => console.error("warm failed", e.message)); }
  else console.log(`warm: ${who}/${type} already cached (key ${k})`);
}

/* cut-outs for art cached before this step existed (sequential, ~0.3 s each) */
(async () => { for (const f of await readdir(CACHE)) { const m = /^([a-f0-9]+)\.png$/.exec(f); if (m) await cutoutFor(m[1]); } })().catch((e) => console.error("cutout sweep:", e.message));
