import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  cardArtId,
  IMAGE_MODEL,
  PIPELINE_VERSION,
  ISNET_REVISION,
  pipelineDescriptor,
} from "./pipeline-version.mjs";
import { readServerConfig } from "./server-config.mjs";

test("cache identity covers each frozen provider/model/pipeline/revision as well as backend admission", () => {
  const bytes = Buffer.from("offline identity"),
    version = pipelineDescriptor(readServerConfig({}));
  const id = cardArtId(bytes, "sniper", "prompt-1", version);
  for (const field of [
    "imageModel",
    "pipelineVersion",
    "cutoutProvider",
    "cutoutModel",
    "cutoutRevision",
    "sourceRevision",
  ]) {
    assert.notEqual(
      cardArtId(bytes, "sniper", "prompt-1", {
        ...version,
        [field]: version[field] + ":different",
      }),
      id,
      field,
    );
  }
  const first = "11111111-1111-4111-8111-111111111111",
    second = "22222222-2222-4222-8222-222222222222";
  assert.notEqual(
    cardArtId(bytes, "sniper", "prompt-1", version, first),
    cardArtId(bytes, "sniper", "prompt-1", version, second),
  );
  assert.notEqual(cardArtId(bytes, "hodler", "prompt-1", version), id);
  assert.notEqual(cardArtId(bytes, "sniper", "prompt-2", version), id);
  assert.notEqual(
    cardArtId(Buffer.from("other avatar"), "sniper", "prompt-1", version),
    id,
  );
  assert.equal(IMAGE_MODEL, "google/gemini-3-pro-image");
  assert.equal(PIPELINE_VERSION, "DONUT_CARD_ART_THREE_LAYER_V1");
});

test("advertised IS-Net revision matches Docker artifact pin and actual Python startup enforcement", async () => {
  const [docker, python] = await Promise.all([
    readFile(new URL("./Dockerfile", import.meta.url), "utf8"),
    readFile(new URL("./harness/isnet-worker.py", import.meta.url), "utf8"),
  ]);
  const checksum = ISNET_REVISION.slice("sha256:".length);
  assert.ok(docker.includes("--checksum=sha256:" + checksum));
  assert.ok(python.includes('MODEL_SHA256 = "' + checksum + '"'));
  assert.ok(
    python.includes(
      'hashlib.file_digest(model, "sha256").hexdigest() != MODEL_SHA256',
    ),
  );
});
