// The middleware chain end to end, against the in-memory store and the mock
// providers: no network, no keys, no spend. Each test proves one behaviour a
// caller can observe, in the same order the request walks the chain.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

// Keep test usage records out of the real data/usage.jsonl. Must be set before
// the metrics module is loaded, hence the dynamic imports below.
process.env.USAGE_LOG = path.join(os.tmpdir(), `modelgate-test-${process.pid}.jsonl`);

const { config } = await import("./config.js");
const { MemoryStore } = await import("./store/index.js");
const { CircuitBreaker } = await import("./reliability.js");
const { MockProvider } = await import("./providers/mock.js");
const { handleChat } = await import("./pipeline.js");
type Provider = import("./providers/types.js").Provider;

async function gateway() {
  const store = new MemoryStore();
  const primary = new MockProvider("mock-primary", 1);
  const secondary = new MockProvider("mock-secondary", 1);
  const providers = new Map<string, Provider>([[primary.name, primary], [secondary.name, secondary]]);
  return { store, providers, breaker: new CircuitBreaker(store), primary, secondary };
}

const ask = (content: string, extra: Record<string, unknown> = {}) =>
  ({ messages: [{ role: "user" as const, content }], ...extra });

beforeEach(() => {
  config.policy.defaultModel = "mock-small";
  config.policy.rateLimitPerMin = 60;
  config.policy.budgetUsdPerDay = 5;
  config.policy.cacheTtlSeconds = 300;
  config.reliability.baseBackoffMs = 1;
});

test("unknown model is a 400 before any quota is consumed", async () => {
  const g = await gateway();
  const r = await handleChat("t", ask("hi", { model: "gpt-9-turbo" }), g);
  assert.equal(r.status, 400);
  assert.equal(r.body.error, "unknown_model");
  assert.ok(Array.isArray(r.body.supportedModels));
  // the rate-limit bucket was never touched
  assert.equal(await g.store.takeToken("rl:t", 60, 1, Date.now() / 1000), 59);
});

test("identical request is served from cache: no provider, no cost, same shape", async () => {
  const g = await gateway();
  const first = await handleChat("t", ask("what is a token bucket"), g);
  const second = await handleChat("t", ask("what is a token bucket"), g);
  assert.equal(first.body.cached, false);
  assert.equal(second.body.cached, true);
  assert.equal(second.body.costUsd, 0);
  assert.deepEqual(second.body.servedBy, first.body.servedBy);
  assert.equal(second.body.text, first.body.text);
});

test("cache is tenant-scoped: another tenant with the same prompt misses", async () => {
  const g = await gateway();
  await handleChat("tenant-a", ask("summarise our revenue"), g);
  const other = await handleChat("tenant-b", ask("summarise our revenue"), g);
  assert.equal(other.body.cached, false, "cross-tenant cache hit is a data leak");
});

test("thinkingBudget is part of the cache key", async () => {
  const g = await gateway();
  await handleChat("t", ask("q", { thinkingBudget: 0 }), g);
  const r = await handleChat("t", ask("q", { thinkingBudget: 1024 }), g);
  assert.equal(r.body.cached, false);
});

test("rate limit: a concurrent burst beyond capacity gets 429s", async () => {
  config.policy.rateLimitPerMin = 5;
  const g = await gateway();
  const results = await Promise.all(
    Array.from({ length: 12 }, (_, i) => handleChat("burst", ask(`q${i}`), g)));
  const limited = results.filter((r) => r.status === 429);
  assert.equal(results.length - limited.length, 5, "exactly `capacity` requests pass");
  assert.equal(limited[0].body.error, "rate_limit_exceeded");
});

test("budget: refused before the call once the daily cap is spent", async () => {
  config.policy.budgetUsdPerDay = 0.01;
  const g = await gateway();
  const day = new Date().toISOString().slice(0, 10);
  await g.store.incrByFloat(`spend:t:${day}`, 0.01, 86_400);
  const r = await handleChat("t", ask("expensive?"), g);
  assert.equal(r.status, 402);
  assert.equal(r.body.error, "budget_exceeded");
});

test("provider outage: fails over to a same-tier model and says so", async () => {
  const g = await gateway();
  g.primary.failing = true;
  const r = await handleChat("t", ask("failover please"), g);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.servedBy, { provider: "mock-secondary", model: "mock-small-alt" });
  assert.equal(r.body.substituted, true);
  assert.equal(r.body.failedOver, true);
});

test("allowSubstitute: false turns an outage into an honest 503, not a different model's answer", async () => {
  const g = await gateway();
  g.primary.failing = true;
  const r = await handleChat("t", ask("pinned", { model: "mock-small", allowSubstitute: false }), g);
  assert.equal(r.status, 503);
  assert.equal(r.body.error, "all_providers_failed");
});

test("every response carries a trace, including errors", async () => {
  const g = await gateway();
  const ok = await handleChat("t", ask("traced"), g);
  const bad = await handleChat("t", ask("x", { model: "nope" }), g);
  assert.ok(ok.trace.length >= 4);
  assert.ok(bad.trace.length >= 1);
});

// --- Tool calling ---------------------------------------------------------

const weather = {
  name: "get_weather",
  description: "Current weather for a city.",
  parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
};

test("tools: the model asks for a tool; the gateway returns the call and runs nothing", async () => {
  const g = await gateway();
  const r = await handleChat("t", ask("weather in Haifa?", { tools: [weather] }), g);
  assert.equal(r.status, 200);
  assert.equal(r.body.stopReason, "tool_use");
  const calls = r.body.toolCalls as { id: string; name: string; arguments: Record<string, unknown> }[];
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "get_weather");
  assert.ok("city" in calls[0].arguments);
});

test("tools: sending the result back completes the turn in text", async () => {
  const g = await gateway();
  const r = await handleChat("t", {
    messages: [
      { role: "user", content: "weather in Haifa?" },
      { role: "assistant", content: "", toolCalls: [{ id: "call_1", name: "get_weather", arguments: { city: "Haifa" } }] },
      { role: "tool", toolCallId: "call_1", content: "29C, clear" },
    ],
    tools: [weather],
  }, g);
  assert.equal(r.body.stopReason, "end");
  assert.match(String(r.body.text), /29C, clear/);
  assert.equal(r.body.toolCalls, undefined);
});

test("tools are part of the cache key", async () => {
  const g = await gateway();
  await handleChat("t", ask("same prompt"), g);
  const withTools = await handleChat("t", ask("same prompt", { tools: [weather] }), g);
  assert.equal(withTools.body.cached, false, "a different tool list is a different question");
});

// --- Store failure policy ---------------------------------------------------
// Redis dying under a running fleet. Each concern has its own answer.

type Store = import("./store/index.js").Store;
type Op = "takeToken" | "get" | "setex" | "incrByFloat";

/** A store where chosen operations throw, as a dying Redis would. */
class FlakyStore implements Store {
  readonly kind = "memory" as const;
  private inner = new MemoryStore();
  constructor(private broken: Set<Op>) {}
  private check(op: Op) { if (this.broken.has(op)) throw new Error(`redis down (${op})`); }
  async takeToken(key: string, cap: number, refill: number, now: number) { this.check("takeToken"); return this.inner.takeToken(key, cap, refill, now); }
  async get(key: string) { this.check("get"); return this.inner.get(key); }
  async setex(key: string, ttl: number, value: string) { this.check("setex"); return this.inner.setex(key, ttl, value); }
  async incrByFloat(key: string, delta: number, ttl: number) { this.check("incrByFloat"); return this.inner.incrByFloat(key, delta, ttl); }
  async close() {}
}

async function flakyGateway(broken: Set<Op>) {
  const g = await gateway();
  const store = new FlakyStore(broken);
  return { ...g, store, breaker: new CircuitBreaker(store) };
}

test("store down at the rate limiter: fail OPEN, request is served", async () => {
  const g = await flakyGateway(new Set(["takeToken"]));
  const r = await handleChat("t", ask("hello"), g);
  assert.equal(r.status, 200);
  assert.ok(r.trace.some((t) => /rate limit: store unavailable .* failing open/.test(t)));
});

test("store down at the budget check: fail CLOSED with 503 store_unavailable", async () => {
  const g = await flakyGateway(new Set(["get"]));
  const r = await handleChat("t", ask("hello"), g);
  assert.equal(r.status, 503);
  assert.equal(r.body.error, "store_unavailable");
  assert.ok(r.trace.some((t) => /budget: store unavailable .* failing CLOSED/.test(t)));
});

test("store down at cache write: request still succeeds, trace says so", async () => {
  const g = await flakyGateway(new Set(["setex"]));
  const r = await handleChat("t", ask("hello"), g);
  assert.equal(r.status, 200);
  assert.ok(r.trace.some((t) => /cache write: store unavailable/.test(t)));
});

test("store down at the budget RESERVATION: fail CLOSED - money is the one thing we do not guess", async () => {
  const g = await flakyGateway(new Set(["incrByFloat"]));
  const r = await handleChat("t", ask("hello"), g);
  assert.equal(r.status, 503);
  assert.equal(r.body.error, "store_unavailable");
  assert.ok(r.trace.some((t) => /cannot reserve/.test(t)));
});

// --- Contract details -------------------------------------------------------

test("retryAfterSec reflects the actual refill rate, not a constant", async () => {
  config.policy.rateLimitPerMin = 10;   // one token every 6s
  const g = await gateway();
  const results = await Promise.all(Array.from({ length: 12 }, (_, i) => handleChat("ra", ask(`q${i}`), g)));
  const limited = results.find((r) => r.status === 429)!;
  assert.equal(limited.body.retryAfterSec, 6);
});

test("every response carries the request id, and a caller-supplied one is honoured", async () => {
  const g = await gateway();
  const ok = await handleChat("t", ask("id?"), g, "req-123");
  assert.equal(ok.body.requestId, "req-123");
  const bad = await handleChat("t", ask("x", { model: "nope" }), g);
  assert.equal(typeof bad.body.requestId, "string");
});

test("usage records carry substitution/failover so stats can count them", async () => {
  const { stats } = await import("./metrics.js");
  const before = stats().failovers;
  const g = await gateway();
  g.primary.failing = true;
  await handleChat("t", ask("count me"), g);
  assert.equal(stats().failovers, before + 1);
});

// --- Cache semantics found in review ---------------------------------------

test("model omitted and model: <default> are the same question - one cache entry", async () => {
  const g = await gateway();
  await handleChat("t", ask("normalise me"), g);
  const explicit = await handleChat("t", ask("normalise me", { model: "mock-small" }), g);
  assert.equal(explicit.body.cached, true);
});

test("a cache hit reports zero usage, consistent with costUsd: 0", async () => {
  const g = await gateway();
  await handleChat("t", ask("usage on hit"), g);
  const hit = await handleChat("t", ask("usage on hit"), g);
  assert.equal(hit.body.cached, true);
  assert.deepEqual(hit.body.usage, { inputTokens: 0, outputTokens: 0 });
});

// --- Budget under concurrency: reserve, then settle -------------------------

test("budget is reserved atomically: a concurrent burst cannot overshoot the cap", async () => {
  const { estimateCost } = await import("./pipeline.js");
  const est = estimateCost("mock-small", ask("q0"));
  config.policy.budgetUsdPerDay = est * 2.5;   // room for exactly two reservations
  const g = await gateway();
  const results = await Promise.all(Array.from({ length: 10 }, (_, i) => handleChat("cap", ask(`q${i}`), g)));
  const passed = results.filter((r) => r.status === 200).length;
  const refused = results.filter((r) => r.status === 402).length;
  assert.equal(passed, 2, "the counter, not a read, decides who gets in");
  assert.equal(refused, 8);
  // and what is left on the counter is the REAL cost of the two, not their reservations
  const day = new Date().toISOString().slice(0, 10);
  const spent = Number(await g.store.get(`spend:cap:${day}`));
  assert.ok(spent > 0 && spent < est * 2, `settled spend ${spent} should be below two reservations ${est * 2}`);
});

test("a failed call releases its reservation", async () => {
  const g = await gateway();
  g.primary.failing = true; g.secondary.failing = true;
  const r = await handleChat("rel", ask("doomed"), g);
  assert.equal(r.status, 503);
  const day = new Date().toISOString().slice(0, 10);
  assert.equal(Number(await g.store.get(`spend:rel:${day}`) ?? 0), 0);
});

test("the whole request has a deadline: hung providers end in 504 deadline_exceeded, not minutes later", async () => {
  config.policy.requestDeadlineMs = 40;
  const g = await gateway();
  const hang = () => new Promise<never>(() => {});
  g.primary.complete = hang; g.secondary.complete = hang;
  const t0 = Date.now();
  const r = await handleChat("dl", ask("hang"), g);
  assert.equal(r.status, 504);
  assert.equal(r.body.error, "deadline_exceeded");
  assert.ok(Date.now() - t0 < 1000);
  config.policy.requestDeadlineMs = 60_000;
});

// --- Cache controls ---------------------------------------------------------
// Defaults are policy, overrides are per request, the response is the truth.

test("cache: false bypasses the cache - neither read nor written", async () => {
  const g = await gateway();
  await handleChat("t", ask("fresh please"), g);                                  // populates
  const bypass = await handleChat("t", ask("fresh please", { cache: false }), g);
  assert.equal(bypass.body.cached, false, "not read");
  assert.ok(bypass.trace.some((l) => /cache bypassed by caller/.test(l)));
  const again = await handleChat("t", ask("fresh please"), g);
  assert.equal(again.body.cached, true, "the earlier entry is intact; the bypass did not overwrite it");

  const g2 = await gateway();
  await handleChat("t", ask("never stored", { cache: false }), g2);
  const after = await handleChat("t", ask("never stored"), g2);
  assert.equal(after.body.cached, false, "not written");
});

test("a pinned request is never served a cached answer from a substitute", async () => {
  const g = await gateway();
  g.primary.failing = true;
  const sub = await handleChat("t", ask("pin me"), g);                       // cached from mock-small-alt
  assert.equal(sub.body.substituted, true);
  g.primary.failing = false;
  const pinned = await handleChat("t", ask("pin me", { model: "mock-small", allowSubstitute: false }), g);
  assert.equal(pinned.body.cached, false);
  assert.deepEqual(pinned.body.servedBy, { provider: "mock-primary", model: "mock-small" });
  assert.ok(pinned.trace.some((l) => /caller pinned/.test(l)));
});

test("CACHE_TTL_SECONDS=0 disables caching cleanly: no reads, no writes, no store errors", async () => {
  config.policy.cacheTtlSeconds = 0;
  const g = await gateway();
  const a = await handleChat("t", ask("ttl zero"), g);
  const b = await handleChat("t", ask("ttl zero"), g);
  assert.equal(b.body.cached, false);
  assert.ok(a.trace.some((l) => /cache disabled by policy/.test(l)));
  assert.ok(!a.trace.some((l) => /store unavailable/.test(l)), "no setex with ttl 0 was attempted");
});

// --- Single-flight ------------------------------------------------------------

test("concurrent identical requests: one provider call, the rest coalesce onto it", async () => {
  const g = await gateway();
  g.primary.latencyMs = 40;
  const results = await Promise.all(Array.from({ length: 5 }, () => handleChat("t", ask("stampede"), g)));
  const leaders = results.filter((r) => !r.body.cached);
  const followers = results.filter((r) => r.body.coalesced === true);
  assert.equal(leaders.length, 1, "exactly one request paid for the answer");
  assert.equal(followers.length, 4);
  assert.ok(results.every((r) => r.body.text === leaders[0].body.text), "everyone got the same answer");
  assert.ok(followers.every((r) => r.body.costUsd === 0 && r.body.cached === true));
  assert.ok(followers.every((r) => r.trace.some((l) => /coalesced onto an identical in-flight/.test(l))));
});

test("single-flight: if the leader fails, a follower makes its own attempt", async () => {
  const g = await gateway();
  g.primary.latencyMs = 30;
  g.secondary.latencyMs = 30;
  g.primary.failing = true; g.secondary.failing = true;
  const [a, b] = await Promise.all([handleChat("t", ask("doomed leader"), g), handleChat("t", ask("doomed leader"), g)]);
  assert.equal(a.status, 503);
  assert.equal(b.status, 503);
  assert.ok(b.trace.some((l) => /leader failed - making our own attempt/.test(l)) ||
            a.trace.some((l) => /leader failed - making our own attempt/.test(l)));
});

test("single-flight does not apply to cache-bypassing requests", async () => {
  const g = await gateway();
  g.primary.latencyMs = 30;
  const results = await Promise.all(Array.from({ length: 3 }, () => handleChat("t", ask("fresh each", { cache: false }), g)));
  assert.ok(results.every((r) => r.body.cached === false && r.body.coalesced === undefined));
});

test("a known model whose provider has no key is 503 model_unavailable, not 'unknown'", async () => {
  const g = await gateway();   // only the two mocks are configured
  const r = await handleChat("t", ask("hi", { model: "gemini-3.6-flash" }), g);
  assert.equal(r.status, 503);
  assert.equal(r.body.error, "model_unavailable");
  assert.match(String(r.body.detail), /provider \(google\) is not configured/);
  assert.deepEqual(r.body.availableModels, ["mock-small", "mock-small-alt"]);
});
