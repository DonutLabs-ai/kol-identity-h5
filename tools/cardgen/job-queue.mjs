import { randomUUID } from "node:crypto";
import { mkdir, open, opendir, rename, unlink, lstat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { constants } from "node:fs";
import { FAILURE_STAGES, JobExpiredError, jobExpired, jobExpiresAt, normalizeExpiry, InvalidExpiryError, ExpiryConflictError } from "./retention.mjs";
import { requestKeyOf, normalizeRequestKey, RequestKeyConflictError } from "./pipeline-version.mjs";
import { initializeSamples, settleSamples, validateSamples } from "./stage-samples.mjs";

const ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const STATUSES = new Set(["queued", "running", "done", "failed"]);
const MAX_RECORD_BYTES = 16 * 1024;
const ERRORS = new Set([
  "provider_error", "provider_timeout", "provider_throttled", "provider_rejected",
  "provider_result_unknown", "invalid_output", "plate_error", "job_failed",
]);

export class QueueFullError extends Error {
  constructor() { super("Job queue capacity reached"); this.name = "QueueFullError"; }
}

export class HistoryFullError extends Error {
  constructor() { super("Retained job history capacity reached"); this.name = "HistoryFullError"; }
}

export class QueueCleanupBusyError extends Error {
  constructor() { super("Job cache cleanup in progress"); this.name = "QueueCleanupBusyError"; }
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
    || (Object.hasOwn(job, "error") && !ERRORS.has(job.error))
    || (Object.hasOwn(job, "attemptStage") && !FAILURE_STAGES.has(job.attemptStage))
    || (Object.hasOwn(job, "failure_stage") && !FAILURE_STAGES.has(job.failure_stage))) {
    throw new TypeError("Invalid persisted job record");
  }
  jobExpiresAt(job); // Validate explicit deadline against original creation, including expired recovery records.
  requestKeyOf(job);
  validateSamples(job);
  return jsonCopy(job);
}

function encodedRecord(job) {
  const snapshot = validateRecord(job);
  const serialized = JSON.stringify(snapshot) + "\n";
  if (Buffer.byteLength(serialized, "utf8") > MAX_RECORD_BYTES) {
    throw new TypeError(`Job record exceeds ${MAX_RECORD_BYTES}-byte metadata limit`);
  }
  return { snapshot, serialized };
}

async function readStoredRecord(path) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new TypeError("Job record must be a regular file");
    if (info.size > MAX_RECORD_BYTES) {
      throw new TypeError(`Job record exceeds ${MAX_RECORD_BYTES}-byte metadata limit`);
    }
    // One extra byte detects growth after stat without ever reading an unbounded file.
    const buffer = Buffer.alloc(info.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length !== info.size) throw new TypeError("Job record changed during recovery");
    return JSON.parse(buffer.subarray(0, length).toString("utf8"));
  } finally { await handle.close(); }
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
 * maxRetainedJobs bounds all job identities, including pending preparation and terminal history.
 * Expired history is removed by bounded sweeps; the capacity limit never evicts unexpired jobs.
 * Each journal record is bounded to 16 KiB of UTF-8 JSON, including its trailing newline.
 * Records contain a sequence so FIFO survives equal timestamps and process replacement.
 * prepare(payload), when supplied, runs once before durable admission and may update payload.
 * run must await checkpoint(job) before each paid call and after publishing known outputs.
 * This scheduler bounds execution; account-wide provider pacing belongs to the caller.
 */
export class PersistentJobQueue {
  #directory;
  #maxActive;
  #maxQueued;
  #maxRetainedJobs;
  #run;
  #jobs = new Map();
  #committed = new Map();
  #requestKeys = new Map();
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
  #now;
  #cleanup;
  #retiring = new Map();
  #orphanCleaning = new Map();
  #sweep;
  #cursor;

  constructor({ directory, maxActive, maxQueued, maxRetainedJobs = 20000, run, now = Date.now, cleanup = async () => {} }) {
    if (typeof directory !== "string" || directory.length === 0
      || !Number.isSafeInteger(maxActive) || maxActive < 1
      || !Number.isSafeInteger(maxQueued) || maxQueued < 0
      || !Number.isSafeInteger(maxActive + maxQueued)
      || !Number.isSafeInteger(maxRetainedJobs) || maxRetainedJobs < 1 || typeof run !== "function") {
      throw new TypeError("Configure directory, positive maxActive/maxRetainedJobs, nonnegative maxQueued and run");
    }
    this.#directory = resolve(directory);
    this.#maxActive = maxActive;
    this.#maxQueued = maxQueued;
    this.#maxRetainedJobs = maxRetainedJobs;
    this.#run = run;
    if (typeof now !== "function" || typeof cleanup !== "function") throw new TypeError("Clock and cleanup must be functions");
    this.#now = now;
    this.#cleanup = cleanup;
  }

  async initialize() {
    if (!this.#initialization) this.#initialization = this.#initialize();
    await this.#initialization;
  }

  async #initialize() {
    const files = [];
    try {
      await mkdir(this.#directory, { recursive: true, mode: 0o700 });
      const info = await lstat(this.#directory);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new TypeError("Job store must be a real directory");
      const directory = await opendir(this.#directory);
      // Count first: an oversized history must fail before any records are hydrated or changed.
      for await (const file of directory) {
        if (!file.name.endsWith(".json")) continue; // Unrenamed .tmp files were never admitted.
        if (files.length === this.#maxRetainedJobs) throw new HistoryFullError();
        files.push(file);
      }
    } catch (error) {
      if (error instanceof HistoryFullError) {
        throw new JobStoreError(`Job store exceeds retained job limit ${this.#maxRetainedJobs}`, error);
      }
      throw new JobStoreError("Cannot open job store", error);
    }
    // Read and validate everything before dispatching or changing recovery records.
    const loaded = [];
    const sequences = new Set();
    const requestKeys = new Set();
    for (const file of files) {
      try {
        if (!file.isFile()) throw new TypeError("Job record must be a regular file");
        const { snapshot: job } = encodedRecord(await readStoredRecord(join(this.#directory, file.name)));
        if (file.name !== `${job.id}.json` || sequences.has(job.sequence)) {
          throw new TypeError("Job filename or sequence does not match its record");
        }
        sequences.add(job.sequence);
        const requestKey = requestKeyOf(job);
        if (requestKey !== undefined) {
          if (requestKeys.has(requestKey)) throw new TypeError("Duplicate persisted requestKey");
          requestKeys.add(requestKey);
        }
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
        job.failure_stage = "unknown";
        settleSamples(job, this.#now(), true);
        job.updatedAt = new Date(this.#now()).toISOString();
        await this.#persist(job);
      }
      this.#jobs.set(job.id, job);
      const requestKey = requestKeyOf(job);
      if (requestKey !== undefined) this.#requestKeys.set(requestKey, job.id);
      this.#committed.set(job.id, jsonCopy(job));
      if (job.status === "queued") this.#waiting.push({ job, ready: true });
    }
    // No recovery dispatch until expired queued/crashed/terminal history is removed.
    await this.sweepExpired(this.#maxRetainedJobs);
    this.#initialized = true;
    this.#pump();
  }

  async submit(id, payload, prepare, expiresAt) {
    if (!this.#initialized) throw new Error("Initialize the job queue before submitting");
    if (typeof id !== "string" || !ID.test(id)) throw new TypeError("Invalid job ID");
    if (this.#retiring.has(id)) throw new JobExpiredError();
    if (this.#orphanCleaning.has(id)) throw new QueueCleanupBusyError();
    const requestedExpiry = expiresAt === undefined ? undefined : normalizeExpiry(expiresAt);
    const requestKey = requestKeyOf({ payload });
    const keyedId = requestKey === undefined ? undefined : this.#requestKeys.get(requestKey);
    if (keyedId !== undefined && keyedId !== id) {
      const keyed = this.#jobs.get(keyedId);
      if (jobExpired(keyed, this.#now())) throw new JobExpiredError();
      throw new RequestKeyConflictError();
    }
    const checkExistingExpiry = job => {
      if (jobExpired(job, this.#now())) throw new JobExpiredError();
      if (requestedExpiry !== undefined && Date.parse(requestedExpiry) !== jobExpiresAt(job)) throw new ExpiryConflictError();
    };
    const pending = this.#admissions.get(id);
    if (pending) {
      const job = await pending;
      checkExistingExpiry(job);
      return { job, created: false };
    }
    const existing = this.#jobs.get(id);
    if (existing) {
      checkExistingExpiry(existing);
      return { job: this.get(id), created: false };
    }
    if (this.#fatal) throw this.#fatal;
    if (this.#closed) throw new QueueClosedError();
    if (prepare !== undefined && typeof prepare !== "function") throw new TypeError("prepare must be a function");
    if (this.#jobs.size >= this.#maxRetainedJobs) throw new HistoryFullError();
    if (this.#active.size + this.#waiting.length >= this.#maxActive + this.#maxQueued) {
      throw new QueueFullError();
    }
    if (this.#sequence === Number.MAX_SAFE_INTEGER) throw new Error("Job sequence exhausted");
    const now = new Date(this.#now()).toISOString();
    const job = {
      id, payload: jsonCopy(payload), status: "queued", stage: "queued",
      sequence: this.#sequence + 1, createdAt: now, updatedAt: now,
      ...(requestedExpiry === undefined ? {} : { expiresAt: requestedExpiry }),
    };
    initializeSamples(job); // Queued/expired-without-dispatch jobs also have explicit zero denominators.
    if (requestedExpiry !== undefined && jobExpired(job, this.#now())) throw new InvalidExpiryError();
    encodedRecord(job); // Reject oversized metadata before prepare or any capacity reservation.
    this.#sequence++;
    // Reserve identity and capacity synchronously, before the first filesystem await.
    const entry = { job, ready: false };
    this.#jobs.set(id, job);
    if (requestKey !== undefined) this.#requestKeys.set(requestKey, id);
    this.#waiting.push(entry);
    const admission = Promise.resolve().then(() => this.#admit(entry, prepare));
    this.#admissions.set(id, admission);
    try { return { job: await admission, created: true }; }
    finally { this.#admissions.delete(id); }
  }

  async #admit(entry, prepare) {
    try {
      if (prepare) await prepare(entry.job.payload);
      if (jobExpired(entry.job, this.#now())) throw new JobExpiredError();
      await this.#persist(entry.job);
    }
    catch (error) {
      this.#jobs.delete(entry.job.id);
      const requestKey = requestKeyOf(entry.job);
      if (requestKey !== undefined) this.#requestKeys.delete(requestKey);
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

  getByRequestKey(requestKey) {
    const id = this.#requestKeys.get(normalizeRequestKey(requestKey));
    return id === undefined ? undefined : this.get(id);
  }

  async removeOrphan(id, action) {
    if (this.owns(id)) return false;
    // Reserve identity synchronously so a new admission cannot race this unlink.
    const removing = Promise.resolve().then(action);
    this.#orphanCleaning.set(id, removing);
    try { await removing; return true; }
    finally { this.#orphanCleaning.delete(id); }
  }

  owns(id) { return this.#jobs.has(id) || this.#admissions.has(id) || this.#retiring.has(id) || this.#orphanCleaning.has(id); }

  sweepExpired(limit = 100) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError("Invalid retention batch size");
    if (this.#sweep) return this.#sweep;
    const sweeping = this.#sweepExpired(limit);
    this.#sweep = sweeping;
    const clear = () => { if (this.#sweep === sweeping) this.#sweep = undefined; };
    sweeping.then(clear, clear);
    return sweeping;
  }

  async #sweepExpired(limit) {
    let scanned = 0, deleted = 0;
    if (!this.#cursor) this.#cursor = this.#jobs.values();
    for (let count = 0; count < limit; count++) {
      const next = this.#cursor.next();
      if (next.done) { this.#cursor = undefined; break; }
      const job = next.value; scanned++;
      if (!jobExpired(job, this.#now()) || this.#active.has(job.id)
        || this.#admissions.has(job.id) || this.#writes.has(job.id) || this.#retiring.has(job.id)) continue;
      // Prevent the queue pump from starting an expired queued job during filesystem cleanup.
      this.#waiting = this.#waiting.filter(entry => entry.job.id !== job.id);
      const removing = Promise.resolve().then(async () => {
        const directory = await lstat(this.#directory);
        if (!directory.isDirectory() || directory.isSymbolicLink()) throw new TypeError("Job store must remain a real directory");
        await this.#cleanup(job.id);
        try { await unlink(join(this.#directory, job.id + ".json")); }
        catch (error) { if (error.code !== "ENOENT") throw error; }
        const handle = await open(this.#directory, "r");
        try { await handle.sync(); } finally { await handle.close(); }
        this.#jobs.delete(job.id); this.#committed.delete(job.id);
        const requestKey = requestKeyOf(job);
        if (requestKey !== undefined) this.#requestKeys.delete(requestKey);
      });
      this.#retiring.set(job.id, removing);
      try { await removing; deleted++; }
      finally { this.#retiring.delete(job.id); }
    }
    return { scanned, deleted };
  }

  get healthy() { return this.#initialized && !this.#closed && this.#fatal === undefined; }

  get retainedJobs() { return this.#jobs.size; }

  get maxRetainedJobs() { return this.#maxRetainedJobs; }

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
    job.updatedAt = new Date(this.#now()).toISOString();
    await this.#persist(job);
  }

  async recordCacheReplay(id) {
    // Serialize against render checkpoints and concurrent replays; never persist a stale job copy.
    const job = this.#jobs.get(id);
    if (job === undefined || jobExpired(job, this.#now())) throw new JobExpiredError();
    if (job.cacheReplayCount === undefined) job.cacheReplayCount = 0;
    job.cacheReplayCount++;
    await this.#persist(job);
  }

  #pump() {
    while (!this.#closed && !this.#fatal && this.#active.size < this.#maxActive
      && this.#waiting[0]?.ready) {
      const { job } = this.#waiting.shift();
      if (jobExpired(job, this.#now())) {
        // Admission may wait beyond its retention boundary. Never start a new paid call.
        job.status = "failed"; job.error = "job_failed"; job.failure_stage = "unknown";
        continue;
      }
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
      job.updatedAt = new Date(this.#now()).toISOString();
      await this.#persist(job);
      if (this.#closed) {
        job.status = "queued";
        job.stage = "queued";
        job.updatedAt = new Date(this.#now()).toISOString();
        await this.#persist(job);
        this.#park(job);
        return;
      }
      if (jobExpired(job, this.#now())) {
        // FIFO/journal I/O can cross the original deadline before render begins.
        job.status = "failed"; job.error = "job_failed"; job.failure_stage = "unknown";
        job.updatedAt = new Date(this.#now()).toISOString();
        await this.#persist(job);
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
        const receipt = error !== null && typeof error === "object" ? error.failure_stage : undefined;
        if (["cutout", "plate", "validation"].includes(job.attemptStage)) job.failure_stage = job.attemptStage;
        else if (job.attemptStage === "llm") {
          // Only a genuine provider failure at the LLM boundary authorizes avatar fallback.
          job.failure_stage = FAILURE_STAGES.has(receipt) ? receipt
            : error !== null && typeof error === "object" && (ERRORS.has(error.category)
              && error.category.startsWith("provider_") || ["TimeoutError", "AbortError"].includes(error.name))
              ? "llm" : "unknown";
        } else job.failure_stage = FAILURE_STAGES.has(receipt) ? receipt : "unknown";
      }
      if (job.status !== "running" || this.#jobs.get(job.id) !== job) {
        throw new TypeError("run must leave job identity and status under queue control");
      }
      job.status = failed ? "failed" : "done";
      settleSamples(job, this.#now(), failed);
      if (failed) {
        job.error = failure;
      } else { delete job.error; delete job.failure_stage; }
      job.updatedAt = new Date(this.#now()).toISOString();
      await this.#persist(job);
    } finally { release(); }
  }

  #park(job) {
    this.#waiting.push({ job, ready: true });
    this.#waiting.sort((a, b) => a.job.sequence - b.job.sequence);
  }

  #persist(job) {
    // Capture now: later job mutations must not change an earlier checkpoint's contents.
    const original = this.#committed.get(job.id);
    if (original !== undefined && original.createdAt !== job.createdAt) throw new TypeError("Original job createdAt cannot change");
    if (original !== undefined && original.expiresAt !== job.expiresAt) throw new TypeError("Original job expiresAt cannot change");
    if (original !== undefined && requestKeyOf(original) !== requestKeyOf(job)) throw new TypeError("Original job requestKey cannot change");
    const { snapshot, serialized } = encodedRecord(job);
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
    if (this.#sweep) await this.#sweep;
    await Promise.allSettled([...this.#orphanCleaning.values()]);
    if (this.#fatal) throw this.#fatal;
  }
}
