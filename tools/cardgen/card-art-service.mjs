import http from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { pipeline as streamPipeline } from "node:stream/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Budget, fastPrompt, TYPES } from "./harness/lib.mjs";
import { createImageGenerator } from "./openrouter-image.mjs";
import { withAuthentication } from "./server-config.mjs";
import { createSerialTaskQueue } from "./serial-task-queue.mjs";
import { createBedrockCutout, pngInfo } from "./bedrock-cutout.mjs";
import { PersistentJobQueue, QueueFullError } from "./job-queue.mjs";

const exec = promisify(execFile);
const ALLOWED_TYPES = new Set(TYPES.filter((type) => type !== "unresolved"));
class RequestError extends Error {
  constructor(status, code) { super(code); this.status = status; }
}
async function fileExists(path) {
  try { await access(path); return true; }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
}
async function atomicWrite(path, bytes) {
  const temporary = path + "." + randomUUID() + ".tmp";
  await writeFile(temporary, bytes);
  await rename(temporary, path);
}
const json = (res, status, body) => {
  res.writeHead(status, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "content-type, authorization" });
  res.end(JSON.stringify(body));
};
function publicJob(job, promptVersion) {
  return { job_id: job.id, status: job.status, stage: job.stage, prompt_version: promptVersion,
    ...(job.status === "done" ? { image_url: job.image_url, cutout_url: job.cutout_url,
      plate_url: job.plate_url } : {}),
    ...(job.status === "failed" ? { error: job.error } : {}) };
}
function avatarExtension(bytes) {
  if (bytes.length >= 33 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return ".png";
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return ".webp";
  if (bytes.length >= 10 && /^(GIF87a|GIF89a)$/.test(bytes.subarray(0, 6).toString("ascii"))) return ".gif";
  if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return ".jpg";
  throw new RequestError(400, "invalid_avatar_image");
}
async function readBody(req, limit) {
  const chunks = []; let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > limit) throw new RequestError(413, "request_too_large");
    chunks.push(chunk);
  }
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch (cause) { throw new RequestError(400, "invalid_json"); }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new RequestError(400, "invalid_request");
  return body;
}
async function avatarBytes(body, config) {
  let bytes;
  if (typeof body.avatar_data === "string") {
    const data = body.avatar_data.includes(",") ? body.avatar_data.slice(body.avatar_data.indexOf(",") + 1) : body.avatar_data;
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data)) throw new RequestError(400, "invalid_avatar_data");
    bytes = Buffer.from(data, "base64");
  } else if (typeof body.avatar_url === "string") {
    let url;
    try { url = new URL(body.avatar_url); }
    catch (cause) { throw new RequestError(400, "invalid_avatar_url"); }
    // The trusted backend supplies an X avatar. Local demo servers can still fetch local fixtures.
    if (config.authRequired && (url.protocol !== "https:" || url.hostname !== "pbs.twimg.com" ||
        url.username !== "" || url.password !== "" || (url.port !== "" && url.port !== "443"))) {
      throw new RequestError(400, "unsupported_avatar_source");
    }
    const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(30000) });
    if (!response.ok || !response.body) throw new RequestError(502, "avatar_download_failed");
    const chunks = []; let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > config.maxAvatarBytes) throw new RequestError(413, "avatar_too_large");
      chunks.push(chunk);
    }
    bytes = Buffer.concat(chunks);
  } else throw new RequestError(400, "no_avatar");
  if (bytes.length === 0) throw new RequestError(400, "empty_avatar");
  if (bytes.length > config.maxAvatarBytes) throw new RequestError(413, "avatar_too_large");
  return bytes;
}

export async function createCardArtService({ config, cache, prompts, apiKey,
  generate = createImageGenerator(), cutout, makePlate, logger = console }) {
  await mkdir(cache, { recursive: true });
  const budget = new Budget(config.budgetLimitUsd === null ? Infinity : config.budgetLimitUsd);
  let foreground = cutout;
  if (foreground === undefined) {
    foreground = createBedrockCutout({ region: config.bedrockRegion,
      model: config.bedrockModel, minIntervalMs: config.bedrockMinIntervalMs,
      timeoutMs: config.bedrockTimeoutMs, stateFile: join(cache, ".bedrock-rate.json") });
    await foreground.initialize();
  }
  const enqueuePlate = createSerialTaskQueue();
  const plate = makePlate || (async (source, cut, target) => {
    const { stdout } = await exec("python3", [new URL("./harness/plate.py", import.meta.url).pathname,
      source, cut, target], { timeout: 30000, maxBuffer: 4096 });
    return JSON.parse(stdout);
  });
  let queue;
  async function render(job) {
    const checkpoint = async (stage, updates = {}) => {
      job.stage = stage; Object.assign(job, updates); await queue.checkpoint(job);
    };
    const main = join(cache, job.id + ".png"), cut = join(cache, job.id + ".cut.png"),
      background = join(cache, job.id + ".plate.jpg");
    if (!(await fileExists(main))) {
      await checkpoint("gemini");
      const result = await generate({ key: apiKey, model: "google/gemini-3-pro-image",
        prompt: fastPrompt(prompts.types[job.payload.type].replace(/\s+/g, " ").trim()),
        avatarPath: job.payload.avatarPath, refs: [], budget });
      pngInfo(result.png);
      await atomicWrite(main, result.png);
      await checkpoint("image_ready", { image_url: `/art/${job.id}.png` });
    }
    await checkpoint("cutout_queued");
    const result = await foreground(await readFile(main), () => checkpoint("bedrock"));
    await atomicWrite(cut, result.png);
    await checkpoint("plate", typeof result.requestId === "string" ? { cutout_request_id: result.requestId } : {});
    const quality = await enqueuePlate(() => plate(main, cut, background));
    if (!Number.isFinite(quality.coverage) || quality.coverage < 0.03 || quality.coverage > 0.9) {
      throw Object.assign(new Error("invalid_foreground_coverage"), { category: "invalid_output" });
    }
    for (const output of [main, cut, background]) {
      if (!(await fileExists(output))) throw Object.assign(new Error("output_missing"), { category: "invalid_output" });
    }
    job.image_url = `/art/${job.id}.png`; job.cutout_url = `/art/${job.id}.cut.png`;
    job.plate_url = `/art/${job.id}.plate.jpg`; job.stage = "complete";
    logger.log(JSON.stringify({ event: "cardgen.completed", job_id: job.id,
      cutout_request_id: result.requestId, cutout_seconds: result.seconds, coverage: quality.coverage }));
  }
  queue = new PersistentJobQueue({ directory: join(cache, "jobs"),
    maxActive: config.maxActiveJobs, maxQueued: config.maxQueuedJobs, run: render });
  await queue.initialize();
  async function jobResponse(job) {
    if (job.status === "done") {
      for (const suffix of [".png", ".cut.png", ".plate.jpg"]) {
        if (!(await fileExists(join(cache, job.id + suffix)))) return {
          job_id: job.id, status: "failed", error: "output_missing", prompt_version: prompts.version,
        };
      }
    }
    return publicJob(job, prompts.version);
  }
  let httpActive = 0;
  const server = http.createServer(withAuthentication(async (req, res) => {
    if (req.method === "GET" && req.url.split("?")[0] === "/healthz") {
      return json(res, queue.healthy ? 200 : 503, { ok: queue.healthy, pipeline: "fast", spent_usd: Number(budget.spent.toFixed(3)),
        prompt_version: prompts.version, source_revision: config.sourceRevision,
        auth_required: config.authRequired, budget_limit_usd: config.budgetLimitUsd,
        cutout_provider: "bedrock", cutout_region: config.bedrockRegion, cutout_model: config.bedrockModel,
        bedrock_min_interval_ms: config.bedrockMinIntervalMs, queue: queue.stats() });
    }
    if (httpActive >= config.maxHttpRequests) {
      res.setHeader("Connection", "close");
      return json(res, 503, { error: "worker_busy" });
    }
    httpActive++;
    try {
      const url = new URL(req.url, "http://worker");
      if (req.method === "OPTIONS") return json(res, 204, {});
      if (req.method === "GET" && url.pathname.startsWith("/art/")) {
        const name = url.pathname.slice(5);
        if (!/^[a-f0-9]{24}(\.png|\.cut\.png|\.plate\.jpg)$/.test(name)) return json(res, 404, { error: "not_found" });
        const file = join(cache, name);
        if (!(await fileExists(file))) return json(res, 404, { error: "not_found" });
        res.writeHead(200, { "Content-Type": name.endsWith(".jpg") ? "image/jpeg" : "image/png",
          "Access-Control-Allow-Origin": "*", "Cache-Control": config.authRequired ? "private, max-age=86400" : "public, max-age=86400" });
        await streamPipeline(createReadStream(file), res); return;
      }
      if (req.method === "POST" && url.pathname === "/v1/identity/card-art") {
        if (Number(req.headers["content-length"]) > config.maxRequestBytes) throw new RequestError(413, "request_too_large");
        const body = await readBody(req, config.maxRequestBytes);
        if (!ALLOWED_TYPES.has(body.type) || typeof prompts.types[body.type] !== "string") throw new RequestError(400, "unknown_type");
        const bytes = await avatarBytes(body, config);
        const id = createHash("sha256").update(bytes).update(":" + body.type + ":" + prompts.version + ":v2").digest("hex").slice(0, 24);
        const extension = avatarExtension(bytes);
        const avatarPath = join(cache, id + ".avatar" + extension);
        const { job, created } = await queue.submit(id, { type: body.type, avatarPath }, () => atomicWrite(avatarPath, bytes));
        const committed = queue.get(job.id);
        if (committed === undefined) throw new Error("Admitted job has no durable record");
        const response = await jobResponse(committed);
        return json(res, response.status === "queued" || response.status === "running" ? 202 : 200,
          { ...response, cached: !created });
      }
      const match = /^\/v1\/identity\/card-art\/([a-f0-9]{24})$/.exec(url.pathname);
      if (req.method === "GET" && match) {
        const job = queue.get(match[1]);
        if (!job) return json(res, 404, { error: "not_found" });
        return json(res, 200, await jobResponse(job));
      }
      return json(res, 404, { error: "not_found" });
    } catch (error) {
      if (res.headersSent) {
        logger.error(JSON.stringify({ event: "cardgen.response_failed", code: error.code || error.name }));
        res.destroy(error); return;
      }
      if (error instanceof RequestError) return json(res, error.status, { error: error.message });
      if (error instanceof QueueFullError) return json(res, 429, { error: "queue_full" });
      logger.error(JSON.stringify({ event: "cardgen.request_failed", code: error.code || error.name }));
      return json(res, 500, { error: "server_error" });
    } finally { httpActive--; }
  }, config));
  return { server, queue, budget };
}
