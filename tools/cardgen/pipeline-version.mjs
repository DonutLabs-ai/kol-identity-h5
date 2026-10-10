import { createHash } from "node:crypto";

export const IMAGE_MODEL = "google/gemini-3-pro-image";
export const PIPELINE_VERSION = "DONUT_CARD_ART_THREE_LAYER_V1";
// Enforced by the resident Python worker before opening the IS-Net session.
export const ISNET_REVISION =
  "sha256:60920e99c45464f2ba57bee2ad08c919a52bbf852739e96947fbb4358c0d964a";

export function pipelineDescriptor(config) {
  return Object.freeze({
    imageModel: IMAGE_MODEL,
    pipelineVersion: PIPELINE_VERSION,
    cutoutProvider: config.cutoutProvider,
    cutoutModel: config.cutoutModel,
    cutoutRevision:
      config.cutoutProvider === "isnet" ? ISNET_REVISION : config.bedrockModel,
    sourceRevision:
      config.sourceRevision === undefined
        ? "unversioned"
        : config.sourceRevision,
  });
}

export class InvalidRequestKeyError extends Error {
  constructor() {
    super("Invalid requestKey UUID");
    this.name = "InvalidRequestKeyError";
  }
}
export class RequestKeyConflictError extends Error {
  constructor() {
    super("Immutable admission input conflicts with requestKey");
    this.name = "RequestKeyConflictError";
  }
}
export function normalizeRequestKey(value) {
  if (
    typeof value !== "string" ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(
      value,
    )
  )
    throw new InvalidRequestKeyError();
  return value.toLowerCase();
}
export function requestKeyOf(job) {
  const payload = job.payload;
  if (
    payload !== null &&
    typeof payload === "object" &&
    !Array.isArray(payload) &&
    Object.hasOwn(payload, "requestKey")
  )
    return normalizeRequestKey(payload.requestKey);
  return undefined;
}
export function cardArtId(bytes, type, promptVersion, version, requestKey) {
  const avatarHash = createHash("sha256").update(bytes).digest("hex");
  const identity = [
    avatarHash,
    type,
    promptVersion,
    version.imageModel,
    version.pipelineVersion,
    version.cutoutProvider,
    version.cutoutModel,
    version.cutoutRevision,
    version.sourceRevision,
    requestKey === undefined ? null : normalizeRequestKey(requestKey),
  ];
  return createHash("sha256")
    .update(JSON.stringify(identity))
    .digest("hex")
    .slice(0, 24);
}

export function publicPipeline(payload) {
  return {
    image_model: payload.imageModel,
    pipeline_version: payload.pipelineVersion,
    cutout_provider: payload.cutoutProvider,
    cutout_model: payload.cutoutModel,
    cutout_revision: payload.cutoutRevision,
    source_revision: payload.sourceRevision,
  };
}

const CONTRACT_FIELDS = [
  "imageModel",
  "pipelineVersion",
  "cutoutProvider",
  "cutoutModel",
  "cutoutRevision",
  "sourceRevision",
];
export class InvalidWorkerContractError extends Error {
  constructor() {
    super("Invalid expectedContract");
    this.name = "InvalidWorkerContractError";
  }
}
export class WorkerContractChangedError extends Error {
  constructor() {
    super("Worker contract changed");
    this.name = "WorkerContractChangedError";
  }
}
function validContract(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== CONTRACT_FIELDS.length ||
    !CONTRACT_FIELDS.every(
      (field) =>
        Object.hasOwn(value, field) &&
        typeof value[field] === "string" &&
        value[field].length > 0 &&
        value[field].length <= 128,
    )
  )
    return false;
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.pipelineVersion) ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.sourceRevision)
  )
    return false;
  if (value.cutoutProvider === "isnet")
    return /^sha256:[a-f0-9]{64}$/.test(value.cutoutRevision);
  return value.cutoutProvider === "bedrock";
}
export function expectedWorkerContract(value) {
  if (!validContract(value)) throw new InvalidWorkerContractError();
  return Object.freeze({
    imageModel: value.imageModel,
    pipelineVersion: value.pipelineVersion,
    cutoutProvider: value.cutoutProvider,
    cutoutModel: value.cutoutModel,
    cutoutRevision: value.cutoutRevision,
    sourceRevision: value.sourceRevision,
  });
}
export function workerContractOf(payload) {
  const contract = {
    imageModel: payload.imageModel,
    pipelineVersion: payload.pipelineVersion,
    cutoutProvider: payload.cutoutProvider,
    cutoutModel: payload.cutoutModel,
    cutoutRevision: payload.cutoutRevision,
    sourceRevision: payload.sourceRevision,
  };
  return validContract(contract) ? Object.freeze(contract) : undefined;
}
export function requireExpectedContract(value, actual) {
  const expected = expectedWorkerContract(value);
  if (!CONTRACT_FIELDS.every((field) => expected[field] === actual[field]))
    throw new WorkerContractChangedError();
}
