import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createImageGenerator, WorkerBudget } from "./openrouter-image.mjs";
import { Budget } from "./harness/lib.mjs";

const avatarPath = new URL("./test-fixtures/main.png", import.meta.url).pathname;
const image = await readFile(avatarPath);
const output = { choices: [{ message: { images: [{ image_url: { url: "data:image/png;base64," + image.toString("base64") } }] } }], usage: { cost: 0.14 } };
const args = () => ({ key: "test-only", model: "google/gemini-3-pro-image", prompt: "Cory's unchanged fast prompt",
  avatarPath, refs: [], budget: new Budget(Infinity) });

test("one paid request preserves Cory's Gemini model, avatar, modalities and prompt", async () => {
  const calls = [];
  const generate = createImageGenerator({ fetcher: async (url, options) => {
    calls.push({ url, options }); return Response.json(output);
  } });
  const input = args();
  const result = await generate(input);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://openrouter.ai/api/v1/chat/completions");
  assert.ok(calls[0].options.signal instanceof AbortSignal);
  assert.deepEqual(JSON.parse(calls[0].options.body), { model: input.model, modalities: ["image", "text"],
    messages: [{ role: "user", content: [{ type: "text", text: "The profile picture to edit:" },
      { type: "image_url", image_url: { url: "data:image/png;base64," + image.toString("base64") } },
      { type: "text", text: input.prompt }] }] });
  assert.deepEqual(result.png, image);
  assert.equal(result.cost, 0.14);
});

test("failed segmenter dispatch gate starts no paid HTTP request after avatar I/O", async () => {
  let calls = 0, gated = 0;
  const generate = createImageGenerator({ fetcher: async () => { calls++; return Response.json(output); } });
  const input = { ...args(), beforeDispatch() {
    gated++; throw Object.assign(new Error("segmenter_unavailable"), { category: "provider_error" });
  } };
  await assert.rejects(generate(input), /segmenter_unavailable/);
  assert.equal(gated, 1); assert.equal(calls, 0); assert.equal(input.budget.spent, 0);
});

test("throttle and ambiguous transport outcome are explicit failures and never automatically retried", async () => {
  for (const [fetcher, category] of [
    [async () => new Response("throttled", { status: 429 }), "provider_throttled"],
    [async () => new Response("rejected", { status: 403 }), "provider_error"],
    [async () => { throw Object.assign(new Error("timeout"), { name: "TimeoutError" }); }, "provider_result_unknown"],
  ]) {
    let calls = 0;
    const generate = createImageGenerator({ fetcher: async (...input) => { calls++; return fetcher(...input); } });
    await assert.rejects(generate(args()), (error) => error.category === category && error.failure_stage === "llm");
    assert.equal(calls, 1);
  }
});

test("malformed provider output fails instead of publishing an empty image", async () => {
  for (const response of [() => new Response("invalid-json"), () => Response.json({}),
    () => Response.json({ choices: [{ message: { images: [{ image_url: { url: "data:image/png;base64,bad!" } }] } }] })]) {
    await assert.rejects(createImageGenerator({ fetcher: async () => response() })(args()),
      (error) => error.category === "invalid_output" && error.failure_stage === "validation");
  }
});

test("known provider cost is recorded even when the returned image is missing", async () => {
  const input = args();
  const generate = createImageGenerator({ fetcher: async () => Response.json({ usage: { cost: 0.14 }, choices: [] }) });
  for (let i = 0; i < 5; i++) await assert.rejects(generate(input), /provider_image_missing/);
  assert.ok(Math.abs(input.budget.spent - 0.7) < 1e-10);
  assert.equal(input.budget.calls, 5);
});

test("missing or malformed provider usage remains explicitly unknown rather than a zero charge", () => {
  const budget = new WorkerBudget(Infinity);
  for (const usage of [undefined, {}, { cost: "" }, { cost: -1 }, { cost: "not-a-number" }]) {
    assert.equal(budget.add(usage), null);
  }
  assert.equal(budget.unknownCostCalls, 5);
  assert.equal(budget.add({ cost: 0 }), 0);
  assert.equal(budget.add({ cost: "0.14" }), 0.14);
  assert.equal(budget.spent, 0.14);
  assert.equal(budget.calls, 7);
});

test("remote provider assets use HTTPS, no redirect and a separate abort deadline", async () => {
  const requests = [];
  const generate = createImageGenerator({ fetcher: async (url, options) => {
    requests.push({ url: String(url), options });
    return requests.length === 1 ? Response.json({ choices: [{ message: { images: [{ image_url: { url: "https://example.com/provider.png" } }] } }] }) : new Response(image);
  } });
  assert.deepEqual((await generate(args())).png, image);
  assert.equal(requests[1].options.redirect, "error");
  assert.ok(requests[1].options.signal instanceof AbortSignal);
  for (const url of ["http://example.com/image.png", "not-url", "https://user:password@example.com/image.png"]) {
    let calls = 0;
    const fetcher = async () => { calls++; return Response.json({ choices: [{ message: { images: [{ image_url: { url } }] } }] }); };
    await assert.rejects(createImageGenerator({ fetcher })(args()), (error) => error.category === "invalid_output");
    assert.equal(calls, 1);
  }
});

test("provider response size is bounded while reading, and zero budget starts no network request", async () => {
  const chunks = new ReadableStream({ start(controller) {
    controller.enqueue(new Uint8Array(17 * 1024 * 1024));
    controller.enqueue(new Uint8Array(17 * 1024 * 1024)); controller.close();
  } });
  await assert.rejects(createImageGenerator({ fetcher: async () => new Response(chunks) })(args()), /provider_response_too_large/);
  let calls = 0;
  const generate = createImageGenerator({ fetcher: async () => { calls++; return Response.json(output); } });
  await assert.rejects(generate({ ...args(), budget: new Budget(0) }), /budget cap/);
  assert.equal(calls, 0);
});

test("successful LLM response followed by failed asset download never has llm failure provenance", async () => {
  for (const assetResponse of [
    async () => new Response("unavailable", { status: 503 }),
    async () => { throw Object.assign(new Error("asset timeout"), { name: "TimeoutError" }); },
  ]) {
    let calls = 0;
    const generate = createImageGenerator({ fetcher: async () => {
      calls++;
      if (calls === 1) return Response.json({ choices: [{ message: { images: [{ image_url: {
        url: "https://example.com/provider.png",
      } }] } }] });
      return assetResponse();
    } });
    await assert.rejects(generate(args()), error => error.failure_stage === "validation");
    assert.equal(calls, 2);
  }
});

test("prepared avatar I/O failure is validation and starts no LLM request", async () => {
  let calls = 0;
  const generate = createImageGenerator({ fetcher: async () => { calls++; return Response.json(output); } });
  await assert.rejects(generate({ ...args(), avatarPath: avatarPath + ".missing" }),
    error => error.failure_stage === "validation");
  assert.equal(calls, 0);
});
