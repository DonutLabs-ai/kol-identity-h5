import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { cpus, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { createCardArtService } from "./card-art-service.mjs";
import { readServerConfig } from "./server-config.mjs";
import { TYPES } from "./harness/lib.mjs";

// Loopback HTTP + real service/journal/files; every paid/image-processing provider is injected.
// Each wave admits N unique jobs through at most 64 HTTP clients, holds generation,
// then closes admission BEFORE releasing it. Only the four already-active jobs render.
// A separate 64-client 1300x1300 PNG wave exercises the near-5-MiB avatar limit.
const TOKEN = "offline-capacity-test-token";
const HTTP_CLIENTS = 64;
const LADDER = [10, 50, 100, 500, 1000];
const MAIN = await readFile(new URL("./test-fixtures/main.png", import.meta.url));
const CUT = await readFile(new URL("./test-fixtures/cut.png", import.meta.url));
const PLATE = Buffer.from("/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCABAAEADASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAGQEBAAMBAQAAAAAAAAAAAAAAAAIDBQYE/8QAGREBAAIDAAAAAAAAAAAAAAAAABIVYqHh/9oADAMBAAIRAxEAPwCYgNl7AWUQkw7rDfEaFlCRdYb4jQCbcAAWUBU4YABGgFruQAFlAVOGAARoBa7kABZRGhCLDpc9dWURoIlLnroAm3H/2Q==", "base64");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
async function sourceHashes() {
  const names = ["card-art-service.mjs", "job-queue.mjs", "server-config.mjs", "bedrock-cutout.mjs",
    "openrouter-image.mjs", "worker.mjs", "harness/plate.py", "harness/validate-main.py", "load-test.mjs"];
  return Object.fromEntries(await Promise.all(names.map(async (name) => [name, sha256(await readFile(new URL(name, import.meta.url)))])));
}
function finite(number) { return Number.isFinite(number) ? number : null; }
function percentile(values, fraction) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

async function worker() {
  const cache = await mkdtemp(join(tmpdir(), "cardgen-load-"));
  const gate = deferred(), firstFour = deferred();
  const counts = { gemini: 0, cutout: 0, plate: 0, checkpoints: 0 };
  const config = readServerConfig({ CARD_AUTH_TOKEN: TOKEN, CARD_REQUIRE_AUTH: "true",
    CARD_MAX_ACTIVE_JOBS: "4", CARD_MAX_QUEUED_JOBS: "1000", CARD_MAX_HTTP_REQUESTS: "64" });
  const sourceStart = await sourceHashes();
  const service = await createCardArtService({ config, cache, apiKey: "offline-only",
    prompts: { version: "load-test-v1", types: Object.fromEntries(TYPES.map((type) => [type, "Hold a telescope."])) },
    logger: { log() {}, error() {} },
    async validateMain() {},
    async generate() {
      counts.gemini++;
      if (counts.gemini === 4) firstFour.resolve();
      await gate.promise; return { png: MAIN, cost: 0, secs: 0 };
    },
    async cutout(image, checkpoint) {
      assert.deepEqual(image, MAIN); await checkpoint(); counts.checkpoints++; counts.cutout++;
      return { png: CUT, requestId: "offline-load", seconds: 0 };
    },
    async makePlate(source, cut, target) {
      counts.plate++; await writeFile(target, PLATE); return { coverage: 0.3 };
    },
  });
  service.server.listen(0, "127.0.0.1"); await once(service.server, "listening");
  const delay = monitorEventLoopDelay({ resolution: 10 }); delay.enable();
  const start = performance.now(), samples = [];
  const sample = () => {
    const record = { elapsed_ms: performance.now() - start, memory: process.memoryUsage(), queue: service.queue.stats() };
    samples.push(record); return record;
  };
  sample(); const sampler = setInterval(sample, 50);
  function snapshot() {
    return { counts: { ...counts }, current: sample(), healthy: service.queue.healthy,
      event_loop_ms: { mean: finite(delay.mean / 1e6), p50: finite(delay.percentile(50) / 1e6),
        p95: finite(delay.percentile(95) / 1e6), p99: finite(delay.percentile(99) / 1e6), max: finite(delay.max / 1e6) } };
  }
  process.on("message", async (message) => {
    try {
      if (message.command === "snapshot") {
        await firstFour.promise;
        process.send({ request: message.request, result: snapshot() });
      } else if (message.command === "drain") {
        const closing = service.queue.close(); // Synchronous stop: queued work must remain queued.
        gate.resolve(); await closing;
        clearInterval(sampler); delay.disable();
        const result = { ...snapshot(), samples, source_start: sourceStart, source_end: await sourceHashes(),
          job_record_files: (await readdir(join(cache, "jobs"))).filter((name) => name.endsWith(".json")).length,
          known_output_files: (await readdir(cache)).filter((name) => /^[a-f0-9]{24}(\.png|\.cut\.png|\.plate\.jpg)$/.test(name)).length };
        await new Promise((done) => { service.server.close(done); service.server.closeAllConnections(); });
        await rm(cache, { recursive: true, force: true });
        process.send({ request: message.request, result }, () => process.disconnect());
      } else throw new Error("Unknown load-worker command");
    } catch (error) {
      process.send({ request: message.request, error: error.stack }, () => process.exit(1));
    }
  });
  process.send({ ready: true, base: `http://127.0.0.1:${service.server.address().port}`, config: {
    max_active: config.maxActiveJobs, max_queued: config.maxQueuedJobs, max_http_requests: config.maxHttpRequests,
    max_request_bytes: config.maxRequestBytes, max_avatar_bytes: config.maxAvatarBytes,
  }, baseline: samples[0], source_start: sourceStart });
}

// Valid, incompressible RGB PNG. tEXt carries the unique avatar index.
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const kind = Buffer.from(type), length = Buffer.alloc(4), checksum = Buffer.alloc(4);
  length.writeUInt32BE(data.length); checksum.writeUInt32BE(crc32(Buffer.concat([kind, data])));
  return Buffer.concat([length, kind, data, checksum]);
}
function avatars(width = 320, height = 320) {
  const stride = width * 3, noise = randomBytes(stride * height);
  const scanlines = Buffer.alloc((stride + 1) * height);
  for (let row = 0; row < height; row++) noise.copy(scanlines, row * (stride + 1) + 1, row * stride, (row + 1) * stride);
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  const prefix = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(scanlines))]);
  const end = chunk("IEND", Buffer.alloc(0));
  return (index) => Buffer.concat([prefix, chunk("tEXt", Buffer.from("load-id\0" + index.toString().padStart(8, "0"))), end]);
}

async function launch() {
  const child = fork(fileURLToPath(import.meta.url), ["--worker"], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  const ready = deferred(), pending = new Map(); let sequence = 0, stderr = "";
  child.stderr.on("data", (data) => { stderr += data.toString(); });
  child.on("message", (message) => {
    if (message.ready) ready.resolve(message);
    else {
      const waiter = pending.get(message.request);
      if (!waiter) return;
      pending.delete(message.request);
      if (message.error) waiter.reject(new Error(message.error)); else waiter.resolve(message.result);
    }
  });
  const exited = once(child, "exit");
  const startup = await Promise.race([ready.promise, exited.then(([code, signal]) => {
    throw new Error(`Load worker exited before listening: ${code}/${signal} ${stderr}`);
  })]);
  const rpc = (command) => new Promise((resolveRpc, reject) => {
    const request = ++sequence; pending.set(request, { resolve: resolveRpc, reject });
    child.send({ command, request }, (error) => { if (error) { pending.delete(request); reject(error); } });
  });
  child.on("exit", (code, signal) => {
    for (const waiter of pending.values()) waiter.reject(new Error(`Load worker exited: ${code}/${signal} ${stderr}`));
    pending.clear();
  });
  return { ...startup, child, rpc, exited, stderr: () => stderr };
}

async function measuredPost(base, index, avatar) {
  const body = JSON.stringify({ type: "sniper", avatar_data: "data:image/png;base64," + avatar.toString("base64") });
  const start = performance.now();
  const response = await fetch(base + "/v1/identity/card-art", { method: "POST",
    headers: { Authorization: "Bearer " + TOKEN, "Content-Type": "application/json" }, body });
  const responseBody = await response.json();
  return { index, http_status: response.status, latency_ms: performance.now() - start,
    request_bytes: Buffer.byteLength(body), avatar_bytes: avatar.length, response: responseBody };
}
async function parallelMap(count, action) {
  const results = Array(count); let next = 0;
  await Promise.all(Array.from({ length: Math.min(HTTP_CLIENTS, count) }, async () => {
    while (next < count) { const index = next++; results[index] = await action(index); }
  }));
  return results;
}
async function wave(count, avatar) {
  const host = await launch(), health = [], started = performance.now();
  let polling = true;
  const probe = async () => {
    const start = performance.now(), response = await fetch(host.base + "/healthz");
    const body = await response.json();
    health.push({ elapsed_ms: start - started, latency_ms: performance.now() - start,
      http_status: response.status, response: body });
  };
  await probe();
  const healthLoop = (async () => {
    while (polling) { await new Promise((done) => setTimeout(done, 50)); if (polling) await probe(); }
  })();
  try {
    const submissions = await parallelMap(count, (index) => measuredPost(host.base, index, avatar(index)));
    const admissionElapsed = performance.now() - started;
    const held = await host.rpc("snapshot");
    const accepted = submissions.filter((record) => record.http_status === 202 || record.http_status === 200);
    const first = accepted[0]; assert.ok(first, "At least one unique request must be admitted");
    const duplicates = await parallelMap(64, () => measuredPost(host.base, first.index, avatar(first.index)));
    for (const record of duplicates) {
      assert.equal(record.http_status, 202); assert.equal(record.response.job_id, first.response.job_id);
      assert.equal(record.response.cached, true); assert.notEqual(record.response.status, "done");
    }
    const afterDuplicates = await host.rpc("snapshot");
    assert.equal(held.counts.gemini, 4); assert.equal(afterDuplicates.counts.gemini, 4);
    assert.equal(new Set(accepted.map((record) => record.response.job_id)).size, accepted.length);
    assert.ok(held.current.queue.active <= 4); assert.ok(held.current.queue.queued <= 1000);
    await probe(); polling = false; await healthLoop;
    const drained = await host.rpc("drain"); await host.exited;
    assert.deepEqual(drained.counts, { gemini: 4, cutout: 4, plate: 4, checkpoints: 4 });
    assert.equal(drained.known_output_files, 12); assert.equal(drained.job_record_files, accepted.length);
    for (const sample of drained.samples) { assert.ok(sample.queue.active <= 4); assert.ok(sample.queue.queued <= 1000); }
    for (const probe of health) { assert.equal(probe.http_status, 200); assert.equal(probe.response.ok, true); }
    const statusCounts = Object.fromEntries([...new Set(submissions.map((item) => item.http_status))]
      .map((status) => [status, submissions.filter((item) => item.http_status === status).length]));
    return { offered_unique: count, server_config: host.config, client_http_concurrency_limit: HTTP_CLIENTS,
      admission_elapsed_ms: admissionElapsed, accepted: accepted.length,
      busy_503: submissions.filter((item) => item.http_status === 503).length,
      queue_full_429: submissions.filter((item) => item.http_status === 429).length, http_status_counts: statusCounts,
      post_latency_ms: { p50: percentile(submissions.map((item) => item.latency_ms), 0.5), p95: percentile(submissions.map((item) => item.latency_ms), 0.95), max: Math.max(...submissions.map((item) => item.latency_ms)) },
      health_sample_count: health.length,
      health_latency_ms: { p50: percentile(health.map((item) => item.latency_ms), 0.5), p95: percentile(health.map((item) => item.latency_ms), 0.95), max: Math.max(...health.map((item) => item.latency_ms)) },
      worker_memory_bytes: { baseline_rss: host.baseline.memory.rss, peak_rss: Math.max(...drained.samples.map((item) => item.memory.rss)),
        peak_heap_used: Math.max(...drained.samples.map((item) => item.memory.heapUsed)), peak_external: Math.max(...drained.samples.map((item) => item.memory.external)) },
      held, after_duplicates: afterDuplicates, drained, submissions, duplicates, health, worker_stderr: host.stderr() };
  } finally {
    polling = false; await healthLoop;
    if (host.child.exitCode === null && host.child.signalCode === null) host.child.kill();
  }
}

async function main() {
  const outputIndex = process.argv.indexOf("--output");
  if (outputIndex === -1 || !process.argv[outputIndex + 1]) throw new Error("Usage: node load-test.mjs --output /absolute/capacity-results.json");
  const output = resolve(process.argv[outputIndex + 1]), avatar = avatars();
  const result = { schema_version: 1, started_at: new Date().toISOString(), mode: "injected_mock_providers_loopback_http",
    paid_provider_calls: 0, actual_provider_capacity_measured: false,
    production_memory_limit_bytes_supplied: 4 * 1024 ** 3,
    methodology: "Independent worker process for memory/event-loop samples; valid synthetic ~300 KiB PNG avatars; N distinct submissions offered with at most 64 active HTTP clients; generators held until admission and duplicate checks finish; close stops queued dispatch before releasing exactly four mock renders per wave. No retries of rejected submissions. Health is public and bypasses HTTP admission cap.",
    limitations: ["Host Linux process measurements, not Sydney EKS/ARM/cgroup measurements; server process only, excluding the load client and Python", "Fixture outputs and zero-latency cutout/plate callbacks do not measure Gemini, Bedrock pacing, Python plate CPU, quality or network latency", "No claim of 1000 simultaneous HTTP requests or paid renders", "Memory sample interval 50 ms can miss shorter allocation peaks", "Only these bounded waves are measured; retained terminal records and six-month storage need separate sizing", "User-supplied production memory limit of 4 GiB is context, not a proven universal safety guarantee"],
    environment: { node: process.version, platform: process.platform, arch: process.arch, host_logical_cpus: cpus().length },
    fixtures: { main_sha256: sha256(MAIN), cut_sha256: sha256(CUT), plate_sha256: sha256(PLATE),
      avatar_bytes: avatar(0).length, avatar_dimensions: [320, 320], avatar_zero_sha256: sha256(avatar(0)) },
    source_start: await sourceHashes(), waves: [] };
  for (const count of LADDER) {
    result.waves.push(await wave(count, avatar));
    await writeFile(output, JSON.stringify(result, null, 2) + "\n");
    const current = result.waves.at(-1);
    console.log(JSON.stringify({ offered: count, accepted: current.accepted, busy_503: current.busy_503,
      active: current.held.current.queue.active, queued: current.held.current.queue.queued,
      peak_rss_mib: +(current.worker_memory_bytes.peak_rss / 1048576).toFixed(1),
      health_p95_ms: +current.health_latency_ms.p95.toFixed(2) }));
  }
  const largeAvatar = avatars(1300, 1300);
  const maxAvatar = largeAvatar(0);
  assert.ok(maxAvatar.length < 5 * 1024 ** 2 && maxAvatar.length > 4.8 * 1024 ** 2);
  result.near_max_input = { avatar_dimensions: [1300, 1300], avatar_bytes: maxAvatar.length,
    avatar_limit_bytes: 5 * 1024 ** 2, avatar_zero_sha256: sha256(maxAvatar), ...await wave(64, largeAvatar) };
  result.near_max_input.peak_rss_fraction_of_supplied_limit = result.near_max_input.worker_memory_bytes.peak_rss / result.production_memory_limit_bytes_supplied;
  console.log(JSON.stringify({ near_max_input: true, avatar_bytes: maxAvatar.length, offered: 64,
    accepted: result.near_max_input.accepted, busy_503: result.near_max_input.busy_503,
    peak_rss_mib: +(result.near_max_input.worker_memory_bytes.peak_rss / 1048576).toFixed(1),
    health_p95_ms: +result.near_max_input.health_latency_ms.p95.toFixed(2) }));
  result.finished_at = new Date().toISOString(); result.source_end = await sourceHashes();
  result.source_changed_during_run = JSON.stringify(result.source_start) !== JSON.stringify(result.source_end);
  await writeFile(output, JSON.stringify(result, null, 2) + "\n");
}

if (process.argv.includes("--worker")) await worker();
else await main();
