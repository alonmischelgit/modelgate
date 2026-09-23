// Streaming through the whole chain, with the mock fleet. What is tested is
// the CONTRACT: deltas concatenate to the final text, `done` carries the same
// body as a one-shot call, the cache is written on completion and replayed as
// a stream, reliability applies until the first byte and not after.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

process.env.USAGE_LOG = path.join(os.tmpdir(), `modelgate-stream-test-${process.pid}.jsonl`);

const { config } = await import("./config.js");
const { MemoryStore } = await import("./store/index.js");
const { CircuitBreaker } = await import("./reliability.js");
const { MockProvider } = await import("./providers/mock.js");
const { handleChat, handleChatStream } = await import("./pipeline.js");
type Provider = import("./providers/types.js").Provider;
type SseEvent = import("./pipeline.js").SseEvent;

async function gateway() {
  const store = new MemoryStore();
  const primary = new MockProvider("mock-primary", 40);
  const secondary = new MockProvider("mock-secondary", 40);
  const providers = new Map<string, Provider>([[primary.name, primary], [secondary.name, secondary]]);
  return { store, providers, breaker: new CircuitBreaker(store), primary, secondary };
}
const ask = (content: string, extra: Record<string, unknown> = {}) =>
  ({ messages: [{ role: "user" as const, content }], stream: true, ...extra });

async function collect(out: Awaited<ReturnType<typeof handleChatStream>>) {
  assert.ok("events" in out, "expected a stream, got an early result");
  const events: SseEvent[] = [];
  for await (const ev of out.events) events.push(ev);
  const deltas = events.filter((e) => e.event === "delta").map((e) => (e.data as { text: string }).text);
  const done = events.find((e) => e.event === "done")?.data as Record<string, unknown> | undefined;
  const error = events.find((e) => e.event === "error")?.data as Record<string, unknown> | undefined;
  return { events, deltas, done, error };
}

beforeEach(() => {
  config.policy.rateLimitPerMin = 60;
  config.policy.budgetUsdPerDay = 5;
  config.policy.cacheTtlSeconds = 300;
  config.policy.ttftTimeoutMs = 15_000;
  config.policy.streamIdleTimeoutMs = 30_000;
  config.reliability.baseBackoffMs = 1;
});

test("a stream is many deltas then one done whose body equals a one-shot answer", async () => {
  const g = await gateway();
  const { deltas, done, error } = await collect(await handleChatStream("t", ask("stream me"), g));
  assert.equal(error, undefined);
  assert.ok(deltas.length > 3, "expected word-by-word deltas");
  assert.equal(deltas.join(""), done!.text, "deltas concatenate to the final text");
  assert.deepEqual(done!.servedBy, { provider: "mock-primary", model: "mock-small" });
  assert.equal(done!.cached, false);
  assert.ok((done!.costUsd as number) > 0);
  assert.ok(Array.isArray(done!.trace));
  assert.ok((done!.trace as string[]).some((l) => /route committed, first byte received/.test(l)));
});

test("the stream writes the cache on completion; a one-shot request then hits it", async () => {
  const g = await gateway();
  await collect(await handleChatStream("t", ask("cache me streaming"), g));
  const r = await handleChat("t", { messages: [{ role: "user", content: "cache me streaming" }] }, g);
  assert.equal(r.body.cached, true, "`stream` is not part of the cache key");
});

test("a cache hit is replayed as a stream: one delta, then done with cached: true", async () => {
  const g = await gateway();
  await handleChat("t", { messages: [{ role: "user", content: "replay me" }] }, g);
  const { deltas, done } = await collect(await handleChatStream("t", ask("replay me"), g));
  assert.equal(deltas.length, 1);
  assert.equal(done!.cached, true);
  assert.equal(done!.costUsd, 0);
});

test("errors decided before the first byte are still JSON with a real status", async () => {
  const g = await gateway();
  const out = await handleChatStream("t", ask("x", { model: "nope" }), g);
  assert.ok("early" in out);
  assert.equal(out.early.status, 400);
  assert.equal(out.early.body.error, "unknown_model");
});

test("failover happens BEFORE the first byte: primary down -> stream from the substitute, declared", async () => {
  const g = await gateway();
  g.primary.failing = true;
  const { done, error } = await collect(await handleChatStream("t", ask("fail over"), g));
  assert.equal(error, undefined);
  assert.deepEqual(done!.servedBy, { provider: "mock-secondary", model: "mock-small-alt" });
  assert.equal(done!.substituted, true);
  assert.equal(done!.failedOver, true);
});

test("no failover AFTER the first byte: mid-stream failure is an error event, not a silent switch", async () => {
  const g = await gateway();
  g.primary.failAfterChunks = 3;
  const { deltas, done, error } = await collect(await handleChatStream("t", ask("break midway"), g));
  assert.equal(deltas.length, 3, "the client got the first three chunks");
  assert.equal(done, undefined, "no done event");
  assert.equal(error!.error, "stream_interrupted");
  assert.deepEqual(error!.servedBy, { provider: "mock-primary", model: "mock-small" });
  assert.ok((error!.trace as string[]).some((l) => /no failover after first byte/.test(l)));
  // and nothing half-baked was cached
  const again = await handleChat("t", { messages: [{ role: "user", content: "break midway" }] }, g);
  assert.equal(again.body.cached, false);
});

test("a stall mid-stream trips the inter-token idle timeout, not the whole-request one", async () => {
  config.policy.streamIdleTimeoutMs = 60;
  const g = await gateway();
  g.primary.stallAfterChunks = 2;
  const t0 = Date.now();
  const { deltas, error } = await collect(await handleChatStream("t", ask("stall"), g));
  assert.equal(deltas.length, 2);
  assert.match(String(error!.detail), /stream idle after 60ms/);
  assert.ok(Date.now() - t0 < 2000);
});

test("a provider that never sends a first byte fails over under the TTFT budget", async () => {
  config.policy.ttftTimeoutMs = 50;
  const g = await gateway();
  const silent: Provider = { name: "mock-primary", isReady: () => true,
    complete: () => new Promise(() => {}), stream: async function* () { await new Promise(() => {}); } };
  g.providers.set("mock-primary", silent);
  const t0 = Date.now();
  const { done } = await collect(await handleChatStream("t", ask("silent"), g));
  assert.deepEqual(done!.servedBy, { provider: "mock-secondary", model: "mock-small-alt" });
  assert.ok(Date.now() - t0 < 1000, "one TTFT timeout, then failover - not three");
});

test("a provider without stream() is served as one delta + done", async () => {
  const g = await gateway();
  const oneShot: Provider = { name: "mock-primary", isReady: () => true, complete: (r) => g.primary.complete(r) };
  g.providers.set("mock-primary", oneShot);
  const { deltas, done } = await collect(await handleChatStream("t", ask("one shot"), g));
  assert.equal(deltas.length, 1);
  assert.equal(deltas[0], done!.text);
});

test("streams never lead single-flight, but do follow a one-shot leader", async () => {
  const g = await gateway();
  const [a, b] = await Promise.all([
    handleChat("t", { messages: [{ role: "user", content: "shared answer" }] }, g),
    (async () => { await new Promise((r) => setTimeout(r, 5)); return collect(await handleChatStream("t", ask("shared answer"), g)); })(),
  ]);
  assert.equal(a.body.cached, false);
  assert.equal(b.done!.coalesced, true);
  assert.equal(b.done!.text, a.body.text);
});

// --- Tool calls mid-stream ----------------------------------------------------

test("a tool call arrives as its own event BEFORE done, complete and actionable; done repeats it", async () => {
  const g = await gateway();
  const tools = [{ name: "get_weather", parameters: { type: "object", properties: { city: { type: "string" } } } }];
  const out = await handleChatStream("t", ask("What's the weather in Haifa?", { tools }), g);
  assert.ok("events" in out);
  const events: SseEvent[] = [];
  for await (const ev of out.events) events.push(ev);
  const names = events.map((e) => e.event);
  const callIdx = names.indexOf("tool_call");
  const doneIdx = names.indexOf("done");
  assert.ok(callIdx >= 0 && doneIdx > callIdx, `tool_call must precede done: ${names.join(",")}`);
  const call = events[callIdx].data as { id: string; name: string; arguments: Record<string, unknown> };
  assert.equal(call.name, "get_weather");
  assert.deepEqual(call.arguments, { city: "Haifa" }, "complete arguments, not a fragment");
  const done = events[doneIdx].data as { toolCalls: unknown[]; stopReason: string };
  assert.equal(done.stopReason, "tool_use");
  assert.deepEqual(done.toolCalls, [call], "done carries the same call, so clients that ignore tool_call are unaffected");
});
