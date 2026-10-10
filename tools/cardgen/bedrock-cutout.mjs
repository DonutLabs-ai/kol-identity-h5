import { BedrockRuntimeClient, InvokeModelCommand, BedrockRuntimeServiceException } from "@aws-sdk/client-bedrock-runtime";
import { fromTokenFile } from "@aws-sdk/credential-provider-web-identity";
import { readFile, open, rename } from "node:fs/promises";
import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createSerialTaskQueue } from "./serial-task-queue.mjs";
import { JobStoreError } from "./job-queue.mjs";

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
function providerError(code, category, cause) {
  return Object.assign(new Error(code, cause === undefined ? undefined : { cause }), { category });
}

export function pngInfo(bytes) {
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE) ||
      bytes.subarray(12, 16).toString("ascii") !== "IHDR") {
    throw providerError("invalid_png", "invalid_output");
  }
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  if (width < 64 || height < 64 || width * height > 9437184 ||
      width / height < 0.4 || width / height > 2.5) {
    throw providerError("unsupported_image_dimensions", "invalid_output");
  }
  return { width, height, colorType: bytes[25] };
}

function decodeResponse(body, input) {
  let response;
  try { response = JSON.parse(new TextDecoder().decode(body)); }
  catch (cause) { throw providerError("invalid_bedrock_response_json", "invalid_output", cause); }
  if (!response || !Array.isArray(response.images) || response.images.length !== 1 ||
      typeof response.images[0] !== "string" || !Array.isArray(response.finish_reasons) ||
      response.finish_reasons.length !== 1 || response.finish_reasons[0] !== null) {
    throw providerError("bedrock_cutout_rejected", "provider_rejected");
  }
  const encoded = response.images[0];
  if (encoded.length > 32 * 1024 * 1024 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    throw providerError("invalid_bedrock_image_encoding", "invalid_output");
  }
  const output = Buffer.from(encoded, "base64");
  const info = pngInfo(output);
  if (info.width !== input.width || info.height !== input.height || info.colorType !== 6) {
    throw providerError("invalid_bedrock_cutout_dimensions_or_alpha", "invalid_output");
  }
  return output;
}

// Persist spacing across restarts. This scheduler belongs to the single PVC-backed worker;
// horizontal replicas require a shared limiter before they can be enabled.
export function createWorkloadBedrockClient({ region, credentialRegion = "ap-southeast-2", credentialRequestHandler }) {
  return new BedrockRuntimeClient({ region, maxAttempts: 1,
    credentials: fromTokenFile({ clientConfig: { region: credentialRegion,
      maxAttempts: 1, requestHandler: credentialRequestHandler } }),
  });
}

export function createBedrockCutout({ region, model, minIntervalMs, timeoutMs, stateFile,
  credentialRegion = "ap-southeast-2",
  client = createWorkloadBedrockClient({ region, credentialRegion }), now = Date.now, sleep = delay }) {
  const enqueue = createSerialTaskQueue();
  let initialized = false, lastStarted = 0;
  async function initialize() {
    if (initialized) return;
    let content;
    try { content = await readFile(stateFile, "utf8"); }
    catch (error) { if (error.code !== "ENOENT") throw new JobStoreError("Cannot read Bedrock scheduler state", error); }
    if (content !== undefined) {
      let state;
      try { state = JSON.parse(content); }
      catch (cause) { throw new JobStoreError("Invalid Bedrock scheduler state JSON", cause); }
      if (!state || !Number.isFinite(state.lastStarted) || state.lastStarted < 0 ||
          (state.pending !== undefined && typeof state.pending !== "boolean")) {
        throw new JobStoreError("Invalid Bedrock scheduler state");
      }
      // A crash after reservation may have occurred just before the actual send.
      // Wait a full interval from recovery rather than trusting an earlier timestamp.
      lastStarted = state.pending ? Math.max(state.lastStarted, now()) : state.lastStarted;
    }
    initialized = true;
  }
  async function persist(pending) {
    try {
      const temporary = stateFile + ".tmp";
      const handle = await open(temporary, "w", 0o600);
      try { await handle.writeFile(JSON.stringify({ lastStarted, pending })); await handle.sync(); }
      finally { await handle.close(); }
      await rename(temporary, stateFile);
      const directory = await open(dirname(stateFile), "r");
      try { await directory.sync(); }
      finally { await directory.close(); }
    } catch (cause) { throw new JobStoreError("Cannot persist Bedrock pacing; dispatch stopped", cause); }
  }
  const cutout = async (image, checkpoint = async () => {}, observation = {}) => enqueue(async () => {
    const input = pngInfo(image);
    if (image.length > 12 * 1024 * 1024) throw providerError("cutout_input_too_large", "invalid_output");
    await initialize();
    await checkpoint();
    const wait = lastStarted + minIntervalMs - now();
    if (wait > 0) await sleep(wait);
    await persist(true);
    const command = new InvokeModelCommand({
      modelId: model, contentType: "application/json", accept: "application/json",
      body: JSON.stringify({ image: image.toString("base64"), output_format: "png" }),
    });
    if (observation.onDispatch !== undefined) await observation.onDispatch();
    // No asynchronous work between this timestamp and SDK dispatch.
    lastStarted = now();
    const started = lastStarted;
    let response;
    try {
      response = await client.send(command, { abortSignal: AbortSignal.timeout(timeoutMs) });
    } catch (cause) {
      const responseStatus = cause instanceof BedrockRuntimeServiceException
        && cause.$metadata !== undefined && cause.$metadata !== null ? cause.$metadata.httpStatusCode : undefined;
      const authoritative = Number.isInteger(responseStatus) && responseStatus >= 400 && responseStatus <= 599;
      if (authoritative && observation.onReceipt !== undefined)
        await observation.onReceipt({ newProviderRequests: 1, costUSD: null, reportedSeconds: (now() - started) / 1000 });
      lastStarted = now(); // Preserve spacing after both confirmed and uncertain attempts.
      const code = !authoritative ? "bedrock_result_unknown" : cause.name === "ThrottlingException" ? "bedrock_throttled" :
        cause.name === "ModelTimeoutException" ? "bedrock_stage_timeout" : "bedrock_call_failed";
      const category = code === "bedrock_throttled" ? "provider_throttled" :
        code === "bedrock_result_unknown" ? "provider_result_unknown" : code === "bedrock_stage_timeout" ? "provider_timeout" : "provider_error";
      await persist(false);
      throw providerError(code, category, cause);
    }
    if (observation.onReceipt !== undefined) await observation.onReceipt({ newProviderRequests: 1, costUSD: null, reportedSeconds: (now() - started) / 1000 });
    lastStarted = now();
    await persist(false);
    const png = decodeResponse(response.body, input);
    const seconds = (now() - started) / 1000;
    if (observation.onReceipt !== undefined) await observation.onReceipt({ newProviderRequests: 1, costUSD: null, reportedSeconds: seconds });
    return { png, requestId: response.$metadata.requestId, seconds };
  });
  cutout.initialize = initialize;
  return cutout;
}
