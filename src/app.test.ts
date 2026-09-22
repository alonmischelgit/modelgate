// The HTTP layer, over a real socket on an ephemeral port: auth, validation
// wiring, headers, JSON errors, the scrape endpoint. The pipeline underneath is
// the mock fleet and the in-memory store, so this stays offline and fast.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import type { Server } from "node:http";

process.env.USAGE_LOG = path.join(os.tmpdir(), `modelgate-app-test-${process.pid}.jsonl`);

const { config } = await import("./config.js");
const { MemoryStore } = await import("./store/index.js");
const { CircuitBreaker } = await import("./reliability.js");
const { MockProvider } = await import("./providers/mock.js");
const { createApp } = await import("./app.js");
type Provider = import("./providers/types.js").Provider;

let server: Server;
let base: string;

before(async () => {
  const store = new MemoryStore();
  const primary = new MockProvider("mock-primary", 1);
  const providers = new Map<string, Provider>([[primary.name, primary], ["mock-secondary", new MockProvider("mock-secondary", 1)]]);
  const app = createApp({ store, providers, breaker: new CircuitBreaker(store) });
  await new Promise<void>((r) => { server = app.listen(0, "127.0.0.1", () => r()); });
  const addr = server.address() as { port: number };
  base = `http://127.0.0.1:${addr.port}`;
});
// closeAllConnections: fetch keeps sockets alive, and close() alone would wait
// out the keep-alive timeout (~5-8s) before the process could exit.
after(() => { server.closeAllConnections(); server.close(); });

const post = (body: string | object, headers: Record<string, string> = {}) =>
  fetch(`${base}/v1/chat`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": "http-test", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

test("no api key -> 401 missing_api_key", async () => {
  const r = await fetch(`${base}/v1/chat`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: "x" }] }) });
  assert.equal(r.status, 401);
  assert.equal((await r.json() as { error: string }).error, "missing_api_key");
});

test("malformed JSON -> 400 invalid_json, as JSON not HTML", async () => {
  const r = await post("{bad");
  assert.equal(r.status, 400);
  assert.match(r.headers.get("content-type") ?? "", /application\/json/);
  assert.equal((await r.json() as { error: string }).error, "invalid_json");
});

test("wrong field shape -> 400 invalid_request naming the field", async () => {
  const r = await post({ messages: [{ role: "user", content: "x" }], maxTokens: "abc" });
  assert.equal(r.status, 400);
  const b = await r.json() as { error: string; detail: string };
  assert.equal(b.error, "invalid_request");
  assert.match(b.detail, /maxTokens/);
});

test("x-request-id is honoured when sane, replaced when not, and always echoed", async () => {
  const ok = await post({ messages: [{ role: "user", content: "id" }] }, { "x-request-id": "trace-42" });
  assert.equal(ok.headers.get("x-request-id"), "trace-42");
  assert.equal((await ok.json() as { requestId: string }).requestId, "trace-42");

  const junk = await post({ messages: [{ role: "user", content: "id2" }] }, { "x-request-id": "a".repeat(300) });
  const id = junk.headers.get("x-request-id") ?? "";
  assert.notEqual(id, "a".repeat(300));
  assert.match(id, /^[0-9a-f-]{36}$/);
});

test("429 carries a Retry-After header", async () => {
  const saved = config.policy.rateLimitPerMin;
  config.policy.rateLimitPerMin = 3;
  try {
    const rs = await Promise.all(Array.from({ length: 8 }, (_, i) =>
      post({ messages: [{ role: "user", content: `b${i}` }] }, { "x-api-key": "http-burst" })));
    const limited = rs.find((r) => r.status === 429);
    assert.ok(limited, "expected at least one 429");
    assert.equal(limited.headers.get("retry-after"), "20");   // 60 / 3
  } finally { config.policy.rateLimitPerMin = saved; }
});

test("/metrics is Prometheus text with counters and a histogram", async () => {
  await post({ messages: [{ role: "user", content: "scrape me" }] });
  const r = await fetch(`${base}/metrics`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type") ?? "", /text\/plain/);
  const body = await r.text();
  assert.match(body, /# TYPE modelgate_requests_total counter/);
  assert.match(body, /modelgate_requests_total\{tenant="http-test",provider="mock-primary",model="mock-small",cached="false",ok="true"\} \d+/);
  assert.match(body, /modelgate_request_duration_seconds_bucket\{provider="mock-primary",cached="false",le="\+Inf"\} \d+/);
  assert.match(body, /modelgate_cost_usd_total\{/);
});

test("swagger assets: the two files are served, the package directory is not", async () => {
  assert.equal((await fetch(`${base}/swagger-ui/swagger-ui-bundle.js`)).status, 200);
  assert.equal((await fetch(`${base}/swagger-ui/package.json`)).status, 404);
});

test("/v1/models marks the default and /health reports the store", async () => {
  const models = await (await fetch(`${base}/v1/models`)).json() as { id: string; isDefault: boolean }[];
  assert.equal(models.filter((m) => m.isDefault).length, 1);
  const h = await (await fetch(`${base}/health`)).json() as { ok: boolean; store: string };
  assert.deepEqual(h, { ok: true, store: "memory" });
});

test("Cache-Control: no-cache bypasses the cache over HTTP", async () => {
  const body = { messages: [{ role: "user", content: "header bypass" }] };
  await post(body, { "x-api-key": "cc" });
  const hit = await post(body, { "x-api-key": "cc" });
  assert.equal((await hit.json() as { cached: boolean }).cached, true);
  const fresh = await post(body, { "x-api-key": "cc", "cache-control": "no-cache" });
  assert.equal((await fresh.json() as { cached: boolean }).cached, false);
});

test("oversized body -> 413 payload_too_large, as JSON", async () => {
  const r = await post({ messages: [{ role: "user", content: "a".repeat(1_100_000) }] });
  assert.equal(r.status, 413);
  assert.equal((await r.json() as { error: string }).error, "payload_too_large");
});
