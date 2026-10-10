import { randomUUID, createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { JobExpiredError } from "./retention.mjs";

export const ASSET_SUFFIX = { main: ".png", cutout: ".cut.png", plate: ".plate.jpg" };
const LIMIT = { main: 12 * 1024 ** 2, cutout: 24 * 1024 ** 2, plate: 32 * 1024 ** 2 };
export class AssetUnavailableError extends Error {
  constructor(cause) { super("asset_unavailable", { cause }); this.name = "AssetUnavailableError"; this.category = "invalid_output"; }
}
export async function readRaster(path, name) {
  if (!Object.hasOwn(LIMIT, name)) throw new TypeError("Unknown raster layer");
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await handle.stat();
    if (!info.isFile() || info.size < 1 || info.size > LIMIT[name]) throw new AssetUnavailableError();
    const bytes = Buffer.alloc(info.size + 1);
    let size = 0;
    while (size < bytes.length) {
      const next = await handle.read(bytes, size, bytes.length - size, size);
      if (next.bytesRead === 0) break;
      size += next.bytesRead;
    }
    if (size !== info.size) throw new AssetUnavailableError();
    return bytes.subarray(0, size);
  } catch (cause) {
    if (cause instanceof AssetUnavailableError) throw cause;
    throw new AssetUnavailableError(cause);
  } finally { if (handle) await handle.close(); }
}
export async function verifyAsset(cache, job, name) {
  const asset = name === "main" ? job.result.main : job.result.layers[name];
  if (asset.state !== "ready") throw new AssetUnavailableError();
  let handle;
  try {
    handle = await open(join(cache, job.id + ASSET_SUFFIX[name]), constants.O_RDONLY | constants.O_NOFOLLOW);
    await verifyHandle(handle, name, asset.sha256);
  } catch (cause) {
    if (cause instanceof AssetUnavailableError) throw cause;
    throw new AssetUnavailableError(cause);
  } finally { if (handle) await handle.close(); }
}
export async function verifyHandle(handle, name, expectedHash) {
  const info = await handle.stat();
  if (!info.isFile() || info.size < 1 || info.size > LIMIT[name]) throw new AssetUnavailableError();
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of handle.createReadStream({ start: 0, autoClose: false, highWaterMark: 64 * 1024 })) {
    size += chunk.length;
    if (size > LIMIT[name]) throw new AssetUnavailableError();
    hash.update(chunk);
  }
  if (size !== info.size || hash.digest("hex") !== expectedHash) throw new AssetUnavailableError();
}
export async function durableWrite(path, bytes, assertActive) {
  const temporary = path + "." + randomUUID() + ".tmp";
  let handle, published = false;
  try {
    if (assertActive !== undefined) assertActive();
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(bytes); await handle.sync(); await handle.close(); handle = undefined;
    if (assertActive !== undefined) assertActive();
    await rename(temporary, path);
    published = true;
    handle = await open(dirname(path), "r"); await handle.sync();
    if (assertActive !== undefined) assertActive();
  } catch (error) {
    if (published && error instanceof JobExpiredError) await unlink(path);
    throw error;
  } finally {
    if (handle) await handle.close();
    try { await unlink(temporary); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}
