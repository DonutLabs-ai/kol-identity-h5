import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { createSerialTaskQueue } from "./serial-task-queue.mjs";
import { ProcessingDeadlineError } from "./processing-deadline.mjs";

const failure = (message, category = "provider_error", cause) =>
  Object.assign(new Error(message, { cause }), { category });

/** One resident CPU session. A task cancellation retires its process without replaying inference. */
export function createIsnetCutout({ modelPath, threads, timeoutMs, startupTimeoutMs,
  spawnProcess = spawn }) {
  const enqueue = createSerialTaskQueue();
  let session, recovery, sequence = 0, fatal, closed = false;
  function rejectWork(owner, error) {
    for (const name of ["ready", "pending"]) {
      const work = owner[name];
      if (work) { clearTimeout(work.timer); owner[name] = undefined; work.reject(error); }
    }
  }
  function kill(owner) {
    if (owner.child && owner.child.exitCode === null && owner.child.signalCode === null)
      owner.child.kill("SIGKILL");
  }
  function stop(error, owner) {
    if (owner !== session || owner.retired) return;
    if (fatal === undefined) fatal = error;
    owner.retired = true; rejectWork(owner, fatal); kill(owner);
  }
  function receive(owner, line) {
    // Readline/error/exit callbacks can arrive after cancellation. Their resident
    // identity must never resolve or poison a request in the replacement process.
    if (owner !== session || owner.retired) return;
    if (line.length > 4096) { stop(failure("isnet_protocol_too_large"), owner); return; }
    let message;
    try { message = JSON.parse(line); }
    catch (cause) { stop(failure("isnet_invalid_protocol", "invalid_output", cause), owner); return; }
    if (message === null || typeof message !== "object" || Array.isArray(message)) {
      stop(failure("isnet_invalid_protocol", "invalid_output"), owner); return;
    }
    if (owner.ready && message.event === "ready" && message.model === "isnet-general-use") {
      clearTimeout(owner.ready.timer); owner.ready.resolve(); owner.ready = undefined; return;
    }
    if (!owner.pending || message.id !== owner.pending.id || typeof message.ok !== "boolean") {
      stop(failure("isnet_unexpected_response", "invalid_output"), owner); return;
    }
    const current = owner.pending; owner.pending = undefined; clearTimeout(current.timer);
    if (!message.ok) { current.reject(failure("isnet_invalid_output", "invalid_output")); return; }
    if (!Number.isFinite(message.seconds) || message.seconds < 0) {
      const error = failure("isnet_invalid_timing", "invalid_output"); current.reject(error); stop(error, owner); return;
    }
    current.resolve(message);
  }
  function start() {
    if (closed) throw failure("isnet_closed");
    if (fatal) throw fatal;
    if (session === undefined) {
      const owner = { retired: false }; session = owner;
      owner.initialization = new Promise((resolve, reject) => {
        const timer = setTimeout(() => stop(failure("isnet_startup_timeout", "provider_timeout"), owner), startupTimeoutMs);
        owner.ready = { resolve, reject, timer };
        try {
          owner.child = spawnProcess("python3", ["-u", new URL("./harness/isnet-worker.py", import.meta.url).pathname,
            "--model", modelPath, "--threads", String(threads)], { stdio: ["pipe", "pipe", "pipe"],
            env: { ...process.env, OMP_NUM_THREADS: String(threads) } });
        } catch (cause) { stop(failure("isnet_spawn_failed", "provider_error", cause), owner); return; }
        const child = owner.child;
        owner.exited = new Promise((done) => child.once("close", done));
        owner.lines = createInterface({ input: child.stdout });
        owner.lines.on("line", line => receive(owner, line));
        child.stderr.pipe(process.stderr, { end: false });
        child.on("error", (cause) => stop(failure("isnet_process_error", "provider_error", cause), owner));
        child.stdin.on("error", (cause) => stop(failure("isnet_input_closed", "provider_error", cause), owner));
        child.on("exit", (code, signal) => {
          if (!closed || owner.pending || owner.ready) stop(failure(`isnet_process_exit:${code}:${signal}`), owner);
        });
      });
    }
    return session.initialization;
  }
  async function initialize() {
    if (recovery) await recovery;
    await start();
  }
  function cancel(owner, error) {
    if (!(error instanceof ProcessingDeadlineError)) { stop(error, owner); return; }
    if (owner !== session || owner.retired) return;
    owner.retired = true; rejectWork(owner, error); kill(owner);
    // Retire the physical inference before loading exactly one replacement.
    // Failed initialization is a sticky component fault, never an inference retry.
    const replacing = (async () => {
      await owner.exited; owner.lines.close();
      if (closed) return;
      session = undefined;
      try { await start(); }
      catch (cause) { fatal = cause; }
    })();
    recovery = replacing;
    replacing.then(() => { if (recovery === replacing) recovery = undefined; });
    return replacing;
  }
  const cutout = (_image, checkpoint, paths) => enqueue(async () => {
    paths.signal?.throwIfAborted();
    await initialize();
    await checkpoint();
    if (paths.onDispatch !== undefined) await paths.onDispatch();
    if (paths.onReceipt !== undefined) await paths.onReceipt({ newProviderRequests: 0, costUSD: null, reportedSeconds: null });
    paths.signal?.throwIfAborted();
    const id = ++sequence;
    const owner = session;
    let retirement;
    const abort = () => { retirement = cancel(owner, paths.signal.reason); };
    let message;
    try {
      paths.signal?.addEventListener("abort", abort, { once: true });
      message = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => stop(failure("isnet_inference_timeout", "provider_timeout"), owner), timeoutMs);
        owner.pending = { id, resolve, reject, timer };
        owner.child.stdin.write(JSON.stringify({ id, source: paths.source, target: paths.target }) + "\n",
          (cause) => { if (cause) stop(failure("isnet_dispatch_failed", "provider_error", cause), owner); });
      });
    } finally {
      paths.signal?.removeEventListener("abort", abort);
      if (retirement) await retirement;
    }
    paths.signal?.throwIfAborted();
    const png = await readFile(paths.target);
    if (paths.onReceipt !== undefined) await paths.onReceipt({ newProviderRequests: 0, costUSD: null, reportedSeconds: message.seconds });
    return { png, seconds: message.seconds };
  });
  cutout.initialize = initialize;
  cutout.healthy = () => !closed && fatal === undefined && !recovery && session !== undefined && !session.retired && session.ready === undefined;
  cutout.close = async () => {
    if (closed) { if (session?.exited) await session.exited; return; }
    closed = true;
    const owner = session;
    if (owner?.ready || owner?.pending) stop(failure("isnet_closed"), owner);
    if (owner?.child) {
      const child = owner.child;
      child.stdin.end();
      const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
      try { await owner.exited; } finally { clearTimeout(timer); owner.lines.close(); }
    }
    if (recovery) await recovery;
  };
  return cutout;
}
