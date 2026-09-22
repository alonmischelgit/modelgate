// Retries, breaker and failover, driven with the mock provider so the tests
// are deterministic, offline and free. Backoff is shrunk to keep them fast;
// the behaviour under test is the *number* of attempts and the *order* of
// providers, not the wall-clock.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { config } from "./config.js";
import { MemoryStore } from "./store/index.js";
import { MockProvider } from "./providers/mock.js";
import { CircuitBreaker, callWithFailover } from "./reliability.js";
import type { Provider, ChatRequest } from "./providers/types.js";
import type { RouteStep } from "./providers/registry.js";

const req: ChatRequest = { messages: [{ role: "user", content: "hi" }] };
const plan: RouteStep[] = [
  { provider: "mock-primary",   model: "mock-small",     substitute: false },
  { provider: "mock-secondary", model: "mock-small-alt", substitute: true },
];

beforeEach(() => {
  config.reliability.baseBackoffMs = 1;
  config.reliability.maxAttempts = 3;
  config.reliability.breakerThreshold = 3;
});

function fleet(primaryFailing: boolean) {
  const primary = new MockProvider("mock-primary", 1);
  primary.failing = primaryFailing;
  const secondary = new MockProvider("mock-secondary", 1);
  return new Map<string, Provider>([[primary.name, primary], [secondary.name, secondary]]);
}

test("healthy primary: one attempt, no failover", async () => {
  const breaker = new CircuitBreaker(new MemoryStore());
  const out = await callWithFailover(plan, fleet(false), req, breaker, () => {});
  assert.equal(out.providerUsed, "mock-primary");
  assert.equal(out.attempts, 1);
  assert.equal(out.failedOver, false);
  assert.equal(out.substituted, false);
});

test("failing primary: retried maxAttempts times, then fails over and reports substitution", async () => {
  const breaker = new CircuitBreaker(new MemoryStore());
  const trace: string[] = [];
  const out = await callWithFailover(plan, fleet(true), req, breaker, (m) => trace.push(m));
  assert.equal(out.providerUsed, "mock-secondary");
  assert.equal(out.modelUsed, "mock-small-alt");
  assert.equal(out.failedOver, true);
  assert.equal(out.substituted, true, "substitution must be declared, never silent");
  assert.equal(trace.filter((t) => /mock-primary\/mock-small attempt \d failed/.test(t)).length,
    config.reliability.maxAttempts);
  assert.equal(out.attempts, config.reliability.maxAttempts + 1, "attempts counts every provider call the caller paid for");
});

test("breaker opens after the threshold and the provider is skipped without being called", async () => {
  const store = new MemoryStore();
  const breaker = new CircuitBreaker(store);
  const providers = fleet(true);
  await callWithFailover(plan, providers, req, breaker, () => {});   // 3 failures -> trips

  assert.equal(await breaker.isOpen("mock-primary"), true);
  const trace: string[] = [];
  const out = await callWithFailover(plan, providers, req, breaker, (m) => trace.push(m));
  assert.deepEqual(out.breakerSkipped, ["mock-primary"]);
  assert.equal(out.attempts, 1, "no attempts were spent on the open circuit");
  assert.ok(!trace.some((t) => t.includes("mock-primary/mock-small attempt")));
});

test("a 4xx is not retried - our bug, fail fast", async () => {
  const bad: Provider = {
    name: "mock-primary",
    isReady: () => true,
    async complete() { throw Object.assign(new Error("bad request"), { status: 400 }); },
  };
  const providers = fleet(false);
  providers.set("mock-primary", bad);
  const breaker = new CircuitBreaker(new MemoryStore());
  const trace: string[] = [];
  const out = await callWithFailover(plan, providers, req, breaker, (m) => trace.push(m));
  assert.equal(trace.filter((t) => t.includes("mock-primary/mock-small attempt")).length, 1);
  assert.equal(out.providerUsed, "mock-secondary");
});

test("every route step exhausted: throws, so the pipeline can answer 503", async () => {
  const providers = fleet(true);
  (providers.get("mock-secondary") as MockProvider).failing = true;
  const breaker = new CircuitBreaker(new MemoryStore());
  await assert.rejects(() => callWithFailover(plan, providers, req, breaker, () => {}), /simulated/);
});

test("a 429 is retried but does NOT count toward opening the circuit", async () => {
  // A provider rate-limiting us means "slow down", not "down". Breaker state is
  // fleet-wide, so one tenant's burst must not take the provider away from
  // everyone.
  const limited: Provider = {
    name: "mock-primary",
    isReady: () => true,
    async complete() { throw Object.assign(new Error("rate limited"), { status: 429 }); },
  };
  const providers = fleet(false);
  providers.set("mock-primary", limited);
  const store = new MemoryStore();
  const breaker = new CircuitBreaker(store);
  const trace: string[] = [];
  const out = await callWithFailover(plan, providers, req, breaker, (m) => trace.push(m));
  assert.equal(trace.filter((t) => t.includes("mock-primary/mock-small attempt")).length,
    config.reliability.maxAttempts, "429s are retried");
  assert.equal(out.providerUsed, "mock-secondary");
  assert.equal(await breaker.isOpen("mock-primary"), false, "429s must not trip the breaker");
});

test("breaker tolerates a dead store: treated as closed, bookkeeping never throws", async () => {
  const dead = new MemoryStore();
  dead.get = async () => { throw new Error("redis down"); };
  dead.setex = async () => { throw new Error("redis down"); };
  dead.incrByFloat = async () => { throw new Error("redis down"); };
  const breaker = new CircuitBreaker(dead);
  assert.equal(await breaker.isOpen("mock-primary"), false);
  await breaker.recordFailure("mock-primary");
  await breaker.recordSuccess("mock-primary");
  const out = await callWithFailover(plan, fleet(false), req, breaker, () => {});
  assert.equal(out.providerUsed, "mock-primary");
});

test("a hung provider is not retried - one timeout, then fail over", async () => {
  config.policy.requestTimeoutMs = 30;
  const hung: Provider = { name: "mock-primary", isReady: () => true, complete: () => new Promise(() => {}) };
  const providers = fleet(false);
  providers.set("mock-primary", hung);
  const breaker = new CircuitBreaker(new MemoryStore());
  const trace: string[] = [];
  const t0 = Date.now();
  const out = await callWithFailover(plan, providers, req, breaker, (m) => trace.push(m));
  assert.equal(trace.filter((t) => t.includes("mock-primary/mock-small attempt")).length, 1, "no second wait on a hang");
  assert.equal(out.providerUsed, "mock-secondary");
  assert.ok(Date.now() - t0 < 500, "failover happened after one timeout, not three");
  config.policy.requestTimeoutMs = 30_000;
});

test("the deadline caps the whole plan: no failover is attempted once it has passed", async () => {
  config.policy.requestTimeoutMs = 30_000;
  const hung: Provider = { name: "mock-primary", isReady: () => true, complete: () => new Promise(() => {}) };
  const providers = fleet(false);
  providers.set("mock-primary", hung);
  const trace: string[] = [];
  await assert.rejects(
    () => callWithFailover(plan, providers, req, new CircuitBreaker(new MemoryStore()), (m) => trace.push(m), Date.now() + 30),
    /deadline/);
  assert.ok(!trace.some((t) => t.includes("mock-secondary")), "the secondary was never tried");
});
