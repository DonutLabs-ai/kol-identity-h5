// Private, bounded per-job observations. No prompts, avatar bytes/URLs, request keys or raw errors.
export const SAMPLE_VERSION = "DONUT_CARD_STAGE_SAMPLES_V1";
const STAGES = ["llm", "cutout", "plate"];
const OUTCOMES = new Set([
  "not_started",
  "running",
  "success",
  "error",
  "timeout",
  "no_image",
  "quality_rejected",
  "invalid_output",
  "asset_error",
  "unavailable",
  "unknown",
]);
const REASONS = new Set([
  "upstream_failed",
  "cache_asset",
  "dependency_unavailable",
  "input_unavailable",
  "budget_not_dispatched",
  "provider_error",
  "provider_timeout",
  "provider_throttled",
  "provider_rejected",
  "missing_image",
  "invalid_output",
  "asset_download_failed",
  "quality_rejected",
  "crash_unknown",
  "unknown",
]);
function emptySample() {
  return {
    attempts: 0,
    newProviderRequests: 0,
    dispatchState: null,
    outcome: "not_started",
    reason: null,
    startedAt: null,
    finishedAt: null,
    elapsedMs: null,
    reportedSeconds: null,
    costUSD: null,
  };
}
export function initializeSamples(job) {
  if (job.stageSamples !== undefined) return;
  const p = job.payload;
  if (
    ![
      "imageModel",
      "promptVersion",
      "pipelineVersion",
      "cutoutProvider",
      "cutoutModel",
      "cutoutRevision",
      "sourceRevision",
    ].every((field) => typeof p[field] === "string")
  )
    return;
  job.stageSamples = {
    version: SAMPLE_VERSION,
    imageApi: "openrouter_chat_completions",
    versions: {
      imageModel: p.imageModel,
      promptVersion: p.promptVersion,
      pipelineVersion: p.pipelineVersion,
      cutoutProvider: p.cutoutProvider,
      cutoutModel: p.cutoutModel,
      cutoutRevision: p.cutoutRevision,
      sourceRevision: p.sourceRevision,
    },
    stages: Object.fromEntries(STAGES.map((stage) => [stage, emptySample()])),
  };
}
export function initializeLayerSamples(job, executionSourceRevision) {
  if (job.stageSamples === undefined) throw new TypeError("Layer retry requires original observations");
  if (job.layerAttemptSamples === undefined) job.layerAttemptSamples = [];
  job.layerAttemptSamples.push({ attempt: job.result.attempt, acceptedSourceRevision: executionSourceRevision, executionSourceRevision: null,
    stages: { cutout: emptySample(), plate: emptySample() } });
}
export function beginLayerExecution(job, executionSourceRevision) {
  const entry = job.layerAttemptSamples[job.result.attempt - 1];
  if (Object.values(entry.stages).some(sample => sample.attempts !== 0 || sample.reason !== null))
    throw new TypeError("Layer execution provenance must precede all derivative work");
  if (!Object.hasOwn(entry, "acceptedSourceRevision")) {
    // Legacy queued receipts named the acceptance source as execution. Preserve that fact.
    entry.acceptedSourceRevision = entry.executionSourceRevision;
    entry.executionSourceRevision = null;
  }
  if (entry.executionSourceRevision !== null) throw new TypeError("Layer execution source is already bound");
  entry.executionSourceRevision = executionSourceRevision;
}
export function currentSample(job, stage) {
  if (job.stageSamples === undefined) return undefined;
  if (job.result !== undefined && job.result.attempt > 0) {
    if (stage === "llm") throw new TypeError("Layer retry cannot observe or dispatch LLM work");
    return job.layerAttemptSamples[job.result.attempt - 1].stages[stage];
  }
  return job.stageSamples.stages[stage];
}
export function beginSample(job, stage, now) {
  if (job.stageSamples === undefined) return;
  const sample = currentSample(job, stage);
  if (sample.attempts !== 0)
    throw new TypeError("Stage attempt already recorded; retries are not permitted");
  Object.assign(sample, {
    attempts: 1,
    dispatchState: "reserved",
    outcome: "running",
    startedAt: new Date(now).toISOString(),
  });
}
export function sampleReceipt(job, stage, receipt) {
  if (job.stageSamples === undefined) return;
  const sample = currentSample(job, stage);
  if (sample.attempts !== 1) throw new TypeError("Receipt requires a stage attempt");
  if (![0, 1].includes(receipt.newProviderRequests))
    throw new TypeError("Invalid provider request count");
  for (const field of ["costUSD", "reportedSeconds"]) {
    if (receipt[field] !== null && (!Number.isFinite(receipt[field]) || receipt[field] < 0))
      throw new TypeError("Invalid stage receipt number");
  }
  Object.assign(sample, {
    dispatchState: "confirmed",
    newProviderRequests: receipt.newProviderRequests,
    costUSD: receipt.costUSD,
    reportedSeconds: receipt.reportedSeconds,
  });
}
export function finishSample(job, stage, now, outcome = "success", reason = null) {
  if (job.stageSamples === undefined) return;
  const sample = currentSample(job, stage);
  if (
    !OUTCOMES.has(outcome) ||
    outcome === "running" ||
    outcome === "not_started" ||
    (reason !== null && !REASONS.has(reason))
  )
    throw new TypeError("Invalid sample outcome");
  if (sample.attempts !== 1 || sample.outcome !== "running")
    throw new TypeError("Finish requires a running stage attempt");
  Object.assign(sample, {
    outcome,
    reason,
    finishedAt: new Date(now).toISOString(),
    elapsedMs: Math.max(0, now - Date.parse(sample.startedAt)),
  });
}
export function skipSample(job, stage, reason) {
  if (job.stageSamples === undefined) return;
  if (!REASONS.has(reason)) throw new TypeError("Invalid skipped stage reason");
  const sample = currentSample(job, stage);
  if (sample.attempts === 0) sample.reason = reason;
}
export function cancelReservation(job, stage, reason) {
  if (job.stageSamples === undefined) return;
  const sample = job.stageSamples.stages[stage];
  if (sample.dispatchState !== "reserved" || sample.newProviderRequests !== 0)
    throw new TypeError("Cannot cancel a confirmed dispatch");
  job.stageSamples.stages[stage] = emptySample();
  skipSample(job, stage, reason);
}
export function stageFailure(error) {
  if (error !== null && typeof error === "object") {
    if (
      error.sampleOutcome !== undefined &&
      OUTCOMES.has(error.sampleOutcome) &&
      REASONS.has(error.sampleReason)
    )
      return { outcome: error.sampleOutcome, reason: error.sampleReason };
    if (error.code === "provider_result_unknown" || error.category === "provider_result_unknown")
      return { outcome: "unknown", reason: "unknown" };
    if (
      ["TimeoutError", "AbortError"].includes(error.name) ||
      ["ETIMEDOUT", "provider_timeout"].includes(error.code) ||
      error.category === "provider_timeout"
    )
      return { outcome: "timeout", reason: "provider_timeout" };
    if (error.category === "invalid_output")
      return { outcome: "invalid_output", reason: "invalid_output" };
    if (["provider_error", "provider_throttled", "provider_rejected"].includes(error.category))
      return { outcome: "error", reason: error.category };
  }
  return { outcome: "unknown", reason: "unknown" };
}
export function settleSamples(job, now, failed) {
  if (job.stageSamples === undefined) return; // Legacy journals carry no invented historical samples.
  for (const stage of job.result !== undefined && job.result.attempt > 0 ? ["cutout", "plate"] : STAGES) {
    const sample = currentSample(job, stage);
    if (sample.outcome === "running") finishSample(job, stage, now, "unknown", "crash_unknown");
    else if (sample.attempts === 0 && sample.reason === null && failed)
      skipSample(job, stage, "upstream_failed");
  }
}
export function validateSamples(job) {
  if (
    job.cacheReplayCount !== undefined &&
    (!Number.isSafeInteger(job.cacheReplayCount) || job.cacheReplayCount < 0)
  )
    throw new TypeError("Invalid cache replay count");
  if (job.stageSamples === undefined) return;
  const ledger = job.stageSamples;
  if (
    ledger.version !== SAMPLE_VERSION ||
    ledger.imageApi !== "openrouter_chat_completions" ||
    !ledger.versions ||
    !ledger.stages ||
    Object.keys(ledger.stages).length !== 3
  )
    throw new TypeError("Invalid stage sample ledger");
  const fields = [
    "imageModel",
    "promptVersion",
    "pipelineVersion",
    "cutoutProvider",
    "cutoutModel",
    "cutoutRevision",
    "sourceRevision",
  ];
  if (
    Object.keys(ledger.versions).length !== fields.length ||
    !fields.every(
      (field) =>
        typeof ledger.versions[field] === "string" && ledger.versions[field] === job.payload[field],
    )
  )
    throw new TypeError("Sample versions must match original payload");
  for (const stage of STAGES) {
    const s = ledger.stages[stage];
    validateSample(s, stage, ledger.versions);
  }
  if (job.layerAttemptSamples !== undefined) {
    if (!Array.isArray(job.layerAttemptSamples) || job.layerAttemptSamples.length !== job.result?.attempt)
      throw new TypeError("Invalid layer observation history");
    for (const [index, entry] of job.layerAttemptSamples.entries()) {
      const legacy = !Object.hasOwn(entry, "acceptedSourceRevision");
      const accepted = legacy ? entry.executionSourceRevision : entry.acceptedSourceRevision;
      if (entry.attempt !== index + 1 || accepted !== job.layerRetries[index].executionSourceRevision
        || (!legacy && entry.executionSourceRevision !== null && (typeof entry.executionSourceRevision !== "string"
          || entry.executionSourceRevision.length < 1 || entry.executionSourceRevision.length > 128))
        || !entry.stages || Object.keys(entry.stages).length !== 2) throw new TypeError("Invalid layer observations");
      for (const stage of ["cutout", "plate"]) validateSample(entry.stages[stage], stage, ledger.versions);
      if (!legacy && entry.executionSourceRevision === null && Object.values(entry.stages).some(sample => sample.attempts !== 0))
        throw new TypeError("Dispatched derivative requires actual execution provenance");
    }
  } else if (job.result !== undefined && job.result.attempt !== 0) throw new TypeError("Missing retry observations");
}
function validateSample(s, stage, versions) {
  if (
    !s ||
    Object.keys(s).length !== 10 ||
    ![0, 1].includes(s.attempts) ||
    ![0, 1].includes(s.newProviderRequests) ||
    ![null, "reserved", "confirmed"].includes(s.dispatchState) ||
    !OUTCOMES.has(s.outcome) ||
    (s.reason !== null && !REASONS.has(s.reason))
  )
    throw new TypeError("Invalid stage sample");
  for (const field of ["elapsedMs", "reportedSeconds", "costUSD"])
    if (s[field] !== null && (!Number.isFinite(s[field]) || s[field] < 0))
      throw new TypeError("Invalid stage timing/cost");
  if (s.attempts === 0) {
    if (
      s.outcome !== "not_started" ||
      s.newProviderRequests !== 0 ||
      s.dispatchState !== null ||
      [s.startedAt, s.finishedAt, s.elapsedMs, s.reportedSeconds, s.costUSD].some(
        (value) => value !== null,
      )
    )
      throw new TypeError("Unattempted stage must not enter denominator");
  } else if (
    !Number.isFinite(Date.parse(s.startedAt)) ||
    s.dispatchState === null ||
    (s.outcome === "running"
      ? s.finishedAt !== null || s.elapsedMs !== null
      : !Number.isFinite(Date.parse(s.finishedAt)) || s.elapsedMs === null)
  )
    throw new TypeError("Invalid stage sample timestamps");
  if (s.newProviderRequests === 1 && s.dispatchState !== "confirmed")
    throw new TypeError("Unknown dispatch cannot be counted as a confirmed provider request");
  const external =
    stage === "llm" || (stage === "cutout" && versions.cutoutProvider === "bedrock");
  if (s.dispatchState === "confirmed" && s.newProviderRequests !== (external ? 1 : 0))
    throw new TypeError("Stage provider denominator does not match its frozen adapter");
  if (s.dispatchState === "reserved" && (s.costUSD !== null || s.reportedSeconds !== null))
    throw new TypeError("Unconfirmed dispatch cannot invent a receipt");
}
