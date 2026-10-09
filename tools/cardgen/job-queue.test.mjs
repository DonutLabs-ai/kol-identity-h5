import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { JobStoreError, PersistentJobQueue, QueueClosedError, QueueFullError } from "./job-queue.mjs";

function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "cardgen-job-queue-"));
  const queues = [], gates = [];
  let expectedStoreFailure = false;
  t.after(async () => {
    gates.forEach((gate) => gate.resolve());
    const closed = await Promise.allSettled(queues.map((queue) => queue.close()));
    await rm(directory, { recursive: true, force: true });
    if (!expectedStoreFailure) assert.ok(closed.every((result) => result.status === "fulfilled"));
  });
  return {
    directory,
    gate() { const gate = deferred(); gates.push(gate); return gate; },
    queue(options) {
      const queue = new PersistentJobQueue({ directory, maxActive: 1, maxQueued: 8, ...options });
      queues.push(queue);
      return queue;
    },
    expectStoreFailure() { expectedStoreFailure = true; },
    async disk(id) { return JSON.parse(await readFile(join(directory, `${id}.json`), "utf8")); },
  };
}

function record(id, sequence, status, extra = {}) {
  return {
    id, sequence, payload: { type: "scalper", avatarPath: `/private/${id}.png` },
    status, stage: status, createdAt: "2026-10-09T00:00:00.000Z",
    updatedAt: "2026-10-09T00:00:00.000Z", ...extra,
  };
}

test("same ID reserves singleflight before prepare and persists before running", async (t) => {
  const f = await fixture(t), preparing = f.gate(), prepared = f.gate(), started = f.gate(), release = f.gate();
  let prepares = 0, runs = 0;
  const queue = f.queue({
    maxQueued: 0,
    async run(job, checkpoint) {
      runs++;
      assert.equal((await f.disk(job.id)).status, "running");
      job.stage = "gemini";
      job.metadata = { attempt: "attempt-one" };
      await checkpoint(job);
      assert.equal((await f.disk(job.id)).stage, "gemini");
      started.resolve();
      await release.promise;
    },
  });
  await queue.initialize();
  const prepare = async (payload) => {
    prepares++; preparing.resolve(); await prepared.promise;
    payload.avatarPath = "/private/winning-avatar.png";
  };
  const first = queue.submit("same", { type: "scalper" }, prepare);
  const duplicates = Array.from({ length: 50 }, () => queue.submit("same", { type: "ignored" }, prepare));
  await preparing.promise;
  assert.equal(prepares, 1);
  assert.equal(runs, 0);
  assert.deepEqual(queue.stats(), { active: 1, queued: 0, max_active: 1, max_queued: 0 });
  assert.equal(queue.get("same"), undefined);
  assert.deepEqual(await readdir(f.directory), []);
  await assert.rejects(queue.submit("overflow", {}), QueueFullError);
  prepared.resolve();
  const admitted = await first, repeated = await Promise.all(duplicates);
  await started.promise;
  assert.equal(admitted.created, true);
  assert.ok(repeated.every((result) => !result.created && result.job === admitted.job));
  assert.equal(admitted.job.payload.avatarPath, "/private/winning-avatar.png");
  assert.equal(runs, 1);
  release.resolve();
  await queue.close();
  assert.equal((await f.disk("same")).status, "done");
});

test("active concurrency and FIFO admission are bounded across different IDs", async (t) => {
  const f = await fixture(t);
  const starts = new Map(), releases = new Map(), order = [];
  for (const id of ["a", "b", "c", "d"]) { starts.set(id, f.gate()); releases.set(id, f.gate()); }
  let active = 0, peak = 0;
  const queue = f.queue({ maxActive: 2, maxQueued: 2, async run(job) {
    active++; peak = Math.max(peak, active); order.push(job.id);
    starts.get(job.id).resolve(); await releases.get(job.id).promise; active--;
  } });
  await queue.initialize();
  await Promise.all(["a", "b", "c", "d"].map((id) => queue.submit(id, { type: "scalper" })));
  await Promise.all([starts.get("a").promise, starts.get("b").promise]);
  assert.deepEqual(queue.stats(), { active: 2, queued: 2, max_active: 2, max_queued: 2 });
  let rejectedPrepare = 0;
  await assert.rejects(queue.submit("overflow", {}, () => { rejectedPrepare++; }), QueueFullError);
  assert.equal(rejectedPrepare, 0);
  assert.equal((await queue.submit("d", { changed: true })).created, false);
  releases.get("b").resolve(); await starts.get("c").promise;
  releases.get("c").resolve(); await starts.get("d").promise;
  assert.deepEqual(order, ["a", "b", "c", "d"]);
  assert.equal(peak, 2);
  releases.get("a").resolve(); releases.get("d").resolve();
  await queue.close();
  assert.equal(active, 0);
});

test("prepare failure admits no job, releases its slot and unblocks the FIFO successor", async (t) => {
  const f = await fixture(t), preparing = f.gate(), releasePrepare = f.gate(), secondStarted = f.gate(), releaseRun = f.gate();
  const failure = new Error("avatar atomic write failed");
  const queue = f.queue({ maxQueued: 1, async run(job) {
    assert.equal(job.id, "second"); secondStarted.resolve(); await releaseRun.promise;
  } });
  await queue.initialize();
  const first = queue.submit("first", {}, async () => { preparing.resolve(); await releasePrepare.promise; throw failure; });
  const rejected = assert.rejects(first, (error) => error === failure);
  await preparing.promise;
  await queue.submit("second", {});
  await assert.rejects(queue.submit("full", {}), QueueFullError);
  releasePrepare.resolve(); await rejected; await secondStarted.promise;
  assert.equal(queue.get("first"), undefined);
  assert.ok(!(await readdir(f.directory)).includes("first.json"));
  releaseRun.resolve(); await queue.close();
});

test("provider failure stores a safe category and does not strand the next job", async (t) => {
  const f = await fixture(t), firstStarted = f.gate(), failFirst = f.gate(), secondStarted = f.gate(), releaseSecond = f.gate();
  const queue = f.queue({ async run(job) {
    if (job.id === "first") {
      firstStarted.resolve(); await failFirst.promise;
      throw Object.assign(new Error("PII and secret provider response"), { code: "provider_throttled" });
    }
    secondStarted.resolve(); await releaseSecond.promise;
  } });
  await queue.initialize(); await queue.submit("first", {}); await firstStarted.promise;
  await queue.submit("second", {}); failFirst.resolve(); await secondStarted.promise;
  assert.equal(queue.get("first").status, "failed");
  assert.equal((await f.disk("first")).error, "provider_throttled");
  assert.ok(!(await readFile(join(f.directory, "first.json"), "utf8")).includes("PII"));
  releaseSecond.resolve(); await queue.close();
  assert.equal((await f.disk("second")).status, "done");
});

test("unknown provider errors do not persist their raw messages", async (t) => {
  const f = await fixture(t), started = f.gate(), release = f.gate();
  const queue = f.queue({ async run() { started.resolve(); await release.promise; throw new Error("private email/token/body"); } });
  await queue.initialize(); await queue.submit("failed", {}); await started.promise;
  release.resolve(); await queue.close();
  assert.equal((await f.disk("failed")).error, "provider_error");
});

test("checkpoints preserve metadata in order and publish complete JSON by rename", async (t) => {
  const f = await fixture(t), checkpointed = f.gate(), release = f.gate();
  const queue = f.queue({ async run(job, checkpoint) {
    job.stage = "before_paid_call"; job.metadata = { requestId: "known-request" };
    const committing = checkpoint(job);
    assert.equal(queue.get(job.id).stage, "running");
    await committing;
    assert.equal(queue.get(job.id).stage, "before_paid_call");
    const returned = queue.get(job.id);
    returned.payload.injected = "caller mutation";
    assert.equal(queue.get(job.id).payload.injected, undefined);
    assert.equal((await f.disk(job.id)).stage, "before_paid_call");
    job.stage = "main_saved"; job.outputs = { image: "/private/known.png" };
    await queue.checkpoint(job);
    const saved = await f.disk(job.id);
    assert.equal(saved.status, "running");
    assert.equal(saved.metadata.requestId, "known-request");
    assert.equal(saved.outputs.image, "/private/known.png");
    assert.equal(saved.stage, "main_saved");
    checkpointed.resolve(); await release.promise;
  } });
  await queue.initialize(); await queue.submit("checkpoint", {}); await checkpointed.promise;
  release.resolve(); await queue.close();
  assert.deepEqual(await readdir(f.directory), ["checkpoint.json"]);
  assert.equal((await f.disk("checkpoint")).status, "done");
  await assert.rejects(queue.checkpoint(queue.get("checkpoint")), TypeError);
});

test("failed durable admission starts no provider and stops further paid dispatch", async (t) => {
  const f = await fixture(t); f.expectStoreFailure();
  let runs = 0;
  const queue = f.queue({ async run() { runs++; } });
  assert.equal(queue.healthy, false);
  await queue.initialize(); await mkdir(join(f.directory, "blocked.json"));
  assert.equal(queue.healthy, true);
  await assert.rejects(queue.submit("blocked", {}), (error) => error instanceof JobStoreError && /Cannot persist job blocked/.test(error.message));
  assert.equal(runs, 0);
  assert.equal(queue.healthy, false);
  assert.equal(queue.get("blocked"), undefined);
  await assert.rejects(queue.submit("next", {}), JobStoreError);
  await assert.rejects(queue.close(), JobStoreError);
  assert.ok((await readdir(f.directory)).every((file) => !file.endsWith(".tmp")));
});

test("close drains started work, parks queued jobs and keeps duplicates readable", async (t) => {
  const f = await fixture(t), started = f.gate(), release = f.gate();
  const runs = [];
  const queue = f.queue({ async run(job) { runs.push(job.id); started.resolve(); await release.promise; } });
  await queue.initialize(); await queue.submit("active", {}); await started.promise;
  await queue.submit("parked", {});
  let closed = false;
  const closing = queue.close().then(() => { closed = true; });
  await Promise.resolve(); assert.equal(closed, false);
  await assert.rejects(queue.submit("new", {}), QueueClosedError);
  assert.equal((await queue.submit("parked", {})).created, false);
  release.resolve(); await closing;
  assert.deepEqual(runs, ["active"]);
  assert.equal((await f.disk("active")).status, "done");
  assert.equal((await f.disk("parked")).status, "queued");
  assert.deepEqual(queue.stats(), { active: 0, queued: 1, max_active: 1, max_queued: 8 });
});

test("close during prepare waits for admission but dispatches no new work", async (t) => {
  const f = await fixture(t), preparing = f.gate(), release = f.gate();
  let runs = 0;
  const queue = f.queue({ async run() { runs++; } });
  await queue.initialize();
  const admission = queue.submit("prepared", { avatarPath: "/private/avatar.png" }, async () => { preparing.resolve(); await release.promise; });
  await preparing.promise;
  const closing = queue.close(); release.resolve(); await admission; await closing;
  assert.equal(runs, 0);
  assert.equal((await f.disk("prepared")).status, "queued");
});

test("close immediately after durable admission parks work whose runner has not started", async (t) => {
  const f = await fixture(t);
  let runs = 0;
  const queue = f.queue({ async run() { runs++; } });
  await queue.initialize();
  await queue.submit("not-started", {});
  await queue.close();
  assert.equal(runs, 0);
  assert.equal((await f.disk("not-started")).status, "queued");
  assert.deepEqual(queue.stats(), { active: 0, queued: 1, max_active: 1, max_queued: 8 });
});

test("restart recovers FIFO queued jobs and terminals, and fails running work as unknown", async (t) => {
  const f = await fixture(t), firstStarted = f.gate(), releaseFirst = f.gate(), secondStarted = f.gate(), releaseSecond = f.gate();
  const terminal = record("done", 3, "done", { outputs: { image: "saved.png" } });
  const failed = record("failed", 4, "failed", { error: "provider_rejected" });
  const rows = [record("z-first", 1, "queued"), record("a-second", 2, "queued"), terminal, failed,
    record("unknown", 5, "running", { stage: "paid_call", outputs: { image: "known-but-not-reconciled.png" } })];
  await Promise.all(rows.map((job) => writeFile(join(f.directory, `${job.id}.json`), JSON.stringify(job))));
  await writeFile(join(f.directory, "known-but-not-reconciled.png"), "existing main image");
  await writeFile(join(f.directory, ".uncommitted.tmp"), "incomplete write");
  const runs = [];
  const queue = f.queue({ async run(job) {
    assert.equal((await f.disk("unknown")).error, "provider_result_unknown");
    runs.push(job.id);
    if (job.id === "z-first") { firstStarted.resolve(); await releaseFirst.promise; }
    else { secondStarted.resolve(); await releaseSecond.promise; }
  } });
  await Promise.all([queue.initialize(), queue.initialize()]); await firstStarted.promise;
  assert.deepEqual(queue.get("done"), terminal);
  assert.deepEqual(queue.get("failed"), failed);
  assert.equal(queue.get("unknown").status, "failed");
  assert.equal(queue.get("unknown").stage, "paid_call");
  assert.equal((await queue.submit("unknown", {})).created, false);
  releaseFirst.resolve(); await secondStarted.promise;
  assert.deepEqual(runs, ["z-first", "a-second"]);
  releaseSecond.resolve(); await queue.close();
  assert.equal((await f.disk("a-second")).status, "done");
});

test("corrupt job records fail startup before any queued provider is dispatched", async (t) => {
  const f = await fixture(t); f.expectStoreFailure();
  let runs = 0;
  await writeFile(join(f.directory, "valid.json"), JSON.stringify(record("valid", 1, "queued")));
  await writeFile(join(f.directory, "corrupt.json"), "{private malformed record");
  const queue = f.queue({ async run() { runs++; } });
  await assert.rejects(queue.initialize(), (error) => error instanceof JobStoreError
    && error.message === "Cannot recover job record corrupt.json" && !error.message.includes("private"));
  assert.equal(runs, 0);
});

test("invalid persisted shapes, filenames and duplicate sequences also fail startup", async (t) => {
  for (const kind of ["shape", "filename", "sequence"]) {
    await t.test(kind, async (sub) => {
      const f = await fixture(sub); f.expectStoreFailure();
      const job = record("valid", 1, "queued");
      if (kind === "shape") job.status = "invented";
      await writeFile(join(f.directory, kind === "filename" ? "different.json" : "valid.json"), JSON.stringify(job));
      if (kind === "sequence") await writeFile(join(f.directory, "second.json"), JSON.stringify(record("second", 1, "queued")));
      const queue = f.queue({ async run() { assert.fail("Corrupt store dispatched"); } });
      await assert.rejects(queue.initialize(), JobStoreError);
    });
  }
});

test("configuration and JSON input are validated before reserving admission", async (t) => {
  const f = await fixture(t);
  for (const limits of [{ maxActive: 0 }, { maxQueued: -1 }, { maxActive: 1.5 }]) {
    assert.throws(() => f.queue({ run() {}, ...limits }), TypeError);
  }
  const queue = f.queue({ run() {} });
  await assert.rejects(queue.submit("early", {}), /Initialize/);
  await queue.initialize();
  for (const id of ["../escape", "", "id.json"]) await assert.rejects(queue.submit(id, {}), TypeError);
  for (const payload of [undefined, { big: 1n }, { invalid: NaN }, { bad: () => {} }]) {
    await assert.rejects(queue.submit("invalid", payload), TypeError);
  }
  assert.deepEqual(await readdir(f.directory), []);
  assert.equal(queue.get("invalid"), undefined);
});
