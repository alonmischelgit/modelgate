// =============================================================================
// THE OPENAPI CONTRACT.
//
// Written by hand rather than generated, for two reasons:
//   1. A gateway's value IS its contract. Callers point their SDK at this
//      service instead of at a provider, so the request/response shape is the
//      product - it deserves to be authored, not inferred.
//   2. The examples below are executable documentation: each one demonstrates
//      one architectural behaviour (cache, rate limit, budget, routing,
//      failover). Anyone can open /docs, hit "Try it out", and watch the
//      gateway explain itself.
//
// Served at /openapi.json, rendered by Swagger UI at /docs.
// =============================================================================
import { config } from "./config.js";
import { MODELS } from "./providers/registry.js";

const modelIds = Object.keys(MODELS);

export function openapiSpec() {
  return {
    openapi: "3.0.3",
    info: {
      title: "modelgate",
      version: "0.1.0",
      description: [
        "One HTTP endpoint in front of every LLM provider.",
        "",
        "Each request walks a middleware chain in a deliberate order:",
        "",
        "1. **identify** - the API key maps to a tenant; everything below is per-tenant.",
        "2. **route** - resolve the requested model to a provider, or 400 fast.",
        "3. **rate limit** - token bucket, atomic in Redis, shared by every instance.",
        "4. **budget** - refuse *before* spending, never after.",
        "5. **cache** - identical request returns in ~1ms for $0 and 0 tokens.",
        "6. **call** - timeout, retries with jittered backoff, circuit breaker, failover.",
        "7. **account** - record tokens, latency and cost against the tenant.",
        "",
        "Every response carries a `trace[]` showing which of those steps ran and",
        "what each decided, so the architecture is visible from the outside.",
        "",
        `Live policy: **${config.policy.rateLimitPerMin} req/min**, ` +
          `**$${config.policy.budgetUsdPerDay}/day** per tenant, ` +
          `cache TTL **${config.policy.cacheTtlSeconds}s**, ` +
          `timeout **${config.policy.requestTimeoutMs}ms**, ` +
          `up to **${config.reliability.maxAttempts} attempts** per provider.`,
      ].join("\n"),
    },
    servers: [{ url: "/", description: "this instance" }],
    tags: [
      { name: "gateway", description: "The endpoint your agents call." },
      { name: "observability", description: "What it cost, what it saved, what happened." },
      { name: "demo", description: "Fault injection, so reliability is demonstrable on demand." },
    ],
    paths: {
      "/v1/chat": {
        post: {
          tags: ["gateway"],
          summary: "Send a chat completion through the gateway",
          description: [
            "The only endpoint that matters. Provider-shaped in, provider-shaped out,",
            "with policy and reliability applied in between.",
            "",
            "**Try the examples in order** - each one proves a different property:",
            "",
            "| Example | What to watch in the response |",
            "|---|---|",
            "| 1. basic | `trace[]` walks route -> rate limit -> budget -> cache miss -> provider |",
            "| 2. cached | send example 1 twice: second is `cached: true`, `costUsd: 0`, ~1ms |",
            "| 3. explicit model | `servedBy` echoes exactly what you asked for |",
            "| 4. unknown model | **400** `unknown_model` with the supported list - never a silent guess |",
            "| 5. no substitution | with `allowSubstitute: false` a provider outage becomes an honest 503 |",
            "| 6. multi-turn | system + history; the whole array is part of the cache key |",
            "| 7a / 7b. thinking | **same answer, ~18x the cost** — reasoning tokens are billed as output |",
            "| 8a / 8b. tools | the model asks for a tool; you run it; you send the result back. The gateway is the transport, the agent owns the loop |",
            "",
            "To see retries and failover, flip a provider into failure with",
            "`POST /v1/_chaos` first, then send example 1 again and read the `trace`.",
          ].join("\n"),
          parameters: [
            {
              name: "x-api-key",
              in: "header",
              required: true,
              description:
                "Identifies the tenant. Rate limit, daily budget and cache namespace are all " +
                "scoped to this value - change it and you get a clean bucket, a clean budget " +
                "and a cold cache. Missing -> 401. (In production this maps a real key to a " +
                "tenant record; here the header *is* the tenant so multi-tenancy is testable.)",
              schema: { type: "string", default: "tenant-a" },
              example: "tenant-a",
            },
            {
              name: "Cache-Control",
              in: "header",
              required: false,
              description: "`no-cache` bypasses the response cache for this call, same as `cache: false` in the body.",
              schema: { type: "string", enum: ["no-cache"] },
            },
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ChatRequest" },
                examples: {
                  basic: {
                    summary: "1. Basic request (uses the default model)",
                    description:
                      "Omit `model` and the gateway uses its configured default " +
                      `(\`${config.policy.defaultModel}\`). Read the trace bottom-up.`,
                    value: {
                      messages: [{ role: "user", content: "Explain a circuit breaker in one sentence." }],
                      maxTokens: 120,
                    },
                  },
                  cacheHit: {
                    summary: "2. Cache hit (send this twice)",
                    description:
                      "Byte-identical to itself, so the second call never reaches a provider: " +
                      "`cached: true`, `costUsd: 0`. The key is a hash of tenant + model + " +
                      "messages + params - tenant included, or one customer could read another's answers.",
                    value: {
                      messages: [{ role: "user", content: "What does a token bucket do?" }],
                      maxTokens: 120,
                    },
                  },
                  explicitModel: {
                    summary: "3. Named model (routing)",
                    description:
                      "The gateway looks the id up in its registry and dispatches to the " +
                      "provider that can actually serve it. `servedBy` reports what really ran.",
                    value: {
                      model: modelIds[0],
                      messages: [{ role: "user", content: "One sentence on why gateways cache." }],
                      maxTokens: 120,
                    },
                  },
                  unknownModel: {
                    summary: "4. Unknown model -> 400 (the interesting failure)",
                    description:
                      "A gateway that guesses on the caller's behalf produces surprise bills and " +
                      "mystery behaviour changes. Unknown ids fail fast, before a rate-limit token " +
                      "is even spent, and the error lists what *is* supported.",
                    value: {
                      model: "gpt-9-turbo",
                      messages: [{ role: "user", content: "hello" }],
                    },
                  },
                  noSubstitute: {
                    summary: "5. Pin the model (allowSubstitute: false)",
                    description:
                      "By default, if the named model's provider is down the gateway may fail over " +
                      "to a *same-tier* model on another provider - and says so via `substituted: true`. " +
                      "Callers who need reproducibility (evals, regression tests) set this to false " +
                      "and get an honest 503 instead of a different model's answer.",
                    value: {
                      model: modelIds[0],
                      allowSubstitute: false,
                      messages: [{ role: "user", content: "Deterministic runs only, please." }],
                    },
                  },
                  thinkingOn: {
                    summary: "7a. Thinking model, default (run this, then 7b)",
                    description:
                      "Gemini 3.x reasons before answering. Send this, note `usage.thinkingTokens` " +
                      "and `costUsd`, then send 7b and compare — same answer, ~18x the cost.",
                    value: {
                      model: "gemini-3.6-flash",
                      messages: [{ role: "user", content: "Say exactly: gateway online." }],
                    },
                  },
                  thinkingOff: {
                    summary: "7b. Same request, thinking disabled",
                    description:
                      "`thinkingBudget: 0`. Identical answer, a fraction of the cost and latency. " +
                      "This is the cost lever a gateway exists to expose — and it is part of the " +
                      "cache key, so 7a and 7b are correctly cached separately.",
                    value: {
                      model: "gemini-3.6-flash",
                      thinkingBudget: 0,
                      messages: [{ role: "user", content: "Say exactly: gateway online." }],
                    },
                  },
                  toolCall: {
                    summary: "8a. Tool calling: the model asks for a tool",
                    description:
                      "Send tools; the model answers with `toolCalls` and `stopReason: tool_use` " +
                      "instead of text. **The gateway never runs tools** - it is the transport, " +
                      "the agent owns the loop. Works on the mock with no key: it deterministically " +
                      "calls the first tool. Then run 8b.",
                    value: {
                      model: "mock-small",
                      messages: [{ role: "user", content: "What's the weather in Haifa?" }],
                      tools: [{
                        name: "get_weather",
                        description: "Current weather for a city. Use for any weather question; not for forecasts.",
                        parameters: {
                          type: "object",
                          properties: { city: { type: "string" } },
                          required: ["city"],
                        },
                      }],
                    },
                  },
                  toolResult: {
                    summary: "8b. Tool calling: send the result back",
                    description:
                      "The caller ran the tool. Echo the assistant turn (with its `toolCalls`, " +
                      "signature included) and append a `tool` message with the result. The model " +
                      "now answers in text.",
                    value: {
                      model: "mock-small",
                      messages: [
                        { role: "user", content: "What's the weather in Haifa?" },
                        { role: "assistant", content: "",
                          toolCalls: [{ id: "call_1", name: "get_weather", arguments: { city: "Haifa" } }] },
                        { role: "tool", toolCallId: "call_1", content: "{\"tempC\": 29, \"sky\": \"clear\"}" },
                      ],
                      tools: [{
                        name: "get_weather",
                        description: "Current weather for a city.",
                        parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
                      }],
                    },
                  },
                  conversation: {
                    summary: "6. Multi-turn with a system prompt",
                    value: {
                      model: modelIds[0],
                      messages: [
                        { role: "system", content: "You are terse. Answer in one line." },
                        { role: "user", content: "What is a dead letter queue?" },
                        { role: "assistant", content: "A holding queue for messages that repeatedly failed processing." },
                        { role: "user", content: "Who drains it?" },
                      ],
                      maxTokens: 120,
                      temperature: 0,
                    },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Completion served - either freshly generated or from cache.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ChatResponse" },
                  examples: {
                    fresh: {
                      summary: "Fresh call, failed over to a substitute",
                      value: {
                        requestId: "8f1c2a4e-…",
                        text: "A circuit breaker stops calling a dependency that is already failing.",
                        stopReason: "end",
                        usage: { inputTokens: 18, outputTokens: 46 },
                        model: "mock-small-alt",
                        provider: "mock-secondary",
                        requestedModel: "mock-small",
                        servedBy: { provider: "mock-secondary", model: "mock-small-alt" },
                        substituted: true,
                        cached: false,
                        costUsd: 0.000112,
                        latencyMs: 2143,
                        attempts: 4,
                        failedOver: true,
                        breakerSkipped: false,
                        trace: [
                          "   0ms route: mock-primary/mock-small -> mock-secondary/mock-small-alt*",
                          "   3ms rate limit ok (59 tokens left)",
                          "   4ms budget ok ($0.0003 of $5 used today)",
                          "   5ms cache miss",
                          "  12ms mock-primary attempt 1 failed: upstream unavailable (simulated)",
                          " 208ms retrying in 196ms",
                          " 412ms mock-primary attempt 2 failed: upstream unavailable (simulated)",
                          "1042ms circuit OPEN for mock-primary - skipping",
                          "1044ms failing over to mock-secondary/mock-small-alt (substitute)",
                          "2140ms ok via mock-secondary",
                        ],
                      },
                    },
                    cached: {
                      summary: "Cache hit - no provider was called",
                      value: {
                        requestId: "c07d9b1e-…",
                        text: "A token bucket admits a request only if a token is available, refilling at a fixed rate.",
                        stopReason: "end",
                        usage: { inputTokens: 0, outputTokens: 0 },
                        model: "mock-small",
                        provider: "mock-primary",
                        requestedModel: "mock-small",
                        servedBy: { provider: "mock-primary", model: "mock-small" },
                        substituted: false,
                        cached: true,
                        costUsd: 0,
                        latencyMs: 1,
                        trace: [
                          "   0ms route: mock-primary/mock-small",
                          "   1ms rate limit ok (58 tokens left)",
                          "   1ms budget ok ($0.0004 of $5 used today)",
                          "   1ms CACHE HIT - returning without calling any provider (0 tokens, $0)",
                        ],
                      },
                    },
                  },
                },
              },
            },
            "400": {
              description:
                "Bad request: malformed JSON (`invalid_json`), a field of the wrong shape " +
                "(`invalid_request`, with the field named in `detail`), or a model the registry " +
                "does not know (`unknown_model`). All rejected before any quota is consumed.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/GatewayError" },
                  example: {
                    error: "unknown_model",
                    detail: 'unknown model "gpt-9-turbo"',
                    supportedModels: modelIds,
                    trace: ['   0ms routing failed: unknown model "gpt-9-turbo"'],
                  },
                },
              },
            },
            "401": {
              description: "No `x-api-key`. The key is the tenant; there is no anonymous bucket to fall into.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/GatewayError" },
                  example: { error: "missing_api_key", detail: "send x-api-key" },
                },
              },
            },
            "403": {
              description:
                "The requested model lives on a provider this tenant's policy forbids (see `/v1/tenants`), " +
                "and no allowed same-tier model could substitute - or the caller pinned the model.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/GatewayError" },
                  example: { error: "provider_not_allowed",
                             detail: "gemini-3.6-flash is served by google, which tenant eu-billing may not use (and substitution is disabled)",
                             allowedProviders: ["anthropic", "mock-primary", "mock-secondary"] },
                },
              },
            },
            "402": {
              description:
                "Daily budget for this tenant is exhausted. Checked *before* the provider call - " +
                "a budget enforced after the fact is just a receipt - and enforced by an atomic " +
                "reservation of the worst-case cost, so concurrent requests cannot race past the cap. " +
                "The reservation is settled to the real cost after the call.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/GatewayError" },
                  example: {
                    error: "budget_exceeded",
                    spentUsd: 5.0001,
                    budgetUsd: 5,
                  },
                },
              },
            },
            "429": {
              description:
                "Token bucket empty for this tenant. The counter lives in Redis and is decremented " +
                "by an atomic Lua script, so N replicas enforce one shared limit rather than N limits.",
              headers: {
                "Retry-After": { schema: { type: "integer" }, description: "Seconds until one token refills (60 / limitPerMin)." },
              },
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/GatewayError" },
                  example: { error: "rate_limit_exceeded", limitPerMin: 60, retryAfterSec: 1 },
                },
              },
            },
            "504": {
              description:
                "The request's overall deadline passed - retries, backoff and failover included. " +
                "The per-attempt timeout bounds one provider call; this bounds the caller's wait.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/GatewayError" },
                  example: { error: "deadline_exceeded", detail: "request deadline of 60000ms exceeded" },
                },
              },
            },
            "503": {
              description:
                "Every provider in the route plan failed, or the caller pinned a model whose " +
                "provider is down. 503 and not 500: this is an upstream dependency failure, not a bug here.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/GatewayError" },
                  example: {
                    error: "all_providers_failed",
                    detail: "mock-primary: upstream unavailable (simulated)",
                  },
                },
              },
            },
          },
        },
      },

      "/v1/models": {
        get: {
          tags: ["gateway"],
          summary: "The model catalogue",
          description:
            "What you may ask for, what it costs, and which models are *interchangeable*. " +
            "`tier` is the equivalence class used for failover: the gateway will only ever " +
            "substitute within a tier, never across one. `available: false` means the model " +
            "is known but its provider has no API key configured on this instance.",
          responses: {
            "200": {
              description: "Every registered model.",
              content: {
                "application/json": {
                  example: [
                    {
                      id: "gemini-3.6-flash",
                      provider: "google",
                      tier: "small",
                      pricingPerMTok: { in: 0.75, out: 3.75 },
                      available: true,
                      isDefault: false,
                    },
                    {
                      id: "gemini-3.1-pro-preview",
                      provider: "google",
                      tier: "large",
                      pricingPerMTok: { in: 2.0, out: 12.0 },
                      available: true,
                      note: "paid tier only - returns 429 on a free API key",
                    },
                    {
                      id: "mock-small",
                      provider: "mock-primary",
                      tier: "small",
                      pricingPerMTok: { in: 0.5, out: 2.0 },
                      available: true,
                    },
                  ],
                },
              },
            },
          },
        },
      },

      "/v1/tenants": {
        get: {
          tags: ["gateway"],
          summary: "Per-tenant policy: who gets what",
          description:
            "The named tenants from `tenants.json` and the default everyone else falls back to. " +
            "Rate limit, daily budget, and - the important one - a **provider allowlist**: policy, " +
            "not a request flag, because a caller must not be able to opt *into* a provider their " +
            "contract forbids. A forbidden provider is simply absent from that tenant's route plan; " +
            "the request fails over to an allowed same-tier model (declared as `substituted`) or is " +
            "refused with `403 provider_not_allowed`. Try `x-api-key: eu-billing` with a Gemini model.",
          responses: {
            "200": {
              description: "Effective policies.",
              content: { "application/json": { example: {
                default: { rateLimitPerMin: 60, budgetUsdPerDay: 5 },
                tenants: {
                  "team-search":    { rateLimitPerMin: 120, budgetUsdPerDay: 20, note: "product traffic" },
                  "eu-billing":     { rateLimitPerMin: 60, budgetUsdPerDay: 5, providers: ["anthropic", "mock-primary", "mock-secondary"], note: "EU data residency: never routed to Google" },
                  "intern-sandbox": { rateLimitPerMin: 5, budgetUsdPerDay: 0.1, note: "tight limits, tiny budget" },
                },
              } } },
            },
          },
        },
      },

      "/v1/stats": {
        get: {
          tags: ["observability"],
          summary: "Aggregate counters: hit rate, spend, savings, latency percentiles",
          description:
            "The numbers that justify running a gateway at all. `estimatedSavedUsd` is the average " +
            "cost of a cache *miss* multiplied by the number of hits - the cache's paycheck. " +
            "`store` tells you whether shared Redis or the in-memory dev fallback is active.",
          responses: {
            "200": {
              description: "Counters over the in-process window.",
              content: {
                "application/json": {
                  example: {
                    requests: 42,
                    cacheHits: 17,
                    cacheHitRate: 0.405,
                    failures: 2,
                    spendUsd: 0.004312,
                    estimatedSavedUsd: 0.001836,
                    p50Ms: 412,
                    p95Ms: 2140,
                    byProvider: { "mock-primary": 23, "mock-secondary": 2, none: 0 },
                    store: "redis",
                    providers: [
                      { name: "mock-primary", ready: true },
                      { name: "mock-secondary", ready: true },
                    ],
                  },
                },
              },
            },
          },
        },
      },

      "/v1/recent": {
        get: {
          tags: ["observability"],
          summary: "The last 25 requests, newest first",
          description:
            "Per-request attribution: tenant, provider, model, tokens, cost, latency, cached, ok. " +
            "Also appended to `data/usage.jsonl` - append-only, because usage records are " +
            "evidence, not state to mutate.",
          responses: {
            "200": {
              description: "Recent usage records.",
              content: {
                "application/json": {
                  example: [
                    {
                      ts: "2026-09-19T09:14:02.881Z",
                      tenant: "tenant-a",
                      provider: "mock-secondary",
                      model: "mock-small-alt",
                      inputTokens: 18,
                      outputTokens: 46,
                      costUsd: 0.000112,
                      cached: false,
                      ms: 2143,
                      ok: true,
                    },
                  ],
                },
              },
            },
          },
        },
      },

      "/v1/_chaos": {
        post: {
          tags: ["demo"],
          summary: "Inject a provider outage (mock providers only)",
          description:
            "Reliability you cannot demonstrate is a claim, not a feature. This flips a mock " +
            "provider into failing, so retries, jittered backoff, the shared circuit breaker and " +
            "cross-provider failover all become visible in the next request's `trace[]`.",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                examples: {
                  breakPrimary: {
                    summary: "Take the primary down",
                    description: "Then POST /v1/chat and read the trace: 3 attempts, backoff, failover.",
                    value: { provider: "mock-primary", failing: true },
                  },
                  healPrimary: {
                    summary: "Bring it back",
                    value: { provider: "mock-primary", failing: false },
                  },
                },
                schema: {
                  type: "object",
                  required: ["provider", "failing"],
                  properties: {
                    provider: { type: "string", enum: ["mock-primary", "mock-secondary"] },
                    failing: { type: "boolean" },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description:
                "`ok: false` means the named provider is not a mock - real providers are never " +
                "made to fail on purpose.",
              content: {
                "application/json": {
                  example: { ok: true, provider: "mock-primary", failing: true },
                },
              },
            },
          },
        },
      },

      "/metrics": {
        get: {
          tags: ["observability"],
          summary: "Prometheus scrape target",
          description:
            "Cumulative counters (requests, cost, tokens by type including thinking, failovers) " +
            "and a latency histogram, in Prometheus text format. `/v1/stats` is a window for the " +
            "dashboard; this is for alerting. `data/usage.jsonl` remains the per-request ledger - " +
            "a metric answers *is p95 rising*, a ledger answers *what did tenant X spend in March*.",
          responses: {
            "200": {
              description: "text/plain; version=0.0.4",
              content: { "text/plain": { example:
                "# TYPE modelgate_requests_total counter\n" +
                "modelgate_requests_total{tenant=\"tenant-a\",provider=\"google\",model=\"gemini-3.6-flash\",cached=false,ok=true} 12\n" +
                "modelgate_tokens_total{tenant=\"tenant-a\",provider=\"google\",model=\"gemini-3.6-flash\",type=\"thinking\"} 1008\n" +
                "modelgate_request_duration_seconds_bucket{provider=\"google\",cached=false,le=\"1\"} 9\n" } },
            },
          },
        },
      },

      "/health": {
        get: {
          tags: ["observability"],
          summary: "Liveness, plus which store backend is in use",
          responses: {
            "200": {
              description: "Alive.",
              content: { "application/json": { example: { ok: true, store: "redis" } } },
            },
          },
        },
      },
    },

    components: {
      schemas: {
        ToolDef: {
          type: "object",
          required: ["name", "parameters"],
          properties: {
            name: { type: "string" },
            description: { type: "string", description: "Prompt engineering: say when to use it, and when not to." },
            parameters: { type: "object", description: "JSON Schema for the arguments - the shape every vendor accepts." },
          },
        },
        ToolCall: {
          type: "object",
          required: ["id", "name", "arguments"],
          properties: {
            id: { type: "string" },
            name: { type: "string" },
            arguments: { type: "object" },
            signature: {
              type: "string",
              description:
                "Opaque, provider-specific. Some models (Gemini 3) sign their reasoning and " +
                "need it echoed back with the call on the next turn. Pass it through untouched.",
            },
          },
        },
        ChatMessage: {
          type: "object",
          required: ["role", "content"],
          properties: {
            role: { type: "string", enum: ["system", "user", "assistant", "tool"] },
            content: { type: "string", description: "Text; for role `tool`, the tool's result." },
            toolCalls: {
              type: "array", items: { $ref: "#/components/schemas/ToolCall" },
              description: "Assistant only: the calls it made in that turn (echo the response's `toolCalls` here).",
            },
            toolCallId: { type: "string", description: "Tool only: which call this result answers." },
          },
        },
        ChatRequest: {
          type: "object",
          required: ["messages"],
          properties: {
            messages: {
              type: "array",
              minItems: 1,
              items: { $ref: "#/components/schemas/ChatMessage" },
              description: "Provider-neutral conversation. Part of the cache key, in full.",
            },
            model: {
              type: "string",
              enum: modelIds,
              description:
                "A model id from /v1/models. Omit to use the instance default " +
                `(\`${config.policy.defaultModel}\`). Anything not in the registry is a 400.`,
            },
            maxTokens: { type: "integer", minimum: 1, default: 256 },
            temperature: { type: "number", minimum: 0, maximum: 2, default: 0 },
            tools: {
              type: "array", items: { $ref: "#/components/schemas/ToolDef" },
              description:
                "Tools the model may ask to call. The gateway never runs them - it returns " +
                "`toolCalls`, the caller executes and sends `tool` messages back. Part of the cache key.",
            },
            allowSubstitute: {
              type: "boolean",
              default: true,
              description:
                "Whether failover may serve the request with a different same-tier model. " +
                "Set false when reproducibility matters more than availability.",
            },
            stream: {
              type: "boolean",
              default: false,
              description:
                "Answer as server-sent events (`Accept: text/event-stream` does the same). " +
                "Events: `delta` `{text}` as tokens arrive; `tool_call` `{id, name, arguments}` the moment " +
                "each call is **complete** (not JSON fragments - a caller cannot act on half an argument " +
                "object), so an agent can start running it before the turn ends; then one `done` whose data " +
                "is exactly the one-shot response body (usage, cost, servedBy, the full toolCalls list, trace), " +
                "or one `error` if the provider failed **after** the first byte. Anything decided before the first byte - a 429, " +
                "a 400, a cache hit - is still plain JSON with a real status. Retries, breaker and failover " +
                "apply only until the first byte: once you have half an answer from model A, nobody can " +
                "silently hand you the rest from model B. Not part of the cache key; a stream's answer is " +
                "cached on completion and a cached answer is replayed as one delta.",
            },
            cache: {
              type: "boolean",
              default: true,
              description:
                "`false` bypasses the response cache for this call - neither read nor written. " +
                "For creative tasks that want variety, time-sensitive prompts, or evals that must " +
                "hit the model. `Cache-Control: no-cache` does the same. Not part of the cache key.",
            },
            thinkingBudget: {
              type: "integer",
              minimum: 0,
              description:
                "Reasoning-token budget for thinking models (Gemini 3.x). `0` disables " +
                "thinking. Omit to let the model decide. **This is a cost lever, not a " +
                "detail**: measured on `gemini-3.6-flash`, the same one-line answer costs " +
                "18x more and takes ~900ms longer with thinking on, because reasoning " +
                "tokens are billed as output. It is part of the cache key.",
            },
          },
        },
        ChatResponse: {
          type: "object",
          properties: {
            requestId: {
              type: "string",
              description: "Ties this response to its usage record and (in production) its log line and span. Send `x-request-id` to supply your own.",
            },
            text: { type: "string", description: "Empty when the model chose to call tools instead." },
            toolCalls: {
              type: "array", items: { $ref: "#/components/schemas/ToolCall" },
              description: "Present when `stopReason` is `tool_use`. Run them, then send the results back as `tool` messages.",
            },
            stopReason: { type: "string", enum: ["end", "tool_use", "max_tokens"] },
            usage: {
              type: "object",
              properties: {
                inputTokens: { type: "integer" },
                outputTokens: {
                  type: "integer",
                  description:
                    "**Includes thinking tokens**, because providers bill them as output. " +
                    "Counting only the visible answer understates cost by an order of magnitude.",
                },
                thinkingTokens: {
                  type: "integer",
                  description: "The reasoning portion of outputTokens, broken out so it is attributable.",
                },
              },
            },
            model: { type: "string", description: "The model that actually produced this text." },
            provider: { type: "string" },
            requestedModel: { type: "string", description: "What the caller asked for." },
            servedBy: {
              type: "object",
              description:
                "What really ran. Always reported, so a substitution can never be silent.",
              properties: { provider: { type: "string" }, model: { type: "string" } },
            },
            substituted: {
              type: "boolean",
              description: "True when a same-tier model on another provider served the request.",
            },
            cached: { type: "boolean" },
            coalesced: {
              type: "boolean",
              description:
                "True when an identical request was already in flight and this one waited for its " +
                "answer instead of calling the provider (single-flight). Reported as a cache hit.",
            },
            costUsd: { type: "number", description: "0 for a cache hit." },
            latencyMs: { type: "integer", description: "End to end, including retries." },
            attempts: { type: "integer", description: "Provider calls made, across all providers." },
            failedOver: { type: "boolean" },
            breakerSkipped: {
              type: "boolean",
              description: "True when an open circuit meant a provider was not even tried.",
            },
            trace: { $ref: "#/components/schemas/Trace" },
          },
        },
        GatewayError: {
          type: "object",
          properties: {
            requestId: { type: "string" },
            error: {
              type: "string",
              enum: [
                "invalid_json",
                "invalid_request",
                "payload_too_large",
                "missing_api_key",
                "unknown_model",
                "model_unavailable",
                "provider_not_allowed",
                "deadline_exceeded",
                "rate_limit_exceeded",
                "budget_exceeded",
                "store_unavailable",
                "all_providers_failed",
                "internal_error",
              ],
              description:
                "Stable machine-readable code. Clients branch on this, not on prose. " +
                "`store_unavailable` is the budget check failing *closed* when Redis is unreachable " +
                "mid-request - the one concern where being wrong costs money.",
            },
            detail: { type: "string" },
            retryAfterSec: { type: "integer", description: "Also sent as the `Retry-After` header on 429 and 503." },
            supportedModels: { type: "array", items: { type: "string" } },
            trace: { $ref: "#/components/schemas/Trace" },
          },
        },
        Trace: {
          type: "array",
          items: { type: "string" },
          description:
            "Timestamped decisions, one line per middleware step. On every response, including " +
            "errors - the gateway explains itself rather than requiring log access.",
        },
      },
    },
  };
}
