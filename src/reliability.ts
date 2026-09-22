// =============================================================================
// Reliability: retries, circuit breaker, and provider failover.
//
// The failure we are defending against: a provider gets slow or starts 500ing.
// Without protection, every request piles up waiting on it, our workers fill,
// and OUR service goes down because THEIRS did. "Waiting is contagious."
//
// Four layers, in order:
//   1. timeout  - never wait forever
//   2. retry    - transient errors (429/5xx/network) with backoff + JITTER
//   3. breaker  - after N consecutive failures, stop calling it entirely for a
//                 cooldown, then let a single trial request test the water
//   4. failover - walk the route plan to the next provider that can serve the
//                 request (see providers/registry.ts for how the plan is built)
//
// Jitter matters: without it, every client retries at the same instant and the
// recovering provider is knocked over again by a synchronised thundering herd.
//
// STREAMING changes one thing: all four layers apply only UNTIL THE FIRST
// BYTE. Once a chunk has reached the client you cannot transparently switch
// providers - the client already has half an answer from model A. So the
// reliability wraps the connection, not the stream: retry, breaker and
// failover until the first token; after that a failure is an error the client
// sees, not one we hide.
// =============================================================================
import { Store } from "./store/index.js";
import { config } from "./config.js";
import { ChatRequest, ChatResponse, Provider, StreamEvent } from "./providers/types.js";
import { RouteStep } from "./providers/registry.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const statusOf = (err: unknown): number | undefined => (err as { status?: number })?.status;

/**
 * 429, 5xx and network errors are worth retrying. A 400 is our bug - fail fast.
 * Our own timeout (504) is NOT retried on the same provider: a hung upstream
 * that just cost us 30s will cost another 30s per retry, and the caller has
 * long since given up. A hang is a reason to fail over, not to wait again.
 */
function isRetryable(err: unknown): boolean {
  const status = statusOf(err);
  if (status === undefined) return true;              // network/unknown -> retry
  if (status === 429) return true;
  if (status === 504) return false;                   // our timeout -> fail over
  return status >= 500;
}

/**
 * Only failures that mean "the provider is unhealthy" count toward opening the
 * circuit: 5xx, timeouts, network errors. A 429 means "slow down", not "down" -
 * and because breaker state is fleet-wide, letting one tenant's burst trip it
 * would take the provider away from every tenant on every replica. A 4xx is our
 * bug and says nothing about the provider's health either.
 */
function countsAgainstBreaker(err: unknown): boolean {
  const status = statusOf(err);
  return status === undefined || status >= 500;
}

export class CircuitBreaker {
  constructor(private store: Store) {}

  private failKey(p: string) { return `breaker:${p}:failures`; }
  private openKey(p: string) { return `breaker:${p}:open`; }

  /**
   * Open = we are not calling this provider right now.
   * If the store itself is unreachable, treat the circuit as closed: losing
   * the breaker degrades protection, losing the provider degrades the product.
   */
  async isOpen(provider: string): Promise<boolean> {
    try { return (await this.store.get(this.openKey(provider))) !== null; }
    catch { return false; }
  }

  async recordSuccess(provider: string): Promise<void> {
    try { await this.store.setex(this.failKey(provider), 1, "0"); }   // reset the streak
    catch { /* breaker bookkeeping must never fail a successful request */ }
  }

  async recordFailure(provider: string): Promise<void> {
    try {
      const n = await this.store.incrByFloat(this.failKey(provider), 1, 300);
      if (n >= config.reliability.breakerThreshold) {
        // Trip. Stored in the SHARED store so the whole fleet trips together -
        // otherwise each replica has to discover the outage independently and
        // you keep hammering a dead provider N times over.
        await this.store.setex(this.openKey(provider), config.reliability.breakerCooldownSec, "1");
      }
    } catch { /* same: a store hiccup is not a reason to lose the request */ }
  }
}

export interface CallOutcome {
  response: ChatResponse;
  providerUsed: string;
  modelUsed: string;
  substituted: boolean;   // true if we served a DIFFERENT model than requested
  attempts: number;
  failedOver: boolean;
  breakerSkipped: string[];
}

/** A stream that has delivered its first byte: the route is committed. */
export interface StreamOutcome extends Omit<CallOutcome, "response"> {
  /** The first event is included; consume to the `final` event to get the response. */
  events: AsyncIterable<StreamEvent>;
}

/**
 * Two clocks. The per-attempt TIMEOUT bounds one provider call. The DEADLINE
 * bounds the whole request - retries, backoff and failover included - because
 * "each step was reasonable" can still add up to a minute the caller never
 * agreed to wait. Past the deadline nothing else is tried.
 */
export class DeadlineExceeded extends Error {
  readonly status = 504;
  constructor(ms: number) { super(`request deadline of ${ms}ms exceeded`); }
}

/** A stream failed after the client had already received part of it. Not recoverable. */
export class StreamInterrupted extends Error {
  readonly status = 502;
  constructor(cause: string) { super(`stream interrupted after first byte: ${cause}`); }
}

/**
 * Run one attempt of `work` against a provider, with timeout + retries.
 * Generic over what an attempt returns: a full response (non-stream) or an
 * opened stream that has produced its first event (stream). Throws if every
 * attempt fails.
 */
async function withRetries<T>(
  provider: Provider,
  work: (timeoutMs: number) => Promise<T>,
  breaker: CircuitBreaker,
  deadlineAt: number,
  perAttemptMs: number,
  onAttempt: (n: number, err?: unknown) => void,
): Promise<{ value: T; attempts: number }> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= config.reliability.maxAttempts; attempt++) {
    const left = deadlineAt - Date.now();
    if (left <= 0) throw new DeadlineExceeded(config.policy.requestDeadlineMs);
    try {
      const value = await work(Math.min(perAttemptMs, left));
      await breaker.recordSuccess(provider.name);
      onAttempt(attempt);
      return { value, attempts: attempt };
    } catch (err) {
      lastErr = err;
      onAttempt(attempt, err);
      if (countsAgainstBreaker(err)) await breaker.recordFailure(provider.name);
      // A timeout that fired because the DEADLINE was closer than the per-attempt
      // budget is the deadline, not the provider - report it as such.
      if (statusOf(err) === 504 && Date.now() >= deadlineAt) throw new DeadlineExceeded(config.policy.requestDeadlineMs);
      if (!isRetryable(err) || attempt === config.reliability.maxAttempts) break;
      // exponential backoff + jitter, but never sleep past the deadline
      const backoff = config.reliability.baseBackoffMs * 2 ** (attempt - 1);
      await sleep(Math.min(backoff + Math.random() * backoff, Math.max(0, deadlineAt - Date.now())));
    }
  }
  throw lastErr;
}

function withTimeout<T>(p: Promise<T>, ms: number, what = "timeout"): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<T>((_, reject) => {
    timer = setTimeout(
      () => reject(Object.assign(new Error(`${what} after ${ms}ms`), { status: 504 })), ms);
  });
  // Clear the timer either way. Left armed, every successful call leaks a
  // pending timer for the full timeout - harmless-looking, until a burst of
  // requests is holding thousands of them and the process will not exit.
  return Promise.race([p, deadline]).finally(() => clearTimeout(timer));
}

/**
 * Walk the route plan in order, skipping providers that are not configured or
 * whose breaker is open; `attempt` runs one step. Shared by the non-stream and
 * stream paths - the plan-walking is identical, only the unit of work differs.
 */
async function walkPlan<T>(
  plan: RouteStep[],
  providers: Map<string, Provider>,
  breaker: CircuitBreaker,
  trace: (msg: string) => void,
  deadlineAt: number,
  attempt: (provider: Provider, step: RouteStep, onAttempt: (n: number, err?: unknown) => void) => Promise<T>,
): Promise<{ value: T; step: RouteStep; index: number; attempts: number; breakerSkipped: string[] }> {
  const breakerSkipped: string[] = [];
  let lastErr: unknown;
  let attempts = 0;   // across the whole plan - the caller paid for all of them

  for (const [i, step] of plan.entries()) {
    if (Date.now() >= deadlineAt) {
      trace(`deadline exceeded before trying ${step.provider}`);
      throw new DeadlineExceeded(config.policy.requestDeadlineMs);
    }
    const provider = providers.get(step.provider);
    if (!provider || !provider.isReady()) {
      trace(`skip ${step.provider}: not configured`);
      continue;
    }
    if (await breaker.isOpen(step.provider)) {
      breakerSkipped.push(step.provider);
      trace(`skip ${step.provider}: circuit OPEN`);
      continue;
    }
    if (step.substitute) {
      trace(`substituting ${step.model} on ${step.provider} (same tier) - reported in the response`);
    }
    try {
      const value = await attempt(provider, step, (n, err) => {
        attempts++;
        trace(err
          ? `${step.provider}/${step.model} attempt ${n} failed: ${(err as Error).message}`
          : `${step.provider}/${step.model} attempt ${n} ok`);
      });
      return { value, step, index: i, attempts, breakerSkipped };
    } catch (err) {
      if (err instanceof DeadlineExceeded) throw err;   // no point moving on
      lastErr = err;
      trace(`${step.provider} exhausted - moving to next route`);
    }
  }
  throw lastErr ?? new Error("no provider in the route plan could serve this request");
}

/** Non-stream: each step gets timeout + retries; a full response is the unit of work. */
export async function callWithFailover(
  plan: RouteStep[],
  providers: Map<string, Provider>,
  req: ChatRequest,
  breaker: CircuitBreaker,
  trace: (msg: string) => void,
  deadlineAt: number = Date.now() + config.policy.requestDeadlineMs,
): Promise<CallOutcome> {
  const r = await walkPlan(plan, providers, breaker, trace, deadlineAt, async (provider, step, onAttempt) => {
    // Send the model id THIS provider understands, not the one the caller
    // happened to name. That mapping is the router's job.
    const { value } = await withRetries(
      provider, (ms) => withTimeout(provider.complete({ ...req, model: step.model }), ms),
      breaker, deadlineAt, config.policy.requestTimeoutMs, onAttempt);
    return value;
  });
  return {
    response: r.value, providerUsed: r.step.provider, modelUsed: r.step.model,
    substituted: r.step.substitute, attempts: r.attempts, failedOver: r.index > 0, breakerSkipped: r.breakerSkipped,
  };
}

/**
 * Stream: the unit of work is "open the stream and receive the FIRST event"
 * under the time-to-first-token budget. Retries, breaker and failover apply to
 * that. Once the first event is in hand the route is committed: the remaining
 * events are forwarded under an inter-token idle timeout, and a failure there
 * is a StreamInterrupted the caller must surface, never a silent switch.
 *
 * A provider without `stream` is served by `complete` as one delta - the
 * caller sees a stream either way.
 */
export async function openStreamWithFailover(
  plan: RouteStep[],
  providers: Map<string, Provider>,
  req: ChatRequest,
  breaker: CircuitBreaker,
  trace: (msg: string) => void,
  deadlineAt: number = Date.now() + config.policy.requestDeadlineMs,
): Promise<StreamOutcome> {
  type Opened = { first: StreamEvent; rest: AsyncIterator<StreamEvent> };

  const r = await walkPlan(plan, providers, breaker, trace, deadlineAt, async (provider, step, onAttempt) => {
    const stepReq = { ...req, model: step.model };
    const { value } = await withRetries<Opened>(provider, async (ms) => {
      if (!provider.stream) {
        // Non-streaming provider: one delta then final, so the contract holds.
        const response = await withTimeout(provider.complete(stepReq), ms);
        const rest = (async function* () { yield { type: "final", response } as StreamEvent; })();
        return { first: { type: "delta", text: response.text }, rest };
      }
      const it = provider.stream(stepReq)[Symbol.asyncIterator]();
      const n = await withTimeout(it.next(), ms, "time to first token");
      if (n.done) throw Object.assign(new Error("stream ended before any event"), { status: 502 });
      return { first: n.value, rest: it };
    }, breaker, deadlineAt, config.policy.ttftTimeoutMs, onAttempt);
    return value;
  });

  const { first, rest } = r.value;
  const provider = r.step.provider;
  async function* events(): AsyncIterable<StreamEvent> {
    yield first;
    if (first.type === "final") return;
    for (;;) {
      let n: IteratorResult<StreamEvent>;
      try {
        n = await withTimeout(rest.next(), config.policy.streamIdleTimeoutMs, "stream idle");
      } catch (err) {
        // Past the first byte: no retry, no failover. Count it against the
        // breaker (it IS a provider failure) and tell the caller.
        if (countsAgainstBreaker(err)) await breaker.recordFailure(provider);
        throw new StreamInterrupted((err as Error).message);
      }
      if (n.done) throw new StreamInterrupted("provider closed the stream without a final event");
      yield n.value;
      if (n.value.type === "final") return;
    }
  }

  return {
    events: events(), providerUsed: provider, modelUsed: r.step.model,
    substituted: r.step.substitute, attempts: r.attempts, failedOver: r.index > 0, breakerSkipped: r.breakerSkipped,
  };
}
