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
  const authToken = (env.CARD_AUTH_TOKEN || "").trim();
  if (env.CARD_REQUIRE_AUTH === "true" && authToken === "") {
    throw new Error("CARD_AUTH_TOKEN is required when CARD_REQUIRE_AUTH=true");
  }
  return {
    authToken,
    authRequired: authToken !== "",
    budgetLimitUsd: parseBudgetLimit(budgetOverride === undefined ? env.CARD_BUDGET : budgetOverride),
    sourceRevision: env.CARD_SOURCE_REVISION,
  };
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
