import { readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { IMAGE_MODEL } from "./pipeline-version.mjs";
import { pngInfo } from "./bedrock-cutout.mjs";
import { JobStoreError } from "./job-queue.mjs";
import { initializeSamples, beginLayerExecution, currentSample, beginSample, sampleReceipt, finishSample, skipSample, cancelReservation, stageFailure } from "./stage-samples.mjs";
import { initializeResult, readyAsset, failAsset } from "./layer-result.mjs";
import { durableWrite, readRaster, verifyAsset } from "./asset-files.mjs";
import { JobExpiredError, jobExpired } from "./retention.mjs";

export function requireRenderVersion(job, version, retry) {
  if (typeof job.payload.prompt !== "string" || typeof job.payload.promptVersion !== "string"
    || job.payload.imageModel !== IMAGE_MODEL || Object.keys(version).some(field =>
      !(retry && field === "sourceRevision") && Object.hasOwn(job.payload, field) && job.payload[field] !== version[field]))
    throw Object.assign(new Error("unsupported_persisted_job_version"), { category: "invalid_output" });
}
export function createLayerRenderer({ cache, config, version, foreground, generate, apiKey, budget,
  validateMain, validateLayer, makePlate, enqueuePlate, fileExists, requireForeground, now, queue, logger }) {
  return async job => {
    const assertActive = () => { if (jobExpired(job, now())) throw new JobExpiredError(); };
    assertActive();
    initializeSamples(job);
    if (job.result === undefined) initializeResult(job);
    const retry = job.result.attempt > 0;
    job.attemptStage = "validation";
    requireRenderVersion(job, version, retry);
    if (!retry) {
      if (foreground.healthy && !foreground.healthy()) {
        skipSample(job, "llm", "dependency_unavailable"); skipSample(job, "cutout", "dependency_unavailable");
      }
      job.attemptStage = "unknown";
      requireForeground();
      job.attemptStage = "validation";
    }
    const checkpoint = async (stage, attemptStage = job.attemptStage) => {
      job.stage = stage; job.attemptStage = attemptStage; await queue().checkpoint(job);
      assertActive();
    };
    const start = async stage => { assertActive(); beginSample(job, stage, now()); await queue().checkpoint(job); assertActive(); };
    const receipt = async (stage, value) => { sampleReceipt(job, stage, value); await queue().checkpoint(job); };
    const finish = async stage => {
      if (currentSample(job, stage)?.outcome === "running") finishSample(job, stage, now());
      await queue().checkpoint(job);
    };
    const failed = async (stage, error) => {
      if (error instanceof JobStoreError || error instanceof JobExpiredError) throw error;
      const tagged = error !== null && typeof error === "object";
      const sample = currentSample(job, stage);
      if (sample?.outcome === "running") {
        if (stage === "llm" && tagged && error.failure_stage === "cutout" && sample.dispatchState === "reserved")
          cancelReservation(job, stage, "dependency_unavailable");
        else { const { outcome, reason } = stageFailure(error); finishSample(job, stage, now(), outcome, reason); }
      } else if (sample?.attempts === 0) {
        skipSample(job, stage, tagged && ["budget_not_dispatched", "input_unavailable"].includes(error.sampleReason)
          ? error.sampleReason : stageFailure(error).reason);
      }
      failAsset(job, stage === "llm" && tagged && error.failure_stage === "cutout" ? "cutout" : stage === "llm" ? "main" : stage, error);
      // The queue commits the failed receipt and terminal status together before retry admission.
    };
    const main = join(cache, job.id + ".png"), cut = join(cache, job.id + ".cut.png"), plate = join(cache, job.id + ".plate.jpg");
    if (retry) {
      beginLayerExecution(job, version.sourceRevision);
      await checkpoint("layers_starting");
      // Original LLM sample/deadline are untouched; a derivative attempt has its own stage budget.
      await verifyAsset(cache, job, "main");
    } else {
      job.result.main = { state: "running", validated: false };
      if (!(await fileExists(main))) {
        await checkpoint("gemini", "llm");
        requireForeground();
        let generated;
        try {
          generated = await generate({ key: apiKey, model: job.payload.imageModel, prompt: job.payload.prompt,
            avatarPath: job.payload.avatarPath, refs: [], budget, beforeDispatch: () => { assertActive(); requireForeground(); },
            onDispatch: () => start("llm"), onReceipt: value => receipt("llm", value) });
          assertActive();
          job.attemptStage = "validation";
          pngInfo(generated.png);
          if (generated.png.length > 12 * 1024 ** 2) throw Object.assign(new Error("main_image_too_large"), { category: "invalid_output" });
        } catch (error) { await failed("llm", error); throw error; }
        if (currentSample(job, "llm")?.outcome === "running")
          await receipt("llm", { newProviderRequests: 1, costUSD: generated.cost, reportedSeconds: generated.secs });
        await durableWrite(main, generated.png, assertActive);
        job.image_url = `/art/${job.id}.png`;
        await checkpoint("image_ready");
      } else skipSample(job, "llm", "cache_asset");
      job.attemptStage = "validation";
      try { await validateMain(main); }
      catch (error) { await failed("llm", error); throw error; }
      const mainBytes = await readRaster(main, "main");
      assertActive(); readyAsset(job, "main", mainBytes);
      await finish("llm");
    }
    const plan = retry ? job.layerRetries[job.result.attempt - 1].plan : ["cutout", "plate"];
    if (plan.includes("cutout")) {
      await checkpoint("cutout_queued", "cutout");
      const scratch = cut + ".tmp";
      try {
        requireForeground();
        await verifyAsset(cache, job, "main");
        const mainBytes = await readRaster(main, "main");
        assertActive();
        const result = await foreground(mainBytes, async () => {
          job.result.layers.cutout = { state: "running", attempt: job.result.attempt };
          await checkpoint(config.cutoutProvider, "cutout");
        }, { source: main, target: scratch, onDispatch: () => start("cutout"), onReceipt: value => receipt("cutout", value) });
        assertActive();
        if (result === null || typeof result !== "object" || !Buffer.isBuffer(result.png))
          throw Object.assign(new Error("cutout_image_missing"), { category: "invalid_output", sampleOutcome: "no_image", sampleReason: "missing_image" });
        if (result.png.length > 24 * 1024 ** 2) throw Object.assign(new Error("cutout_too_large"), { category: "invalid_output" });
        await durableWrite(scratch, result.png, assertActive);
        await validateLayer("cutout", main, scratch);
        assertActive();
        await durableWrite(cut, result.png, assertActive);
        await unlink(scratch);
        assertActive();
        readyAsset(job, "cutout", result.png);
        if (typeof result.requestId === "string") job.cutout_request_id = result.requestId;
        await finish("cutout");
      } catch (error) { await failed("cutout", error); throw error; }
    } else {
      await verifyAsset(cache, job, "cutout");
      skipSample(job, "cutout", "cache_asset");
    }
    if (plan.includes("plate")) {
      job.result.layers.plate = { state: "pending", attempt: job.result.attempt };
      await checkpoint("plate_queued", "plate");
      const scratch = plate + ".tmp";
      try {
        const quality = await enqueuePlate(async () => {
          await verifyAsset(cache, job, "main"); await verifyAsset(cache, job, "cutout");
          job.result.layers.plate = { state: "running", attempt: job.result.attempt };
          await checkpoint("plate", "plate"); await start("plate");
          await receipt("plate", { newProviderRequests: 0, costUSD: null, reportedSeconds: null });
          assertActive();
          return makePlate(main, cut, scratch);
        });
        assertActive();
        job.attemptStage = "validation";
        if (!Number.isFinite(quality.coverage) || quality.coverage < 0.03 || quality.coverage > 0.9)
          throw Object.assign(new Error("invalid_foreground_coverage"), { category: "invalid_output" });
        const bytes = await readRaster(scratch, "plate");
        await validateLayer("plate", main, scratch);
        assertActive();
        await durableWrite(plate, bytes, assertActive);
        await unlink(scratch);
        assertActive();
        readyAsset(job, "plate", bytes);
        await finish("plate");
      } catch (error) { await failed("plate", error); throw error; }
    }
    if (![job.result.main, ...Object.values(job.result.layers)].every(asset => asset.state === "ready"))
      throw new TypeError("Render completed without all ready assets");
    assertActive();
    job.image_url = job.result.main.url; job.cutout_url = job.result.layers.cutout.url;
    job.plate_url = job.result.layers.plate.url; job.stage = "complete";
    logger.log(JSON.stringify({ event: "cardgen.completed", job_id: job.id, attempt: job.result.attempt }));
  };
}
