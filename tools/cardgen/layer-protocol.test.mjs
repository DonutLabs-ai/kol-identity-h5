import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, writeFile, rm, readdir, cp, symlink, open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { createCardArtService } from "./card-art-service.mjs";
import { readServerConfig } from "./server-config.mjs";
import { pipelineDescriptor } from "./pipeline-version.mjs";
import { expiresAt, jobExpiresAt } from "./retention.mjs";
import { RESULT_CONTRACT, retryCommand } from "./layer-result.mjs";
import { createBedrockCutout } from "./bedrock-cutout.mjs";

const exec = promisify(execFile);
const MAIN = await readFile(new URL("./test-fixtures/main.png", import.meta.url));
const CUT = await readFile(new URL("./test-fixtures/cut.png", import.meta.url));
const KEY = "11111111-1111-4111-8111-111111111111";
const TOKEN = "offline-private-backend-key";
const CREATED = "2026-01-31T12:00:00.000Z";
const EXPIRY = new Date(expiresAt(CREATED)).toISOString();
const uuid = n => `22222222-2222-4222-8222-${String(n).padStart(12, "0")}`;
const error = category => Object.assign(new Error("PRIVATE stage detail"), { category });
function gate() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

async function fixture(t) {
  const cache = await mkdtemp(join(tmpdir(), "cardgen-layers-")), dirs = [cache], services = [], gates = [];
  const f = { cache, clock: Date.parse(CREATED), counts: { llm: 0, cutout: 0, plate: 0 },
    cutErrors: [], plateErrors: [], healthy: true,
    gate() { const g = gate(); gates.push(g); return g; },
    async stop(s) {
      if (s.server.listening) await new Promise(done => { s.server.close(done); s.server.closeAllConnections(); });
      await s.close();
    },
    async start(options = {}) {
      const config = readServerConfig({ CARD_AUTH_TOKEN: TOKEN, CARD_REQUIRE_AUTH: "true", CARD_SOURCE_REVISION: "source-v1",
        CARD_RETENTION_SWEEP_MS: "600000", ...options.env });
      const cutout = async (_image, checkpoint, paths) => {
        f.counts.cutout++; await checkpoint(); await paths.onDispatch();
        await paths.onReceipt({ newProviderRequests: 0, costUSD: null, reportedSeconds: null });
        if (f.cutHold) { f.cutEntered.resolve(); await f.cutHold.promise; }
        const failure = f.cutErrors.shift(); if (failure) throw failure;
        return { png: f.cutBytes || CUT, seconds: 0.01 };
      };
      cutout.healthy = () => f.healthy;
      const s = await createCardArtService({ config, cache: options.cache || cache,
        prompts: { version: "sean-offline-v1", types: { sniper: "Frozen offline prompt" } },
        apiKey: "offline-only", now: () => f.clock, cutout: options.cutout || cutout,
        async generate(args) {
          f.counts.llm++; args.beforeDispatch(); await args.onDispatch();
          if (f.mainHold) { f.mainEntered.resolve(); await f.mainHold.promise; }
          if (f.mainError) throw f.mainError;
          await args.onReceipt({ newProviderRequests: 1, costUSD: 0.14, reportedSeconds: 0.01 });
          return { png: MAIN, cost: 0.14, secs: 0.01 };
        },
        validateMain: options.badMain ? async () => { throw error("invalid_output"); } : undefined,
        async makePlate(source, cut, target) {
          f.counts.plate++;
          if (f.plateHold) { f.plateEntered.resolve(); await f.plateHold.promise; }
          const failure = f.plateErrors.shift(); if (failure) throw failure;
          const { stdout } = await exec("python3", [new URL("./harness/plate.py", import.meta.url).pathname, source, cut, target],
            { timeout: 30000, maxBuffer: 4096 });
          return JSON.parse(stdout);
        },
        diskInfo: async () => ({ bavail: f.noSpace ? 1 : 100 * 1024 ** 3, bsize: 1 }),
        logger: { log() {}, error() {} },
      });
      services.push(s); s.server.listen(0, "127.0.0.1"); await once(s.server, "listening");
      return { ...s, config, cache: options.cache || cache, base: `http://127.0.0.1:${s.server.address().port}` };
    },
    async request(s, path, body, authorized = true) {
      const r = await fetch(s.base + path, { method: body === undefined ? "GET" : "POST",
        headers: { ...(authorized ? { Authorization: "Bearer " + TOKEN } : {}), "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: r.status, body: await r.json() };
    },
    post(s, key = KEY, deadline = EXPIRY) { return f.request(s, "/v1/identity/card-art", { type: "sniper", avatar_data: MAIN.toString("base64"),
      requestKey: key, expiresAt: deadline, expectedContract: pipelineDescriptor(s.config) }); },
    get(s, id) { return f.request(s, "/v1/identity/card-art/" + id); },
    retry(s, receipt, token = uuid(1), overrides = {}) {
      return f.request(s, `/v1/identity/card-art/${receipt.job_id}/retry-layers`, {
        requestKey: receipt.requestKey, expiresAt: receipt.expiresAt, expectedContract: receipt.workerContract,
        retryToken: token, expectedAttempt: receipt.attempt, mainSha256: receipt.main.sha256, ...overrides,
      });
    },
    async terminal(s, id) {
      const until = Date.now() + 20000;
      while (Date.now() < until) {
        const result = await f.get(s, id);
        if (["done", "failed"].includes(result.body.status)) return result.body;
        await new Promise(done => setTimeout(done, 10));
      }
      throw new Error("Offline layer job did not settle");
    },
    async journal(s, id) { return JSON.parse(await readFile(join(s.cache, "jobs", id + ".json"), "utf8")); },
    async fork(s) {
      const dir = await mkdtemp(join(tmpdir(), "cardgen-crash-snapshot-")); dirs.push(dir);
      await cp(s.cache, dir, { recursive: true }); return dir;
    },
  };
  t.after(async () => { gates.forEach(g => g.resolve()); for (const s of services) await f.stop(s); for (const dir of dirs) await rm(dir, { recursive: true, force: true }); });
  return f;
}

test("formal pending receipt stays sealed; authenticated request-key GET reconciles lost ACK without POST", async t => {
  const f = await fixture(t); f.cutHold = f.gate(); f.cutEntered = f.gate();
  const s = await f.start(), admitted = (await f.post(s)).body;
  await f.cutEntered.promise;
  const waiting = (await f.get(s, admitted.job_id)).body;
  assert.equal(waiting.result_contract, RESULT_CONTRACT); assert.equal(waiting.attempt, 0);
  assert.equal(waiting.main.state, "ready"); assert.equal(waiting.main.validated, true);
  assert.equal(waiting.layers.cutout.state, "running"); assert.equal(waiting.layers.plate.state, "blocked");
  assert.equal(waiting.image_url, undefined); assert.equal(waiting.failure_stage, undefined);
  const route = "/v1/identity/card-art/requests/" + KEY;
  assert.equal((await f.request(s, route, undefined, false)).status, 401);
  for (let i = 0; i < 3; i++) assert.equal((await f.request(s, route)).body.job_id, admitted.job_id);
  assert.equal((await f.request(s, "/v1/identity/card-art/requests/" + uuid(99))).status, 404);
  assert.equal(f.counts.llm, 1);
  f.cutHold.resolve(); f.cutHold = undefined;
  const done = await f.terminal(s, admitted.job_id);
  assert.equal(done.status, "done"); assert.ok(Object.values(done.layers).every(x => x.state === "ready"));
  assert.equal(done.expiresAt, EXPIRY); assert.deepEqual(done.workerContract, pipelineDescriptor(s.config));
  assert.ok(!JSON.stringify(done).includes("PRIVATE"));
});

for (const category of ["provider_error", "provider_timeout"]) {
  test(`confirmed cutout ${category}: same-main CAS retry handles blocked plate without LLM`, async t => {
    const f = await fixture(t); f.cutErrors.push(error(category));
    const s = await f.start(), id = (await f.post(s)).body.job_id, failed = await f.terminal(s, id);
    assert.equal(failed.main.state, "ready"); assert.equal(failed.layers.cutout.state, category === "provider_timeout" ? "timed_out" : "failed");
    assert.equal(failed.layers.plate.state, "blocked"); assert.equal(failed.failure_stage, "cutout");
    const original = await f.journal(s, id);
    f.cutHold = f.gate(); f.cutEntered = f.gate();
    const replies = await Promise.all([f.retry(s, failed), f.retry(s, failed)]);
    assert.ok(replies.every(x => x.status === 202));
    assert.ok(replies.every(x => x.body.retryToken === uuid(1) && x.body.attempt === 1));
    assert.deepEqual(replies.map(x => x.body.replayed).sort(), [false, true]);
    await f.cutEntered.promise;
    assert.equal((await f.retry(s, failed, uuid(2))).body.error, "attempt_conflict");
    assert.equal((await f.retry(s, failed, uuid(1), { mainSha256: "0".repeat(64) })).body.error, "retry_token_conflict");
    f.cutHold.resolve(); f.cutHold = undefined;
    const repaired = await f.terminal(s, id), saved = await f.journal(s, id);
    assert.equal(repaired.status, "done"); assert.equal(repaired.attempt, 1);
    assert.equal(repaired.retryToken, uuid(1)); assert.equal(saved.result.retryToken, uuid(1));
    assert.equal((await f.request(s, "/v1/identity/card-art/requests/" + KEY)).body.retryToken, uuid(1));
    assert.deepEqual(repaired.main, failed.main); assert.equal(repaired.expiresAt, failed.expiresAt);
    assert.deepEqual(repaired.workerContract, failed.workerContract);
    assert.deepEqual(saved.stageSamples, original.stageSamples); assert.equal(saved.layerAttemptSamples.length, 1);
    assert.equal(saved.layerAttemptSamples[0].stages.cutout.newProviderRequests, 0);
    assert.equal(saved.layerAttemptSamples[0].stages.plate.costUSD, null);
    assert.deepEqual(f.counts, { llm: 1, cutout: 2, plate: 1 });
    const replay = await f.retry(s, failed); assert.equal(replay.body.acceptedAttempt, 1); assert.equal(replay.body.replayed, true);
    assert.equal((await f.journal(s, id)).layerRetryReplayCount, 2);
  });
  test(`confirmed plate ${category}: preserve cutout across source revision/reboot and original calendar expiry`, async t => {
    const f = await fixture(t); f.plateErrors.push(error(category));
    const first = await f.start(), id = (await f.post(first)).body.job_id, failed = await f.terminal(first, id);
    const original = await f.journal(first, id);
    assert.equal(failed.layers.cutout.state, "ready"); assert.equal(failed.layers.plate.state, category === "provider_timeout" ? "timed_out" : "failed");
    await f.stop(first); f.healthy = false;
    const second = await f.start({ env: { CARD_SOURCE_REVISION: "source-v2" } });
    const ack = await f.retry(second, failed);
    assert.equal(ack.status, 202); assert.equal(ack.body.acceptedAttempt, 1);
    const repaired = await f.terminal(second, id), record = await f.journal(second, id);
    assert.equal(repaired.status, "done"); assert.deepEqual(repaired.main, failed.main);
    assert.deepEqual(repaired.layers.cutout, failed.layers.cutout);
    assert.deepEqual(repaired.workerContract, failed.workerContract); assert.equal(repaired.expiresAt, EXPIRY);
    assert.deepEqual(record.stageSamples, original.stageSamples);
    assert.equal(record.layerAttemptSamples[0].stages.cutout.attempts, 0);
    assert.equal(record.layerAttemptSamples[0].stages.cutout.reason, "cache_asset");
    assert.equal(record.layerRetries[0].executionSourceRevision, "source-v2");
    assert.deepEqual(f.counts, { llm: 1, cutout: 1, plate: 2 });
    await f.stop(second); const reboot = await f.start({ env: { CARD_SOURCE_REVISION: "source-v2" } });
    assert.equal((await f.retry(reboot, failed)).body.replayed, true);
    assert.deepEqual(f.counts, { llm: 1, cutout: 1, plate: 2 });
    await writeFile(join(f.cache, "approved-static-default.png"), "retained nonpersonal fixture");
    for (const suffix of [".cut.png.tmp.isnet.tmp", ".plate.jpg.tmp.tmp", ".plate.jpg.tmp", `.cut.png.tmp.${uuid(9)}.tmp`])
      await writeFile(join(f.cache, id + suffix), "bounded personal scratch");
    f.clock = Date.parse(EXPIRY);
    assert.equal((await f.get(reboot, id)).status, 410);
    assert.equal((await f.retry(reboot, failed)).status, 410);
    assert.equal((await f.request(reboot, "/v1/identity/card-art/requests/" + KEY)).status, 410);
    assert.equal((await f.request(reboot, failed.main.url)).status, 410);
    await reboot.sweepRetention();
    assert.ok(!(await readdir(f.cache)).some(name => name.startsWith(id)));
    assert.deepEqual(await readdir(join(f.cache, "jobs")), []);
    assert.ok((await readdir(f.cache)).includes("approved-static-default.png"));
  });
}

test("bad main and invalid derivative raster have distinct authority; absent avatar never starts LLM", async t => {
  const f = await fixture(t), s = await f.start({ badMain: true });
  const noAvatar = await f.request(s, "/v1/identity/card-art", { type: "sniper" });
  assert.equal(noAvatar.status, 400); assert.equal(f.counts.llm, 0);
  const id = (await f.post(s)).body.job_id, failed = await f.terminal(s, id);
  assert.equal(failed.main.state, "failed"); assert.equal(failed.main.validated, false); assert.equal(failed.main.url, undefined);
  assert.equal(failed.failure_stage, "validation"); assert.equal(f.counts.cutout, 0);
  assert.equal((await f.request(s, `/art/${id}.png`)).status, 404);
  assert.equal((await f.retry(s, failed, uuid(1), { mainSha256: "0".repeat(64) })).status, 409);
  const second = await fixture(t); second.cutBytes = MAIN;
  const other = await second.start(), badId = (await second.post(other)).body.job_id, bad = await second.terminal(other, badId);
  assert.equal(bad.main.state, "ready"); assert.equal(bad.layers.cutout.state, "failed");
  assert.equal(bad.failure_stage, "cutout"); assert.equal(second.counts.plate, 0);
  assert.equal((await second.journal(other, badId)).stageSamples.stages.llm.outcome, "success");
});

test("unknown derivative outcome cannot retry or masquerade as LLM failure; identity/auth/expiry conflicts are distinct", async t => {
  const f = await fixture(t); f.cutErrors.push(error("provider_result_unknown"));
  const s = await f.start(), id = (await f.post(s)).body.job_id, unknown = await f.terminal(s, id);
  assert.equal(unknown.layers.cutout.state, "unknown"); assert.equal(unknown.failure_stage, "unknown");
  assert.equal((await f.retry(s, unknown)).body.error, "retry_not_allowed");
  assert.equal((await f.retry(s, unknown, uuid(1), { requestKey: uuid(99) })).body.error, "request_key_conflict");
  assert.equal((await f.retry(s, unknown, uuid(1), { expiresAt: "2026-07-30T12:00:00.000Z" })).body.error, "expiry_conflict");
  const wrong = { ...unknown.workerContract, cutoutRevision: "sha256:" + "0".repeat(64) };
  assert.equal((await f.retry(s, unknown, uuid(1), { expectedContract: wrong })).body.error, "contract_changed");
  const request = { requestKey: KEY, expiresAt: EXPIRY, expectedContract: unknown.workerContract, retryToken: uuid(1), expectedAttempt: 0, mainSha256: unknown.main.sha256 };
  assert.equal((await f.request(s, `/v1/identity/card-art/${id}/retry-layers`, request, false)).status, 401);
  assert.equal((await f.post(s)).body.job_id, id); assert.deepEqual(f.counts, { llm: 1, cutout: 1, plate: 0 });
  const record = await f.journal(s, id);
  assert.equal(record.stageSamples.stages.llm.outcome, "success");
  assert.equal(record.stageSamples.stages.cutout.outcome, "unknown");
  assert.equal(record.cacheReplayCount, 1);
});

test("running retry crash snapshot persists token, successful assets and observations without reexecution", async t => {
  const f = await fixture(t); f.plateErrors.push(error("provider_error"));
  const s = await f.start(), id = (await f.post(s)).body.job_id, failed = await f.terminal(s, id);
  f.plateHold = f.gate(); f.plateEntered = f.gate();
  await f.retry(s, failed); await f.plateEntered.promise;
  const active = await f.journal(s, id), fork = await f.fork(s), before = { ...f.counts };
  const recovered = await f.start({ cache: fork });
  const state = (await f.get(recovered, id)).body;
  assert.equal(state.attempt, 1); assert.equal(state.layers.plate.state, "unknown");
  assert.equal(state.retryToken, uuid(1)); assert.equal(active.result.retryToken, uuid(1));
  assert.deepEqual(state.main, failed.main); assert.deepEqual(state.layers.cutout, failed.layers.cutout);
  assert.equal((await f.retry(recovered, failed)).body.acceptedAttempt, 1);
  assert.equal((await f.retry(recovered, state, uuid(2))).body.error, "retry_not_allowed");
  assert.deepEqual(f.counts, before);
  const record = await f.journal(recovered, id);
  assert.deepEqual(record.stageSamples, active.stageSamples);
  assert.equal(record.layerAttemptSamples[0].stages.plate.outcome, "unknown");
  assert.equal(record.layerAttemptSamples[0].stages.plate.reason, "crash_unknown");
  f.plateHold.resolve(); f.plateHold = undefined;
});

for (const legacy of [false, true]) {
test(`queued ${legacy ? "legacy" : "current"} retry reboot records actual B execution and preserves A acceptance`, async t => {
  const f = await fixture(t); f.plateErrors.push(error("provider_error"));
  const s = await f.start({ env: { CARD_MAX_ACTIVE_JOBS: "1" } }), id = (await f.post(s)).body.job_id, failed = await f.terminal(s, id);
  f.noSpace = true;
  assert.equal((await f.retry(s, failed)).body.error, "storage_capacity");
  assert.equal((await f.journal(s, id)).result.attempt, 0); f.noSpace = false;
  f.cutHold = f.gate(); f.cutEntered = f.gate(); await f.post(s, uuid(90)); await f.cutEntered.promise;
  const ack = await f.retry(s, failed); assert.equal(ack.body.status, "queued");
  const fork = await f.fork(s), before = { ...f.counts };
  if (legacy) {
    const path = join(fork, "jobs", id + ".json"), old = JSON.parse(await readFile(path, "utf8"));
    delete old.layerAttemptSamples[0].acceptedSourceRevision;
    old.layerAttemptSamples[0].executionSourceRevision = "source-v1";
    await writeFile(path, JSON.stringify(old));
  }
  f.cutHold = undefined; f.healthy = false;
  const recovered = await f.start({ cache: fork, env: { CARD_MAX_ACTIVE_JOBS: "1", CARD_SOURCE_REVISION: "source-v2" } });
  const done = await f.terminal(recovered, id);
  assert.equal(done.status, "done"); assert.equal(done.attempt, 1);
  assert.equal(ack.body.retryToken, uuid(1)); assert.equal(done.retryToken, uuid(1));
  const accepted = await f.journal(s, id), executed = await f.journal(recovered, id);
  assert.equal(accepted.layerRetries[0].executionSourceRevision, "source-v1");
  assert.equal(executed.layerRetries[0].executionSourceRevision, "source-v1");
  assert.equal(executed.layerAttemptSamples[0].acceptedSourceRevision, "source-v1");
  assert.equal(executed.layerAttemptSamples[0].executionSourceRevision, "source-v2");
  assert.equal(executed.payload.sourceRevision, "source-v1");
  assert.deepEqual(executed.stageSamples, accepted.stageSamples);
  assert.deepEqual(executed.result.main, accepted.result.main);
  assert.deepEqual(executed.result.layers.cutout, accepted.result.layers.cutout);
  assert.equal((await f.journal(recovered, id)).layerAttemptSamples[0].executionSourceRevision, "source-v2");
  assert.equal(f.counts.llm, before.llm); assert.equal(f.counts.cutout, before.cutout); assert.equal(f.counts.plate, before.plate + 1);
  assert.equal((await f.retry(recovered, failed)).body.replayed, true);
  f.cutEntered = undefined; f.healthy = true;
});
}

test("tampered/symlink successful resource becomes unavailable on read and cannot be overwritten by retry", async t => {
  const f = await fixture(t); f.plateErrors.push(error("provider_error"));
  const s = await f.start(), id = (await f.post(s)).body.job_id, failed = await f.terminal(s, id);
  const path = join(f.cache, id + ".cut.png"); await rm(path); await symlink(join(f.cache, id + ".png"), path);
  const view = (await f.get(s, id)).body;
  assert.equal(view.layers.cutout.state, "unknown"); assert.equal(view.layers.cutout.url, undefined);
  assert.equal((await f.retry(s, failed)).body.error, "asset_integrity_conflict");
  assert.equal((await f.request(s, failed.layers.cutout.url)).status, 404);
  assert.equal((await f.journal(s, id)).result.attempt, 0); assert.deepEqual(f.counts, { llm: 1, cutout: 1, plate: 1 });
});

test("private request-key and retry routes stay closed on anonymous demo configuration", async t => {
  const f = await fixture(t), s = await f.start({ env: { CARD_AUTH_TOKEN: "", CARD_REQUIRE_AUTH: "false" } });
  assert.equal((await f.request(s, "/v1/identity/card-art/requests/" + KEY)).status, 401);
  assert.equal((await f.request(s, `/v1/identity/card-art/${"a".repeat(24)}/retry-layers`, {})).status, 401);
  assert.deepEqual(f.counts, { llm: 0, cutout: 0, plate: 0 });
});

test("old retry token replay returns acceptedAttempt without rewinding the live receipt or stage denominators", async t => {
  const f = await fixture(t); f.plateErrors.push(error("provider_error"), error("provider_timeout"));
  const s = await f.start(), id = (await f.post(s)).body.job_id, initial = await f.terminal(s, id);
  await f.retry(s, initial, uuid(1)); const first = await f.terminal(s, id);
  assert.equal(first.attempt, 1); assert.equal(first.layers.plate.state, "timed_out");
  await f.retry(s, first, uuid(2)); const done = await f.terminal(s, id);
  const before = await f.journal(s, id), replay = await f.retry(s, initial, uuid(1));
  assert.equal(replay.body.acceptedAttempt, 1); assert.equal(replay.body.attempt, 2); assert.equal(replay.body.replayed, true);
  assert.equal(replay.body.acceptedRetryToken, uuid(1)); assert.equal(replay.body.retryToken, uuid(2));
  assert.equal((await f.get(s, id)).body.retryToken, uuid(2));
  assert.equal(replay.body.status, "done"); assert.deepEqual(replay.body.main, done.main);
  assert.deepEqual((await f.journal(s, id)).layerAttemptSamples, before.layerAttemptSamples);
  assert.equal(before.stageSamples.stages.llm.attempts, 1); assert.equal(before.layerAttemptSamples.length, 2);
  assert.deepEqual(f.counts, { llm: 1, cutout: 1, plate: 3 });
});

test("bounded retry metadata fails closed before acceptance, retains live tokens and original successful assets", async t => {
  const f = await fixture(t); f.plateErrors = Array.from({ length: 40 }, () => error("provider_error"));
  const s = await f.start(), id = (await f.post(s)).body.job_id, initial = await f.terminal(s, id);
  let current = initial, denied;
  for (let n = 1; n <= 40; n++) {
    const result = await f.retry(s, current, uuid(n));
    if (result.status === 503) { denied = result; break; }
    assert.equal(result.status, 202); current = await f.terminal(s, id);
  }
  assert.equal(denied?.body.error, "retry_capacity");
  const saved = await f.journal(s, id), before = { ...f.counts };
  assert.equal(saved.result.attempt, current.attempt); assert.equal(saved.layerRetries.length, current.attempt);
  assert.ok(Buffer.byteLength(JSON.stringify(saved)) < 16 * 1024);
  assert.deepEqual(saved.result.main, initial.main); assert.deepEqual(saved.result.layers.cutout, initial.layers.cutout);
  assert.equal((await f.retry(s, initial, uuid(1))).body.acceptedAttempt, 1);
  assert.deepEqual(f.counts, before); assert.equal(f.counts.llm, 1);
});

for (const category of ["provider_rejected", "provider_timeout", "provider_result_unknown"]) {
  test(`LLM ${category} preserves authoritative main outcome and blocks unattempted derivatives`, async t => {
    const f = await fixture(t);
    f.mainError = Object.assign(error(category), { failure_stage: category === "provider_result_unknown" ? "unknown" : "llm" });
    const s = await f.start(), id = (await f.post(s)).body.job_id;
    const result = await f.terminal(s, id), saved = await f.journal(s, id);
    assert.equal(result.main.state, category === "provider_rejected" ? "failed" : category === "provider_timeout" ? "timed_out" : "unknown");
    assert.equal(result.failure_stage, category === "provider_result_unknown" ? "unknown" : "llm");
    assert.equal(result.layers.cutout.state, "blocked"); assert.equal(result.layers.plate.state, "blocked");
    assert.equal(result.main.validated, false); assert.equal(result.main.url, undefined);
    assert.equal(result.retryToken, undefined); assert.equal(result.attempt, 0);
    assert.equal(saved.stageSamples.stages.cutout.attempts, 0); assert.equal(saved.stageSamples.stages.plate.attempts, 0);
    assert.deepEqual(f.counts, { llm: 1, cutout: 0, plate: 0 });
    await f.stop(s); const reboot = await f.start();
    assert.deepEqual((await f.get(reboot, id)).body, result);
    assert.deepEqual(f.counts, { llm: 1, cutout: 0, plate: 0 });
  });
}

for (const stage of ["llm", "cutout", "plate"]) {
  test(`expiry crossed during ${stage} stops later dispatch and canonical publication before exact cleanup`, async t => {
    const f = await fixture(t), until = new Date(f.clock + 1000).toISOString();
    const hold = f.gate(), entered = f.gate();
    if (stage === "llm") { f.mainHold = hold; f.mainEntered = entered; }
    else if (stage === "cutout") { f.cutHold = hold; f.cutEntered = entered; }
    else { f.plateHold = hold; f.plateEntered = entered; }
    const s = await f.start(), id = (await f.post(s, KEY, until)).body.job_id;
    await entered.promise; f.clock = Date.parse(until) + 1; hold.resolve();
    await s.queue.close();
    const record = await f.journal(s, id), files = await readdir(f.cache);
    assert.equal(record.status, "failed");
    assert.equal(record.expiresAt, until); assert.notEqual(record.result.main.state, stage === "llm" ? "ready" : "unknown");
    assert.equal(files.includes(id + (stage === "llm" ? ".png" : stage === "cutout" ? ".cut.png" : ".plate.jpg")), false);
    assert.deepEqual(f.counts, { llm: 1, cutout: stage === "llm" ? 0 : 1, plate: stage === "plate" ? 1 : 0 });
    assert.equal((await f.get(s, id)).status, 410);
    assert.equal((await f.request(s, "/art/" + id + ".png")).status, 410);
    assert.equal((await f.request(s, "/v1/identity/card-art/requests/" + KEY)).status, 410);
    await writeFile(join(f.cache, "approved-static-default.png"), "retained fixture");
    await s.sweepRetention();
    assert.ok(!(await readdir(f.cache)).some(name => name.startsWith(id)));
    assert.deepEqual(await readdir(join(f.cache, "jobs")), []);
    assert.ok((await readdir(f.cache)).includes("approved-static-default.png"));
  });
}

test("expiry crossed during terminal journal directory sync cannot commit a successful completion", async t => {
  const f = await fixture(t), until = new Date(f.clock + 1000).toISOString();
  f.mainHold = f.gate(); f.mainEntered = f.gate();
  const handle = await open(f.cache, "r"), prototype = Object.getPrototypeOf(handle);
  const sync = prototype.sync;
  await handle.close();
  let s, id, crossed = false;
  t.mock.method(prototype, "sync", async function (...args) {
    await sync.apply(this, args);
    if (s !== undefined && id !== undefined && (await this.stat()).isDirectory()
      && (await f.journal(s, id)).status === "done") {
      f.clock = Date.parse(until); crossed = true;
    }
  });
  s = await f.start(); id = (await f.post(s, KEY, until)).body.job_id;
  await f.mainEntered.promise; f.mainHold.resolve(); await s.queue.close();
  t.mock.restoreAll();
  assert.equal(crossed, true);
  assert.equal(s.queue.get(id).status, "failed");
  assert.equal((await f.journal(s, id)).status, "failed");
  assert.equal((await f.get(s, id)).status, 410);
  assert.deepEqual(f.counts, { llm: 1, cutout: 1, plate: 1 });
  await s.sweepRetention();
  assert.deepEqual(await readdir(f.cache), ["jobs"]);
  assert.deepEqual(await readdir(join(f.cache, "jobs")), []);
});

test("confirmed derivative failure publishes only with terminal status so immediate same-main retry can be accepted", async t => {
  const f = await fixture(t); f.plateErrors.push(error("provider_error"));
  f.plateHold = f.gate(); f.plateEntered = f.gate();
  const s = await f.start(), checkpoint = s.queue.checkpoint;
  const premature = [];
  t.mock.method(s.queue, "checkpoint", async function (job) {
    await checkpoint.call(this, job);
    if (job.status === "running" && job.result.layers.plate.state === "failed") {
      const receipt = await f.get(s, job.id), retry = await f.retry(s, receipt.body);
      premature.push({ jobStatus: receipt.body.status, plate: receipt.body.layers.plate.state,
        retryStatus: retry.status, retryError: retry.body.error });
    }
  });
  const id = (await f.post(s)).body.job_id;
  await f.plateEntered.promise; f.plateHold.resolve();
  const partial = await f.terminal(s, id);
  assert.deepEqual(premature, []);
  assert.equal(partial.status, "failed"); assert.equal(partial.layers.plate.state, "failed");
  const retry = await f.retry(s, partial);
  assert.equal(retry.status, 202); assert.equal(retry.body.retryToken, uuid(1));
  assert.equal(retry.body.attempt, partial.attempt + 1);
  const repaired = await f.terminal(s, id);
  assert.equal(repaired.status, "done"); assert.deepEqual(repaired.main, partial.main);
  assert.deepEqual(repaired.layers.cutout, partial.layers.cutout);
  assert.deepEqual(f.counts, { llm: 1, cutout: 1, plate: 2 });
});

for (const mode of ["cache", "accepted token"]) {
  for (let depth = 0; depth < 13; depth++) {
    test(`confirmed derivative failure publishes only terminal state during concurrent ${mode} replay at depth ${depth}`, async t => {
      const cache = await mkdtemp(join(tmpdir(), "cardgen-replay-publication-"));
      const id = depth.toString(16).padStart(24, "f");
      const config = readServerConfig({ CARD_AUTH_TOKEN: TOKEN, CARD_SOURCE_REVISION: "source-v1", CARD_RETENTION_SWEEP_MS: "600000" });
      const counts = { llm: 0, cutout: 0, plate: 0 };
      let service, replay, replayReceipt, originalCommand;
      const schedule = n => {
        if (n > 0) { queueMicrotask(() => schedule(n - 1)); return; }
        const recording = mode === "cache" ? service.queue.recordCacheReplay(id)
          : service.queue.retryLayers(id, originalCommand, config.sourceRevision, async () => {});
        replay = recording.then(ack => {
          replayReceipt = service.queue.get(id);
          if (mode === "accepted token") {
            assert.equal(ack.replayed, true); assert.equal(ack.acceptedAttempt, 1);
          }
        });
      };
      const idle = async () => {
        const until = Date.now() + 20000;
        while (service.queue.stats().active !== 0) {
          t.signal.throwIfAborted();
          assert.ok(service.queue.healthy, "Replay publication fixture queue became unhealthy");
          assert.ok(Date.now() < until, `Replay fixture did not settle: ${JSON.stringify(service.queue.get(id))}`);
          await new Promise(resolve => setTimeout(resolve, 1));
        }
      };
      const command = (job, token) => retryCommand({ requestKey: job.payload.requestKey,
        expiresAt: new Date(jobExpiresAt(job)).toISOString(), expectedContract: pipelineDescriptor(config),
        retryToken: token, expectedAttempt: job.result.attempt, mainSha256: job.result.main.sha256 }, id);
      try {
        service = await createCardArtService({ config, cache, apiKey: "offline-only",
          prompts: { version: "offline", types: { sniper: "offline" } },
          logger: { log() {}, error() {} }, diskInfo: async () => ({ bavail: 100 * 1024 ** 3, bsize: 1 }),
          async generate(args) {
            counts.llm++; args.beforeDispatch(); await args.onDispatch();
            await args.onReceipt({ newProviderRequests: 1, costUSD: 0.14, reportedSeconds: 0.01 });
            return { png: MAIN, cost: 0.14, secs: 0.01 };
          },
          async cutout(_bytes, checkpoint, paths) {
            counts.cutout++; await checkpoint(); await paths.onDispatch();
            await paths.onReceipt({ newProviderRequests: 0, costUSD: null, reportedSeconds: 0 });
            return { png: CUT, seconds: 0 };
          },
          validateMain: async () => {}, validateLayer: async () => {},
          makePlate() {
            counts.plate++;
            if (counts.plate === (mode === "cache" ? 1 : 2)) schedule(depth);
            return Promise.reject(error("provider_error"));
          },
        });
        await service.queue.submit(id, { ...pipelineDescriptor(config), resultContract: RESULT_CONTRACT,
          promptVersion: "offline", prompt: "offline", type: "sniper", requestKey: KEY });
        if (mode === "accepted token") {
          await idle();
          originalCommand = command(service.queue.get(id), uuid(1));
          await service.queue.retryLayers(id, originalCommand, config.sourceRevision, async () => {});
        }
        await idle(); await replay;
        assert.ok(replayReceipt, `replay receipt at depth ${depth}`);
        assert.equal(replayReceipt.status === "running" && replayReceipt.result.layers.plate.state === "failed", false,
          `${mode} replay published running/failed at depth ${depth}`);
        const terminal = service.queue.get(id);
        const journal = JSON.parse(await readFile(join(cache, "jobs", id + ".json"), "utf8"));
        assert.equal(terminal.status, "failed"); assert.deepEqual(journal, terminal);
        assert.equal(mode === "cache" ? terminal.cacheReplayCount : terminal.layerRetryReplayCount, 1);
        const accepted = await service.queue.retryLayers(id, command(terminal, uuid(2)), config.sourceRevision, async () => {});
        assert.equal(accepted.replayed, false); assert.equal(accepted.acceptedAttempt, terminal.result.attempt + 1);
        assert.equal(accepted.job.result.retryToken, uuid(2));
        await idle();
        const final = service.queue.get(id);
        assert.deepEqual(final.result.main, terminal.result.main);
        assert.deepEqual(final.result.layers.cutout, terminal.result.layers.cutout);
        assert.deepEqual(final.payload, terminal.payload); assert.equal(final.expiresAt, terminal.expiresAt);
        assert.deepEqual(final.stageSamples, terminal.stageSamples);
        assert.deepEqual(counts, { llm: 1, cutout: 1, plate: mode === "cache" ? 2 : 3 });
        assert.equal(mode === "cache" ? final.cacheReplayCount : final.layerRetryReplayCount, 1);
      } finally {
        if (service) await service.close();
        await rm(cache, { recursive: true, force: true });
      }
    });
  }
}

for (const name of ["Error", "TimeoutError", "CredentialsProviderError"]) {
  test(`Bedrock ${name} without authoritative service response remains unknown, uncounted and cannot retry`, async t => {
    const f = await fixture(t);
    const adapter = createBedrockCutout({ region: "us-west-2", model: "offline", minIntervalMs: 1, timeoutMs: 1000,
      stateFile: join(f.cache, ".bedrock-rate.json"), now: () => f.clock,
      client: { async send() { throw Object.assign(new Error("offline only"), { name, code: "ECONNRESET" }); } } });
    const s = await f.start({ cutout: adapter, env: { CARD_CUTOUT_PROVIDER: "bedrock" } });
    const id = (await f.post(s)).body.job_id, result = await f.terminal(s, id), record = await f.journal(s, id);
    assert.equal(result.layers.cutout.state, "unknown"); assert.equal(result.failure_stage, "unknown");
    assert.equal(result.main.state, "ready"); assert.equal(result.layers.plate.state, "blocked");
    assert.equal((await f.retry(s, result)).body.error, "retry_not_allowed");
    assert.equal(record.stageSamples.stages.cutout.newProviderRequests, 0);
    assert.equal(record.stageSamples.stages.cutout.dispatchState, "reserved");
    assert.equal(record.stageSamples.stages.cutout.outcome, "unknown");
    assert.equal(record.stageSamples.stages.cutout.costUSD, null);
    assert.equal(record.stageSamples.stages.llm.outcome, "success");
    assert.deepEqual(f.counts, { llm: 1, cutout: 0, plate: 0 });
  });
}

test("explicit plate retry crossing original expiry discards late output without LLM or successful cutout replacement", async t => {
  const f = await fixture(t); f.plateErrors.push(error("provider_error"));
  const s = await f.start(), id = (await f.post(s)).body.job_id, original = await f.terminal(s, id);
  f.clock = Date.parse(EXPIRY) - 1000; f.plateHold = f.gate(); f.plateEntered = f.gate();
  await f.retry(s, original); await f.plateEntered.promise;
  f.clock = Date.parse(EXPIRY); f.plateHold.resolve(); await s.queue.close();
  const record = await f.journal(s, id);
  assert.equal(record.status, "failed"); assert.equal(record.result.attempt, 1);
  assert.deepEqual(record.result.main, original.main); assert.deepEqual(record.result.layers.cutout, original.layers.cutout);
  assert.equal((await readdir(f.cache)).includes(id + ".plate.jpg"), false);
  assert.equal((await f.get(s, id)).status, 410); assert.equal((await f.retry(s, original)).status, 410);
  assert.deepEqual(f.counts, { llm: 1, cutout: 1, plate: 2 });
  await s.sweepRetention(); assert.deepEqual(await readdir(f.cache), ["jobs"]);
  assert.deepEqual(await readdir(join(f.cache, "jobs")), []);
});

test("expiry while Bedrock waits for durable spacing prevents its later SDK dispatch", async t => {
  const f = await fixture(t), until = new Date(f.clock + 1000).toISOString(); let sends = 0;
  const waiting = f.gate();
  const stateFile = join(f.cache, ".bedrock-rate.json");
  await writeFile(stateFile, JSON.stringify({ lastStarted: f.clock, pending: false }));
  const adapter = createBedrockCutout({ region: "us-west-2", model: "offline", minIntervalMs: 3100, timeoutMs: 1000,
    stateFile, now: () => f.clock, sleep: async ms => { f.clock += ms; waiting.resolve(); },
    client: { async send() { sends++; throw new Error("must not dispatch"); } } });
  const s = await f.start({ cutout: adapter, env: { CARD_CUTOUT_PROVIDER: "bedrock" } });
  const id = (await f.post(s, KEY, until)).body.job_id;
  await waiting.promise;
  await s.queue.close();
  const record = await f.journal(s, id);
  assert.equal(sends, 0); assert.equal(record.status, "failed");
  assert.equal(record.stageSamples.stages.cutout.newProviderRequests, 0);
  assert.equal((await f.get(s, id)).status, 410);
  await s.sweepRetention(); assert.deepEqual(await readdir(f.cache), [".bedrock-rate.json", "jobs"]);
});
