#!/usr/bin/env node
/* Mock card-art backend — the endpoints from BACKEND.md, runnable locally so the H5 hooks can be built and demoed
   before Sean's real service exists. Runs the tuned pipeline (GPT card → Gemini restyle) with a cache.

   NODE_USE_ENV_PROXY=1 node tools/cardgen/server.mjs [--port 3022] [--warm chriszhu:diamond_hands:avatars/chriszhu.png]

   POST /v1/identity/card-art   { avatar_url|avatar_data, handle, type }  → 200 done (cache) | 202 queued
   GET  /v1/identity/card-art/:job                                          → queued | running | done | failed
   GET  /art/<file>                                                         → the generated PNGs
   The real backend gets the avatar from X; here the client sends the (mock) avatar it is showing. */
import http from "node:http";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir, copyFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve, extname } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { apiKey, loadPrompts, buildPrompt, generateImage, Budget, STYLE_DIR, CARDGEN, HERE as HARNESS } from "./harness/lib.mjs";

const exec = promisify(execFile);
const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, all) => (v.startsWith("--") ? a.concat([[v.slice(2), all[i + 1] && !all[i + 1].startsWith("--") ? all[i + 1] : true]]) : a), []));
const PORT = Number(args.port || 3022), CACHE = join(CARDGEN, "out/server-cache"); await mkdir(CACHE, { recursive: true });
const key = await apiKey(), prompts = await loadPrompts(), budget = new Budget(Number(args.cap || 20));
const jobs = new Map();
const PHOTO_AVATAR = /\.(jpe?g)$/i;   /* photo avatars get --face-clean in the restyle; drawn ones don't */

function refsFor(type) { const f = join(STYLE_DIR, `figma/refs-${type}.txt`); if (!existsSync(f)) return []; return readFileSyncLines(f); }
function readFileSyncLines(f) { return require("node:fs").readFileSync(f, "utf8").split("\n").filter(Boolean).map((n) => ["webp", "jpg", "png"].map((e) => join(STYLE_DIR, n + "." + e)).find(existsSync)).filter(Boolean); }
import { createRequire } from "node:module"; const require = createRequire(import.meta.url);

/* extension from the bytes (magic numbers) — the URL's suffix lied for PNG avatars fetched via a .jpg-looking path */
const extOf = (buf) => buf[0] === 0x89 && buf[1] === 0x50 ? ".png" : buf[0] === 0x52 && buf[8] === 0x57 ? ".webp" : buf[0] === 0x47 ? ".gif" : ".jpg";
const cacheKey = (avatarBytes, type) => createHash("sha256").update(avatarBytes).update(":" + type + ":" + prompts.version + ":v2").digest("hex").slice(0, 24);

async function pipeline(job) {
  const { avatarPath, type, id } = job;
  job.status = "running"; job.stage = "gpt";
  const refs = refsFor(type);
  const g = await generateImage({ key, model: "openai/gpt-5.4-image-2", prompt: buildPrompt(prompts, prompts.style, type), avatarPath, refs, brandPath: join(CARDGEN, "refs/donut-ribbons.webp"), budget, refMode: "style" });
  const stage1 = join(CACHE, job.key + ".stage1.png"); await writeFile(stage1, g.png);
  job.stage = "gemini";
  const faceClean = PHOTO_AVATAR.test(avatarPath) ? ["--face-clean"] : [];
  await exec("node", [join(HARNESS, "restyle.mjs"), "--image", stage1, "--avatar", avatarPath, "--type", type, "--refs", refs.map((p) => "figma/" + p.split("/").pop().replace(/\.\w+$/, "")).join(","), "--name", "server-" + job.key, "--brand", "--edge-sparkle", ...faceClean], { env: { ...process.env, NODE_USE_ENV_PROXY: "1" } });
  await copyFile(join(CARDGEN, "out/restyle", "server-" + job.key, "restyled.png"), join(CACHE, job.key + ".png"));
  job.status = "done"; job.image_url = `/art/${job.key}.png`;
}

const json = (res, code, body) => { res.writeHead(code, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "content-type" }); res.end(JSON.stringify(body)); };
http.createServer(async (req, res) => {
  try {
    if (req.method === "OPTIONS") return json(res, 204, {});
    const u = new URL(req.url, "http://x");
    if (u.pathname.startsWith("/art/")) { const f = join(CACHE, u.pathname.slice(5)); if (!existsSync(f)) return json(res, 404, { error: "not_found" }); res.writeHead(200, { "Content-Type": "image/png", "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=86400" }); return res.end(await readFile(f)); }
    if (req.method === "POST" && u.pathname === "/v1/identity/card-art") {
      let body = ""; for await (const c of req) body += c; const b = JSON.parse(body || "{}");
      if (!prompts.types[b.type]) return json(res, 400, { error: "unknown_type" });
      let avatarBytes, avatarPath;
      if (b.avatar_data) { avatarBytes = Buffer.from(String(b.avatar_data).split(",").pop(), "base64"); }
      else if (b.avatar_url) { const r = await fetch(new URL(b.avatar_url, "http://127.0.0.1:3021/")); avatarBytes = Buffer.from(await r.arrayBuffer()); }
      else return json(res, 400, { error: "no_avatar" });
      const k = cacheKey(avatarBytes, b.type);
      if (existsSync(join(CACHE, k + ".png"))) return json(res, 200, { status: "done", job_id: k, image_url: `/art/${k}.png`, prompt_version: prompts.version, cached: true });
      /* a job record whose output vanished (cache cleared) must not be trusted — start over */
      const stale = jobs.get(k); if (stale && (stale.status === "done" || stale.status === "failed") && !existsSync(join(CACHE, k + ".png"))) jobs.delete(k);
      if (!jobs.has(k)) {
        avatarPath = join(CACHE, k + extOf(avatarBytes)); await writeFile(avatarPath, avatarBytes);
        const job = { id: k, key: k, type: b.type, avatarPath, status: "queued", started: Date.now() }; jobs.set(k, job);
        pipeline(job).catch((e) => { job.status = "failed"; job.error = e.message; console.error("job", k, "failed:", e.message); });
      }
      return json(res, 202, { status: jobs.get(k).status, job_id: k });
    }
    const m = /^\/v1\/identity\/card-art\/([a-f0-9]+)$/.exec(u.pathname);
    if (req.method === "GET" && m) {
      const k = m[1];
      if (existsSync(join(CACHE, k + ".png"))) return json(res, 200, { status: "done", image_url: `/art/${k}.png`, prompt_version: prompts.version });
      const job = jobs.get(k); if (!job) return json(res, 404, { error: "not_found" });
      if (job.status === "done") { jobs.delete(k); return json(res, 200, { status: "failed", error: "output_missing" }); }   /* done but the PNG is gone */
      return json(res, 200, { status: job.status, stage: job.stage, error: job.error, elapsed_s: Math.round((Date.now() - job.started) / 1000) });
    }
    json(res, 404, { error: "not_found" });
  } catch (e) { json(res, 500, { error: "server_error", message: e.message }); }
}).listen(PORT, "127.0.0.1", () => console.log(`card-art mock backend on http://127.0.0.1:${PORT}  (cache ${CACHE})`));

/* --warm who:type:avatar → pre-compute (or register an existing PNG via --warm-from path) */
if (args.warm) {
  const [who, type, avatar] = String(args.warm).split(":"); const bytes = await readFile(resolve(CARDGEN, avatar)); const k = cacheKey(bytes, type);
  if (args["warm-from"]) { await copyFile(resolve(CARDGEN, String(args["warm-from"])), join(CACHE, k + ".png")); console.log(`warm: ${who}/${type} ← ${args["warm-from"]} (key ${k})`); }
  else if (!existsSync(join(CACHE, k + ".png"))) { const p = join(CACHE, k + extname(avatar)); await writeFile(p, bytes); const job = { id: k, key: k, type, avatarPath: p, status: "queued", started: Date.now() }; jobs.set(k, job); pipeline(job).then(() => console.log("warm done", k)).catch((e) => console.error("warm failed", e.message)); }
  else console.log(`warm: ${who}/${type} already cached (key ${k})`);
}
