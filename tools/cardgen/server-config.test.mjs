import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { Budget } from "./harness/lib.mjs";
import { parseBudgetLimit, readServerConfig, withAuthentication } from "./server-config.mjs";

test("absent or blank budget is unlimited; zero and finite caps are preserved", () => {
  for (const value of [undefined, "", " \t\n"]) {
    assert.equal(parseBudgetLimit(value), null);
    assert.equal(readServerConfig({ CARD_BUDGET: value }).budgetLimitUsd, null);
  }
  for (const [value, expected] of [["0", 0], ["0.14", 0.14], [" 20.50 ", 20.5], ["1e2", 100]]) {
    assert.equal(parseBudgetLimit(value), expected);
  }
  const unlimited = new Budget(Infinity);
  unlimited.check(21);
  const zero = new Budget(parseBudgetLimit("0"));
  assert.throws(() => zero.check(0.30), /budget cap \$0 reached/);
  const finite = new Budget(parseBudgetLimit("0.30"));
  finite.check(0.30);
  finite.add({ cost: 0.14 });
  assert.throws(() => finite.check(0.30), /budget cap/);
});

test("invalid budget fails config validation; CLI cap retains precedence", () => {
  for (const value of ["-1", "NaN", "Infinity", "-Infinity", "1e309", "20usd", true, null]) {
    assert.throws(() => readServerConfig({ CARD_BUDGET: value }), /finite nonnegative USD/);
  }
  assert.equal(readServerConfig({ CARD_BUDGET: "20" }, "0").budgetLimitUsd, 0);
  assert.equal(readServerConfig({ CARD_BUDGET: "20" }, "").budgetLimitUsd, null);
  assert.throws(() => readServerConfig({}, true), /finite nonnegative USD/);
});

test("required auth fails config validation without a nonblank token", () => {
  for (const token of [undefined, "", " \t\n"]) {
    assert.throws(
      () => readServerConfig({ CARD_REQUIRE_AUTH: "true", CARD_AUTH_TOKEN: token }),
      /^Error: CARD_AUTH_TOKEN is required when CARD_REQUIRE_AUTH=true$/,
    );
  }
  assert.equal(readServerConfig({}).authRequired, false);
  assert.equal(readServerConfig({ CARD_REQUIRE_AUTH: "false" }).authRequired, false);
  for (const required of [undefined, "false", "true"]) {
    const config = readServerConfig({ CARD_REQUIRE_AUTH: required, CARD_AUTH_TOKEN: "test-secret" });
    assert.equal(config.authRequired, true);
  }
  assert.equal(readServerConfig({ CARD_SOURCE_REVISION: "d4cc8fa" }).sourceRevision, "d4cc8fa");
});

async function testServer(t, config) {
  const requests = [];
  const server = http.createServer(withAuthentication((req, res) => {
    requests.push({ method: req.method, url: req.url });
    const code = req.method === "OPTIONS" ? 204 : req.url === "/unknown" ? 404 : 200;
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ routed: true }));
  }, config));
  t.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return { base: `http://127.0.0.1:${address.port}`, requests };
}

const protectedRoutes = [
  ["POST", "/v1/identity/card-art"],
  ["GET", "/v1/identity/card-art/abc123"],
  ["GET", "/art/abc123.png"],
  ["GET", "/art/abc123.cut.png"],
  ["GET", "/art/abc123.plate.jpg"],
  ["GET", "/unknown"],
  ["OPTIONS", "/v1/identity/card-art"],
  ["OPTIONS", "/healthz"],
  ["POST", "/healthz"],
  ["GET", "/healthz/"],
];

test("missing, wrong, or malformed bearer rejects every protected route before its handler", async (t) => {
  const token = "test-secret";
  const { base, requests } = await testServer(t, readServerConfig({ CARD_AUTH_TOKEN: token }));
  for (const authorization of [undefined, "Bearer wrong", "Bearer test-secreu", "Basic test-secret", "Bearer", "Bearer test-secret extra"]) {
    for (const [method, path] of protectedRoutes) {
      const headers = authorization === undefined ? {} : { authorization };
      const response = await fetch(base + path, { method, headers, body: method === "POST" ? "invalid json" : undefined });
      assert.equal(response.status, 401, `${method} ${path}, ${authorization}`);
      assert.equal(response.headers.get("www-authenticate"), "Bearer");
      assert.deepEqual(await response.json(), { error: "unauthorized" });
      assert.equal(requests.length, 0);
    }
  }
  const head = await fetch(base + "/healthz", { method: "HEAD" });
  assert.equal(head.status, 401);
  assert.equal(await head.text(), "");
  assert.equal(requests.length, 0);
});

test("correct bearer reaches all routes, including OPTIONS and unknown route handling", async (t) => {
  const { base, requests } = await testServer(t, readServerConfig({ CARD_REQUIRE_AUTH: "true", CARD_AUTH_TOKEN: "test-secret" }));
  for (const [method, path] of protectedRoutes) {
    const response = await fetch(base + path, { method, headers: { authorization: "Bearer test-secret" } });
    assert.equal(response.status, method === "OPTIONS" ? 204 : path === "/unknown" ? 404 : 200);
    await response.text();
    assert.deepEqual(requests.at(-1), { method, url: path });
  }
  const response = await fetch(base + "/art/abc123.png", { headers: { authorization: "bearer test-secret" } });
  assert.equal(response.status, 200);
  await response.text();
  assert.equal(requests.length, protectedRoutes.length + 1);
});

test("only GET health is public when token auth is configured", async (t) => {
  const { base, requests } = await testServer(t, readServerConfig({ CARD_REQUIRE_AUTH: "true", CARD_AUTH_TOKEN: "test-secret" }));
  for (const path of ["/healthz", "/healthz?probe=ready"]) {
    const response = await fetch(base + path, { headers: { authorization: "Bearer wrong" } });
    assert.equal(response.status, 200);
    await response.text();
    assert.deepEqual(requests.at(-1), { method: "GET", url: path });
  }
});

test("local demo remains unauthenticated only with auth not required and no token", async (t) => {
  const { base, requests } = await testServer(t, readServerConfig({}));
  for (const [method, path] of protectedRoutes) {
    const response = await fetch(base + path, { method });
    assert.equal(response.status, method === "OPTIONS" ? 204 : path === "/unknown" ? 404 : 200);
    await response.text();
  }
  assert.equal(requests.length, protectedRoutes.length);
});

async function actualHandler(config, cachedArt = false) {
  const source = await readFile(new URL("./server.mjs", import.meta.url), "utf8");
  const start = source.indexOf("const json ="), end = source.indexOf("/* --warm");
  assert.ok(start >= 0 && end > start);
  let handler;
  const reads = [];
  const assetBytes = Buffer.from("test-art");
  runInNewContext(source.slice(start, end), {
    http: { createServer(listener) { handler = listener; return { listen() {} }; } },
    withAuthentication, config, URL, join,
    PORT: 0, HOST: "127.0.0.1", PIPELINE: "fast",
    budget: { spent: 0.14 }, prompts: { version: "test-version", types: {} },
    CACHE: "/test-cache", jobs: new Map(),
    existsSync(path) { reads.push(path); return cachedArt; },
    async readFile(path) { reads.push(path); return assetBytes; },
  });
  assert.equal(typeof handler, "function");
  return { handler, reads, assetBytes };
}

async function callHandler(handler, method, url, authorization) {
  let code, headers, body;
  const req = {
    method, url, headers: { authorization },
    async *[Symbol.asyncIterator]() { throw new Error("request body must not be read"); },
  };
  const res = {
    writeHead(status, values) { code = status; headers = values; },
    end(value) { body = value; },
  };
  await handler(req, res);
  return { code, headers, body: typeof body === "string" && headers["Content-Type"] === "application/json" ? JSON.parse(body) : body };
}

test("actual server handler gates reads and body consumption, then routes authenticated requests", async () => {
  const { handler, reads } = await actualHandler(readServerConfig({ CARD_AUTH_TOKEN: "test-secret" }));
  for (const authorization of [undefined, "Bearer wrong"]) {
    for (const [method, path] of protectedRoutes) {
      const response = await callHandler(handler, method, path, authorization);
      assert.equal(response.code, 401);
      assert.deepEqual(response.body, { error: "unauthorized" });
      assert.deepEqual(reads, []);
    }
  }
  const art = await callHandler(handler, "GET", "/art/abc123.png", "Bearer test-secret");
  assert.equal(art.code, 404);
  assert.deepEqual(reads, ["/test-cache/abc123.png"]);
  const options = await callHandler(handler, "OPTIONS", "/v1/identity/card-art", "Bearer test-secret");
  assert.equal(options.code, 204);
  assert.match(options.headers["Access-Control-Allow-Headers"], /authorization/);
  const unknown = await callHandler(handler, "GET", "/unknown", "Bearer test-secret");
  assert.equal(unknown.code, 404);
});

test("actual health keeps existing fields and reports revision, enforced auth and nullable budget", async () => {
  for (const [env, fields] of [
    [{}, { auth_required: false, budget_limit_usd: null }],
    [{ CARD_AUTH_TOKEN: "test-secret", CARD_BUDGET: "0", CARD_SOURCE_REVISION: "d4cc8fa" },
      { source_revision: "d4cc8fa", auth_required: true, budget_limit_usd: 0 }],
    [{ CARD_BUDGET: "0.50" }, { auth_required: false, budget_limit_usd: 0.5 }],
  ]) {
    const { handler, reads } = await actualHandler(readServerConfig(env));
    const response = await callHandler(handler, "GET", "/healthz");
    assert.equal(response.code, 200);
    assert.deepEqual(response.body, {
      ok: true, pipeline: "fast", spent_usd: 0.14, prompt_version: "test-version", ...fields,
    });
    assert.deepEqual(reads, []);
  }
});

test("all three art assets cache privately with bearer auth and publicly for an unauthenticated demo", async () => {
  for (const [env, cacheControl] of [
    [{}, "public, max-age=86400"],
    [{ CARD_AUTH_TOKEN: "test-secret" }, "private, max-age=86400"],
    [{ CARD_AUTH_TOKEN: "test-secret", CARD_REQUIRE_AUTH: "false" }, "private, max-age=86400"],
    [{ CARD_AUTH_TOKEN: "test-secret", CARD_REQUIRE_AUTH: "true" }, "private, max-age=86400"],
  ]) {
    const config = readServerConfig(env);
    const { handler, reads, assetBytes } = await actualHandler(config, true);
    for (const suffix of [".png", ".cut.png", ".plate.jpg"]) {
      const path = "/art/abc123" + suffix;
      const before = reads.length;
      if (config.authRequired) {
        for (const authorization of [undefined, "Bearer wrong"]) {
          const denied = await callHandler(handler, "GET", path, authorization);
          assert.equal(denied.code, 401);
          assert.equal(reads.length, before);
        }
      }
      const response = await callHandler(handler, "GET", path, config.authRequired ? "Bearer test-secret" : undefined);
      assert.equal(response.code, 200);
      assert.equal(response.headers["Cache-Control"], cacheControl);
      assert.equal(response.headers["Content-Type"], suffix.endsWith(".jpg") ? "image/jpeg" : "image/png");
      assert.deepEqual(response.body, assetBytes);
      assert.equal(reads.length, before + 2);
    }
  }
});
