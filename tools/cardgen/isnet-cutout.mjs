import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { createSerialTaskQueue } from "./serial-task-queue.mjs";

const failure = (message, category = "provider_error", cause) =>
  Object.assign(new Error(message, { cause }), { category });

/** One resident CPU session per worker. No model retry, process restart or provider fallback. */
export function createIsnetCutout({ modelPath, threads, timeoutMs, startupTimeoutMs,
  spawnProcess = spawn }) {
  const enqueue = createSerialTaskQueue();
  let child, lines, initialization, ready, pending, sequence = 0, fatal, closed = false;
  let exited;
  function stop(error) {
    if (fatal === undefined) fatal = error;
    if (ready) { clearTimeout(ready.timer); ready.reject(fatal); ready = undefined; }
    if (pending) { clearTimeout(pending.timer); pending.reject(fatal); pending = undefined; }
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  function receive(line) {
    if (line.length > 4096) { stop(failure("isnet_protocol_too_large")); return; }
    let message;
    try { message = JSON.parse(line); }
    catch (cause) { stop(failure("isnet_invalid_protocol", "invalid_output", cause)); return; }
    if (message === null || typeof message !== "object" || Array.isArray(message)) {
      stop(failure("isnet_invalid_protocol", "invalid_output")); return;
    }
    if (ready && message.event === "ready" && message.model === "isnet-general-use") {
      clearTimeout(ready.timer); ready.resolve(); ready = undefined; return;
    }
    if (!pending || message.id !== pending.id || typeof message.ok !== "boolean") {
      stop(failure("isnet_unexpected_response", "invalid_output")); return;
    }
    const current = pending; pending = undefined; clearTimeout(current.timer);
    if (!message.ok) { current.reject(failure("isnet_invalid_output", "invalid_output")); return; }
    if (!Number.isFinite(message.seconds) || message.seconds < 0) {
      const error = failure("isnet_invalid_timing", "invalid_output"); current.reject(error); stop(error); return;
    }
    current.resolve(message);
  }
  async function initialize() {
    if (closed) throw failure("isnet_closed");
    if (fatal) throw fatal;
    if (initialization === undefined) {
      initialization = new Promise((resolve, reject) => {
        const timer = setTimeout(() => stop(failure("isnet_startup_timeout", "provider_timeout")), startupTimeoutMs);
        ready = { resolve, reject, timer };
        try {
          child = spawnProcess("python3", ["-u", new URL("./harness/isnet-worker.py", import.meta.url).pathname,
            "--model", modelPath, "--threads", String(threads)], { stdio: ["pipe", "pipe", "pipe"],
            env: { ...process.env, OMP_NUM_THREADS: String(threads) } });
        } catch (cause) { stop(failure("isnet_spawn_failed", "provider_error", cause)); return; }
        exited = new Promise((done) => child.once("close", done));
        lines = createInterface({ input: child.stdout });
        lines.on("line", receive);
        child.stderr.pipe(process.stderr, { end: false });
        child.on("error", (cause) => stop(failure("isnet_process_error", "provider_error", cause)));
        child.stdin.on("error", (cause) => stop(failure("isnet_input_closed", "provider_error", cause)));
        child.on("exit", (code, signal) => {
          if (!closed || pending || ready) stop(failure(`isnet_process_exit:${code}:${signal}`));
        });
      });
    }
    await initialization;
  }
  const cutout = (_image, checkpoint, paths) => enqueue(async () => {
    await initialize();
    await checkpoint();
    const id = ++sequence;
    const message = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => stop(failure("isnet_inference_timeout", "provider_timeout")), timeoutMs);
      pending = { id, resolve, reject, timer };
      child.stdin.write(JSON.stringify({ id, source: paths.source, target: paths.target }) + "\n",
        (cause) => { if (cause) stop(failure("isnet_dispatch_failed", "provider_error", cause)); });
    });
    const png = await readFile(paths.target);
    return { png, seconds: message.seconds };
  });
  cutout.initialize = initialize;
  cutout.healthy = () => !closed && fatal === undefined && initialization !== undefined && ready === undefined;
  cutout.close = async () => {
    if (closed) { if (exited) await exited; return; }
    closed = true;
    if (ready || pending) stop(failure("isnet_closed"));
    if (child) {
      child.stdin.end();
      const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
      try { await exited; } finally { clearTimeout(timer); lines.close(); }
    }
  };
  return cutout;
}
