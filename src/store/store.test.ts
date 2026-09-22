// The in-memory store is dev-only, but it must honour the same contract as
// Redis or every test above it is testing the wrong thing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createStore, MemoryStore } from "./index.js";

test("createStore falls back to memory when no REDIS_URL is given", async () => {
  const s = await createStore(undefined);
  assert.equal(s.kind, "memory");
});

test("token bucket: drains to -1, then refills with time", async () => {
  const s = new MemoryStore();
  const now = 1_000;
  // capacity 3, refill 1/sec
  assert.equal(await s.takeToken("rl:t", 3, 1, now), 2);
  assert.equal(await s.takeToken("rl:t", 3, 1, now), 1);
  assert.equal(await s.takeToken("rl:t", 3, 1, now), 0);
  assert.equal(await s.takeToken("rl:t", 3, 1, now), -1, "empty bucket must refuse");
  // two seconds later, two tokens are back
  assert.equal(await s.takeToken("rl:t", 3, 1, now + 2), 1);
});

test("token bucket never exceeds capacity after a long idle", async () => {
  const s = new MemoryStore();
  await s.takeToken("rl:idle", 5, 1, 0);
  assert.equal(await s.takeToken("rl:idle", 5, 1, 10_000), 4);
});

test("a counter written by incrByFloat is readable by get (the budget check depends on it)", async () => {
  const s = new MemoryStore();
  assert.equal(await s.get("spend:t"), null);
  assert.equal(await s.incrByFloat("spend:t", 0.25, 60), 0.25);
  assert.equal(await s.incrByFloat("spend:t", 0.5, 60), 0.75);
  assert.equal(Number(await s.get("spend:t")), 0.75);
});

test("setex values expire", async () => {
  const s = new MemoryStore();
  await s.setex("k", 0.01, "v");          // 10ms
  assert.equal(await s.get("k"), "v");
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(await s.get("k"), null);
});

test("incrByFloat is atomic under concurrency: no lost updates", async () => {
  const s = new MemoryStore();
  await Promise.all(Array.from({ length: 100 }, () => s.incrByFloat("c", 1, 60)));
  assert.equal(Number(await s.get("c")), 100, "an await between read and write would lose increments");
});
