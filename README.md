# modelgate

One HTTP endpoint in front of every LLM provider.

Your services stop calling Google / Anthropic SDKs directly and call the gateway
instead. The gateway adds the things every team otherwise builds twice — caching,
per-tenant rate limits and budgets, retries, circuit breaking, cross-provider
failover, model routing and cost attribution — in one place, so application code
stays about the application.

Same category as Portkey, LiteLLM, Helicone and Cloudflare AI Gateway. Built
from scratch to own the failure modes, not to compete with them.

```
npm install
npm start          # http://localhost:3200  (no API key, no Redis, no Docker needed)
npm test           # 117 tests, offline, ~1s
npm run demo       # scripted proof of every behaviour, in a second terminal
npm run agent      # a 30-line agent using the gateway: tool loop, one request id across hops
npm run agent:stream   # the same agent, streaming tokens as they arrive
```

Then open **http://localhost:3200** (dashboard) and **/docs** (Swagger — every
example is runnable and each one demonstrates one property).

## What a request goes through

```mermaid
flowchart LR
  in([POST /v1/chat]) --> id[identify<br/>key → tenant]
  id --> rt{route<br/>model known?}
  rt -- no --> e400[400]
  rt -- yes --> rl{rate limit}
  rl -- no --> e429[429]
  rl -- yes --> bg{budget}
  bg -- no --> e402[402]
  bg -- yes --> ch{cache}
  ch -- hit --> ok2[200 · $0 · ~1ms]
  ch -- miss --> call[call provider<br/>timeout · retry · breaker · failover]
  call -- fail --> e503[503]
  call -- ok --> acct[account<br/>tokens · cost · latency]
  acct --> ok[200]
```

The chain lives in one file, [`src/pipeline.ts`](src/pipeline.ts), and the order
is deliberate:

| Step | Why here and not elsewhere |
|---|---|
| **route first** | An unknown model is a 400 that costs the caller nothing — not a rate-limit token, not three retries against a provider that never understood the id. |
| **rate limit before cache** | The limit protects *the gateway*, not just the provider bill. Cache-first would let a client hammer one cached prompt for free, on your CPU and sockets. |
| **budget before the call** | A budget checked after the request is a receipt. You can't un-spend money. Enforced by an **atomic reservation** of the worst-case cost, settled to the real cost after — so concurrent requests can't race past the cap. |
| **cache before the provider** | A hit is 0 tokens, $0, ~1ms. This is where the money is saved. |
| **account last** | You can only meter what actually happened — which model really served it, how many tokens, what it cost. |

Every response — success or error — carries a `trace[]` of what each step
decided, so the architecture is visible from the outside:

```
   0ms route: google/gemini-3.6-flash -> anthropic/claude-haiku-4-5*
   3ms rate limit ok (59 tokens left)
   4ms budget ok ($0.0003 of $5 used today)
   5ms cache miss
 327ms google/gemini-3.6-flash attempt 1 failed: 503
 531ms google/gemini-3.6-flash attempt 2 failed: 503
1042ms google exhausted - moving to next route
1044ms substituting claude-haiku-4-5 on anthropic (same tier) - reported in the response
2140ms anthropic/claude-haiku-4-5 attempt 1 ok
```

## The decisions worth defending

**Redis is the correct implementation; in-memory is a labelled escape hatch.**
A gateway is a stateless service you run N replicas of, and its rate limits,
budgets, cache and breaker state are *fleet-wide* facts. With per-process
counters, three replicas enforce three times the limit and three times the daily
budget — and nothing errors to tell you. The in-memory store exists so the repo
runs with zero setup; it logs a warning, and `/v1/stats` reports `store: "memory"`
so the fallback can never be silent. ([`src/store/index.ts`](src/store/index.ts))

**The token bucket is a Lua script.** Read-then-write across the network is a
check-then-act race — two requests both see "1 token left" and both pass. The
script makes check-and-take one atomic Redis operation.

**Tiers are declared equivalence classes.** The registry
([`src/providers/registry.ts`](src/providers/registry.ts)) maps each model to a
provider, a price and a `tier`. Failover only ever substitutes *within* a tier and
*across* providers — a "small" request never silently becomes a frontier-model
bill, a "large" request never quietly degrades. Mocks are their own tier, so a
canned answer is never substituted for a real model.

**Silent substitution is a bug; declared substitution is a feature.** Every
response reports `requestedModel`, `servedBy` and `substituted`. Callers who need
reproducibility (evals, regression suites) send `allowSubstitute: false` and get
an honest 503 instead of a different model's answer — and are never served a
cached answer that came from a substitute either; the two knobs agree.

**"Per tenant" is a policy table, not a key prefix.** [`tenants.json`](tenants.json)
gives each tenant its own rate limit, daily budget and — the important one —
a **provider allowlist**. That last one is policy, not a request flag, because a
caller must never be able to opt *into* a provider their contract forbids. A
forbidden provider is simply absent from that tenant's route plan: the request
fails over to an allowed same-tier model (declared as `substituted`) or is
refused with `403 provider_not_allowed`. Resolution is tenant → file default →
env, and the trace's first line says which policy applied. `GET /v1/tenants`
shows the table.

**Defaults are policy, overrides are per request, the response is the truth.**
Caching is on by policy (`CACHE_TTL_SECONDS`; `0` turns it off cleanly), any
call can opt out with `cache: false` or `Cache-Control: no-cache`, and the
response says `cached: true/false`. Same shape for substitution. A control is
never part of the cache key — `no-cache` must not create a parallel entry.

**Concurrent identical requests pay once.** A plain cache has a stampede
problem: a retry storm is *N identical requests at the same instant*, they all
miss together, and every one calls the provider. The first becomes the leader;
the rest wait for its answer and are served as hits (`coalesced: true`). Found by
firing three identical requests concurrently and getting three misses. In-process
by design — one duplicate per replica is a bounded cost; a Redis lock on every
miss is not.

**The cache key includes the tenant.** Prompts carry private context. A cache
keyed only on the prompt hands one customer another customer's completion —
that is a breach, not a performance bug.

**Thinking tokens are billed as output, so they are counted as output.** Found
by running against a real key: for the prompt *"say exactly: gateway online"*,
`gemini-3.6-flash` produced 3 visible tokens and 84 reasoning tokens. Counting
only the visible answer understated cost 18×, and a small `maxTokens` returned an
empty answer with HTTP 200 — which a naive gateway would then cache. The adapter
now includes reasoning in `outputTokens`, breaks it out as `thinkingTokens`,
refuses to cache an empty `MAX_TOKENS` answer, and exposes `thinkingBudget` as a
request parameter (it's part of the cache key, because it changes the answer).

**The gateway is the transport; the agent owns the loop.** Tool calling is
passthrough: send `tools` (JSON Schema, the shape every vendor takes), get back
`toolCalls` and `stopReason: "tool_use"`, run them yourself, send the results as
`tool` messages. The gateway never executes a tool — that's the caller's code,
the caller's permissions, the caller's blast radius. Adapters translate to
Gemini `functionDeclarations` / Anthropic `tool_use` and back, including the
opaque reasoning signature Gemini 3 needs echoed on the next turn.

**A 429 from a provider does not trip the breaker.** Breaker state is fleet-wide
on purpose — but that means the wrong signal takes the provider away from every
tenant on every replica. A 429 means "slow down", not "down"; only 5xx, timeouts
and network errors count toward opening the circuit.

**When Redis dies under a running fleet, each concern fails differently.** Rate
limit and cache fail *open* (keep serving; losing the limiter briefly beats an
outage). Budget fails *closed* with `503 store_unavailable` (the downside of
being wrong is money). Accounting fails open (we already served — log it, never
fail the response). The trace says which happened.

**Streaming walks the same chain — and reliability applies only until the
first byte.** `stream: true` (or `Accept: text/event-stream`) answers as
server-sent events: `delta` events as tokens arrive, then one `done` whose data
is exactly the one-shot response (usage, cost, `servedBy`, tool calls, trace).
Everything decided before the provider call — a 429, a 400, a cache hit — is
still plain JSON with a real status, because once a stream has started the
status is 200 forever. Retries, the breaker and failover apply to *getting the
first byte* (under a time-to-first-token budget); after that the route is
committed — you cannot hand a client the second half of an answer from a
different model — so a mid-stream failure is an `error` event, and an
inter-token idle timeout replaces the whole-request one. The stream's answer is
cached on completion; a cached answer is replayed as one delta. Same loop for
the agent either way: [`examples/streaming-agent.ts`](examples/streaming-agent.ts).

**Tool calls stream too — complete, the moment each one is ready.** A
`tool_call` event carries `{id, name, arguments}` as soon as the provider has
finished that call, before the turn ends, so an agent can start running it
while the model is still producing the next one. Not as JSON fragments: a
caller cannot act on half an argument object, so forwarding fragments is
complexity without a decision the client can make. Gemini sends each call as
one part; Claude streams `input_json_delta` fragments and the adapter assembles
them and emits once, on `content_block_stop`. `done` repeats the full list, so
a client that ignores `tool_call` events is unaffected.

**503, not 500, when every provider fails.** 500 means *we* are broken. An
upstream dependency failure is a different pager. Every error is JSON with a
stable `error` code, a `requestId`, and — where it makes sense — a `Retry-After`
header computed from the actual refill rate.

## API

Full contract at `/docs` (Swagger) and `/openapi.json`, generated from the live
registry and policy so it cannot drift from the service.

```bash
curl -s localhost:3200/v1/chat \
  -H 'content-type: application/json' -H 'x-api-key: tenant-a' \
  -d '{"model":"gemini-3.6-flash","thinkingBudget":0,
       "messages":[{"role":"user","content":"One sentence on why gateways cache."}]}'
```

| Endpoint | Purpose |
|---|---|
| `POST /v1/chat` | The gateway. Provider-neutral messages and tools in, provider-neutral text / tool calls out, policy in between. |
| `GET /v1/models` | The catalogue: id, provider, tier, price, and whether this instance can serve it. |
| `GET /v1/tenants` | Per-tenant policy: rate limit, budget, provider allowlist, and the default everyone else gets. |
| `GET /v1/stats` | Hit rate, spend, estimated savings, p50/p95, per-provider counts, which store is active. |
| `GET /v1/recent` | Last 25 requests with per-request attribution. Also appended to `data/usage.jsonl`. |
| `GET /metrics` | Prometheus scrape target: cumulative counters (requests, cost, tokens by type incl. thinking, failovers) and a latency histogram. |
| `POST /v1/_chaos` | Fault injection for the mock providers, so retries / breaker / failover are demonstrable on demand. |

`x-api-key` is required (401 without it) — the key is the tenant. Errors are
machine-readable: `invalid_request` (400), `unknown_model` (400),
`rate_limit_exceeded` (429), `budget_exceeded` (402), `store_unavailable` (503),
`all_providers_failed` (503), `deadline_exceeded` (504). Clients branch on the
code, never on prose.

Two clocks: `REQUEST_TIMEOUT_MS` bounds one provider attempt; `REQUEST_DEADLINE_MS`
bounds the whole request, retries and failover included. "Each step was
reasonable" can still add up to a minute the caller never agreed to. Streaming
swaps the first for two of its own: `TTFT_TIMEOUT_MS` (until the first token)
and `STREAM_IDLE_TIMEOUT_MS` (silence between tokens).

## Configuration

Copy [`.env.example`](.env.example) to `.env`. Everything has a working default;
the only things you might set are:

| Variable | Default | Notes |
|---|---|---|
| `REDIS_URL` | *(unset → in-memory)* | Set this for anything beyond a single dev instance. `docker compose up` gives you one. |
| `GOOGLE_API_KEY` | *(unset)* | A [Google AI Studio](https://aistudio.google.com/apikey) key in a project with **no billing account** cannot be charged — over-quota is a 429, never an invoice. |
| `ANTHROPIC_API_KEY` | *(unset)* | Enables the second real provider, which makes cross-provider failover real. |
| `DEFAULT_MODEL` | `mock-small` | Used when a request names no model. |
| `RATE_LIMIT_PER_MIN` / `BUDGET_USD_PER_DAY` / `CACHE_TTL_SECONDS` | 60 / 5 / 300 | Per-tenant policy. |
| `MAX_ATTEMPTS` / `BASE_BACKOFF_MS` / `BREAKER_THRESHOLD` / `BREAKER_COOLDOWN_SEC` | 3 / 200 / 5 / 30 | Per-provider reliability. |

With no keys at all, the two mock providers are always registered, so routing,
caching, rate limiting, budgets, the breaker and failover all work and all demo.

## Layout

```
src/
  server.ts            entry point: wire real deps, listen, graceful shutdown
  app.ts               the HTTP surface as a function of its deps - testable on port 0
  validate.ts          request validation at the edge - the runtime twin of the OpenAPI contract
  pipeline.ts          the middleware chain — read this file first
  reliability.ts       timeout · retries with jittered backoff · circuit breaker · failover
  openapi.ts           the contract, hand-written; examples double as the demo script
  metrics.ts           the ledger (JSONL), the scrape target (/metrics), the dashboard window (/v1/stats)
  config.ts            env → typed config
  demo.ts              scripted end-to-end proof (npm run demo)
  tenants.ts           per-tenant policy: limits, budgets, provider allowlist (tenants.json)
  providers/
    registry.ts        model → provider/tier/price, and routePlan()
    types.ts           the neutral request/response shape (messages, tools, tool calls) and the adapter interface
    google.ts          Gemini adapter (handles the thinking-token trap)
    anthropic.ts       Claude adapter
    mock.ts            deterministic provider with fault injection
  store/
    index.ts           Store interface, Redis implementation (Lua token bucket), memory fallback
  *.test.ts            node:test, no test framework to install
examples/
  agent.ts             an agent that uses the gateway: the loop is the agent's, the transport is ours
  streaming-agent.ts   the same loop over server-sent events, SSE parsed by hand so nothing is hidden
public/
  index.html           dashboard
  docs.html            Swagger UI
```

## Testing

```
npm test
```

The pure parts — routing plans, request validation, cache keys, retry
classification — are unit tests. The chain is tested end to end against the
in-memory store and the mock providers, so the suite runs offline, free and
deterministically. Reliability is tested by *making* a provider fail and
asserting on the number of attempts and the order of providers, not on
wall-clock. The store-failure policy is tested by making individual store
operations throw. The Gemini adapter is tested against a fake SDK client, which
is where the thinking-token accounting and tool-call parsing are pinned.

## What I'd change for production

In order:

1. **Auth** — real API keys mapped to tenant records; today the key *is* the tenant (required, but not verified) so multi-tenancy is testable without a user system.
2. **Concurrency limits** per tenant and per provider (bulkheading). LLM calls are long-lived, so in-flight matters more than rate.
3. **Honour the provider's `Retry-After`** on 429s — backoff is tuned for blips, not for a rate limit that names its own wait — and classify quota-exhausted 429s as non-retryable.
4. **Traces to OTel, the ledger to a warehouse** — `/metrics` is already scrapeable; `trace[]` becomes spans, `usage.jsonl` becomes a table.
5. **Cost-aware routing** — the easy 80% (classification, extraction) to a small model, escalate the rest. The registry is a typed table and `routePlan()` is a pure function precisely so this is an addition, not surgery.
6. **Redis Cluster / tenant sharding** — Redis is the next bottleneck. The per-concern failure policy is already in place (rate limit and cache fail *open*, budget fails *closed* — see the header of `pipeline.ts`); what's missing is making the store itself not a single point of failure.
