import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { Budget } from "./harness/lib.mjs";

export class WorkerBudget extends Budget {
  unknownCostCalls = 0;
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
function failure(code, category, cause) {
  return Object.assign(new Error(code, cause === undefined ? undefined : { cause }), { category });
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
async function boundary(action) {
  try { return await action(); }
  catch (cause) {
    if (cause.category !== undefined) throw cause;
    const unknown = cause.name === "TimeoutError" || cause.name === "AbortError";
    throw failure(unknown ? "provider_result_unknown" : "provider_call_failed",
      unknown ? "provider_result_unknown" : "provider_error", cause);
  }
}

// Same one-call Gemini prompt/model as Cory's harness, with bounded network output.
export function createImageGenerator({ fetcher = fetch } = {}) {
  return async ({ key, model, prompt, avatarPath, refs, budget, beforeDispatch }) => {
    if (refs.length !== 0) throw new TypeError("The deployed fast path has no extra reference images");
    budget.check(0.30);
    const avatar = await readFile(avatarPath);
    const mime = MIME[extname(avatarPath)];
    if (mime === undefined) throw new TypeError("Unsupported prepared avatar extension");
    if (beforeDispatch !== undefined) beforeDispatch();
    const started = Date.now();
    const response = await boundary(() => fetcher("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST", signal: AbortSignal.timeout(540000), headers: {
        Authorization: "Bearer " + key, "Content-Type": "application/json",
        "X-Title": "Donut card-art harness",
      }, body: JSON.stringify({ model, modalities: ["image", "text"], messages: [{ role: "user", content: [
        { type: "text", text: "The profile picture to edit:" },
        { type: "image_url", image_url: { url: `data:${mime};base64,${avatar.toString("base64")}` } },
        { type: "text", text: prompt },
      ] }] }),
    }));
    if (!response.ok) {
      await response.body?.cancel();
      throw failure("provider_http_" + response.status,
        response.status === 429 ? "provider_throttled" : "provider_error");
    }
    const raw = await boundary(() => bytes(response, 32 * 1024 * 1024));
    let result;
    try { result = JSON.parse(raw.toString("utf8")); }
    catch (cause) { throw failure("invalid_provider_json", "invalid_output", cause); }
    // A successful provider response may report usage even when its image is unusable.
    const cost = budget.add(result.usage);
    const url = result.choices?.[0]?.message?.images?.[0]?.image_url?.url;
    if (typeof url !== "string") throw failure("provider_image_missing", "invalid_output");
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
      const download = await boundary(() => fetcher(asset, { redirect: "error", signal: AbortSignal.timeout(30000) }));
      if (!download.ok) { await download.body?.cancel(); throw failure("provider_image_download_failed", "provider_error"); }
      png = await boundary(() => bytes(download, 12 * 1024 * 1024));
    }
    return { png, cost, secs: (Date.now() - started) / 1000 };
  };
}
