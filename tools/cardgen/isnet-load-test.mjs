import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";
import { createCardArtService } from "./card-art-service.mjs";
import { readServerConfig } from "./server-config.mjs";
import { TYPES } from "./harness/lib.mjs";

const exec = promisify(execFile);
const root = process.env.CARD_BENCH_OUTPUT || "/tmp/isnet-results";
const source = await readFile(process.env.CARD_BENCH_IMAGE);
await mkdir(root, { recursive: true });
const started = performance.now(), healthLatencies = [], runtimeSamples = [], completed = [];
const report = { started_at: new Date().toISOString(), arch: process.arch,
  source_revision: process.env.CARD_SOURCE_REVISION, paid_provider_calls: 0,
  unique_main_images: 1, input_sha256: createHash("sha256").update(source).digest("hex"),
  limitations: ["Main images are a fixed approved fixture; Gemini is not called.",
    "Measures real IS-Net, PNG validation, PNG writes and Pillow plates; no public frontend or network transit.",
    "Repeated one portrait measures capacity, not broad segmentation accuracy."], waves: [] };
function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)];
}
function metrics(values) { return { samples: values.length, p50: percentile(values, .5), p95: percentile(values, .95), max: Math.max(...values) }; }
const files = ["memory.current", "memory.peak", "memory.events", "cpu.stat", "cpu.max", "memory.max"];
async function cgroup() {
  return Object.fromEntries(await Promise.all(files.map(async name => [name,
    (await readFile("/sys/fs/cgroup/" + name, "utf8")).trim()])));
}
const config = readServerConfig({ ...process.env, CARD_REQUIRE_AUTH: "true", CARD_AUTH_TOKEN: "offline-isnet-qa",
  CARD_CUTOUT_PROVIDER: "isnet", CARD_MIN_FREE_DISK_BYTES: "104857600" });
let generated = 0, base, interval, busy = false;
const serviceStarted = performance.now();
report.cgroup_before = await cgroup();
const service = await createCardArtService({ config, cache: join(root, "cache"), apiKey: "offline-never-used",
  prompts: { version: "isnet-load-v1", types: Object.fromEntries(TYPES.map(t => [t, "Hold a telescope."])) },
  async generate() { generated++; return { png: source, cost: 0, secs: 0 }; },
  logger: { log(line) { const event = JSON.parse(line); completed.push({ ...event, elapsed_ms: performance.now() - started }); },
    error(line) { process.stderr.write(line + "\n"); } },
});
report.cold_ready_ms = performance.now() - serviceStarted;
service.server.listen(0, "127.0.0.1"); await once(service.server, "listening");
base = `http://127.0.0.1:${service.server.address().port}`;
async function call(path, options = {}) {
  const response = await fetch(base + path, { ...options, signal: AbortSignal.timeout(15000),
    headers: { Authorization: "Bearer offline-isnet-qa", ...options.headers } });
  return { status: response.status, body: await response.json() };
}
async function sample() {
  const before = performance.now(), response = await call("/healthz");
  healthLatencies.push(performance.now() - before);
  assert.equal(response.status, 200); assert.equal(response.body.cutout_provider, "isnet");
  runtimeSamples.push({ elapsed_ms: performance.now() - started, rss: process.memoryUsage().rss,
    queue: response.body.queue, cgroup: await cgroup() });
}
let samplingError;
try {
  report.initial_health = (await call("/healthz")).body;
  assert.equal(report.initial_health.source_revision, process.env.CARD_SOURCE_REVISION);
  const unauthorized = await fetch(base + "/v1/identity/card-art", { method: "POST", body: "{}" });
  assert.equal(unauthorized.status, 401); report.unauthorized_status = unauthorized.status;
  interval = setInterval(() => {
    if (busy) return;
    busy = true;
    sample().catch(error => { samplingError = error; }).finally(() => { busy = false; });
  }, 500);
  for (const count of [10, 25, 50]) {
    const waveStarted = performance.now(), originalGenerated = generated;
    const admitted = await Promise.all(Array.from({ length: count }, async (_, index) => {
      // Trailing metadata varies input identity; the generated main stays the same real portrait.
      const avatar = Buffer.concat([source, Buffer.from(`isnet-wave-${count}-${index}`)]);
      const before = performance.now();
      const response = await call("/v1/identity/card-art", { method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "sniper", avatar_data: avatar.toString("base64") }) });
      assert.equal(response.status, 202); assert.ok(["queued", "running"].includes(response.body.status));
      return { id: response.body.job_id, admitted_ms: performance.now() - before };
    }));
    assert.equal(new Set(admitted.map(x => x.id)).size, count);
    const duplicate = await call("/v1/identity/card-art", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "sniper", avatar_data: Buffer.concat([source, Buffer.from(`isnet-wave-${count}-0`)]).toString("base64") }) });
    assert.equal(duplicate.body.job_id, admitted[0].id); assert.equal(duplicate.body.cached, true);
    const pending = new Map(admitted.map(x => [x.id, x])), latencies = [];
    while (pending.size) {
      assert.ok(performance.now() - waveStarted < 900000, "Load wave exceeded 15-minute deadline");
      if (samplingError) throw samplingError;
      await Promise.all([...pending].map(async ([id, item]) => {
        const response = await call("/v1/identity/card-art/" + id);
        assert.equal(response.status, 200); assert.notEqual(response.body.status, "failed", JSON.stringify(response.body));
        if (response.body.status !== "done") {
          for (const name of ["image_url", "cutout_url", "plate_url"]) assert.equal(Object.hasOwn(response.body, name), false);
          return;
        }
        for (const name of ["image_url", "cutout_url", "plate_url"]) assert.equal(typeof response.body[name], "string");
        latencies.push(performance.now() - waveStarted); pending.delete(id); item.done = response.body;
      }));
      if (pending.size) await sleep(500);
    }
    assert.equal(generated - originalGenerated, count, "Duplicate must not generate another main");
    const elapsed = performance.now() - waveStarted;
    const wave = { offered: count, accepted: admitted.length, completed: count, failed: 0,
      seconds: elapsed / 1000, completion_per_minute: count * 60000 / elapsed,
      admission_ms: metrics(admitted.map(x => x.admitted_ms)), completion_ms: metrics(latencies) };
    report.waves.push(wave); console.log(JSON.stringify({ event: "isnet.wave_complete", ...wave }));
  }
  const journal = service.queue.get(completed[0].job_id);
  const validated = await exec("python3", ["-c", "from PIL import Image; import json,sys; r=[]\nfor p in sys.argv[1:]:\n im=Image.open(p); im.load(); r.append({'path':p.rsplit('/',1)[-1],'mode':im.mode,'size':list(im.size),'format':im.format})\nprint(json.dumps(r))",
    join(root, "cache", journal.id + ".png"), join(root, "cache", journal.id + ".cut.png"), join(root, "cache", journal.id + ".plate.jpg")]);
  report.sample_outputs = JSON.parse(validated.stdout);
  assert.equal(report.sample_outputs[1].mode, "RGBA");
  assert.equal(report.sample_outputs[2].format, "JPEG");
  assert.ok(report.sample_outputs.every(x => x.size[0] === 1024 && x.size[1] === 1024));
  report.cutout_seconds = metrics(completed.map(x => x.cutout_seconds));
  report.health_ms = metrics(healthLatencies);
  report.gemini_fixture_calls = generated;
  report.cgroup_after = await cgroup();
  assert.match(report.cgroup_after["memory.events"], /oom_kill 0/);
  report.status = "PASS";
} catch (error) { report.status = "FAIL"; report.error = error.stack; process.exitCode = 1; }
finally {
  clearInterval(interval);
  await new Promise(resolve => service.server.close(resolve));
  await service.close();
  report.finished_at = new Date().toISOString(); report.runtime_samples = runtimeSamples; report.completed = completed;
  await writeFile(join(root, "isnet-load-report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ event: "isnet.load_finished", status: report.status, error: report.error }));
}
if (process.env.CARD_BENCH_HOLD === "true") {
  const keepalive = setInterval(() => {}, 1000);
  await new Promise(resolve => process.once("SIGTERM", () => { clearInterval(keepalive); resolve(); }));
}
