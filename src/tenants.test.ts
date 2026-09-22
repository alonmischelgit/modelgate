// Per-tenant policy: limits, budgets and the provider allowlist, resolved from
// tenants.json over env defaults, and enforced by the pipeline.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

process.env.USAGE_LOG = path.join(os.tmpdir(), `modelgate-tenants-test-${process.pid}.jsonl`);

const { config } = await import("./config.js");
const { configureTenants, policyFor, loadTenantsFile } = await import("./tenants.js");
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
  config.policy.rateLimitPerMin = 60;
  config.policy.budgetUsdPerDay = 5;
  config.reliability.baseBackoffMs = 1;
  configureTenants({
    default: { rateLimitPerMin: 30 },
    tenants: {
      "big":    { rateLimitPerMin: 100, budgetUsdPerDay: 50 },
      "tiny":   { rateLimitPerMin: 2 },
      "no-alt": { providers: ["mock-primary"], note: "may not use the secondary" },
    },
  });
});

test("resolution: tenant > file default > env", () => {
  assert.equal(policyFor("big").rateLimitPerMin, 100);
  assert.equal(policyFor("big").budgetUsdPerDay, 50);
  assert.equal(policyFor("tiny").rateLimitPerMin, 2);
  assert.equal(policyFor("tiny").budgetUsdPerDay, 5,  "budget not in file -> env");
  assert.equal(policyFor("stranger").rateLimitPerMin, 30, "unknown tenant -> file default");
  assert.equal(policyFor("stranger").budgetUsdPerDay, 5,  "-> env when the file default is silent");
  assert.equal(policyFor("stranger").providers, undefined, "no allowlist means every provider");
});

test("a missing tenants.json is fine: env defaults for everyone", () => {
  assert.equal(loadTenantsFile(path.join(os.tmpdir(), "does-not-exist.json")), 0);
  assert.equal(policyFor("anyone").rateLimitPerMin, config.policy.rateLimitPerMin);
});

test("the tenant's own rate limit is enforced, not the instance default", async () => {
  const g = await gateway();
  const results = await Promise.all(Array.from({ length: 6 }, (_, i) => handleChat("tiny", ask(`q${i}`), g)));
  assert.equal(results.filter((r) => r.status === 200).length, 2);
  assert.equal(results.find((r) => r.status === 429)!.body.limitPerMin, 2);
});

test("the trace names the policy that applied", async () => {
  const g = await gateway();
  const r = await handleChat("no-alt", ask("who am i"), g);
  assert.ok(r.trace.some((l) => /tenant no-alt: .*providers: mock-primary.*may not use the secondary/.test(l)));
});

test("provider allowlist: a forbidden provider is simply not in the route plan", async () => {
  const g = await gateway();
  const r = await handleChat("no-alt", ask("route me"), g);
  assert.equal(r.status, 200);
  assert.ok(r.trace.some((l) => l.startsWith("   0ms route: mock-primary/mock-small") && !l.includes("mock-secondary")));
});

test("provider allowlist: with the only allowed provider down, it is an honest failure, never the forbidden one", async () => {
  const g = await gateway();
  g.primary.failing = true;
  const r = await handleChat("no-alt", ask("tempting"), g);
  assert.equal(r.status, 503, "must not fail over to mock-secondary");
  assert.ok(!r.trace.some((l) => l.includes("mock-secondary")));
});

test("provider allowlist: a pinned request for a forbidden provider's model is 403, with the allowed list", async () => {
  const g = await gateway();
  const r = await handleChat("no-alt", ask("give me alt", { model: "mock-small-alt", allowSubstitute: false }), g);
  assert.equal(r.status, 403);
  assert.equal(r.body.error, "provider_not_allowed");
  assert.match(String(r.body.detail), /substitution is disabled/);
  assert.deepEqual(r.body.allowedProviders, ["mock-primary"]);
});

test("provider allowlist: the same request WITH substitution allowed is served by an allowed same-tier model", async () => {
  const g = await gateway();
  const r = await handleChat("no-alt", ask("give me alt", { model: "mock-small-alt" }), g);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.servedBy, { provider: "mock-primary", model: "mock-small" });
  assert.equal(r.body.substituted, true, "declared, as always");
});

test("provider allowlist: a forbidden model's request fails over to an ALLOWED same-tier model, declared", async () => {
  configureTenants({ tenants: { "alt-only": { providers: ["mock-secondary"] } } });
  const g = await gateway();
  const r = await handleChat("alt-only", ask("substitute me", { model: "mock-small" }), g);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.servedBy, { provider: "mock-secondary", model: "mock-small-alt" });
  assert.equal(r.body.substituted, true);
});
