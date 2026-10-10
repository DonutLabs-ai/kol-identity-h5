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
export function beginSample(job, stage, now) {
  if (job.stageSamples === undefined) return;
  const sample = job.stageSamples.stages[stage];
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
  const sample = job.stageSamples.stages[stage];
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
  const sample = job.stageSamples.stages[stage];
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
  const sample = job.stageSamples.stages[stage];
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
    if (
      ["TimeoutError", "AbortError"].includes(error.name) ||
      ["ETIMEDOUT", "provider_timeout", "provider_result_unknown"].includes(error.code) ||
      ["provider_timeout", "provider_result_unknown"].includes(error.category)
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
  for (const stage of STAGES) {
    const sample = job.stageSamples.stages[stage];
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
      stage === "llm" || (stage === "cutout" && ledger.versions.cutoutProvider === "bedrock");
    if (s.dispatchState === "confirmed" && s.newProviderRequests !== (external ? 1 : 0))
      throw new TypeError("Stage provider denominator does not match its frozen adapter");
    if (s.dispatchState === "reserved" && (s.costUSD !== null || s.reportedSeconds !== null))
      throw new TypeError("Unconfirmed dispatch cannot invent a receipt");
  }
}
