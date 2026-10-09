import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, writeFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createCardArtService } from "./card-art-service.mjs";
import { createImageGenerator } from "./openrouter-image.mjs";
import { readServerConfig } from "./server-config.mjs";
import { pipelineDescriptor } from "./pipeline-version.mjs";
import { PersistentJobQueue } from "./job-queue.mjs";

const MAIN = await readFile(new URL("./test-fixtures/main.png", import.meta.url));
const CUT = await readFile(new URL("./test-fixtures/cut.png", import.meta.url));
const TOKEN = "offline-metrics-only",
  CREATED = "2026-10-10T00:00:00.000Z";
const PROMPTS = {
  version: "metrics-test-v1",
  types: { sniper: "Private prompt never logged." },
};

async function fixture(t, options = {}) {
  const cache = await mkdtemp(join(tmpdir(), "cardgen-metrics-")),
    services = [];
  const config = readServerConfig({
    CARD_AUTH_TOKEN: TOKEN,
    CARD_REQUIRE_AUTH: "true",
    CARD_CUTOUT_PROVIDER: "isnet",
    CARD_SOURCE_REVISION: "metrics-source-v1",
    CARD_RETENTION_SWEEP_MS: "600000",
    ...(options.env || {}),
  });
  let clock = Date.parse(CREATED),
    requests = 0,
    llmResult;
  const logs = [];
  const generator = createImageGenerator({
    fetcher: async (...args) => {
      requests++;
      if (options.fetcher) return options.fetcher(...args);
      return Response.json({
        usage: { cost: "0.14" },
        choices: [
          {
            message: {
              images: [
                {
                  image_url: {
                    url: "data:image/png;base64," + MAIN.toString("base64"),
                  },
                },
              ],
            },
          },
        ],
      });
    },
  });
  const f = {
    cache,
    config,
    logs,
    advance(ms) {
      clock += ms;
    },
    get requests() {
      return requests;
    },
    get llmResult() {
      return llmResult;
    },
    async stop(s) {
      if (s.server.listening)
        await new Promise((done) => {
          s.server.close(done);
          s.server.closeAllConnections();
        });
      await s.close();
    },
    async start() {
      const cutout = async (_image, checkpoint, paths) => {
        await checkpoint();
        if (paths.onDispatch) await paths.onDispatch();
        if (options.cutoutHold) await options.cutoutHold;
        f.advance(120);
        if (options.cutoutError) throw options.cutoutError;
        if (options.cutoutNone) return null;
        if (paths.onReceipt)
          await paths.onReceipt({
            newProviderRequests: 0,
            reportedSeconds: 0.12,
            costUSD: null,
          });
        return { png: CUT, seconds: 0.12 };
      };
      if (options.health) cutout.healthy = options.health;
      const s = await createCardArtService({
        config,
        cache,
        prompts: PROMPTS,
        apiKey: "offline-secret-never-log",
        now: () => clock,
        generate: async (args) => {
          llmResult = await generator(args);
          return llmResult;
        },
        cutout,
        validateMain: options.validateMain || (async () => {}),
        makePlate: async (_main, _cut, target) => {
          f.advance(30);
          if (options.plateError) throw options.plateError;
          await writeFile(target, MAIN);
          return { coverage: 0.3 };
        },
        diskInfo: async () => ({ bavail: 100 * 1024 ** 3, bsize: 1 }),
        logger: {
          log(line) {
            logs.push(line);
          },
          error(line) {
            logs.push(line);
          },
        },
      });
      services.push(s);
      s.server.listen(0, "127.0.0.1");
      await once(s.server, "listening");
      return { ...s, base: "http://127.0.0.1:" + s.server.address().port };
    },
    async post(s) {
      const r = await fetch(s.base + "/v1/identity/card-art", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + TOKEN,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          type: "sniper",
          avatar_data: MAIN.toString("base64"),
        }),
      });
      return { status: r.status, body: await r.json() };
    },
    async terminal(s, id) {
      const until = performance.now() + 20000;
      while (performance.now() < until) {
        const r = await fetch(s.base + "/v1/identity/card-art/" + id, {
          headers: { Authorization: "Bearer " + TOKEN },
        });
        const body = await r.json();
        if (["done", "failed"].includes(body.status)) return body;
        await new Promise((done) => setTimeout(done, 10));
      }
      throw new Error("Offline job did not settle");
    },
    async journal(id) {
      return JSON.parse(await readFile(join(cache, "jobs", id + ".json"), "utf8"));
    },
  };
  t.after(async () => {
    for (const s of services) await f.stop(s);
    await rm(cache, { recursive: true, force: true });
  });
  return f;
}

test("private stage samples persist real LLM cost/timing and independent derivative attempts; replay/restart does not create samples", async (t) => {
  const f = await fixture(t),
    s = await f.start();
  const admitted = await f.post(s),
    id = admitted.body.job_id;
  const done = await f.terminal(s, id);
  assert.equal(done.status, "done");
  const record = await f.journal(id),
    ledger = record.stageSamples;
  assert.ok(ledger, "METRIC-01/02 requires persisted samples rather than health budget counters");
  assert.deepEqual(ledger.versions, {
    ...pipelineDescriptor(f.config),
    promptVersion: PROMPTS.version,
  });
  const { llm, cutout, plate } = ledger.stages;
  for (const sample of [llm, cutout, plate]) {
    assert.equal(sample.attempts, 1);
    assert.equal(sample.outcome, "success");
    assert.equal(sample.reason, null);
    assert.ok(Number.isFinite(Date.parse(sample.startedAt)));
    assert.ok(Number.isFinite(Date.parse(sample.finishedAt)));
    assert.ok(sample.elapsedMs >= 0);
  }
  assert.equal(llm.newProviderRequests, 1);
  assert.equal(llm.costUSD, 0.14);
  assert.ok(llm.reportedSeconds >= 0);
  assert.equal(llm.reportedSeconds, f.llmResult.secs);
  assert.equal(llm.costUSD, f.llmResult.cost);
  assert.equal(cutout.newProviderRequests, 0);
  assert.equal(cutout.reportedSeconds, 0.12);
  assert.equal(cutout.elapsedMs, 120);
  assert.equal(cutout.costUSD, null);
  assert.equal(plate.newProviderRequests, 0);
  assert.equal(plate.elapsedMs, 30);
  assert.equal(plate.costUSD, null);
  assert.equal(Object.hasOwn(done, "stageSamples"), false);
  const replay = await f.post(s);
  assert.equal(replay.body.cached, true);
  const replayed = await f.journal(id);
  assert.deepEqual(replayed.stageSamples, ledger);
  assert.equal(replayed.cacheReplayCount, 1);
  await f.stop(s);
  const restarted = await f.start();
  await f.post(restarted);
  const restored = await f.journal(id);
  assert.deepEqual(restored.stageSamples, ledger);
  assert.equal(restored.cacheReplayCount, 2);
  assert.equal(f.requests, 1);
  assert.ok(!JSON.stringify(f.logs).includes("offline-secret-never-log"));
  f.advance(200 * 86400000);
  await restarted.sweepRetention();
  assert.deepEqual(await readdir(join(f.cache, "jobs")), []);
});

test("LLM missing-image preserves known charge, safe outcome and zero derivative denominator", async (t) => {
  const f = await fixture(t, {
      fetcher: async () => Response.json({ usage: { cost: 0.07 }, choices: [] }),
    }),
    s = await f.start();
  const id = (await f.post(s)).body.job_id;
  assert.equal((await f.terminal(s, id)).status, "failed");
  const { stages } = (await f.journal(id)).stageSamples;
  assert.equal(stages.llm.attempts, 1);
  assert.equal(stages.llm.outcome, "no_image");
  assert.equal(stages.llm.reason, "missing_image");
  assert.equal(stages.llm.costUSD, 0.07);
  assert.equal(stages.llm.newProviderRequests, 1);
  for (const stage of ["cutout", "plate"]) {
    assert.equal(stages[stage].attempts, 0);
    assert.equal(stages[stage].outcome, "not_started");
    assert.equal(stages[stage].reason, "upstream_failed");
  }
});

test("dependency failure before dispatch and zero budget record no attempted provider request", async (t) => {
  for (const options of [{ health: () => false }, { env: { CARD_BUDGET: "0" } }]) {
    const f = await fixture(t, options),
      s = await f.start();
    const admitted = await f.post(s);
    if (admitted.status === 503) {
      assert.equal(f.requests, 0);
      assert.deepEqual(await readdir(join(f.cache, "jobs")), []);
      continue;
    }
    const id = admitted.body.job_id;
    await f.terminal(s, id);
    const { stages } = (await f.journal(id)).stageSamples;
    for (const stage of ["llm", "cutout", "plate"]) {
      assert.equal(stages[stage].attempts, 0);
      assert.equal(stages[stage].newProviderRequests, 0);
    }
    assert.equal(f.requests, 0);
  }
});

test("cutout and plate failures keep successful LLM sample and independent safe stage reasons", async (t) => {
  for (const stage of ["cutout", "plate"]) {
    const error = Object.assign(new Error("SECRET/raw/provider/error/body"), {
      category: "provider_timeout",
    });
    const f = await fixture(t, { [stage + "Error"]: error }),
      s = await f.start();
    const id = (await f.post(s)).body.job_id;
    assert.equal((await f.terminal(s, id)).failure_stage, stage);
    const { stages } = (await f.journal(id)).stageSamples;
    assert.equal(stages.llm.outcome, "success");
    assert.equal(stages.llm.costUSD, 0.14);
    assert.equal(stages[stage].attempts, 1);
    assert.equal(stages[stage].outcome, "timeout");
    assert.equal(stages[stage].reason, "provider_timeout");
    assert.equal(stages[stage].costUSD, null);
    if (stage === "cutout") assert.equal(stages.plate.attempts, 0);
    assert.ok(!JSON.stringify(await f.journal(id)).includes("SECRET/raw"));
    assert.equal(f.requests, 1);
  }
});

test("genuine LLM throttle, rejection and timeout each confirm one request with unknown cost, never derivative attempts", async (t) => {
  for (const kind of ["throttle", "reject", "timeout"]) {
    const f = await fixture(t, {
        fetcher: async () => {
          if (kind === "timeout")
            throw Object.assign(new Error("SECRET timeout body"), {
              name: "TimeoutError",
            });
          return new Response("SECRET rejection body", {
            status: kind === "throttle" ? 429 : 403,
          });
        },
      }),
      s = await f.start();
    const id = (await f.post(s)).body.job_id;
    assert.equal((await f.terminal(s, id)).failure_stage, "llm");
    const { stages } = (await f.journal(id)).stageSamples;
    assert.equal(stages.llm.attempts, 1);
    assert.equal(stages.llm.newProviderRequests, 1);
    assert.equal(stages.llm.dispatchState, "confirmed");
    assert.equal(stages.llm.costUSD, null);
    assert.equal(stages.llm.outcome, kind === "timeout" ? "timeout" : "error");
    assert.equal(
      stages.llm.reason,
      kind === "timeout"
        ? "provider_timeout"
        : kind === "throttle"
          ? "provider_throttled"
          : "provider_error",
    );
    assert.equal(stages.cutout.attempts, 0);
    assert.equal(stages.plate.attempts, 0);
    assert.equal(f.requests, 1);
    assert.ok(!JSON.stringify(await f.journal(id)).includes("SECRET"));
  }
});

test("unknown usage remains null, invalid PNG and quality refusal retain the actual LLM charge", async (t) => {
  for (const kind of ["unknown_cost", "invalid_png", "quality", "decode_error"]) {
    const f = await fixture(t, {
        fetcher: async () =>
          Response.json({
            usage: kind === "unknown_cost" ? {} : { cost: 0.19 },
            choices: [
              {
                message: {
                  images: [
                    {
                      image_url: {
                        url:
                          "data:image/png;base64," +
                          (kind === "invalid_png" ? Buffer.from("not PNG") : MAIN).toString(
                            "base64",
                          ),
                      },
                    },
                  ],
                },
              },
            ],
          }),
        ...(["quality", "decode_error"].includes(kind)
          ? {
              validateMain: async () => {
                if (kind === "quality")
                  throw Object.assign(new Error("offline positive validator rejection receipt"), {
                    sampleOutcome: "quality_rejected",
                    sampleReason: "quality_rejected",
                  });
                throw new Error(
                  "generic decode or dependency failure is not a positive quality rejection",
                );
              },
            }
          : {}),
      }),
      s = await f.start();
    const id = (await f.post(s)).body.job_id;
    await f.terminal(s, id);
    const { stages } = (await f.journal(id)).stageSamples;
    assert.equal(stages.llm.costUSD, kind === "unknown_cost" ? null : 0.19);
    assert.equal(
      stages.llm.outcome,
      kind === "unknown_cost"
        ? "success"
        : kind === "quality"
          ? "quality_rejected"
          : kind === "decode_error"
            ? "unknown"
            : "invalid_output",
    );
    if (kind !== "unknown_cost") {
      assert.equal(stages.cutout.attempts, 0);
      assert.equal(stages.plate.attempts, 0);
    }
    assert.equal(f.requests, 1);
  }
});

test("foreground becomes unavailable after admission without entering any request denominator", async (t) => {
  let checks = 0;
  const f = await fixture(t, { health: () => checks++ === 0 }),
    s = await f.start();
  const id = (await f.post(s)).body.job_id;
  assert.equal((await f.terminal(s, id)).failure_stage, "cutout");
  const { stages } = (await f.journal(id)).stageSamples;
  assert.equal(stages.llm.reason, "dependency_unavailable");
  assert.equal(stages.cutout.reason, "dependency_unavailable");
  for (const stage of Object.values(stages)) {
    assert.equal(stage.attempts, 0);
    assert.equal(stage.newProviderRequests, 0);
    assert.equal(stage.startedAt, null);
  }
  assert.equal(f.requests, 0);
});

test("cutout none is its own failed sample; plate remains unattempted and LLM stays successful", async (t) => {
  const f = await fixture(t, { cutoutNone: true }),
    s = await f.start();
  const id = (await f.post(s)).body.job_id;
  assert.equal((await f.terminal(s, id)).failure_stage, "cutout");
  const { stages } = (await f.journal(id)).stageSamples;
  assert.equal(stages.llm.outcome, "success");
  assert.equal(stages.cutout.attempts, 1);
  assert.equal(stages.cutout.outcome, "no_image");
  assert.equal(stages.plate.attempts, 0);
});

test("restart closes an unfinished reservation as unknown without inventing a confirmed request or retry", async (t) => {
  const f = await fixture(t),
    s = await f.start();
  const id = (await f.post(s)).body.job_id;
  await f.terminal(s, id);
  await f.stop(s);
  const record = await f.journal(id);
  const completedLlm = { ...record.stageSamples.stages.llm };
  record.status = "running";
  record.stage = "plate";
  record.stageSamples.stages.plate = {
    attempts: 1,
    newProviderRequests: 0,
    dispatchState: "reserved",
    outcome: "running",
    reason: null,
    startedAt: CREATED,
    finishedAt: null,
    elapsedMs: null,
    reportedSeconds: null,
    costUSD: null,
  };
  await writeFile(join(f.cache, "jobs", id + ".json"), JSON.stringify(record));
  f.advance(1000);
  const restarted = await f.start();
  assert.equal((await f.terminal(restarted, id)).failure_stage, "unknown");
  const restored = await f.journal(id);
  assert.deepEqual(restored.stageSamples.stages.llm, completedLlm);
  assert.equal(restored.stageSamples.stages.plate.outcome, "unknown");
  assert.equal(restored.stageSamples.stages.plate.reason, "crash_unknown");
  assert.equal(restored.stageSamples.stages.plate.newProviderRequests, 0);
  assert.equal(restored.stageSamples.stages.plate.dispatchState, "reserved");
  assert.equal(f.requests, 1);
});

test("concurrent in-flight replays never overwrite samples or create extra dispatches", async (t) => {
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const f = await fixture(t, { cutoutHold: held }),
    s = await f.start();
  t.after(() => release());
  const id = (await f.post(s)).body.job_id;
  try {
    const replies = await Promise.all(Array.from({ length: 8 }, () => f.post(s)));
    assert.ok(replies.every((reply) => reply.body.cached === true));
  } finally {
    release();
  }
  await f.terminal(s, id);
  const record = await f.journal(id);
  assert.equal(record.cacheReplayCount, 8);
  for (const sample of Object.values(record.stageSamples.stages)) {
    assert.equal(sample.attempts, 1);
    assert.equal(sample.outcome, "success");
  }
  assert.equal(f.requests, 1);
});

test("successful provider response followed by asset download failure is distinct from LLM failure and keeps known cost", async (t) => {
  let calls = 0;
  const f = await fixture(t, {
      fetcher: async () =>
        ++calls === 1
          ? Response.json({
              usage: { cost: 0.23 },
              choices: [
                {
                  message: {
                    images: [
                      {
                        image_url: { url: "https://offline.invalid/image.png" },
                      },
                    ],
                  },
                },
              ],
            })
          : new Response("private asset body", { status: 503 }),
    }),
    s = await f.start();
  const id = (await f.post(s)).body.job_id;
  assert.equal((await f.terminal(s, id)).failure_stage, "validation");
  const { stages } = (await f.journal(id)).stageSamples;
  assert.equal(stages.llm.newProviderRequests, 1);
  assert.equal(stages.llm.costUSD, 0.23);
  assert.equal(stages.llm.outcome, "asset_error");
  assert.equal(stages.llm.reason, "asset_download_failed");
  assert.equal(stages.cutout.attempts, 0);
  assert.equal(stages.plate.attempts, 0);
  assert.equal(calls, 2);
});

test("queued admission that expires before execution retains explicit zero stage denominators until journal cleanup", async (t) => {
  const cache = await mkdtemp(join(tmpdir(), "cardgen-metrics-queued-"));
  let clock = Date.parse(CREATED),
    release,
    started;
  const held = new Promise((done) => {
      release = done;
    }),
    runs = [];
  const active = new Promise((done) => {
    started = done;
  });
  const queue = new PersistentJobQueue({
    directory: join(cache, "jobs"),
    maxActive: 1,
    maxQueued: 2,
    now: () => clock,
    run: async (job) => {
      runs.push(job.id);
      started();
      await held;
    },
  });
  t.after(async () => {
    release();
    await queue.close();
    await rm(cache, { recursive: true, force: true });
  });
  await queue.initialize();
  const payload = {
    ...pipelineDescriptor(readServerConfig({ CARD_CUTOUT_PROVIDER: "isnet" })),
    promptVersion: PROMPTS.version,
  };
  await queue.submit("111111111111111111111111", payload);
  await active;
  await queue.submit("222222222222222222222222", payload);
  const pending = queue.get("222222222222222222222222");
  assert.equal(pending.status, "queued");
  for (const sample of Object.values(pending.stageSamples.stages)) {
    assert.equal(sample.attempts, 0);
    assert.equal(sample.newProviderRequests, 0);
    assert.equal(sample.outcome, "not_started");
    assert.equal(sample.startedAt, null);
    assert.equal(sample.costUSD, null);
  }
  clock += 200 * 86400000;
  release();
  await queue.close();
  assert.deepEqual(runs, ["111111111111111111111111"]);
  await queue.sweepExpired();
  assert.deepEqual(await readdir(join(cache, "jobs")), []);
});
