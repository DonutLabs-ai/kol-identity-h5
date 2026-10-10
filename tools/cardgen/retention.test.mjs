import assert from "node:assert/strict";
import { once } from "node:events";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  readdir,
  utimes,
  symlink,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { performance } from "node:perf_hooks";
import { createCardArtService } from "./card-art-service.mjs";
import { readServerConfig } from "./server-config.mjs";
import { createImageGenerator } from "./openrouter-image.mjs";
import { PersistentJobQueue, QueueCleanupBusyError } from "./job-queue.mjs";
import { JobExpiredError, ExpiryConflictError } from "./retention.mjs";
import {
  cardArtId,
  pipelineDescriptor,
  RequestKeyConflictError,
} from "./pipeline-version.mjs";
const MAIN = await readFile(
  new URL("./test-fixtures/main.png", import.meta.url),
);
const CUT = await readFile(new URL("./test-fixtures/cut.png", import.meta.url));
const TOKEN = "offline-retention-test",
  PROMPTS = { version: "retention-v1", types: { sniper: "Hold a telescope." } };
const VERSION = pipelineDescriptor(
  readServerConfig({ CARD_CUTOUT_PROVIDER: "isnet" }),
);
const ID = cardArtId(MAIN, "sniper", PROMPTS.version, VERSION);
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function fixture(
  t,
  createdAt = "2026-08-31T12:34:56.789Z",
  status = "done",
) {
  const cache = await mkdtemp(join(tmpdir(), "cardgen-retention-")),
    outside = await mkdtemp(join(tmpdir(), "cardgen-outside-"));
  const services = [],
    gates = [];
  let clock = Date.parse(createdAt),
    paid = 0;
  await mkdir(join(cache, "jobs"));
  const record = {
    id: ID,
    status,
    stage: status,
    sequence: 1,
    createdAt,
    updatedAt: createdAt,
    payload: {
      type: "sniper",
      avatarPath: join(cache, ID + ".avatar.png"),
      promptVersion: PROMPTS.version,
      prompt: "fixed",
      imageModel: "google/gemini-3-pro-image",
      cutoutModel: "isnet-general-use",
      ...VERSION,
    },
    ...(status === "done"
      ? {
          image_url: `/art/${ID}.png`,
          cutout_url: `/art/${ID}.cut.png`,
          plate_url: `/art/${ID}.plate.jpg`,
        }
      : {}),
    ...(status === "failed" ? { error: "provider_error" } : {}),
  };
  await writeFile(join(cache, "jobs", ID + ".json"), JSON.stringify(record));
  for (const suffix of [".png", ".cut.png", ".plate.jpg", ".avatar.png"])
    await writeFile(join(cache, ID + suffix), MAIN);
  t.after(async () => {
    gates.forEach((g) => g.resolve());
    for (const s of services) {
      if (s.server.listening)
        await new Promise((done) => {
          s.server.close(done);
          s.server.closeAllConnections();
        });
      await s.close();
    }
    await rm(cache, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });
  return {
    cache,
    outside,
    record,
    id: ID,
    get paid() {
      return paid;
    },
    setClock(value) {
      clock = Date.parse(value);
    },
    gate() {
      const g = deferred();
      gates.push(g);
      return g;
    },
    async start(overrides = {}) {
      const config = {
        ...readServerConfig({
          CARD_AUTH_TOKEN: TOKEN,
          CARD_REQUIRE_AUTH: "true",
          CARD_CUTOUT_PROVIDER: "isnet",
          CARD_RETENTION_SWEEP_MS: "600000",
        }),
        ...overrides.config,
      };
      const foreground =
        overrides.cutout || (async () => ({ png: CUT, seconds: 0 }));
      if (overrides.health) foreground.healthy = overrides.health;
      const service = await createCardArtService({
        config,
        cache,
        prompts: PROMPTS,
        apiKey: "offline-never-send",
        now: () => clock,
        logger: { log() {}, error() {} },
        cutout: foreground,
        validateMain: overrides.validateMain || (async () => {}),
        async generate(options) {
          paid++;
          return overrides.generate
            ? overrides.generate(options)
            : { png: MAIN };
        },
        makePlate:
          overrides.makePlate ||
          (async (_main, _cut, target) => {
            await writeFile(target, MAIN);
            return { coverage: 0.3 };
          }),
        diskInfo: async () => ({ bavail: 100 * 1024 ** 3, bsize: 1 }),
      });
      services.push(service);
      service.server.listen(0, "127.0.0.1");
      await once(service.server, "listening");
      return {
        ...service,
        base: `http://127.0.0.1:${service.server.address().port}`,
      };
    },
  };
}
async function request(
  s,
  path,
  method = "GET",
  authorized = true,
  additionalBody = {},
) {
  const r = await fetch(s.base + path, {
    method,
    headers: {
      ...(authorized ? { Authorization: "Bearer " + TOKEN } : {}),
      ...(method === "POST" ? { "Content-Type": "application/json" } : {}),
    },
    ...(method === "POST"
      ? {
          body: JSON.stringify({
            type: "sniper",
            avatar_data: MAIN.toString("base64"),
            ...additionalBody,
          }),
        }
      : {}),
  });
  return {
    status: r.status,
    headers: r.headers,
    body: r.headers.get("content-type")?.includes("json")
      ? await r.json()
      : await r.arrayBuffer(),
  };
}
async function terminal(s, id) {
  // Poll the same admitted job; durable fsync on the shared host has no 2-second SLA.
  const deadline = performance.now() + 20000;
  let last;
  while (performance.now() < deadline) {
    const r = await request(s, "/v1/identity/card-art/" + id);
    last = r.body;
    if (["done", "failed"].includes(r.body.status)) return r.body;
    await new Promise((done) => setTimeout(done, 10));
  }
  throw Error("Job not terminal: " + JSON.stringify(last));
}
test("real factory expires from journal createdAt at exact six-calendar-month boundary", async (t) => {
  const f = await fixture(t);
  f.setClock("2027-02-28T12:34:56.788Z");
  const s = await f.start();
  await utimes(join(f.cache, ID + ".png"), new Date(), new Date());
  assert.equal(
    (await request(s, "/v1/identity/card-art/" + ID)).body.status,
    "done",
  );
  const art = await request(s, "/art/" + ID + ".png");
  assert.equal(art.status, 200);
  assert.match(art.headers.get("cache-control"), /no-store/);
  assert.equal(
    (await request(s, "/v1/identity/card-art", "POST")).body.cached,
    true,
  );
  assert.equal(f.paid, 0);
  f.setClock("2027-02-28T12:34:56.789Z");
  assert.equal((await request(s, "/v1/identity/card-art/" + ID)).status, 410);
  for (const suffix of [".png", ".cut.png", ".plate.jpg"])
    assert.equal((await request(s, "/art/" + ID + suffix)).status, 410);
  assert.equal((await request(s, "/v1/identity/card-art", "POST")).status, 410);
  assert.equal(f.paid, 0);
  assert.equal(
    JSON.parse(await readFile(join(f.cache, "jobs", ID + ".json"), "utf8"))
      .createdAt,
    f.record.createdAt,
  );
});
test("bounded sweep removes terminal journal, assets/raw/tmp but preserves unrelated files and external payload paths", async (t) => {
  const f = await fixture(t, "2026-01-31T00:00:00.000Z", "failed");
  for (const suffix of [
    ".raw.json",
    ".png.11111111-1111-4111-8111-111111111111.tmp",
    ".cut.png.isnet.tmp",
    ".plate.jpg.tmp",
  ])
    await writeFile(join(f.cache, ID + suffix), "private");
  await writeFile(
    join(
      f.cache,
      "jobs",
      "." + ID + ".11111111-1111-4111-8111-111111111111.tmp",
    ),
    "private",
  );
  await writeFile(join(f.cache, "sniper.png"), "static");
  await writeFile(join(f.cache, "isnet-general-use.onnx"), "model");
  await writeFile(join(f.outside, "outside.png"), "never delete");
  await writeFile(
    join(f.cache, "jobs", ID + ".json"),
    JSON.stringify({
      ...f.record,
      payload: {
        ...f.record.payload,
        avatarPath: join(f.outside, "outside.png"),
      },
    }),
  );
  const s = await f.start();
  f.setClock("2026-07-31T00:00:00.000Z");
  for (let i = 0; i < 4; i++) await s.sweepRetention();
  assert.deepEqual((await readdir(f.cache)).sort(), [
    "isnet-general-use.onnx",
    "jobs",
    "sniper.png",
  ]);
  assert.deepEqual(await readdir(join(f.cache, "jobs")), []);
  assert.equal(s.queue.retainedJobs, 0);
  assert.equal(
    await readFile(join(f.outside, "outside.png"), "utf8"),
    "never delete",
  );
  assert.equal(f.paid, 0);
});
test("restart expires old queued/running/terminal journals before recovery dispatch", async (t) => {
  for (const status of ["queued", "running", "done", "failed"]) {
    const f = await fixture(t, "2026-04-10T00:00:00.000Z", status);
    f.setClock("2026-10-10T00:00:00.000Z");
    const s = await f.start();
    assert.equal(f.paid, 0);
    assert.equal(s.queue.retainedJobs, 0);
    assert.equal((await request(s, "/art/" + ID + ".png")).status, 404);
    assert.deepEqual(await readdir(join(f.cache, "jobs")), []);
  }
});
test("active job is denied at expiry but deletion waits for actual completion", async (t) => {
  const f = await fixture(t, "2026-01-01T00:00:00.000Z", "queued");
  await rm(join(f.cache, ID + ".png"));
  const started = deferred(),
    gate = f.gate();
  const s = await f.start({
    async generate() {
      started.resolve();
      await gate.promise;
      return { png: MAIN };
    },
  });
  await started.promise;
  f.setClock("2026-07-01T00:00:00.000Z");
  await s.sweepRetention();
  assert.equal((await request(s, "/v1/identity/card-art/" + ID)).status, 410);
  assert.ok((await readdir(join(f.cache, "jobs"))).includes(ID + ".json"));
  gate.resolve();
  await s.queue.close();
  await s.sweepRetention();
  assert.deepEqual(await readdir(join(f.cache, "jobs")), []);
});
test("auth guards expiry, and journal-less assets and symlink targets are never served", async (t) => {
  const f = await fixture(t);
  const s = await f.start();
  f.setClock("2027-02-28T12:34:56.789Z");
  for (const path of ["/v1/identity/card-art/" + ID, "/art/" + ID + ".png"])
    assert.equal((await request(s, path, "GET", false)).status, 401);
  await writeFile(join(f.cache, "b".repeat(24) + ".png"), MAIN);
  assert.equal(
    (await request(s, "/art/" + "b".repeat(24) + ".png")).status,
    404,
  );
  await rm(join(f.cache, ID + ".png"));
  await writeFile(join(f.outside, "secret.png"), "private");
  await symlink(join(f.outside, "secret.png"), join(f.cache, ID + ".png"));
  f.setClock("2026-09-01T00:00:00.000Z");
  assert.notEqual((await request(s, "/art/" + ID + ".png")).status, 200);
});
for (const category of [
  "provider_throttled",
  "provider_rejected",
  "provider_timeout",
])
  test("genuine LLM " + category + " has safe llm provenance", async (t) => {
    const f = await fixture(t, "2026-01-01T00:00:00.000Z", "queued");
    await rm(join(f.cache, ID + ".png"));
    const s = await f.start({
      generate() {
        throw Object.assign(new Error("private details"), { category });
      },
    });
    const failed = await terminal(s, ID);
    assert.equal(failed.failure_stage, "llm");
    assert.equal(failed.error, category);
    assert.ok(!JSON.stringify(failed).includes("private details"));
    assert.equal(
      JSON.parse(await readFile(join(f.cache, "jobs", ID + ".json"), "utf8"))
        .failure_stage,
      "llm",
    );
  });
for (const [name, overrides, expected] of [
  ["foreground health", { health: () => false }, "cutout"],
  [
    "invalid PNG",
    { generate: () => ({ png: Buffer.from("bad") }) },
    "validation",
  ],
  [
    "cutout",
    {
      cutout: () => {
        throw Error("private failure");
      },
    },
    "cutout",
  ],
  [
    "plate",
    {
      makePlate: () => {
        throw Error("private failure");
      },
    },
    "plate",
  ],
  [
    "validation",
    {
      validateMain: () => {
        throw Error("invalid dimensions");
      },
    },
    "validation",
  ],
])
  test(name + " does not permit LLM fallback", async (t) => {
    const f = await fixture(t, "2026-01-01T00:00:00.000Z", "queued");
    if (name === "invalid PNG") await rm(join(f.cache, ID + ".png"));
    const s = await f.start(overrides);
    assert.equal((await terminal(s, ID)).failure_stage, expected);
  });
test("crash recovery is unknown even after persisted llm stage; success omits failure_stage", async (t) => {
  const f = await fixture(t, "2026-01-01T00:00:00.000Z", "running");
  await writeFile(
    join(f.cache, "jobs", ID + ".json"),
    JSON.stringify({ ...f.record, attemptStage: "llm" }),
  );
  const s = await f.start();
  assert.equal((await terminal(s, ID)).failure_stage, "unknown");
  assert.equal(f.paid, 0);
  const done = await fixture(t);
  const d = await done.start();
  assert.equal(
    Object.hasOwn(
      (await request(d, "/v1/identity/card-art/" + ID)).body,
      "failure_stage",
    ),
    false,
  );
});

test("UTC calendar-month retention clamps leap/end-of-month and keeps exact time", async () => {
  const { expiresAt } = await import("./retention.mjs");
  for (const [start, end] of [
    ["2023-08-31T23:59:59.123Z", "2024-02-29T23:59:59.123Z"],
    ["2024-08-31T00:00:00.001Z", "2025-02-28T00:00:00.001Z"],
    ["2026-12-31T12:00:00.000Z", "2027-06-30T12:00:00.000Z"],
    ["2026-01-10T08:15:00.000+08:00", "2026-07-10T00:15:00.000Z"],
  ])
    assert.equal(new Date(expiresAt(start)).toISOString(), end);
  assert.throws(() => expiresAt("bad timestamp"), /createdAt/);
});

test("bounded sweeps progress across history and file cursors, with no static catalog deletion", async (t) => {
  const f = await fixture(t, "2026-01-01T00:00:00.000Z");
  for (let i = 1; i < 6; i++) {
    const id = i.toString(16).repeat(24);
    const r = { ...f.record, id, sequence: i + 1 };
    await writeFile(join(f.cache, "jobs", id + ".json"), JSON.stringify(r));
    await writeFile(join(f.cache, id + ".png"), MAIN);
    await writeFile(join(f.cache, id + ".plate.jpg.tmp"), "private temp");
  }
  await writeFile(join(f.cache, "approved-catalog.json"), "static");
  const s = await f.start({ config: { retentionBatchSize: 1 } });
  f.setClock("2026-07-01T00:00:00.000Z");
  let maxHistory = 0,
    maxFiles = 0;
  for (let i = 0; i < 100; i++) {
    const result = await s.sweepRetention();
    maxHistory = Math.max(maxHistory, result.history.scanned);
    maxFiles = Math.max(maxFiles, result.files.scanned);
    if (s.queue.retainedJobs === 0 && (await readdir(f.cache)).length === 2)
      break;
  }
  assert.ok(maxHistory <= 1);
  assert.ok(maxFiles <= 2);
  assert.equal(s.queue.retainedJobs, 0);
  assert.deepEqual((await readdir(f.cache)).sort(), [
    "approved-catalog.json",
    "jobs",
  ]);
});

test("cleanup failure retains original journal for retry, and cannot bypass expired reads", async (t) => {
  const f = await fixture(t, "2026-01-01T00:00:00.000Z");
  const s = await f.start();
  await rm(join(f.cache, ID + ".plate.jpg"));
  await mkdir(join(f.cache, ID + ".plate.jpg"));
  f.setClock("2026-07-01T00:00:00.000Z");
  await assert.rejects(s.sweepRetention(), { code: "EISDIR" });
  assert.equal(s.queue.retainedJobs, 1);
  assert.equal((await request(s, "/healthz")).status, 503);
  assert.equal((await request(s, "/art/" + ID + ".png")).status, 410);
  assert.equal((await request(s, "/v1/identity/card-art", "POST")).status, 410);
  assert.equal(
    JSON.parse(await readFile(join(f.cache, "jobs", ID + ".json"), "utf8"))
      .createdAt,
    f.record.createdAt,
  );
  await rm(join(f.cache, ID + ".plate.jpg"), { recursive: true });
  for (let i = 0; i < 3; i++) await s.sweepRetention();
  assert.equal(s.queue.retainedJobs, 0);
  assert.equal((await request(s, "/healthz")).status, 200);
  assert.equal(f.paid, 0);
});

test("failed raw/orphan assets are reclaimed without a new timestamp and symlink deletion never follows target", async (t) => {
  const f = await fixture(t);
  const id = "c".repeat(24),
    orphan = join(f.cache, id + ".avatar.png");
  await writeFile(join(f.outside, "private.png"), "never delete");
  await symlink(join(f.outside, "private.png"), orphan);
  await writeFile(join(f.cache, id + ".raw.json"), "private orphan");
  await writeFile(
    join(f.cache, id + ".png.11111111-1111-4111-8111-111111111111.tmp"),
    "unfinished admission",
  );
  const s = await f.start();
  await s.sweepRetention();
  assert.ok(!(await readdir(f.cache)).some((n) => n.startsWith(id)));
  assert.equal(
    await readFile(join(f.outside, "private.png"), "utf8"),
    "never delete",
  );
  assert.equal(s.queue.retainedJobs, 1);
});

test("untyped LLM-boundary bug fails with unknown provenance, never avatar fallback", async (t) => {
  const f = await fixture(t, "2026-01-01T00:00:00.000Z", "queued");
  await rm(join(f.cache, ID + ".png"));
  const s = await f.start({
    generate() {
      throw new TypeError("unexpected internal bug");
    },
  });
  assert.equal((await terminal(s, ID)).failure_stage, "unknown");
});

test("new admission journal createdAt and expires_at use admission clock and survive duplicate/restart", async (t) => {
  const f = await fixture(t);
  await rm(join(f.cache, "jobs", ID + ".json"));
  for (const name of await readdir(f.cache))
    if (name.startsWith(ID)) await rm(join(f.cache, name));
  f.setClock("2026-08-31T12:34:56.789Z");
  const s = await f.start();
  const admitted = await request(s, "/v1/identity/card-art", "POST");
  assert.ok([200, 202].includes(admitted.status));
  const done = await terminal(s, ID);
  assert.equal(done.expires_at, "2027-02-28T12:34:56.789Z");
  f.setClock("2026-10-01T00:00:00.000Z");
  assert.equal(
    (await request(s, "/v1/identity/card-art", "POST")).body.expires_at,
    done.expires_at,
  );
  assert.equal(f.paid, 1);
  await s.close();
  await new Promise((resolve) => {
    s.server.close(resolve);
    s.server.closeAllConnections();
  });
  const restarted = await f.start();
  assert.equal(
    (await request(restarted, "/v1/identity/card-art/" + ID)).body.expires_at,
    done.expires_at,
  );
  assert.equal(f.paid, 1);
});

test("retention scheduling is bounded, validates config and periodically reclaims without client reads", async (t) => {
  for (const [key, invalid] of [
    ["CARD_RETENTION_SWEEP_MS", "999"],
    ["CARD_RETENTION_SWEEP_MS", "600001"],
    ["CARD_RETENTION_BATCH_SIZE", "1001"],
    ["CARD_RETENTION_BATCH_SIZE", "0"],
  ])
    assert.throws(() => readServerConfig({ [key]: invalid }), new RegExp(key));
  const f = await fixture(t, "2026-01-01T00:00:00.000Z");
  const s = await f.start({ config: { retentionSweepMs: 1000 } });
  f.setClock("2026-07-01T00:00:00.000Z");
  for (let i = 0; i < 200 && s.queue.retainedJobs > 0; i++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(s.queue.retainedJobs, 0);
  assert.deepEqual(await readdir(join(f.cache, "jobs")), []);
  assert.equal(f.paid, 0);
});

test("orphan cleanup reserves its identity against concurrent admission and preserves admitted raw files", async (t) => {
  const f = await fixture(t),
    started = deferred(),
    gate = f.gate(),
    id = "d".repeat(24);
  const queue = new PersistentJobQueue({
    directory: join(f.outside, "jobs"),
    maxActive: 1,
    maxQueued: 1,
    run: async () => {},
  });
  await queue.initialize();
  t.after(() => queue.close());
  const raw = join(f.outside, id + ".avatar.png");
  await writeFile(raw, MAIN);
  const cleaning = queue.removeOrphan(id, async () => {
    started.resolve();
    await gate.promise;
    await rm(raw);
  });
  await started.promise;
  let prepared = 0;
  await assert.rejects(
    queue.submit(id, {}, async () => {
      prepared++;
      await writeFile(raw, MAIN);
    }),
    QueueCleanupBusyError,
  );
  assert.equal(prepared, 0);
  gate.resolve();
  assert.equal(await cleaning, true);
  await queue.submit(id, {}, async () => {
    prepared++;
    await writeFile(raw, MAIN);
  });
  assert.equal(await queue.removeOrphan(id, () => rm(raw)), false);
  assert.deepEqual(await readFile(raw), MAIN);
  assert.equal(prepared, 1);
  await queue.close();
});

test("actual generator output download failure persists validation across worker restart", async (t) => {
  const f = await fixture(t, "2026-01-01T00:00:00.000Z", "queued");
  await rm(join(f.cache, ID + ".png"));
  let calls = 0;
  const generate = createImageGenerator({
    fetcher: async () => {
      calls++;
      return calls === 1
        ? Response.json({
            choices: [
              {
                message: {
                  images: [
                    { image_url: { url: "https://example.com/generated.png" } },
                  ],
                },
              },
            ],
          })
        : new Response("unavailable", { status: 503 });
    },
  });
  const s = await f.start({ generate });
  assert.equal((await terminal(s, ID)).failure_stage, "validation");
  await new Promise((resolve) => {
    s.server.close(resolve);
    s.server.closeAllConnections();
  });
  await s.close();
  const restarted = await f.start();
  const failed = await terminal(restarted, ID);
  assert.equal(failed.failure_stage, "validation");
  assert.equal(calls, 2);
  assert.equal(f.paid, 1);
});

test("foreground failure after Gemini checkpoint is cutout despite provider_error category", async (t) => {
  const f = await fixture(t, "2026-01-01T00:00:00.000Z", "queued");
  await rm(join(f.cache, "jobs", ID + ".json"));
  let healthy = true;
  const s = await f.start({ health: () => healthy });
  const persist = s.queue.checkpoint.bind(s.queue);
  s.queue.checkpoint = async (job) => {
    if (job.stage === "gemini") healthy = false;
    return persist(job);
  };
  const admitted = await request(s, "/v1/identity/card-art", "POST");
  assert.equal(admitted.status, 202);
  const failed = await terminal(s, ID);
  assert.equal(failed.failure_stage, "cutout");
  assert.equal(failed.error, "provider_error");
  assert.equal(f.paid, 0);
});

test("backend deadline is immutable across cache hits/restart and expires all authorized reads", async (t) => {
  const f = await fixture(t, "2026-01-01T00:00:00.000Z");
  await rm(join(f.cache, "jobs", ID + ".json"));
  const s = await f.start(),
    deadline = "2026-02-01T12:34:56.789Z";
  const admitted = await request(s, "/v1/identity/card-art", "POST", true, {
    expiresAt: deadline,
  });
  assert.equal(admitted.body.expires_at, deadline);
  await terminal(s, ID);
  const journal = JSON.parse(
    await readFile(join(f.cache, "jobs", ID + ".json"), "utf8"),
  );
  assert.equal(journal.expiresAt, deadline);
  assert.equal(
    (
      await request(s, "/v1/identity/card-art", "POST", true, {
        expiresAt: "2026-02-01T20:34:56.789+08:00",
      })
    ).body.cached,
    true,
  );
  for (const expiresAt of [
    "2026-01-31T12:34:56.789Z",
    "2026-03-01T12:34:56.789Z",
  ]) {
    const conflict = await request(s, "/v1/identity/card-art", "POST", true, {
      expiresAt,
    });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.error, "expiry_conflict");
  }
  assert.equal(f.paid, 1);
  await new Promise((resolve) => {
    s.server.close(resolve);
    s.server.closeAllConnections();
  });
  await s.close();
  f.setClock("2026-02-01T12:34:56.788Z");
  const restarted = await f.start();
  assert.equal((await request(restarted, "/art/" + ID + ".png")).status, 200);
  f.setClock(deadline);
  assert.equal(
    (await request(restarted, "/v1/identity/card-art/" + ID)).status,
    410,
  );
  for (const suffix of [".png", ".cut.png", ".plate.jpg"])
    assert.equal((await request(restarted, "/art/" + ID + suffix)).status, 410);
  assert.equal(
    (
      await request(restarted, "/v1/identity/card-art", "POST", true, {
        expiresAt: deadline,
      })
    ).status,
    410,
  );
  await restarted.sweepRetention();
  assert.equal(restarted.queue.retainedJobs, 0);
  assert.deepEqual(await readdir(join(f.cache, "jobs")), []);
  assert.equal(f.paid, 1);
});

test("invalid, elapsed and over-six-month backend deadlines never admit or generate a job", async (t) => {
  const f = await fixture(t, "2026-01-01T00:00:00.000Z");
  await rm(join(f.cache, "jobs", ID + ".json"));
  const s = await f.start();
  for (const expiresAt of [
    null,
    17,
    "not ISO",
    "2026-02-30T00:00:00.000Z",
    "2026-01-01T00:00:00.000Z",
    "2026-07-01T00:00:00.001Z",
  ]) {
    const r = await request(s, "/v1/identity/card-art", "POST", true, {
      expiresAt,
    });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "invalid_expires_at");
  }
  assert.equal(f.paid, 0);
  assert.equal(s.queue.retainedJobs, 0);
  assert.deepEqual(await readdir(join(f.cache, "jobs")), []);
});

test("pending duplicates cannot replace expiry, and preparation crossing deadline admits no paid work", async (t) => {
  const f = await fixture(t),
    preparing = deferred(),
    gate = f.gate();
  let clock = Date.parse("2026-01-01T00:00:00.000Z"),
    calls = 0;
  const deadline = "2026-01-01T00:00:01.000Z";
  const queue = new PersistentJobQueue({
    directory: join(f.outside, "jobs"),
    maxActive: 1,
    maxQueued: 1,
    now: () => clock,
    run: async () => {
      calls++;
    },
  });
  await queue.initialize();
  t.after(() => queue.close());
  const first = queue.submit(
    "first",
    {},
    async () => {
      preparing.resolve();
      await gate.promise;
    },
    deadline,
  );
  const firstRejected = assert.rejects(first, JobExpiredError);
  await preparing.promise;
  const duplicate = queue.submit(
    "first",
    {},
    undefined,
    "2026-01-01T00:00:02.000Z",
  );
  const duplicateRejected = assert.rejects(duplicate, JobExpiredError);
  clock = Date.parse(deadline);
  gate.resolve();
  await Promise.all([firstRejected, duplicateRejected]);
  assert.equal(calls, 0);
  assert.equal(queue.retainedJobs, 0);
  assert.deepEqual(await readdir(join(f.outside, "jobs")), []);
  await queue.close();
});

test("expiry crossed behind FIFO journal write prevents a new render dispatch", async (t) => {
  const f = await fixture(t),
    gate = f.gate(),
    firstStarted = deferred();
  let clock = Date.parse("2026-01-01T00:00:00.000Z");
  const calls = [];
  const queue = new PersistentJobQueue({
    directory: join(f.outside, "jobs"),
    maxActive: 2,
    maxQueued: 1,
    now: () => clock,
    run: async (job) => {
      calls.push(job.id);
      if (job.id === "first") {
        clock = Date.parse("2026-01-01T00:00:01.000Z");
        firstStarted.resolve();
      }
    },
  });
  await queue.initialize();
  t.after(() => queue.close());
  const first = queue.submit("first", {}, () => gate.promise);
  await queue.submit("second", {}, undefined, "2026-01-01T00:00:01.000Z");
  gate.resolve();
  await first;
  await firstStarted.promise;
  const until = performance.now() + 20000;
  while (queue.get("second").status !== "failed" && performance.now() < until)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(queue.get("second").status, "failed");
  assert.deepEqual(calls, ["first"]);
  await queue.close();
});

test("pending earlier deadline is rejected after the single original admission without extension or extra render", async (t) => {
  const f = await fixture(t),
    preparing = deferred(),
    gate = f.gate();
  let calls = 0;
  const started = deferred();
  const deadline = "2026-07-01T00:00:00.000Z";
  const queue = new PersistentJobQueue({
    directory: join(f.outside, "jobs"),
    maxActive: 1,
    maxQueued: 1,
    now: () => Date.parse("2026-01-01T00:00:00.000Z"),
    run: async () => {
      calls++;
      started.resolve();
    },
  });
  await queue.initialize();
  t.after(() => queue.close());
  const first = queue.submit(
    "first",
    {},
    async () => {
      preparing.resolve();
      await gate.promise;
    },
    deadline,
  );
  await preparing.promise;
  const duplicate = queue.submit(
    "first",
    {},
    undefined,
    "2026-06-01T00:00:00.000Z",
  );
  const conflicting = assert.rejects(duplicate, ExpiryConflictError);
  gate.resolve();
  await first;
  await conflicting;
  await started.promise;
  await queue.close();
  assert.equal(queue.get("first").expiresAt, deadline);
  assert.equal(calls, 1);
});

test("actual health advertises exact image/pipeline versions and old ready jobs preserve their frozen metadata", async (t) => {
  const f = await fixture(t);
  await rm(join(f.cache, "jobs", ID + ".json"));
  const s = await f.start();
  const health = (await request(s, "/healthz")).body;
  assert.equal(health.image_model, "google/gemini-3-pro-image");
  assert.equal(health.pipeline_version, "DONUT_CARD_ART_THREE_LAYER_V1");
  const admitted = await request(s, "/v1/identity/card-art", "POST");
  const done = await terminal(s, admitted.body.job_id);
  assert.equal(done.image_model, health.image_model);
  assert.equal(done.pipeline_version, health.pipeline_version);
  assert.equal(done.cutout_provider, "isnet");
  assert.equal(done.cutout_model, "isnet-general-use");
  assert.equal(done.cutout_revision, health.cutout_revision);
  await new Promise((resolve) => {
    s.server.close(resolve);
    s.server.closeAllConnections();
  });
  await s.close();
  const restarted = await f.start({
    config: { sourceRevision: "different-build" },
  });
  const old = (
    await request(restarted, "/v1/identity/card-art/" + admitted.body.job_id)
  ).body;
  for (const field of [
    "image_model",
    "pipeline_version",
    "cutout_provider",
    "cutout_model",
    "cutout_revision",
    "source_revision",
  ])
    assert.equal(old[field], done[field]);
  assert.equal(f.paid, 1);
});

test("different worker revision never reuses a result from a prior frozen pipeline identity", async (t) => {
  const f = await fixture(t);
  await rm(join(f.cache, "jobs", ID + ".json"));
  const s = await f.start();
  const first = await request(s, "/v1/identity/card-art", "POST");
  await terminal(s, first.body.job_id);
  await new Promise((resolve) => {
    s.server.close(resolve);
    s.server.closeAllConnections();
  });
  await s.close();
  const newer = await f.start({
    config: { sourceRevision: "different-build" },
  });
  const second = await request(newer, "/v1/identity/card-art", "POST");
  assert.notEqual(second.body.job_id, first.body.job_id);
  assert.equal(second.body.cached, false);
  await terminal(newer, second.body.job_id);
  assert.equal(f.paid, 2);
});

test("separate backend admission UUIDs permit explicit new generation and same-key retries preserve immutable expiry", async (t) => {
  const f = await fixture(t, "2026-01-01T00:00:00.000Z");
  await rm(join(f.cache, "jobs", ID + ".json"));
  const s = await f.start();
  const a = {
    requestKey: "11111111-1111-4111-8111-111111111111",
    expiresAt: "2026-06-01T00:00:00.000Z",
    expectedContract: BACKEND_CONTRACT,
  };
  const b = {
    requestKey: "22222222-2222-4222-8222-222222222222",
    expiresAt: "2026-07-01T00:00:00.000Z",
    expectedContract: BACKEND_CONTRACT,
  };
  const first = await request(s, "/v1/identity/card-art", "POST", true, a);
  await terminal(s, first.body.job_id);
  const repeated = await request(s, "/v1/identity/card-art", "POST", true, a);
  assert.equal(repeated.body.job_id, first.body.job_id);
  assert.equal(repeated.body.cached, true);
  const second = await request(s, "/v1/identity/card-art", "POST", true, b);
  assert.notEqual(second.body.job_id, first.body.job_id);
  assert.equal(second.body.cached, false);
  await terminal(s, second.body.job_id);
  assert.equal(f.paid, 2);
  const conflict = await request(s, "/v1/identity/card-art", "POST", true, {
    ...a,
    expiresAt: b.expiresAt,
  });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.error, "expiry_conflict");
  for (const [result, admission] of [
    [first, a],
    [second, b],
    [repeated, a],
  ]) {
    assert.equal(result.body.requestKey, admission.requestKey);
    assert.equal(result.body.expiresAt, admission.expiresAt);
    assert.ok(!result.body.job_id.includes(admission.requestKey));
    assert.equal(
      (
        await request(
          s,
          "/v1/identity/card-art/" + result.body.job_id,
          "GET",
          false,
        )
      ).status,
      401,
    );
  }
  const saved = JSON.parse(
    await readFile(join(f.cache, "jobs", first.body.job_id + ".json"), "utf8"),
  );
  assert.equal(saved.payload.requestKey, a.requestKey);
  assert.equal(saved.expiresAt, a.expiresAt);
  await new Promise((resolve) => {
    s.server.close(resolve);
    s.server.closeAllConnections();
  });
  await s.close();
  const restarted = await f.start();
  const retried = await request(
    restarted,
    "/v1/identity/card-art",
    "POST",
    true,
    a,
  );
  assert.equal(retried.body.cached, true);
  assert.equal(retried.body.job_id, first.body.job_id);
  assert.equal(f.paid, 2);
  const changed = await request(
    restarted,
    "/v1/identity/card-art",
    "POST",
    true,
    {
      ...a,
      avatar_data: Buffer.concat([MAIN, Buffer.from("changed")]).toString(
        "base64",
      ),
    },
  );
  assert.equal(changed.status, 409);
  assert.equal(changed.body.error, "request_key_conflict");
  assert.equal(f.paid, 2);
});

test("invalid backend requestKey UUIDs are rejected before admission without exposing UUID in public routes", async (t) => {
  const f = await fixture(t);
  await rm(join(f.cache, "jobs", ID + ".json"));
  const s = await f.start();
  for (const requestKey of [
    null,
    1,
    "not-uuid",
    "../secrets",
    "00000000-0000-0000-0000-000000000000",
    "11111111-1111-4111-1111-111111111111",
  ]) {
    const r = await request(s, "/v1/identity/card-art", "POST", true, {
      requestKey,
    });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "invalid_request_key");
  }
  assert.equal(f.paid, 0);
  assert.equal(s.queue.retainedJobs, 0);
  assert.equal(
    (
      await request(
        s,
        "/v1/identity/card-art/11111111-1111-4111-8111-111111111111",
      )
    ).status,
    404,
  );
});

test("pending requestKey reserves identity before I/O and rejects changed input without another preparation or render", async (t) => {
  const f = await fixture(t),
    gate = f.gate(),
    preparing = deferred(),
    started = deferred();
  let prepares = 0,
    calls = 0;
  const queue = new PersistentJobQueue({
    directory: join(f.outside, "jobs"),
    maxActive: 2,
    maxQueued: 1,
    run: async () => {
      calls++;
      started.resolve();
    },
  });
  await queue.initialize();
  t.after(() => queue.close());
  const payload = { requestKey: "abcdefab-abcd-4abc-8abc-abcdefabcdef" };
  const first = queue.submit("first", payload, async () => {
    prepares++;
    preparing.resolve();
    await gate.promise;
  });
  await preparing.promise;
  await assert.rejects(
    queue.submit("changed", payload, async () => {
      prepares++;
    }),
    RequestKeyConflictError,
  );
  gate.resolve();
  await first;
  await started.promise;
  await queue.close();
  assert.equal(prepares, 1);
  assert.equal(calls, 1);
});

const BACKEND_CONTRACT = {
  imageModel: VERSION.imageModel,
  pipelineVersion: VERSION.pipelineVersion,
  cutoutProvider: VERSION.cutoutProvider,
  cutoutModel: VERSION.cutoutModel,
  cutoutRevision: VERSION.cutoutRevision,
  sourceRevision: VERSION.sourceRevision,
};

test("Hilbert admission contract is echoed by authenticated queued and done receipts from frozen payload", async (t) => {
  const f = await fixture(t, "2026-01-01T00:00:00.000Z");
  await rm(join(f.cache, "jobs", ID + ".json"));
  const gate = f.gate();
  const s = await f.start({
    generate: async () => {
      await gate.promise;
      return { png: MAIN };
    },
  });
  const admission = {
    requestKey: "abcdefab-abcd-4abc-8abc-abcdefabcdef",
    expiresAt: "2026-06-01T00:00:00.000Z",
    expectedContract: BACKEND_CONTRACT,
  };
  const first = await request(
    s,
    "/v1/identity/card-art",
    "POST",
    true,
    admission,
  );
  assert.equal(first.status, 202);
  assert.equal(first.body.requestKey, admission.requestKey);
  assert.equal(first.body.expiresAt, admission.expiresAt);
  assert.deepEqual(first.body.workerContract, BACKEND_CONTRACT);
  gate.resolve();
  const done = await terminal(s, first.body.job_id);
  assert.equal(done.requestKey, admission.requestKey);
  assert.equal(done.expiresAt, admission.expiresAt);
  assert.deepEqual(done.workerContract, BACKEND_CONTRACT);
  const health = (await request(s, "/healthz", "GET", false)).body;
  assert.ok(!JSON.stringify(health).includes(admission.requestKey));
  assert.equal(
    (
      await request(
        s,
        "/v1/identity/card-art/" + first.body.job_id,
        "GET",
        false,
      )
    ).status,
    401,
  );
  assert.equal(
    (await request(s, "/v1/identity/card-art/" + admission.requestKey)).status,
    404,
  );
});

test("expectedContract health-to-POST race rejects before avatar download, raw bytes or paid admission", async (t) => {
  const f = await fixture(t);
  await rm(join(f.cache, "jobs", ID + ".json"));
  const s = await f.start();
  for (const [field, value] of [
    ["imageModel", "different-model"],
    ["pipelineVersion", "different-pipeline"],
    ["cutoutProvider", "bedrock"],
    ["cutoutModel", "different-model"],
    ["cutoutRevision", "sha256:" + "b".repeat(64)],
    ["sourceRevision", "different-build"],
  ]) {
    const r = await request(s, "/v1/identity/card-art", "POST", true, {
      expectedContract: { ...BACKEND_CONTRACT, [field]: value },
      avatar_data: "invalid-avatar-before-I/O",
    });
    assert.equal(r.status, 409);
    assert.equal(r.body.error, "contract_changed");
  }
  assert.equal(f.paid, 0);
  assert.equal(s.queue.retainedJobs, 0);
  assert.deepEqual(await readdir(join(f.cache, "jobs")), []);
});

test("malformed expectedContract never admits a job", async (t) => {
  const f = await fixture(t);
  await rm(join(f.cache, "jobs", ID + ".json"));
  const s = await f.start();
  const { cutoutRevision: _revision, ...legacyFive } = BACKEND_CONTRACT;
  for (const expectedContract of [
    null,
    [],
    {},
    "contract",
    legacyFive,
    { ...BACKEND_CONTRACT, sourceRevision: null },
    { ...BACKEND_CONTRACT, cutoutRevision: "unknown-extra" },
    { ...BACKEND_CONTRACT, extra: "unrecognized" },
  ]) {
    const r = await request(s, "/v1/identity/card-art", "POST", true, {
      expectedContract,
    });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "invalid_expected_contract");
  }
  assert.equal(f.paid, 0);
  assert.equal(s.queue.retainedJobs, 0);
});

test("unauthenticated demo receipts and public routes never expose backend admission UUID", async (t) => {
  const f = await fixture(t);
  await rm(join(f.cache, "jobs", ID + ".json"));
  const s = await f.start({ config: { authRequired: false, authToken: "" } });
  const requestKey = "abcdefab-abcd-4abc-8abc-abcdefabcdef";
  const r = await request(s, "/v1/identity/card-art", "POST", false, {
    requestKey,
    expectedContract: BACKEND_CONTRACT,
  });
  assert.ok([200, 202].includes(r.status));
  const done = await terminal(s, r.body.job_id);
  for (const body of [r.body, done]) {
    assert.equal(Object.hasOwn(body, "requestKey"), false);
    assert.ok(!JSON.stringify(body).includes(requestKey));
  }
  assert.equal(
    (await request(s, "/v1/identity/card-art/" + requestKey, "GET", false))
      .status,
    404,
  );
  assert.equal(
    (await request(s, "/art/" + requestKey + ".png", "GET", false)).status,
    404,
  );
});

test("a preflight contract from the old build cannot admit on the new build, while old GET receipts remain frozen", async (t) => {
  const f = await fixture(t);
  await rm(join(f.cache, "jobs", ID + ".json"));
  const old = await f.start();
  const admission = {
    requestKey: "abcdefab-abcd-4abc-8abc-abcdefabcdef",
    expectedContract: BACKEND_CONTRACT,
  };
  const first = await request(
    old,
    "/v1/identity/card-art",
    "POST",
    true,
    admission,
  );
  const done = await terminal(old, first.body.job_id);
  await new Promise((resolve) => {
    old.server.close(resolve);
    old.server.closeAllConnections();
  });
  await old.close();
  const newer = await f.start({
    config: { sourceRevision: "different-build" },
  });
  const rejected = await request(newer, "/v1/identity/card-art", "POST", true, {
    ...admission,
    requestKey: "bcdefabc-bcde-4bcd-8bcd-bcdefabcdefa",
  });
  assert.equal(rejected.status, 409);
  assert.equal(rejected.body.error, "contract_changed");
  assert.equal(f.paid, 1);
  assert.equal(newer.queue.retainedJobs, 1);
  const recovered = (
    await request(newer, "/v1/identity/card-art/" + first.body.job_id)
  ).body;
  assert.deepEqual(recovered.workerContract, done.workerContract);
  assert.equal(recovered.requestKey, admission.requestKey);
  assert.equal(recovered.expiresAt, done.expiresAt);
  const health = (await request(newer, "/healthz")).body;
  assert.equal(health.source_revision, "different-build");
  assert.equal(recovered.workerContract.sourceRevision, "unversioned");
});

test("failed and exactly expired authenticated receipts retain original contract/key/deadline and never dispatch another render", async (t) => {
  const f = await fixture(t, "2026-01-01T00:00:00.000Z");
  await rm(join(f.cache, "jobs", ID + ".json"));
  const s = await f.start({
    generate() {
      throw Object.assign(new Error("private body"), {
        category: "provider_timeout",
      });
    },
  });
  const admission = {
    requestKey: "abcdefab-abcd-4abc-8abc-abcdefabcdef",
    expiresAt: "2026-02-01T00:00:00.000Z",
    expectedContract: BACKEND_CONTRACT,
  };
  const first = await request(
    s,
    "/v1/identity/card-art",
    "POST",
    true,
    admission,
  );
  const failed = await terminal(s, first.body.job_id);
  assert.equal(failed.failure_stage, "llm");
  assert.equal(failed.requestKey, admission.requestKey);
  assert.equal(failed.expiresAt, admission.expiresAt);
  assert.deepEqual(failed.workerContract, BACKEND_CONTRACT);
  f.setClock(admission.expiresAt);
  const expired = await request(
    s,
    "/v1/identity/card-art/" + first.body.job_id,
  );
  assert.equal(expired.status, 410);
  assert.equal(expired.body.requestKey, admission.requestKey);
  assert.equal(expired.body.expiresAt, admission.expiresAt);
  assert.deepEqual(expired.body.workerContract, BACKEND_CONTRACT);
  const rejected = await request(
    s,
    "/v1/identity/card-art",
    "POST",
    true,
    admission,
  );
  assert.equal(rejected.status, 410);
  assert.equal(f.paid, 1);
});

test("backend requestKey cannot omit expectedContract to bypass preflight enforcement", async (t) => {
  const f = await fixture(t);
  await rm(join(f.cache, "jobs", ID + ".json"));
  const s = await f.start();
  const r = await request(s, "/v1/identity/card-art", "POST", true, {
    requestKey: "abcdefab-abcd-4abc-8abc-abcdefabcdef",
  });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, "invalid_expected_contract");
  assert.equal(f.paid, 0);
  assert.equal(s.queue.retainedJobs, 0);
});
