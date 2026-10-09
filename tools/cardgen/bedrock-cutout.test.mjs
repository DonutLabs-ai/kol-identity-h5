import assert from "node:assert/strict";
import { readFile, mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createBedrockCutout, createWorkloadBedrockClient, pngInfo } from "./bedrock-cutout.mjs";

const original = await readFile(new URL("./test-fixtures/main.png", import.meta.url));
const foreground = await readFile(new URL("./test-fixtures/cut.png", import.meta.url));
const body = (images = [foreground.toString("base64")], reasons = [null]) =>
  Buffer.from(JSON.stringify({ images, finish_reasons: reasons }));

async function setup(t, send) {
  const dir = await mkdtemp(join(tmpdir(), "cardgen-bedrock-"));
  t.after(() => rm(dir, { recursive: true }));
  let clock = 100000;
  const waits = [], starts = [], commands = [];
  const options = { region: "us-west-2", model: "us.stability.stable-image-remove-background-v1:0",
    minIntervalMs: 3100, timeoutMs: 90000, stateFile: join(dir, "rate.json"),
    now: () => clock, sleep: async (ms) => { waits.push(ms); clock += ms; },
    client: { async send(command, options) {
      starts.push(clock); commands.push(command.input);
      assert.ok(options.abortSignal instanceof AbortSignal);
      return send ? send(command) : { body: body(), $metadata: { requestId: "test-request" } };
    } },
  };
  return { cutout: createBedrockCutout(options), options, waits, starts, commands };
}

test("uses approved US profile, same source image, PNG output and returns actual foreground", async (t) => {
  const { cutout, commands } = await setup(t);
  let checkpoints = 0;
  const result = await cutout(original, async () => { checkpoints++; });
  assert.deepEqual(result.png, foreground);
  assert.equal(result.requestId, "test-request");
  assert.equal(checkpoints, 1);
  assert.deepEqual(JSON.parse(commands[0].body), { image: original.toString("base64"), output_format: "png" });
  assert.equal(commands[0].modelId, "us.stability.stable-image-remove-background-v1:0");
});

test("stage observation brackets actual Bedrock dispatch, preserves real seconds and never estimates charge", async t => {
  for (const fails of [false, true]) {
    const receipts = [], order = [];
    const f = await setup(t, fails ? async () => { order.push("send"); throw Object.assign(new Error("private body"), { name: "ThrottlingException" }); } : async () => { order.push("send"); return { body: body(), $metadata: { requestId: "offline" } }; });
    const observed = { onDispatch: async () => { order.push("dispatch-journal"); assert.equal(f.starts.length, 0); }, onReceipt: async receipt => receipts.push(receipt) };
    if (fails) await assert.rejects(f.cutout(original, async () => {}, observed), error => error.category === "provider_throttled");
    else assert.equal((await f.cutout(original, async () => {}, observed)).seconds, receipts.at(-1).reportedSeconds);
    assert.deepEqual(order, ["dispatch-journal", "send"]); assert.equal(f.starts.length, 1);
    assert.ok(receipts.every(receipt => receipt.newProviderRequests === 1 && receipt.costUSD === null));
  }
});

test("concurrent callers are spaced and a restarted scheduler retains previous dispatch time", async (t) => {
  const { cutout, options, starts, waits } = await setup(t);
  await Promise.all(Array.from({ length: 10 }, () => cutout(original)));
  assert.equal(starts.length, 10);
  for (let i = 1; i < starts.length; i++) assert.ok(starts[i] - starts[i - 1] >= 3100);
  assert.equal(waits.length, 9);
  await createBedrockCutout(options)(original);
  assert.equal(starts[10] - starts[9], 3100);
});

test("a throttled or ambiguous call reaches its caller without repeating the paid request", async (t) => {
  let calls = 0;
  const { cutout } = await setup(t, () => {
    calls++;
    throw Object.assign(new Error("upstream"), { name: calls === 1 ? "ThrottlingException" : "TimeoutError" });
  });
  await assert.rejects(cutout(original), /bedrock_throttled/);
  assert.equal(calls, 1);
  await assert.rejects(cutout(original), /bedrock_result_unknown/);
  assert.equal(calls, 2);
});

test("bad provider payload, rejection, non-RGBA and changed dimensions are failures", async (t) => {
  const wrongSize = Buffer.from(foreground); wrongSize.writeUInt32BE(65, 16);
  for (const output of [Buffer.from("bad-json"), body([], [null]), body(undefined, ["CONTENT_FILTERED"]),
    body([original.toString("base64")]), body([wrongSize.toString("base64")]), body(["invalid base64!"])]) {
    const { cutout } = await setup(t, () => ({ body: output, $metadata: { requestId: "test" } }));
    await assert.rejects(cutout(original), /invalid_bedrock|bedrock_cutout_rejected/);
  }
});

test("invalid input is rejected before any provider call", async (t) => {
  const { cutout, starts } = await setup(t);
  for (const value of [Buffer.from("not-png"), Buffer.alloc(0)]) await assert.rejects(cutout(value), /invalid_png/);
  assert.deepEqual(starts, []);
  assert.deepEqual(pngInfo(foreground), { width: 64, height: 64, colorType: 6 });
});

test("a pending reservation with an old timestamp forces a fresh interval after restart", async (t) => {
  const { options, starts, waits } = await setup(t);
  await writeFile(options.stateFile, JSON.stringify({ lastStarted: 1, pending: true }));
  const restarted = createBedrockCutout(options);
  await restarted.initialize();
  await restarted(original);
  assert.deepEqual(waits, [3100]);
  assert.equal(starts[0], 103100);
  assert.deepEqual(JSON.parse(await readFile(options.stateFile, "utf8")), { lastStarted: 103100, pending: false });
});

test("corrupt scheduler state fails initialization and store failure prevents dispatch", async (t) => {
  for (const state of ["invalid-json", JSON.stringify({ lastStarted: 0, pending: "wrong" })]) {
    const { options, starts } = await setup(t);
    await writeFile(options.stateFile, state);
    await assert.rejects(createBedrockCutout(options).initialize(), /scheduler state/i);
    assert.equal(starts.length, 0);
  }
  const { cutout, options, starts } = await setup(t);
  await cutout.initialize();
  await mkdir(options.stateFile);
  await assert.rejects(cutout(original), /Cannot persist Bedrock pacing/);
  assert.equal(starts.length, 0);
});

test("a failed durable paid-stage checkpoint starts no provider request", async (t) => {
  const { cutout, starts } = await setup(t);
  await assert.rejects(cutout(original, async () => { throw new Error("checkpoint failed"); }), /checkpoint failed/);
  assert.equal(starts.length, 0);
});

test("web identity credential acquisition uses Sydney STS even though Bedrock uses Oregon", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "cardgen-sts-"));
  const token = join(directory, "test-token");
  await writeFile(token, "offline-test-token");
  const keys = ["AWS_ROLE_ARN", "AWS_WEB_IDENTITY_TOKEN_FILE", "AWS_REGION", "AWS_DEFAULT_REGION"];
  const prior = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  t.after(async () => {
    for (const key of keys) {
      if (prior[key] === undefined) delete process.env[key]; else process.env[key] = prior[key];
    }
    await rm(directory, { recursive: true });
  });
  process.env.AWS_ROLE_ARN = "arn:aws:iam::123456789012:role/offline-only";
  process.env.AWS_WEB_IDENTITY_TOKEN_FILE = token;
  process.env.AWS_REGION = "ap-southeast-2";
  process.env.AWS_DEFAULT_REGION = "ap-southeast-2";
  const hosts = [];
  const client = createWorkloadBedrockClient({ region: "us-west-2", credentialRegion: "ap-southeast-2",
    credentialRequestHandler: { async handle(request) { hosts.push(request.hostname); throw new Error("offline_transport_blocked"); } },
  });
  await assert.rejects(client.config.credentials(), /offline_transport_blocked/);
  assert.deepEqual(hosts, ["sts.ap-southeast-2.amazonaws.com"]);
  assert.equal(await client.config.region(), "us-west-2");
  client.destroy();
});
