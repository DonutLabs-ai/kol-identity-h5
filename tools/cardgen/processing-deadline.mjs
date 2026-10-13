import { normalizeExpiry } from "./retention.mjs";
import { currentSample, finishSample, settleSamples } from "./stage-samples.mjs";

export const PROCESSING_DEADLINE_VERSION = 1;
export const PROCESSING_LIMIT_MS = 60000;
export class InvalidProcessingDeadlineError extends Error {
  constructor() { super("invalid_processing_deadline"); this.name = "InvalidProcessingDeadlineError"; }
}
export class ProcessingDeadlineError extends Error {
  constructor() { super("processing_deadline_reached"); this.name = "ProcessingDeadlineError"; this.category = "provider_timeout"; }
}
export function normalizeProcessingDeadline(value) {
  if (typeof value !== "string" || !value.endsWith("Z")) throw new InvalidProcessingDeadlineError();
  try { return normalizeExpiry(value); }
  catch (error) {
    if (error.name !== "InvalidExpiryError") throw error;
    throw new InvalidProcessingDeadlineError();
  }
}
export function processingAdmission(value, receivedAt) {
  const received = new Date(receivedAt).toISOString();
  const deadline = value === undefined ? new Date(receivedAt + PROCESSING_LIMIT_MS).toISOString()
    : normalizeProcessingDeadline(value);
  if (Date.parse(deadline) > receivedAt + PROCESSING_LIMIT_MS) throw new InvalidProcessingDeadlineError();
  return { processingReceivedAt: received, processingDeadlineAt: deadline };
}
export function processingDeadlineAt(job) {
  const retry = job.result?.attempt > 0 ? job.layerRetries[job.result.attempt - 1] : undefined;
  return Date.parse(retry === undefined ? job.processingDeadlineAt : retry.processingDeadlineAt);
}
export function processingExpired(job, now) { return now >= processingDeadlineAt(job); }
export function needsProcessingDeadline(job) {
  return job.status === "queued" || job.status === "running" || (job.status === "failed"
    && !job.processingTimedOut && (job.error === "provider_result_unknown" || job.result !== undefined
      && [job.result.main, ...Object.values(job.result.layers)].some(asset => asset.state === "unknown")));
}
export function backfillProcessingDeadline(job) {
  let changed = false;
  if (job.processingDeadlineAt === undefined) {
    Object.assign(job, processingAdmission(undefined, Date.parse(job.createdAt))); changed = true;
  }
  for (const retry of job.layerRetries || []) {
    if (retry.processingDeadlineAt === undefined) {
      // Old journals have no retry receipt timestamp. Conservatively use original creation,
      // never fabricate a new 60-second interval on recovery. Completed results stay intact.
      Object.assign(retry, processingAdmission(undefined, Date.parse(job.createdAt))); changed = true;
    }
  }
  return changed;
}
export function validateProcessingDeadline(job) {
  const entries = [job, ...(job.layerRetries || [])];
  for (const entry of entries) {
    if (entry.processingDeadlineAt === undefined && entry.processingReceivedAt === undefined) continue;
    if (typeof entry.processingReceivedAt !== "string"
      || normalizeProcessingDeadline(entry.processingReceivedAt) !== entry.processingReceivedAt
      || normalizeProcessingDeadline(entry.processingDeadlineAt) !== entry.processingDeadlineAt
      || Date.parse(entry.processingDeadlineAt) > Date.parse(entry.processingReceivedAt) + PROCESSING_LIMIT_MS)
      throw new TypeError("Invalid durable processing deadline");
  }
  if (job.processingTimedOut !== undefined && job.processingTimedOut !== true)
    throw new TypeError("Invalid processing timeout marker");
}
export function completeProcessing(job, now) {
  if (job.result === undefined || !job.result.main.validated
    || ![job.result.main, ...Object.values(job.result.layers)].every(asset => asset.state === "ready")) return false;
  // Readiness is already durably qualified. Terminal bookkeeping does not
  // create another asset or turn a successful plate into a timeout.
  job.status = "done"; job.stage = "complete";
  job.image_url = job.result.main.url; job.cutout_url = job.result.layers.cutout.url;
  job.plate_url = job.result.layers.plate.url;
  delete job.error; delete job.failure_stage; delete job.processingTimedOut;
  settleSamples(job, now, false);
  job.updatedAt = new Date(now).toISOString();
  return true;
}
export function settleProcessingDeadline(job, now) {
  if (completeProcessing(job, now)) return;
  job.status = "failed"; job.stage = "processing_deadline"; job.error = "provider_timeout";
  job.failure_stage = job.result?.main.state === "ready"
    ? job.result.layers.cutout.state === "ready" ? "plate" : "cutout" : "llm";
  job.processingTimedOut = true;
  if (job.result !== undefined) {
    for (const [name, asset] of [["main", job.result.main], ...Object.entries(job.result.layers)]) {
      if (["ready", "failed", "timed_out"].includes(asset.state)) continue;
      const timedOut = { state: "timed_out", reason: "stage_timeout" };
      if (name === "main") job.result.main = { ...timedOut, validated: false };
      else job.result.layers[name] = { ...timedOut, attempt: job.result.attempt };
    }
  }
  if (job.stageSamples !== undefined) {
    for (const stage of job.result?.attempt > 0 ? ["cutout", "plate"] : ["llm", "cutout", "plate"]) {
      if (currentSample(job, stage).outcome === "running")
        finishSample(job, stage, now, "timeout", "provider_timeout");
    }
  }
  settleSamples(job, now, true);
  job.updatedAt = new Date(now).toISOString();
}
