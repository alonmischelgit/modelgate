// -----------------------------------------------------------------------------
// End-to-end proof of every gateway behaviour. Needs no API key and no Redis:
//     npm start         (in one terminal)
//     npm run demo      (in another)
// -----------------------------------------------------------------------------
import { config } from "./config.js";

const BASE = `http://localhost:${config.port}`;
// The gateway's JSON, loosely typed: this is a client script, not the contract.
type Json = Record<string, any>;
// A per-run nonce so questions are always fresh. Without it the second run of
// the demo cache-hits everywhere and proves nothing - a demo has to be
// repeatable, not just work once.
const RUN = Math.random().toString(36).slice(2, 8);

async function ask(tenant: string, content: string) {
  const t0 = Date.now();
  const res = await fetch(`${BASE}/v1/chat`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": tenant },
    body: JSON.stringify({ messages: [{ role: "user", content: `${content} (run ${RUN})` }] }),
  });
  const body = await res.json() as Json;
  return { status: res.status, ms: Date.now() - t0, body };
}

const chaos = (provider: string, failing: boolean) =>
  fetch(`${BASE}/v1/_chaos`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ provider, failing }),
  }).then((r) => r.json());

const line = (s: string) => console.log(`\n=== ${s} ${"=".repeat(Math.max(0, 58 - s.length))}`);

// 1 -------------------------------------------------------------------------
line("1. First call: cache MISS, hits a provider");
let r = await ask("tenant-a", "What is a circuit breaker?");
console.log(`   ${r.status} ${r.ms}ms  cached=${r.body.cached} provider=${r.body.provider} cost=$${r.body.costUsd}`);
r.body.trace?.forEach((t: string) => console.log(`     ${t}`));

// 2 -------------------------------------------------------------------------
line("2. Identical call: cache HIT - no provider, no tokens, no cost");
r = await ask("tenant-a", "What is a circuit breaker?");
console.log(`   ${r.status} ${r.ms}ms  cached=${r.body.cached} cost=$${r.body.costUsd}`);
r.body.trace?.forEach((t: string) => console.log(`     ${t}`));

// 3 -------------------------------------------------------------------------
line("3. SAME question, DIFFERENT tenant: must MISS (cache is tenant-scoped)");
r = await ask("tenant-b", "What is a circuit breaker?");
console.log(`   ${r.status} cached=${r.body.cached}  <- isolation: tenant-b cannot read tenant-a's cache`);

// 4 -------------------------------------------------------------------------
line("4. Provider outage: retries with backoff, then FAILOVER to the secondary");
await chaos("mock-primary", true);
r = await ask("tenant-a", "Explain failover please");
console.log(`   ${r.status} ${r.ms}ms provider=${r.body.provider} attempts=${r.body.attempts} failedOver=${r.body.failedOver}`);
r.body.trace?.forEach((t: string) => console.log(`     ${t}`));

// 5 -------------------------------------------------------------------------
line("5. Keep failing: the circuit OPENS and we stop calling it at all");
for (let i = 0; i < 3; i++) await ask("tenant-a", `warm the breaker ${i}`);
r = await ask("tenant-a", "is the breaker open now");
console.log(`   provider=${r.body.provider} breakerSkipped=${JSON.stringify(r.body.breakerSkipped)}`);
r.body.trace?.filter((t: string) => t.includes("OPEN")).forEach((t: string) => console.log(`     ${t}`));
await chaos("mock-primary", false);

// 6 -------------------------------------------------------------------------
line("6. Rate limit: hammer it until a 429 comes back");
// Fire them CONCURRENTLY. Sending them one at a time lets the bucket refill
// between requests (a 60/min bucket refills 1 token/sec, and each sequential
// call takes ~250ms) - so a serial loop would never hit the limit. A burst is
// also the realistic case, and it exercises the atomicity of the token bucket:
// many requests racing for the last few tokens.
const burst = await Promise.all(
  Array.from({ length: 90 }, (_, i) => ask("tenant-burst", `burst question ${i}`)));
const allowed = burst.filter((r) => r.status !== 429).length;
const limited = burst.filter((r) => r.status === 429).length;
console.log(`   ${burst.length} concurrent requests -> allowed=${allowed} rate-limited=${limited}`);
console.log(`   limit is ${config.policy.rateLimitPerMin}/min, so ~${config.policy.rateLimitPerMin} pass and the rest get 429 <- atomic token bucket`);

// 7 -------------------------------------------------------------------------
line("7. Stats");
const s = await fetch(`${BASE}/v1/stats`).then((r) => r.json()) as Json;
console.log(`   requests=${s.requests} cacheHits=${s.cacheHits} (${(s.cacheHitRate * 100).toFixed(0)}%) ` +
            `spend=$${s.spendUsd} saved=$${s.estimatedSavedUsd} p50=${s.p50Ms}ms p95=${s.p95Ms}ms`);
console.log(`   store=${s.store} providers=${JSON.stringify(s.providers)}`);
