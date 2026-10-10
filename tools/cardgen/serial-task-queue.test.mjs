import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { createSerialTaskQueue } from "./serial-task-queue.mjs";

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test("different keys run FIFO with at most one active task", async () => {
  const enqueue = createSerialTaskQueue();
  const firstStarted = deferred(), releaseFirst = deferred();
  const events = [];
  let active = 0, maxActive = 0;
  const first = enqueue(async () => {
    active++; maxActive = Math.max(maxActive, active);
    events.push("start:key-a"); firstStarted.resolve();
    await releaseFirst.promise;
    events.push("end:key-a"); active--;
    return "key-a";
  });
  const second = enqueue(async () => {
    active++; maxActive = Math.max(maxActive, active);
    events.push("start:key-b");
    events.push("end:key-b"); active--;
    return "key-b";
  });
  const third = enqueue(() => { events.push("key-c"); return "key-c"; });
  await firstStarted.promise;
  assert.deepEqual(events, ["start:key-a"]);
  releaseFirst.resolve();
  assert.deepEqual(await Promise.all([first, second, third]), ["key-a", "key-b", "key-c"]);
  assert.equal(maxActive, 1);
  assert.equal(active, 0);
  assert.deepEqual(events, ["start:key-a", "end:key-a", "start:key-b", "end:key-b", "key-c"]);
});

test("rejected predecessor reaches its caller and unblocks the next key", async () => {
  const enqueue = createSerialTaskQueue();
  const releaseFirst = deferred(), firstStarted = deferred();
  const failure = new Error("key-a cutout failed"), events = [];
  const first = enqueue(async () => {
    events.push("key-a"); firstStarted.resolve();
    await releaseFirst.promise;
    throw failure;
  });
  const rejected = assert.rejects(first, (error) => error === failure);
  const second = enqueue(() => { events.push("key-b"); return "key-b"; });
  await firstStarted.promise;
  assert.deepEqual(events, ["key-a"]);
  releaseFirst.resolve();
  await rejected;
  assert.equal(await second, "key-b");
  assert.deepEqual(events, ["key-a", "key-b"]);
});

test("a synchronous throw also leaves the queue usable", async () => {
  const enqueue = createSerialTaskQueue();
  const failure = new Error("synchronous cutout failure");
  const first = enqueue(() => { throw failure; });
  const rejected = assert.rejects(first, (error) => error === failure);
  const second = enqueue(() => 42);
  await rejected;
  assert.equal(await second, 42);
});

test("actual cutout map shares one promise per key and serializes different keys after failure", async () => {
  const source = await readFile(new URL("./server.mjs", import.meta.url), "utf8");
  const start = source.indexOf("const inflight ="), end = source.indexOf("async function cutoutRun");
  assert.ok(start >= 0 && end > start);
  const releaseFirst = deferred(), firstStarted = deferred();
  const events = [], failure = new Error("key-a cutout failed");
  let active = 0, maxActive = 0;
  const cutoutFor = runInNewContext(source.slice(start, end) + "\ncutoutFor;", {
    createSerialTaskQueue,
    async cutoutRun(key) {
      active++; maxActive = Math.max(maxActive, active); events.push(key);
      try {
        if (key === "key-a" && events.length === 1) {
          firstStarted.resolve();
          await releaseFirst.promise;
          throw failure;
        }
        return key;
      } finally { active--; }
    },
  });
  const first = cutoutFor("key-a"), duplicate = cutoutFor("key-a");
  assert.equal(first, duplicate);
  const rejected = assert.rejects(first, (error) => error === failure);
  const second = cutoutFor("key-b");
  await firstStarted.promise;
  assert.deepEqual(events, ["key-a"]);
  releaseFirst.resolve();
  await rejected;
  assert.equal(await second, "key-b");
  assert.equal(await cutoutFor("key-a"), "key-a");
  assert.equal(maxActive, 1);
  assert.equal(active, 0);
  assert.deepEqual(events, ["key-a", "key-b", "key-a"]);
});
