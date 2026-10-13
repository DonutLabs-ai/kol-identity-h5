import { createHash } from "node:crypto";
import { processingDeadlineAt } from "./processing-deadline.mjs";

// Auxiliary proof metadata has its own bound; canonical job records retain 16 KiB.
export const MAX_WITNESS_BYTES = 4096;
const HASH = /^[a-f0-9]{64}$/;
export const digest = value => createHash("sha256").update(value).digest("hex");
const resourceHash = asset => digest(JSON.stringify(asset));
function readyResources(job) {
  if (job.result === undefined) return {};
  return Object.fromEntries([["main", job.result.main], ...Object.entries(job.result.layers)]
    .filter(([, asset]) => asset.state === "ready"));
}
function scope(job) {
  return { jobId: job.id, attempt: job.result?.attempt ?? 0,
    processingDeadlineAt: job.processingDeadlineAt,
    attemptDeadlineAt: new Date(processingDeadlineAt(job)).toISOString() };
}
export function createCheckpointWitness(job, serialized, previous, completedAt, processing, legacy = false) {
  const identity = scope(job), canonicalSha256 = digest(serialized), resources = {};
  for (const [name, asset] of Object.entries(readyResources(job))) {
    const resourceSha256 = resourceHash(asset), old = previous?.resources[name];
    if (old !== undefined) {
      if (old.resourceSha256 !== resourceSha256) throw new TypeError("Qualified resource cannot change");
      resources[name] = old;
    } else if (legacy) resources[name] = { legacy: true, resourceSha256 };
    else {
      if (!processing) throw new TypeError("Bookkeeping cannot qualify a new resource");
      resources[name] = { ...identity, canonicalSha256, resourceSha256,
        qualifiedAt: new Date(completedAt).toISOString() };
    }
  }
  const witness = { version: 1, ...identity, canonicalSha256,
    kind: processing ? "processing" : "bookkeeping",
    qualifiedAt: processing ? new Date(completedAt).toISOString() : null, resources };
  validateCheckpointWitness(witness, job, serialized);
  if (Buffer.byteLength(JSON.stringify(witness) + "\n") > MAX_WITNESS_BYTES)
    throw new TypeError("Checkpoint witness exceeds bounded proof metadata limit");
  return witness;
}
function validateQualification(proof, job, attempt) {
  const admission = attempt === 0 ? job : job.layerRetries?.[attempt - 1];
  if (admission === undefined || proof.jobId !== job.id
    || proof.processingDeadlineAt !== job.processingDeadlineAt
    || proof.attemptDeadlineAt !== admission.processingDeadlineAt
    || typeof proof.qualifiedAt !== "string" || !Number.isFinite(Date.parse(proof.qualifiedAt))
    || new Date(proof.qualifiedAt).toISOString() !== proof.qualifiedAt
    || Date.parse(proof.qualifiedAt) < Date.parse(admission.processingReceivedAt)
    || Date.parse(proof.qualifiedAt) >= Date.parse(admission.processingDeadlineAt)
    || !HASH.test(proof.canonicalSha256)) throw new TypeError("Invalid checkpoint qualification");
}
export function validateCheckpointWitness(witness, job, serialized) {
  if (witness === null || typeof witness !== "object" || witness.version !== 1
    || !["processing", "bookkeeping"].includes(witness.kind)
    || witness.canonicalSha256 !== digest(serialized)
    || JSON.stringify({ jobId: witness.jobId, attempt: witness.attempt,
      processingDeadlineAt: witness.processingDeadlineAt, attemptDeadlineAt: witness.attemptDeadlineAt }) !== JSON.stringify(scope(job))
    || witness.resources === null || typeof witness.resources !== "object" || Array.isArray(witness.resources))
    throw new TypeError("Checkpoint witness does not bind its journal");
  if (witness.kind === "processing") validateQualification(witness, job, witness.attempt);
  else if (witness.qualifiedAt !== null) throw new TypeError("Bookkeeping cannot claim qualification");
  const ready = readyResources(job);
  if (Object.keys(witness.resources).length !== Object.keys(ready).length)
    throw new TypeError("Checkpoint resource witness mismatch");
  for (const [name, asset] of Object.entries(ready)) {
    const proof = witness.resources[name];
    if (proof === null || typeof proof !== "object" || proof.resourceSha256 !== resourceHash(asset))
      throw new TypeError("Checkpoint resource witness mismatch");
    if (proof.legacy === true) {
      if (Object.keys(proof).length !== 2) throw new TypeError("Invalid legacy resource attestation");
    } else {
      const resourceAttempt = name === "main" ? 0 : asset.attempt;
      if (!Number.isSafeInteger(proof.attempt) || proof.attempt < 0 || proof.attempt > (job.result?.attempt ?? 0)
        || proof.attempt !== resourceAttempt)
        throw new TypeError("Invalid checkpoint resource attempt");
      validateQualification(proof, job, proof.attempt);
    }
  }
  return witness;
}

export function validateWitnessTransition(previous, current) {
  for (const [name, proof] of Object.entries(current.resources)) {
    const old = previous.resources[name];
    if (old !== undefined) {
      if (JSON.stringify(old) !== JSON.stringify(proof)) throw new TypeError("Resource qualification cannot change");
    } else if (current.kind !== "processing" || proof.legacy === true
      || proof.attempt !== current.attempt || proof.canonicalSha256 !== current.canonicalSha256
      || proof.qualifiedAt !== current.qualifiedAt) {
      throw new TypeError("New resource lacks its checkpoint completion witness");
    }
  }
}
