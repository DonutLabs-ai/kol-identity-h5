import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { Budget } from "./harness/lib.mjs";

export class WorkerBudget extends Budget {
  unknownCostCalls = 0;
  check(estimate) {
    if (this.spent + estimate > this.cap) throw Object.assign(new Error(`budget cap $${this.cap} reached (spent $${this.spent.toFixed(2)})`), { sampleReason: "budget_not_dispatched" });
  }
  add(usage) {
    this.calls++;
    const value = usage?.cost;
    if ((typeof value !== "number" && typeof value !== "string") || (typeof value === "string" && value.trim() === "")) {
      this.unknownCostCalls++; return null;
    }
    const cost = Number(value);
    if (!Number.isFinite(cost) || cost < 0) { this.unknownCostCalls++; return null; }
    this.spent += cost; return cost;
  }
}

const MIME = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
  ".webp": "image/webp", ".gif": "image/gif" };
function failure(code, category, cause, stage = category === "invalid_output" ? "validation" : "llm") {
  return Object.assign(new Error(code, cause === undefined ? undefined : { cause }), { category, failure_stage: stage });
}
async function bytes(response, maximum) {
  if (!response.body) throw failure("empty_provider_response", "invalid_output");
  const chunks = []; let length = 0;
  for await (const chunk of response.body) {
    length += chunk.length;
    if (length > maximum) throw failure("provider_response_too_large", "invalid_output");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
async function boundary(action, stage = "llm", onFailure) {
  try { return await action(); }
  catch (cause) {
    if (onFailure !== undefined) await onFailure();
    const tagged = cause !== null && typeof cause === "object";
    const unknown = tagged && (cause.name === "TimeoutError" || cause.name === "AbortError");
    const error = tagged && cause.category !== undefined ? cause : failure(unknown ? "provider_result_unknown" : "provider_call_failed",
      unknown ? "provider_result_unknown" : "provider_error", cause, stage);
    if (stage === "validation") Object.assign(error, { sampleOutcome: "asset_error", sampleReason: "asset_download_failed" });
    throw error;
  }
}

// Same one-call Gemini prompt/model as Cory's harness, with bounded network output.
export function createImageGenerator({ fetcher = fetch } = {}) {
  return async ({ key, model, prompt, avatarPath, refs, budget, beforeDispatch, onDispatch, onReceipt }) => {
    if (refs.length !== 0) throw new TypeError("The deployed fast path has no extra reference images");
    budget.check(0.30);
    let avatar;
    try { avatar = await readFile(avatarPath); }
    catch (cause) { throw Object.assign(new Error("prepared_avatar_unavailable", { cause }), { category: "invalid_output", failure_stage: "validation", sampleReason: "input_unavailable" }); }
    const mime = MIME[extname(avatarPath)];
    if (mime === undefined) throw failure("Unsupported prepared avatar extension", "invalid_output");
    if (beforeDispatch !== undefined) beforeDispatch();
    if (onDispatch !== undefined) await onDispatch();
    // A dispatch journal write can wait; recheck foreground immediately before the provider call.
    if (beforeDispatch !== undefined) beforeDispatch();
    const started = Date.now();
    let cost = null;
    const receipt = async () => {
      if (onReceipt !== undefined) await onReceipt({ newProviderRequests: 1, costUSD: cost, reportedSeconds: (Date.now() - started) / 1000 });
    };
    const response = await boundary(() => fetcher("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST", signal: AbortSignal.timeout(540000), headers: {
        Authorization: "Bearer " + key, "Content-Type": "application/json",
        "X-Title": "Donut card-art harness",
      }, body: JSON.stringify({ model, modalities: ["image", "text"], messages: [{ role: "user", content: [
        { type: "text", text: "The profile picture to edit:" },
        { type: "image_url", image_url: { url: `data:${mime};base64,${avatar.toString("base64")}` } },
        { type: "text", text: prompt },
      ] }] }),
    }), "llm", receipt);
    await receipt();
    if (!response.ok) {
      await response.body?.cancel();
      throw failure("provider_http_" + response.status,
        response.status === 429 ? "provider_throttled" : "provider_error");
    }
    const raw = await boundary(() => bytes(response, 32 * 1024 * 1024), "llm", receipt);
    let result;
    try { result = JSON.parse(raw.toString("utf8")); }
    catch (cause) { throw failure("invalid_provider_json", "invalid_output", cause); }
    if (result === null || typeof result !== "object" || Array.isArray(result)) throw failure("invalid_provider_json_shape", "invalid_output");
    // A successful provider response may report usage even when its image is unusable.
    cost = budget.add(result.usage);
    await receipt();
    const url = result.choices?.[0]?.message?.images?.[0]?.image_url?.url;
    if (typeof url !== "string") throw Object.assign(failure("provider_image_missing", "invalid_output"), { sampleOutcome: "no_image", sampleReason: "missing_image" });
    let png;
    if (url.startsWith("data:")) {
      const inline = /^data:image\/\w+;base64,([A-Za-z0-9+/]+={0,2})$/.exec(url);
      if (!inline || inline[1].length > 16 * 1024 * 1024) {
        throw failure("invalid_provider_image", "invalid_output");
      }
      png = Buffer.from(inline[1], "base64");
    } else {
      let asset;
      try { asset = new URL(url); }
      catch (cause) { throw failure("invalid_provider_asset_url", "invalid_output", cause); }
      if (asset.protocol !== "https:" || asset.username !== "" || asset.password !== "") {
        throw failure("invalid_provider_asset_url", "invalid_output");
      }
      const download = await boundary(() => fetcher(asset, { redirect: "error", signal: AbortSignal.timeout(30000) }), "validation", receipt);
      if (!download.ok) { await download.body?.cancel(); throw Object.assign(failure("provider_image_download_failed", "provider_error", undefined, "validation"), { sampleOutcome: "asset_error", sampleReason: "asset_download_failed" }); }
      png = await boundary(() => bytes(download, 12 * 1024 * 1024), "validation");
    }
    const secs = (Date.now() - started) / 1000;
    if (onReceipt !== undefined) await onReceipt({ newProviderRequests: 1, costUSD: cost, reportedSeconds: secs });
    return { png, cost, secs };
  };
}
