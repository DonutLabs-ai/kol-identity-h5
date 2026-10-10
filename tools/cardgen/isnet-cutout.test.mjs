import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createIsnetCutout } from "./isnet-cutout.mjs";
import { readServerConfig } from "./server-config.mjs";

const CUT = await readFile(new URL("./test-fixtures/cut.png", import.meta.url));

test("worker selects IS-Net by default, rejects unknown providers and can explicitly select Bedrock", () => {
  const config = readServerConfig({});
  assert.equal(config.cutoutProvider, "isnet");
  assert.equal(config.cutoutModel, "isnet-general-use");
  assert.equal(config.isnetThreads, 2);
  const aws = readServerConfig({ CARD_CUTOUT_PROVIDER: "bedrock" });
  assert.equal(aws.cutoutModel, aws.bedrockModel);
  assert.throws(() => readServerConfig({ CARD_CUTOUT_PROVIDER: "invalid" }), /CARD_CUTOUT_PROVIDER/);
  for (const name of ["CARD_ISNET_THREADS", "CARD_ISNET_TIMEOUT_MS", "CARD_ISNET_STARTUP_TIMEOUT_MS"]) {
    assert.throws(() => readServerConfig({ [name]: "0" }), new RegExp(name));
  }
});

async function fixture(t, behavior = "success") {
  const directory = await mkdtemp(join(tmpdir(), "cardgen-isnet-"));
  let processes = 0, child;
  // Real IPC with a cheap external process; model inference is verified separately on native ARM.
  const code = `
    const fs = require('node:fs');
    const rl = require('node:readline').createInterface({ input: process.stdin });
    console.log(JSON.stringify({ event: 'ready', model: 'isnet-general-use' }));
    let active = false;
    rl.on('line', line => {
      const request = JSON.parse(line);
      if (active) process.exit(42);
      active = true;
      if (${JSON.stringify(behavior)} === 'exit') process.exit(7);
      if (${JSON.stringify(behavior)} === 'hang') return;
      if (${JSON.stringify(behavior)} === 'null') { console.log('null'); return; }
      setTimeout(() => {
        active = false;
        if (request.source === 'bad-input') {
          console.log(JSON.stringify({ id: request.id, ok: false, error: 'invalid_output' })); return;
        }
        fs.writeFileSync(request.target, Buffer.from(${JSON.stringify(CUT.toString("base64"))}, 'base64'));
        console.log(JSON.stringify({ id: request.id, ok: true, seconds: 0.01 }));
      }, 10);
    });
  `;
  const cutout = createIsnetCutout({ modelPath: "test-model", threads: 2,
    timeoutMs: behavior === "hang" ? 40 : 2000, startupTimeoutMs: 2000,
    spawnProcess() { processes++; child = spawn(process.execPath, ["-e", code], { stdio: ["pipe", "pipe", "pipe"] }); return child; },
  });
  t.after(async () => { await cutout.close(); await rm(directory, { recursive: true, force: true }); });
  return { cutout, directory, processes: () => processes, child: () => child };
}

test("one warm process serializes concurrent inference and checkpoints before dispatch", async (t) => {
  const f = await fixture(t), checkpoints = [];
  await Promise.all([f.cutout.initialize(), f.cutout.initialize()]);
  const results = await Promise.all(Array.from({ length: 8 }, (_, i) => f.cutout(null,
    async () => checkpoints.push(i), { source: "input", target: join(f.directory, i + ".png") })));
  assert.equal(f.processes(), 1);
  assert.deepEqual(checkpoints, [0, 1, 2, 3, 4, 5, 6, 7]);
  for (const result of results) assert.deepEqual(result.png, CUT);
  assert.equal(f.cutout.healthy(), true);
});

test("invalid input remains a failed call and a later job can use the same session", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.cutout(null, async () => {}, { source: "bad-input", target: join(f.directory, "bad.png") }),
    (error) => error.category === "invalid_output");
  assert.deepEqual((await f.cutout(null, async () => {}, { source: "good", target: join(f.directory, "good.png") })).png, CUT);
  assert.equal(f.processes(), 1);
});

test("resident inference observation is one local attempt, not a new LLM/provider request or invented zero cost", async t => {
  const f = await fixture(t), receipts = [];
  let starts = 0;
  const result = await f.cutout(null, async () => {}, { source: "good", target: join(f.directory, "observed.png"),
    onDispatch: async () => { starts++; }, onReceipt: async receipt => receipts.push(receipt) });
  assert.equal(starts, 1); assert.equal(receipts.at(-1).reportedSeconds, result.seconds);
  assert.equal(result.seconds, 0.01); assert.ok(receipts.every(receipt => receipt.costUSD === null && receipt.newProviderRequests === 0));
});

for (const behavior of ["exit", "hang", "null"]) {
  test(`IS-Net ${behavior} fails pending work, becomes unhealthy and never restarts or switches provider`, async (t) => {
    const f = await fixture(t, behavior);
    const results = await Promise.allSettled([0, 1].map(i => f.cutout(null, async () => {},
      { source: "input", target: join(f.directory, i + ".png") })));
    assert.ok(results.every(result => result.status === "rejected"));
    assert.equal(f.cutout.healthy(), false);
    assert.equal(f.processes(), 1);
    await assert.rejects(f.cutout(null, async () => {}, { source: "input", target: join(f.directory, "later.png") }));
    assert.equal(f.processes(), 1);
  });
}

test("closing the segmenter terminates its child and prevents further dispatch", async (t) => {
  const f = await fixture(t);
  await f.cutout.initialize();
  const exited = once(f.child(), "exit");
  await f.cutout.close();
  const [code] = await exited;
  assert.equal(code, 0);
  await assert.rejects(f.cutout(null, async () => {}, { source: "input", target: join(f.directory, "later.png") }));
});

test("spawn failure rejects initialization immediately without a live deadline timer", async () => {
  const cutout = createIsnetCutout({ modelPath: "test-model", threads: 2, timeoutMs: 1000, startupTimeoutMs: 1000,
    spawnProcess() { throw new Error("Cannot create process"); } });
  await assert.rejects(cutout.initialize(), /isnet_spawn_failed/);
  assert.equal(cutout.healthy(), false);
  await cutout.close();
});
