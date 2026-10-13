import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { mkdtemp, readFile, rm, cp, writeFile, open, readdir, unlink, lstat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { existsSync, promises as fsPromises } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createCardArtService } from "./card-art-service.mjs";
import { readServerConfig } from "./server-config.mjs";
import { pipelineDescriptor } from "./pipeline-version.mjs";
import { PersistentJobQueue } from "./job-queue.mjs";
import { createImageGenerator } from "./openrouter-image.mjs";
import { createIsnetCutout } from "./isnet-cutout.mjs";
import { spawn } from "node:child_process";
import { digest, validateCheckpointWitness, validateWitnessTransition } from "./checkpoint-witness.mjs";

const exec = promisify(execFile);
const MAIN = await readFile(new URL("./test-fixtures/main.png", import.meta.url));
const CUT = await readFile(new URL("./test-fixtures/cut.png", import.meta.url));
const KEY = "11111111-1111-4111-8111-111111111111";
const TOKEN = "offline-only";
const START = Date.parse("2026-10-13T09:00:00.000Z");
const EXPIRY = "2027-04-01T09:00:00.000Z";
const iso = time => new Date(time).toISOString();
const uuid = n => `22222222-2222-4222-8222-${String(n).padStart(12, "0")}`;
const stageError = () => Object.assign(new Error("offline failure"), { category: "provider_error" });

async function fixture(t) {
  const cache = await mkdtemp(join(tmpdir(), "cardgen-s13-")), services = [], dirs = [cache], gates = [];
  const f = { cache, clock: START, counts: { llm: 0, cutout: 0, plate: 0 }, signals: {}, plateTargets: [],
    gate() { let resolve; const promise = new Promise(done => { resolve = done; }); const g = { promise, resolve }; gates.push(g); return g; },
    async stage(name, signal) {
      f.counts[name]++; f.signals[name] = signal;
      const hold = f[name + "Hold"];
      if (hold) { f[name + "Entered"].resolve(); await hold.promise; }
      if (f[name + "Error"]) throw f[name + "Error"];
    },
    async start(directory = cache, source = "source-v1", options = {}) {
      const config = readServerConfig({ CARD_AUTH_TOKEN: TOKEN, CARD_SOURCE_REVISION: source,
        CARD_RETENTION_SWEEP_MS: "600000", ...options.env });
      const s = await createCardArtService({ config, cache: directory, apiKey: TOKEN, now: () => f.clock,
        prompts: { version: "offline", types: { sniper: "offline prompt" } },
        logger: { log() {}, error() {} }, diskInfo: async () => ({ bavail: 100 * 1024 ** 3, bsize: 1 }),
        generate: options.generate || (async args => {
          args.beforeDispatch(); await args.onDispatch(); await f.stage("llm", args.signal);
          await args.onReceipt({ newProviderRequests: 1, costUSD: 0.14, reportedSeconds: 1 });
          return { png: MAIN, cost: 0.14, secs: 1 };
        }),
        cutout: options.cutout || (async (_bytes, checkpoint, paths) => {
          await checkpoint(); await paths.onDispatch();
          await paths.onReceipt({ newProviderRequests: 0, costUSD: null, reportedSeconds: null });
          await f.stage("cutout", paths.signal); return { png: CUT, seconds: 1 };
        }),
        async makePlate(main, cut, target, { signal } = {}) {
          f.plateTargets.push(target);
          await f.stage("plate", signal);
          const result = await exec("python3", [new URL("./harness/plate.py", import.meta.url).pathname, main, cut, target]);
          return JSON.parse(result.stdout);
        },
      });
      services.push(s); s.server.listen(0, "127.0.0.1"); await once(s.server, "listening");
      return { ...s, config, directory, base: `http://127.0.0.1:${s.server.address().port}` };
    },
    async request(s, path, body) {
      const response = await fetch(s.base + path, { method: body === undefined ? "GET" : "POST",
        headers: { Authorization: "Bearer " + TOKEN, "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, body: await response.json() };
    },
    post(s, fields = {}) { return f.request(s, "/v1/identity/card-art", { type: "sniper", avatar_data: MAIN.toString("base64"),
      requestKey: KEY, expiresAt: EXPIRY, expectedContract: pipelineDescriptor(s.config), ...fields }); },
    get(s, id) { return f.request(s, "/v1/identity/card-art/" + id); },
    retry(s, receipt, n, fields = {}) { return f.request(s, `/v1/identity/card-art/${receipt.job_id}/retry-layers`, {
      requestKey: KEY, expiresAt: EXPIRY, expectedContract: receipt.workerContract, retryToken: uuid(n),
      expectedAttempt: receipt.attempt, mainSha256: receipt.main.sha256, ...fields }); },
    async idle(s) {
      for (let i = 0; i < 1000 && s.queue.stats().active !== 0; i++) await new Promise(done => setTimeout(done, 5));
      assert.equal(s.queue.stats().active, 0); assert.equal(s.queue.healthy, true);
    },
    async journal(s, id) { return JSON.parse(await readFile(join(s.directory, "jobs", id + ".json"), "utf8")); },
    async fork(s) { const dir = await mkdtemp(join(tmpdir(), "cardgen-s13-reboot-")); dirs.push(dir); await cp(s.directory, dir, { recursive: true }); return dir; },
    hold(name) { f[name + "Hold"] = f.gate(); f[name + "Entered"] = f.gate(); },
  };
  t.after(async () => {
    gates.forEach(g => g.resolve());
    for (const s of services) {
      await new Promise(done => { s.server.close(done); s.server.closeAllConnections(); }); await s.close();
    }
    for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  });
  return f;
}

test("S13 old callers get one durable default; replay/reboot preserve initial deadline and advertise capability", async t => {
  const f = await fixture(t); f.hold("llm"); const s = await f.start();
  const admitted = (await f.post(s)).body;
  assert.equal(admitted.processingDeadlineAt, iso(START + 60000));
  await f.llmEntered.promise;
  assert.equal(admitted.expiresAt, EXPIRY);
  assert.equal((await f.request(s, "/healthz")).body.processing_deadline_version, 1);
  f.clock += 30000;
  assert.equal((await f.post(s, { processingDeadlineAt: iso(f.clock + 60000) })).body.processingDeadlineAt, admitted.processingDeadlineAt);
  const copy = await f.fork(s); const reboot = await f.start(copy);
  const lookup = await f.request(reboot, "/v1/identity/card-art/requests/" + KEY);
  assert.equal(lookup.body.processingDeadlineAt, admitted.processingDeadlineAt);
  assert.equal(lookup.body.failure_stage, "unknown"); assert.equal(f.counts.llm, 1);
  f.clock = START + 60000;
  const expired = (await f.get(reboot, admitted.job_id)).body;
  assert.equal(expired.error, "provider_timeout"); assert.equal(expired.failure_stage, "llm");
  assert.equal(expired.main.state, "timed_out"); assert.equal(expired.expiresAt, EXPIRY);
});

test("S13 IS-Net deadline retires its resident, fences late frames, and permits explicit repair and unrelated work", async t => {
  const f = await fixture(t); let processes = 0, active = 0, maxActive = 0, dispatches = 0, oldChild;
  const dispatched = f.gate();
  const cutout = createIsnetCutout({ modelPath: "offline-model", threads: 2, timeoutMs: 2000, startupTimeoutMs: 2000,
    spawnProcess() {
      const first = ++processes === 1;
      const code = `const fs = require('node:fs');
        console.log(JSON.stringify({event:'ready',model:'isnet-general-use'}));
        require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
          const request=JSON.parse(line);
          if (${first}) return;
          fs.writeFileSync(request.target,Buffer.from(${JSON.stringify(CUT.toString("base64"))},'base64'));
          console.log(JSON.stringify({id:request.id,ok:true,seconds:0.01}));
        });`;
      const child = spawn(process.execPath, ["-e", code], { stdio: ["pipe", "pipe", "pipe"] });
      maxActive = Math.max(maxActive, ++active); child.once("close", () => active--);
      child.stdin.on("finish", () => {});
      const write = child.stdin.write.bind(child.stdin);
      child.stdin.write = (...args) => { dispatches++; dispatched.resolve(); return write(...args); };
      if (first) oldChild = child;
      return child;
    } });
  await cutout.initialize();
  const s = await f.start(f.cache, "source-v1", { cutout });
  const id = (await f.post(s)).body.job_id; await dispatched.promise;
  const before = (await f.get(s, id)).body; assert.equal(before.main.state, "ready");
  f.clock = START + 60000;
  const expired = (await f.get(s, id)).body;
  assert.equal(expired.failure_stage, "cutout"); assert.deepEqual(expired.main, before.main);
  await f.idle(s);
  assert.equal(cutout.healthy(), true); assert.equal(processes, 2); assert.equal(dispatches, 1);
  // Delayed buffered frames from the retired resident cannot poison or settle the replacement.
  oldChild.stdout.emit("data", Buffer.from('{"id":1,"ok":true,"seconds":99}\n'));
  oldChild.emit("exit", 9, null);
  assert.equal((await f.request(s, "/healthz")).status, 200);
  assert.equal((await f.retry(s, expired, 40)).status, 202); await f.idle(s);
  const done = (await f.get(s, id)).body;
  assert.equal(done.status, "done"); assert.deepEqual(done.main, before.main);
  assert.equal(f.counts.llm, 1); assert.equal(processes, 2); assert.equal(dispatches, 2);
  assert.deepEqual(await readFile(join(s.directory, id + ".png")), MAIN);
  const other = (await f.post(s, { requestKey: uuid(41) })).body.job_id; await f.idle(s);
  assert.equal((await f.get(s, other)).body.status, "done");
  assert.equal((await f.request(s, "/healthz")).status, 200);
  assert.equal(f.counts.llm, 2); assert.equal(processes, 2); assert.equal(dispatches, 3); assert.equal(maxActive, 1);
});

test("S13 accepts explicit UTC deadlines, rejects malformed/over-60s and makes past deadline terminal without dispatch", async t => {
  const f = await fixture(t), s = await f.start();
  for (const processingDeadlineAt of [iso(START + 60001), "2026-10-13T09:00:30+00:00", "2026-02-30T09:00:00Z", null]) {
    const invalid = await f.post(s, { processingDeadlineAt });
    assert.equal(invalid.status, 400); assert.equal(invalid.body.error, "invalid_processing_deadline");
  }
  const admitted = (await f.post(s, { processingDeadlineAt: iso(START - 1) })).body;
  assert.equal(admitted.processingDeadlineAt, iso(START - 1));
  const terminal = (await f.get(s, admitted.job_id)).body;
  assert.equal(terminal.main.state, "timed_out"); assert.equal(terminal.failure_stage, "llm");
  assert.deepEqual(f.counts, { llm: 0, cutout: 0, plate: 0 });
});

test("S13 active checkpoints cannot mutate original receipt or deadline", async t => {
  const directory = await mkdtemp(join(tmpdir(), "cardgen-s13-immutable-"));
  let runs = 0;
  const queue = new PersistentJobQueue({ directory, maxActive: 1, maxQueued: 0, now: () => START,
    async run(job, checkpoint) {
      runs++;
      for (const field of ["processingReceivedAt", "processingDeadlineAt"]) {
        const original = job[field]; job[field] = iso(Date.parse(original) - 1);
        await assert.rejects(checkpoint(), /Original processing deadline cannot change/);
        assert.equal(queue.get(job.id)[field], original); job[field] = original;
      }
      await checkpoint();
    } });
  t.after(async () => { await queue.close(); await rm(directory, { recursive: true, force: true }); });
  await queue.initialize(); await queue.submit("immutable", {});
  // Give the already reserved execution its FIFO turn before draining it.
  await new Promise(done => setImmediate(done));
  while (queue.stats().active !== 0) await new Promise(done => setTimeout(done, 1));
  assert.equal(queue.healthy, true); assert.equal(runs, 1);
  assert.equal(queue.get("immutable").processingDeadlineAt, iso(START + 60000));
});

for (const cap of ["0", "0.29"]) {
  test(`S13 real worker budget cap ${cap} privately confirms no dispatch for initial and replacement tasks`, async t => {
    const f = await fixture(t); let providerCalls = 0;
    const generate = createImageGenerator({ fetcher: async () => {
      providerCalls++; throw new Error("Offline fixture must never reach provider dispatch");
    } });
    const s = await f.start(f.cache, "source-v1", { env: { CARD_BUDGET: cap }, generate });
    for (const requestKey of [KEY, uuid(10)]) {
      const receivedAt = f.clock;
      const id = (await f.post(s, { requestKey })).body.job_id; await f.idle(s);
      const terminal = (await f.get(s, id)).body, record = await f.journal(s, id);
      assert.equal(terminal.status, "failed"); assert.equal(terminal.error, "budget_not_dispatched");
      assert.equal(terminal.main.state, "failed"); assert.equal(terminal.failure_stage, "unknown");
      assert.equal(terminal.processingDeadlineAt, iso(receivedAt + 60000));
      assert.equal(record.stageSamples.stages.llm.reason, "budget_not_dispatched");
      for (const stage of ["llm", "cutout", "plate"]) {
        assert.equal(record.stageSamples.stages[stage].attempts, 0);
        assert.equal(record.stageSamples.stages[stage].newProviderRequests, 0);
      }
      f.clock = receivedAt + 60000;
      assert.equal((await f.get(s, id)).body.error, "budget_not_dispatched");
      // A replacement gets a new request key and deadline without a paid call.
      f.clock++;
    }
    assert.equal(providerCalls, 0); assert.deepEqual(f.counts, { llm: 0, cutout: 0, plate: 0 });
    assert.equal(s.budget.calls, 0); assert.equal(s.budget.spent, 0);
  });
}

for (const stage of ["llm", "cutout", "plate"]) {
  test(`S13 absolute total deadline fences ignored ${stage} abort, late receipt/assets and journal`, async t => {
    const f = await fixture(t); f.hold(stage); const s = await f.start();
    const admitted = (await f.post(s, { processingDeadlineAt: iso(START + 60000) })).body;
    await f[stage + "Entered"].promise;
    const before = (await f.get(s, admitted.job_id)).body;
    f.clock = START + 60000;
    const terminal = (await f.get(s, admitted.job_id)).body;
    assert.equal(terminal.status, "failed"); assert.equal(terminal.failure_stage, stage);
    assert.equal(f.signals[stage].aborted, true);
    assert.equal(stage === "llm" ? terminal.main.state : terminal.layers[stage].state, "timed_out");
    if (stage !== "llm") { assert.deepEqual(terminal.main, before.main); assert.equal((await fetch(s.base + terminal.main.url, { headers: { Authorization: "Bearer " + TOKEN } })).status, 200); }
    if (stage === "plate") assert.deepEqual(terminal.layers.cutout, before.layers.cutout);
    const sealed = await f.journal(s, admitted.job_id);
    f[stage + "Hold"].resolve(); await f.idle(s);
    assert.deepEqual(await f.journal(s, admitted.job_id), sealed);
    const late = (await f.get(s, admitted.job_id)).body;
    assert.deepEqual(late, terminal);
    if (stage !== "llm") assert.deepEqual(await readFile(join(s.directory, admitted.job_id + ".png")), MAIN);
    if (stage === "plate") assert.deepEqual(await readFile(join(s.directory, admitted.job_id + ".cut.png")), CUT);
    const url = `/art/${admitted.job_id}${stage === "llm" ? ".png" : stage === "cutout" ? ".cut.png" : ".plate.jpg"}`;
    assert.equal((await fetch(s.base + url, { headers: { Authorization: "Bearer " + TOKEN } })).status, 404);
  });
}

test("S13 each explicit layer retry owns fresh immutable deadline/token; initial root and successful resources survive", async t => {
  const f = await fixture(t); f.plateError = stageError(); const s = await f.start();
  const id = (await f.post(s, { processingDeadlineAt: iso(START + 60000) })).body.job_id;
  await f.idle(s); const failed = (await f.get(s, id)).body;
  f.clock += 120000; f.plateError = undefined; f.hold("plate");
  const retryDeadline = iso(f.clock + 60000);
  const replies = await Promise.all([f.retry(s, failed, 1, { processingDeadlineAt: retryDeadline }), f.retry(s, failed, 1, { processingDeadlineAt: retryDeadline })]);
  assert.ok(replies.every(r => r.status === 202));
  for (const { body } of replies) {
    assert.equal(body.processingDeadlineAt, iso(START + 60000));
    assert.equal(body.acceptedRetryProcessingDeadlineAt, retryDeadline);
    assert.equal(body.acceptedRetryToken, uuid(1)); assert.equal(body.acceptedAttempt, 1);
  }
  await f.plateEntered.promise; f.clock += 60000;
  const timedOut = (await f.get(s, id)).body;
  assert.equal(timedOut.layers.plate.state, "timed_out"); assert.deepEqual(timedOut.main, failed.main);
  assert.deepEqual(timedOut.layers.cutout, failed.layers.cutout);
  assert.equal(timedOut.acceptedRetryProcessingDeadlineAt, retryDeadline);
  f.plateHold.resolve(); f.plateHold = undefined; await f.idle(s);
  assert.deepEqual(await readFile(join(s.directory, id + ".png")), MAIN);
  assert.deepEqual(await readFile(join(s.directory, id + ".cut.png")), CUT);
  const second = await f.retry(s, timedOut, 2);
  assert.equal(second.body.acceptedRetryProcessingDeadlineAt, iso(f.clock + 60000));
  await f.idle(s);
  const done = (await f.get(s, id)).body;
  assert.equal(done.status, "done"); assert.equal(done.processingDeadlineAt, failed.processingDeadlineAt);
  assert.deepEqual(done.main, failed.main); assert.deepEqual(done.layers.cutout, failed.layers.cutout);
  const replay = await f.retry(s, failed, 1, { processingDeadlineAt: retryDeadline });
  assert.equal(replay.body.acceptedRetryToken, uuid(1)); assert.equal(replay.body.acceptedAttempt, 1);
  assert.equal(replay.body.acceptedRetryProcessingDeadlineAt, retryDeadline);
  assert.deepEqual(f.counts, { llm: 1, cutout: 1, plate: 3 });
  assert.equal(new Set(f.plateTargets).size, 3);
  assert.ok(f.plateTargets.every(path => path !== join(s.directory, id + ".plate.jpg.tmp")));
  assert.equal(done.expiresAt, EXPIRY);
});

test("S13 timer settles queued/running jobs without polling, retaining slots until ignored abort settles", async t => {
  const directory = await mkdtemp(join(tmpdir(), "cardgen-s13-timer-"));
  let release, entered, signal;
  const hold = new Promise(done => { release = done; }), started = new Promise(done => { entered = done; });
  const calls = [];
  const queue = new PersistentJobQueue({ directory, maxActive: 1, maxQueued: 1,
    async run(job, _checkpoint, context) { calls.push(job.id); signal = context; entered(); await hold; } });
  t.after(async () => { release(); await queue.close(); await rm(directory, { recursive: true, force: true }); });
  await queue.initialize();
  const receivedAt = Date.now(), deadline = iso(receivedAt + 500);
  await queue.submit("active", {}, undefined, undefined, { receivedAt, processingDeadlineAt: deadline });
  await started;
  await queue.submit("queued", {}, undefined, undefined, { receivedAt, processingDeadlineAt: deadline });
  for (let i = 0; i < 200 && queue.get("queued").status !== "failed"; i++) await new Promise(done => setTimeout(done, 10));
  assert.equal(queue.get("queued").error, "provider_timeout");
  assert.equal(queue.get("active").error, "provider_timeout"); assert.equal(signal.aborted, true);
  assert.deepEqual(calls, ["active"]); assert.equal(queue.stats().active, 1);
  const journal = await readFile(join(directory, "active.json"), "utf8");
  release(); await queue.close();
  assert.equal(await readFile(join(directory, "active.json"), "utf8"), journal);
});

test("S13 legacy queued journals backfill from original receipt, expire on restart without paid replay", async t => {
  const directory = await mkdtemp(join(tmpdir(), "cardgen-s13-legacy-"));
  const legacy = { id: "legacy", payload: {}, sequence: 1, status: "queued", stage: "queued",
    createdAt: iso(START), updatedAt: iso(START) };
  await writeFile(join(directory, "legacy.json"), JSON.stringify(legacy));
  let calls = 0;
  const queue = new PersistentJobQueue({ directory, maxActive: 1, maxQueued: 1, now: () => START + 60000,
    run() { calls++; } });
  t.after(async () => { await queue.close(); await rm(directory, { recursive: true, force: true }); });
  await queue.initialize();
  const terminal = queue.get("legacy");
  assert.equal(terminal.processingDeadlineAt, iso(START + 60000));
  assert.equal(terminal.status, "failed"); assert.equal(terminal.error, "provider_timeout");
  assert.equal(calls, 0);
  assert.deepEqual(JSON.parse(await readFile(join(directory, "legacy.json"), "utf8")), terminal);
});

test("S13 receipt and disk preparation consume the same interval before dispatch", async t => {
  const directory = await mkdtemp(join(tmpdir(), "cardgen-s13-preparation-"));
  let clock = START, calls = 0;
  const queue = new PersistentJobQueue({ directory, maxActive: 1, maxQueued: 1, now: () => clock, run() { calls++; } });
  t.after(async () => { await queue.close(); await rm(directory, { recursive: true, force: true }); });
  await queue.initialize(); clock += 30000;
  await queue.submit("late-admission", {}, async () => { clock = START + 60000; }, undefined, { receivedAt: START });
  const terminal = queue.get("late-admission");
  assert.equal(terminal.processingDeadlineAt, iso(START + 60000));
  assert.equal(terminal.error, "provider_timeout"); assert.equal(calls, 0);
});

test("S13 retry restart keeps unknown before its deadline, settles at original retry deadline without a second call", async t => {
  const f = await fixture(t); f.plateError = stageError(); const s = await f.start();
  const id = (await f.post(s)).body.job_id; await f.idle(s);
  const failed = (await f.get(s, id)).body;
  f.clock += 120000; f.plateError = undefined; f.hold("plate");
  const accepted = (await f.retry(s, failed, 1)).body; await f.plateEntered.promise;
  const reboot = await f.start(await f.fork(s));
  const unknown = (await f.get(reboot, id)).body;
  assert.equal(unknown.failure_stage, "unknown"); assert.equal(unknown.layers.plate.state, "unknown");
  assert.equal(unknown.processingDeadlineAt, failed.processingDeadlineAt);
  assert.equal(unknown.acceptedRetryProcessingDeadlineAt, accepted.acceptedRetryProcessingDeadlineAt);
  assert.deepEqual(f.counts, { llm: 1, cutout: 1, plate: 2 });
  f.clock = Date.parse(accepted.acceptedRetryProcessingDeadlineAt);
  const terminal = (await f.get(reboot, id)).body;
  assert.equal(terminal.failure_stage, "plate"); assert.equal(terminal.layers.plate.state, "timed_out");
  assert.deepEqual(terminal.main, failed.main); assert.deepEqual(terminal.layers.cutout, failed.layers.cutout);
  assert.equal((await f.retry(reboot, failed, 1)).body.replayed, true);
  assert.deepEqual(f.counts, { llm: 1, cutout: 1, plate: 2 });
});

test("S13 past retry deadline makes no inference; altered token deadline conflicts and future cap is rejected", async t => {
  const f = await fixture(t); f.plateError = stageError(); const s = await f.start();
  const id = (await f.post(s)).body.job_id; await f.idle(s); const failed = (await f.get(s, id)).body;
  const counts = { ...f.counts };
  const invalid = await f.retry(s, failed, 1, { processingDeadlineAt: iso(f.clock + 60001) });
  assert.equal(invalid.status, 400); assert.deepEqual(f.counts, counts);
  const accepted = (await f.retry(s, failed, 1, { processingDeadlineAt: iso(f.clock - 1) })).body;
  assert.equal(accepted.layers.plate.state, "timed_out"); assert.equal(accepted.acceptedAttempt, 1);
  assert.equal(accepted.processingDeadlineAt, failed.processingDeadlineAt);
  assert.deepEqual(accepted.layers.cutout, failed.layers.cutout); assert.deepEqual(f.counts, counts);
  assert.equal((await f.retry(s, failed, 1, { processingDeadlineAt: iso(f.clock + 60000) })).body.error, "retry_token_conflict");
});

test("S13 canonical asset sync crossing the deadline removes only its unpublished output, preserving main", async t => {
  const f = await fixture(t); f.hold("llm"); const s = await f.start();
  const id = (await f.post(s)).body.job_id; await f.llmEntered.promise;
  const handle = await open(s.directory, "r"), prototype = Object.getPrototypeOf(handle), sync = prototype.sync;
  await handle.close(); let crossed = false;
  t.mock.method(prototype, "sync", async function (...args) {
    await sync.apply(this, args);
    if (!crossed && (await this.stat()).isDirectory() && existsSync(join(s.directory, id + ".cut.png"))) {
      crossed = true; f.clock = START + 60000;
    }
  });
  f.llmHold.resolve(); await f.idle(s); t.mock.restoreAll();
  assert.equal(crossed, true); assert.equal(existsSync(join(s.directory, id + ".cut.png")), false);
  const terminal = (await f.get(s, id)).body;
  assert.equal(terminal.main.state, "ready"); assert.equal(terminal.layers.cutout.state, "timed_out");
  assert.deepEqual(await readFile(join(s.directory, id + ".png")), MAIN);
});

test("S13 crash during late checkpoint sync recovers preceding committed manifest, never the late ready layer", async t => {
  const f = await fixture(t); f.hold("llm"); const s = await f.start();
  const id = (await f.post(s)).body.job_id; await f.llmEntered.promise;
  const handle = await open(join(s.directory, "jobs"), "r"), prototype = Object.getPrototypeOf(handle), sync = prototype.sync;
  await handle.close(); let copy;
  t.mock.method(prototype, "sync", async function (...args) {
    await sync.apply(this, args);
    const disk = await f.journal(s, id);
    if (copy === undefined && (await this.stat()).isDirectory() && disk.status === "running" && disk.result.layers.cutout.state === "ready") {
      f.clock = START + 60000; copy = "copying";
      copy = await f.fork(s);
    }
  });
  f.llmHold.resolve(); await f.idle(s); t.mock.restoreAll();
  assert.ok(copy && copy !== "copying");
  const reboot = await f.start(copy); const terminal = (await f.get(reboot, id)).body;
  assert.equal(terminal.main.state, "ready"); assert.equal(terminal.layers.cutout.state, "timed_out");
  assert.equal(terminal.failure_stage, "cutout"); assert.equal(f.counts.llm, 1);
});

test("S13 recovery rejects a rollback checkpoint with different admission identity", async t => {
  const f = await fixture(t); f.hold("llm"); const s = await f.start();
  const id = (await f.post(s)).body.job_id; await f.llmEntered.promise;
  const copy = await f.fork(s), forged = await f.journal(s, id);
  forged.processingDeadlineAt = iso(START + 59000);
  await writeFile(join(copy, "jobs", `.${id}.checkpoint`), JSON.stringify(forged));
  await assert.rejects(f.start(copy), error => error.name === "JobStoreError"
    && error.cause.message === "Checkpoint identity cannot change");
  assert.equal(f.counts.llm, 1);
});

test("S13 isolated attempt scratch and child temporary files remain inside exact retention cleanup", async t => {
  const f = await fixture(t); f.plateError = stageError(); const s = await f.start();
  const id = (await f.post(s)).body.job_id; await f.idle(s);
  for (const suffix of [`.png.${uuid(9)}.tmp.${uuid(8)}.tmp`, `.cut.png.${uuid(9)}.tmp.isnet.tmp`, `.plate.jpg.${uuid(9)}.tmp.tmp`])
    await writeFile(join(s.directory, id + suffix), "offline personal scratch");
  await writeFile(join(s.directory, "unrelated.txt"), "preserve");
  f.clock = Date.parse(EXPIRY);
  assert.equal((await f.get(s, id)).status, 410);
  await s.sweepRetention();
  assert.deepEqual((await readdir(s.directory)).sort(), ["jobs", "unrelated.txt"]);
});

test("S13 all-ready checkpoint wins over deadline crossing during terminal journal directory sync", async t => {
  const f = await fixture(t); f.hold("llm"); const s = await f.start();
  const id = (await f.post(s)).body.job_id; await f.llmEntered.promise;
  const handle = await open(join(s.directory, "jobs"), "r"), prototype = Object.getPrototypeOf(handle), sync = prototype.sync;
  await handle.close(); let crossed = false;
  t.mock.method(prototype, "sync", async function (...args) {
    await sync.apply(this, args);
    if (!crossed && (await this.stat()).isDirectory() && (await f.journal(s, id)).status === "done") {
      crossed = true; f.clock = START + 60000;
    }
  });
  f.llmHold.resolve(); await f.idle(s); t.mock.restoreAll();
  assert.equal(crossed, true);
  const terminal = (await f.get(s, id)).body;
  assert.equal(terminal.status, "done"); assert.equal(terminal.layers.plate.state, "ready");
  assert.equal(terminal.error, undefined); assert.equal(terminal.failure_stage, undefined);
  assert.equal((await f.journal(s, id)).status, "done");
  assert.deepEqual(f.counts, { llm: 1, cutout: 1, plate: 1 });
});

test("S13 all-ready checkpoint recovers as 3D success before and after deadline with no repeated call", async t => {
  const f = await fixture(t); f.hold("llm"); const s = await f.start();
  const id = (await f.post(s)).body.job_id; await f.llmEntered.promise;
  const handle = await open(join(s.directory, "jobs"), "r"), prototype = Object.getPrototypeOf(handle), sync = prototype.sync;
  await handle.close(); let copy;
  t.mock.method(prototype, "sync", async function (...args) {
    await sync.apply(this, args);
    if (copy === undefined && (await this.stat()).isDirectory() && (await f.journal(s, id)).status === "done") {
      copy = "copying"; copy = await f.fork(s);
    }
  });
  f.llmHold.resolve(); await f.idle(s); t.mock.restoreAll();
  assert.ok(copy && copy !== "copying");
  const original = (await f.get(s, id)).body, reboot = await f.start(copy);
  const recovered = (await f.get(reboot, id)).body;
  assert.equal(recovered.status, "done"); assert.equal(recovered.error, undefined);
  assert.deepEqual(recovered.main, original.main); assert.deepEqual(recovered.layers, original.layers);
  assert.equal(recovered.processingDeadlineAt, iso(START + 60000));
  assert.equal((await f.journal(reboot, id)).status, "done");
  f.clock = START + 60000;
  const atDeadline = (await f.get(reboot, id)).body;
  assert.equal(atDeadline.status, "done"); assert.deepEqual(atDeadline.layers, original.layers);
  assert.deepEqual(f.counts, { llm: 1, cutout: 1, plate: 1 });
});

test("S13 read verification crossing deadline returns the committed terminal manifest", async t => {
  const f = await fixture(t); f.hold("cutout"); const s = await f.start();
  const id = (await f.post(s)).body.job_id; await f.cutoutEntered.promise;
  const handle = await open(join(s.directory, id + ".png"), "r"), prototype = Object.getPrototypeOf(handle), stream = prototype.createReadStream;
  await handle.close(); let crossed = false;
  t.mock.method(prototype, "createReadStream", function (...args) {
    const result = stream.apply(this, args);
    if (!crossed) { crossed = true; f.clock = START + 60000; }
    return result;
  });
  const receipt = (await f.get(s, id)).body; t.mock.restoreAll();
  assert.equal(crossed, true); assert.equal(receipt.status, "failed"); assert.equal(receipt.failure_stage, "cutout");
  assert.equal(receipt.main.state, "ready"); assert.equal(receipt.layers.cutout.state, "timed_out");
  assert.deepEqual(receipt, (await f.get(s, id)).body);
});

test("S13 all-ready explicit retry survives terminal bookkeeping cutoff and restart without another inference", async t => {
  const f = await fixture(t); f.plateError = stageError(); const s = await f.start();
  const id = (await f.post(s)).body.job_id; await f.idle(s); const failed = (await f.get(s, id)).body;
  f.plateError = undefined; f.hold("plate"); f.clock += 120000;
  const retryDeadline = f.clock + 60000;
  await f.retry(s, failed, 43); await f.plateEntered.promise;
  const handle = await open(join(s.directory, "jobs"), "r"), prototype = Object.getPrototypeOf(handle), sync = prototype.sync;
  await handle.close(); let copy;
  t.mock.method(prototype, "sync", async function (...args) {
    await sync.apply(this, args);
    const record = await f.journal(s, id);
    if (copy === undefined && (await this.stat()).isDirectory() && record.status === "done") {
      copy = "copying"; copy = await f.fork(s); f.clock = retryDeadline;
    }
  });
  f.plateHold.resolve(); await f.idle(s); t.mock.restoreAll();
  assert.ok(copy && copy !== "copying");
  const done = (await f.get(s, id)).body, reboot = await f.start(copy), restored = (await f.get(reboot, id)).body;
  for (const receipt of [done, restored]) {
    assert.equal(receipt.status, "done"); assert.deepEqual(receipt.main, failed.main); assert.deepEqual(receipt.layers.cutout, failed.layers.cutout);
    assert.equal(receipt.layers.plate.state, "ready"); assert.equal(receipt.processingDeadlineAt, failed.processingDeadlineAt);
    assert.equal(receipt.acceptedRetryProcessingDeadlineAt, iso(retryDeadline)); assert.equal(receipt.acceptedAttempt, 1);
  }
  assert.deepEqual(f.counts, { llm: 1, cutout: 1, plate: 2 });
});

// Parent explicitly superseded strict full-function-return A with a completion
// witness. The old three A counterexamples remain immutable in the RED snapshot.
for (const name of ["main", "cutout", "plate"]) {
  for (const boundary of ["witness temporary", "witness directory", "marker cleanup"]) {
    test(`S13 completion witness ${name}: ${boundary} may cross D only after resource persistence ACK`, async t => {
      const f = await fixture(t); f.hold("llm"); const s = await f.start();
      const id = (await f.post(s)).body.job_id; await f.llmEntered.promise;
      const handle = await open(join(s.directory, "jobs"), "r"), prototype = Object.getPrototypeOf(handle), sync = prototype.sync;
      await handle.close(); let copy, proof;
      t.mock.method(prototype, "sync", async function (...args) {
        await sync.apply(this, args);
        if (copy !== undefined) return;
        const stat = await this.stat(), record = await f.journal(s, id);
        const asset = name === "main" ? record.result.main : record.result.layers[name];
        if (record.status !== "running" || asset.state !== "ready") return;
        let temporaryProof;
        if (stat.isFile()) {
          for (const file of await readdir(join(s.directory, "jobs"))) {
            if (!file.startsWith(`.${id}.`) || !file.endsWith(".tmp")) continue;
            const path = join(s.directory, "jobs", file), info = await lstat(path);
            if (info.ino !== stat.ino || info.dev !== stat.dev) continue;
            const data = JSON.parse(await readFile(path, "utf8"));
            if (data.version === 1 && data.kind === "processing") temporaryProof = data;
          }
        }
        let storedProof;
        try { storedProof = JSON.parse(await readFile(join(s.directory, "jobs", `.${id}.witness`), "utf8")); }
        catch (error) { if (error.code !== "ENOENT") throw error; }
        const matches = value => value?.resources[name]?.qualifiedAt !== undefined
          && value.canonicalSha256 === createHash("sha256").update(JSON.stringify(record) + "\n").digest("hex");
        const marker = existsSync(join(s.directory, "jobs", `.${id}.checkpoint`));
        if (boundary === "witness temporary" ? matches(temporaryProof)
          : stat.isDirectory() && matches(storedProof) && (boundary === "marker cleanup" ? !marker : marker)) {
          proof = temporaryProof ?? storedProof; copy = "copying";
          f.clock = START + 60000; copy = await f.fork(s);
        }
      });
      f.llmHold.resolve(); await f.idle(s); t.mock.restoreAll();
      assert.ok(copy && copy !== "copying");
      assert.equal(proof.jobId, id); assert.equal(proof.attempt, 0);
      assert.equal(proof.processingDeadlineAt, iso(START + 60000));
      assert.ok(Date.parse(proof.resources[name].qualifiedAt) < START + 60000);
      const reboot = await f.start(copy);
      const current = (await f.get(s, id)).body, recovered = (await f.get(reboot, id)).body;
      assert.equal(name === "main" ? current.main.state : current.layers[name].state, "ready");
      const survived = boundary !== "witness temporary";
      assert.equal(name === "main" ? recovered.main.state : recovered.layers[name].state, survived ? "ready" : "timed_out");
      if (name !== "main") assert.equal(recovered.main.state, "ready");
      if (name === "plate") assert.equal(recovered.layers.cutout.state, "ready");
      assert.equal(current.status, name === "plate" ? "done" : "failed");
      assert.equal(recovered.status, survived && name === "plate" ? "done" : "failed");
      assert.equal(f.counts.llm, 1);
    });
  }
}

test("S13 completion witness invalid or missing candidate proof recovers anchor, never ready by file existence", async t => {
  const f = await fixture(t); f.hold("llm"); const s = await f.start();
  const id = (await f.post(s)).body.job_id; await f.llmEntered.promise;
  const handle = await open(join(s.directory, "jobs"), "r"), prototype = Object.getPrototypeOf(handle), sync = prototype.sync;
  await handle.close(); let copy;
  t.mock.method(prototype, "sync", async function (...args) {
    await sync.apply(this, args);
    if (copy !== undefined || !(await this.stat()).isDirectory()) return;
    const record = await f.journal(s, id);
    if (record.status !== "running" || record.result.layers.cutout.state !== "ready") return;
    const witness = JSON.parse(await readFile(join(s.directory, "jobs", `.${id}.witness`), "utf8"));
    if (witness.canonicalSha256 !== createHash("sha256").update(JSON.stringify(record) + "\n").digest("hex")) return;
    copy = "copying"; f.clock = START + 60000; copy = await f.fork(s);
  });
  f.llmHold.resolve(); await f.idle(s); t.mock.restoreAll(); assert.ok(copy && copy !== "copying");
  const mutations = {
    missing: async path => unlink(path),
    malformed: async path => writeFile(path, "{broken"),
    hash: proof => { proof.canonicalSha256 = "0".repeat(64); },
    job: proof => { proof.jobId = "another"; },
    attempt: proof => { proof.attempt++; },
    deadline: proof => { proof.processingDeadlineAt = iso(START + 59000); },
    resource: proof => { proof.resources.cutout.resourceSha256 = "0".repeat(64); },
    late: proof => { proof.resources.cutout.qualifiedAt = iso(START + 60000); },
    resourceJournal: proof => { proof.resources.cutout.canonicalSha256 = "0".repeat(64); },
    inventedLegacy: proof => { proof.resources.cutout = { legacy: true, resourceSha256: proof.resources.cutout.resourceSha256 }; },
    badtime: proof => { proof.resources.cutout.qualifiedAt = "invalid"; },
  };
  for (const [name, mutate] of Object.entries(mutations)) {
    const directory = await f.fork({ directory: copy }), path = join(directory, "jobs", `.${id}.witness`);
    if (["missing", "malformed"].includes(name)) await mutate(path);
    else { const proof = JSON.parse(await readFile(path, "utf8")); mutate(proof); await writeFile(path, JSON.stringify(proof)); }
    const reboot = await f.start(directory), terminal = (await f.get(reboot, id)).body;
    assert.equal(terminal.main.state, "ready", name); assert.equal(terminal.layers.cutout.state, "timed_out", name);
    assert.equal(existsSync(join(directory, id + ".cut.png")), true, name);
    assert.deepEqual(await readFile(join(directory, id + ".png")), MAIN);
  }
  assert.equal(f.counts.llm, 1);
});

test("S13 W3 witness retention crash after anchor unlink recovers unrelated history without expired work", async t => {
  const f = await fixture(t), s = await f.start();
  const id = (await f.post(s)).body.job_id; await f.idle(s);
  const survivor = (await f.post(s, { requestKey: uuid(81), expiresAt: "2027-04-13T09:00:00.000Z" })).body.job_id;
  await f.idle(s); const confirmed = (await f.get(s, survivor)).body, calls = { ...f.counts };
  const jobs = join(s.directory, "jobs"), canonical = join(jobs, id + ".json"), anchor = join(jobs, `.${id}.anchor`);
  const handle = await open(jobs, "r"), prototype = Object.getPrototypeOf(handle), sync = prototype.sync, directory = await handle.stat();
  await handle.close(); let copy, durablyRetired = false;
  const realUnlink = fsPromises.unlink;
  t.mock.method(prototype, "sync", async function (...args) {
    await sync.apply(this, args);
    const stat = await this.stat();
    if (stat.dev === directory.dev && stat.ino === directory.ino && !existsSync(canonical) && existsSync(anchor))
      durablyRetired = true;
  });
  t.mock.method(fsPromises, "unlink", async function (path, ...args) {
    await realUnlink.call(this, path, ...args);
    // Pause the real sweep exactly after removal of its mandatory recovery anchor.
    // Old code still has the canonical journal here; fixed code has already synced its retirement.
    if (path === anchor && copy === undefined) { copy = "copying"; copy = await f.fork(s); }
  });
  syncBuiltinESMExports(); f.clock = Date.parse(EXPIRY);
  try { await s.sweepRetention(); }
  finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  assert.ok(copy && copy !== "copying");
  const reboot = await f.start(copy);
  assert.equal((await f.request(reboot, "/healthz")).status, 200);
  assert.equal(durablyRetired, true);
  assert.equal((await f.get(reboot, id)).status, 404);
  assert.equal(existsSync(join(copy, "jobs", id + ".json")), false);
  assert.equal(existsSync(join(copy, id + ".png")), false);
  assert.equal((await f.request(reboot, `/art/${id}.png`)).status, 404);
  const restored = (await f.get(reboot, survivor)).body;
  assert.deepEqual(restored.main, confirmed.main); assert.deepEqual(restored.layers, confirmed.layers);
  assert.deepEqual(f.counts, calls);
});

test("S13 W3 witness retirement sync failure retains proofs for a reappearing journal and never dispatches", async t => {
  const f = await fixture(t), s = await f.start();
  const id = (await f.post(s)).body.job_id; await f.idle(s);
  const jobs = join(s.directory, "jobs"), canonical = join(jobs, id + ".json"), savedJournal = await readFile(canonical);
  const handle = await open(jobs, "r"), prototype = Object.getPrototypeOf(handle), sync = prototype.sync, directory = await handle.stat();
  await handle.close(); let copy;
  t.mock.method(prototype, "sync", async function (...args) {
    const stat = await this.stat();
    if (copy === undefined && stat.dev === directory.dev && stat.ino === directory.ino && !existsSync(canonical)) {
      copy = "copying"; copy = await f.fork(s);
      // The unlink has no directory ACK. Model power loss preserving its previously
      // durable canonical identity; proof files must still precede that retirement barrier.
      await writeFile(join(copy, "jobs", id + ".json"), savedJournal);
      throw Object.assign(new Error("offline retirement directory sync failure"), { code: "EIO" });
    }
    return sync.apply(this, args);
  });
  f.clock = Date.parse(EXPIRY);
  try { await assert.rejects(s.sweepRetention(), { code: "EIO" }); }
  finally { t.mock.restoreAll(); }
  assert.ok(copy && copy !== "copying");
  const reboot = await f.start(copy);
  assert.equal((await f.request(reboot, "/healthz")).status, 200);
  assert.equal((await f.get(reboot, id)).status, 404);
  assert.equal(existsSync(join(copy, id + ".png")), false);
  assert.equal(s.queue.owns(id), true); assert.equal((await f.get(s, id)).status, 410);
  // The failed pass consumed this job from the bounded iterator. Its next pass
  // reaches the end; ownership remains until a fresh scan finishes retirement.
  assert.deepEqual((await s.sweepRetention()).history, { scanned: 0, deleted: 0 });
  assert.equal(s.queue.owns(id), true); assert.equal((await f.get(s, id)).status, 410);
  await s.sweepRetention();
  assert.equal(s.queue.owns(id), false); assert.deepEqual(f.counts, { llm: 1, cutout: 1, plate: 1 });
});

for (const name of ["cutout", "plate"]) {
  test(`S13 W3 witness overlapping deadlines reject ${name} proof from an older attempt and preserve borrowed assets`, async t => {
    const f = await fixture(t); f[name + "Error"] = stageError(); f.hold(name);
    const s = await f.start(), id = (await f.post(s, { processingDeadlineAt: iso(START + 60000) })).body.job_id;
    await f[name + "Entered"].promise; f.clock = START + 10000; f[name + "Hold"].resolve();
    await f.idle(s); const failed = (await f.get(s, id)).body;
    f[name + "Error"] = undefined; f.hold(name); f.clock = START + 20000;
    assert.equal((await f.retry(s, failed, name === "cutout" ? 82 : 83,
      { processingDeadlineAt: failed.processingDeadlineAt })).status, 202);
    await f[name + "Entered"].promise; f.clock = START + 30000;
    const jobs = join(s.directory, "jobs"), handle = await open(jobs, "r"), prototype = Object.getPrototypeOf(handle), sync = prototype.sync;
    await handle.close(); let copy;
    t.mock.method(prototype, "sync", async function (...args) {
      await sync.apply(this, args);
      if (copy !== undefined || !(await this.stat()).isDirectory()) return;
      const record = await f.journal(s, id);
      if (record.status !== "running" || record.result.attempt !== 1 || record.result.layers[name].state !== "ready") return;
      const witness = JSON.parse(await readFile(join(jobs, `.${id}.witness`), "utf8"));
      if (witness.canonicalSha256 !== digest(JSON.stringify(record) + "\n")) return;
      copy = "copying"; copy = await f.fork(s);
    });
    f[name + "Hold"].resolve(); await f.idle(s); t.mock.restoreAll(); assert.ok(copy && copy !== "copying");
    const record = JSON.parse(await readFile(join(copy, "jobs", id + ".json"), "utf8"));
    const witnessPath = join(copy, "jobs", `.${id}.witness`), witness = JSON.parse(await readFile(witnessPath, "utf8"));
    const anchor = JSON.parse(await readFile(join(copy, "jobs", `.${id}.anchor`), "utf8"));
    assert.equal(record.processingDeadlineAt, record.layerRetries[0].processingDeadlineAt);
    assert.equal(witness.attempt, 1); assert.equal(witness.resources[name].attempt, 1);
    assert.equal(witness.resources.main.attempt, 0); assert.deepEqual(witness.resources.main, anchor.witness.resources.main);
    if (name === "plate") assert.deepEqual(witness.resources.cutout, anchor.witness.resources.cutout);
    const calls = { ...f.counts }, valid = await f.fork({ directory: copy }), accepted = await f.start(valid);
    const positive = (await f.get(accepted, id)).body;
    assert.equal(positive.layers[name].state, "ready"); assert.deepEqual(positive.main, failed.main);
    witness.resources[name].attempt = 0; // Only the nested attempt changes; D, hashes and timestamp still match.
    await writeFile(witnessPath, JSON.stringify(witness));
    const reboot = await f.start(copy), recovered = (await f.get(reboot, id)).body;
    assert.equal(recovered.layers[name].state, "unknown"); assert.deepEqual(recovered.main, failed.main);
    if (name === "plate") assert.deepEqual(recovered.layers.cutout, failed.layers.cutout);
    assert.equal(existsSync(join(copy, id + (name === "cutout" ? ".cut.png" : ".plate.jpg"))), true);
    assert.deepEqual(f.counts, calls); assert.equal(recovered.processingDeadlineAt, failed.processingDeadlineAt);
  });
}

test("S13 W3 witness new resource admission must match the current checkpoint even with a consistent older asset", () => {
  const job = { id: "a".repeat(24), processingReceivedAt: iso(START), processingDeadlineAt: iso(START + 60000),
    layerRetries: [{ processingReceivedAt: iso(START + 20000), processingDeadlineAt: iso(START + 60000) }],
    result: { attempt: 1, main: { state: "pending" }, layers: { cutout: { state: "ready", attempt: 0 }, plate: { state: "blocked" } } } };
  const serialized = JSON.stringify(job) + "\n", canonicalSha256 = digest(serialized), qualifiedAt = iso(START + 30000);
  const witness = { version: 1, jobId: job.id, attempt: 1, processingDeadlineAt: job.processingDeadlineAt,
    attemptDeadlineAt: job.processingDeadlineAt, canonicalSha256, kind: "processing", qualifiedAt,
    resources: { cutout: { jobId: job.id, attempt: 0, processingDeadlineAt: job.processingDeadlineAt,
      attemptDeadlineAt: job.processingDeadlineAt, canonicalSha256, qualifiedAt, resourceSha256: digest(JSON.stringify(job.result.layers.cutout)) } } };
  validateCheckpointWitness(witness, job, serialized); // Earlier borrowed proof/asset may be consistent in isolation.
  assert.throws(() => validateWitnessTransition({ resources: {} }, witness), TypeError);
});
