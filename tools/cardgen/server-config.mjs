import { createHash, timingSafeEqual } from "node:crypto";

export function parseBudgetLimit(value) {
  if (value === undefined || (typeof value === "string" && value.trim() === "")) return null;
  if (typeof value !== "string") throw new Error("CARD_BUDGET must be a finite nonnegative USD amount");
  const limit = Number(value);
  if (!Number.isFinite(limit) || limit < 0) {
    throw new Error("CARD_BUDGET must be a finite nonnegative USD amount");
  }
  return limit;
}

export function readServerConfig(env = process.env, budgetOverride) {
  const cutoutProvider = env.CARD_CUTOUT_PROVIDER || "isnet";
  if (cutoutProvider !== "isnet" && cutoutProvider !== "bedrock") {
    throw new Error("CARD_CUTOUT_PROVIDER must be isnet or bedrock");
  }
  const bedrockModel = env.CARD_BEDROCK_MODEL || "us.stability.stable-image-remove-background-v1:0";
  const authToken = (env.CARD_AUTH_TOKEN || "").trim();
  if (env.CARD_REQUIRE_AUTH === "true" && authToken === "") {
    throw new Error("CARD_AUTH_TOKEN is required when CARD_REQUIRE_AUTH=true");
  }
  return {
    authToken,
    authRequired: authToken !== "",
    budgetLimitUsd: parseBudgetLimit(budgetOverride === undefined ? env.CARD_BUDGET : budgetOverride),
    sourceRevision: env.CARD_SOURCE_REVISION,
    cutoutProvider,
    cutoutModel: cutoutProvider === "isnet" ? "isnet-general-use" : bedrockModel,
    isnetModelPath: env.CARD_ISNET_MODEL_PATH || "/opt/cardgen-models/isnet-general-use.onnx",
    isnetThreads: positiveInteger(env.CARD_ISNET_THREADS, 2, "CARD_ISNET_THREADS"),
    isnetTimeoutMs: positiveInteger(env.CARD_ISNET_TIMEOUT_MS, 60000, "CARD_ISNET_TIMEOUT_MS"),
    isnetStartupTimeoutMs: positiveInteger(env.CARD_ISNET_STARTUP_TIMEOUT_MS, 120000, "CARD_ISNET_STARTUP_TIMEOUT_MS"),
    bedrockRegion: env.CARD_BEDROCK_REGION || "us-west-2",
    credentialRegion: env.AWS_REGION || "ap-southeast-2",
    bedrockModel,
    bedrockMinIntervalMs: positiveInteger(env.CARD_BEDROCK_MIN_INTERVAL_MS, 3100, "CARD_BEDROCK_MIN_INTERVAL_MS"),
    bedrockTimeoutMs: positiveInteger(env.CARD_BEDROCK_TIMEOUT_MS, 90000, "CARD_BEDROCK_TIMEOUT_MS"),
    maxActiveJobs: positiveInteger(env.CARD_MAX_ACTIVE_JOBS, 4, "CARD_MAX_ACTIVE_JOBS"),
    maxQueuedJobs: positiveInteger(env.CARD_MAX_QUEUED_JOBS, 1000, "CARD_MAX_QUEUED_JOBS"),
    maxRetainedJobs: positiveInteger(env.CARD_MAX_RETAINED_JOBS, 20000, "CARD_MAX_RETAINED_JOBS"),
    minFreeDiskBytes: positiveInteger(env.CARD_MIN_FREE_DISK_BYTES, 5 * 1024 ** 3, "CARD_MIN_FREE_DISK_BYTES"),
    maxRequestBytes: positiveInteger(env.CARD_MAX_REQUEST_BYTES, 8 * 1024 * 1024, "CARD_MAX_REQUEST_BYTES"),
    maxAvatarBytes: positiveInteger(env.CARD_MAX_AVATAR_BYTES, 5 * 1024 * 1024, "CARD_MAX_AVATAR_BYTES"),
    maxHttpRequests: positiveInteger(env.CARD_MAX_HTTP_REQUESTS, 64, "CARD_MAX_HTTP_REQUESTS"),
  };
}

function positiveInteger(value, defaultValue, name) {
  if (value === undefined || value === "") return defaultValue;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(name + " must be a positive integer");
  return parsed;
}

export function withAuthentication(handler, config) {
  // Fixed-size digests allow constant-time comparison even when token lengths differ.
  const expected = createHash("sha256").update(config.authToken).digest();
  return (req, res) => {
    const publicHealth = req.method === "GET" && req.url.split("?")[0] === "/healthz";
    if (config.authRequired && !publicHealth) {
      const header = req.headers.authorization;
      const bearer = typeof header === "string" ? /^Bearer (.+)$/i.exec(header) : null;
      if (!bearer || !timingSafeEqual(expected, createHash("sha256").update(bearer[1]).digest())) {
        res.writeHead(401, {
          "Content-Type": "application/json",
          "WWW-Authenticate": "Bearer",
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Headers": "content-type, authorization",
        });
        return res.end(JSON.stringify({ error: "unauthorized" }));
      }
    }
    return handler(req, res);
  };
}
