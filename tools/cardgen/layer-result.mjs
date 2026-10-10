import { createHash } from "node:crypto";
import { normalizeRequestKey, expectedWorkerContract } from "./pipeline-version.mjs";
import { normalizeExpiry } from "./retention.mjs";

export const RESULT_CONTRACT = "DONUT_CARD_PARTIAL_LAYERS_V1";
const STATES = new Set(["pending", "running", "ready", "failed", "timed_out", "unknown", "blocked"]);
const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export class LayerRetryError extends Error {
  constructor(code, status = 409) { super(code); this.name = "LayerRetryError"; this.status = status; }
}
export function initializeResult(job) {
  job.result = {
    result_contract: RESULT_CONTRACT, attempt: 0,
    main: { state: "pending", validated: false },
    layers: { cutout: { state: "pending", attempt: 0 }, plate: { state: "blocked", attempt: 0 } },
  };
  job.layerRetries = [];
}
export function resultReceipt(job) { return job.result === undefined ? {} : job.result; }
export function settleResult(job) {
  if (job.result === undefined) return;
  const r = job.result;
  for (const [name, asset] of [["main", r.main], ...Object.entries(r.layers)]) {
    if (asset.state === "running" || asset.state === "pending") {
      const dependency = name === "cutout" ? r.main : name === "plate" ? r.layers.cutout : undefined;
      // Pending dependants were never dispatched. Only work that could have run is unknown.
      if (asset.state === "pending" && dependency !== undefined && dependency.state !== "ready") {
        asset.state = "blocked"; delete asset.reason;
      } else { asset.state = "unknown"; asset.reason = "result_unknown"; }
      if (Object.hasOwn(asset, "validated")) asset.validated = false;
      delete asset.url; delete asset.sha256;
    }
  }
}
export function readyAsset(job, name, bytes) {
  const suffix = name === "main" ? ".png" : name === "cutout" ? ".cut.png" : ".plate.jpg";
  const asset = { state: "ready", url: `/art/${job.id}${suffix}`,
    sha256: createHash("sha256").update(bytes).digest("hex") };
  if (name === "main") job.result.main = { ...asset, validated: true };
  else job.result.layers[name] = { ...asset, attempt: job.result.attempt };
}
export function failAsset(job, name, error) {
  if (job.result === undefined) return;
  const category = error !== null && typeof error === "object" ? error.category : undefined;
  const unknown = category === "provider_result_unknown" || category === undefined;
  const state = unknown ? "unknown" : category === "provider_timeout" ? "timed_out" : "failed";
  const asset = { state, reason: unknown ? "result_unknown" : state === "timed_out" ? "stage_timeout" : "stage_failed" };
  if (name === "main") job.result.main = { ...asset, validated: false };
  else job.result.layers[name] = { ...asset, attempt: job.result.attempt };
}
export function retryCommand(body, id) {
  if (Object.keys(body).length !== 6 || !["requestKey", "expiresAt", "expectedContract", "retryToken", "expectedAttempt", "mainSha256"].every(field => Object.hasOwn(body, field)))
    throw new LayerRetryError("invalid_layer_retry", 400);
  if (typeof body.retryToken !== "string" || !UUID.test(body.retryToken.toLowerCase())
    || !Number.isSafeInteger(body.expectedAttempt) || body.expectedAttempt < 0 || body.expectedAttempt >= Number.MAX_SAFE_INTEGER
    || typeof body.mainSha256 !== "string" || !HASH.test(body.mainSha256))
    throw new LayerRetryError("invalid_layer_retry", 400);
  const command = { requestKey: normalizeRequestKey(body.requestKey), expiresAt: normalizeExpiry(body.expiresAt),
    expectedContract: expectedWorkerContract(body.expectedContract), retryToken: body.retryToken.toLowerCase(),
    expectedAttempt: body.expectedAttempt, mainSha256: body.mainSha256 };
  const fingerprint = createHash("sha256").update(JSON.stringify({ id, ...command })).digest("hex");
  return { ...command, fingerprint };
}
export function planRetry(job, command, executionSourceRevision) {
  const r = job.result;
  if (r === undefined || r.main.state !== "ready" || !r.main.validated || r.main.sha256 !== command.mainSha256)
    throw new LayerRetryError("retry_not_allowed");
  if (r.attempt !== command.expectedAttempt) throw new LayerRetryError("attempt_conflict");
  if (job.status !== "failed" || Object.values(r.layers).some(asset => ["pending", "running", "unknown"].includes(asset.state)))
    throw new LayerRetryError("retry_not_allowed");
  const failed = asset => ["failed", "timed_out"].includes(asset.state);
  const plan = [];
  if (failed(r.layers.cutout)) plan.push("cutout");
  if (failed(r.layers.plate) || (plan.includes("cutout") && r.layers.plate.state === "blocked")) plan.push("plate");
  if (plan.length === 0 || (!plan.includes("cutout") && r.layers.cutout.state !== "ready"))
    throw new LayerRetryError("retry_not_allowed");
  const attempt = r.attempt + 1;
  job.layerRetries.push({ retryToken: command.retryToken, fingerprint: command.fingerprint, attempt, plan, executionSourceRevision });
  r.attempt = attempt;
  r.retryToken = command.retryToken;
  for (const stage of plan) r.layers[stage] = { state: stage === "plate" && plan.includes("cutout") ? "blocked" : "pending", attempt };
  return plan;
}
export function validateResult(job) {
  if (job.layerRetryReplayCount !== undefined && (!Number.isSafeInteger(job.layerRetryReplayCount) || job.layerRetryReplayCount < 0))
    throw new TypeError("Invalid layer replay count");
  if (job.result === undefined) {
    if (job.layerRetries !== undefined) throw new TypeError("Retry history requires a result manifest");
    return;
  }
  const r = job.result;
  if (r.result_contract !== RESULT_CONTRACT || !Number.isSafeInteger(r.attempt) || r.attempt < 0
    || !r.main || !r.layers || Object.keys(r.layers).length !== 2 || !Array.isArray(job.layerRetries)
    || job.layerRetries.length !== r.attempt) throw new TypeError("Invalid layer result manifest");
  for (const [name, asset] of [["main", r.main], ...Object.entries(r.layers)]) {
    if (!asset || !STATES.has(asset.state) || (name === "main" && (typeof asset.validated !== "boolean" || asset.state === "blocked"))
      || (name !== "main" && (!Number.isSafeInteger(asset.attempt) || asset.attempt < 0 || asset.attempt > r.attempt)))
      throw new TypeError("Invalid asset state");
    if (asset.state === "ready") {
      const suffix = name === "main" ? ".png" : name === "cutout" ? ".cut.png" : ".plate.jpg";
      if (asset.url !== `/art/${job.id}${suffix}` || !HASH.test(asset.sha256) || (name === "main" && !asset.validated))
        throw new TypeError("Ready asset requires validated canonical provenance");
    } else if (asset.url !== undefined || asset.sha256 !== undefined || (name === "main" && asset.validated))
      throw new TypeError("Unready asset cannot publish provenance");
    if (asset.reason !== undefined && !["result_unknown", "stage_timeout", "stage_failed", "asset_unavailable"].includes(asset.reason))
      throw new TypeError("Invalid safe asset reason");
  }
  const tokens = new Set();
  for (const [index, entry] of job.layerRetries.entries()) {
    if (entry.attempt !== index + 1 || !UUID.test(entry.retryToken) || tokens.has(entry.retryToken)
      || !HASH.test(entry.fingerprint) || typeof entry.executionSourceRevision !== "string" || entry.executionSourceRevision.length > 128
      || !Array.isArray(entry.plan) || !["cutout", "plate", "cutout,plate"].includes(entry.plan.join(",")))
      throw new TypeError("Invalid durable retry plan");
    tokens.add(entry.retryToken);
  }
  if (r.attempt === 0 ? r.retryToken !== undefined : r.retryToken !== job.layerRetries.at(-1).retryToken)
    throw new TypeError("Current retry identity must match its durable attempt");
}
