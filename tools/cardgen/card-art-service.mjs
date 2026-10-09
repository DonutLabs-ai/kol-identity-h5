import http from "node:http";
import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, writeFile, rename, statfs, stat, open, unlink, lstat } from "node:fs/promises";
import { constants } from "node:fs";
import { pipeline as streamPipeline } from "node:stream/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fastPrompt, TYPES } from "./harness/lib.mjs";
import { createImageGenerator, WorkerBudget } from "./openrouter-image.mjs";
import { withAuthentication } from "./server-config.mjs";
import { createSerialTaskQueue } from "./serial-task-queue.mjs";
import { createBedrockCutout, pngInfo } from "./bedrock-cutout.mjs";
import { createIsnetCutout } from "./isnet-cutout.mjs";
import { PersistentJobQueue, QueueFullError, QueueCleanupBusyError } from "./job-queue.mjs";
import { createRetentionFiles, FAILURE_STAGES, JobExpiredError, jobExpired, jobExpiresAt, normalizeExpiry, InvalidExpiryError, ExpiryConflictError } from "./retention.mjs";
import {
  IMAGE_MODEL, pipelineDescriptor, publicPipeline, cardArtId, normalizeRequestKey,
  InvalidRequestKeyError, RequestKeyConflictError, workerContractOf,
  expectedWorkerContract, requireExpectedContract,
  InvalidWorkerContractError, WorkerContractChangedError,
} from "./pipeline-version.mjs";
import { initializeSamples, beginSample, sampleReceipt, finishSample, skipSample, cancelReservation, stageFailure } from "./stage-samples.mjs";

const exec = promisify(execFile);
const ALLOWED_TYPES = new Set(TYPES.filter((type) => type !== "unresolved"));
const RESERVED_JOB_BYTES = 80 * 1024 * 1024;
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
    "Access-Control-Allow-Headers": "content-type, authorization", "Cache-Control": "private, no-store" });
  res.end(JSON.stringify(body));
};
function publicJob(job) {
  return { job_id: job.id, status: job.status, stage: job.stage, prompt_version: job.payload.promptVersion, ...publicPipeline(job.payload),
    ...(job.status === "done" ? { image_url: job.image_url, cutout_url: job.cutout_url,
      plate_url: job.plate_url } : {}),
    ...(job.status === "failed" ? { error: job.error,
      failure_stage: FAILURE_STAGES.has(job.failure_stage) ? job.failure_stage : "unknown" } : {}) };
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
  generate = createImageGenerator(), cutout, makePlate, validateMain, diskInfo = statfs, logger = console, now = Date.now }) {
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
  const validate = validateMain || (async (source) => {
    await exec("python3", [new URL("./harness/validate-main.py", import.meta.url).pathname, source],
      { timeout: 30000, maxBuffer: 4096 });
  });
  const plate = makePlate || (async (source, cut, target) => {
    const { stdout } = await exec("python3", [new URL("./harness/plate.py", import.meta.url).pathname,
      source, cut, target], { timeout: 30000, maxBuffer: 4096 });
    return JSON.parse(stdout);
  });
  let queue;
  const retentionFiles = createRetentionFiles(cache, id => queue.owns(id), (id, action) => queue.removeOrphan(id, action));
  function requireForeground() {
    if (foreground.healthy && !foreground.healthy()) {
      throw Object.assign(new Error("segmenter_unavailable"), { category: "provider_error", failure_stage: "cutout" });
    }
  }
  async function render(job) {
    initializeSamples(job);
    if (foreground.healthy && !foreground.healthy()) {
      skipSample(job, "llm", "dependency_unavailable"); skipSample(job, "cutout", "dependency_unavailable");
    }
    requireForeground();
    job.attemptStage = "validation";
    if (typeof job.payload.prompt !== "string" || typeof job.payload.promptVersion !== "string" ||
        job.payload.imageModel !== IMAGE_MODEL || job.payload.cutoutModel !== config.cutoutModel
        || Object.keys(version).some(field => Object.hasOwn(job.payload, field) && job.payload[field] !== version[field])) {
      throw Object.assign(new Error("unsupported_persisted_job_version"), { category: "invalid_output" });
    }
    const checkpoint = async (stage, updates = {}, attemptStage = job.attemptStage) => {
      job.attemptStage = attemptStage;
      job.stage = stage; Object.assign(job, updates); await queue.checkpoint(job);
    };
    const startSample = async stage => { beginSample(job, stage, now()); await queue.checkpoint(job); };
    const receiptSample = async (stage, receipt) => { sampleReceipt(job, stage, receipt); await queue.checkpoint(job); };
    const completeSample = async (stage, outcome = "success", reason = null) => {
      finishSample(job, stage, now(), outcome, reason); await queue.checkpoint(job);
    };
    const failedSample = async (stage, error) => {
      const sample = job.stageSamples?.stages[stage];
      if (sample?.outcome === "running") {
        if (stage === "llm" && error !== null && typeof error === "object" && error.failure_stage === "cutout" && sample.dispatchState === "reserved") cancelReservation(job, stage, "dependency_unavailable");
        else { const { outcome, reason } = stageFailure(error); finishSample(job, stage, now(), outcome, reason); }
      } else if (sample?.attempts === 0) {
        const explicit = error !== null && typeof error === "object" && ["budget_not_dispatched", "input_unavailable"].includes(error.sampleReason) ? error.sampleReason : stageFailure(error).reason;
        skipSample(job, stage, explicit);
      }
      await queue.checkpoint(job);
    };
    const main = join(cache, job.id + ".png"), cut = join(cache, job.id + ".cut.png"),
      background = join(cache, job.id + ".plate.jpg");
    if (!(await fileExists(main))) {
      await checkpoint("gemini", {}, "llm");
      requireForeground();
      let result;
      try { result = await generate({ key: apiKey, model: job.payload.imageModel,
        prompt: job.payload.prompt,
        avatarPath: job.payload.avatarPath, refs: [], budget, beforeDispatch: requireForeground,
        onDispatch: () => startSample("llm"), onReceipt: receipt => receiptSample("llm", receipt) });
        job.attemptStage = "validation";
        pngInfo(result.png);
        if (result.png.length > 12 * 1024 * 1024) throw Object.assign(new Error("main_image_too_large"), { category: "invalid_output" });
      } catch (error) { await failedSample("llm", error); throw error; }
      // Real adapters provide receipts at dispatch; injected/legacy adapters without them carry no invented attempt.
      if (job.stageSamples?.stages.llm.outcome === "running") {
        await receiptSample("llm", { newProviderRequests: 1, costUSD: result.cost, reportedSeconds: result.secs });
      }
      await atomicWrite(main, result.png);
      await checkpoint("image_ready", { image_url: `/art/${job.id}.png` });
    } else skipSample(job, "llm", "cache_asset");
    job.attemptStage = "validation";
    try { await validate(main); }
    catch (error) {
      if (job.stageSamples?.stages.llm.outcome === "running") {
        const { outcome, reason } = stageFailure(error);
        await completeSample("llm", outcome, reason);
      }
      throw error;
    }
    if (job.stageSamples?.stages.llm.outcome === "running") await completeSample("llm");
    await checkpoint("cutout_queued", {}, "cutout");
    let result;
    try {
      result = await foreground(await readFile(main), () => checkpoint(config.cutoutProvider), { source: main, target: cut,
        onDispatch: () => startSample("cutout"), onReceipt: receipt => receiptSample("cutout", receipt) });
      if (result === null || typeof result !== "object" || !Buffer.isBuffer(result.png)) throw Object.assign(new Error("cutout_image_missing"), { category: "invalid_output", sampleOutcome: "no_image", sampleReason: "missing_image" });
      if (result.png.length > 24 * 1024 * 1024) throw Object.assign(new Error("cutout_too_large"), { category: "invalid_output" });
    } catch (error) { await failedSample("cutout", error); throw error; }
    if (job.stageSamples?.stages.cutout.outcome === "running") await completeSample("cutout");
    await atomicWrite(cut, result.png);
    await checkpoint("plate", typeof result.requestId === "string" ? { cutout_request_id: result.requestId } : {}, "plate");
    let quality;
    try { quality = await enqueuePlate(async () => {
      await startSample("plate");
      // Local Python invocation, not a new external image/provider request; cost is unknown.
      await receiptSample("plate", { newProviderRequests: 0, costUSD: null, reportedSeconds: null });
      return plate(main, cut, background);
    }); } catch (error) { await failedSample("plate", error); throw error; }
    job.attemptStage = "validation";
    if (!Number.isFinite(quality.coverage) || quality.coverage < 0.03 || quality.coverage > 0.9) {
      await completeSample("plate", "invalid_output", "invalid_output");
      throw Object.assign(new Error("invalid_foreground_coverage"), { category: "invalid_output" });
    }
    for (const output of [main, cut, background]) {
      if (!(await fileExists(output))) {
        await completeSample("plate", "invalid_output", "invalid_output");
        throw Object.assign(new Error("output_missing"), { category: "invalid_output" });
      }
    }
    if ((await stat(background)).size > 32 * 1024 * 1024) {
      await completeSample("plate", "invalid_output", "invalid_output");
      throw Object.assign(new Error("plate_too_large"), { category: "invalid_output" });
    }
    await completeSample("plate");
    job.image_url = `/art/${job.id}.png`; job.cutout_url = `/art/${job.id}.cut.png`;
    job.plate_url = `/art/${job.id}.plate.jpg`; job.stage = "complete";
    logger.log(JSON.stringify({ event: "cardgen.completed", job_id: job.id,
      cutout_request_id: result.requestId, cutout_seconds: result.seconds, coverage: quality.coverage }));
  }
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
    if (job.status === "done") {
      for (const suffix of [".png", ".cut.png", ".plate.jpg"]) {
        if (!(await fileExists(join(cache, job.id + suffix)))) return {
          ...receipt, ...publicPipeline(job.payload), job_id: job.id, status: "failed", error: "output_missing", failure_stage: "validation", prompt_version: job.payload.promptVersion,
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
        const file = join(cache, name);
        let handle;
        try { handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW); }
        catch (error) { if (error.code === "ENOENT" || error.code === "ELOOP") return json(res, 404, { error: "not_found" }); throw error; }
        try {
          if (!(await handle.stat()).isFile()) return json(res, 404, { error: "not_found" });
          if (jobExpired(job, now())) return json(res, 410, { status: "expired", error: "expired" });
          res.writeHead(200, { "Content-Type": name.endsWith(".jpg") ? "image/jpeg" : "image/png",
            "Access-Control-Allow-Origin": "*", "Cache-Control": "private, no-store" });
          await streamPipeline(handle.createReadStream({ autoClose: false }), res); return;
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
          promptVersion: prompts.version,
          prompt: fastPrompt(prompts.types[body.type].replace(/\s+/g, " ").trim()),
          ...version,
          ...(requestKey === undefined ? {} : { requestKey }),
        }, async () => {
          const disk = await diskInfo(cache);
          const available = disk.bavail * disk.bsize;
          if (!Number.isSafeInteger(available) || available < 0) throw new Error("Invalid filesystem available capacity");
          const pending = queue.stats();
          const reservation = Math.max(RESERVED_JOB_BYTES, config.maxAvatarBytes + 68 * 1024 * 1024 + 128 * 1024);
          if (available - (pending.active + pending.queued) * reservation < config.minFreeDiskBytes) {
            throw new RequestError(503, "storage_capacity");
          }
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
