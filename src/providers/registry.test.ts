// Routing is a pure function that returns a plan and does no I/O, which is
// what makes it unit-testable without a network. These tests pin the rules
// that matter: exact model first, substitution only within a tier and across
// providers, unknown models rejected, mocks never standing in for real models.
import { test } from "node:test";
import assert from "node:assert/strict";
import { routePlan, costUsd, MODELS } from "./registry.js";

const ALL = ["google", "anthropic", "mock-primary", "mock-secondary"];

test("step 0 is exactly the model the caller asked for", () => {
  const r = routePlan("gemini-3.6-flash", "mock-small", { availableProviders: ALL });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual(r.plan[0], { provider: "google", model: "gemini-3.6-flash", substitute: false });
});

test("substitutes only within the same tier and only on a different provider", () => {
  const r = routePlan("gemini-3.6-flash", "mock-small", { availableProviders: ALL });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  const subs = r.plan.slice(1);
  assert.ok(subs.length > 0, "expected at least one substitute");
  for (const s of subs) {
    assert.equal(s.substitute, true);
    assert.equal(MODELS[s.model].tier, "small", `${s.model} is not small-tier`);
    assert.notEqual(s.provider, "google", "substitute must be on a different provider");
  }
});

test("a mock is never substituted for a real model", () => {
  const r = routePlan("gemini-3.6-flash", "mock-small", { availableProviders: ALL });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.ok(!r.plan.some((s) => s.provider.startsWith("mock")), "mock in a real model's plan");
});

test("mocks still substitute for each other, so failover is demonstrable with no keys", () => {
  const r = routePlan("mock-small", "mock-small", { availableProviders: ["mock-primary", "mock-secondary"] });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual(r.plan.map((s) => s.provider), ["mock-primary", "mock-secondary"]);
});

test("allowSubstitute: false yields a single-step plan", () => {
  const r = routePlan("mock-small", "mock-small", { allowSubstitute: false, availableProviders: ALL });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.plan.length, 1);
});

test("unknown model is rejected with the supported list, never guessed", () => {
  const r = routePlan("gpt-9-turbo", "mock-small", { availableProviders: ALL });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.match(r.error, /unknown model/);
  assert.deepEqual(r.supported, Object.keys(MODELS));
});

test("falls back to the default model when none is requested", () => {
  const r = routePlan(undefined, "mock-small", { availableProviders: ALL });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.plan[0].model, "mock-small");
});

test("known model whose provider has no key: plan is substitutes only, or an error", () => {
  const withAlt = routePlan("gemini-3.6-flash", "mock-small", { availableProviders: ["anthropic"] });
  assert.equal(withAlt.ok, true);
  if (withAlt.ok) assert.ok(withAlt.plan.every((s) => s.substitute));

  const noAlt = routePlan("gemini-3.6-flash", "mock-small", { availableProviders: ["mock-primary"] });
  assert.equal(noAlt.ok, false);
  if (!noAlt.ok) assert.match(noAlt.error, /no configured provider/);
});

test("cost is priced from the registry and charges output tokens (thinking included)", () => {
  // 1M input at $0.75 + 1M output at $3.75
  assert.equal(costUsd("gemini-3.6-flash", { inputTokens: 1_000_000, outputTokens: 1_000_000 }), 4.5);
  // Unknown ids get a conservative default rather than $0 - never under-bill.
  assert.ok(costUsd("nope", { inputTokens: 1000, outputTokens: 1000 }) > 0);
});
