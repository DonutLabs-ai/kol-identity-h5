import { lstat, opendir, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";

export const FAILURE_STAGES = new Set([
  "llm",
  "cutout",
  "plate",
  "validation",
  "unknown",
]);
export function expiresAt(createdAt) {
  const original = new Date(createdAt);
  if (!Number.isFinite(original.getTime()))
    throw new TypeError("Invalid original job createdAt");
  const target = new Date(original);
  target.setUTCDate(1);
  target.setUTCMonth(target.getUTCMonth() + 6);
  const lastDay = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(original.getUTCDate(), lastDay));
  return target.getTime();
}
export class InvalidExpiryError extends Error {
  constructor() {
    super("Invalid expiresAt");
    this.name = "InvalidExpiryError";
  }
}
export class ExpiryConflictError extends Error {
  constructor() {
    super("Immutable job expiry conflicts with request");
    this.name = "ExpiryConflictError";
  }
}
export function normalizeExpiry(value) {
  if (typeof value !== "string") throw new InvalidExpiryError();
  const parts =
    /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(
      value,
    );
  if (!parts) throw new InvalidExpiryError();
  const year = Number(parts[1]),
    month = Number(parts[2]),
    day = Number(parts[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const lastDay =
    month === 2 ? (leap ? 29 : 28) : [4, 6, 9, 11].includes(month) ? 30 : 31;
  const time = Date.parse(value);
  if (day > lastDay || !Number.isFinite(time)) throw new InvalidExpiryError();
  return new Date(time).toISOString();
}
export function jobExpiresAt(job) {
  const cap = expiresAt(job.createdAt);
  if (!Object.hasOwn(job, "expiresAt")) return cap;
  const deadline = Date.parse(normalizeExpiry(job.expiresAt));
  if (deadline > cap) throw new InvalidExpiryError();
  return deadline;
}
export function jobExpired(job, now) {
  return now >= jobExpiresAt(job);
}
export class JobExpiredError extends Error {
  constructor() {
    super("Job retention expired");
    this.name = "JobExpiredError";
  }
}
const HASH = /^[a-f0-9]{24}$/;
const UUID = "[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}";
const PERSONAL = new RegExp(
  "^([a-f0-9]{24})(\\.png|\\.cut\\.png(?:\\.tmp)?|\\.plate\\.jpg(?:\\.tmp)?|\\.avatar\\.(?:png|jpg|webp|gif)|\\.stage1\\.png|\\.raw\\.json)(?:\\.(?:" +
    UUID +
    "\\.tmp|isnet\\.tmp|tmp))?$",
);
const JOURNAL_TEMP = new RegExp("^\\.([a-f0-9]{24})\\." + UUID + "\\.tmp$");
const PERSONAL_SUFFIXES = [
  ".png",
  ".cut.png",
  ".plate.jpg",
  ".avatar.png",
  ".avatar.jpg",
  ".avatar.webp",
  ".avatar.gif",
  ".stage1.png",
  ".raw.json",
  ".cut.png.tmp", ".cut.png.tmp.isnet.tmp", ".cut.png.isnet.tmp",
  ".plate.jpg.tmp", ".plate.jpg.tmp.tmp",
];
async function unlinkOwned(file) {
  try {
    await unlink(file);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

/** Only direct job-hash files in the designated cache. Never follow paths from a journal payload. */
export function createRetentionFiles(cache, ownsJob, removeOrphan) {
  const root = resolve(cache),
    jobs = join(root, "jobs");
  const cursors = new Map();
  async function requireDirectory(directory) {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new TypeError("Retention directory must be a real directory");
  }
  return {
    async removeJob(id) {
      if (!HASH.test(id))
        throw new TypeError("Personal cache requires a canonical job hash");
      await requireDirectory(root);
      // Constant-size asset set removed before the owning journal. unlink never follows symlinks.
      for (const suffix of PERSONAL_SUFFIXES)
        await unlinkOwned(join(root, id + suffix));
    },
    async sweepOrphans(limit) {
      let scanned = 0,
        deleted = 0;
      // Keep each directory iterator between ticks; both scans and deletions are bounded.
      for (const [directory, pattern] of [
        [root, PERSONAL],
        [jobs, JOURNAL_TEMP],
      ]) {
        await requireDirectory(directory);
        let cursor = cursors.get(directory);
        if (!cursor) {
          cursor = await opendir(directory);
          cursors.set(directory, cursor);
        }
        for (let count = 0; count < limit; count++) {
          const file = await cursor.read();
          if (file === null) {
            await cursor.close();
            cursors.delete(directory);
            break;
          }
          scanned++;
          const match = pattern.exec(file.name);
          if (!match || file.isDirectory() || ownsJob(match[1])) continue;
          if (
            await removeOrphan(match[1], () =>
              unlinkOwned(join(directory, file.name)),
            )
          )
            deleted++;
        }
      }
      return { scanned, deleted };
    },
    async close() {
      for (const cursor of cursors.values()) await cursor.close();
      cursors.clear();
    },
  };
}
