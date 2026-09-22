// =============================================================================
// THE MODEL REGISTRY - which provider serves which model, and what it costs.
//
// This is the piece that makes the gateway a *router* rather than a dumb proxy.
// A caller asks for a specific model ("gemini-2.5-flash"); the gateway has to
// know which upstream can actually serve that, because sending an Anthropic
// model id to Google is just an error with extra steps.
//
// It also answers a question that is easy to get wrong: WHAT DOES FAILOVER MEAN
// WHEN THE CALLER NAMED A MODEL? You cannot silently answer a request for
// model X using model Y - different quality, different cost, different
// behaviour, and the caller would never know. So:
//
//   - failover is only ever to a model in the same TIER (a deliberate
//     equivalence class), and
//   - the response always reports which model actually served it.
//
// Silent substitution is a bug. Declared substitution is a feature.
// =============================================================================

// "mock" is its own tier on purpose. A mock is NOT an acceptable stand-in for a
// real model, so it must never be substituted for one - if Google is down, the
// honest outcome is a Claude model or a 503, not a canned string that looks like
// an answer. The mocks still substitute for EACH OTHER, which is what keeps
// failover demonstrable with no API keys at all.
export type Tier = "small" | "large" | "mock";

export interface ModelSpec {
  id: string;
  provider: string;              // which adapter can serve it
  tier: Tier;                    // equivalence class for failover
  pricing: { in: number; out: number };  // USD per 1M tokens
  note?: string;                 // surfaced in /v1/models and the docs
}

// Verified against the live ListModels endpoint. Note that a model appearing in
// ListModels does NOT mean your key may call it: gemini-2.5-flash is still
// listed but returns 404 "no longer available to new users" - which is exactly
// the kind of drift a registry exists to absorb. One table to edit, not five
// repos.
export const MODELS: Record<string, ModelSpec> = {
  "gemini-3.6-flash":      { id: "gemini-3.6-flash",      provider: "google",    tier: "small", pricing: { in: 0.75, out: 3.75 } },
  "gemini-3.1-flash-lite": { id: "gemini-3.1-flash-lite", provider: "google",    tier: "small", pricing: { in: 0.25, out: 1.50 } },
  "gemini-3.1-pro-preview":{ id: "gemini-3.1-pro-preview",provider: "google",    tier: "large", pricing: { in: 2.00, out: 12.00 },
                             note: "paid tier only - returns 429 on a free API key" },
  "claude-haiku-4-5":      { id: "claude-haiku-4-5",      provider: "anthropic", tier: "small", pricing: { in: 1.00, out: 5.00 } },
  "claude-sonnet-5":       { id: "claude-sonnet-5",       provider: "anthropic", tier: "large", pricing: { in: 2.00, out: 10.00 } },
  // Mock models, so routing and failover are demonstrable with no API keys.
  "mock-small":       { id: "mock-small",       provider: "mock-primary",   tier: "mock", pricing: { in: 0.50, out: 2.00 } },
  "mock-small-alt":   { id: "mock-small-alt",   provider: "mock-secondary", tier: "mock", pricing: { in: 0.60, out: 2.20 } },
};

export interface RouteStep { provider: string; model: string; substitute: boolean }

export type RouteResult =
  | { ok: true; plan: RouteStep[] }
  | { ok: false; error: string; supported: string[] };

/**
 * Turn a requested model into an ordered list of (provider, model) attempts.
 *
 * Step 0 is always the model the caller actually asked for. Later steps are
 * same-tier models on *different* providers - used only if the caller allows
 * substitution. An unknown model is a 400, not a guess: silently picking a
 * model for the caller is how you end up with a surprise bill and mystery
 * behaviour changes.
 */
export function routePlan(
  requested: string | undefined,
  defaultModel: string,
  opts: { allowSubstitute?: boolean; availableProviders: string[] } ,
): RouteResult {
  const wanted = requested ?? defaultModel;
  const spec = MODELS[wanted];
  if (!spec) {
    return { ok: false, error: `unknown model "${wanted}"`, supported: Object.keys(MODELS) };
  }

  const available = new Set(opts.availableProviders);
  const plan: RouteStep[] = [];

  if (available.has(spec.provider)) {
    plan.push({ provider: spec.provider, model: spec.id, substitute: false });
  }

  if (opts.allowSubstitute !== false) {
    for (const alt of Object.values(MODELS)) {
      if (alt.id === spec.id) continue;
      if (alt.tier !== spec.tier) continue;             // never cross tiers
      if (alt.provider === spec.provider) continue;      // a different provider is the point
      if (!available.has(alt.provider)) continue;
      plan.push({ provider: alt.provider, model: alt.id, substitute: true });
    }
  }

  if (plan.length === 0) {
    return { ok: false, error: `no configured provider can serve "${wanted}"`, supported: Object.keys(MODELS) };
  }
  return { ok: true, plan };
}

export function costUsd(model: string, usage: { inputTokens: number; outputTokens: number }): number {
  const p = MODELS[model]?.pricing ?? { in: 1, out: 5 };
  return (usage.inputTokens * p.in + usage.outputTokens * p.out) / 1_000_000;
}
