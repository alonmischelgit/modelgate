// =============================================================================
// THE GATEWAY PIPELINE - the architecture, in one file you can read top to
// bottom. Every request walks this chain in order:
//
//   1. identify   who is calling (API key -> tenant) and resolve their policy
//   2. route      which provider can serve the requested model, or 400 fast
//   3. rate limit token bucket, atomic, shared across instances
//   4. budget     have they spent their daily allowance? (cheap read)
//   5. CACHE      identical request -> return immediately, 0 tokens, 0 cost
//                 (and single-flight: concurrent identical requests pay once)
//   6. reserve    add the worst-case cost to the counter ATOMICALLY; refuse if
//                 that crosses the cap - then call the provider, with
//                 timeout + retries + breaker + failover, under one deadline
//   7. settle     replace the reservation with the real cost; record usage
//
// The order is deliberate and worth defending:
//   - identify first, because everything else is per-tenant.
//   - route before anything that costs quota: an unknown model is a 400 that
//     should cost the caller nothing.
//   - rate limit BEFORE the cache, so a client cannot spam you for free; the
//     limit protects the gateway itself, not just the provider.
//   - budget before the call, never after - after is too late to not spend.
//     The read in step 4 refuses exhausted tenants cheaply; the reservation in
//     step 6 is what makes it correct under concurrency, because an atomic
//     increment cannot be raced the way a read-then-compare can.
//   - cache before the provider call: that is where the money is saved, and a
//     hit never needs a reservation.
//
// STREAMING walks the same chain. Steps 1-6a are identical (and any early
// answer - a 429, a cache hit - is still one JSON body, sent before the stream
// starts). The provider call becomes "open a stream and get the first byte",
// after which the route is committed; text is forwarded as it arrives, and the
// final event carries the same response object a non-stream call returns, so
// step 7 is shared. What streaming forbids: failover after the first byte,
// caching before the last one, and knowing the cost before the end.
//
// WHEN THE STORE IS UNREACHABLE mid-request, each step has its own policy,
// because "fail open" and "fail closed" have different costs per concern:
//   - rate limit  fail OPEN  (serve; losing the limiter briefly beats an outage)
//   - budget      fail CLOSED (refuse; the downside of being wrong is money)
//   - cache       fail OPEN  (treat as a miss)
//   - accounting  fail OPEN  (we already served - log it, never fail the response)
// Startup is different: if Redis is down at boot we fall back to memory and
// say so (store/index.ts). This is about Redis dying under a running fleet.
// =============================================================================
import crypto from "node:crypto";
import { Store } from "./store/index.js";
import { config } from "./config.js";
import { Provider, ChatRequest, ChatResponse, ToolCall, estimateTokens } from "./providers/types.js";
import { routePlan, costUsd, MODELS, RouteStep } from "./providers/registry.js";
import { policyFor, TenantPolicy } from "./tenants.js";
import {
  CircuitBreaker, DeadlineExceeded, StreamInterrupted, callWithFailover, openStreamWithFailover,
} from "./reliability.js";
import { recordUsage } from "./metrics.js";

export interface GatewayResult {
  ok: boolean;
  status: number;
  body: Record<string, unknown>;
  trace: string[];
}

export interface GatewayDeps {
  store: Store;
  providers: Map<string, Provider>;
  breaker: CircuitBreaker;
}

/** One server-sent event on the streaming path. */
export type SseEvent =
  | { event: "delta"; data: { text: string } }
  | { event: "tool_call"; data: ToolCall }
  | { event: "done"; data: Record<string, unknown> }
  | { event: "error"; data: Record<string, unknown> };

/** Cache key = tenant + the exact semantics of the request. */
function cacheKey(tenant: string, req: ChatRequest, resolvedModel: string): string {
  const canonical = JSON.stringify({
    // NOTE: tenant is part of the key. Without it, one customer could read
    // another customer's cached completion - a real data-leak bug in a
    // multi-tenant cache.
    t: tenant,
    // The RESOLVED model, so "model omitted" and "model: <the default>" share
    // an entry - they are the same question.
    m: resolvedModel,
    msgs: req.messages,
    mt: req.maxTokens ?? null,
    temp: req.temperature ?? null,
    // Thinking budget changes the answer, so it changes the key. Anything that
    // alters the semantics of the response belongs here; anything that does not
    // (request ids, timestamps, trace headers, `stream`, `cache`) must stay
    // out, or the hit rate silently goes to zero.
    tb: req.thinkingBudget ?? null,
    tools: req.tools ?? null,   // a different tool list is a different question
  });
  return `cache:${crypto.createHash("sha256").update(canonical).digest("hex").slice(0, 32)}`;
}

const errMsg = (err: unknown) => (err instanceof Error ? err.message : String(err));

// Identical requests currently being answered, by cache key. See step 5b.
const inflight = new Map<string, Promise<ChatResponse>>();

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  promise.catch(() => { /* followers observe the rejection themselves */ });
  return { promise, resolve, reject };
}

/**
 * Worst-case cost of a request, for the budget reservation: every input token
 * plus the whole output allowance, at the intended model's price. Deliberately
 * pessimistic - a reservation that is too small is the overshoot we are here
 * to prevent; one that is too large is corrected a second later at settlement.
 */
export function estimateCost(model: string, req: ChatRequest): number {
  const input = estimateTokens(JSON.stringify(req.messages) + JSON.stringify(req.tools ?? []));
  const output = req.maxTokens ?? config.policy.defaultMaxTokens;
  return costUsd(model, { inputTokens: input, outputTokens: output });
}

// -----------------------------------------------------------------------------
// The per-request context: everything steps 1-6a decide, handed to whichever
// step 6b/7 runs (one-shot or stream).
// -----------------------------------------------------------------------------
interface Ctx {
  tenant: string;
  req: ChatRequest;
  deps: GatewayDeps;
  requestId: string;
  t0: number;
  trace: string[];
  say: (m: string) => void;
  failOpen: <T>(label: string, fn: () => Promise<T>, fallback: T) => Promise<T>;
  policy: TenantPolicy;
  requested: string;
  plan: RouteStep[];
  key: string;
  cacheable: boolean;
  spendKey: string;
  reserve: number;
  reservedTotal: number;
  /** Non-null when this request is the single-flight leader for its key. */
  lead: ReturnType<typeof deferred<ChatResponse>> | null;
}

type Preflight = { early: GatewayResult } | { ctx: Ctx };

/** Steps 1-6a. Returns an early answer (error, cache hit, coalesced) or the context to make the call. */
async function preflight(
  tenant: string, req: ChatRequest, deps: GatewayDeps, requestId: string, canLead: boolean,
): Promise<Preflight> {
  const trace: string[] = [];
  const t0 = Date.now();
  const say = (m: string) => trace.push(`${String(Date.now() - t0).padStart(4)}ms ${m}`);
  const requested = req.model ?? config.policy.defaultModel;

  /** Run a store operation that may fail OPEN: on error, trace it and use the fallback. */
  const failOpen = async <T>(label: string, fn: () => Promise<T>, fallback: T): Promise<T> => {
    try { return await fn(); }
    catch (err) { say(`${label}: store unavailable (${errMsg(err)}) - failing open`); return fallback; }
  };
  const early = (status: number, body: Record<string, unknown>): Preflight =>
    ({ early: { ok: status < 400, status, trace, body: { requestId, ...body } } });

  // --- 1. Identify: resolve this tenant's policy -----------------------------
  const policy = policyFor(tenant);
  say(`tenant ${tenant}: ${policy.rateLimitPerMin}/min, $${policy.budgetUsdPerDay}/day` +
      (policy.providers ? `, providers: ${policy.providers.join(",")}` : "") +
      (policy.note ? ` (${policy.note})` : ""));

  // --- 2. Route the model ----------------------------------------------------
  // The tenant's allowlist narrows what "available" means. A forbidden
  // provider is not in the plan at all, so the router either substitutes an
  // allowed same-tier model or reports that nothing can serve the request.
  const available = [...deps.providers.keys()].filter((p) => !policy.providers || policy.providers.includes(p));
  const route = routePlan(req.model, config.policy.defaultModel, {
    allowSubstitute: req.allowSubstitute,
    availableProviders: available,
  });
  if (!route.ok) {
    say(`routing failed: ${route.error}`);
    const spec = MODELS[requested];
    const forbidden = spec && policy.providers && !policy.providers.includes(spec.provider);
    if (forbidden) {
      return early(403, { error: "provider_not_allowed",
        detail: `${requested} is served by ${spec.provider}, which tenant ${tenant} may not use` +
                (req.allowSubstitute === false ? " (and substitution is disabled)" : ", and no allowed same-tier model is available"),
        allowedProviders: policy.providers });
    }
    if (spec) {
      // Known model, but this instance has no key for its provider (and no
      // allowed same-tier alternative). That is our configuration, not the
      // caller's mistake - say so, and say what would fix it.
      return early(503, { error: "model_unavailable",
        detail: `${requested} is a known model but its provider (${spec.provider}) is not configured on this instance` +
                (req.allowSubstitute === false ? " (and substitution is disabled)" : ", and no same-tier alternative is available"),
        availableModels: Object.values(MODELS).filter((m) => deps.providers.has(m.provider)).map((m) => m.id) });
    }
    return early(400, { error: "unknown_model", detail: route.error, supportedModels: route.supported });
  }
  say(`route: ${route.plan.map((s) => `${s.provider}/${s.model}${s.substitute ? "*" : ""}`).join(" -> ")}`);

  // --- 3. Rate limit ---------------------------------------------------------
  const perMin = policy.rateLimitPerMin;
  const remaining = await failOpen("rate limit",
    () => deps.store.takeToken(`rl:${tenant}`, perMin, perMin / 60, Date.now() / 1000), null);
  if (remaining !== null && remaining < 0) {
    // One token refills every 60/perMin seconds - that is the honest wait.
    say(`rate limit exceeded for ${tenant}`);
    return early(429, { error: "rate_limit_exceeded", limitPerMin: perMin, retryAfterSec: Math.max(1, Math.ceil(60 / perMin)) });
  }
  if (remaining !== null) say(`rate limit ok (${remaining} tokens left)`);

  // --- 4. Budget (fails CLOSED) ----------------------------------------------
  const day = new Date().toISOString().slice(0, 10);
  const spendKey = `spend:${tenant}:${day}`;
  let spent: number;
  try {
    spent = Number((await deps.store.get(spendKey)) ?? 0);
  } catch (err) {
    say(`budget: store unavailable (${errMsg(err)}) - failing CLOSED, cannot verify spend`);
    return early(503, { error: "store_unavailable", detail: "cannot verify budget", retryAfterSec: 5 });
  }
  if (spent >= policy.budgetUsdPerDay) {
    say(`budget exhausted: $${spent.toFixed(4)} >= $${policy.budgetUsdPerDay}`);
    return early(402, { error: "budget_exceeded", spentUsd: Number(spent.toFixed(4)), budgetUsd: policy.budgetUsdPerDay });
  }
  say(`budget ok ($${spent.toFixed(4)} of $${policy.budgetUsdPerDay} used today)`);

  // --- 5. Cache --------------------------------------------------------------
  // Policy says whether caching is on (TTL > 0); the caller can opt this one
  // call out. `cache` is a control, not part of the question, so it is
  // deliberately NOT in the key - "no-cache" must not create a parallel entry.
  const key = cacheKey(tenant, req, requested);
  const cacheable = req.cache !== false && config.policy.cacheTtlSeconds > 0;
  if (!cacheable) say(req.cache === false ? "cache bypassed by caller" : "cache disabled by policy (TTL 0)");
  const hit = cacheable ? await failOpen("cache", () => deps.store.get(key), null) : null;
  // A pinned request (allowSubstitute: false) must not be served a cached
  // answer that came from a substitute - the cache cannot hand back a policy
  // the caller explicitly rejected.
  const cached = hit ? JSON.parse(hit) as ChatResponse : null;
  const servedFromCache = async (r: ChatResponse, extra: Record<string, unknown>): Promise<Preflight> => {
    await recordUsage({
      requestId, tenant, provider: r.provider, model: r.model,
      inputTokens: 0, outputTokens: 0, costUsd: 0, cached: true, ms: Date.now() - t0, ok: true,
    });
    // Same response shape as a fresh call, so clients never branch on `cached`
    // just to find out which model answered. Usage is what THIS request cost -
    // zero - not what the original call cost; a hit that reports 87 tokens next
    // to costUsd: 0 is a contradiction a caller would have to know to ignore.
    return early(200, {
      ...r, usage: { inputTokens: 0, outputTokens: 0 },
      requestedModel: requested, servedBy: { provider: r.provider, model: r.model },
      substituted: r.model !== requested, cached: true, costUsd: 0, latencyMs: Date.now() - t0, ...extra,
    });
  };
  if (cached && req.allowSubstitute === false && cached.model !== requested) {
    say(`cache entry is from ${cached.model}, caller pinned ${requested} - treating as miss`);
  } else if (cached) {
    say(`CACHE HIT - returning without calling any provider (0 tokens, $0)`);
    return servedFromCache(cached, {});
  }
  if (cacheable) say("cache miss");

  // --- 5b. Single-flight: don't pay N times for one answer -------------------
  // Concurrent identical requests all miss the cache at the same instant - a
  // retry storm is exactly that - and a plain cache would send every one of
  // them to the provider. The first becomes the leader; the rest wait for its
  // answer and are served as cache hits. In-process only, on purpose: a second
  // replica runs its own leader, which bounds the duplicate work at one call
  // per replica, whereas a Redis lock here would add a round trip to EVERY
  // miss to save a rare cross-instance duplicate.
  const leader = cacheable ? inflight.get(key) : undefined;
  if (leader) {
    say("coalesced onto an identical in-flight request - waiting for its answer instead of calling the provider");
    try {
      return servedFromCache(await leader, { coalesced: true });
    } catch {
      say("in-flight leader failed - making our own attempt");
    }
  }
  // Become the leader NOW - synchronously, before the next await - or a burst
  // of identical requests all pass this point before any of them registers.
  // Every early return below must release it, so followers do not hang.
  // Streams never lead: followers need a whole response, and a stream only
  // has one at the end.
  const lead = canLead && cacheable && !inflight.has(key) ? deferred<ChatResponse>() : null;
  if (lead) inflight.set(key, lead.promise);
  const abandonLead = (why: string) => { lead?.reject(new Error(why)); if (lead) inflight.delete(key); };

  // --- 6a. Reserve the budget (atomic, fails CLOSED) -------------------------
  // Step 4 was a cheap read. This is the authoritative check: add the worst-
  // case cost to the counter atomically, and if that pushes the tenant over,
  // take it back and refuse. Two concurrent requests can no longer both see
  // "$4.99 of $5" and both proceed - the counter, not the read, decides.
  // Worst case = every input token + the full output allowance, priced at the
  // model we intend to use; settled to the real cost after the call.
  const reserve = estimateCost(route.plan[0].model, req);
  let reservedTotal: number;
  try {
    reservedTotal = await deps.store.incrByFloat(spendKey, reserve, 86_400);
  } catch (err) {
    abandonLead("store unavailable");
    say(`budget: store unavailable (${errMsg(err)}) - failing CLOSED, cannot reserve`);
    return early(503, { error: "store_unavailable", detail: "cannot reserve budget", retryAfterSec: 5 });
  }
  if (reservedTotal > policy.budgetUsdPerDay) {
    abandonLead("budget exceeded");
    await failOpen("budget release", () => deps.store.incrByFloat(spendKey, -reserve, 86_400), 0);
    say(`budget: reserving $${reserve.toFixed(4)} would exceed $${policy.budgetUsdPerDay} - refused`);
    return early(402, { error: "budget_exceeded", spentUsd: Number((reservedTotal - reserve).toFixed(4)), budgetUsd: policy.budgetUsdPerDay });
  }
  say(`budget reserved $${reserve.toFixed(4)} (worst case)`);

  return { ctx: {
    tenant, req, deps, requestId, t0, trace, say, failOpen, policy, requested,
    plan: route.plan, key, cacheable, spendKey, reserve, reservedTotal, lead,
  } };
}

/** The provider call failed (before any byte reached the client). Release, record, and answer. */
async function failed(c: Ctx, err: unknown): Promise<GatewayResult> {
  c.lead?.reject(err);
  if (c.lead) inflight.delete(c.key);
  // Nothing was spent: hand the reservation back. If THIS fails the tenant
  // is over-counted by one worst case until midnight - the conservative
  // direction, and the trace says so.
  await c.failOpen("budget release", () => c.deps.store.incrByFloat(c.spendKey, -c.reserve, 86_400), 0);
  const deadline = err instanceof DeadlineExceeded;
  c.say(`${deadline ? "deadline exceeded" : "all providers failed"}: ${errMsg(err)}`);
  await recordUsage({
    requestId: c.requestId, tenant: c.tenant, provider: "none", model: c.requested,
    inputTokens: 0, outputTokens: 0, costUsd: 0, cached: false, ms: Date.now() - c.t0, ok: false,
  });
  // 504 for our own deadline; 503 for theirs. Neither is a 500: nothing here
  // is a bug in the gateway.
  const body = deadline
    ? { requestId: c.requestId, error: "deadline_exceeded", detail: errMsg(err) }
    : { requestId: c.requestId, error: "all_providers_failed", detail: errMsg(err), retryAfterSec: config.reliability.breakerCooldownSec };
  return { ok: false, status: deadline ? 504 : 503, trace: c.trace, body };
}

/** Step 7: settle the reservation to the real cost, cache, record, and build the body. */
async function settled(
  c: Ctx, response: ChatResponse,
  used: { providerUsed: string; modelUsed: string; substituted: boolean; attempts: number; failedOver: boolean; breakerSkipped: string[] },
): Promise<GatewayResult> {
  c.lead?.resolve(response);
  if (c.lead) inflight.delete(c.key);
  const cost = costUsd(used.modelUsed, response.usage);
  if (c.cacheable) {
    await c.failOpen("cache write",
      () => c.deps.store.setex(c.key, config.policy.cacheTtlSeconds, JSON.stringify(response)), undefined);
  }
  const newTotal = await c.failOpen("budget settle",
    () => c.deps.store.incrByFloat(c.spendKey, cost - c.reserve, 86_400), c.reservedTotal);
  c.say(`spent $${cost.toFixed(6)}, settled reservation (tenant total today $${newTotal.toFixed(4)})`);

  await recordUsage({
    requestId: c.requestId, tenant: c.tenant, provider: used.providerUsed, model: response.model,
    inputTokens: response.usage.inputTokens, outputTokens: response.usage.outputTokens,
    thinkingTokens: response.usage.thinkingTokens,
    costUsd: cost, cached: false, substituted: used.substituted, failedOver: used.failedOver,
    ms: Date.now() - c.t0, ok: true,
  });

  return {
    ok: true, status: 200, trace: c.trace,
    body: {
      ...response, requestId: c.requestId,
      requestedModel: c.requested,
      servedBy: { provider: used.providerUsed, model: used.modelUsed },
      substituted: used.substituted,
      cached: false,
      costUsd: Number(cost.toFixed(6)),
      latencyMs: Date.now() - c.t0,
      attempts: used.attempts,
      failedOver: used.failedOver,
      breakerSkipped: used.breakerSkipped,
    },
  };
}

// -----------------------------------------------------------------------------
// The two entry points.
// -----------------------------------------------------------------------------

/** One request, one JSON body. */
export async function handleChat(
  tenant: string,
  req: ChatRequest,
  deps: GatewayDeps,
  requestId: string = crypto.randomUUID(),
): Promise<GatewayResult> {
  const pre = await preflight(tenant, req, deps, requestId, true);
  if ("early" in pre) return pre.early;
  const c = pre.ctx;

  // --- 6b. Provider call, with reliability -----------------------------------
  let outcome;
  try {
    outcome = await callWithFailover(c.plan, deps.providers, req, deps.breaker, c.say, c.t0 + config.policy.requestDeadlineMs);
  } catch (err) {
    return failed(c, err);
  }
  return settled(c, outcome.response, outcome);
}

/**
 * One request, a stream of events. Either an early JSON answer (any step
 * before the provider decided - errors, or a cache hit which is replayed as
 * one delta), or an event stream to forward as SSE.
 */
export async function handleChatStream(
  tenant: string,
  req: ChatRequest,
  deps: GatewayDeps,
  requestId: string = crypto.randomUUID(),
): Promise<{ early: GatewayResult } | { events: AsyncGenerator<SseEvent> }> {
  const pre = await preflight(tenant, req, deps, requestId, false);
  if ("early" in pre) {
    if (!pre.early.ok) return pre;
    // A cache hit or a coalesced answer, replayed in the stream's shape so the
    // client's code path is the same whether or not anyone paid for it.
    const body: Record<string, unknown> = { ...pre.early.body, trace: pre.early.trace };
    return { events: (async function* () {
      yield { event: "delta", data: { text: String(body.text ?? "") } } as SseEvent;
      yield { event: "done", data: body } as SseEvent;
    })() };
  }
  const c = pre.ctx;

  // --- 6b. Open the stream: retries/breaker/failover until the first byte ----
  let opened;
  try {
    opened = await openStreamWithFailover(c.plan, deps.providers, req, deps.breaker, c.say, c.t0 + config.policy.requestDeadlineMs);
  } catch (err) {
    return { early: await failed(c, err) };
  }
  c.say(`streaming from ${opened.providerUsed}/${opened.modelUsed} - route committed, first byte received`);

  const events = (async function* (): AsyncGenerator<SseEvent> {
    try {
      for await (const ev of opened.events) {
        if (ev.type === "delta") {
          yield { event: "delta", data: { text: ev.text } };
        } else if (ev.type === "tool_call") {
          // Complete, actionable, and before the turn ends - the agent can
          // start running it while the model is still producing the next one.
          yield { event: "tool_call", data: ev.call };
        } else {
          const result = await settled(c, ev.response, opened);
          yield { event: "done", data: { ...result.body, trace: result.trace } };
          return;
        }
      }
    } catch (err) {
      // After the first byte there is no failover: the client already has part
      // of an answer. Say so. The reservation stays - the provider may well
      // have billed for what it sent - which is the conservative direction.
      const interrupted = err instanceof StreamInterrupted;
      c.say(`${interrupted ? "stream interrupted" : "stream failed"}: ${errMsg(err)} - no failover after first byte`);
      await recordUsage({
        requestId: c.requestId, tenant: c.tenant, provider: opened.providerUsed, model: opened.modelUsed,
        inputTokens: 0, outputTokens: 0, costUsd: 0, cached: false, ms: Date.now() - c.t0, ok: false,
      });
      yield { event: "error", data: { requestId: c.requestId, error: "stream_interrupted", detail: errMsg(err),
                                      servedBy: { provider: opened.providerUsed, model: opened.modelUsed }, trace: c.trace } };
    }
  })();
  return { events };
}
