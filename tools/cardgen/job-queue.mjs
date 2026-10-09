import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";

const ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const STATUSES = new Set(["queued", "running", "done", "failed"]);
const ERRORS = new Set([
  "provider_error", "provider_timeout", "provider_throttled", "provider_rejected",
  "provider_result_unknown", "invalid_output", "plate_error", "job_failed",
]);

export class QueueFullError extends Error {
  constructor() { super("Job queue capacity reached"); this.name = "QueueFullError"; }
}

export class QueueClosedError extends Error {
  constructor() { super("Job queue is closed"); this.name = "QueueClosedError"; }
}

export class JobStoreError extends Error {
  constructor(message, cause) {
    super(message, { cause });
    this.name = "JobStoreError";
  }
}

function jsonCopy(value) {
  const visiting = new Set();
  function validate(item) {
    if (item === null || typeof item === "string" || typeof item === "boolean") return;
    if (typeof item === "number" && Number.isFinite(item)) return;
    if (typeof item !== "object" || visiting.has(item)) {
      throw new TypeError("Job data must contain only finite, acyclic JSON values");
    }
    if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype) {
      throw new TypeError("Job data must contain plain JSON objects");
    }
    visiting.add(item);
    for (const child of Object.values(item)) validate(child);
    visiting.delete(item);
  }
  validate(value);
  return JSON.parse(JSON.stringify(value));
}

function validateRecord(job) {
  if (job === null || typeof job !== "object" || Array.isArray(job)
    || typeof job.id !== "string" || !ID.test(job.id)
    || !Object.hasOwn(job, "payload") || !STATUSES.has(job.status)
    || typeof job.stage !== "string" || job.stage.length === 0
    || !Number.isSafeInteger(job.sequence) || job.sequence < 1
    || typeof job.createdAt !== "string" || !Number.isFinite(Date.parse(job.createdAt))
    || typeof job.updatedAt !== "string" || !Number.isFinite(Date.parse(job.updatedAt))
    || (Object.hasOwn(job, "error") && !ERRORS.has(job.error))) {
    throw new TypeError("Invalid persisted job record");
  }
  return jsonCopy(job);
}

function errorCategory(error) {
  if (error !== null && typeof error === "object") {
    for (const field of ["category", "code", "message"]) {
      if (ERRORS.has(error[field])) return error[field];
    }
    if (error.name === "TimeoutError" || error.code === "ETIMEDOUT") return "provider_timeout";
    if (error.name === "ThrottlingException") return "provider_throttled";
  }
  return "provider_error";
}

/** Single process/replica only. maxQueued bounds waiting admission in addition to maxActive slots.
 * Records contain a sequence so FIFO survives equal timestamps and process replacement.
 * prepare(payload), when supplied, runs once before durable admission and may update payload.
 * run must await checkpoint(job) before each paid call and after publishing known outputs.
 * This scheduler bounds execution; account-wide provider pacing belongs to the caller.
 */
export class PersistentJobQueue {
  #directory;
  #maxActive;
  #maxQueued;
  #run;
  #jobs = new Map();
  #committed = new Map();
  #admissions = new Map();
  #waiting = [];
  #active = new Map();
  #writes = new Map();
  #sequence = 0;
  #startTail = Promise.resolve();
  #initialization;
  #initialized = false;
  #closed = false;
  #fatal;

  constructor({ directory, maxActive, maxQueued, run }) {
    if (typeof directory !== "string" || directory.length === 0
      || !Number.isSafeInteger(maxActive) || maxActive < 1
      || !Number.isSafeInteger(maxQueued) || maxQueued < 0
      || !Number.isSafeInteger(maxActive + maxQueued) || typeof run !== "function") {
      throw new TypeError("Configure directory, positive maxActive, nonnegative maxQueued and run");
    }
    this.#directory = resolve(directory);
    this.#maxActive = maxActive;
    this.#maxQueued = maxQueued;
    this.#run = run;
  }

  async initialize() {
    if (!this.#initialization) this.#initialization = this.#initialize();
    await this.#initialization;
  }

  async #initialize() {
    let files;
    try {
      await mkdir(this.#directory, { recursive: true, mode: 0o700 });
      files = await readdir(this.#directory, { withFileTypes: true });
    } catch (error) {
      throw new JobStoreError("Cannot open job store", error);
    }
    // Read and validate everything before dispatching or changing recovery records.
    const loaded = [];
    const sequences = new Set();
    for (const file of files) {
      if (!file.name.endsWith(".json")) continue; // Unrenamed .tmp files were never admitted.
      try {
        if (!file.isFile()) throw new TypeError("Job record must be a regular file");
        const job = validateRecord(JSON.parse(await readFile(join(this.#directory, file.name), "utf8")));
        if (file.name !== `${job.id}.json` || sequences.has(job.sequence)) {
          throw new TypeError("Job filename or sequence does not match its record");
        }
        sequences.add(job.sequence);
        loaded.push(job);
      } catch (error) {
        throw new JobStoreError(`Cannot recover job record ${file.name}`, error);
      }
    }
    loaded.sort((a, b) => a.sequence - b.sequence);
    for (const job of loaded) {
      this.#sequence = Math.max(this.#sequence, job.sequence);
      if (job.status === "running") {
        job.status = "failed";
        job.error = "provider_result_unknown";
        job.updatedAt = new Date().toISOString();
        await this.#persist(job);
      }
      this.#jobs.set(job.id, job);
      this.#committed.set(job.id, jsonCopy(job));
      if (job.status === "queued") this.#waiting.push({ job, ready: true });
    }
    this.#initialized = true;
    this.#pump();
  }

  async submit(id, payload, prepare) {
    if (!this.#initialized) throw new Error("Initialize the job queue before submitting");
    if (typeof id !== "string" || !ID.test(id)) throw new TypeError("Invalid job ID");
    const pending = this.#admissions.get(id);
    if (pending) return { job: await pending, created: false };
    const existing = this.#jobs.get(id);
    if (existing) return { job: this.get(id), created: false };
    if (this.#fatal) throw this.#fatal;
    if (this.#closed) throw new QueueClosedError();
    if (prepare !== undefined && typeof prepare !== "function") throw new TypeError("prepare must be a function");
    if (this.#active.size + this.#waiting.length >= this.#maxActive + this.#maxQueued) {
      throw new QueueFullError();
    }
    if (this.#sequence === Number.MAX_SAFE_INTEGER) throw new Error("Job sequence exhausted");
    const now = new Date().toISOString();
    const job = {
      id, payload: jsonCopy(payload), status: "queued", stage: "queued",
      sequence: ++this.#sequence, createdAt: now, updatedAt: now,
    };
    // Reserve identity and capacity synchronously, before the first filesystem await.
    const entry = { job, ready: false };
    this.#jobs.set(id, job);
    this.#waiting.push(entry);
    const admission = Promise.resolve().then(() => this.#admit(entry, prepare));
    this.#admissions.set(id, admission);
    try { return { job: await admission, created: true }; }
    finally { this.#admissions.delete(id); }
  }

  async #admit(entry, prepare) {
    try {
      if (prepare) await prepare(entry.job.payload);
      await this.#persist(entry.job);
    }
    catch (error) {
      this.#jobs.delete(entry.job.id);
      this.#waiting.splice(this.#waiting.indexOf(entry), 1);
      this.#pump();
      throw error;
    }
    entry.ready = true;
    this.#pump();
    return entry.job;
  }

  get(id) {
    const job = this.#committed.get(id);
    return job === undefined ? undefined : jsonCopy(job);
  }

  get healthy() { return this.#initialized && !this.#closed && this.#fatal === undefined; }

  stats() {
    // Pending preparation reserves available start slots before any I/O.
    const reserved = this.#closed ? 0 : Math.min(this.#waiting.length, this.#maxActive - this.#active.size);
    return {
      active: this.#active.size + reserved,
      queued: this.#waiting.length - reserved,
      max_active: this.#maxActive,
      max_queued: this.#maxQueued,
    };
  }

  async checkpoint(job) {
    if (this.#jobs.get(job.id) !== job || !this.#active.has(job.id) || job.status !== "running") {
      throw new TypeError("Checkpoint requires the active running job record");
    }
    if (this.#fatal) throw this.#fatal;
    job.updatedAt = new Date().toISOString();
    await this.#persist(job);
  }

  #pump() {
    while (!this.#closed && !this.#fatal && this.#active.size < this.#maxActive
      && this.#waiting[0]?.ready) {
      const { job } = this.#waiting.shift();
      const execution = this.#execute(job);
      this.#active.set(job.id, execution);
      execution.then(
        () => { this.#active.delete(job.id); this.#pump(); },
        (error) => {
          this.#fatal = error;
          this.#active.delete(job.id);
          console.error("PersistentJobQueue stopped: job state could not be committed");
        },
      );
    }
  }

  async #execute(job) {
    const predecessor = this.#startTail;
    let release;
    this.#startTail = new Promise((resolveStart) => { release = resolveStart; });
    await predecessor;
    try {
      if (this.#fatal) throw this.#fatal;
      if (this.#closed) { this.#park(job); return; }
      job.status = "running";
      job.stage = "running";
      job.updatedAt = new Date().toISOString();
      await this.#persist(job);
      if (this.#closed) {
        job.status = "queued";
        job.stage = "queued";
        job.updatedAt = new Date().toISOString();
        await this.#persist(job);
        this.#park(job);
        return;
      }
      let outcome;
      try { outcome = Promise.resolve(this.#run(job, (current = job) => this.checkpoint(current))); }
      catch (error) { outcome = Promise.reject(error); }
      release(); // Start FIFO, but let already started jobs execute concurrently.
      let failure;
      let failed = false;
      try { await outcome; }
      catch (error) {
        if (error instanceof JobStoreError) throw error;
        failed = true;
        failure = errorCategory(error);
      }
      if (job.status !== "running" || this.#jobs.get(job.id) !== job) {
        throw new TypeError("run must leave job identity and status under queue control");
      }
      job.status = failed ? "failed" : "done";
      if (failed) job.error = failure;
      else delete job.error;
      job.updatedAt = new Date().toISOString();
      await this.#persist(job);
    } finally { release(); }
  }

  #park(job) {
    this.#waiting.push({ job, ready: true });
    this.#waiting.sort((a, b) => a.job.sequence - b.job.sequence);
  }

  #persist(job) {
    // Capture now: later job mutations must not change an earlier checkpoint's contents.
    const snapshot = validateRecord(job);
    const serialized = JSON.stringify(snapshot) + "\n";
    const previous = this.#writes.get(snapshot.id) || Promise.resolve();
    const writing = previous.then(async () => {
      await this.#atomicWrite(snapshot.id, serialized);
      this.#committed.set(snapshot.id, snapshot);
    });
    this.#writes.set(snapshot.id, writing);
    const cleanup = () => { if (this.#writes.get(snapshot.id) === writing) this.#writes.delete(snapshot.id); };
    writing.then(cleanup, cleanup);
    return writing;
  }

  async #atomicWrite(id, serialized) {
    const temporary = join(this.#directory, `.${id}.${randomUUID()}.tmp`);
    let handle;
    try {
      handle = await open(temporary, "wx", 0o600);
      await handle.writeFile(serialized, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporary, join(this.#directory, `${id}.json`));
      handle = await open(this.#directory, "r");
      await handle.sync();
      await handle.close();
      handle = undefined;
    } catch (error) {
      const failure = new JobStoreError(`Cannot persist job ${id}; dispatch stopped`, error);
      this.#fatal = failure;
      throw failure;
    } finally {
      if (handle) await handle.close();
      try { await unlink(temporary); }
      catch (error) { if (error.code !== "ENOENT") throw new JobStoreError("Cannot clean uncommitted job file", error); }
    }
  }

  async close() {
    this.#closed = true;
    if (this.#initialization) await this.#initialization;
    await Promise.allSettled([...this.#admissions.values()]);
    await Promise.allSettled([...this.#active.values()]);
    await Promise.allSettled([...this.#writes.values()]);
    if (this.#fatal) throw this.#fatal;
  }
}
