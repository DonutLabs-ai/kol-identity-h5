import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import { performance } from "node:perf_hooks";
import { mkdir, mkdtemp, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createCardArtService } from "./card-art-service.mjs";
import { createBedrockCutout } from "./bedrock-cutout.mjs";
import { JobStoreError } from "./job-queue.mjs";
import { readServerConfig } from "./server-config.mjs";
import { TYPES } from "./harness/lib.mjs";
import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";

const TOKEN = "offline-service-test-token";
const MAIN = await readFile(new URL("./test-fixtures/main.png", import.meta.url));
const CUT = await readFile(new URL("./test-fixtures/cut.png", import.meta.url));
// A 64x64 JPEG made from main.png, embedded so tests need no image library or subprocess.
const PLATE = Buffer.from("/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCABAAEADASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAGQEBAAMBAQAAAAAAAAAAAAAAAAIDBQYE/8QAGREBAAIDAAAAAAAAAAAAAAAAABIVYqHh/9oADAMBAAIRAxEAPwCYgNl7AWUQkw7rDfEaFlCRdYb4jQCbcAAWUBU4YABGgFruQAFlAVOGAARoBa7kABZRGhCLDpc9dWURoIlLnroAm3H/2Q==", "base64");
const AVATAR = "data:image/png;base64," + MAIN.toString("base64");

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function fixture(t) {
  const cache = await mkdtemp(join(tmpdir(), "cardgen-http-"));
  const services = [], gates = [];
  const counts = { gemini: 0, cutout: 0, plate: 0, checkpoints: 0 };
  const plateFinished = deferred(), geminiStarted = deferred(), cutoutStarted = deferred();
  async function stop(service) {
    if (service.server.listening) {
      await new Promise((resolve) => { service.server.close(resolve); service.server.closeAllConnections(); });
    }
    await service.queue.close();
  }
  t.after(async () => {
    gates.forEach((gate) => gate.resolve());
    await Promise.all(services.map(stop));
    await rm(cache, { recursive: true, force: true });
  });
  const f = {
    cache, counts, plateFinished, geminiStarted, cutoutStarted, stop,
    gate() { const gate = deferred(); gates.push(gate); return gate; },
    async start(overrides = {}, env = {}) {
      const config = readServerConfig({ CARD_AUTH_TOKEN: TOKEN, CARD_REQUIRE_AUTH: "true", ...env });
      const { prompts = { version: "http-test-v1", types: Object.fromEntries(TYPES.map((type) => [type, "Hold a telescope."])) },
        diskInfo = async () => ({ bavail: 100 * 1024 ** 3, bsize: 1 }) } = overrides;
      const service = await createCardArtService({
        config, cache, apiKey: "offline-only-never-sent",
        prompts, diskInfo,
        async validateMain(source) {
          if (overrides.validateMain !== undefined) await overrides.validateMain(source);
        },
        logger: { log() {}, error() {} },
        async generate(options) {
          counts.gemini++; geminiStarted.resolve();
          if (overrides.generate) return overrides.generate(options);
          return { png: MAIN, cost: 0, secs: 0 };
        },
        cutout: overrides.useDefaultCutout ? undefined : async (image, checkpoint) => {
          await checkpoint(); counts.checkpoints++; counts.cutout++; cutoutStarted.resolve();
          if (overrides.cutout) return overrides.cutout(image, checkpoint);
          return { png: CUT, requestId: "offline-request", seconds: 0 };
        },
        async makePlate(source, cut, target) {
          counts.plate++;
          const quality = overrides.makePlate ? await overrides.makePlate(source, cut, target)
            : (await writeFile(target, PLATE), { coverage: 0.3 });
          plateFinished.resolve(); return quality;
        },
      });
      services.push(service);
      service.server.listen(0, "127.0.0.1"); await once(service.server, "listening");
      const base = `http://127.0.0.1:${service.server.address().port}`;
      return { ...service, config, base };
    },
  };
  return f;
}

async function request(service, path, options = {}) {
  const response = await fetch(service.base + path, {
    ...options, headers: { Authorization: "Bearer " + TOKEN, ...options.headers },
  });
  return { status: response.status, body: await response.json() };
}
const post = (service, body = { type: "sniper", avatar_data: AVATAR }) => request(service, "/v1/identity/card-art", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});
const poll = (service, id) => request(service, "/v1/identity/card-art/" + id);
function noUrls(body) {
  for (const field of ["image_url", "cutout_url", "plate_url"]) assert.equal(Object.hasOwn(body, field), false, field);
}
async function completed(f, service) {
  const admitted = await post(service);
  assert.equal(admitted.status, 202);
  await f.plateFinished.promise;
  await service.queue.close();
  const done = await poll(service, admitted.body.job_id);
  assert.equal(done.body.status, "done");
  return done.body;
}

test("output_missing on GET and duplicate POST never exposes URLs or regenerates", async (t) => {
  for (const suffix of [".png", ".cut.png", ".plate.jpg"]) {
    await t.test(suffix, async (sub) => {
      const f = await fixture(sub), service = await f.start();
      const done = await completed(f, service);
      await unlink(join(f.cache, done.job_id + suffix));
      const missing = await poll(service, done.job_id);
      assert.equal(missing.body.status, "failed");
      assert.equal(missing.body.error, "output_missing"); noUrls(missing.body);
      const duplicate = await post(service);
      assert.equal(duplicate.body.status, "failed", "Duplicate POST must recheck cached output files");
      assert.equal(duplicate.body.error, "output_missing"); noUrls(duplicate.body);
      assert.deepEqual(f.counts, { gemini: 1, cutout: 1, plate: 1, checkpoints: 1 });
    });
  }
});

test("non-image avatar bytes are rejected before any generation", async (t) => {
  const f = await fixture(t), service = await f.start();
  const response = await post(service, { type: "sniper", avatar_data: "data:image/png;base64," + Buffer.from("not an image").toString("base64") });
  assert.equal(response.status, 400);
  assert.equal(f.counts.gemini, 0);
});

test("64 concurrent duplicate POSTs dispatch one generator, checkpointed cutout and plate", async (t) => {
  const f = await fixture(t), gate = f.gate();
  const service = await f.start({ generate: async () => { await gate.promise; return { png: MAIN, cost: 0, secs: 0 }; } });
  const responses = await Promise.all(Array.from({ length: 64 }, () => post(service)));
  assert.equal(new Set(responses.map((response) => response.body.job_id)).size, 1);
  for (const response of responses) { assert.equal(response.status, 202); noUrls(response.body); }
  assert.equal(responses.filter((response) => !response.body.cached).length, 1);
  await f.geminiStarted.promise;
  assert.deepEqual(f.counts, { gemini: 1, cutout: 0, plate: 0, checkpoints: 0 });
  gate.resolve(); await f.plateFinished.promise; await service.queue.close();
  const done = await poll(service, responses[0].body.job_id);
  assert.equal(done.body.status, "done");
  assert.deepEqual(f.counts, { gemini: 1, cutout: 1, plate: 1, checkpoints: 1 });
});

test("held cutout stays running across the old 15-second grace, with no premature URLs", async (t) => {
  const f = await fixture(t), gate = f.gate();
  const service = await f.start({ cutout: async () => { await gate.promise; return { png: CUT, requestId: "held", seconds: 0 }; } });
  const admitted = await post(service); await f.cutoutStarted.promise;
  const before = await poll(service, admitted.body.job_id);
  assert.equal(before.body.status, "running"); assert.equal(before.body.stage, "bedrock"); noUrls(before.body);
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  t.mock.timers.tick(16000);
  const after = await poll(service, admitted.body.job_id);
  assert.equal(after.body.status, "running"); assert.equal(after.body.stage, "bedrock"); noUrls(after.body);
  t.mock.timers.reset();
  gate.resolve(); await f.plateFinished.promise; await service.queue.close();
  assert.equal((await poll(service, admitted.body.job_id)).body.status, "done");
});

test("actual paid-dispatch spacing includes a delayed durable checkpoint", async (t) => {
  const f = await fixture(t), twoCalls = deferred(), starts = [];
  let clock = 100000;
  const cutout = createBedrockCutout({ region: "us-west-2", model: "offline-mock", minIntervalMs: 3100,
    timeoutMs: 90000, stateFile: join(f.cache, ".mock-bedrock-rate.json"), now: () => clock,
    sleep: async (duration) => { clock += duration; },
    client: { async send() {
      assert.equal(JSON.parse(await readFile(join(f.cache, ".mock-bedrock-rate.json"), "utf8")).pending, true,
        "Pending reservation must be durable before paid dispatch");
      starts.push(clock); if (starts.length === 2) twoCalls.resolve();
      return { body: Buffer.from(JSON.stringify({ images: [CUT.toString("base64")], finish_reasons: [null] })),
        $metadata: { requestId: "offline-spacing" } };
    } },
  });
  const service = await f.start({ cutout: (image, checkpoint) => cutout(image, async () => {
    await checkpoint();
    // Deterministic ten-second journal delay before the FIRST paid dispatch.
    if (starts.length === 0) clock += 10000;
  }) });
  assert.equal((await post(service)).status, 202);
  assert.equal((await post(service, { type: "hodler", avatar_data: AVATAR })).status, 202);
  await twoCalls.promise; await service.queue.close();
  assert.ok(starts[1] - starts[0] >= 3100, `Actual paid calls started ${starts[1] - starts[0]} ms apart`);
  assert.deepEqual(JSON.parse(await readFile(join(f.cache, ".mock-bedrock-rate.json"), "utf8")),
    { lastStarted: starts[1], pending: false });
});

test("pending dispatch recovered after restart waits a full interval before another paid call", async (t) => {
  const f = await fixture(t), path = join(f.cache, ".mock-bedrock-rate.json"), starts = [];
  let clock = 100000;
  await writeFile(path, JSON.stringify({ lastStarted: clock - 10000, pending: true }));
  const cutout = createBedrockCutout({ region: "us-west-2", model: "offline-mock", minIntervalMs: 3100,
    timeoutMs: 90000, stateFile: path, now: () => clock, sleep: async (duration) => { clock += duration; },
    client: { async send() {
      assert.equal(JSON.parse(await readFile(path, "utf8")).pending, true);
      starts.push(clock);
      return { body: Buffer.from(JSON.stringify({ images: [CUT.toString("base64")], finish_reasons: [null] })),
        $metadata: { requestId: "offline-recovery" } };
    } },
  });
  const service = await f.start({ cutout: (image, checkpoint) => cutout(image, checkpoint) });
  const done = await completed(f, service);
  assert.equal(done.status, "done"); assert.deepEqual(starts, [103100]);
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { lastStarted: 103100, pending: false });
});

test("real SDK credential delay cannot compress HTTP dispatches or exceed 20 in rolling 60 seconds", async (t) => {
  const f = await fixture(t), allCalls = deferred(), starts = [], path = join(f.cache, ".sdk-mock-rate.json");
  let clock = 100000, credentialCalls = 0;
  const client = new BedrockRuntimeClient({ region: "us-west-2", maxAttempts: 1,
    credentials: async () => {
      await Promise.resolve();
      if (credentialCalls++ === 0) clock += 10000;
      return { accessKeyId: "offline-test-access-key", secretAccessKey: "offline-test-secret-key" };
    },
    requestHandler: { async handle(request) {
      assert.equal(request.method, "POST"); assert.match(request.hostname, /us-west-2/);
      assert.equal(JSON.parse(await readFile(path, "utf8")).pending, true);
      starts.push(clock); clock++;
      if (starts.length === 21) allCalls.resolve({});
      return { response: { statusCode: 200, headers: { "content-type": "application/json",
        "x-amzn-requestid": "offline-sdk-" + starts.length },
        body: Buffer.from(JSON.stringify({ images: [CUT.toString("base64")], finish_reasons: [null] })) } };
    } },
  });
  t.after(() => client.destroy());
  const cutout = createBedrockCutout({ region: "us-west-2", model: "us.stability.stable-image-remove-background-v1:0",
    minIntervalMs: 3100, timeoutMs: 90000, stateFile: path, client, now: () => clock,
    sleep: async (duration) => { clock += duration; } });
  const service = await f.start({ cutout: async (image, checkpoint) => {
    try { return await cutout(image, checkpoint); }
    catch (error) { allCalls.resolve({ error }); throw error; }
  } });
  const bodies = TYPES.filter((type) => type !== "unresolved").flatMap((type) => [
    { type, avatar_data: AVATAR }, { type, avatar_data: "data:image/png;base64," + CUT.toString("base64") },
  ]).slice(0, 21);
  assert.equal(bodies.length, 21);
  const admissions = await Promise.all(bodies.map((body) => post(service, body)));
  for (const response of admissions) assert.ok([200, 202].includes(response.status));
  assert.equal(new Set(admissions.map((response) => response.body.job_id)).size, 21);
  const outcome = await allCalls.promise; assert.equal(outcome.error, undefined);
  await service.queue.close();
  assert.equal(starts.length, 21); assert.ok(credentialCalls >= 1); assert.ok(starts[0] >= 110000);
  for (let index = 1; index < starts.length; index++) assert.ok(starts[index] - starts[index - 1] >= 3100);
  const rolling = starts.map((start) => starts.filter((time) => time >= start && time < start + 60000).length);
  assert.ok(Math.max(...rolling) <= 20);
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { lastStarted: starts.at(-1) + 1, pending: false });
  for (const response of admissions) assert.equal(service.queue.get(response.body.job_id).status, "done");
  assert.deepEqual(f.counts, { gemini: 21, cutout: 21, plate: 21, checkpoints: 21 });
  t.diagnostic(`Fake HTTP handlers: 21, first gap ${starts[1] - starts[0]} ms, max rolling-minute starts ${Math.max(...rolling)}; zero AWS calls`);
});

test("full PNG validation failure stops before cutout and preserves failure without Gemini fallback", async (t) => {
  const f = await fixture(t), entered = f.gate(), release = f.gate(), malformed = MAIN.subarray(0, 33);
  let validations = 0;
  const service = await f.start({ generate: async () => ({ png: malformed, cost: 0, secs: 0 }),
    validateMain: async (source) => {
      validations++; assert.deepEqual(await readFile(source), malformed); entered.resolve(); await release.promise;
      throw Object.assign(new Error("injected_full_png_decode_failed"), { category: "invalid_output" });
    },
  });
  const admitted = await post(service); await entered.promise;
  const pending = await poll(service, admitted.body.job_id);
  assert.equal(pending.body.status, "running"); assert.equal(pending.body.stage, "image_ready"); noUrls(pending.body);
  release.resolve(); await service.queue.close();
  for (const response of [await poll(service, admitted.body.job_id), await post(service)]) {
    assert.equal(response.body.status, "failed"); assert.equal(response.body.error, "invalid_output");
    assert.equal(response.body.stage, "image_ready"); noUrls(response.body);
  }
  assert.equal(validations, 1); assert.deepEqual(f.counts, { gemini: 1, cutout: 0, plate: 0, checkpoints: 0 });
});

test("corrupt default pacing state fails startup before queued Gemini recovery", async (t) => {
  const f = await fixture(t), id = "a".repeat(24), jobs = join(f.cache, "jobs");
  const avatarPath = join(f.cache, id + ".avatar.png"), createdAt = new Date().toISOString();
  await mkdir(jobs); await writeFile(avatarPath, MAIN);
  const queued = JSON.stringify({ id, payload: { type: "sniper", avatarPath, promptVersion: "http-test-v1",
    prompt: "Immutable queued test prompt", imageModel: "google/gemini-3-pro-image",
    cutoutModel: "us.stability.stable-image-remove-background-v1:0" }, status: "queued", stage: "queued",
    sequence: 1, createdAt, updatedAt: createdAt });
  const jobPath = join(jobs, id + ".json"); await writeFile(jobPath, queued);
  let unexpectedDispatch = 0;
  // Protect this startup regression against accidental real SDK/network dispatch even if it fails.
  t.mock.method(BedrockRuntimeClient.prototype, "send", async () => {
    unexpectedDispatch++; throw new Error("Unexpected default provider dispatch");
  });
  for (const state of ["bad-json", '{"lastStarted":-1}', '{"lastStarted":100000,"pending":"true"}']) {
    await writeFile(join(f.cache, ".bedrock-rate.json"), state);
    await assert.rejects(f.start({ useDefaultCutout: true }), (error) => {
      assert.ok(error instanceof JobStoreError); assert.match(error.message, /Invalid Bedrock scheduler state/); return true;
    });
    assert.equal(f.counts.gemini, 0); assert.equal(unexpectedDispatch, 0);
    assert.equal(await readFile(jobPath, "utf8"), queued, "Startup failure must leave the queued job unstarted");
  }
});

test("done exposes three authenticated, usable asset files and survives service restart", async (t) => {
  const f = await fixture(t), first = await f.start(), done = await completed(f, first);
  for (const [field, bytes, mime] of [["image_url", MAIN, "image/png"], ["cutout_url", CUT, "image/png"], ["plate_url", PLATE, "image/jpeg"]]) {
    const unauthorized = await fetch(first.base + done[field]); assert.equal(unauthorized.status, 401); await unauthorized.arrayBuffer();
    const asset = await fetch(first.base + done[field], { headers: { Authorization: "Bearer " + TOKEN } });
    assert.equal(asset.status, 200); assert.equal(asset.headers.get("content-type"), mime);
    assert.match(asset.headers.get("cache-control"), /^private,/);
    assert.deepEqual(Buffer.from(await asset.arrayBuffer()), bytes);
  }
  await f.stop(first);
  const restarted = await f.start();
  assert.deepEqual((await poll(restarted, done.job_id)).body, done);
  const duplicate = await post(restarted);
  assert.equal(duplicate.status, 200); assert.equal(duplicate.body.cached, true); assert.equal(duplicate.body.status, "done");
  assert.deepEqual(f.counts, { gemini: 1, cutout: 1, plate: 1, checkpoints: 1 });
});

test("provider failure preserves a safe terminal category, hides URLs and does not regenerate", async (t) => {
  const f = await fixture(t);
  const service = await f.start({ cutout: async () => { throw Object.assign(new Error("private avatar and provider response"), { category: "provider_timeout" }); } });
  const admitted = await post(service); await f.cutoutStarted.promise; await service.queue.close();
  for (const response of [await poll(service, admitted.body.job_id), await post(service)]) {
    assert.equal(response.body.status, "failed"); assert.equal(response.body.error, "provider_timeout"); noUrls(response.body);
    assert.doesNotMatch(JSON.stringify(response.body), /private avatar/);
  }
  assert.deepEqual(f.counts, { gemini: 1, cutout: 1, plate: 0, checkpoints: 1 });
});

test("missing plate after a successful mock callback cannot produce done", async (t) => {
  const f = await fixture(t), service = await f.start({ makePlate: async () => ({ coverage: 0.3 }) });
  const admitted = await post(service); await f.plateFinished.promise; await service.queue.close();
  const response = await poll(service, admitted.body.job_id);
  assert.equal(response.body.status, "failed"); assert.equal(response.body.error, "invalid_output"); noUrls(response.body);
});

test("POST responses read the committed snapshot rather than an uncommitted submit result", async (t) => {
  const f = await fixture(t), gate = f.gate();
  const service = await f.start({ generate: async () => { await gate.promise; return { png: MAIN, cost: 0, secs: 0 }; } });
  const submit = service.queue.submit.bind(service.queue);
  // Model a terminal in-memory mutation while its atomic journal commit is still pending.
  t.mock.method(service.queue, "submit", async (...args) => {
    const result = await submit(...args);
    return { ...result, job: { ...result.job, status: "done", stage: "complete",
      image_url: `/art/${result.job.id}.png`, cutout_url: `/art/${result.job.id}.cut.png`, plate_url: `/art/${result.job.id}.plate.jpg` } };
  });
  const admitted = await post(service);
  assert.equal(admitted.status, 202); assert.notEqual(admitted.body.status, "done"); noUrls(admitted.body);
  assert.notEqual(service.queue.get(admitted.body.job_id).status, "done");
});

test("malformed JSON, unsupported type and invalid avatar input do not dispatch", async (t) => {
  const f = await fixture(t), service = await f.start();
  for (const body of ["{", "null", "[]"]) {
    assert.equal((await request(service, "/v1/identity/card-art", { method: "POST", body })).status, 400);
  }
  for (const body of [
    { type: "Sniper", avatar_data: AVATAR }, { type: "unresolved", avatar_data: AVATAR },
    { type: "not-a-type", avatar_data: AVATAR }, { type: "sniper" },
    { type: "sniper", avatar_data: "bad!base64" }, { type: "sniper", avatar_data: "" },
  ]) assert.equal((await post(service, body)).status, 400);
  assert.equal(f.counts.gemini, 0);
});

test("request and decoded-avatar byte limits reject before admission", async (t) => {
  const f = await fixture(t);
  const service = await f.start({}, { CARD_MAX_REQUEST_BYTES: "1024", CARD_MAX_AVATAR_BYTES: "100" });
  const tooLarge = await post(service, { type: "sniper", avatar_data: AVATAR, padding: "x".repeat(2048) });
  assert.equal(tooLarge.status, 413); assert.equal(tooLarge.body.error, "request_too_large");
  const avatar = await post(service); assert.equal(avatar.status, 413); assert.equal(avatar.body.error, "avatar_too_large");
  assert.equal(f.counts.gemini, 0); assert.equal(service.queue.stats().queued, 0);
});

test("chunked oversized input is rejected even without Content-Length", async (t) => {
  const f = await fixture(t), service = await f.start({}, { CARD_MAX_REQUEST_BYTES: "1024" });
  const response = await new Promise((resolve, reject) => {
    const req = http.request(service.base + "/v1/identity/card-art", { method: "POST",
      headers: { Authorization: "Bearer " + TOKEN, "Content-Type": "application/json" } }, (res) => {
      const chunks = []; res.on("data", (chunk) => chunks.push(chunk));
      res.on("error", reject);
      res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) }));
    });
    req.on("error", reject);
    req.write('{"type":"sniper","padding":"'); req.end("x".repeat(2048) + '"}');
  });
  assert.equal(response.status, 413); assert.equal(response.body.error, "request_too_large");
  assert.equal(f.counts.gemini, 0);
});

test("production URL input rejects unsafe origins without outbound requests", async (t) => {
  const f = await fixture(t), service = await f.start();
  const originalFetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", (url, options) => {
    assert.equal(new URL(url).hostname, "127.0.0.1", "Rejected URLs must never reach fetch");
    return originalFetch(url, options);
  });
  for (const avatar_url of ["bad-url", "http://pbs.twimg.com/a.png", "https://127.0.0.1/a.png",
    "https://pbs.twimg.com.evil.test/a.png", "https://user:secret@pbs.twimg.com/a.png", "https://pbs.twimg.com:444/a.png", "file:///tmp/avatar.png"]) {
    assert.equal((await post(service, { type: "sniper", avatar_url })).status, 400);
  }
  assert.equal(f.counts.gemini, 0);
});

test("allowed X avatar is downloaded through a bounded injected HTTP response", async (t) => {
  const f = await fixture(t), service = await f.start(), originalFetch = globalThis.fetch;
  let downloads = 0;
  t.mock.method(globalThis, "fetch", (url, options) => {
    if (new URL(url).hostname === "pbs.twimg.com") {
      downloads++; assert.equal(options.redirect, "error"); assert.ok(options.signal instanceof AbortSignal);
      return Promise.resolve(new Response(MAIN, { headers: { "Content-Type": "image/png" } }));
    }
    assert.equal(new URL(url).hostname, "127.0.0.1"); return originalFetch(url, options);
  });
  const response = await post(service, { type: "sniper", avatar_url: "https://pbs.twimg.com/profile_images/offline.png" });
  assert.equal(response.status, 202); assert.equal(downloads, 1);
  await f.plateFinished.promise; await service.queue.close();
  assert.equal((await poll(service, response.body.job_id)).body.status, "done");
});

test("downloaded avatar byte cap rejects before any paid dispatch", async (t) => {
  const f = await fixture(t), service = await f.start({}, { CARD_MAX_AVATAR_BYTES: "100" }), originalFetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", (url, options) => {
    if (new URL(url).hostname === "pbs.twimg.com") return Promise.resolve(new Response(MAIN));
    assert.equal(new URL(url).hostname, "127.0.0.1"); return originalFetch(url, options);
  });
  const response = await post(service, { type: "sniper", avatar_url: "https://pbs.twimg.com/profile_images/offline.png" });
  assert.equal(response.status, 413); assert.equal(response.body.error, "avatar_too_large");
  assert.equal(f.counts.gemini, 0);
});

test("authentication protects submission, polling, assets and OPTIONS while health is public", async (t) => {
  const f = await fixture(t), service = await f.start();
  for (const [path, method] of [["/v1/identity/card-art", "POST"], ["/v1/identity/card-art/" + "a".repeat(24), "GET"],
    ["/art/" + "a".repeat(24) + ".png", "GET"], ["/v1/identity/card-art", "OPTIONS"]]) {
    for (const Authorization of ["", "Bearer wrong-token", "Basic ignored"]) {
      assert.equal((await request(service, path, { method, headers: { Authorization } })).status, 401);
    }
  }
  const health = await request(service, "/healthz", { headers: { Authorization: "" } });
  assert.equal(health.status, 200); assert.equal(health.body.ok, true); assert.equal(f.counts.gemini, 0);
  await service.queue.close();
  const stopped = await request(service, "/healthz", { headers: { Authorization: "" } });
  assert.equal(stopped.status, 503); assert.equal(stopped.body.ok, false);
});

test("queue full rejects a new ID while duplicates and health remain responsive", async (t) => {
  const f = await fixture(t), gate = f.gate();
  const service = await f.start({ generate: async () => { await gate.promise; return { png: MAIN, cost: 0, secs: 0 }; } },
    { CARD_MAX_ACTIVE_JOBS: "1", CARD_MAX_QUEUED_JOBS: "1" });
  const first = await post(service); await f.geminiStarted.promise;
  const second = await post(service, { type: "hodler", avatar_data: AVATAR }); assert.equal(second.status, 202);
  const full = await post(service, { type: "degen", avatar_data: AVATAR });
  assert.equal(full.status, 429); assert.equal(full.body.error, "queue_full");
  const duplicate = await post(service); assert.equal(duplicate.status, 202); assert.equal(duplicate.body.cached, true);
  assert.equal(duplicate.body.job_id, first.body.job_id);
  const start = performance.now(), health = await request(service, "/healthz", { headers: { Authorization: "" } });
  assert.equal(health.status, 200); assert.equal(health.body.queue.active, 1); assert.equal(health.body.queue.queued, 1);
  t.diagnostic(`Held-provider health latency ${Math.round(performance.now() - start)} ms; no production SLA asserted`);
  assert.equal(f.counts.gemini, 1);
});

test("HTTP admission cap returns worker_busy while public health bypasses held request bodies", async (t) => {
  const f = await fixture(t), service = await f.start({}, { CARD_MAX_HTTP_REQUESTS: "2" });
  const held = [];
  t.after(() => held.forEach(({ req }) => req.destroy()));
  for (let index = 0; index < 2; index++) {
    const arrival = once(service.server, "request");
    const responseDone = new Promise((resolve, reject) => {
      const req = http.request(service.base + "/v1/identity/card-art", { method: "POST",
        headers: { Authorization: "Bearer " + TOKEN, "Content-Type": "application/json" } }, (res) => {
        res.resume(); res.on("end", () => resolve(res.statusCode));
      });
      req.on("error", reject); held.push({ req }); req.write('{"type":"sniper"');
    });
    held[index].responseDone = responseDone;
    await arrival;
  }
  const busy = await poll(service, "a".repeat(24)); assert.equal(busy.status, 503); assert.equal(busy.body.error, "worker_busy");
  const health = await request(service, "/healthz", { headers: { Authorization: "" } });
  assert.equal(health.status, 200); assert.equal(health.body.ok, true);
  held.forEach(({ req }) => req.end("}"));
  assert.deepEqual(await Promise.all(held.map(({ responseDone }) => responseDone)), [400, 400]);
  assert.equal(f.counts.gemini, 0);
});

test("retained-history limit returns 503 for a new job while completed duplicates remain usable", async (t) => {
  const f = await fixture(t), env = { CARD_MAX_RETAINED_JOBS: "1" };
  const first = await f.start({}, env), done = await completed(f, first);
  await f.stop(first);
  let diskChecks = 0;
  const service = await f.start({ diskInfo: async () => { diskChecks++; return { bavail: 100 * 1024 ** 3, bsize: 1 }; } }, env);
  const full = await post(service, { type: "hodler", avatar_data: AVATAR });
  assert.equal(full.status, 503); assert.equal(full.body.error, "history_capacity"); noUrls(full.body);
  const duplicate = await post(service);
  assert.equal(duplicate.status, 200); assert.equal(duplicate.body.status, "done");
  assert.equal(duplicate.body.job_id, done.job_id); assert.equal(duplicate.body.cached, true);
  assert.equal(diskChecks, 0, "Full history and duplicates must not call prepare");
  assert.deepEqual(f.counts, { gemini: 1, cutout: 1, plate: 1, checkpoints: 1 });
  const health = await request(service, "/healthz");
  assert.equal(health.body.retained_jobs, 1); assert.equal(health.body.max_retained_jobs, 1);
  assert.equal(health.body.budget_limit_usd, null, "Storage history limit must not impose a business spend cap");
  assert.equal((await readdir(f.cache)).filter((name) => name.includes(".avatar.")).length, 1);
});

test("disk headroom rejects before avatar, journal admission or provider dispatch", async (t) => {
  const f = await fixture(t);
  const service = await f.start({ diskInfo: async () => ({ bavail: 5 * 1024 ** 3 + 79 * 1024 ** 2, bsize: 1 }) });
  assert.equal(service.config.minFreeDiskBytes, 5 * 1024 ** 3);
  const rejected = await post(service);
  assert.equal(rejected.status, 503); assert.equal(rejected.body.error, "storage_capacity"); noUrls(rejected.body);
  assert.equal(service.queue.retainedJobs, 0); assert.deepEqual(await readdir(join(f.cache, "jobs")), []);
  assert.deepEqual(await readdir(f.cache), ["jobs"]);
  assert.deepEqual(f.counts, { gemini: 0, cutout: 0, plate: 0, checkpoints: 0 });
  assert.equal((await request(service, "/healthz")).status, 200);
});

test("disk reservation counts the held active job and refuses a second new admission", async (t) => {
  const f = await fixture(t), gate = f.gate(); let diskChecks = 0;
  const service = await f.start({
    diskInfo: async () => { diskChecks++; return { bavail: 5 * 1024 ** 3 + 120 * 1024 ** 2, bsize: 1 }; },
    generate: async () => { await gate.promise; return { png: MAIN, cost: 0, secs: 0 }; },
  }, { CARD_MAX_ACTIVE_JOBS: "1" });
  const first = await post(service); assert.equal(first.status, 202); await f.geminiStarted.promise;
  const second = await post(service, { type: "hodler", avatar_data: AVATAR });
  assert.equal(second.status, 503); assert.equal(second.body.error, "storage_capacity");
  assert.equal(service.queue.retainedJobs, 1); assert.equal(service.queue.stats().active, 1); assert.equal(service.queue.stats().queued, 0);
  const duplicate = await post(service);
  assert.equal(duplicate.status, 202); assert.equal(duplicate.body.job_id, first.body.job_id); assert.equal(duplicate.body.cached, true);
  assert.equal(diskChecks, 2); assert.equal(f.counts.gemini, 1);
  assert.equal((await readdir(f.cache)).filter((name) => name.includes(".avatar.")).length, 1);
  assert.equal((await readdir(join(f.cache, "jobs"))).length, 1);
  gate.resolve(); await f.plateFinished.promise; await service.queue.close();
  assert.equal((await poll(service, first.body.job_id)).body.status, "done");
});

test("disk reservation increases when the configured avatar limit exceeds the default", async (t) => {
  const f = await fixture(t);
  const service = await f.start({ diskInfo: async () => ({ bavail: 5 * 1024 ** 3 + 88 * 1024 ** 2, bsize: 1 }) },
    { CARD_MAX_AVATAR_BYTES: String(20 * 1024 ** 2) });
  const rejected = await post(service);
  assert.equal(rejected.status, 503); assert.equal(rejected.body.error, "storage_capacity");
  assert.equal(service.queue.retainedJobs, 0); assert.deepEqual(await readdir(f.cache), ["jobs"]);
  assert.equal(f.counts.gemini, 0);
});

test("prompt upgrade preserves completed and queued A snapshots while factory B resumes A", async (t) => {
  const f = await fixture(t), releaseA = f.gate(), startedB = f.gate(), releaseB = f.gate();
  const promptsA = { version: "prompt-A", types: Object.fromEntries(TYPES.map((type) => [type, "A_ONLY immutable direction"])) };
  const promptsB = { version: "prompt-B", types: Object.fromEntries(TYPES.map((type) => [type, "B_ONLY new direction"])) };
  const first = await f.start({ prompts: promptsA,
    generate: async () => { await releaseA.promise; return { png: MAIN, cost: 0, secs: 0 }; } }, { CARD_MAX_ACTIVE_JOBS: "1" });
  const activeA = await post(first); await f.geminiStarted.promise;
  const queuedA = await post(first, { type: "hodler", avatar_data: AVATAR });
  const savedA = first.queue.get(queuedA.body.job_id);
  assert.equal(savedA.status, "queued"); assert.equal(savedA.payload.promptVersion, "prompt-A");
  assert.match(savedA.payload.prompt, /A_ONLY/); assert.equal(queuedA.body.prompt_version, "prompt-A");
  const closingA = first.queue.close(); releaseA.resolve(); await closingA;
  assert.equal(first.queue.get(activeA.body.job_id).status, "done");
  assert.equal(first.queue.get(queuedA.body.job_id).status, "queued");
  await f.stop(first);
  let resumedOptions;
  const second = await f.start({ prompts: promptsB, generate: async (options) => {
    resumedOptions = options; startedB.resolve(); await releaseB.promise; return { png: MAIN, cost: 0, secs: 0 };
  } });
  await startedB.promise;
  assert.equal(resumedOptions.prompt, savedA.payload.prompt); assert.equal(resumedOptions.model, savedA.payload.imageModel);
  assert.doesNotMatch(resumedOptions.prompt, /B_ONLY/); assert.deepEqual(resumedOptions.refs, []);
  const done = await poll(second, activeA.body.job_id), running = await poll(second, queuedA.body.job_id);
  assert.equal(done.body.status, "done"); assert.equal(done.body.prompt_version, "prompt-A");
  assert.equal(running.body.status, "running"); assert.equal(running.body.prompt_version, "prompt-A"); noUrls(running.body);
  releaseB.resolve(); await second.queue.close();
  const recovered = await poll(second, queuedA.body.job_id);
  assert.equal(recovered.body.status, "done"); assert.equal(recovered.body.prompt_version, "prompt-A");
  assert.deepEqual(f.counts, { gemini: 2, cutout: 2, plate: 2, checkpoints: 2 });
});
