import http from "node:http";
import { access, mkdir, statfs, open, unlink, lstat } from "node:fs/promises";
import { constants } from "node:fs";
import { pipeline as streamPipeline } from "node:stream/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fastPrompt, TYPES } from "./harness/lib.mjs";
import { createImageGenerator, WorkerBudget } from "./openrouter-image.mjs";
import { withAuthentication } from "./server-config.mjs";
import { createSerialTaskQueue } from "./serial-task-queue.mjs";
import { createBedrockCutout } from "./bedrock-cutout.mjs";
import { createIsnetCutout } from "./isnet-cutout.mjs";
import { PersistentJobQueue, QueueFullError, QueueCleanupBusyError } from "./job-queue.mjs";
import { createRetentionFiles, FAILURE_STAGES, JobExpiredError, jobExpired, jobExpiresAt, normalizeExpiry, InvalidExpiryError, ExpiryConflictError } from "./retention.mjs";
import {
  IMAGE_MODEL, pipelineDescriptor, publicPipeline, cardArtId, normalizeRequestKey,
  InvalidRequestKeyError, RequestKeyConflictError, workerContractOf,
  expectedWorkerContract, requireExpectedContract,
  InvalidWorkerContractError, WorkerContractChangedError,
} from "./pipeline-version.mjs";
import { RESULT_CONTRACT, resultReceipt, retryCommand, LayerRetryError } from "./layer-result.mjs";
import { createLayerRenderer, requireRenderVersion } from "./layer-renderer.mjs";
import { durableWrite, verifyAsset, verifyHandle, AssetUnavailableError } from "./asset-files.mjs";

const exec = promisify(execFile);
const ALLOWED_TYPES = new Set(TYPES.filter((type) => type !== "unresolved"));
const RESERVED_JOB_BYTES = 160 * 1024 * 1024;
class RequestError extends Error {
  constructor(status, code) { super(code); this.status = status; }
}
async function fileExists(path) {
  try { await access(path); return true; }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
}
async function atomicWrite(path, bytes) {
  await durableWrite(path, bytes);
}
const json = (res, status, body) => {
  res.writeHead(status, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "content-type, authorization", "Cache-Control": "private, no-store" });
  res.end(JSON.stringify(body));
};
function publicJob(job) {
  return { job_id: job.id, status: job.status, stage: job.stage, prompt_version: job.payload.promptVersion, ...publicPipeline(job.payload), ...resultReceipt(job),
    ...(job.status === "done" ? { image_url: job.image_url, cutout_url: job.cutout_url,
      plate_url: job.plate_url } : {}),
    ...(job.status === "failed" ? { error: job.error,
      failure_stage: job.error === "provider_result_unknown" && job.failure_stage !== "validation" ? "unknown"
        : FAILURE_STAGES.has(job.failure_stage) ? job.failure_stage : "unknown" } : {}) };
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
  generate = createImageGenerator(), cutout, makePlate, validateMain, validateLayer, diskInfo = statfs, logger = console, now = Date.now }) {
  await mkdir(cache, { recursive: true });
  const cacheInfo = await lstat(cache);
  if (!cacheInfo.isDirectory() || cacheInfo.isSymbolicLink()) throw new TypeError("Cache must be a real directory");
  const budget = new WorkerBudget(config.budgetLimitUsd === null ? Infinity : config.budgetLimitUsd);
  const version = pipelineDescriptor(config);
  const actualContract = expectedWorkerContract(version);
  let foreground = cutout;
  if (foreground === undefined) {
    foreground = config.cutoutProvider === "isnet" ? createIsnetCutout({
      modelPath: config.isnetModelPath, threads: config.isnetThreads,
      timeoutMs: config.isnetTimeoutMs, startupTimeoutMs: config.isnetStartupTimeoutMs,
    }) : createBedrockCutout({ region: config.bedrockRegion,
      credentialRegion: config.credentialRegion,
      model: config.bedrockModel, minIntervalMs: config.bedrockMinIntervalMs,
      timeoutMs: config.bedrockTimeoutMs, stateFile: join(cache, ".bedrock-rate.json") });
    await foreground.initialize();
  }
  const enqueuePlate = createSerialTaskQueue();
  const localExec = async (path, args) => {
    try { return await exec("python3", [new URL(path, import.meta.url).pathname, ...args],
      { timeout: 30000, maxBuffer: 4096 }); }
    catch (cause) {
      throw Object.assign(new Error("local_stage_failed", { cause }), {
        category: cause.killed || cause.code === "ETIMEDOUT" ? "provider_timeout"
          : typeof cause.code === "number" ? "invalid_output" : "provider_error",
      });
    }
  };
  const validate = validateMain || (async (source) => {
    await localExec("./harness/validate-main.py", [source]);
  });
  const validateDerivative = validateLayer || (async (name, source, target) => {
    await localExec("./harness/validate-layer.py", [name, source, target]);
  });
  const plate = makePlate || (async (source, cut, target) => {
    const { stdout } = await localExec("./harness/plate.py", [source, cut, target]);
    return JSON.parse(stdout);
  });
  let queue;
  const retentionFiles = createRetentionFiles(cache, id => queue.owns(id), (id, action) => queue.removeOrphan(id, action));
  function requireForeground() {
    if (foreground.healthy && !foreground.healthy()) {
      throw Object.assign(new Error("segmenter_unavailable"), { category: "provider_error", failure_stage: "cutout" });
    }
  }
  async function reserveDisk() {
    const disk = await diskInfo(cache), available = disk.bavail * disk.bsize;
    if (!Number.isSafeInteger(available) || available < 0) throw new Error("Invalid filesystem available capacity");
    const pending = queue.stats();
    const reservation = Math.max(RESERVED_JOB_BYTES, config.maxAvatarBytes + 124 * 1024 * 1024 + 128 * 1024);
    if (available - (pending.active + pending.queued) * reservation < config.minFreeDiskBytes)
      throw new RequestError(503, "storage_capacity");
  }
  const render = createLayerRenderer({ cache, config, version, foreground, generate, apiKey, budget,
    validateMain: validate, validateLayer: validateDerivative, makePlate: plate, enqueuePlate,
    fileExists, requireForeground, now, queue: () => queue, logger });
  queue = new PersistentJobQueue({ directory: join(cache, "jobs"),
    maxActive: config.maxActiveJobs, maxQueued: config.maxQueuedJobs, maxRetainedJobs: config.maxRetainedJobs, run: render, now, cleanup: id => retentionFiles.removeJob(id) });
  try { await queue.initialize(); }
  catch (error) { if (foreground.close) await foreground.close(); throw error; }
  async function jobResponse(job) {
    const deadline = new Date(jobExpiresAt(job)).toISOString();
    const receipt = { expiresAt: deadline, expires_at: deadline, workerContract: workerContractOf(job.payload),
      ...(config.authRequired && Object.hasOwn(job.payload, "requestKey") ? { requestKey: job.payload.requestKey } : {}) };
    if (jobExpired(job, now())) return { ...receipt, job_id: job.id, status: "expired", error: "expired" };
    if (typeof job.payload.promptVersion !== "string") return {
      ...receipt, ...publicPipeline(job.payload), job_id: job.id, status: "failed", error: "unsupported_persisted_job_version", failure_stage: "validation",
    };
    if (job.result !== undefined) {
      let unavailable = false;
      for (const [name, asset] of [["main", job.result.main], ...Object.entries(job.result.layers)]) {
        if (asset.state !== "ready") continue;
        try { await verifyAsset(cache, job, name); }
        catch (error) {
          if (!(error instanceof AssetUnavailableError)) throw error;
          asset.state = "unknown"; asset.reason = "asset_unavailable";
          if (name === "main") asset.validated = false;
          delete asset.url; delete asset.sha256; unavailable = true;
        }
      }
      if (unavailable) {
        job.status = "failed"; job.error = "output_missing"; job.failure_stage = "validation";
      }
    }
    if (job.status === "done") {
      for (const suffix of [".png", ".cut.png", ".plate.jpg"]) {
        if (!(await fileExists(join(cache, job.id + suffix)))) return {
          ...receipt, ...resultReceipt(job), ...publicPipeline(job.payload), job_id: job.id, status: "failed", error: "output_missing", failure_stage: "validation", prompt_version: job.payload.promptVersion,
        };
      }
    }
    if (jobExpired(job, now())) return { ...receipt, job_id: job.id, status: "expired", error: "expired" };
    return { ...publicJob(job), ...receipt };
  }
  let retentionSweep, retentionError, closing = false;
  function sweepRetention() {
    if (retentionSweep) return retentionSweep;
    const sweeping = (async () => {
      const history = await queue.sweepExpired(config.retentionBatchSize);
      const files = await retentionFiles.sweepOrphans(config.retentionBatchSize);
      retentionError = undefined;
      return { history, files };
    })();
    retentionSweep = sweeping;
    sweeping.then(() => { retentionSweep = undefined; }, error => {
      retentionSweep = undefined; retentionError = error;
    });
    return sweeping;
  }
  try { await sweepRetention(); }
  catch (error) {
    try { await queue.close(); }
    finally { await retentionFiles.close(); if (foreground.close) await foreground.close(); }
    throw error;
  }
  // Bounded periodic reclamation. Read checks are synchronous and do not wait for this sweep.
  const retentionTimer = setInterval(() => {
    if (!closing) sweepRetention().catch(error => logger.error(JSON.stringify({
      event: "cardgen.retention_failed", code: error.code || error.name,
    })));
  }, config.retentionSweepMs);
  retentionTimer.unref();
  let httpActive = 0;
  const server = http.createServer(withAuthentication(async (req, res) => {
    if (req.method === "GET" && req.url.split("?")[0] === "/healthz") {
      const healthy = retentionError === undefined && queue.healthy && (foreground.healthy === undefined || foreground.healthy());
      return json(res, healthy ? 200 : 503, { ok: healthy, pipeline: "fast", spent_usd: Number(budget.spent.toFixed(3)),
        result_contract: RESULT_CONTRACT,
        ...publicPipeline(version),
        unknown_gemini_cost_calls: budget.unknownCostCalls,
        retained_jobs: queue.retainedJobs, max_retained_jobs: config.maxRetainedJobs,
        prompt_version: prompts.version,
        auth_required: config.authRequired, budget_limit_usd: config.budgetLimitUsd,
        cutout_provider: config.cutoutProvider, cutout_model: config.cutoutModel,
        ...(config.cutoutProvider === "bedrock" ? { cutout_region: config.bedrockRegion,
          bedrock_min_interval_ms: config.bedrockMinIntervalMs } : { isnet_threads: config.isnetThreads }), queue: queue.stats() });
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
        const job = queue.get(name.slice(0, 24));
        if (!job) return json(res, 404, { error: "not_found" });
        if (jobExpired(job, now())) return json(res, 410, { status: "expired", error: "expired" });
        const layer = name.endsWith(".cut.png") ? "cutout" : name.endsWith(".plate.jpg") ? "plate" : "main";
        const asset = job.result === undefined ? undefined : layer === "main" ? job.result.main : job.result.layers[layer];
        if (asset !== undefined && asset.state !== "ready") return json(res, 404, { error: "not_found" });
        const file = join(cache, name);
        let handle;
        try { handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW); }
        catch (error) { if (error.code === "ENOENT" || error.code === "ELOOP") return json(res, 404, { error: "not_found" }); throw error; }
        try {
          if (!(await handle.stat()).isFile()) return json(res, 404, { error: "not_found" });
          if (asset !== undefined) await verifyHandle(handle, layer, asset.sha256);
          if (jobExpired(job, now())) return json(res, 410, { status: "expired", error: "expired" });
          res.writeHead(200, { "Content-Type": name.endsWith(".jpg") ? "image/jpeg" : "image/png",
            "Access-Control-Allow-Origin": "*", "Cache-Control": "private, no-store" });
          await streamPipeline(handle.createReadStream({ start: 0, autoClose: false }), res); return;
        } finally { await handle.close(); }
      }
      if (req.method === "POST" && url.pathname === "/v1/identity/card-art") {
        if (Number(req.headers["content-length"]) > config.maxRequestBytes) throw new RequestError(413, "request_too_large");
        const body = await readBody(req, config.maxRequestBytes);
        const requestKey = Object.hasOwn(body, "requestKey") ? normalizeRequestKey(body.requestKey) : undefined;
        if (requestKey !== undefined || Object.hasOwn(body, "expectedContract")) requireExpectedContract(body.expectedContract, actualContract);
        const requestedExpiry = Object.hasOwn(body, "expiresAt") ? normalizeExpiry(body.expiresAt) : undefined;
        if (!ALLOWED_TYPES.has(body.type) || typeof prompts.types[body.type] !== "string") throw new RequestError(400, "unknown_type");
        const bytes = await avatarBytes(body, config);
        const id = cardArtId(bytes, body.type, prompts.version, version, requestKey);
        const keyed = requestKey === undefined ? undefined : queue.getByRequestKey(requestKey);
        if (keyed && jobExpired(keyed, now())) return json(res, 410, { status: "expired", error: "expired" });
        if (keyed && keyed.id !== id) throw new RequestKeyConflictError();
        if (queue.get(id) === undefined && foreground.healthy && !foreground.healthy()) {
          return json(res, 503, { error: "segmenter_unavailable" });
        }
        const existing = queue.get(id);
        if (existing && jobExpired(existing, now())) return json(res, 410, { status: "expired", error: "expired" });
        const extension = avatarExtension(bytes);
        const avatarPath = join(cache, id + ".avatar" + extension);
        let admitted;
        try { admitted = await queue.submit(id, { type: body.type, avatarPath,
          promptVersion: prompts.version, resultContract: RESULT_CONTRACT,
          prompt: fastPrompt(prompts.types[body.type].replace(/\s+/g, " ").trim()),
          ...version,
          ...(requestKey === undefined ? {} : { requestKey }),
        }, async () => {
          await reserveDisk();
          await atomicWrite(avatarPath, bytes);
        }, requestedExpiry); } catch (error) {
          // Preparation can fail after raw bytes were written but before journal admission.
          await queue.removeOrphan(id, async () => {
            try { await unlink(avatarPath); }
            catch (failure) { if (failure.code !== "ENOENT") throw failure; }
          });
          throw error;
        }
        const { job, created } = admitted;
        if (!created) await queue.recordCacheReplay(job.id);
        const committed = queue.get(job.id);
        if (committed === undefined) throw new Error("Admitted job has no durable record");
        const response = await jobResponse(committed);
        return json(res, response.status === "expired" ? 410 : response.status === "queued" || response.status === "running" ? 202 : 200,
          { ...response, cached: !created });
      }
      const byKey = /^\/v1\/identity\/card-art\/requests\/([^/]+)$/.exec(url.pathname);
      if (req.method === "GET" && byKey) {
        if (!config.authRequired) return json(res, 401, { error: "unauthorized" });
        const job = queue.getByRequestKey(normalizeRequestKey(byKey[1]));
        if (!job) return json(res, 404, { error: "not_found" });
        const response = await jobResponse(job);
        return json(res, response.status === "expired" ? 410 : 200, response);
      }
      const retry = /^\/v1\/identity\/card-art\/([a-f0-9]{24})\/retry-layers$/.exec(url.pathname);
      if (req.method === "POST" && retry) {
        if (!config.authRequired) return json(res, 401, { error: "unauthorized" });
        const command = retryCommand(await readBody(req, Math.min(config.maxRequestBytes, 4096)), retry[1]);
        const original = queue.get(retry[1]);
        if (!original) return json(res, 404, { error: "not_found" });
        if (jobExpired(original, now())) throw new JobExpiredError();
        if (original.payload.requestKey !== command.requestKey) throw new RequestKeyConflictError();
        if (Date.parse(command.expiresAt) !== jobExpiresAt(original)) throw new ExpiryConflictError();
        if (original.result === undefined) throw new LayerRetryError("retry_not_allowed");
        requireExpectedContract(command.expectedContract, workerContractOf(original.payload));
        const accepted = await queue.retryLayers(original.id, command, version.sourceRevision, async job => {
          requireRenderVersion(job, version, true);
          for (const name of ["main", "cutout", "plate"]) {
            const asset = name === "main" ? job.result.main : job.result.layers[name];
            if (asset.state === "ready") await verifyAsset(cache, job, name);
          }
          if (job.layerRetries.at(-1).plan.includes("cutout")) requireForeground();
          await reserveDisk();
        });
        const response = await jobResponse(accepted.job);
        return json(res, response.status === "expired" ? 410 : ["queued", "running"].includes(response.status) ? 202 : 200,
          { ...response, acceptedRetryToken: command.retryToken, acceptedAttempt: accepted.acceptedAttempt, replayed: accepted.replayed });
      }
      const match = /^\/v1\/identity\/card-art\/([a-f0-9]{24})$/.exec(url.pathname);
      if (req.method === "GET" && match) {
        const job = queue.get(match[1]);
        if (!job) return json(res, 404, { error: "not_found" });
        const response = await jobResponse(job);
        return json(res, response.status === "expired" ? 410 : 200, response);
      }
      return json(res, 404, { error: "not_found" });
    } catch (error) {
      if (res.headersSent) {
        logger.error(JSON.stringify({ event: "cardgen.response_failed", code: error.code || error.name }));
        res.destroy(error); return;
      }
      if (error instanceof QueueCleanupBusyError) return json(res, 503, { error: "cache_cleanup_in_progress" });
      if (error instanceof LayerRetryError) return json(res, error.status, { error: error.message });
      if (error instanceof AssetUnavailableError) return json(res, 409, { error: "asset_integrity_conflict" });
      if (error instanceof InvalidExpiryError) return json(res, 400, { error: "invalid_expires_at" });
      if (error instanceof InvalidWorkerContractError) return json(res, 400, { error: "invalid_expected_contract" });
      if (error instanceof WorkerContractChangedError) return json(res, 409, { error: "contract_changed" });
      if (error instanceof InvalidRequestKeyError) return json(res, 400, { error: "invalid_request_key" });
      if (error instanceof RequestKeyConflictError) return json(res, 409, { error: "request_key_conflict" });
      if (error instanceof ExpiryConflictError) return json(res, 409, { error: "expiry_conflict" });
      if (error instanceof JobExpiredError) return json(res, 410, { status: "expired", error: "expired" });
      if (error instanceof RequestError) return json(res, error.status, { error: error.message });
      if (error instanceof QueueFullError) return json(res, 429, { error: "queue_full" });
      if (error.name === "HistoryFullError") return json(res, 503, { error: "history_capacity" });
      logger.error(JSON.stringify({ event: "cardgen.request_failed", code: error.code || error.name }));
      return json(res, 500, { error: "server_error" });
    } finally { httpActive--; }
  }, config));
  return { server, queue, budget, sweepRetention, async close() {
    closing = true; clearInterval(retentionTimer);
    try { if (retentionSweep) await retentionSweep; await queue.close(); }
    finally { try { await retentionFiles.close(); } finally { if (foreground.close) await foreground.close(); } }
  } };
}
