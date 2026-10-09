#!/usr/bin/env node
import { join } from "node:path";
import { parseArgs } from "node:util";
import { apiKey, loadPrompts, CARDGEN } from "./harness/lib.mjs";
import { readServerConfig } from "./server-config.mjs";
import { createCardArtService } from "./card-art-service.mjs";

const { values } = parseArgs({ options: {
  port: { type: "string" }, host: { type: "string" }, cap: { type: "string" },
  pipeline: { type: "string" },
} });
const port = Number(values.port || process.env.PORT || "3022");
const host = values.host || process.env.HOST || "127.0.0.1";
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("invalid PORT");
if ((values.pipeline || process.env.CARD_PIPELINE || "fast") !== "fast") {
  throw new Error("The deployed worker requires CARD_PIPELINE=fast");
}
const config = readServerConfig(process.env, values.cap);
const runtime = await createCardArtService({ config, cache: join(CARDGEN, "out/server-cache"),
  prompts: await loadPrompts(), apiKey: await apiKey() });
runtime.server.listen(port, host, () => console.log(JSON.stringify({ event: "cardgen.started", port,
  source_revision: config.sourceRevision, cutout_region: config.bedrockRegion,
  cutout_model: config.bedrockModel, max_active_jobs: config.maxActiveJobs,
  max_queued_jobs: config.maxQueuedJobs })));
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  runtime.server.close();
  await runtime.queue.close();
}
process.on("SIGTERM", () => { shutdown().catch((error) => { console.error(error); process.exitCode = 1; }); });
process.on("SIGINT", () => { shutdown().catch((error) => { console.error(error); process.exitCode = 1; }); });
